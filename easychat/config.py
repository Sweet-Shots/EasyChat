"""Settings, read from a .env file sitting next to the project."""

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_env(path=None):
    """Read KEY=VALUE lines into os.environ. Existing variables win."""
    env_path = Path(path) if path else ROOT / ".env"
    if not env_path.is_file():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def _int(name, fallback):
    try:
        return int(os.environ.get(name, "").strip() or fallback)
    except ValueError:
        return fallback


class Settings:
    def __init__(self):
        self.port = _int("PORT", 3000)
        self.room_password = (
            os.environ.get("INVITE_CODE", "").strip() or os.environ.get("ROOM_PASSWORD", "").strip()
        )
        self.tenor_api_key = os.environ.get("TENOR_API_KEY", "").strip()
        self.max_messages = _int("MAX_MESSAGES_PER_ROOM", 2000)
        chats_dir = os.environ.get("CHATS_DIR", "").strip()
        self.chats_dir = Path(chats_dir).expanduser().resolve() if chats_dir else ROOT / "EasyChat Chats"
        self.public_dir = ROOT / "public"
        # a subfolder, so the room loader's *.json scan never sees these
        self.accounts_dir = self.chats_dir / "accounts"
        self.host_names = [name for name in os.environ.get("HOST_USERS", "").split(",") if name.strip()]

    @property
    def requires_password(self):
        """The invite code, now only asked for when registering."""
        return bool(self.room_password)

    @property
    def gifs_enabled(self):
        return bool(self.tenor_api_key)
