# EasyChat

A small, good-looking chat room you host yourself and share with a link. One
device runs the server, everyone else just opens the URL, types a name and
starts talking. Every conversation is a plain JSON file in an **EasyChat Chats**
folder on the host machine — nothing is stored anywhere else.

- Blue-and-white interface with iMessage-style bubbles and a Discord-style room list
- Live typing indicators, presence, unread badges
- Markdown: `**bold**`, `*italic*`, `__underline__`, `~~strike~~`, `` `code` ``, code blocks, `> quotes`, `||spoilers||`, links, `@mentions`
- GIF search powered by Tenor
- Passcode gate so a stray link-visitor cannot wander in
- Works on phones

---

## 1. Install

You need [Node.js](https://nodejs.org) 18 or newer on the host device.

```bash
npm install
cp .env.example .env
```

Open `.env` and set at least a passcode:

```ini
PORT=3000
ROOM_PASSWORD=pick-something-good
TENOR_API_KEY=
```

## 2. Get a Tenor key (for GIF search)

GIF search is the only part that needs an outside service. Everything else
works without it — the GIF button simply says it is not configured.

1. Go to <https://developers.google.com/tenor/guides/quickstart> and follow
   "Get a key": it creates a Google Cloud project and enables the Tenor API.
2. Copy the API key into `.env` as `TENOR_API_KEY=...`
3. Restart the server.

The key stays on the host — browsers never see it, they ask your server and
your server asks Tenor.

## 3. Run it

```bash
npm start
```

That prints the local address and where chats are being written:

```
EasyChat is running
Local:      http://localhost:3000
Chats:      /home/you/EasyChat/EasyChat Chats
Passcode:   required
GIF search: on (Tenor)
```

## 4. Put it on the internet

Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/),
then in a second terminal:

```bash
npm run tunnel
```

It starts the server if it is not already up, opens a Cloudflare quick tunnel
and prints the public link:

```
┌────────────────────────────────────────┐
│    https://smooth-otter-lake.trycloudflare.com    │
└────────────────────────────────────────┘
```

Share that link and the passcode. The link lives as long as the command runs —
stop it and start it again and you get a new one. (Prefer doing it by hand?
`cloudflared tunnel --url http://localhost:3000` is the whole trick.)

---

## The chats folder

```
EasyChat Chats/
  general.json
  random.json
  design-talk.json
```

Each file holds the room and its messages:

```json
{
  "id": "general",
  "name": "General",
  "topic": "The default room. Say hi.",
  "createdAt": 1789475735566,
  "messages": [
    { "id": "…", "type": "chat", "user": "riley", "text": "hey **everyone**", "attachment": null, "ts": 1789475737822 }
  ]
}
```

Back it up by copying the folder. Delete a file to delete a room (restart
afterwards). Rooms created from the app's **+** button show up here
immediately. Only the newest `MAX_MESSAGES_PER_ROOM` messages (2000 by
default) are kept per file.

Put the folder somewhere else with `CHATS_DIR=/path/to/somewhere` in `.env`.

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port the server listens on |
| `ROOM_PASSWORD` | _empty_ | Passcode required to enter. Empty means anyone with the link can join |
| `TENOR_API_KEY` | _empty_ | Enables GIF search |
| `CHATS_DIR` | `./EasyChat Chats` | Where the JSON files live |
| `MAX_MESSAGES_PER_ROOM` | `2000` | Messages kept per room |

## Shortcuts

| Key | Action |
| --- | --- |
| `Enter` | Send |
| `Shift` + `Enter` | New line |
| `Esc` | Close the GIF picker / menu / dialog |

## Good to know

- **It is a quick tunnel, not a fortress.** The passcode keeps strangers out of
  the room; it is not encryption. Don't share anything you would mind a
  determined person reading.
- Messages are HTML-escaped before markdown is applied, so nobody can inject
  markup or scripts into someone else's browser.
- Only `https://media*.tenor.com` images can be attached — a client cannot make
  the room load an arbitrary URL.
- There is a light rate limit (10 messages per 10 seconds per connection).
- Closing the server saves everything on the way out; a browser that loses
  connection reconnects on its own with a backoff.

## Layout

```
server.js            HTTP + WebSocket server, join/typing/presence logic
lib/store.js         Rooms on disk — one JSON file each
lib/gifs.js          Tenor proxy and response cache
scripts/tunnel.js    npm run tunnel
public/index.html    Markup
public/css/styles.css  Theme, layout, animations
public/js/app.js     Client: websocket, rendering, GIF picker
public/js/markdown.js  The small safe markdown renderer
```
