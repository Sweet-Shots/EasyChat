"""Accounts: a username, a password, and a token that keeps you signed in.

Everything lives in one JSON file so the host can see who exists, and every
password is a PBKDF2 hash - the file never holds the typed text.

This is what makes "who said this" mean something. Before it, anyone could
type any name; now a name belongs to whoever registered it.
"""

import base64
import hmac
import json
import os
import re
import secrets
import threading
import uuid

from .store import hash_password, now_ms, verify_password

USERNAME_RE = re.compile(r"^[\w .\-]{2,24}$", re.UNICODE)
MIN_PASSWORD_LENGTH = 6
MAX_PASSWORD_LENGTH = 128
TOKEN_DAYS = 30


class AccountError(Exception):
    """Something the person can fix, with a message worth showing them."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def clean_username(raw):
    name = re.sub(r"\s+", " ", str(raw or "")).strip()
    return name if USERNAME_RE.match(name) else None


class Accounts:
    def __init__(self, directory, invite_code="", host_names=(), owner_names=()):
        self.dir = directory
        self.path = directory / "users.json"
        self.secret_path = directory / "secret.key"
        self.invite_code = invite_code
        self.host_names = {name.strip().lower() for name in host_names if name.strip()}
        self.owner_names = {name.strip().lower() for name in owner_names if name.strip()}
        self.users = {}  # lowercase username -> record
        self.by_id = {}  # stable id -> record, so a rename keeps you signed in
        self.lock = threading.RLock()
        self.secret = b""

    # ---------- setup ----------

    def init(self):
        self.dir.mkdir(parents=True, exist_ok=True)
        if self.secret_path.is_file():
            self.secret = self.secret_path.read_bytes().strip()
        if not self.secret:
            self.secret = base64.urlsafe_b64encode(secrets.token_bytes(32))
            self.secret_path.write_bytes(self.secret)
            if os.name != "nt":
                self.secret_path.chmod(0o600)
        if self.path.is_file():
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
                changed = False
                for record in data.get("users", []):
                    key = record["username"].lower()
                    if isinstance(record.get("password"), str):  # host typed one in
                        record["password"] = hash_password(record["password"])
                        changed = True
                    if not record.get("id"):
                        record["id"] = uuid.uuid4().hex
                        changed = True
                    self.users[key] = record
                    self.by_id[record["id"]] = record
                if changed:
                    self.save()
            except (ValueError, KeyError, TypeError, OSError) as err:
                print(f"[accounts] could not read users.json: {err}")
        return self

    def save(self):
        with self.lock:
            payload = json.dumps(
                {"users": sorted(self.users.values(), key=lambda u: u["createdAt"])},
                indent=2,
                ensure_ascii=False,
            )
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(payload, encoding="utf-8")
        os.replace(tmp, self.path)

    # ---------- registering and signing in ----------

    def count(self):
        with self.lock:
            return len(self.users)

    def register(self, username, password, invite):
        name = clean_username(username)
        if not name:
            raise AccountError(
                "bad-username", "2 to 24 characters, letters/numbers/spaces and . _ - only."
            )
        password = str(password or "")
        if len(password) < MIN_PASSWORD_LENGTH:
            raise AccountError(
                "weak-password", f"Passwords need at least {MIN_PASSWORD_LENGTH} characters."
            )
        if len(password) > MAX_PASSWORD_LENGTH:
            raise AccountError("weak-password", "That password is too long.")
        if self.invite_code and not hmac.compare_digest(str(invite or ""), self.invite_code):
            raise AccountError("bad-invite", "That invite code is not right.")

        with self.lock:
            if name.lower() in self.users:
                raise AccountError("name-taken", f'"{name}" is already registered.')
            first = not self.users
            record = {
                "id": uuid.uuid4().hex,
                "username": name,
                "password": hash_password(password),
                "createdAt": now_ms(),
                "lastSeen": now_ms(),
                # the very first account runs the place
                "owner": first or name.lower() in self.owner_names,
                "host": first or name.lower() in self.host_names or name.lower() in self.owner_names,
            }
            self.users[name.lower()] = record
            self.by_id[record["id"]] = record
        self.save()
        return record

    def sign_in(self, username, password):
        name = str(username or "").strip()
        with self.lock:
            record = self.users.get(name.lower())
        # the same message either way, so nobody can probe for who exists
        if not record or not verify_password(record.get("password"), password):
            raise AccountError("bad-sign-in", "Wrong username or password.")
        self.touch(record["username"])
        return record

    def touch(self, username):
        with self.lock:
            record = self.users.get(str(username).lower())
            if record:
                record["lastSeen"] = now_ms()

    def get(self, username):
        with self.lock:
            return self.users.get(str(username or "").lower())

    def is_host(self, username):
        record = self.get(username)
        return bool(record and (record.get("host") or record.get("owner")))

    def is_owner(self, username):
        record = self.get(username)
        return bool(record and record.get("owner"))

    def owners(self):
        with self.lock:
            return [r["username"] for r in self.users.values() if r.get("owner")]

    # ---------- what an owner may do to an account ----------

    def summary(self, online_names=()):
        """Every account, with no password material anywhere in it."""
        online = {name.lower() for name in online_names}
        with self.lock:
            records = sorted(self.users.values(), key=lambda r: r["createdAt"])
            return [
                {
                    "username": r["username"],
                    "owner": bool(r.get("owner")),
                    "host": bool(r.get("host")),
                    "createdAt": r.get("createdAt", 0),
                    "lastSeen": r.get("lastSeen", 0),
                    "online": r["username"].lower() in online,
                    "color": r.get("color", ""),
                    "avatar": r.get("avatar", ""),
                }
                for r in records
            ]

    def set_role(self, username, *, host=None, owner=None):
        record = self.get(username)
        if not record:
            raise AccountError("no-account", "There is no such account.")
        if owner is False and record.get("owner") and len(self.owners()) <= 1:
            raise AccountError("last-owner", "There has to be at least one owner.")
        with self.lock:
            if owner is not None:
                record["owner"] = bool(owner)
                if owner:
                    record["host"] = True
            if host is not None and not record.get("owner"):
                record["host"] = bool(host)
        self.save()
        return record

    def set_profile(self, username, *, color=None, avatar=None):
        """What someone looks like to everyone else."""
        record = self.get(username)
        if not record:
            raise AccountError("no-account", "There is no such account.")
        with self.lock:
            if color is not None:
                colour = str(color).strip()
                if colour and not re.fullmatch(r"#[0-9a-fA-F]{6}", colour):
                    raise AccountError("bad-color", "That is not a colour I understand.")
                if colour:
                    record["color"] = colour
                else:
                    record.pop("color", None)
            if avatar is not None:
                if avatar:
                    record["avatar"] = str(avatar)[:300]
                else:
                    record.pop("avatar", None)
        self.save()
        return record

    def profiles(self):
        """username -> how to show them: colour, picture, and role.

        Only people who have set something or hold a role appear here - a role
        badge is meant to be seen, but a plain member's account is nobody's
        business, so the map is not a roster of everyone registered.
        """
        with self.lock:
            return {
                r["username"]: {
                    "color": r.get("color", ""),
                    "avatar": r.get("avatar", ""),
                    "owner": bool(r.get("owner")),
                    "host": bool(r.get("host")) and not r.get("owner"),
                }
                for r in self.users.values()
                if r.get("color") or r.get("avatar") or r.get("host") or r.get("owner")
            }

    def set_password(self, username, new_password):
        record = self.get(username)
        if not record:
            raise AccountError("no-account", "There is no such account.")
        if len(str(new_password or "")) < MIN_PASSWORD_LENGTH:
            raise AccountError(
                "weak-password", f"Passwords need at least {MIN_PASSWORD_LENGTH} characters."
            )
        with self.lock:
            record["password"] = hash_password(new_password)
        self.save()
        return record

    def rename(self, username, new_name):
        """Returns (old, new). The caller has to move the history across."""
        record = self.get(username)
        if not record:
            raise AccountError("no-account", "There is no such account.")
        clean = clean_username(new_name)
        if not clean:
            raise AccountError(
                "bad-username", "2 to 24 characters, letters/numbers/spaces and . _ - only."
            )
        with self.lock:
            if clean.lower() != username.lower() and clean.lower() in self.users:
                raise AccountError("name-taken", f'"{clean}" is already registered.')
            old = record["username"]
            self.users.pop(old.lower(), None)
            record["username"] = clean
            self.users[clean.lower()] = record
            self.by_id[record["id"]] = record
        self.save()
        return old, clean

    def delete(self, username):
        record = self.get(username)
        if not record:
            raise AccountError("no-account", "There is no such account.")
        if record.get("owner") and len(self.owners()) <= 1:
            raise AccountError("last-owner", "You cannot delete the last owner.")
        with self.lock:
            self.users.pop(record["username"].lower(), None)
            self.by_id.pop(record.get("id", ""), None)
        self.save()
        return record["username"]

    def change_password(self, username, current, new_password):
        record = self.get(username)
        if not record or not verify_password(record.get("password"), current):
            raise AccountError("bad-sign-in", "Your current password is not right.")
        if len(str(new_password or "")) < MIN_PASSWORD_LENGTH:
            raise AccountError(
                "weak-password", f"Passwords need at least {MIN_PASSWORD_LENGTH} characters."
            )
        with self.lock:
            record["password"] = hash_password(new_password)
        self.save()
        return record

    # ---------- staying signed in ----------

    def issue_token(self, username):
        """id|expiry|signature - keyed by account id, so renaming keeps you in."""
        record = self.get(username)
        account_id = record["id"] if record else str(username)
        expiry = now_ms() + TOKEN_DAYS * 86400000
        body = f"{account_id}|{expiry}"
        signature = hmac.new(self.secret, body.encode("utf-8"), "sha256").hexdigest()
        raw = f"{body}|{signature}".encode("utf-8")
        return base64.urlsafe_b64encode(raw).decode("ascii")

    def check_token(self, token):
        try:
            raw = base64.urlsafe_b64decode(str(token or "").encode("ascii")).decode("utf-8")
            account_id, expiry, signature = raw.rsplit("|", 2)
        except (ValueError, TypeError, UnicodeDecodeError, base64.binascii.Error):
            return None
        expected = hmac.new(self.secret, f"{account_id}|{expiry}".encode("utf-8"), "sha256").hexdigest()
        if not hmac.compare_digest(signature, expected):
            return None
        try:
            if int(expiry) < now_ms():
                return None
        except ValueError:
            return None
        with self.lock:
            record = self.by_id.get(account_id)
        if not record:
            return None
        self.touch(record["username"])
        return record
