"""Rooms on disk - one JSON file per room inside the chats folder.

Nothing here is clever on purpose: a room is a dict, a file is that dict
dumped with indent=2, so the host can open one in Notepad and read it.
"""

import json
import os
import re
import secrets
import threading
import time
import unicodedata

SAVE_DEBOUNCE_SECONDS = 0.4


def slugify(name):
    text = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()[:32]
    return text or "room"


def now_ms():
    return int(time.time() * 1000)


class ChatStore:
    def __init__(self, directory, max_messages=2000):
        self.dir = directory
        self.max_messages = max_messages
        self.rooms = {}
        self.lock = threading.RLock()
        self._timers = {}

    # ---------- loading ----------

    def init(self):
        self.dir.mkdir(parents=True, exist_ok=True)
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
            except Exception as err:  # a hand-edited file should not stop the server
                print(f"[store] skipping {path.name}: {err}")
        if not self.rooms:
            self.create_room("General", "The default room. Say hi.")
            self.create_room("Random", "Off-topic, memes, GIF wars.")
        return self

    def file_path(self, room_id):
        return self.dir / f"{room_id}.json"

    # ---------- reading ----------

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

    def create_room(self, name, topic=""):
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
            self.rooms[room_id] = room
        self.save(room_id)
        return room

    def add_message(self, room_id, message):
        with self.lock:
            room = self.rooms.get(room_id)
            if room is None:
                return None
            room["messages"].append(message)
            extra = len(room["messages"]) - self.max_messages
            if extra > 0:
                del room["messages"][:extra]
        self.schedule_save(room_id)
        return message

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
