#!/usr/bin/env python3
"""Lightweight local HTTP server & browser launcher for Uinta Basin Air Ops Sim."""

from __future__ import annotations

import functools
import http.server
import os
import signal
import socket
import sys
import threading
import urllib.request
import webbrowser
from pathlib import Path

PREFERRED_PORT = 8742
STATE_DIR = Path.home() / ".cache" / "uinta-basin-air-ops-sim"
PORT_FILE = STATE_DIR / "server.port"


def server_alive(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/VERSION", timeout=0.6) as resp:
            return resp.status == 200
    except Exception:
        return False


def pick_port() -> int:
    for port in (PREFERRED_PORT, 0):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", port))
                return s.getsockname()[1]
            except OSError:
                continue
    raise RuntimeError("Could not bind a local TCP port")


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args) -> None:  # noqa: A002
        return


def main() -> int:
    web_dir = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent
    if not (web_dir / "index.html").is_file():
        print(f"Error: index.html not found in {web_dir}", file=sys.stderr)
        return 1

    STATE_DIR.mkdir(parents=True, exist_ok=True)
    if PORT_FILE.is_file():
        try:
            existing_port = int(PORT_FILE.read_text().strip())
            if server_alive(existing_port):
                webbrowser.open(f"http://127.0.0.1:{existing_port}/")
                return 0
        except Exception:
            pass

    port = pick_port()
    PORT_FILE.write_text(f"{port}\n")
    handler = functools.partial(QuietHandler, directory=str(web_dir))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    httpd.daemon_threads = True

    def _shutdown(*_args) -> None:
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    url = f"http://127.0.0.1:{port}/"
    threading.Timer(0.25, lambda: webbrowser.open(url)).start()
    print(f"KVEL & Uinta Basin Air Ops Sim serving {web_dir} at {url}")
    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()
        try:
            if PORT_FILE.is_file() and PORT_FILE.read_text().strip() == str(port):
                PORT_FILE.unlink()
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
