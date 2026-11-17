// Звідки брати відео для кнопки "Дивитись".
//
// resolveStream(movie) повертає масив кандидатів (або null):
//   { type: 'video',  url, format?, subtitles?, qualities? }   -> KZPlayer (player-ui.js)
//   { type: 'iframe', url }                                    -> сторінка плеєра в iframe
// app.js пробує кандидатів по черзі: спершу всі video (не заграло -> наступний), потім iframe,
// а якщо нічого не вийшло, показує трейлер і легальні сервіси.
//
// Каскад: кеш (localStorage, CACHE_TTL) -> SOURCES -> MANUAL -> null.
// movie: дані TMDB (id, imdb_id, title, original_title, release_date, ...).

(() => {
  'use strict';

  const CACHE_KEY = 'kz_stream_cache';
  const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 годин
  const SOURCE_TIMEOUT = 8000;          // мс на одне джерело

  // ---------- Помічники для адаптерів ----------
  // Підстановки в шаблонах: {imdb_id} {tmdb_id} {title} {year}
  const fill = (tpl, m) => tpl
    .replace(/\{imdb_id\}/g, encodeURIComponent(m.imdb_id || ''))
    .replace(/\{tmdb_id\}/g, encodeURIComponent(m.id))
    .replace(/\{title\}/g, encodeURIComponent(m.original_title || m.title || ''))
    .replace(/\{year\}/g, (m.release_date || '').slice(0, 4));
  const needsImdb = (tpl, m) => tpl.includes('{imdb_id}') && !m.imdb_id;

  // Адаптер "URL за шаблоном": жодних запитів, просто підставляє id в URL.
  // extra: { type: 'iframe' } або { format: 'mpegts' }, { subtitles: [...] } тощо.
  function fromTemplate(name, template, extra = {}) {
    return {
      name,
      async resolve(m) {
        if (needsImdb(template, m)) return null;
        return Object.assign({ type: 'video' }, extra, { url: fill(template, m) });
      },
    };
  }

  // Адаптер "JSON API": тягне JSON і віддає його в pick(json, movie),
  // який повертає кандидата, масив кандидатів або null.
  function fromJson(name, template, pick, init = {}) {
    return {
      name,
      async resolve(m, signal) {
        if (needsImdb(template, m)) return null;
        const r = await fetch(fill(template, m), Object.assign({ signal }, init));
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return pick(await r.json(), m);
      },
    };
  }

  // ---------- SOURCES: у порядку пріоритету ----------
  // Опитуються паралельно, з таймаутом SOURCE_TIMEOUT. Порядок у масиві = порядок спроб у плеєрі.
  const SOURCES = [
    // fromTemplate('primary', 'https://example.com/hls/{imdb_id}/master.m3u8'),                                   // TODO: домен
    // fromJson('api', 'https://example.com/api/movie/{imdb_id}', (j) => j && j.url ? { type: 'video', url: j.url } : null), // TODO: домен
    // fromTemplate('embed', 'https://example.com/embed/{imdb_id}', { type: 'iframe' }),                           // TODO: домен
  ];

  // ---------- MANUAL: ручні посилання ----------
  // Ключ: imdb_id ('tt1234567') або 'tmdb:<id>'. Значення: кандидат або масив кандидатів.
  const MANUAL = {
    // 'tt0000000': {
    //   type: 'video',
    //   url: 'https://example.com/film/master.m3u8', // TODO: посилання
    //   subtitles: [{ label: 'Українські', lang: 'uk', url: 'https://example.com/film/uk.vtt', default: true }],
    // },
  };

  // ---------- Кеш ----------
  const keyOf = (m) => m.imdb_id || `tmdb:${m.id}`;
  const cache = {
    all() { try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch { return {}; } },
    save(all) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(all)); } catch { /* ignore */ } },
    get(k) {
      const all = this.all(), e = all[k];
      if (!e) return null;
      if (Date.now() - e.at > CACHE_TTL) { delete all[k]; this.save(all); return null; }
      return e.list;
    },
    set(k, list) {
      const all = this.all(), now = Date.now();
      for (const [kk, e] of Object.entries(all)) if (now - e.at > CACHE_TTL) delete all[kk];
      all[k] = { at: now, list };
      this.save(all);
    },
    drop(k, url) {
      const all = this.all(), e = all[k];
      if (!e) return;
      e.list = url ? e.list.filter((c) => c.url !== url) : [];
      if (!e.list.length) delete all[k];
      this.save(all);
    },
  };

  // ---------- Каскад ----------
  const norm = (x) => (Array.isArray(x) ? x : [x])
    .filter((c) => c && typeof c.url === 'string' && c.url && (c.type === 'video' || c.type === 'iframe'));

  function runSource(src, m) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), SOURCE_TIMEOUT);
    return Promise.race([
      Promise.resolve().then(() => src.resolve(m, ctl.signal)),
      new Promise((_, reject) => ctl.signal.addEventListener('abort', () => reject(new Error('timeout')))),
    ]).finally(() => clearTimeout(timer));
  }

  async function fromSources(m) {
    if (!SOURCES.length) return [];
    const settled = await Promise.allSettled(SOURCES.map((s) => runSource(s, m)));
    const out = [];
    settled.forEach((r, i) => {
      const name = SOURCES[i].name;
      if (r.status === 'fulfilled') norm(r.value).forEach((c) => out.push(Object.assign({ source: name }, c)));
      else console.warn(`[sources] ${name}:`, (r.reason && r.reason.message) || r.reason);
    });
    return out;
  }

  async function resolveStream(m) {
    const key = keyOf(m);
    let list = cache.get(key);
    if (!list) {
      list = await fromSources(m);
      if (list.length) cache.set(key, list);
    }
    // MANUAL не кешується, щоб правки в ньому діяли одразу.
    const manual = norm(MANUAL[m.imdb_id] || MANUAL[`tmdb:${m.id}`]).map((c) => Object.assign({ source: 'manual' }, c));
    const seen = new Set();
    const all = list.concat(manual).filter((c) => !seen.has(c.url) && seen.add(c.url));
    return all.length ? all : null;
  }

  // app.js викликає invalidate, коли кандидат не заграв: прибирає його з кешу.
  resolveStream.invalidate = (m, c) => cache.drop(keyOf(m), c && c.url);
  resolveStream.clearCache = () => { try { localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ } };
  resolveStream.helpers = { fromTemplate, fromJson };

  window.resolveStream = resolveStream;
})();
