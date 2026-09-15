"""Who is connected, who is in which room, and what gets broadcast."""

import hmac
import json
import re
import threading
import time
import uuid

from . import store as store_mod

MAX_TEXT_LENGTH = 4000
HISTORY_LIMIT = 300
TYPING_TTL_SECONDS = 6
RATE_LIMIT_MESSAGES = 10
RATE_LIMIT_WINDOW = 10
LEAVE_GRACE_SECONDS = 8
ROOM_PASSWORD_MIN = 4
ROOM_PASSWORD_MAX = 64
UNLOCK_ATTEMPT_LIMIT = 6
UNLOCK_ATTEMPT_WINDOW = 60

USERNAME_RE = re.compile(r"^[\w .\-]{2,24}$", re.UNICODE)
TENOR_URL_RE = re.compile(r"^https://media\d*\.tenor\.com/")


class Client:
    def __init__(self, websocket):
        self.id = uuid.uuid4().hex
        self.ws = websocket
        self.username = None
        self.room_id = None
        self.joined_at = 0
        self.stamps = []
        self.unlocked = set()  # rooms this connection has given the password for
        self.unlock_fails = []

    def send(self, payload):
        self.ws.send_text(json.dumps(payload))


class Hub:
    def __init__(self, store, settings):
        self.store = store
        self.settings = settings
        self.lock = threading.RLock()
        self.clients = {}
        self.typing = {}  # room_id -> {client_id: (username, expires_at)}
        self.pending_leaves = {}  # (room_id, username) -> Timer

    # ---------- plumbing ----------

    def add_client(self, websocket):
        client = Client(websocket)
        with self.lock:
            self.clients[client.id] = client
        client.send(
            {
                "type": "hello",
                "requiresPassword": self.settings.requires_password,
                "gifsEnabled": self.settings.gifs_enabled,
            }
        )
        return client

    def remove_client(self, client):
        with self.lock:
            self.clients.pop(client.id, None)
        self._clear_typing_everywhere(client)
        if client.username and client.room_id:
            self._announce_leave(client.room_id, client.username)
            self.push_presence(client.room_id)

    def _members_snapshot(self, room_id):
        with self.lock:
            seen = {}
            for client in self.clients.values():
                if client.room_id == room_id and client.username and client.username not in seen:
                    seen[client.username] = {"username": client.username, "since": client.joined_at}
        return sorted(seen.values(), key=lambda member: member["username"].lower())

    def _targets(self, room_id, exclude=None):
        with self.lock:
            return [
                client
                for client in self.clients.values()
                if client.room_id == room_id and client is not exclude
            ]

    def _everyone(self):
        with self.lock:
            return [client for client in self.clients.values() if client.username]

    def broadcast(self, room_id, payload, exclude=None):
        for client in self._targets(room_id, exclude):
            client.send(payload)

    def broadcast_all(self, payload):
        for client in self._everyone():
            client.send(payload)

    def rooms_with_presence(self):
        counts = {}
        with self.lock:
            for client in self.clients.values():
                if client.room_id and client.username:
                    counts[client.room_id] = counts.get(client.room_id, 0) + 1
        rooms = self.store.list_rooms()
        for room in rooms:
            room["online"] = counts.get(room["id"], 0)
        return rooms

    def push_presence(self, room_id):
        self.broadcast(room_id, {"type": "presence", "roomId": room_id, "members": self._members_snapshot(room_id)})
        self.broadcast_all({"type": "rooms", "rooms": self.rooms_with_presence()})

    # ---------- system notices ----------

    def system_message(self, room_id, text):
        message = {"id": uuid.uuid4().hex, "type": "system", "text": text, "ts": store_mod.now_ms()}
        self.store.add_message(room_id, message)
        self.broadcast(room_id, {"type": "message", "roomId": room_id, "message": message})

    def _announce_leave(self, room_id, username):
        """Held briefly: a dropped connection that comes right back never left."""
        key = (room_id, username)
        with self.lock:
            existing = self.pending_leaves.pop(key, None)
            if existing:
                existing.cancel()
            timer = threading.Timer(LEAVE_GRACE_SECONDS, self._fire_leave, args=(key,))
            timer.daemon = True
            self.pending_leaves[key] = timer
            timer.start()

    def _fire_leave(self, key):
        with self.lock:
            self.pending_leaves.pop(key, None)
        room_id, username = key
        self.system_message(room_id, f"{username} left the room.")

    def _announce_join(self, room_id, username):
        key = (room_id, username)
        with self.lock:
            pending = self.pending_leaves.pop(key, None)
        if pending:
            pending.cancel()
            return  # they never really left
        self.system_message(room_id, f"{username} joined the room.")

    # ---------- typing ----------

    def set_typing(self, client, is_typing):
        if not client.room_id:
            return
        with self.lock:
            room_typers = self.typing.setdefault(client.room_id, {})
            if is_typing:
                room_typers[client.id] = (client.username, time.time() + TYPING_TTL_SECONDS)
            else:
                room_typers.pop(client.id, None)
        self.push_typing(client.room_id)

    def _clear_typing_everywhere(self, client):
        touched = []
        with self.lock:
            for room_id, room_typers in self.typing.items():
                if room_typers.pop(client.id, None):
                    touched.append(room_id)
        for room_id in touched:
            self.push_typing(room_id)

    def push_typing(self, room_id):
        now = time.time()
        users = []
        with self.lock:
            room_typers = self.typing.get(room_id, {})
            for client_id, (username, expires) in list(room_typers.items()):
                if expires <= now:
                    room_typers.pop(client_id, None)
                elif username not in users:
                    users.append(username)
        self.broadcast(room_id, {"type": "typing", "roomId": room_id, "users": users})

    def sweep_typing(self):
        with self.lock:
            room_ids = list(self.typing)
        for room_id in room_ids:
            self.push_typing(room_id)

    # ---------- message handling ----------

    def handle(self, client, raw):
        try:
            data = json.loads(raw)
        except (ValueError, TypeError):
            return
        if not isinstance(data, dict) or not isinstance(data.get("type"), str):
            return

        kind = data["type"]
        if kind == "join":
            return self._handle_join(client, data)
        if not client.username:
            return client.send({"type": "error", "code": "not-joined", "message": "Join first."})
        if kind == "message":
            return self._handle_message(client, data)
        if kind == "typing":
            return self.set_typing(client, bool(data.get("state")))
        if kind == "switch":
            return self.enter_room(client, str(data.get("roomId") or ""), data.get("password"))
        if kind == "create-room":
            return self._handle_create_room(client, data)

    def _password_ok(self, candidate):
        if not self.settings.requires_password:
            return True
        return hmac.compare_digest(str(candidate or ""), self.settings.room_password)

    def _handle_join(self, client, data):
        if client.username:
            return
        username = re.sub(r"\s+", " ", str(data.get("username") or "")).strip()
        if not USERNAME_RE.match(username):
            return client.send(
                {
                    "type": "error",
                    "code": "bad-username",
                    "message": "2 to 24 characters, letters/numbers/spaces and . _ - only.",
                }
            )
        if not self._password_ok(data.get("password")):
            return client.send({"type": "error", "code": "bad-password", "message": "That passcode is not right."})

        client.username = username
        client.joined_at = store_mod.now_ms()
        rooms = self.rooms_with_presence()
        client.send(
            {
                "type": "welcome",
                "username": username,
                "rooms": rooms,
                "gifsEnabled": self.settings.gifs_enabled,
            }
        )

        wanted = data.get("roomId")
        keys = data.get("roomKeys") if isinstance(data.get("roomKeys"), dict) else {}
        if any(room["id"] == wanted for room in rooms):
            if self.enter_room(client, wanted, keys.get(wanted), quiet=True):
                return
        # otherwise the first room they can walk straight into
        for room in rooms:
            if not room["locked"] or room["id"] in keys:
                if self.enter_room(client, room["id"], keys.get(room["id"]), quiet=True):
                    return
        client.send({"type": "no-room"})

    def enter_room(self, client, room_id, password=None, quiet=False):
        """Returns True once the client is inside the room."""
        room = self.store.get_room(room_id)
        if room is None:
            client.send({"type": "error", "code": "no-room", "message": "That room no longer exists."})
            return False
        previous = client.room_id
        if previous == room_id:
            return True

        if store_mod.is_locked(room) and room_id not in client.unlocked:
            if not password:
                if not quiet:
                    client.send(
                        {
                            "type": "error",
                            "code": "room-locked",
                            "roomId": room_id,
                            "roomName": room["name"],
                            "message": f'"{room["name"]}" needs a password.',
                        }
                    )
                return False
            if self._unlock_throttled(client):
                client.send(
                    {
                        "type": "error",
                        "code": "unlock-throttled",
                        "roomId": room_id,
                        "roomName": room["name"],
                        "message": "Too many wrong passwords. Wait a minute and try again.",
                    }
                )
                return False
            if not store_mod.verify_password(room.get("password"), password):
                client.unlock_fails.append(time.time())
                client.send(
                    {
                        "type": "error",
                        "code": "bad-room-password",
                        "roomId": room_id,
                        "roomName": room["name"],
                        "message": "That room password is not right.",
                    }
                )
                return False
            client.unlocked.add(room_id)

        if previous:
            self._clear_typing_everywhere(client)
            self._announce_leave(previous, client.username)
        client.room_id = room_id
        client.send(
            {
                "type": "room",
                "room": {
                    "id": room["id"],
                    "name": room["name"],
                    "topic": room.get("topic", ""),
                    "locked": store_mod.is_locked(room),
                },
                "messages": self.store.recent_messages(room_id, HISTORY_LIMIT),
                "members": self._members_snapshot(room_id),
            }
        )
        self._announce_join(room_id, client.username)
        if previous:
            self.push_presence(previous)
        self.push_presence(room_id)
        return True

    def _unlock_throttled(self, client):
        now = time.time()
        client.unlock_fails = [stamp for stamp in client.unlock_fails if now - stamp < UNLOCK_ATTEMPT_WINDOW]
        return len(client.unlock_fails) >= UNLOCK_ATTEMPT_LIMIT

    def _rate_limited(self, client):
        now = time.time()
        client.stamps = [stamp for stamp in client.stamps if now - stamp < RATE_LIMIT_WINDOW]
        if len(client.stamps) >= RATE_LIMIT_MESSAGES:
            return True
        client.stamps.append(now)
        return False

    def _handle_message(self, client, data):
        if not client.room_id:
            return
        if self._rate_limited(client):
            return client.send({"type": "error", "code": "rate-limit", "message": "Slow down a moment."})

        text = str(data.get("text") or "")[:MAX_TEXT_LENGTH].strip()
        attachment = None
        gif = data.get("gif")
        if isinstance(gif, dict) and isinstance(gif.get("url"), str) and TENOR_URL_RE.match(gif["url"]):
            preview = gif.get("preview")
            try:
                width = int(gif.get("width") or 320)
                height = int(gif.get("height") or 240)
            except (TypeError, ValueError):
                width, height = 320, 240
            attachment = {
                "kind": "gif",
                "url": gif["url"],
                "preview": preview if isinstance(preview, str) else gif["url"],
                "width": width,
                "height": height,
                "title": str(gif.get("title") or "GIF")[:120],
            }
        if not text and not attachment:
            return

        message = {
            "id": uuid.uuid4().hex,
            "type": "chat",
            "user": client.username,
            "text": text,
            "attachment": attachment,
            "ts": store_mod.now_ms(),
        }
        self.store.add_message(client.room_id, message)
        self.set_typing(client, False)
        self.broadcast(client.room_id, {"type": "message", "roomId": client.room_id, "message": message})
        self.broadcast_all({"type": "rooms", "rooms": self.rooms_with_presence()})

    def _handle_create_room(self, client, data):
        name = str(data.get("name") or "").strip()[:40]
        password = str(data.get("password") or "")[:ROOM_PASSWORD_MAX]
        if len(name) < 2:
            return client.send(
                {"type": "error", "code": "bad-room", "message": "Room names need at least 2 characters."}
            )
        if len(password.strip()) < ROOM_PASSWORD_MIN:
            return client.send(
                {
                    "type": "error",
                    "code": "weak-room-password",
                    "message": f"Give the room a password of at least {ROOM_PASSWORD_MIN} characters.",
                }
            )
        if self.store.has_room_named(name):
            return client.send({"type": "error", "code": "dup-room", "message": f'"{name}" already exists.'})
        room = self.store.create_room(name, str(data.get("topic") or ""), password.strip())
        client.unlocked.add(room["id"])  # whoever made it is already inside
        self.broadcast_all({"type": "rooms", "rooms": self.rooms_with_presence()})
        self.enter_room(client, room["id"])

    # ---------- heartbeat ----------

    def heartbeat(self):
        with self.lock:
            clients = list(self.clients.values())
        for client in clients:
            if not client.ws.alive:
                client.ws.terminate()
                continue
            client.ws.alive = False
            client.ws.send_ping()
