"""A small RFC 6455 WebSocket server implementation.

Only what a chat room needs: the handshake, text frames, fragmentation,
ping/pong and close. No compression extensions are negotiated, so frames
arrive as plain payloads.
"""

import base64
import hashlib
import socket
import struct
import threading

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

OP_CONTINUATION = 0x0
OP_TEXT = 0x1
OP_BINARY = 0x2
OP_CLOSE = 0x8
OP_PING = 0x9
OP_PONG = 0xA

MAX_PAYLOAD = 64 * 1024


class ProtocolError(Exception):
    def __init__(self, code, reason):
        super().__init__(reason)
        self.code = code
        self.reason = reason


def accept_key(client_key):
    digest = hashlib.sha1((client_key + GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


def is_upgrade(headers):
    upgrade = (headers.get("Upgrade") or "").lower()
    connection = (headers.get("Connection") or "").lower()
    return upgrade == "websocket" and "upgrade" in connection and bool(headers.get("Sec-WebSocket-Key"))


def encode_frame(payload, opcode=OP_TEXT):
    """Server frames are never masked."""
    length = len(payload)
    header = bytearray()
    header.append(0x80 | opcode)  # FIN + opcode
    if length < 126:
        header.append(length)
    elif length < 65536:
        header.append(126)
        header.extend(struct.pack("!H", length))
    else:
        header.append(127)
        header.extend(struct.pack("!Q", length))
    return bytes(header) + payload


class WebSocket:
    """One client connection. Sends are locked so any thread may broadcast."""

    def __init__(self, sock, rfile, wfile):
        self.sock = sock
        self.rfile = rfile
        self.wfile = wfile
        self.send_lock = threading.Lock()
        self.open = True
        self.alive = True  # flipped by the heartbeat, set by any pong

    # ---------- sending ----------

    def _write(self, data):
        if not self.open:
            return False
        with self.send_lock:
            try:
                self.wfile.write(data)
                self.wfile.flush()
                return True
            except (OSError, ValueError):
                self.open = False
                return False

    def send_text(self, text):
        return self._write(encode_frame(text.encode("utf-8"), OP_TEXT))

    def send_ping(self):
        return self._write(encode_frame(b"", OP_PING))

    def send_pong(self, payload=b""):
        return self._write(encode_frame(payload, OP_PONG))

    def send_close(self, code=1000, reason=""):
        body = struct.pack("!H", code) + reason.encode("utf-8")[:123]
        self._write(encode_frame(body, OP_CLOSE))
        self.open = False

    def terminate(self):
        """Drop the socket so a thread blocked on read wakes up."""
        self.open = False
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

    # ---------- receiving ----------

    def _read_exactly(self, count):
        chunks = []
        remaining = count
        while remaining > 0:
            chunk = self.rfile.read(remaining)
            if not chunk:
                return None
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def _read_frame(self):
        head = self._read_exactly(2)
        if head is None:
            return None
        fin = bool(head[0] & 0x80)
        if head[0] & 0x70:
            raise ProtocolError(1002, "reserved bits must be zero")
        opcode = head[0] & 0x0F
        masked = bool(head[1] & 0x80)
        length = head[1] & 0x7F

        if length == 126:
            extended = self._read_exactly(2)
            if extended is None:
                return None
            length = struct.unpack("!H", extended)[0]
        elif length == 127:
            extended = self._read_exactly(8)
            if extended is None:
                return None
            length = struct.unpack("!Q", extended)[0]

        if not masked:
            raise ProtocolError(1002, "client frames must be masked")
        if length > MAX_PAYLOAD:
            raise ProtocolError(1009, "message too large")
        if opcode >= OP_CLOSE and (length > 125 or not fin):
            raise ProtocolError(1002, "control frames must be short and unfragmented")

        mask = self._read_exactly(4)
        if mask is None:
            return None
        payload = self._read_exactly(length) if length else b""
        if payload is None:
            return None
        if length:
            payload = bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))
        return fin, opcode, payload

    def messages(self):
        """Yield complete text messages until the connection ends."""
        buffer = bytearray()
        buffering = False
        while self.open:
            try:
                frame = self._read_frame()
            except ProtocolError as err:
                self.send_close(err.code, err.reason)
                return
            except (OSError, ValueError, struct.error):
                return
            if frame is None:
                return

            fin, opcode, payload = frame

            if opcode == OP_CLOSE:
                self.send_close(1000)
                return
            if opcode == OP_PING:
                self.send_pong(payload)
                continue
            if opcode == OP_PONG:
                self.alive = True
                continue

            if opcode == OP_CONTINUATION:
                if not buffering:
                    self.send_close(1002, "unexpected continuation")
                    return
                buffer.extend(payload)
            elif opcode in (OP_TEXT, OP_BINARY):
                if buffering:
                    self.send_close(1002, "expected continuation")
                    return
                buffer = bytearray(payload)
                buffering = True
            else:
                self.send_close(1003, "unsupported opcode")
                return

            if len(buffer) > MAX_PAYLOAD:
                self.send_close(1009, "message too large")
                return

            if fin and buffering:
                buffering = False
                try:
                    text = bytes(buffer).decode("utf-8")
                except UnicodeDecodeError:
                    self.send_close(1007, "invalid utf-8")
                    return
                buffer = bytearray()
                yield text
