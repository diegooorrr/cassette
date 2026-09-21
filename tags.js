// tags.js — dependency-free audio metadata reader.
// Handles ID3v2.2/2.3/2.4 (mp3), MP4/iTunes atoms (m4a/aac/alac),
// FLAC Vorbis comments, and Ogg/Opus. Falls back to the filename.

const utf8 = new TextDecoder('utf-8');
const latin1 = new TextDecoder('windows-1252');
const utf16 = new TextDecoder('utf-16');
const utf16be = new TextDecoder('utf-16be');

const NUL = String.fromCharCode(0);
const COPY = String.fromCharCode(0xa9); // the © that prefixes iTunes atom names

const str = (bytes, enc) => {
  if (enc === 3) return utf8.decode(bytes);
  if (enc === 1) return utf16.decode(bytes);
  if (enc === 2) return utf16be.decode(bytes);
  return latin1.decode(bytes);
};

const clean = (s) => (s || '').replace(/\s+$/g, '').trim();
// ID3 text frames may hold several NUL-separated values; the first is the one.
const firstValue = (s) => clean((s || '').split(NUL)[0]);
const four = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u24 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
const synch = (b, o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];

function blank() {
  return {
    title: '', artist: '', album: '', albumArtist: '',
    year: '', genre: '', trackNo: 0, discNo: 0, picture: null
  };
}

// --- ID3v2 (mp3) -----------------------------------------------------------
function readID3(bytes) {
  const out = blank();
  if (bytes.length < 10) return null;
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2]) !== 'ID3') return null;

  const major = bytes[3];
  const flags = bytes[5];
  const size = synch(bytes, 6);
  let pos = 10;
  const end = Math.min(10 + size, bytes.length);

  if (flags & 0x40) pos += major === 4 ? synch(bytes, pos) : u32(bytes, pos) + 4;

  const short = major === 2;
  const headLen = short ? 6 : 10;

  while (pos + headLen <= end) {
    const id = short
      ? String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2])
      : four(bytes, pos);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;

    let len;
    if (short) len = u24(bytes, pos + 3);
    else if (major === 4) len = synch(bytes, pos + 4);
    else len = u32(bytes, pos + 4);
    if (len <= 0 || pos + headLen + len > end) break;

    const body = bytes.subarray(pos + headLen, pos + headLen + len);
    pos += headLen + len;

    if (id === 'APIC' || id === 'PIC') {
      out.picture = out.picture || readAPIC(body, id === 'PIC');
      continue;
    }
    if (id[0] !== 'T') continue;

    const text = firstValue(str(body.subarray(1), body[0]));
    if (!text) continue;

    switch (id) {
      case 'TIT2': case 'TT2': out.title = text; break;
      case 'TPE1': case 'TP1': out.artist = text; break;
      case 'TALB': case 'TAL': out.album = text; break;
      case 'TPE2': case 'TP2': out.albumArtist = text; break;
      case 'TCON': case 'TCO': out.genre = text.replace(/^\((\d+)\)\s*/, ''); break;
      case 'TYER': case 'TYE': case 'TDRC': out.year = text.slice(0, 4); break;
      case 'TRCK': case 'TRK': out.trackNo = parseInt(text, 10) || 0; break;
      case 'TPOS': case 'TPA': out.discNo = parseInt(text, 10) || 0; break;
    }
  }
  return out;
}

function readAPIC(body, isShort) {
  const enc = body[0];
  let p = 1, mime;
  if (isShort) {
    mime = { PNG: 'image/png', JPG: 'image/jpeg' }[latin1.decode(body.subarray(1, 4))] || 'image/jpeg';
    p = 4;
  } else {
    let z = p;
    while (z < body.length && body[z] !== 0) z++;
    mime = latin1.decode(body.subarray(p, z)) || 'image/jpeg';
    p = z + 1;
  }
  p += 1; // picture type byte

  // Description terminator is two NUL bytes for the UTF-16 encodings, one otherwise.
  if (enc === 1 || enc === 2) {
    while (p + 1 < body.length && !(body[p] === 0 && body[p + 1] === 0)) p += 2;
    p += 2;
  } else {
    while (p < body.length && body[p] !== 0) p++;
    p += 1;
  }
  if (p >= body.length) return null;
  return { mime, data: body.slice(p) };
}

// --- MP4 / M4A -------------------------------------------------------------
const MP4_CONTAINERS = new Set(['moov', 'udta', 'meta', 'ilst', 'trak', 'mdia', 'minf', 'stbl']);

function readMP4(bytes) {
  const out = blank();
  let found = false;

  const walk = (start, end, depth) => {
    let p = start;
    while (p + 8 <= end && depth < 8) {
      let size = u32(bytes, p);
      const type = four(bytes, p + 4);
      let head = 8;
      if (size === 1) {
        if (p + 16 > end) break;
        size = u32(bytes, p + 12); // 64-bit size; high word is 0 for real-world songs
        head = 16;
      }
      if (size === 0) size = end - p;
      if (size < head || p + size > end) break;

      const bodyStart = p + head + (type === 'meta' ? 4 : 0);

      if (MP4_CONTAINERS.has(type)) {
        walk(bodyStart, p + size, depth + 1);
      } else if (type.charCodeAt(0) === 0xa9 || ['aART', 'trkn', 'disk', 'covr', 'gnre'].includes(type)) {
        readIlstItem(bytes, type, bodyStart, p + size, out);
        found = true;
      }
      p += size;
    }
  };

  walk(0, bytes.length, 0);
  return found || out.title ? out : null;
}

function readIlstItem(bytes, type, start, end, out) {
  let p = start;
  while (p + 8 <= end) {
    const size = u32(bytes, p);
    const kind = four(bytes, p + 4);
    if (size < 8 || p + size > end) break;

    if (kind === 'data') {
      const flag = u32(bytes, p + 8) & 0xffffff;
      const data = bytes.subarray(p + 16, p + size);
      if (type === 'covr') {
        out.picture = out.picture || { mime: flag === 13 ? 'image/jpeg' : 'image/png', data: data.slice(0) };
      } else if (type === 'trkn' || type === 'disk') {
        const n = data.length >= 4 ? (data[2] << 8) | data[3] : 0;
        if (type === 'trkn') out.trackNo = n; else out.discNo = n;
      } else {
        const text = clean(utf8.decode(data));
        if (text) {
          if (type === COPY + 'nam') out.title = text;
          else if (type === COPY + 'ART') out.artist = text;
          else if (type === COPY + 'alb') out.album = text;
          else if (type === 'aART') out.albumArtist = text;
          else if (type === COPY + 'day') out.year = text.slice(0, 4);
          else if (type === COPY + 'gen' || type === 'gnre') out.genre = text;
        }
      }
    }
    p += size;
  }
}

// --- FLAC ------------------------------------------------------------------
function readFLAC(bytes) {
  if (latin1.decode(bytes.subarray(0, 4)) !== 'fLaC') return null;
  const out = blank();
  let p = 4;
  while (p + 4 <= bytes.length) {
    const last = bytes[p] & 0x80;
    const type = bytes[p] & 0x7f;
    const len = u24(bytes, p + 1);
    const body = bytes.subarray(p + 4, p + 4 + len);
    if (type === 4) applyVorbis(body, out);
    else if (type === 6) out.picture = out.picture || readFlacPicture(body);
    p += 4 + len;
    if (last) break;
  }
  return out;
}

function applyVorbis(body, out) {
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let p = 0;
  if (p + 4 > body.length) return;
  const vlen = dv.getUint32(p, true); p += 4 + vlen;
  if (p + 4 > body.length) return;
  const count = dv.getUint32(p, true); p += 4;

  for (let i = 0; i < count && p + 4 <= body.length; i++) {
    const len = dv.getUint32(p, true); p += 4;
    const line = utf8.decode(body.subarray(p, p + len)); p += len;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).toUpperCase();
    const val = line.slice(eq + 1).trim();
    if (!val) continue;

    if (key === 'TITLE') out.title = val;
    else if (key === 'ARTIST') out.artist = val;
    else if (key === 'ALBUM') out.album = val;
    else if (key === 'ALBUMARTIST') out.albumArtist = val;
    else if (key === 'DATE' || key === 'YEAR') out.year = val.slice(0, 4);
    else if (key === 'GENRE') out.genre = val;
    else if (key === 'TRACKNUMBER') out.trackNo = parseInt(val, 10) || 0;
    else if (key === 'DISCNUMBER') out.discNo = parseInt(val, 10) || 0;
    else if (key === 'METADATA_BLOCK_PICTURE') {
      try {
        const raw = Uint8Array.from(atob(val), (c) => c.charCodeAt(0));
        out.picture = out.picture || readFlacPicture(raw);
      } catch { /* malformed art is not worth failing an import over */ }
    }
  }
}

function readFlacPicture(b) {
  let p = 4;
  const mimeLen = u32(b, p); p += 4;
  const mime = latin1.decode(b.subarray(p, p + mimeLen)); p += mimeLen;
  const descLen = u32(b, p); p += 4 + descLen;
  p += 16; // width, height, colour depth, indexed colours
  const dataLen = u32(b, p); p += 4;
  if (!dataLen || p + dataLen > b.length) return null;
  return { mime: mime || 'image/jpeg', data: b.slice(p, p + dataLen) };
}

// --- Ogg (Vorbis / Opus) ---------------------------------------------------
function readOgg(bytes) {
  if (latin1.decode(bytes.subarray(0, 4)) !== 'OggS') return null;
  const out = blank();
  const limit = Math.min(bytes.length, 512 * 1024);
  for (let i = 0; i < limit - 8; i++) {
    if (bytes[i] === 0x03 && latin1.decode(bytes.subarray(i + 1, i + 7)) === 'vorbis') {
      applyVorbis(bytes.subarray(i + 7), out);
      return out;
    }
    if (bytes[i] === 0x4f && latin1.decode(bytes.subarray(i, i + 8)) === 'OpusTags') {
      applyVorbis(bytes.subarray(i + 8), out);
      return out;
    }
  }
  return out;
}

// --- filename fallback -----------------------------------------------------
function fromFilename(name) {
  const base = name.replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ').trim();
  const pair = base.match(/^\s*(?:(\d{1,3})\s*[-.–]\s*)?(.+?)\s+[-–]\s+(.+?)\s*$/);
  if (pair) {
    const lead = pair[2].trim();
    // "03 - Just A Title" is a numbered track, not an artist called "03".
    if (!pair[1] && /^\d{1,3}$/.test(lead)) {
      return { trackNo: parseInt(lead, 10), artist: '', title: pair[3].trim() };
    }
    return { trackNo: parseInt(pair[1], 10) || 0, artist: lead, title: pair[3].trim() };
  }
  const numbered = base.match(/^\s*(\d{1,3})[\s.\-]+(.+)$/);
  if (numbered) return { trackNo: parseInt(numbered[1], 10) || 0, artist: '', title: numbered[2].trim() };
  return { trackNo: 0, artist: '', title: base };
}

export async function readTags(file) {
  let tags = null;
  try {
    // Reading the whole file is fine for songs; anything enormous gets a
    // generous window, which still covers ID3 and front-loaded MP4 atoms.
    const cap = 64 * 1024 * 1024;
    const slice = file.size > cap ? file.slice(0, 8 * 1024 * 1024) : file;
    const bytes = new Uint8Array(await slice.arrayBuffer());
    tags = readID3(bytes) || readFLAC(bytes) || readOgg(bytes) || readMP4(bytes);
  } catch {
    tags = null;
  }

  const t = tags || blank();
  const fb = fromFilename(file.name);
  return {
    title: t.title || fb.title || file.name,
    artist: t.artist || t.albumArtist || fb.artist || 'Unknown Artist',
    album: t.album || 'Unknown Album',
    albumArtist: t.albumArtist || t.artist || fb.artist || 'Unknown Artist',
    year: t.year || '',
    genre: t.genre || '',
    trackNo: t.trackNo || fb.trackNo || 0,
    discNo: t.discNo || 0,
    picture: t.picture && t.picture.data && t.picture.data.length ? t.picture : null
  };
}
