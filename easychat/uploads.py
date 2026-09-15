"""Images and files: stored next to the chats, served back by unguessable URL.

Three rules shape this module:

- The type is decided by looking at the bytes, not by what the browser claimed.
- Anything that is not a known-safe image is served as a download, never
  rendered in the page, so an upload cannot become script on this origin.
- Every stored file is described by a signed dict. The browser echoes that
  back when it sends the message, so nobody can attach a path they did not
  upload.
"""

import hmac
import json
import os
import re
import secrets
import shutil
import struct
import threading
import uuid

# what a browser may render inline; everything else downloads
IMAGE_TYPES = {
    b"\x89PNG\r\n\x1a\n": ("image/png", ".png"),
    b"\xff\xd8\xff": ("image/jpeg", ".jpg"),
    b"GIF87a": ("image/gif", ".gif"),
    b"GIF89a": ("image/gif", ".gif"),
}

SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._ -]+")
TICKET_TTL_MS = 10 * 60 * 1000

_lock = threading.Lock()


def sniff(head):
    """(mime, extension, is_image) from the leading bytes."""
    for magic, (mime, ext) in IMAGE_TYPES.items():
        if head.startswith(magic):
            return mime, ext, True
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp", ".webp", True
    if head[:4] == b"%PDF":
        return "application/pdf", ".pdf", False
    return "application/octet-stream", ".bin", False


def png_size(data):
    if len(data) > 24 and data.startswith(b"\x89PNG\r\n\x1a\n"):
        width, height = struct.unpack(">II", data[16:24])
        return width, height
    return 0, 0


def gif_size(data):
    if len(data) > 10 and data[:3] == b"GIF":
        width, height = struct.unpack("<HH", data[6:10])
        return width, height
    return 0, 0


def jpeg_size(data):
    """Walk the JPEG segments for the frame header."""
    index = 2
    while index + 9 < len(data):
        if data[index] != 0xFF:
            index += 1
            continue
        marker = data[index + 1]
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB):
            height, width = struct.unpack(">HH", data[index + 5 : index + 9])
            return width, height
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            index += 2
            continue
        try:
            length = struct.unpack(">H", data[index + 2 : index + 4])[0]
        except struct.error:
            break
        index += 2 + length
    return 0, 0


def webp_size(data):
    if len(data) > 30 and data[12:16] == b"VP8X":
        width = int.from_bytes(data[24:27], "little") + 1
        height = int.from_bytes(data[27:30], "little") + 1
        return width, height
    if len(data) > 30 and data[12:16] == b"VP8 ":
        width = int.from_bytes(data[26:28], "little") & 0x3FFF
        height = int.from_bytes(data[28:30], "little") & 0x3FFF
        return width, height
    return 0, 0


def image_size(mime, data):
    if mime == "image/png":
        return png_size(data)
    if mime == "image/gif":
        return gif_size(data)
    if mime == "image/jpeg":
        return jpeg_size(data)
    if mime == "image/webp":
        return webp_size(data)
    return 0, 0


def tidy_name(raw, fallback_ext):
    name = SAFE_NAME_RE.sub("", str(raw or "").strip())[:80]
    name = name.lstrip(".") or f"upload{fallback_ext}"
    return name


class Uploads:
    def __init__(self, directory, secret, max_file_mb=10, max_total_mb=1024):
        self.dir = directory
        self.secret = secret
        self.max_file_bytes = max_file_mb * 1024 * 1024
        self.max_total_bytes = max_total_mb * 1024 * 1024
        self._spent = set()

    def init(self):
        self.dir.mkdir(parents=True, exist_ok=True)
        return self

    # ---------- tickets ----------

    def mint_ticket(self, username, room_id, now_ms):
        body = f"{username}|{room_id}|{now_ms + TICKET_TTL_MS}"
        signature = hmac.new(self.secret, body.encode("utf-8"), "sha256").hexdigest()[:32]
        return f"{body}|{signature}"

    def spend_ticket(self, ticket):
        """A ticket is good for one upload, so a stale one cannot be replayed."""
        with _lock:
            if ticket in self._spent:
                return False
            self._spent.add(ticket)
            if len(self._spent) > 500:
                self._spent = set(list(self._spent)[-200:])
            return True

    def check_ticket(self, ticket, now_ms):
        try:
            username, room_id, expiry, signature = str(ticket or "").rsplit("|", 3)
        except ValueError:
            return None
        body = f"{username}|{room_id}|{expiry}"
        expected = hmac.new(self.secret, body.encode("utf-8"), "sha256").hexdigest()[:32]
        if not hmac.compare_digest(signature, expected):
            return None
        try:
            if int(expiry) < now_ms:
                return None
        except ValueError:
            return None
        return username, room_id

    # ---------- the attachment dict, signed so it cannot be forged ----------

    def sign_attachment(self, attachment):
        body = json.dumps(attachment, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return hmac.new(self.secret, body, "sha256").hexdigest()[:32]

    def check_attachment(self, attachment, signature):
        if not isinstance(attachment, dict) or not signature:
            return False
        return hmac.compare_digest(self.sign_attachment(attachment), str(signature))

    # ---------- disk ----------

    def total_bytes(self):
        total = 0
        for root, _dirs, files in os.walk(self.dir):
            for name in files:
                try:
                    total += os.path.getsize(os.path.join(root, name))
                except OSError:
                    pass
        return total

    def room_dir(self, room_id):
        safe = re.sub(r"[^A-Za-z0-9_.-]+", "", room_id)[:64] or "room"
        return self.dir / safe

    def store(self, room_id, data, claimed_name):
        """Returns the attachment dict, or raises ValueError with a reason."""
        if not data:
            raise ValueError("That file is empty.")
        if len(data) > self.max_file_bytes:
            raise ValueError(f"Files have to be under {self.max_file_bytes // (1024 * 1024)} MB.")
        with _lock:
            if self.total_bytes() + len(data) > self.max_total_bytes:
                raise ValueError("The host has run out of room for uploads.")

            mime, ext, is_image = sniff(data[:32])
            folder = self.room_dir(room_id)
            folder.mkdir(parents=True, exist_ok=True)
            stored = f"{uuid.uuid4().hex}{secrets.token_hex(4)}{ext}"
            path = folder / stored
            path.write_bytes(data)

        name = tidy_name(claimed_name, ext)
        attachment = {
            "kind": "image" if is_image else "file",
            "url": f"/files/{folder.name}/{stored}",
            "name": name,
            "size": len(data),
            "mime": mime,
        }
        if is_image:
            width, height = image_size(mime, data)
            attachment["width"] = width
            attachment["height"] = height
        return attachment

    def resolve(self, relative):
        """A published /files/... path back to a real file, or None."""
        parts = [part for part in str(relative or "").split("/") if part not in ("", ".", "..")]
        if len(parts) != 2:
            return None
        candidate = (self.dir / parts[0] / parts[1]).resolve()
        try:
            inside = candidate.is_relative_to(self.dir.resolve())
        except AttributeError:  # Python < 3.9
            inside = str(candidate).startswith(str(self.dir.resolve()))
        return candidate if inside and candidate.is_file() else None

    def remove(self, url):
        """Used when a message is deleted or trimmed away."""
        if not isinstance(url, str) or not url.startswith("/files/"):
            return
        target = self.resolve(url[len("/files/") :])
        if target:
            try:
                target.unlink()
            except OSError:
                pass

    def sweep(self, known_urls):
        """Delete files no surviving message points at."""
        keep = {url for url in known_urls if isinstance(url, str)}
        removed = 0
        if not self.dir.is_dir():
            return 0
        for folder in self.dir.iterdir():
            if not folder.is_dir():
                continue
            for item in folder.iterdir():
                if f"/files/{folder.name}/{item.name}" not in keep:
                    try:
                        item.unlink()
                        removed += 1
                    except OSError:
                        pass
            try:
                next(folder.iterdir())
            except StopIteration:
                shutil.rmtree(folder, ignore_errors=True)
            except OSError:
                pass
        return removed
