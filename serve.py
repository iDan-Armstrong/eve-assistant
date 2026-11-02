"""Serve the New Eden Atlas locally.

    python serve.py        # http://localhost:8800 and opens your browser

A plain static file server (the map is a static site — the same files
deploy unchanged to GitHub Pages). No dependencies.
"""

from __future__ import annotations

import functools
import http.server
import threading
import webbrowser
from pathlib import Path

HOST, PORT = "127.0.0.1", 8800
WEB = Path(__file__).resolve().parent / "web"


def main() -> None:
    handler = functools.partial(http.server.SimpleHTTPRequestHandler,
                                directory=str(WEB))
    server = http.server.ThreadingHTTPServer((HOST, PORT), handler)
    url = f"http://{HOST}:{PORT}"
    print(f"New Eden Atlas: {url}  (Ctrl+C to stop)")
    threading.Timer(0.8, webbrowser.open, (url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
