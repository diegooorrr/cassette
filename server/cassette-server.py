#!/usr/bin/env python3
"""Cassette music server.

Serves a folder of audio files to the Cassette web app over HTTP, with the
byte-range support a browser needs in order to stream and seek. Python
standard library only, so a Raspberry Pi needs nothing installed.

It deliberately does no tag parsing: the app already has a tested reader and
pulls the first chunk of each file over a range request to use it. That keeps
this process small and dull, which is what you want on a box that must stay up.

    ./cassette-server.py --root /srv/music --port 8010
"""

import argparse
import hashlib
import json
import mimetypes
import os
import posixpath
import re
import socketserver
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

AUDIO_EXT = {
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.m4b': 'audio/mp4',
    '.aac': 'audio/aac', '.mp4': 'audio/mp4', '.flac': 'audio/flac',
    '.wav': 'audio/wav', '.aif': 'audio/aiff', '.aiff': 'audio/aiff',
    '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/opus',
}

RANGE_RE = re.compile(r'^bytes=(\d*)-(\d*)$')


class Library:
    """The set of audio files under root, refreshed when the tree changes."""

    def __init__(self, root, ttl=15.0):
        self.root = os.path.abspath(root)
        self.ttl = ttl
        self._lock = threading.Lock()
        self._by_id = {}
        self._tracks = []
        self._scanned_at = 0.0

    def _scan(self):
        by_id, tracks = {}, []
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = [d for d in dirnames if not d.startswith('.')]
            for name in filenames:
                if name.startswith('.'):
                    continue
                ext = os.path.splitext(name)[1].lower()
                if ext not in AUDIO_EXT:
                    continue
                full = os.path.join(dirpath, name)
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                rel = os.path.relpath(full, self.root)
                tid = hashlib.sha1(rel.encode('utf-8')).hexdigest()[:16]
                by_id[tid] = full
                tracks.append({
                    'id': tid,
                    'path': rel.replace(os.sep, '/'),
                    'name': name,
                    'size': st.st_size,
                    'mtime': int(st.st_mtime),
                    'mime': AUDIO_EXT[ext],
                })
        tracks.sort(key=lambda t: t['path'].lower())
        return by_id, tracks

    def refresh(self, force=False):
        with self._lock:
            if force or time.time() - self._scanned_at > self.ttl:
                self._by_id, self._tracks = self._scan()
                self._scanned_at = time.time()
            return self._tracks

    def path_for(self, tid):
        self.refresh()
        with self._lock:
            return self._by_id.get(tid)


class Handler(BaseHTTPRequestHandler):
    server_version = 'cassette/1.0'
    protocol_version = 'HTTP/1.1'

    # --- helpers ---------------------------------------------------------
    def _cors(self):
        # The tailnet is the access control; inside it, keep this permissive so
        # the app works from GitHub Pages and from a local dev copy alike.
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Range, Content-Type')
        self.send_header('Access-Control-Expose-Headers',
                         'Content-Range, Content-Length, Accept-Ranges')

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(status)
        self._cors()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def log_message(self, fmt, *args):
        if self.server.verbose:
            sys.stderr.write('%s %s\n' % (self.address_string(), fmt % args))

    # --- routes ----------------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = posixpath.normpath(self.path.split('?', 1)[0])

        if path in ('/', '/api', '/api/'):
            return self._json({
                'service': 'cassette',
                'root': self.server.library.root,
                'tracks': len(self.server.library.refresh()),
            })

        if path == '/api/index.json':
            tracks = self.server.library.refresh(force='refresh' in self.path)
            return self._json({'generated': int(time.time()), 'tracks': tracks})

        if path.startswith('/api/file/'):
            return self._send_file(path[len('/api/file/'):])

        self._json({'error': 'not found'}, 404)

    # --- byte-range file delivery ---------------------------------------
    def _send_file(self, tid):
        full = self.server.library.path_for(tid)
        if not full or not os.path.isfile(full):
            return self._json({'error': 'unknown track'}, 404)

        size = os.path.getsize(full)
        ctype = mimetypes.guess_type(full)[0] or 'application/octet-stream'
        start, end = 0, size - 1
        partial = False

        rng = self.headers.get('Range')
        if rng:
            m = RANGE_RE.match(rng.strip())
            if m:
                lo, hi = m.group(1), m.group(2)
                if lo:
                    start = int(lo)
                    if hi:
                        end = min(int(hi), size - 1)
                elif hi:                      # suffix range: last N bytes
                    start = max(0, size - int(hi))
                if start > end or start >= size:
                    self.send_response(416)
                    self._cors()
                    self.send_header('Content-Range', 'bytes */%d' % size)
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                    return
                partial = True

        length = end - start + 1
        self.send_response(206 if partial else 200)
        self._cors()
        self.send_header('Content-Type', ctype)
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(length))
        if partial:
            self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
        self.end_headers()

        if self.command == 'HEAD':
            return

        remaining = length
        with open(full, 'rb') as fh:
            fh.seek(start)
            while remaining > 0:
                chunk = fh.read(min(65536, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return          # the phone skipped track; perfectly normal
                remaining -= len(chunk)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    ap = argparse.ArgumentParser(description='Serve a music folder to Cassette.')
    ap.add_argument('--root', required=True, help='folder holding the music')
    ap.add_argument('--port', type=int, default=8010)
    ap.add_argument('--host', default='127.0.0.1',
                    help='bind address (default loopback; tailscale serve fronts it)')
    ap.add_argument('--verbose', action='store_true')
    args = ap.parse_args()

    if not os.path.isdir(args.root):
        sys.exit('no such folder: %s' % args.root)

    srv = Server((args.host, args.port), Handler)
    srv.library = Library(args.root)
    srv.verbose = args.verbose
    count = len(srv.library.refresh(force=True))
    print('cassette-server: %d tracks under %s' % (count, os.path.abspath(args.root)))
    print('listening on http://%s:%d' % (args.host, args.port))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
