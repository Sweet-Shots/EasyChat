#!/usr/bin/env python3
"""EasyChat - run this on the device that should host the chat room.

    python server.py

No third-party packages: everything here is Python's standard library.
"""

import atexit
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from easychat import httpd  # noqa: E402
from easychat.accounts import Accounts  # noqa: E402
from easychat.config import Settings, load_env  # noqa: E402
from easychat.hub import Hub  # noqa: E402
from easychat.readstate import ReadState  # noqa: E402
from easychat.store import ChatStore  # noqa: E402
from easychat.uploads import Uploads  # noqa: E402

HEARTBEAT_SECONDS = 30
TYPING_SWEEP_SECONDS = 2.5

ES_CONTINUOUS = 0x80000000
ES_SYSTEM_REQUIRED = 0x00000001


def keep_awake():
    """Ask Windows not to sleep while the chat is up. Returns a cleanup call.

    A sleeping host takes the chat down with it, so this is worth asking for -
    but it is only a request: a forced group-policy sleep or a closed lid still
    wins."""
    if os.name != "nt":
        return lambda: None
    try:
        import ctypes

        ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)
    except Exception as err:  # not worth failing a chat server over
        print(f"[power] could not ask Windows to stay awake: {err}")
        return lambda: None

    def release():
        try:
            import ctypes

            ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS)
        except Exception:
            pass

    return release


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


def banner(settings, accounts):
    print()
    print("  EasyChat is running")
    print(f"  Local:      http://localhost:{settings.port}")
    print(f"  Chats:      {settings.chats_dir}")
    print(f"  Accounts:   {accounts.count()} registered"
          f"{' - the first person to register becomes the host' if not accounts.count() else ''}")
    print(f"  Invite code:{' required to register' if settings.requires_password else ' none (anyone with the link can register)'}")
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

    accounts = Accounts(
        settings.accounts_dir, settings.room_password, settings.host_names, settings.owner_names
    ).init()
    uploads = Uploads(
        settings.files_dir, accounts.secret, settings.max_upload_mb, settings.max_storage_mb
    ).init()

    def drop_file(message):
        attachment = message.get("attachment") or {}
        if attachment.get("kind") in ("image", "file"):
            uploads.remove(attachment.get("url"))

    store = ChatStore(settings.chats_dir, settings.max_messages, on_trim=drop_file).init()
    in_use = (
        store.attachment_urls()
        + [profile["avatar"] for profile in accounts.profiles().values() if profile.get("avatar")]
        + accounts.backgrounds()
    )
    orphans = uploads.sweep(in_use)
    if orphans:
        print(f"  Cleaned up {orphans} uploaded file(s) no message points at any more.")
    read_state = ReadState(settings.accounts_dir).init()
    hub = Hub(store, settings, accounts, uploads, read_state)

    try:
        server = httpd.ChatServer(
            ("0.0.0.0", settings.port), httpd.ChatHandler, settings, store, hub, accounts, uploads
        )
    except OSError as err:
        print(f"\nCould not listen on port {settings.port}: {err}")
        print("Another program may be using it - set PORT in .env to something else.\n")
        return 1

    release_power = keep_awake()
    atexit.register(release_power)
    start_loop(HEARTBEAT_SECONDS, hub.heartbeat, "heartbeat")
    start_loop(TYPING_SWEEP_SECONDS, hub.sweep_typing, "typing-sweep")
    banner(settings, accounts)

    try:
        server.serve_forever(poll_interval=0.4)
    except KeyboardInterrupt:
        print("\nSaving chats...")
    finally:
        server.shutdown()
        server.server_close()
        store.flush()
        accounts.save()
        read_state.save()
        release_power()
    return 0


if __name__ == "__main__":
    sys.exit(main())
