/**
 * Unlimited client-side translation.
 *
 * Uses Google's public (unauthenticated) translate endpoint, which has no
 * API key or hard quota — suitable for an "unlimited" feature in a desktop
 * app. Results are cached in localStorage so repeated messages are never
 * re-translated.
 */

const CACHE_PREFIX = 'rd_tr_';
const TARGET_LANG_KEY = 'rd_translation_lang';

// Map a navigator language to a Google Translate target code.
function normalizeLang(code: string): string {
  const c = (code || '').toLowerCase().split(/[-_]/)[0];
  const supported = new Set([
    'en', 'zh', 'ru', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'ar', 'tr',
    'hi', 'id', 'vi', 'th', 'pl', 'uk', 'nl', 'sv', 'cs', 'ro', 'el', 'he',
    'fa', 'ms', 'fil', 'bn', 'ta', 'te', 'mr', 'gu', 'kn', 'ml', 'pa', 'ur',
  ]);
  return supported.has(c) ? c : 'en';
}

export function getTargetLanguage(): string {
  try {
    const stored = localStorage.getItem(TARGET_LANG_KEY);
    if (stored) return normalizeLang(stored);
  } catch {}
  try {
    return normalizeLang(navigator.language || 'en');
  } catch {
    return 'en';
  }
}

export function setTargetLanguage(lang: string): void {
  try {
    localStorage.setItem(TARGET_LANG_KEY, lang);
  } catch {}
}

function cacheKey(text: string, target: string): string {
  // Simple hash to keep keys short.
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (h * 31 + text.charCodeAt(i)) >>> 0;
  }
  return `${CACHE_PREFIX}${target}_${h}_${text.length}`;
}

export async function translateText(text: string, target?: string): Promise<string> {
  const t = (text || '').trim();
  if (!t) return text;
  const lang = target || getTargetLanguage();
  // Skip if already in target language? We can't know; just translate.

  const key = cacheKey(t, lang);
  try {
    const cached = localStorage.getItem(key);
    if (cached) return cached;
  } catch {}

  try {
    const url =
      'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' +
      encodeURIComponent(lang) +
      '&dt=t&q=' +
      encodeURIComponent(t);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // data[0] is array of [translated, original, ...]
    let out = '';
    if (Array.isArray(data) && Array.isArray(data[0])) {
      for (const seg of data[0]) {
        if (Array.isArray(seg) && typeof seg[0] === 'string') out += seg[0];
      }
    }
    if (!out) out = t;
    try {
      localStorage.setItem(key, out);
    } catch {}
    return out;
  } catch (err) {
    console.warn('[translation] failed:', err);
    return t;
  }
}

// Translate a batch of texts; returns array of translations in same order.
export async function translateBatch(texts: string[], target?: string): Promise<string[]> {
  const out: string[] = [];
  for (const txt of texts) {
    out.push(await translateText(txt, target));
  }
  return out;
}
