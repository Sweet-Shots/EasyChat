"""Rooms on disk - one JSON file per room inside the chats folder.

Nothing here is clever on purpose: a room is a dict, a file is that dict
dumped with indent=2, so the host can open one in Notepad and read it.
"""

import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
import unicodedata

SAVE_DEBOUNCE_SECONDS = 0.4

PBKDF2_ITERATIONS = 120_000
MIN_PASSWORD_LENGTH = 4


def hash_password(plain):
    """Room passwords are stored hashed, never as the typed text."""
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", plain.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return {
        "algo": "pbkdf2_sha256",
        "iterations": PBKDF2_ITERATIONS,
        "salt": salt.hex(),
        "hash": digest.hex(),
    }


def verify_password(stored, candidate):
    if not isinstance(stored, dict) or not candidate:
        return False
    try:
        salt = bytes.fromhex(stored["salt"])
        iterations = int(stored["iterations"])
        expected = bytes.fromhex(stored["hash"])
    except (KeyError, TypeError, ValueError):
        return False
    digest = hashlib.pbkdf2_hmac("sha256", str(candidate).encode("utf-8"), salt, iterations)
    return hmac.compare_digest(digest, expected)


def is_locked(room):
    return isinstance(room.get("password"), dict)


def slugify(name):
    text = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()[:32]
    return text or "room"


def now_ms():
    return int(time.time() * 1000)


class ChatStore:
    def __init__(self, directory, max_messages=2000, on_trim=None):
        self.dir = directory
        self.max_messages = max_messages
        self.on_trim = on_trim  # called with each message that falls off the end
        self.rooms = {}
        self.lock = threading.RLock()
        self._timers = {}

    # ---------- loading ----------

    def init(self):
        self.dir.mkdir(parents=True, exist_ok=True)
        rehashed = []
        for path in sorted(self.dir.glob("*.json")):
            try:
                room = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(room, dict) or not isinstance(room.get("id"), str):
                    raise ValueError("missing room id")
                room.setdefault("messages", [])
                room.setdefault("topic", "")
                room.setdefault("createdAt", now_ms())
                if not isinstance(room["messages"], list):
                    room["messages"] = []
                self.rooms[room["id"]] = room
                # the host may set or reset a password by typing it into the
                # file as plain text; it gets hashed on the next start
                typed = room.get("password")
                if isinstance(typed, str):
                    if typed.strip():
                        room["password"] = hash_password(typed.strip())
                        rehashed.append(room["id"])
                    else:
                        room.pop("password", None)
                        rehashed.append(room["id"])
                elif typed is not None and not isinstance(typed, dict):
                    room.pop("password", None)
            except Exception as err:  # a hand-edited file should not stop the server
                print(f"[store] skipping {path.name}: {err}")
        for room_id in rehashed:
            self.save(room_id)
            print(f"[store] stored the password for {room_id} as a hash")
        if not self.rooms:
            self.create_room("General", "Open to everyone. Say hi.")
        return self

    def file_path(self, room_id):
        return self.dir / f"{room_id}.json"

    # ---------- reading ----------

    def attachment_urls(self):
        """Every file path still referenced by a message, for the orphan sweep."""
        urls = []
        with self.lock:
            for room in self.rooms.values():
                for message in room["messages"]:
                    attachment = message.get("attachment") or {}
                    if attachment.get("kind") in ("image", "file"):
                        urls.append(attachment.get("url"))
        return urls

    def list_rooms(self):
        with self.lock:
            rooms = sorted(self.rooms.values(), key=lambda r: r["createdAt"])
            return [
                {
                    "id": room["id"],
                    "name": room["name"],
                    "topic": room.get("topic", ""),
                    "messageCount": len(room["messages"]),
                    "lastActivity": room["messages"][-1]["ts"] if room["messages"] else room["createdAt"],
                    "locked": is_locked(room),
                }
                for room in rooms
            ]

    def get_room(self, room_id):
        with self.lock:
            return self.rooms.get(room_id)

    def has_room_named(self, name):
        wanted = name.strip().lower()
        with self.lock:
            return any(room["name"].lower() == wanted for room in self.rooms.values())

    def recent_messages(self, room_id, limit=300):
        with self.lock:
            room = self.rooms.get(room_id)
            return list(room["messages"][-limit:]) if room else []

    # ---------- writing ----------

    def create_room(self, name, topic="", password=None):
        clean = name.strip()[:40]
        with self.lock:
            room_id = slugify(clean)
            while room_id in self.rooms:
                room_id = f"{slugify(clean)}-{secrets.token_hex(2)}"
            room = {
                "id": room_id,
                "name": clean,
                "topic": topic.strip()[:120],
                "createdAt": now_ms(),
                "messages": [],
            }
            if password:
                room["password"] = hash_password(password)
            self.rooms[room_id] = room
        self.save(room_id)
        return room

    def rename_user(self, old, new):
        """Move every mention of a name across, so history keeps its author."""
        touched = []
        with self.lock:
            for room_id, room in self.rooms.items():
                changed = False
                for message in room["messages"]:
                    if message.get("user") == old:
                        message["user"] = new
                        changed = True
                    if message.get("deletedBy") == old:
                        message["deletedBy"] = new
                        changed = True
                    reply = message.get("replyTo")
                    if isinstance(reply, dict) and reply.get("user") == old:
                        reply["user"] = new
                        changed = True
                banned = room.get("banned")
                if isinstance(banned, list) and old in banned:
                    room["banned"] = [new if name == old else name for name in banned]
                    changed = True
                if changed:
                    touched.append(room_id)
        for room_id in touched:
            self.save(room_id)
        return touched

    def delete_room(self, room_id):
        with self.lock:
            timer = self._timers.pop(room_id, None)
            if timer:
                timer.cancel()
            room = self.rooms.pop(room_id, None)
        if room is None:
            return False
        try:
            self.file_path(room_id).unlink()
        except OSError:
            pass
        return True

    def add_message(self, room_id, message):
        with self.lock:
            room = self.rooms.get(room_id)
            if room is None:
                return None
            room["messages"].append(message)
            extra = len(room["messages"]) - self.max_messages
            if extra > 0:
                dropped = room["messages"][:extra]
                del room["messages"][:extra]
                if self.on_trim:
                    for old in dropped:
                        self.on_trim(old)
        self.schedule_save(room_id)
        return message

    def find_message(self, room_id, message_id):
        with self.lock:
            room = self.rooms.get(room_id)
            if room is None:
                return None
            for message in reversed(room["messages"]):  # edits target recent ones
                if message.get("id") == message_id:
                    return message
        return None

    def messages_before(self, room_id, before_ts, limit=100):
        """The page of history just older than before_ts, oldest first."""
        with self.lock:
            room = self.rooms.get(room_id)
            if room is None:
                return [], False
            older = [m for m in room["messages"] if m.get("ts", 0) < before_ts]
            page = older[-limit:]
            return list(page), len(older) > len(page)

    def search(self, room_ids, needle, limit=60):
        """Plain substring match. A few thousand dicts scan in microseconds."""
        needle = needle.casefold()
        hits = []
        with self.lock:
            for room_id in room_ids:
                room = self.rooms.get(room_id)
                if room is None:
                    continue
                for message in reversed(room["messages"]):
                    if message.get("type") != "chat" or message.get("deleted"):
                        continue
                    text = message.get("text") or ""
                    if needle in text.casefold():
                        hits.append(
                            {
                                "roomId": room_id,
                                "roomName": room["name"],
                                "messageId": message["id"],
                                "user": message.get("user", ""),
                                "ts": message.get("ts", 0),
                                "text": text[:220],
                            }
                        )
                        if len(hits) >= limit:
                            hits.sort(key=lambda h: h["ts"], reverse=True)
                            return hits, True
        hits.sort(key=lambda h: h["ts"], reverse=True)
        return hits, False

    def schedule_save(self, room_id):
        """Coalesce a burst of messages into one write."""
        with self.lock:
            if room_id in self._timers:
                return
            timer = threading.Timer(SAVE_DEBOUNCE_SECONDS, self._save_from_timer, args=(room_id,))
            timer.daemon = True
            self._timers[room_id] = timer
            timer.start()

    def _save_from_timer(self, room_id):
        with self.lock:
            self._timers.pop(room_id, None)
        try:
            self.save(room_id)
        except OSError as err:
            print(f"[store] save failed for {room_id}: {err}")

    def save(self, room_id):
        with self.lock:
            room = self.rooms.get(room_id)
            if room is None:
                return
            payload = json.dumps(room, indent=2, ensure_ascii=False)
        target = self.file_path(room_id)
        tmp = target.with_suffix(".json.tmp")
        tmp.write_text(payload, encoding="utf-8")
        os.replace(tmp, target)  # atomic on Windows too

    def flush(self):
        with self.lock:
            for timer in self._timers.values():
                timer.cancel()
            self._timers.clear()
            room_ids = list(self.rooms)
        for room_id in room_ids:
            try:
                self.save(room_id)
            except OSError as err:
                print(f"[store] flush failed for {room_id}: {err}")
