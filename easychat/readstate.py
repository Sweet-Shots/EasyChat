"""How far each person has read in each room.

Kept in its own file rather than in the room JSON, so the message files stay
clean enough to read in Notepad.
"""

import json
import os
import threading

SAVE_DEBOUNCE_SECONDS = 2.0


class ReadState:
    def __init__(self, directory):
        self.path = directory / "read-state.json"
        self.marks = {}  # lowercase username -> {room_id: last read ts}
        self.lock = threading.RLock()
        self._timer = None

    def init(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.is_file():
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    self.marks = {
                        user: {room: int(ts) for room, ts in rooms.items()}
                        for user, rooms in data.items()
                        if isinstance(rooms, dict)
                    }
            except (ValueError, TypeError, OSError) as err:
                print(f"[read-state] starting fresh: {err}")
        return self

    def mark(self, username, room_id, ts):
        key = str(username).lower()
        with self.lock:
            rooms = self.marks.setdefault(key, {})
            if ts > rooms.get(room_id, 0):
                rooms[room_id] = int(ts)
                self._schedule()

    def last_read(self, username, room_id):
        with self.lock:
            return self.marks.get(str(username).lower(), {}).get(room_id, 0)

    def unread_counts(self, username, store):
        """{room_id: how many chat messages arrived since they last looked}."""
        counts = {}
        with self.lock:
            seen = dict(self.marks.get(str(username).lower(), {}))
        for room in store.list_rooms():
            room_id = room["id"]
            since = seen.get(room_id, 0)
            messages = store.recent_messages(room_id, 300)
            counts[room_id] = sum(
                1
                for message in messages
                if message.get("type") == "chat"
                and message.get("ts", 0) > since
                and message.get("user") != username
            )
        return counts

    def rename_user(self, old, new):
        with self.lock:
            marks = self.marks.pop(str(old).lower(), None)
            if marks is not None:
                self.marks[str(new).lower()] = marks
                self._schedule()

    def forget_user(self, username):
        with self.lock:
            if self.marks.pop(str(username).lower(), None) is not None:
                self._schedule()

    def _schedule(self):
        if self._timer:
            return
        self._timer = threading.Timer(SAVE_DEBOUNCE_SECONDS, self._save_now)
        self._timer.daemon = True
        self._timer.start()

    def _save_now(self):
        self._timer = None
        try:
            self.save()
        except OSError as err:
            print(f"[read-state] save failed: {err}")

    def save(self):
        with self.lock:
            payload = json.dumps(self.marks, indent=1, sort_keys=True)
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(payload, encoding="utf-8")
        os.replace(tmp, self.path)
