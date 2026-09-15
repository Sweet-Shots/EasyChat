"""Tenor lookups, proxied so the API key never leaves the host."""

import json
import threading
import time
import urllib.parse
import urllib.request

TENOR = "https://tenor.googleapis.com/v2"
CACHE_TTL_SECONDS = 300
CACHE_LIMIT = 200

_cache = {}
_lock = threading.Lock()


class GifError(Exception):
    pass


def _normalise(results):
    out = []
    for item in results or []:
        media = item.get("media_formats") or {}
        full = media.get("gif") or media.get("mediumgif") or media.get("tinygif")
        preview = media.get("tinygif") or media.get("nanogif") or full
        if not full or not preview:
            continue
        dims = full.get("dims") or preview.get("dims") or [320, 240]
        out.append(
            {
                "id": item.get("id", ""),
                "title": item.get("content_description") or item.get("title") or "GIF",
                "url": full["url"],
                "preview": preview["url"],
                "width": dims[0],
                "height": dims[1],
            }
        )
    return out


def _fetch(api_key, endpoint, params):
    query = {
        "key": api_key,
        "client_key": "easychat",
        "media_filter": "gif,tinygif,nanogif",
        "contentfilter": "medium",
        "limit": "30",
    }
    query.update({k: v for k, v in params.items() if v})
    url = f"{TENOR}/{endpoint}?{urllib.parse.urlencode(query)}"

    now = time.time()
    with _lock:
        hit = _cache.get(url)
        if hit and now - hit[0] < CACHE_TTL_SECONDS:
            return hit[1]

    try:
        request = urllib.request.Request(url, headers={"User-Agent": "EasyChat"})
        with urllib.request.urlopen(request, timeout=8) as response:
            body = json.loads(response.read().decode("utf-8"))
    except Exception as err:
        raise GifError(str(err)) from err

    value = {"results": _normalise(body.get("results")), "next": body.get("next", "")}
    with _lock:
        if len(_cache) > CACHE_LIMIT:
            _cache.clear()
        _cache[url] = (now, value)
    return value


def search(api_key, query, pos=""):
    return _fetch(api_key, "search", {"q": query, "pos": pos})


def featured(api_key, pos=""):
    return _fetch(api_key, "featured", {"pos": pos})
