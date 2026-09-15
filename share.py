#!/usr/bin/env python3
"""Run EasyChat and put it on the internet through a Cloudflare quick tunnel.

    python share.py

Fetches the cloudflared program into .bin/ the first time - one file, no
installer, no administrator rights. Delete the .bin folder to undo it.
"""

import os
import platform
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from easychat.config import Settings, load_env  # noqa: E402

BIN_DIR = ROOT / ".bin"
RELEASE = "https://github.com/cloudflare/cloudflared/releases/latest/download"
URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")


def cloudflared_asset():
    """(asset name, local file name, is it a tarball) for this machine."""
    system = platform.system().lower()
    machine = platform.machine().lower()
    arm = machine in ("arm64", "aarch64")
    x86 = machine in ("i386", "i686", "x86")

    if system == "windows":
        arch = "arm64" if arm else ("386" if x86 else "amd64")
        return f"cloudflared-windows-{arch}.exe", "cloudflared.exe", False
    if system == "darwin":
        arch = "arm64" if arm else "amd64"
        return f"cloudflared-darwin-{arch}.tgz", "cloudflared", True
    arch = "arm64" if arm else ("386" if x86 else "amd64")
    return f"cloudflared-linux-{arch}", "cloudflared", False


def on_path():
    from shutil import which

    return which("cloudflared")


def download(url, target):
    print(f"  Downloading {url.rsplit('/', 1)[-1]} ...", end="", flush=True)
    request = urllib.request.Request(url, headers={"User-Agent": "EasyChat"})
    with urllib.request.urlopen(request, timeout=60) as response, open(target, "wb") as handle:
        read = 0
        while True:
            chunk = response.read(262144)
            if not chunk:
                break
            handle.write(chunk)
            read += len(chunk)
            if read % (4 * 1024 * 1024) < 262144:
                print(".", end="", flush=True)
    print(" done.")


def ensure_cloudflared():
    existing = on_path()
    if existing:
        return existing

    asset, filename, is_tarball = cloudflared_asset()
    target = BIN_DIR / filename
    if target.is_file():
        return str(target)

    BIN_DIR.mkdir(exist_ok=True)
    print()
    print("  cloudflared is not on this device yet.")
    print("  Fetching it into the project folder - nothing is installed.")
    print()
    try:
        if is_tarball:
            import tarfile

            archive = BIN_DIR / "cloudflared.tgz"
            download(f"{RELEASE}/{asset}", archive)
            with tarfile.open(archive) as tar:
                for member in tar.getmembers():
                    if member.name.endswith("cloudflared"):
                        member.name = "cloudflared"
                        tar.extract(member, BIN_DIR)
                        break
            archive.unlink(missing_ok=True)
        else:
            download(f"{RELEASE}/{asset}", target)
    except Exception as err:
        print(f"\n  Could not download cloudflared: {err}")
        print(f"  Get it by hand from {RELEASE}/{asset}")
        print(f"  and save it as {target}\n")
        return None

    if not target.is_file():
        return None
    if os.name != "nt":
        target.chmod(0o755)
    return str(target)


def wait_for_server(port, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return True
        except OSError:
            time.sleep(0.3)
    return False


def announce(url):
    line = "-" * (len(url) + 8)
    print()
    print(f"  +{line}+")
    print(f"  |    {url}    |")
    print(f"  +{line}+")
    print()
    print("  Share that link (and the passcode) with whoever should join.")
    print("  It works until you stop this window, then you get a new one.")
    print()


def pump(stream, seen):
    for raw in iter(stream.readline, ""):
        text = raw.rstrip()
        match = URL_RE.search(text)
        if match and not seen["announced"]:
            seen["announced"] = True
            announce(match.group(0))
        elif not seen["announced"] and text:
            print(f"  cloudflared | {text[-160:]}")


def main():
    load_env()
    settings = Settings()

    binary = ensure_cloudflared()
    if not binary:
        return 1

    print("  Starting EasyChat ...")
    server = subprocess.Popen([sys.executable, str(ROOT / "server.py")], cwd=str(ROOT))
    if not wait_for_server(settings.port):
        print("\n  The server did not start. Run start.bat on its own to see why.\n")
        server.terminate()
        return 1

    tunnel = subprocess.Popen(
        [binary, "tunnel", "--url", f"http://localhost:{settings.port}"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    seen = {"announced": False}
    reader = threading.Thread(target=pump, args=(tunnel.stdout, seen), daemon=True)
    reader.start()

    try:
        while True:
            if server.poll() is not None:
                print("\n  The chat server stopped.")
                break
            if tunnel.poll() is not None:
                print("\n  The tunnel stopped.")
                break
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\n  Shutting down ...")
    finally:
        for process in (tunnel, server):
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
    return 0


if __name__ == "__main__":
    sys.exit(main())
