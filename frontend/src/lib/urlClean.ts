/**
 * Strip tracking parameters from URLs entering the app (pasted into the
 * composer, seeded from web-search results). Conservative by design: only
 * well-known tracking keys are removed, so functional query params survive.
 * Everything downstream benefits — the stored conversation, fetch_url, notes.
 */

// Whole-key matches (lowercased).
const TRACKING_KEYS = new Set([
  'fbclid',
  'gclid',
  'gclsrc',
  'dclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'ttclid',
  'twclid',
  'yclid',
  'igshid',
  'igsh',
  'mc_cid',
  'mc_eid',
  '_hsenc',
  '_hsmi',
  'hsctatracking',
  'vero_id',
  'oly_enc_id',
  'oly_anon_id',
  's_kwcid',
  'srsltid',
  'mkt_tok',
  'spm',
  'ref_src',
  'ref_url',
  'si', // YouTube/Spotify share-source id
]);

// Prefix matches (lowercased): utm_source, utm_medium, utm_campaign, ...
const TRACKING_PREFIXES = ['utm_', 'pk_', 'mtm_', 'piwik_', 'matomo_'];

function isTracking(key: string): boolean {
  const k = key.toLowerCase();
  return TRACKING_KEYS.has(k) || TRACKING_PREFIXES.some((p) => k.startsWith(p));
}

/** Return `raw` with tracking params removed; unchanged if nothing matched. */
export function cleanUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return raw;
  let changed = false;
  for (const key of [...url.searchParams.keys()]) {
    if (isTracking(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (!changed) return raw; // preserve the original string byte-for-byte
  let out = url.toString();
  // URL keeps a dangling "?" when the last param was removed — drop it.
  if (url.searchParams.size === 0) out = out.replace(/\?(?=#|$)/, '');
  return out;
}

// http(s) URLs in free text; trailing sentence punctuation excluded.
const URL_IN_TEXT = /https?:\/\/[^\s<>"'）)\]]+/g;

/** Clean every URL found in a block of text (composer paste, draft seeds). */
export function cleanUrlsInText(text: string): string {
  return text.replace(URL_IN_TEXT, (match) => {
    // Keep trailing punctuation ("see https://x.com?utm_source=a.") intact.
    const m = /^(.*?)([.,;:!?]+)?$/.exec(match);
    const core = m?.[1] ?? match;
    const tail = m?.[2] ?? '';
    return cleanUrl(core) + tail;
  });
}
