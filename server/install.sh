#!/usr/bin/env bash
# Set up the Cassette music server on a Raspberry Pi (or any Debian box).
# Run as root:  sudo ./install.sh
#
# Installs the server, runs it under systemd so it survives reboots, and puts
# it behind `tailscale serve` so it gets a real HTTPS name on your tailnet.
# It touches nothing else on the machine.

set -euo pipefail

MUSIC_DIR="${MUSIC_DIR:-/srv/music}"
PORT="${PORT:-8010}"
RUN_AS="${SUDO_USER:-$(id -un)}"
BIN=/usr/local/bin/cassette-server.py
UNIT=/etc/systemd/system/cassette.service
HERE="$(cd "$(dirname "$0")" && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "run this with sudo"; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required"; exit 1; }

echo "==> installing server"
install -m 0755 "$HERE/cassette-server.py" "$BIN"

echo "==> music folder: $MUSIC_DIR (owned by $RUN_AS)"
mkdir -p "$MUSIC_DIR"
chown -R "$RUN_AS" "$MUSIC_DIR"

echo "==> systemd unit"
cat > "$UNIT" <<UNITEOF
[Unit]
Description=Cassette music server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_AS
ExecStart=$BIN --root $MUSIC_DIR --port $PORT
Restart=on-failure
RestartSec=3
# It only ever reads the music folder.
ProtectSystem=strict
ProtectHome=read-only
ReadOnlyPaths=$MUSIC_DIR
PrivateTmp=yes
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
UNITEOF

systemctl daemon-reload
systemctl enable --now cassette.service
sleep 1
systemctl is-active --quiet cassette.service && echo "    running" || {
  echo "    FAILED — see: journalctl -u cassette -n 40"; exit 1; }

echo "==> exposing it on the tailnet over HTTPS"
if command -v tailscale >/dev/null; then
  tailscale serve --bg --https=443 "http://127.0.0.1:$PORT" 2>/dev/null \
    || tailscale serve https / "http://127.0.0.1:$PORT" 2>/dev/null \
    || echo "    could not configure tailscale serve automatically — see note below"
  echo
  echo "Your server address (paste this into Cassette):"
  tailscale status --json 2>/dev/null \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print('   https://' + d['Self']['DNSName'].rstrip('.'))" \
    2>/dev/null || echo "   run: tailscale status --json | grep DNSName"
else
  echo "    tailscale is not installed. Install it, run 'tailscale up', then re-run this script."
fi

cat <<'NOTE'

If the HTTPS address does not work, HTTPS certificates are probably off for
your tailnet. Turn them on once, free, at:
    https://login.tailscale.com/admin/dns   ->  "HTTPS Certificates" -> Enable
Then re-run this script.

Put music in the folder above and it appears in the app within seconds.
    systemctl status cassette      # is it up
    journalctl -u cassette -f      # watch it
NOTE
