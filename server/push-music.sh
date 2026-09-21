#!/usr/bin/env bash
# Copy music from this Mac to the Pi.  ./push-music.sh ~/Downloads/SomeAlbum ...
# Override the target with:  CASSETTE_HOST=name CASSETTE_DEST=/srv/music

set -euo pipefail
HOST="${CASSETTE_HOST:-kalshi}"
DEST="${CASSETTE_DEST:-/srv/music}"

[ $# -gt 0 ] || { echo "usage: $(basename "$0") <folder-or-file> [more...]"; exit 1; }

echo "==> checking $HOST"
ssh -o ConnectTimeout=8 -o BatchMode=yes "$HOST" true 2>/dev/null || {
  echo "cannot reach $HOST over ssh."
  echo "is the Pi powered on and on your tailnet?  tailscale status"
  exit 1
}

echo "==> copying to $HOST:$DEST"
rsync -rh --progress --size-only --no-perms --omit-dir-times "$@" "$HOST:$DEST/"

echo "==> done. The app picks it up on its next refresh."
