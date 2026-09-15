# EasyChat

A small, good-looking chat room you host yourself and share with a link. One
device runs the server, everyone else just opens the URL, types a name and
starts talking. Every conversation is a plain JSON file in an **EasyChat Chats**
folder on the host machine — nothing is stored anywhere else.

- Blue-and-white interface with iMessage-style bubbles and a Discord-style room list
- Real accounts: your username is yours, and you stay signed in across restarts
- Every room has its own password, chosen when the room is made
- Live typing indicators, presence, unread badges
- Markdown: `**bold**`, `*italic*`, `__underline__`, `~~strike~~`, `` `code` ``, code blocks, `> quotes`, `||spoilers||`, links, `@mentions`
- GIF search powered by Tenor
- An invite code so a stray link-visitor cannot register
- Desktop notifications and a chime when you are not looking
- Works on phones

**Nothing to install.** The server is plain Python with no pip packages — no
`pip install`, no Node, no build step. If the host device has no Python at all,
the launcher fetches a portable copy into the project folder. Everything stays
inside this one folder and no step needs administrator rights.

---

## Run it on Windows

1. Put this folder somewhere you can write to — Desktop or Documents is fine.
2. Copy `.env.example` to `.env` and open it in Notepad. At minimum set a
   passcode:

   ```ini
   PORT=3000
   INVITE_CODE=pick-something-good
   TENOR_API_KEY=
   ```

3. Double-click **`start.bat`**.

That's it. The window prints:

```
EasyChat is running
Local:      http://localhost:3000
Chats:      C:\Users\you\Desktop\EasyChat\EasyChat Chats
Accounts:   0 registered - the first person to register becomes the host
Invite code: required to register
GIF search: off (set TENOR_API_KEY in .env)
```

Open <http://localhost:3000> to check it, and leave the window open — closing it
stops the chat. Anyone on the same office Wi-Fi can already reach it at
`http://<your-ip>:3000`.

### Sharing it with the world

Double-click **`share.bat`** instead. It starts the chat *and* opens a
Cloudflare tunnel, then prints the public link:

```
+--------------------------------------------------+
|    https://smooth-otter-lake.trycloudflare.com    |
+--------------------------------------------------+
```

Share that link and the invite code. It lives as long as the window stays open;
open it again later and you get a different link.

The first run of each script downloads what it needs into the project folder:

| Folder | What lands there | When |
| --- | --- | --- |
| `.python\` | A portable Python (~11 MB) | Only if the device has no Python |
| `.bin\` | `cloudflared.exe` (~40 MB) | Only on the first `share.bat` |

Both are plain unzips, not installers — no admin rights, no registry, nothing
added to PATH. Delete either folder to undo it.

## Run it on macOS or Linux

python3 is already there, so:

```bash
./start.sh      # chat on http://localhost:3000
./share.sh      # chat plus the public link
```

## GIF search

GIF search is the only part that talks to an outside service, and it is off
until you give it a key. Everything else works without one — the GIF button
just says it is not configured.

1. Open <https://developers.google.com/tenor/guides/quickstart> and follow
   "Get a key".
2. Put it in `.env` as `TENOR_API_KEY=...`
3. Restart the chat.

The key stays on the host. Browsers ask *your* server for GIFs and your server
asks Tenor, so the key is never sent to anyone in the room.

---

## Accounts

The first person to open EasyChat creates an account, and **that first account
is the host**. Everyone after them signs in with their own username and
password. A name belongs to whoever registered it, so nobody can type your name
and speak as you.

If `INVITE_CODE` is set in `.env`, it is required to *create* an account —
signing in afterwards needs only the person's own password. That is what keeps
strangers who find the link from registering.

Accounts live in `EasyChat Chats/accounts/users.json`, with passwords stored as
PBKDF2 hashes like room passwords. Signing in issues a token that lasts 30 days,
so people are not asked again every time they open the link. Sign out from the
button next to your name.

**Forgot a password?** Stop the chat, open `users.json`, and replace that
person's `"password": { ... }` block with plain text — `"password": "new-one"`.
It is hashed on the next start, exactly like room passwords.

**To remove someone**, delete their entry from `users.json` and restart.

Extra hosts can be named in `.env` as `HOST_USERS=riley,sam`.

## Rooms and passwords

Every room made from the **+** button needs a password, typed when the room is
created. Anyone who clicks that room is asked for it before they see a single
message, and rooms they cannot open show a padlock in the list.

The one exception is **General**, the room created on first run. It is open, so
that people who have the link and the front-door passcode always land
somewhere. Lock it too if you want — see below.

A password is remembered for as long as that browser tab is open, so switching
rooms and reloading do not ask again. Everyone else — a new tab, another
person, tomorrow — is asked once.

Passwords are stored as a PBKDF2 hash, never as the text that was typed, so
someone who gets hold of a chat file cannot read the password out of it. That
means a forgotten room password cannot be looked up. It can be replaced:

**To set, change or remove a room's password by hand**, stop the chat and open
that room's JSON file:

```jsonc
// set or change it: type the new password as plain text
"password": "new-password-here",

// remove it, making the room open to everyone:
// delete the whole "password" line
```

Start the chat again. On the way up the server hashes what you typed and
rewrites the file, so the plain text does not sit on disk — the console prints
`stored the password for <room> as a hash` when it does.

Guessing is throttled: six wrong passwords from one connection and it stops
answering for a minute.

## The chats folder

```
EasyChat Chats/
  general.json
  secret-lair.json
  weekend-plans.json
```

Each file holds one room and its messages:

```json
{
  "id": "secret-lair",
  "name": "Secret Lair",
  "topic": "Planning the party",
  "createdAt": 1789475735566,
  "password": {
    "algo": "pbkdf2_sha256",
    "iterations": 120000,
    "salt": "64a8dd2b020f69b724d8c21a96b2615c",
    "hash": "62a29e6fd931ec8fa5a7f3e6c52bece6…"
  },
  "messages": [
    { "id": "…", "type": "chat", "user": "riley", "text": "hey **everyone**", "attachment": null, "ts": 1789475737822 }
  ]
}
```

A room with no `password` field is open to everyone.

Back it up by copying the folder. Delete a file to delete a room (restart
afterwards). Rooms made with the **+** button in the app show up here right
away. Only the newest `MAX_MESSAGES_PER_ROOM` messages (2000 by default) are
kept per file.

## Settings

All of these live in `.env`:

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port the server listens on |
| `INVITE_CODE` | _empty_ | Required to create an account. Empty means anyone with the link can register |
| `HOST_USERS` | _empty_ | Extra usernames with host powers, comma separated |
| `TENOR_API_KEY` | _empty_ | Enables GIF search |
| `CHATS_DIR` | `.\EasyChat Chats` | Where the JSON files live |
| `MAX_MESSAGES_PER_ROOM` | `2000` | Messages kept per room |

## Shortcuts

| Key | Action |
| --- | --- |
| `Enter` | Send |
| `Shift` + `Enter` | New line |
| `Esc` | Close the GIF picker / menu / dialog |

## If something goes wrong

**"Could not download Python automatically."** Your network probably blocks
python.org. On any other machine, grab the *Windows embeddable package (64-bit)*
from <https://www.python.org/downloads/windows/>, unzip it into a folder called
`.python` next to `start.bat` so that `.python\python.exe` exists, and run
`start.bat` again.

**cloudflared will not download or run.** Some work machines block unknown
programs outright. Two ways around it:

- Skip the tunnel and use the local network — `start.bat` alone is enough for
  anyone on the same Wi-Fi, at `http://<your-ip>:3000`. Find the address with
  `ipconfig`.
- Use the SSH client Windows already ships with, which needs no download:

  ```
  ssh -R 80:localhost:3000 nokey@localhost.run
  ```

  It prints a public link of its own. It is a different service with the same
  idea, and no account is needed.

**"Could not listen on port 3000."** Something else is using it. Set a
different `PORT` in `.env`.

**Antivirus flags the download.** Both files come straight from python.org and
GitHub's official cloudflared releases. If your policy blocks them, use the
manual steps above.

## Good to know

- **A quick tunnel link is public.** The invite code and passwords keep
  strangers out; they are not encryption. Don't put anything sensitive in there.
- There are three layers: the invite code gates who can register, an account
  password proves who you are, and each room has its own password on top.
- Room passwords are stored as PBKDF2-SHA256 hashes with a random salt, and a
  room's history is only sent after the password checks out.
- Messages are HTML-escaped before markdown is applied, so nobody can inject
  markup or scripts into anyone else's browser.
- Only `https://media*.tenor.com` images can be attached — nobody can make the
  room load an arbitrary URL.
- There is a light rate limit (10 messages per 10 seconds per connection).
- Closing the window saves everything on the way out, and a browser that loses
  its connection reconnects on its own.

## Layout

```
start.bat / start.sh      Run the chat
share.bat / share.sh      Run it and open a public link
server.py                 Entry point
share.py                  Tunnel helper (fetches cloudflared)
scripts/find-python.bat   Locates or fetches Python on Windows
easychat/config.py        Reads .env
easychat/store.py         Rooms on disk, one JSON file each
easychat/wsproto.py       WebSocket framing (stdlib only)
easychat/httpd.py         Static files, JSON API, the /ws upgrade
easychat/hub.py           Rooms, presence, typing, broadcasting
easychat/gifs.py          Tenor proxy and cache
public/                   The web app (HTML, CSS, JS)
```
