#!/usr/bin/env python3
"""Serve the Diligent III tracker locally.

The app is plain static files, but it uses ES modules, which browsers refuse to
load over file://. This is a stdlib-only static server bound to localhost.

    python3 server.py [port]        # default http://localhost:8000
"""

import http.server
import socketserver
import sys
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # Local-only tool; never let a stale module linger between edits.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    with socketserver.TCPServer(("127.0.0.1", port), Handler) as httpd:
        url = f"http://localhost:{port}/"
        print(f"Diligent III running at {url}  (ctrl-C to stop)")
        try:
            webbrowser.open(url)
        except Exception:
            pass
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
