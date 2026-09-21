// app.js — Cassette. Everything lives on the device; nothing is ever uploaded.
import { readTags } from './tags.js';

/* ------------------------------------------------------------------ *
 * IndexedDB
 * Metadata and audio blobs are kept in separate stores so that loading
 * the library never drags hundreds of megabytes of audio into memory.
 * ------------------------------------------------------------------ */
const DB_NAME = 'cassette';
const DB_VERSION = 2;
let dbHandle = null;

function openDB() {
  if (dbHandle) return Promise.resolve(dbHandle);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tracks')) {
        const s = db.createObjectStore('tracks', { keyPath: 'id' });
        s.createIndex('byAlbum', 'albumKey');
        s.createIndex('byArtist', 'artistKey');
        s.createIndex('byAdded', 'addedAt');
      }
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio');
      if (!db.objectStoreNames.contains('art')) db.createObjectStore('art');
      if (!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('remote')) db.createObjectStore('remote');
    };
    req.onsuccess = () => { dbHandle = req.result; resolve(dbHandle); };
    req.onerror = () => reject(req.error);
  });
}

function idb(store, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    if (req) { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }
    else tx.oncomplete = () => resolve();
  }));
}

const dbGet = (s, k) => idb(s, 'readonly', (o) => o.get(k));
const dbAll = (s) => idb(s, 'readonly', (o) => o.getAll());
const dbKeys = (s) => idb(s, 'readonly', (o) => o.getAllKeys());
const dbPut = (s, v, k) => idb(s, 'readwrite', (o) => o.put(v, k));
const dbDel = (s, k) => idb(s, 'readwrite', (o) => o.delete(k));

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */
const state = {
  tracks: [],
  playlists: [],
  view: 'songs',
  detail: null,          // { kind: 'album'|'artist'|'playlist', key }
  search: '',
  queue: [],             // track ids, in the order they will play
  queueIndex: -1,
  shuffle: false,
  repeat: 'off',         // 'off' | 'all' | 'one'
  importing: null,       // { done, total, label }
  sheetOpen: false,
  server: '',            // music server base URL, '' when not configured
  serverState: 'idle',   // 'idle' | 'checking' | 'ok' | 'error'
  serverMsg: '',
  serverDraft: null,     // what is typed in the server box, before connecting
  serverSync: null       // { done, total } while reading tags off the server
};

const artURLs = new Map();   // albumKey -> { url, type }
let currentAudioURL = null;

const audio = new Audio();
audio.preload = 'auto';

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const keyOf = (s) => String(s || '').trim().toLowerCase();

// Tags routinely cram every credited artist into one field: "Drake/21 Savage".
// Split those so a feature shows up under both artists — but leave alone names
// that genuinely contain a slash, which are short ones like AC/DC.
const UNSPLITTABLE = new Set(['ac/dc']);

function artistList(raw) {
  const s = String(raw || '').trim();
  if (!s) return ['Unknown Artist'];
  if (s.length <= 6 || UNSPLITTABLE.has(s.toLowerCase())) return [s];
  const parts = s.split(/\s*[\/;]\s*/).map((x) => x.trim()).filter(Boolean);
  return parts.length ? parts : [s];
}

const primaryArtist = (raw) => artistList(raw)[0];
const artistText = (raw) => artistList(raw).join(', ');

// An album belongs to its lead artist; otherwise one record splits into a
// separate tile for every guest feature on it.
const albumKeyFor = (t) => keyOf(primaryArtist(t.albumArtist)) + '::' + keyOf(t.album);

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}

const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

function fmtBytes(n) {
  if (!n) return '0 MB';
  const mb = n / (1024 * 1024);
  return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(0) + ' MB';
}

const byId = (id) => state.tracks.find((t) => t.id === id);

function sortTracks(list) {
  return list.slice().sort((a, b) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
}

function albumOrder(list) {
  return list.slice().sort((a, b) =>
    (a.discNo - b.discNo) || (a.trackNo - b.trackNo) ||
    a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ------------------------------------------------------------------ *
 * Grouping
 * ------------------------------------------------------------------ */
function albums() {
  const map = new Map();
  for (const t of state.tracks) {
    let a = map.get(t.albumKey);
    if (!a) {
      a = { key: t.albumKey, album: t.album, artist: primaryArtist(t.albumArtist), year: t.year, tracks: [] };
      map.set(t.albumKey, a);
    }
    a.tracks.push(t);
    if (!a.year && t.year) a.year = t.year;
  }
  return [...map.values()].sort((x, y) =>
    x.album.localeCompare(y.album, undefined, { sensitivity: 'base' }));
}

function artists() {
  const map = new Map();
  for (const t of state.tracks) {
    for (const name of artistList(t.artist)) {
      const k = keyOf(name);
      let a = map.get(k);
      if (!a) { a = { key: k, name, tracks: [], albums: new Set() }; map.set(k, a); }
      a.tracks.push(t);
      a.albums.add(t.albumKey);
    }
  }
  return [...map.values()].sort((x, y) =>
    x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }));
}

/* ------------------------------------------------------------------ *
 * Import
 * ------------------------------------------------------------------ */
const AUDIO_RE = /\.(mp3|m4a|m4b|aac|mp4|flac|wav|aif|aiff|ogg|oga|opus|caf)$/i;

async function probeDuration(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const probe = new Audio();
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      probe.removeAttribute('src');
      URL.revokeObjectURL(url);
      resolve(isFinite(v) && v > 0 ? v : 0);
    };
    const timer = setTimeout(() => finish(0), 10000);
    probe.onloadedmetadata = () => finish(probe.duration);
    probe.onerror = () => finish(0);
    probe.preload = 'metadata';
    probe.src = url;
  });
}

async function importFiles(fileList) {
  const files = [...fileList].filter((f) => AUDIO_RE.test(f.name) || (f.type || '').startsWith('audio/'));
  if (!files.length) { toast('No audio files in that selection'); return; }

  const seen = new Set(state.tracks.map((t) => t.fileName + '|' + t.size));
  const haveArt = new Set(await dbKeys('art'));
  let added = 0, skipped = 0, failed = 0;

  state.importing = { done: 0, total: files.length, label: '' };
  render();

  for (const file of files) {
    state.importing.done++;
    state.importing.label = file.name;
    renderImport();

    const dupKey = file.name + '|' + file.size;
    if (seen.has(dupKey)) { skipped++; continue; }

    try {
      const tags = await readTags(file);
      const duration = await probeDuration(file);
      const id = (crypto.randomUUID && crypto.randomUUID()) ||
        (Date.now().toString(36) + Math.random().toString(36).slice(2));

      const track = {
        id,
        title: tags.title,
        artist: tags.artist,
        album: tags.album,
        albumArtist: tags.albumArtist,
        year: tags.year,
        genre: tags.genre,
        trackNo: tags.trackNo,
        discNo: tags.discNo,
        duration,
        fileName: file.name,
        size: file.size,
        mime: file.type || 'audio/mpeg',
        addedAt: Date.now(),
        playCount: 0
      };
      track.albumKey = albumKeyFor(track);
      track.artistKey = keyOf(primaryArtist(track.artist));

      await dbPut('audio', file, id);
      await dbPut('tracks', track);

      if (tags.picture && !haveArt.has(track.albumKey)) {
        const artBlob = new Blob([tags.picture.data], { type: tags.picture.mime });
        await dbPut('art', artBlob, track.albumKey);
        haveArt.add(track.albumKey);
        artURLs.set(track.albumKey, { url: URL.createObjectURL(artBlob), type: artBlob.type });
      }

      state.tracks.push(track);
      seen.add(dupKey);
      added++;
    } catch (err) {
      console.warn('import failed', file.name, err);
      failed++;
    }
  }

  state.importing = null;
  render();

  const bits = [added + ' added'];
  if (skipped) bits.push(skipped + ' already in library');
  if (failed) bits.push(failed + ' failed');
  toast(bits.join(' · '));
  requestPersistence();
}

async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch { /* best effort only */ }
}

/* ------------------------------------------------------------------ *
 * Music server
 *
 * The server hands over a file list and nothing else. Tags are read here,
 * from the first chunk of each file via a range request, with the same
 * parser the local import uses — so the box on the shelf stays dumb and
 * dependency-free. Results are cached, so a normal launch costs one small
 * JSON fetch and nothing more.
 * ------------------------------------------------------------------ */
const REMOTE_HEAD_BYTES = 384 * 1024;
const REMOTE_WHOLE_FILE_CAP = 24 * 1024 * 1024;

function normalizeServer(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const withScheme = /^https?:\/\//i.test(s) ? s : 'https://' + s;
  return withScheme.replace(/\/+$/, '');
}

const remoteFileURL = (base, id) => base + '/api/file/' + encodeURIComponent(id);

async function fetchRange(url, start, end) {
  const res = await fetch(url, { headers: { Range: 'bytes=' + start + '-' + end } });
  if (!res.ok && res.status !== 206) throw new Error('HTTP ' + res.status);
  return res.arrayBuffer();
}

// Most formats do not carry duration in their tags, so let an audio element
// report it — that only pulls enough of the file to read the header.
function probeRemoteDuration(url) {
  return new Promise((resolve) => {
    const probe = new Audio();
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      probe.removeAttribute('src');
      resolve(isFinite(v) && v > 0 ? v : 0);
    };
    const timer = setTimeout(() => finish(0), 15000);
    probe.onloadedmetadata = () => finish(probe.duration);
    probe.onerror = () => finish(0);
    probe.preload = 'metadata';
    probe.src = url;
  });
}

async function describeRemote(base, entry) {
  const url = remoteFileURL(base, entry.id);
  const stem = entry.name.replace(/\.[^.]+$/, '');
  let tags = null;

  try {
    const head = await fetchRange(url, 0, Math.min(REMOTE_HEAD_BYTES, entry.size) - 1);
    tags = await readTags(new File([head], entry.name));

    // A few containers keep their metadata at the end of the file. If the head
    // told us nothing, re-read in full — but only when that is cheap.
    const headWasUseless = tags.title === stem && tags.album === 'Unknown Album';
    if (headWasUseless && entry.size > REMOTE_HEAD_BYTES && entry.size <= REMOTE_WHOLE_FILE_CAP) {
      const whole = await (await fetch(url)).arrayBuffer();
      const better = await readTags(new File([whole], entry.name));
      if (better.title !== stem || better.album !== 'Unknown Album') tags = better;
    }
  } catch {
    tags = null;
  }

  if (!tags) tags = await readTags(new File([new ArrayBuffer(0)], entry.name));
  const duration = await probeRemoteDuration(url);
  return { tags, duration };
}

function remoteTrackFrom(base, rec) {
  const t = {
    id: 'remote:' + rec.id,
    serverId: rec.id,
    remote: true,
    src: remoteFileURL(base, rec.id),
    title: rec.title, artist: rec.artist, album: rec.album,
    albumArtist: rec.albumArtist, year: rec.year, genre: rec.genre,
    trackNo: rec.trackNo, discNo: rec.discNo,
    duration: rec.duration, size: rec.size, mime: rec.mime,
    fileName: rec.name, addedAt: (rec.mtime || 0) * 1000, playCount: 0
  };
  t.albumKey = albumKeyFor(t);
  t.artistKey = keyOf(primaryArtist(t.artist));
  return t;
}

const dropRemoteTracks = () => { state.tracks = state.tracks.filter((t) => !t.remote); };

// Show whatever we already know about the server's library, so a phone with no
// route to the Pi still renders the shelf instead of an empty screen.
async function showCachedRemote() {
  if (!state.server) return;
  const offline = new Set(state.tracks.filter((t) => !t.remote && t.serverId).map((t) => t.serverId));
  const recs = await dbAll('remote');
  dropRemoteTracks();
  for (const rec of recs) {
    if (!offline.has(rec.id)) state.tracks.push(remoteTrackFrom(state.server, rec));
  }
}

async function syncServer(opts = {}) {
  const base = state.server;
  if (!base) return;

  state.serverState = 'checking';
  state.serverMsg = '';
  render();

  let entries;
  try {
    const res = await fetch(base + '/api/index.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('server answered ' + res.status);
    const data = await res.json();
    entries = Array.isArray(data.tracks) ? data.tracks : [];
  } catch (err) {
    state.serverState = 'error';
    state.serverMsg = err.message || 'could not reach it';
    await showCachedRemote();
    render();
    if (!opts.quiet) toast('Could not reach the music server');
    return;
  }

  const cached = new Map((await dbAll('remote')).map((r) => [r.id, r]));
  const offline = new Set(state.tracks.filter((t) => !t.remote && t.serverId).map((t) => t.serverId));
  const haveArt = new Set(await dbKeys('art'));
  const stale = entries.filter((e) => {
    const c = cached.get(e.id);
    return !c || c.mtime !== e.mtime;
  });

  if (stale.length) {
    state.importing = { done: 0, total: stale.length, label: 'reading tags' };
    render();
  }

  const fresh = [];
  for (const entry of entries) {
    let rec = cached.get(entry.id);

    if (!rec || rec.mtime !== entry.mtime) {
      const { tags, duration } = await describeRemote(base, entry);
      rec = {
        id: entry.id, name: entry.name, path: entry.path, size: entry.size,
        mtime: entry.mtime, mime: entry.mime, duration,
        title: tags.title, artist: tags.artist, album: tags.album,
        albumArtist: tags.albumArtist, year: tags.year, genre: tags.genre,
        trackNo: tags.trackNo, discNo: tags.discNo
      };
      await dbPut('remote', rec, entry.id);
      cached.set(entry.id, rec);

      const probe = remoteTrackFrom(base, rec);
      if (tags.picture && !haveArt.has(probe.albumKey)) {
        const blob = new Blob([tags.picture.data], { type: tags.picture.mime });
        await dbPut('art', blob, probe.albumKey);
        haveArt.add(probe.albumKey);
        artURLs.set(probe.albumKey, { url: URL.createObjectURL(blob), type: blob.type });
      }

      state.importing.done++;
      state.importing.label = rec.title;
      renderImport();
    }

    if (!offline.has(entry.id)) fresh.push(remoteTrackFrom(base, rec));
  }

  const live = new Set(entries.map((e) => e.id));
  for (const id of cached.keys()) if (!live.has(id)) await dbDel('remote', id);

  dropRemoteTracks();
  state.tracks.push(...fresh);
  state.importing = null;
  state.serverState = 'ok';
  state.serverMsg = fresh.length + ' streaming';
  render();
}

async function connectServer(raw) {
  const base = normalizeServer(raw);
  state.server = base;
  await dbPut('meta', base, 'server');
  if (!base) {
    dropRemoteTracks();
    state.serverState = 'idle';
    state.serverMsg = '';
    await idb('remote', 'readwrite', (o) => o.clear());
    render();
    return;
  }
  await syncServer();
}

// Keep a streamed track on the device, so it survives the Pi being unplugged.
async function saveOffline(track) {
  if (!track || !track.remote) return;
  state.importing = { done: 0, total: 1, label: track.title };
  render();
  try {
    const res = await fetch(track.src);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const file = new File([blob], track.fileName, { type: track.mime || blob.type });
    const id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now());

    const local = Object.assign({}, track, {
      id, remote: false, addedAt: Date.now(), playCount: 0
    });
    delete local.src;

    await dbPut('audio', file, id);
    await dbPut('tracks', local);

    state.queue = state.queue.map((q) => (q === track.id ? id : q));
    state.tracks = state.tracks.filter((t) => t.id !== track.id);
    state.tracks.push(local);
    state.importing = null;
    toast('Saved on this device');
  } catch (err) {
    state.importing = null;
    toast('Could not save: ' + (err.message || 'failed'));
  }
  render();
}


/* ------------------------------------------------------------------ *
 * Playback
 * ------------------------------------------------------------------ */
function shuffled(ids, firstId) {
  const rest = ids.filter((id) => id !== firstId);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return firstId ? [firstId, ...rest] : rest;
}

function playList(tracks, startIndex = 0) {
  if (!tracks.length) return;
  const ids = tracks.map((t) => t.id);
  const startId = ids[Math.max(0, Math.min(startIndex, ids.length - 1))];
  state.queue = state.shuffle ? shuffled(ids, startId) : ids;
  state.queueIndex = state.queue.indexOf(startId);
  loadCurrent(true);
}

async function loadCurrent(autoplay) {
  const track = byId(state.queue[state.queueIndex]);
  if (!track) return;

  let src;
  if (track.remote) {
    src = track.src;                       // streamed straight off the server
  } else {
    const blob = await dbGet('audio', track.id);
    if (!blob) { toast('That file is missing from storage'); return; }
    src = URL.createObjectURL(blob);
  }

  const previousURL = currentAudioURL;
  currentAudioURL = track.remote ? null : src;
  audio.src = src;
  if (previousURL) URL.revokeObjectURL(previousURL);

  intendPlay = !!autoplay;
  if (autoplay) {
    try { await audio.play(); }
    catch (err) { console.warn('play blocked', err); }
  }
  updateMediaSession(track);
  saveSession();
  render();
}

function togglePlay() {
  if (!state.queue.length) {
    const all = sortTracks(state.tracks);
    if (all.length) playList(all, 0);
    return;
  }
  if (audio.paused) { intendPlay = true; audio.play().catch(() => {}); }
  else { intendPlay = false; audio.pause(); }
}

function next(userInitiated) {
  if (!state.queue.length) return;
  if (state.repeat === 'one' && !userInitiated) { audio.currentTime = 0; audio.play().catch(() => {}); return; }

  if (state.queueIndex < state.queue.length - 1) state.queueIndex++;
  else if (state.repeat === 'all' || userInitiated) state.queueIndex = 0;
  else { audio.pause(); audio.currentTime = 0; render(); return; }

  loadCurrent(true);
}

function prev() {
  if (!state.queue.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  state.queueIndex = state.queueIndex > 0 ? state.queueIndex - 1 : state.queue.length - 1;
  loadCurrent(true);
}

function toggleShuffle() {
  state.shuffle = !state.shuffle;
  const currentId = state.queue[state.queueIndex];
  if (state.queue.length && currentId) {
    state.queue = state.shuffle
      ? shuffled(state.queue, currentId)
      : sortQueueToNatural(state.queue, currentId);
    state.queueIndex = state.queue.indexOf(currentId);
  }
  saveSession();
  render();
}

// Un-shuffling restores library order rather than the original click order,
// which is close enough and always well-defined.
function sortQueueToNatural(ids, currentId) {
  const set = new Set(ids);
  const ordered = sortTracks(state.tracks.filter((t) => set.has(t.id))).map((t) => t.id);
  return ordered.includes(currentId) ? ordered : [currentId, ...ordered];
}

function cycleRepeat() {
  state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
  saveSession();
  render();
}

function queueNext(id) {
  if (!state.queue.length) { playList([byId(id)], 0); return; }
  state.queue.splice(state.queueIndex + 1, 0, id);
  saveSession();
  toast('Playing next');
  render();
}

function queueLast(id) {
  if (!state.queue.length) { playList([byId(id)], 0); return; }
  state.queue.push(id);
  saveSession();
  toast('Added to queue');
  render();
}

audio.addEventListener('ended', () => {
  const t = byId(state.queue[state.queueIndex]);
  if (t && !t.remote) { t.playCount = (t.playCount || 0) + 1; dbPut('tracks', t); }
  next(false);
});
audio.addEventListener('play', render);
audio.addEventListener('pause', () => { render(); saveSession(); });
audio.addEventListener('timeupdate', () => { renderProgress(); throttledSave(); });
// If files have gone missing, skip forward — but never loop the queue forever.
let consecutiveFailures = 0;
let intendPlay = false;

audio.addEventListener('error', () => {
  if (!audio.src) return;

  // A restored queue is only preloaded. Failing to preload is not a reason to
  // go hunting through the rest of the queue.
  if (!intendPlay) return;

  const failed = byId(state.queue[state.queueIndex]);
  if (failed && failed.remote && state.serverState !== 'ok') {
    consecutiveFailures = 0;
    intendPlay = false;
    audio.pause();
    toast('Your music server is not reachable');
    return;
  }

  consecutiveFailures++;
  if (consecutiveFailures >= Math.max(1, state.queue.length)) {
    consecutiveFailures = 0;
    audio.pause();
    toast('None of these tracks could be played');
    return;
  }
  toast('Could not play that track');
  next(true);
});
audio.addEventListener('playing', () => { consecutiveFailures = 0; });

let saveTimer = 0;
function throttledSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = 0; saveSession(); }, 5000);
}

function saveSession() {
  dbPut('meta', {
    queue: state.queue,
    queueIndex: state.queueIndex,
    position: audio.currentTime || 0,
    shuffle: state.shuffle,
    repeat: state.repeat
  }, 'session').catch(() => {});
}

/* --- lock screen / control centre --- */
function updateMediaSession(track) {
  if (!('mediaSession' in navigator)) return;
  const art = artURLs.get(track.albumKey);
  const meta = {
    title: track.title,
    artist: artistText(track.artist),
    album: track.album
  };
  if (art) meta.artwork = [{ src: art.url, sizes: '512x512', type: art.type || 'image/jpeg' }];
  try { navigator.mediaSession.metadata = new MediaMetadata(meta); } catch { /* older Safari */ }

  const set = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* unsupported */ } };
  set('play', () => audio.play().catch(() => {}));
  set('pause', () => audio.pause());
  set('previoustrack', prev);
  set('nexttrack', () => next(true));
  set('seekto', (d) => { if (d.seekTime != null) audio.currentTime = d.seekTime; });
  set('seekbackward', () => { audio.currentTime = Math.max(0, audio.currentTime - 10); });
  set('seekforward', () => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10); });
}

/* ------------------------------------------------------------------ *
 * Playlists
 * ------------------------------------------------------------------ */
async function createPlaylist(name, trackIds = []) {
  const pl = {
    id: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()),
    name: name.trim() || 'New Playlist',
    trackIds,
    createdAt: Date.now()
  };
  await dbPut('playlists', pl);
  state.playlists.push(pl);
  render();
  return pl;
}

async function addToPlaylist(playlistId, trackId) {
  const pl = state.playlists.find((p) => p.id === playlistId);
  if (!pl) return;
  if (!pl.trackIds.includes(trackId)) pl.trackIds.push(trackId);
  await dbPut('playlists', pl);
  toast('Added to ' + pl.name);
  render();
}

async function removeFromPlaylist(playlistId, trackId) {
  const pl = state.playlists.find((p) => p.id === playlistId);
  if (!pl) return;
  pl.trackIds = pl.trackIds.filter((id) => id !== trackId);
  await dbPut('playlists', pl);
  render();
}

async function deletePlaylist(playlistId) {
  await dbDel('playlists', playlistId);
  state.playlists = state.playlists.filter((p) => p.id !== playlistId);
  if (state.detail && state.detail.kind === 'playlist' && state.detail.key === playlistId) state.detail = null;
  render();
}

async function deleteTrack(id) {
  await dbDel('audio', id);
  await dbDel('tracks', id);
  state.tracks = state.tracks.filter((t) => t.id !== id);

  for (const pl of state.playlists) {
    if (pl.trackIds.includes(id)) {
      pl.trackIds = pl.trackIds.filter((x) => x !== id);
      await dbPut('playlists', pl);
    }
  }

  const wasCurrent = state.queue[state.queueIndex] === id;
  const removedBefore = state.queue.slice(0, state.queueIndex).filter((x) => x === id).length;
  state.queue = state.queue.filter((x) => x !== id);
  state.queueIndex -= removedBefore;

  if (wasCurrent) {
    audio.pause();
    if (state.queue.length) { state.queueIndex = Math.min(state.queueIndex, state.queue.length - 1); loadCurrent(false); }
    else { state.queueIndex = -1; audio.removeAttribute('src'); }
  }
  toast('Removed from library');
  render();
}

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */
function artHTML(albumKey, cls) {
  const art = artURLs.get(albumKey);
  if (art) return '<div class="art ' + cls + '" style="background-image:url(' + art.url + ')"></div>';
  return '<div class="art ' + cls + ' empty">' + noteSVG() + '</div>';
}

const streamSVG = () =>
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 13a9 9 0 0 1 14 0"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><circle cx="12" cy="20" r="1" fill="currentColor"/></svg>';

const noteSVG = () =>
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l12-2v13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="18" r="3" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="18" cy="16" r="3" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';

function trackRow(t, index, opts = {}) {
  const isNow = state.queue[state.queueIndex] === t.id;
  const unreachable = t.remote && state.serverState === 'error';
  return (
    '<li class="row track' + (isNow ? ' now' : '') + (unreachable ? ' unavailable' : '') +
      '" data-play="' + index + '">' +
      (opts.showArt === false
        ? '<span class="num">' + (t.trackNo || index + 1) + '</span>'
        : artHTML(t.albumKey, 'sm')) +
      '<span class="meta">' +
        '<span class="t1">' + esc(t.title) + '</span>' +
        '<span class="t2">' + esc(opts.sub || artistText(t.artist)) + '</span>' +
      '</span>' +
      (t.remote ? '<span class="stream" aria-label="Streams from your server">' + streamSVG() + '</span>' : '') +
      '<span class="dur">' + (t.duration ? fmtTime(t.duration) : '') + '</span>' +
      '<button class="more" data-menu="' + esc(t.id) + '" aria-label="More options">' +
        '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>' +
      '</button>' +
    '</li>'
  );
}

function emptyState() {
  return (
    '<div class="empty-state">' +
      '<div class="es-icon">' + noteSVG() + '</div>' +
      '<h2>No music yet</h2>' +
      '<p>Add songs from your Files app. They are stored on this device and play with no internet.</p>' +
      '<button class="btn primary" data-act="import">Add music</button>' +
    '</div>'
  );
}

function viewSongs() {
  const list = sortTracks(state.tracks);
  if (!list.length) return emptyState();
  return (
    headerBar(plural(list.length, 'song'),
      '<button class="btn small" data-act="shuffle-all">Shuffle</button>') +
    '<ul class="list" data-list="songs">' + list.map((t, i) => trackRow(t, i)).join('') + '</ul>'
  );
}

function viewAlbums() {
  const list = albums();
  if (!list.length) return emptyState();
  return (
    headerBar(plural(list.length, 'album'), '') +
    '<div class="grid">' + list.map((a) =>
      '<button class="card" data-open="album:' + esc(a.key) + '">' +
        artHTML(a.key, 'lg') +
        '<span class="c1">' + esc(a.album) + '</span>' +
        '<span class="c2">' + esc(a.artist) + '</span>' +
      '</button>').join('') +
    '</div>'
  );
}

function viewArtists() {
  const list = artists();
  if (!list.length) return emptyState();
  return (
    headerBar(plural(list.length, 'artist'), '') +
    '<ul class="list">' + list.map((a) =>
      '<li class="row" data-open="artist:' + esc(a.key) + '">' +
        artHTML([...a.albums][0], 'sm round') +
        '<span class="meta">' +
          '<span class="t1">' + esc(a.name) + '</span>' +
          '<span class="t2">' + plural(a.tracks.length, 'song') + '</span>' +
        '</span>' +
        '<span class="chev">' + chevron() + '</span>' +
      '</li>').join('') +
    '</ul>'
  );
}

function viewPlaylists() {
  return (
    headerBar('Playlists', '<button class="btn small" data-act="new-playlist">New</button>') +
    (state.playlists.length
      ? '<ul class="list">' + state.playlists.map((p) =>
          '<li class="row" data-open="playlist:' + esc(p.id) + '">' +
            '<div class="art sm empty">' + noteSVG() + '</div>' +
            '<span class="meta">' +
              '<span class="t1">' + esc(p.name) + '</span>' +
              '<span class="t2">' + plural(p.trackIds.length, 'song') + '</span>' +
            '</span>' +
            '<span class="chev">' + chevron() + '</span>' +
          '</li>').join('') + '</ul>'
      : '<p class="hint">No playlists yet. Tap New to make one.</p>')
  );
}

function viewSearch() {
  const q = state.search.trim().toLowerCase();
  if (!q) return '<p class="hint">Search your library by song, artist or album.</p>';
  const hits = state.tracks.filter((t) =>
    t.title.toLowerCase().includes(q) ||
    t.artist.toLowerCase().includes(q) ||
    t.album.toLowerCase().includes(q));
  if (!hits.length) return '<p class="hint">Nothing matches "' + esc(state.search) + '".</p>';
  const list = sortTracks(hits);
  return '<ul class="list" data-list="search">' + list.map((t, i) => trackRow(t, i)).join('') + '</ul>';
}

function viewDetail() {
  const { kind, key } = state.detail;

  if (kind === 'album') {
    const a = albums().find((x) => x.key === key);
    if (!a) return emptyState();
    const list = albumOrder(a.tracks);
    return detailShell(artHTML(a.key, 'hero'), a.album,
      esc(a.artist) + (a.year ? ' · ' + esc(a.year) : '') + ' · ' + plural(list.length, 'song'),
      list, { showArt: false, sub: '' });
  }

  if (kind === 'artist') {
    const a = artists().find((x) => x.key === key);
    if (!a) return emptyState();
    const list = sortTracks(a.tracks);
    return detailShell(artHTML([...a.albums][0], 'hero round'), a.name,
      plural(a.albums.size, 'album') + ' · ' + plural(list.length, 'song'),
      list, {});
  }

  const pl = state.playlists.find((p) => p.id === key);
  if (!pl) return emptyState();
  const list = pl.trackIds.map(byId).filter(Boolean);
  return detailShell('<div class="art hero empty">' + noteSVG() + '</div>', pl.name,
    plural(list.length, 'song'), list, { playlistId: pl.id });
}

function detailShell(art, title, sub, list, opts) {
  return (
    '<div class="detail">' +
      '<button class="back" data-act="back">' + chevron(true) + ' Back</button>' +
      '<div class="hero-wrap">' + art +
        '<h1>' + esc(title) + '</h1>' +
        '<p class="sub">' + sub + '</p>' +
        '<div class="hero-actions">' +
          '<button class="btn primary" data-act="play-detail">Play</button>' +
          '<button class="btn" data-act="shuffle-detail">Shuffle</button>' +
          (opts.playlistId ? '<button class="btn danger" data-act="del-playlist" data-id="' + esc(opts.playlistId) + '">Delete</button>' : '') +
        '</div>' +
      '</div>' +
      (list.length
        ? '<ul class="list" data-list="detail">' + list.map((t, i) => trackRow(t, i, opts)).join('') + '</ul>'
        : '<p class="hint">This playlist is empty. Add songs from the ⋮ menu on any track.</p>') +
    '</div>'
  );
}

function headerBar(label, actions) {
  return '<div class="bar"><span>' + esc(label) + '</span><span class="bar-actions">' + actions + '</span></div>';
}

const chevron = (left) => '<svg viewBox="0 0 24 24" class="chev-svg"><path d="' +
  (left ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7') +
  '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* --- the list the current view would play, in display order --- */
function currentList() {
  if (state.detail) {
    const { kind, key } = state.detail;
    if (kind === 'album') {
      const a = albums().find((x) => x.key === key);
      return a ? albumOrder(a.tracks) : [];
    }
    if (kind === 'artist') {
      const a = artists().find((x) => x.key === key);
      return a ? sortTracks(a.tracks) : [];
    }
    const pl = state.playlists.find((p) => p.id === key);
    return pl ? pl.trackIds.map(byId).filter(Boolean) : [];
  }
  if (state.view === 'search') {
    const q = state.search.trim().toLowerCase();
    return sortTracks(state.tracks.filter((t) =>
      t.title.toLowerCase().includes(q) ||
      t.artist.toLowerCase().includes(q) ||
      t.album.toLowerCase().includes(q)));
  }
  return sortTracks(state.tracks);
}

/* ------------------------------------------------------------------ *
 * Render
 * ------------------------------------------------------------------ */
function render() {
  const main = $('#view');
  let html;
  if (state.detail) html = viewDetail();
  else if (state.view === 'songs') html = viewSongs();
  else if (state.view === 'albums') html = viewAlbums();
  else if (state.view === 'artists') html = viewArtists();
  else if (state.view === 'playlists') html = viewPlaylists();
  else if (state.view === 'search') html = viewSearch();
  else html = viewSettings();
  main.innerHTML = html;

  document.querySelectorAll('.tab').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === state.view && !state.detail));
  const searching = state.view === 'search' && !state.detail;
  $('#searchwrap').hidden = !searching;
  $('#searchbtn').classList.toggle('active', searching);

  renderPlayer();
  renderImport();
}

function viewSettings() {
  const local = state.tracks.filter((t) => !t.remote);
  const streamed = state.tracks.filter((t) => t.remote);
  const totalBytes = local.reduce((n, t) => n + (t.size || 0), 0);
  const totalSecs = state.tracks.reduce((n, t) => n + (t.duration || 0), 0);
  const hours = Math.floor(totalSecs / 3600);
  const mins = Math.round((totalSecs % 3600) / 60);

  const status = {
    idle: 'Not connected',
    checking: 'Checking\u2026',
    ok: 'Connected \u00b7 ' + esc(state.serverMsg),
    error: 'Cannot reach it \u00b7 ' + esc(state.serverMsg)
  }[state.serverState] || '';

  const box = state.serverDraft === null ? state.server : state.serverDraft;

  return (
    '<div class="settings">' +
      headerBar('Library', '') +
      '<div class="stats">' +
        '<div><b>' + state.tracks.length + '</b><span>songs</span></div>' +
        '<div><b>' + albums().length + '</b><span>albums</span></div>' +
        '<div><b>' + local.length + '</b><span>on this phone</span></div>' +
        '<div><b>' + streamed.length + '</b><span>on the server</span></div>' +
      '</div>' +

      headerBar('Music server', '') +
      '<div class="server">' +
        '<input id="serverurl" type="url" inputmode="url" autocapitalize="off" ' +
          'autocorrect="off" spellcheck="false" placeholder="https://your-pi.tailnet.ts.net" ' +
          'value="' + esc(box) + '">' +
        '<div class="server-row">' +
          '<button class="btn small primary" data-act="server-connect">' +
            (state.server ? 'Reconnect' : 'Connect') + '</button>' +
          (state.server ? '<button class="btn small" data-act="server-refresh">Refresh</button>' : '') +
          (state.server ? '<button class="btn small danger" data-act="server-forget">Forget</button>' : '') +
        '</div>' +
        '<p class="status ' + state.serverState + '">' + status + '</p>' +
      '</div>' +

      headerBar('On this phone', '') +
      '<p class="hint small">' + fmtBytes(totalBytes) + ' stored \u00b7 ' +
        hours + 'h ' + mins + 'm of music in the library</p>' +
      '<button class="btn primary wide" data-act="import">Add music from this phone</button>' +
      '<p class="hint" id="quota">Checking storage…</p>' +
      '<div class="about">' +
        '<h3>How this works</h3>' +
        '<p>Songs you add from this phone are stored inside the app and play with no internet at all. Songs on your music server stream over your private network, and any you save are kept here too.</p>' +
        '<p>Keep it on your Home Screen. Removing the app from the Home Screen can let iOS clear its storage, so hold on to the original files as your backup.</p>' +
      '</div>' +
      '<button class="btn danger wide" data-act="wipe">Erase downloaded music</button>' +
    '</div>'
  );
}

function renderImport() {
  const el = $('#import-progress');
  if (!state.importing) { el.hidden = true; return; }
  const { done, total, label } = state.importing;
  el.hidden = false;
  el.querySelector('.ip-bar span').style.width = Math.round((done / total) * 100) + '%';
  el.querySelector('.ip-text').textContent = 'Importing ' + done + ' of ' + total;
  el.querySelector('.ip-file').textContent = label || '';
}

function renderPlayer() {
  const t = byId(state.queue[state.queueIndex]);
  const mini = $('#mini');
  const sheet = $('#sheet');

  if (!t) {
    mini.hidden = true;
    document.body.classList.remove('has-player');
    if (state.sheetOpen) closeSheet();
    return;
  }

  mini.hidden = false;
  document.body.classList.add('has-player');
  const playing = !audio.paused;

  mini.querySelector('.mini-art').innerHTML = artHTML(t.albumKey, 'sm');
  mini.querySelector('.mini-title').textContent = t.title;
  mini.querySelector('.mini-artist').textContent = artistText(t.artist);
  mini.querySelector('.mini-play').innerHTML = playing ? pauseIcon() : playIcon();
  mini.querySelector('.mini-play').setAttribute('aria-label', playing ? 'Pause' : 'Play');

  sheet.querySelector('.np-art').innerHTML = artHTML(t.albumKey, 'xl');
  sheet.querySelector('.np-title').textContent = t.title;
  sheet.querySelector('.np-artist').textContent = artistText(t.artist);
  sheet.querySelector('.np-album').textContent = t.album === 'Unknown Album' ? '' : t.album;
  sheet.querySelector('.np-play').innerHTML = playing ? pauseIcon(34) : playIcon(34);
  sheet.querySelector('.np-play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  sheet.querySelector('.np-shuffle').classList.toggle('on', state.shuffle);
  sheet.querySelector('.np-repeat').classList.toggle('on', state.repeat !== 'off');
  sheet.querySelector('.np-repeat .rep-one').hidden = state.repeat !== 'one';

  const upNext = state.queue.slice(state.queueIndex + 1, state.queueIndex + 26).map(byId).filter(Boolean);
  sheet.querySelector('.np-queue').innerHTML = upNext.length
    ? '<h4>Up next</h4><ul class="list compact">' + upNext.map((q, i) =>
        '<li class="row" data-jump="' + (state.queueIndex + 1 + i) + '">' +
          artHTML(q.albumKey, 'sm') +
          '<span class="meta"><span class="t1">' + esc(q.title) + '</span>' +
          '<span class="t2">' + esc(artistText(q.artist)) + '</span></span>' +
        '</li>').join('') + '</ul>'
    : '<h4>Up next</h4><p class="hint small">End of queue.</p>';

  renderProgress();
}

function renderProgress() {
  const dur = audio.duration || (byId(state.queue[state.queueIndex]) || {}).duration || 0;
  const cur = audio.currentTime || 0;
  const pct = dur ? (cur / dur) * 100 : 0;

  const bar = $('#mini .mini-bar span');
  if (bar) bar.style.width = pct + '%';

  const seek = $('#seek');
  if (seek && !seek.dataset.dragging) seek.value = String(pct);
  const el1 = $('.np-cur'); if (el1) el1.textContent = fmtTime(cur);
  const el2 = $('.np-dur'); if (el2) el2.textContent = fmtTime(dur);

  if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && dur) {
    try {
      navigator.mediaSession.setPositionState({
        duration: dur,
        position: Math.min(cur, dur),
        playbackRate: audio.playbackRate || 1
      });
    } catch { /* Safari throws on odd values */ }
  }
}

const playIcon = (s = 22) => '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>';
const pauseIcon = (s = 22) => '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '"><rect x="7" y="5.5" width="3.6" height="13" rx="1.2" fill="currentColor"/><rect x="13.4" y="5.5" width="3.6" height="13" rx="1.2" fill="currentColor"/></svg>';

/* ------------------------------------------------------------------ *
 * Sheet + menus
 * ------------------------------------------------------------------ */
function openSheet() {
  if (!byId(state.queue[state.queueIndex])) return;
  state.sheetOpen = true;
  $('#sheet').classList.add('open');
  document.body.classList.add('sheet-open');
  renderPlayer();
}

function closeSheet() {
  state.sheetOpen = false;
  $('#sheet').classList.remove('open');
  document.body.classList.remove('sheet-open');
}

function openMenu(trackId) {
  const t = byId(trackId);
  if (!t) return;
  const plItems = state.playlists.map((p) =>
    '<button data-addpl="' + esc(p.id) + '">Add to “' + esc(p.name) + '”</button>').join('');
  const inPlaylist = state.detail && state.detail.kind === 'playlist' ? state.detail.key : '';

  $('#menu').innerHTML =
    '<div class="menu-card">' +
      '<div class="menu-head">' + artHTML(t.albumKey, 'sm') +
        '<span class="meta"><span class="t1">' + esc(t.title) + '</span>' +
        '<span class="t2">' + esc(artistText(t.artist)) + '</span></span>' +
      '</div>' +
      '<button data-mact="next">Play next</button>' +
      '<button data-mact="last">Add to queue</button>' +
      plItems +
      '<button data-mact="newpl">Add to new playlist…</button>' +
      (inPlaylist ? '<button data-mact="rmpl">Remove from this playlist</button>' : '') +
      (t.remote
        ? '<button data-mact="save">Save on this device</button>'
        : t.serverId
          ? '<button class="danger" data-mact="unsave">Remove the offline copy</button>'
          : '<button class="danger" data-mact="delete">Delete from library</button>') +
      '<button class="cancel" data-mact="cancel">Cancel</button>' +
    '</div>';
  $('#menu').dataset.track = trackId;
  $('#menu').classList.add('open');
}

const closeMenu = () => $('#menu').classList.remove('open');

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */
function wire() {
  $('#addbtn').addEventListener('click', () => $('#file').click());

  $('#searchbtn').addEventListener('click', () => {
    state.view = 'search';
    state.detail = null;
    render();
    setTimeout(() => $('#search').focus(), 50);
  });

  $('#file').addEventListener('change', (e) => {
    importFiles(e.target.files);
    e.target.value = '';
  });

  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
    state.view = b.dataset.view;
    state.detail = null;
    render();
    $('#view').scrollTop = 0;
    if (state.view === 'settings') showQuota();
    if (state.view === 'search') setTimeout(() => $('#search').focus(), 50);
  }));

  $('#search').addEventListener('input', (e) => { state.search = e.target.value; render(); });

  // Hold the typed server address across re-renders so it is not wiped mid-edit.
  $('#view').addEventListener('input', (e) => {
    if (e.target.id === 'serverurl') state.serverDraft = e.target.value;
  });

  // One delegated handler for the whole scrolling view.
  $('#view').addEventListener('click', async (e) => {
    const menuBtn = e.target.closest('[data-menu]');
    if (menuBtn) { e.stopPropagation(); openMenu(menuBtn.dataset.menu); return; }

    const open = e.target.closest('[data-open]');
    if (open) {
      const [kind, ...rest] = open.dataset.open.split(':');
      state.detail = { kind, key: rest.join(':') };
      render();
      $('#view').scrollTop = 0;
      return;
    }

    const row = e.target.closest('[data-play]');
    if (row) { playList(currentList(), Number(row.dataset.play)); return; }

    const act = e.target.closest('[data-act]');
    if (!act) return;

    switch (act.dataset.act) {
      case 'import': $('#file').click(); break;
      case 'back': state.detail = null; render(); break;
      case 'shuffle-all': {
        const list = sortTracks(state.tracks);
        if (!list.length) break;
        state.shuffle = true;
        playList(list, Math.floor(Math.random() * list.length));
        break;
      }
      case 'play-detail': playList(currentList(), 0); break;
      case 'shuffle-detail': {
        const list = currentList();
        if (!list.length) break;
        state.shuffle = true;
        playList(list, Math.floor(Math.random() * list.length));
        break;
      }
      case 'new-playlist': {
        const name = prompt('Playlist name');
        if (name != null) await createPlaylist(name);
        break;
      }
      case 'del-playlist':
        if (confirm('Delete this playlist? The songs stay in your library.')) await deletePlaylist(act.dataset.id);
        break;
      case 'server-connect': {
        const raw = state.serverDraft === null ? state.server : state.serverDraft;
        state.serverDraft = null;
        await connectServer(raw);
        break;
      }
      case 'server-refresh': await syncServer(); break;
      case 'server-forget':
        if (confirm('Forget this server? Songs you saved on the phone stay.')) await connectServer('');
        break;
      case 'wipe':
        if (confirm('Erase every song from this app? Your original files are untouched.')) await wipeAll();
        break;
    }
  });

  // Mini player
  $('#mini').addEventListener('click', (e) => {
    if (e.target.closest('.mini-play')) { e.stopPropagation(); togglePlay(); return; }
    if (e.target.closest('.mini-next')) { e.stopPropagation(); next(true); return; }
    openSheet();
  });

  // Now playing sheet
  $('#sheet').addEventListener('click', (e) => {
    if (e.target.closest('.np-close, .np-grab')) return closeSheet();
    if (e.target.closest('.np-play')) return togglePlay();
    if (e.target.closest('.np-next')) return next(true);
    if (e.target.closest('.np-prev')) return prev();
    if (e.target.closest('.np-shuffle')) return toggleShuffle();
    if (e.target.closest('.np-repeat')) return cycleRepeat();
    const jump = e.target.closest('[data-jump]');
    if (jump) { state.queueIndex = Number(jump.dataset.jump); loadCurrent(true); }
  });

  wireSheetSwipe();

  const seek = $('#seek');
  const startDrag = () => { seek.dataset.dragging = '1'; };
  const endDrag = () => {
    const dur = audio.duration || 0;
    if (dur) audio.currentTime = (Number(seek.value) / 100) * dur;
    delete seek.dataset.dragging;
  };
  seek.addEventListener('pointerdown', startDrag);
  seek.addEventListener('touchstart', startDrag, { passive: true });
  seek.addEventListener('change', endDrag);
  seek.addEventListener('pointerup', endDrag);

  // Action menu
  $('#menu').addEventListener('click', async (e) => {
    const id = $('#menu').dataset.track;
    const pl = e.target.closest('[data-addpl]');
    if (pl) { await addToPlaylist(pl.dataset.addpl, id); closeMenu(); return; }

    const b = e.target.closest('[data-mact]');
    if (!b) { if (e.target.id === 'menu') closeMenu(); return; }

    switch (b.dataset.mact) {
      case 'next': queueNext(id); break;
      case 'last': queueLast(id); break;
      case 'newpl': {
        const name = prompt('Playlist name');
        if (name != null) await createPlaylist(name, [id]);
        break;
      }
      case 'rmpl': await removeFromPlaylist(state.detail.key, id); break;
      case 'delete': if (confirm('Delete this song from the app?')) await deleteTrack(id); break;
      case 'save': await saveOffline(byId(id)); break;
      case 'unsave':
        if (confirm('Remove the copy on this phone? It stays on your music server.')) {
          await deleteTrack(id);
          if (state.server) await syncServer({ quiet: true });
        }
        break;
    }
    closeMenu();
  });

  // Desktop convenience: drag a folder of music onto the window.
  document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
  document.addEventListener('dragleave', () => document.body.classList.remove('dragging'));
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    document.body.classList.remove('dragging');
    if (e.dataTransfer && e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    if (e.code === 'ArrowRight') next(true);
    if (e.code === 'ArrowLeft') prev();
    if (e.code === 'Escape') { closeMenu(); closeSheet(); }
  });
}

// Drag the sheet down to dismiss it — only from the top, so the queue
// underneath still scrolls normally.
function wireSheetSwipe() {
  const sheet = $('#sheet');
  let startY = null;
  let offset = 0;

  sheet.addEventListener('touchstart', (e) => {
    if (sheet.scrollTop > 0 || e.touches.length !== 1) { startY = null; return; }
    if (e.target.closest('#seek')) { startY = null; return; }
    startY = e.touches[0].clientY;
    offset = 0;
  }, { passive: true });

  sheet.addEventListener('touchmove', (e) => {
    if (startY === null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0) return;
    e.preventDefault();
    offset = dy;
    sheet.classList.add('dragging');
    sheet.style.transform = 'translateY(' + dy + 'px)';
  }, { passive: false });

  const release = () => {
    if (startY === null) return;
    sheet.classList.remove('dragging');
    sheet.style.transform = '';
    if (offset > 90) closeSheet();
    startY = null;
    offset = 0;
  };
  sheet.addEventListener('touchend', release);
  sheet.addEventListener('touchcancel', release);
}

async function showQuota() {
  const el = $('#quota');
  if (!el) return;
  try {
    const est = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    el.textContent = 'Using ' + fmtBytes(est.usage) + ' of about ' + fmtBytes(est.quota) +
      ' available' + (persisted ? ' · storage marked persistent' : '');
  } catch {
    el.textContent = 'Storage usage is not reported by this browser.';
  }
}

async function wipeAll() {
  audio.pause();
  audio.removeAttribute('src');
  for (const name of ['tracks', 'audio', 'art', 'playlists', 'remote']) {
    await idb(name, 'readwrite', (o) => o.clear());
  }
  await dbDel('meta', 'session');
  for (const art of artURLs.values()) URL.revokeObjectURL(art.url);
  artURLs.clear();
  Object.assign(state, { tracks: [], playlists: [], queue: [], queueIndex: -1, detail: null });
  render();
  toast('Downloaded music erased');
  if (state.server) await syncServer({ quiet: true });   // the server shelf comes back
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
// Imports made before album grouping moved to the lead artist keyed albums on
// the whole "Drake/21 Savage" credit, which split one record across many tiles.
// Re-key those in place and carry their cover art over.
async function migrateGroupingKeys() {
  const artKeys = new Set(await dbKeys('art'));
  let moved = 0;

  for (const t of state.tracks) {
    const albumKey = albumKeyFor(t);
    const artistKey = keyOf(primaryArtist(t.artist));
    if (t.albumKey === albumKey && t.artistKey === artistKey) continue;

    if (t.albumKey && artKeys.has(t.albumKey) && !artKeys.has(albumKey)) {
      const blob = await dbGet('art', t.albumKey);
      if (blob) { await dbPut('art', blob, albumKey); artKeys.add(albumKey); }
    }
    t.albumKey = albumKey;
    t.artistKey = artistKey;
    await dbPut('tracks', t);
    moved++;
  }

  if (!moved) return;
  const live = new Set(state.tracks.map((t) => t.albumKey));
  for (const k of artKeys) if (!live.has(k)) await dbDel('art', k);
}

async function boot() {
  wire();

  state.tracks = await dbAll('tracks');
  await migrateGroupingKeys();
  state.playlists = (await dbAll('playlists')).sort((a, b) => a.createdAt - b.createdAt);

  // Album art object URLs, built once up front — one per album, not per track.
  const artKeys = await dbKeys('art');
  for (const k of artKeys) {
    const blob = await dbGet('art', k);
    if (blob) artURLs.set(k, { url: URL.createObjectURL(blob), type: blob.type });
  }

  state.server = (await dbGet('meta', 'server')) || '';
  if (state.server) await showCachedRemote();

  const session = await dbGet('meta', 'session');
  if (session && Array.isArray(session.queue)) {
    const live = new Set(state.tracks.map((t) => t.id));
    state.queue = session.queue.filter((id) => live.has(id));
    state.queueIndex = Math.min(session.queueIndex ?? -1, state.queue.length - 1);
    state.shuffle = !!session.shuffle;
    state.repeat = session.repeat || 'off';
    if (state.queueIndex >= 0) {
      await loadCurrent(false);          // restored paused; iOS needs a tap to start
      if (session.position) audio.currentTime = session.position;
    }
  }

  render();
  $('#splash').remove();

  // Refresh the server shelf in the background; a slow or absent Pi must never
  // hold up the songs already on the phone.
  if (state.server) syncServer({ quiet: true });

  if ('serviceWorker' in navigator) {
    // When a new version takes over, pick it up straight away — but never yank
    // the page out from under playback, and never on the very first visit.
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading || !audio.paused) return;
      reloading = true;
      location.reload();
    });
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('sw', err));
  }
  requestPersistence();
}

boot().catch((err) => {
  console.error(err);
  document.body.innerHTML = '<div class="fatal">Could not start Cassette.<br><small>' + esc(err.message) + '</small></div>';
});
