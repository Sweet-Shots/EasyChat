#!/usr/bin/env python3
"""EasyChat - run this on the device that should host the chat room.

    python server.py

No third-party packages: everything here is Python's standard library.
"""

import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from easychat import httpd  # noqa: E402
from easychat.config import Settings, load_env  # noqa: E402
from easychat.hub import Hub  # noqa: E402
from easychat.store import ChatStore  # noqa: E402

HEARTBEAT_SECONDS = 30
TYPING_SWEEP_SECONDS = 2.5


def start_loop(interval, action, name):
    def run():
        while True:
            time.sleep(interval)
            try:
                action()
            except Exception as err:  # one bad tick must not kill the loop
                print(f"[{name}] {err}")

    thread = threading.Thread(target=run, name=name, daemon=True)
    thread.start()
    return thread


def banner(settings):
    print()
    print("  EasyChat is running")
    print(f"  Local:      http://localhost:{settings.port}")
    print(f"  Chats:      {settings.chats_dir}")
    print(f"  Passcode:   {'required' if settings.requires_password else 'none (anyone with the link can join)'}")
    print(f"  GIF search: {'on (Tenor)' if settings.gifs_enabled else 'off (set TENOR_API_KEY in .env)'}")
    print()
    print("  Share it:   run share.bat  (Windows)  or  ./share.sh")
    print("  Stop it:    Ctrl+C")
    print()


def main():
    load_env()
    settings = Settings()

    if not settings.public_dir.is_dir():
        print(f"Cannot find the web files at {settings.public_dir}")
        return 1

    store = ChatStore(settings.chats_dir, settings.max_messages).init()
    hub = Hub(store, settings)

    try:
        server = httpd.ChatServer(("0.0.0.0", settings.port), httpd.ChatHandler, settings, store, hub)
    except OSError as err:
        print(f"\nCould not listen on port {settings.port}: {err}")
        print("Another program may be using it - set PORT in .env to something else.\n")
        return 1

    start_loop(HEARTBEAT_SECONDS, hub.heartbeat, "heartbeat")
    start_loop(TYPING_SWEEP_SECONDS, hub.sweep_typing, "typing-sweep")
    banner(settings)

    try:
        server.serve_forever(poll_interval=0.4)
    except KeyboardInterrupt:
        print("\nSaving chats...")
    finally:
        server.shutdown()
        server.server_close()
        store.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
