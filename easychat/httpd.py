"""The HTTP side: static files, the little JSON API, and the /ws upgrade."""

import json
import mimetypes
import posixpath
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import gifs, store, wsproto
from . import uploads as uploads_mod

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("font/woff2", ".woff2")


class ChatServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler, settings, store, hub, accounts, uploads):
        super().__init__(address, handler)
        self.settings = settings
        self.store = store
        self.hub = hub
        self.accounts = accounts
        self.uploads = uploads


class ChatHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "EasyChat"
    sys_version = ""
    timeout = 60

    # ---------- helpers ----------

    def log_message(self, fmt, *args):
        pass  # the console stays readable; real errors still print tracebacks

    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    CSP = (
        "default-src 'self'; "
        "img-src 'self' data: https://*.tenor.com; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src https://fonts.gstatic.com; "
        "script-src 'self'; "
        "connect-src 'self' ws: wss:; "
        "frame-ancestors 'none'; "
        "base-uri 'none'; "
        "form-action 'none'"
    )

    def send_secure_headers(self):
        """The public link should not be framable, and should leak nothing."""
        self.send_header("Content-Security-Policy", self.CSP)
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")

    def send_bytes(self, body, content_type, etag=None):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_secure_headers()
        if etag:
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    # ---------- routing ----------

    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if path == "/ws":
            return self.handle_websocket()
        if path == "/api/config":
            settings = self.server.settings
            return self.send_json(
                {
                    "requiresInvite": settings.requires_password,
                    "gifsEnabled": settings.gifs_enabled,
                    "anyAccounts": self.server.accounts.count() > 0,
                }
            )
        if path.startswith("/api/gifs/"):
            return self.handle_gifs(path.rsplit("/", 1)[-1], query)
        if path.startswith("/api/"):
            return self.send_json({"error": "Unknown endpoint."}, 404)
        if path.startswith("/files/"):
            return self.serve_upload(path[len("/files/") :])
        return self.serve_static(path)

    def do_POST(self):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path != "/api/upload":
            return self.send_json({"error": "Unknown endpoint."}, 404)

        uploads = self.server.uploads
        query = urllib.parse.parse_qs(parsed.query)
        ticket = (query.get("ticket") or [""])[0]
        seat = uploads.check_ticket(ticket, store.now_ms())
        if not seat or not uploads.spend_ticket(ticket):
            self.close_connection = True
            return self.send_json({"error": "Upload permission expired. Try again."}, 403)
        _username, room_id = seat

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return self.send_json({"error": "Nothing to upload."}, 400)
        if length > uploads.max_file_bytes:
            # read nothing: refuse before pulling megabytes off the wire
            self.close_connection = True
            return self.send_json(
                {"error": f"Files have to be under {uploads.max_file_bytes // (1024 * 1024)} MB."}, 413
            )

        data = self.rfile.read(length)
        try:
            attachment = uploads.store(room_id, data, self.headers.get("X-File-Name", ""))
        except ValueError as err:
            return self.send_json({"error": str(err)}, 507)
        except OSError as err:
            print(f"[uploads] {err}")
            return self.send_json({"error": "The host could not save that file."}, 500)

        return self.send_json(
            {"attachment": attachment, "signature": uploads.sign_attachment(attachment)}
        )

    def serve_upload(self, relative):
        target = self.server.uploads.resolve(relative)
        if target is None:
            return self.send_json({"error": "Not found."}, 404)
        try:
            body = target.read_bytes()
        except OSError:
            return self.send_json({"error": "Not found."}, 404)

        mime, _ext, is_image = uploads_mod.sniff(body[:32])
        self.send_response(200)
        self.send_header("Content-Type", mime if is_image else "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        # never let an upload be sniffed into script on this origin
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'none'; img-src 'self'")
        if not is_image:
            self.send_header("Content-Disposition", "attachment")
        self.send_header("Cache-Control", "private, max-age=86400")
        self.end_headers()
        self.wfile.write(body)

    def handle_gifs(self, mode, query):
        settings = self.server.settings
        if not settings.gifs_enabled:
            return self.send_json({"error": "GIF search is not configured on this host."}, 503)
        pos = (query.get("pos") or [""])[0][:200]
        try:
            if mode == "search":
                term = (query.get("q") or [""])[0].strip()[:100]
                if not term:
                    return self.send_json({"results": [], "next": ""})
                return self.send_json(gifs.search(settings.tenor_api_key, term, pos))
            if mode == "trending":
                return self.send_json(gifs.featured(settings.tenor_api_key, pos))
        except gifs.GifError as err:
            print(f"[gifs] {err}")
            return self.send_json({"error": "Could not reach Tenor. Try again in a moment."}, 502)
        return self.send_json({"error": "Unknown GIF endpoint."}, 404)

    def serve_static(self, path):
        public_dir = self.server.settings.public_dir
        relative = posixpath.normpath(urllib.parse.unquote(path)).lstrip("/")
        target = (public_dir / relative).resolve() if relative else (public_dir / "index.html")

        # any unknown route (and anything trying to climb out) lands on the app
        try:
            inside = target.is_relative_to(public_dir.resolve())
        except AttributeError:  # Python < 3.9
            inside = str(target).startswith(str(public_dir.resolve()))
        if not inside or not target.is_file():
            target = public_dir / "index.html"

        try:
            body = target.read_bytes()
        except OSError:
            return self.send_json({"error": "Not found."}, 404)

        stat = target.stat()
        etag = f'"{int(stat.st_mtime)}-{stat.st_size}"'
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in ("application/json", "text/javascript"):
            content_type += "; charset=utf-8"
        self.send_bytes(body, content_type, etag)

    # ---------- websocket ----------

    def handle_websocket(self):
        self.close_connection = True
        if not wsproto.is_upgrade(self.headers):
            return self.send_json({"error": "Expected a WebSocket upgrade."}, 400)

        accept = wsproto.accept_key(self.headers["Sec-WebSocket-Key"].strip())
        self.wfile.write(
            (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
            ).encode("ascii")
        )
        self.wfile.flush()

        self.connection.settimeout(None)  # the heartbeat decides when a client is gone
        websocket = wsproto.WebSocket(self.connection, self.rfile, self.wfile)
        hub = self.server.hub
        client = hub.add_client(websocket)
        try:
            for raw in websocket.messages():
                hub.handle(client, raw)
        finally:
            hub.remove_client(client)
            websocket.open = False
