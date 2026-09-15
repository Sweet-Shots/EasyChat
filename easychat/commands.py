"""Slash commands.

None of these call anything outside the process: they are dice, coin flips,
room housekeeping and a couple of text macros. A command returns one of four
results and the hub decides what to do with it:

    notice  - shown only to the person who typed it, never stored
    emote   - "riley rolled 7", stored as a normal message so search,
              replies, reactions and export all work on it
    say     - an ordinary message from that person
    system  - a room notice, stored, e.g. "riley changed the topic"
"""

import random
import re

MAX_DICE = 20
MAX_SIDES = 1000
EIGHT_BALL = [
    "It is certain.",
    "Without a doubt.",
    "Yes, definitely.",
    "You may rely on it.",
    "Most likely.",
    "Signs point to yes.",
    "Reply hazy, try again.",
    "Ask again later.",
    "Better not tell you now.",
    "Cannot predict now.",
    "Don't count on it.",
    "My reply is no.",
    "My sources say no.",
    "Outlook not so good.",
    "Very doubtful.",
]

_registry = {}


def notice(text):
    return {"kind": "notice", "text": text}


def emote(text):
    return {"kind": "emote", "text": text}


def say(text):
    return {"kind": "say", "text": text}


def system(text):
    return {"kind": "system", "text": text}


def error(text):
    return {"kind": "error", "text": text}


def command(name, usage, help_text, *, host_only=False, aliases=()):
    def wrap(fn):
        entry = {
            "name": name,
            "usage": usage,
            "help": help_text,
            "hostOnly": host_only,
            "run": fn,
        }
        _registry[name] = entry
        for alias in aliases:
            _registry[alias] = dict(entry, name=alias, alias_of=name)
        return fn

    return wrap


def listing(is_host):
    """What to offer in the autocomplete, in a sensible order."""
    seen = []
    for entry in _registry.values():
        if entry.get("alias_of") or (entry["hostOnly"] and not is_host):
            continue
        seen.append(
            {
                "name": entry["name"],
                "usage": entry["usage"],
                "help": entry["help"],
                "hostOnly": entry["hostOnly"],
            }
        )
    return seen


def split(text):
    """'/roll 2d6' -> ('roll', '2d6'). Returns (None, text) if not a command."""
    if not text.startswith("/") or text.startswith("//"):
        return None, text
    head, _, rest = text[1:].partition(" ")
    return head.strip().lower(), rest.strip()


def run(name, args, ctx):
    entry = _registry.get(name)
    if not entry:
        return error(f"There is no /{name} command. Try /help.")
    if entry["hostOnly"] and not ctx["is_host"]:
        return error(f"/{entry['name']} is for hosts.")
    return entry["run"](args, ctx)


# ---------------------------------------------------------------- fun

@command("roll", "/roll [2d6]", "Roll dice. Defaults to one six-sided die.")
def _roll(args, ctx):
    spec = (args or "1d6").lower().replace(" ", "")
    match = re.fullmatch(r"(\d*)d(\d+)", spec)
    if not match:
        return error("Try /roll, /roll d20, or /roll 2d6.")
    count = int(match.group(1) or 1)
    sides = int(match.group(2))
    if not 1 <= count <= MAX_DICE:
        return error(f"Between 1 and {MAX_DICE} dice, please.")
    if not 2 <= sides <= MAX_SIDES:
        return error(f"Dice need between 2 and {MAX_SIDES} sides.")

    rolls = [random.randint(1, sides) for _ in range(count)]
    total = sum(rolls)
    if count == 1:
        return emote(f"rolled **{total}** on a {sides}-sided die")
    return emote(f"rolled **{total}** on {count}d{sides} ({', '.join(map(str, rolls))})")


@command("flip", "/flip", "Flip a coin.")
def _flip(args, ctx):
    return emote(f"flipped **{random.choice(['heads', 'tails'])}**")


@command("pick", "/pick tea | coffee | neither", "Pick one of several options.")
def _pick(args, ctx):
    options = [part.strip() for part in re.split(r"\s*[|,]\s*", args or "") if part.strip()]
    if len(options) < 2:
        return error("Give me at least two options: /pick tea | coffee")
    if len(options) > 20:
        return error("Twenty options is plenty.")
    return emote(f"picked **{random.choice(options)}** out of {len(options)}")


@command("8ball", "/8ball will it rain?", "Ask the magic eight ball.", aliases=("eightball",))
def _eight_ball(args, ctx):
    if not args:
        return error("Ask it something: /8ball will it rain?")
    return emote(f"asked “{args[:120]}” and the eight ball says: **{random.choice(EIGHT_BALL)}**")


@command("me", "/me makes tea", "Say what you are doing, in the third person.")
def _me(args, ctx):
    if not args:
        return error("Try /me makes tea.")
    return emote(args)


@command("shrug", "/shrug [text]", "Append a shrug to your message.")
def _shrug(args, ctx):
    return say(f"{args} ¯\\_(ツ)_/¯".strip())


@command("tableflip", "/tableflip [text]", "Flip a table.")
def _tableflip(args, ctx):
    return say(f"{args} (╯°□°)╯︵ ┻━┻".strip())


@command("unflip", "/unflip [text]", "Put the table back.")
def _unflip(args, ctx):
    return say(f"{args} ┬─┬ ノ( ゜-゜ノ)".strip())


# ---------------------------------------------------------------- the room

@command("help", "/help", "List the commands you can use.")
def _help(args, ctx):
    lines = ["**Commands**"]
    for entry in listing(ctx["is_host"]):
        lines.append(f"`{entry['usage']}` — {entry['help']}")
    lines.append("")
    lines.append("Only you can see this. Start a message with `//` to send a literal slash.")
    return notice("\n".join(lines))


@command("who", "/who", "List who is in this room right now.")
def _who(args, ctx):
    names = ctx["members"]
    if not names:
        return notice("Nobody else is here right now.")
    return notice(f"**In this room ({len(names)})**\n" + ", ".join(names))


@command("away", "/away [back in 10]", "Show yourself as away in the member list.")
def _away(args, ctx):
    ctx["set_status"]((args or "away")[:60])
    return notice("You are marked as away. Send a message or use /back to clear it.")


@command("back", "/back", "Clear your away note.")
def _back(args, ctx):
    ctx["set_status"]("")
    return notice("Welcome back.")


@command("topic", "/topic what this room is for", "Set this room's topic.", host_only=True)
def _topic(args, ctx):
    topic = args.strip()[:120]
    ctx["set_topic"](topic)
    if not topic:
        return system(f"{ctx['username']} cleared the topic.")
    return system(f"{ctx['username']} set the topic: {topic}")


@command("rename", "/rename Weekend Plans", "Rename this room.", host_only=True)
def _rename(args, ctx):
    name = args.strip()[:40]
    if len(name) < 2:
        return error("Room names need at least 2 characters.")
    problem = ctx["rename_room"](name)
    if problem:
        return error(problem)
    return system(f"{ctx['username']} renamed the room to {name}.")


@command("bans", "/bans", "List who has been removed from this room.", host_only=True)
def _bans(args, ctx):
    banned = ctx["banned"]
    if not banned:
        return notice("Nobody has been removed from this room.")
    return notice(
        "**Removed from this room**\n"
        + "\n".join(f"- {name}" for name in banned)
        + "\n\nLet someone back in with `/unban <name>`."
    )


@command("unban", "/unban riley", "Let someone back into this room.", host_only=True)
def _unban(args, ctx):
    name = args.strip()
    if not name:
        return error("Who should I let back in? /unban riley")
    if not ctx["unban"](name):
        return error(f'"{name}" is not on the removed list for this room.')
    return system(f"{ctx['username']} let {name} back into the room.")
