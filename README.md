# Cassette

A music player that lives on your phone. You add your own audio files once,
and from then on it works with no internet at all — airplane mode, dead zones,
flights, the subway.

It is a web app, not an App Store app, so there is nothing to sideload and
nothing that expires after seven days. You add it to your Home Screen and it
behaves like any other app: its own icon, full screen, no browser chrome.

## What it does

- **Reads your tags.** Title, artist, album, album artist, year, genre, track
  and disc numbers, and embedded cover art — from MP3 (ID3v2.2/2.3/2.4), M4A/AAC
  (iTunes atoms), FLAC and Ogg/Opus. Files with no tags fall back to the filename.
- **Sorts itself** into Songs, Albums and Artists.
- **Playlists**, search, queue, shuffle, and repeat (off / all / one).
- **Lock screen controls** — artwork, play/pause, skip, and scrubbing from
  Control Centre and the Lock Screen, and playback continues with the screen off.
- **Remembers where you were** — the queue and position survive a restart.

## How your files are stored

Everything goes into IndexedDB on the device itself. No account, no server, no
upload; the app never sends your audio anywhere. The only network request it
ever makes is fetching its own HTML and JavaScript, and a service worker caches
those on first visit so even that stops after the first load.

Keep the original files somewhere safe. iOS can reclaim storage from a web app
that has been removed from the Home Screen, so treat the phone copy as a copy.

## Adding music

1. Get the files onto the phone — AirDrop from a Mac, or drop them into
   iCloud Drive / Dropbox and open them in the Files app.
2. Open Cassette, tap **+**, and choose **Browse** to pick them out of Files.
   Select as many at once as you like.

On a desktop browser you can also drag a folder of music straight onto the window.

## Streaming from your own server

Cassette can also play from a music server you run — a Raspberry Pi is ideal,
since it can stay on all the time and costs nothing to keep running. You drop
files on the Pi, and they appear on the phone without any transfer step.

The server in `server/` does one job: list a folder and serve byte ranges out
of it. It reads no tags and has no dependencies beyond Python 3, because the
app already has a tested tag reader and pulls the first chunk of each file to
use it. Cached after the first read, so a launch costs one small JSON request.

### On the Pi

```
git clone https://github.com/diegooorrr/cassette
sudo ./cassette/server/install.sh
```

That installs the server, runs it under systemd so it comes back after a
reboot, and puts it behind `tailscale serve`, which gives it a real HTTPS
certificate on your private tailnet. HTTPS is required: the app is served over
HTTPS and browsers refuse to load audio from a plain-HTTP origin.

Tailnet HTTPS certificates are free but off by default — enable them once at
<https://login.tailscale.com/admin/dns> under *HTTPS Certificates*.

### On your Mac

```
./server/push-music.sh ~/Downloads/SomeAlbum
```

### On your phone

Install Tailscale from the App Store and sign in — the Pi is only reachable
inside your own tailnet, never from the open internet. Then in Cassette open
**Library → Music server**, paste the `https://…ts.net` address the installer
printed, and tap Connect.

Everything on the server shows up alongside anything stored on the phone,
marked with a small signal icon. Tap **Save on this device** on any track to
keep a copy for when the Pi is unreachable.

If the server is down, the library still renders — server tracks appear dimmed
and tell you so rather than failing silently.

## Running it yourself

It is five static files with no build step and no dependencies. Serve the
directory over HTTPS (a service worker will not register over plain HTTP,
except on `localhost`):

```
python3 -m http.server 8791
```

## Layout

| File | Purpose |
| --- | --- |
| `index.html` | Markup and all styling |
| `app.js` | Library, storage, playback, UI |
| `tags.js` | Metadata reader (no dependencies) |
| `sw.js` | Service worker — makes the app shell work offline |
| `manifest.webmanifest` | Home Screen name, icon, standalone display |
| `server/cassette-server.py` | Optional music server: file list + byte ranges |
| `server/install.sh` | Sets it up on a Pi under systemd + tailscale serve |
| `server/push-music.sh` | Copies music from your computer to the Pi |
