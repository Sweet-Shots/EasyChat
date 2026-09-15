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
    def __init__(self, directory, invite_code="", host_names=()):
        self.dir = directory
        self.path = directory / "users.json"
        self.secret_path = directory / "secret.key"
        self.invite_code = invite_code
        self.host_names = {name.strip().lower() for name in host_names if name.strip()}
        self.users = {}  # lowercase username -> record
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
                for record in data.get("users", []):
                    key = record["username"].lower()
                    if isinstance(record.get("password"), str):  # host typed one in
                        record["password"] = hash_password(record["password"])
                    self.users[key] = record
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
                "username": name,
                "password": hash_password(password),
                "createdAt": now_ms(),
                "lastSeen": now_ms(),
                "host": first or name.lower() in self.host_names,
            }
            self.users[name.lower()] = record
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
        return bool(record and record.get("host"))

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
        """username|expiry|signature - so a reload does not ask again."""
        expiry = now_ms() + TOKEN_DAYS * 86400000
        body = f"{username}|{expiry}"
        signature = hmac.new(self.secret, body.encode("utf-8"), "sha256").hexdigest()
        raw = f"{body}|{signature}".encode("utf-8")
        return base64.urlsafe_b64encode(raw).decode("ascii")

    def check_token(self, token):
        try:
            raw = base64.urlsafe_b64decode(str(token or "").encode("ascii")).decode("utf-8")
            username, expiry, signature = raw.rsplit("|", 2)
        except (ValueError, TypeError, UnicodeDecodeError, base64.binascii.Error):
            return None
        expected = hmac.new(self.secret, f"{username}|{expiry}".encode("utf-8"), "sha256").hexdigest()
        if not hmac.compare_digest(signature, expected):
            return None
        try:
            if int(expiry) < now_ms():
                return None
        except ValueError:
            return None
        record = self.get(username)
        if not record:
            return None
        self.touch(record["username"])
        return record
