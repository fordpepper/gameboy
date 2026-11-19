#!/bin/sh
# Serve the emulator on your LAN. Open the printed URL on the iPad (same Wi-Fi).
cd "$(dirname "$0")"
IP=$(ip -4 route get 1.1.1.1 2>/dev/null | grep -o 'src [0-9.]*' | cut -d' ' -f2)
echo "Open on iPad:  http://${IP:-<this-machine-ip>}:8000"
exec python3 - <<'PY'
import http.server, functools
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()
http.server.ThreadingHTTPServer(('0.0.0.0', 8000), H).serve_forever()
PY
