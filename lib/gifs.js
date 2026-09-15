'use strict';

const TENOR = 'https://tenor.googleapis.com/v2';
const CACHE_TTL_MS = 5 * 60 * 1000;

const cache = new Map();

function normalise(results = []) {
  return results
    .map((item) => {
      const media = item.media_formats || {};
      const full = media.gif || media.mediumgif || media.tinygif;
      const preview = media.tinygif || media.nanogif || full;
      if (!full || !preview) return null;
      const [w, h] = full.dims || preview.dims || [320, 240];
      return {
        id: item.id,
        title: item.content_description || item.title || 'GIF',
        url: full.url,
        preview: preview.url,
        width: w,
        height: h,
      };
    })
    .filter(Boolean);
}

async function tenorFetch(apiKey, endpoint, params) {
  const url = new URL(`${TENOR}/${endpoint}`);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('client_key', 'easychat');
  url.searchParams.set('media_filter', 'gif,tinygif,nanogif');
  url.searchParams.set('contentfilter', 'medium');
  url.searchParams.set('limit', '30');
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }

  const cacheKey = url.toString();
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Tenor responded ${res.status}`);
    const body = await res.json();
    const value = { results: normalise(body.results), next: body.next || '' };
    cache.set(cacheKey, { at: Date.now(), value });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return value;
  } finally {
    clearTimeout(timeout);
  }
}

function search(apiKey, query, pos) {
  return tenorFetch(apiKey, 'search', { q: query, pos });
}

function featured(apiKey, pos) {
  return tenorFetch(apiKey, 'featured', { pos });
}

module.exports = { search, featured };
