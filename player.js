// Звідки брати відео для кнопки "Дивитись".
//
// resolveStream(movie) повертає масив кандидатів (або null):
//   { type: 'video',  url, format?, subtitles?, qualities?, audios?, lang? }  -> KZPlayer (player-ui.js)
//   { type: 'iframe', url, lang? }                                           -> сторінка плеєра в iframe
// Кандидати з lang/audios сортуються: укр -> рос -> решта. Якщо є audios, url необов'язковий
// (береться з першої озвучки), а у плеєрі з'являється меню "Озвучка".
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

  // ---------- Токени джерел ----------
  // Порожній токен => джерело просто вимкнене, решта працює як є. TODO: вписати свої.
  // kodik (укр/рос озвучки): безкоштовна реєстрація на kodik-api.com -> токен у профілі.
  //   ВАЖЛИВО: старий домен kodikapi.com більше не резолвиться (ENOTFOUND), живий лише kodik-api.com,
  //   тому хости перебираються по черзі (див. KODIK_HOSTS).
  // alloha (прямий m3u8): токен видають ЛИШЕ за заявкою через Telegram-бота -> тому необов'язковий.
  const KEYS = { kodik: '', alloha: '' };
  // Хости Kodik API у порядку спроб (перший — робочий, другий лишений як страховка).
  const KODIK_HOSTS = ['kodik-api.com', 'kodikapi.com'];

  // Пріоритет мов: uk -> ru -> решта (незмінний порядок усередині групи).
  const langText = (x) => String((x && (x.lang || x.label || x.name)) || '').toLowerCase();
  const langRank = (x) => (/^(uk|ua)|укр|укра/.test(langText(x)) ? 0 : /^(ru|rus)|рос|рус/.test(langText(x)) ? 1 : 2);
  const sortByLang = (list) => list
    .map((x, i) => [x, i])
    .sort((a, b) => langRank(a[0]) - langRank(b[0]) || a[1] - b[1])
    .map((x) => x[0]);

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
  // ВАЖЛИВО: у ВЛАСНИЙ плеєр (KZPlayer) потрапляє лише type:'video' — і тільки якщо сервер
  // віддає прямий m3u8/mp4 і дозволяє CORS. Усе з type:'iframe' — це чужий плеєр.
  const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

  // Internet Archive: без ключа, віддає ПРЯМИЙ mp4 (=> власний плеєр + CORS у них відкритий).
  // Матчінг за назвою+роком; рік обов'язковий, бо інакше видача ловить зовсім інші фільми.
  const archive = {
    name: 'archive',
    async resolve(m, signal) {
      const q = `title:(${m.original_title || m.title || ''}) AND mediatype:movies`;
      const s = await fetch(`https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl%5B%5D=identifier&fl%5B%5D=year&rows=5&output=json`, { signal }).then((r) => r.json());
      const year = (m.release_date || '').slice(0, 4);
      const doc = (s?.response?.docs || []).find((d) => year && String(d.year || '') === year);
      if (!doc) return null;
      const meta = await fetch(`https://archive.org/metadata/${doc.identifier}`, { signal }).then((r) => r.json());
      const file = (meta.files || []).find((f) => /\.(mp4|m4v|webm)$/i.test(f.name));
      if (!file) return null;
      return { type: 'video', url: `https://archive.org/download/${doc.identifier}/${encPath(file.name)}` };
    },
  };

  // VidLink API (/api/b/movie/{tmdb_id}): має віддавати JSON з m3u8 (=> власний плеєр).
  // ПЕРЕВІРЕНО: без браузерного User-Agent -> 403, з ним -> 200, але тіло "null" (даних нема).
  // Тож зараз цей кандидат нічого не додає. TODO: знайти пряме HLS-джерело, що справді віддає m3u8.
  const vidlink = fromJson('vidlink', 'https://vidlink.pro/api/b/movie/{tmdb_id}', (j) => {
    const st = j && j.stream;
    if (!st || !st.playlist) return null;
    const abs = (u) => (!u ? '' : /^https?:/i.test(u) ? u : 'https://vidlink.pro' + (u[0] === '/' ? '' : '/') + u);
    return {
      type: 'video',
      format: 'hls',
      url: abs(st.playlist),
      subtitles: (st.captions || [])
        .map((c) => ({ label: c.language || 'Субтитри', lang: String(c.language || 'und').slice(0, 5), url: abs(c.url) }))
        .filter((c) => c.url),
    };
  });

  // Kodik: укр/рос озвучки. Тягне список перекладів -> окремий iframe на кожен переклад (укр перші),
  // а всередині плеєра Kodik до того ж є власний перемикач озвучок.
  // Хости перебираються по черзі, бо kodikapi.com помер. TODO: перевірити поля на своєму токені.
  const kodik = KEYS.kodik && {
    name: 'kodik',
    async resolve(m, signal) {
      if (!m.imdb_id) return null;
      const q = `imdb_id=${encodeURIComponent(m.imdb_id)}&types=movie&with_material_data=false&token=${KEYS.kodik}`;
      let j = null, err = null;
      for (const host of KODIK_HOSTS) {
        try {
          const r = await fetch(`https://${host}/search?${q}`, { signal });
          if (!r.ok) { const e = new Error(`${host}: HTTP ${r.status}`); e.http = true; if (!err || !err.http) err = e; continue; }
          j = await r.json();
          break;
        } catch (e) { if (!err) err = e; }
      }
      if (!j) { if (err) throw err; return null; }
      const seen = new Set();
      const out = [];
      for (const r of (j && j.results) || []) {
        const tr = r.translation || {};
        if (!r.link || seen.has(tr.id)) continue;
        seen.add(tr.id);
        out.push({ type: 'iframe', lang: tr.title || '', url: `https:${r.link}${r.link.includes('?') ? '&' : '?'}translations=true` });
      }
      return out.length ? sortByLang(out) : null;
    },
  };

  // Alloha: віддає ПРЯМИЙ m3u8 (=> власний плеєр + наше меню "Озвучка"). Токен — за заявкою.
  // TODO: якщо у відповіді з'явиться список перекладів — скласти їх у поле audios.
  const alloha = KEYS.alloha && fromJson(
    'alloha',
    `https://api.alloha.tv/?token=${KEYS.alloha}&imdb={imdb_id}`,
    (j) => {
      const d = j && j.data;
      if (!d || !d.file) return null;
      return { type: 'video', format: 'hls', lang: (d.translation && d.translation.name) || '', url: d.file };
    },
  );

  // TODO-кандидати на майбутнє: api.videasy.net (мультимовний, без токена) — з мого середовища
  // таймаутить (>30 с), ймовірний шлях https://api.videasy.net/movie/{tmdb_id}/sources.
  // Далі — iframe-вбудови (чужі плеєрі). Усі хости нижче перевірені як живі (HTTP 200).
  // TODO: домени живуть недовго — перевіряй і додавай нові.
  const SOURCES = [
    kodik,
    alloha,
    vidlink,
    archive,
    fromTemplate('2embed', 'https://www.2embed.cc/embed/{imdb_id}', { type: 'iframe' }),
    fromTemplate('vidsrc', 'https://vidsrc.to/embed/movie/{imdb_id}', { type: 'iframe' }),
    fromTemplate('vsembed', 'https://vsembed.ru/embed/movie/{imdb_id}', { type: 'iframe' }),
    fromTemplate('multiembed', 'https://multiembed.mov/?video_id={imdb_id}&tmdb=1', { type: 'iframe' }),
    fromTemplate('vidlink-embed', 'https://vidlink.pro/movie/{tmdb_id}', { type: 'iframe' }),
  ].filter(Boolean);

  // ---------- MANUAL: ручні посилання ----------
  // Ключ: imdb_id ('tt1234567') або 'tmdb:<id>'. Значення: кандидат або масив кандидатів.
  // Не кешується — правки діють одразу після перезавантаження сторінки.
  const MANUAL = {
    // Демо вибору озвучки у власному плеєрі: розкоментуй і відкрий "Матрицю" (tt0133093).
    // Коли є audios, поле url необов'язкове — підставляється з першої озвучки.
    // Обидві «озвучки» вказують на тестовий HLS — у плеєрі з'явиться меню "Озвучка",
    // українська стоятиме першою (uk -> ru -> перша), перемикання тримає позицію.
    // 'tt0133093': {
    //   type: 'video', format: 'hls',
    //   audios: [
    //     { label: 'Українська (тест)', lang: 'uk', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' },
    //     { label: 'Російська (тест)', lang: 'ru', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' },
    //   ],
    // },
    // Одна озвучка / будь-який фільм:
    // 'tt0000000': { type: 'video', format: 'hls', url: 'https://example.com/film/master.m3u8' },
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
  // Кандидат валідний, якщо має url АБО непорожній список озвучок (тоді url береться з першої).
  const norm = (x) => (Array.isArray(x) ? x : [x])
    .filter((c) => c && (c.type === 'video' || c.type === 'iframe') && (c.url || (c.audios && c.audios.length)))
    .map((c) => (c.url ? c : Object.assign({}, c, { url: c.audios[0].url })))
    .filter((c) => typeof c.url === 'string' && c.url);

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
    // Пріоритет мов: укр -> рос -> решта (app.js потім лише піднімає video над iframe, порядок усередині груп зберігається).
    const all = sortByLang(list.concat(manual).filter((c) => !seen.has(c.url) && seen.add(c.url)));
    return all.length ? all : null;
  }

  // app.js викликає invalidate, коли кандидат не заграв: прибирає його з кешу.
  resolveStream.invalidate = (m, c) => cache.drop(keyOf(m), c && c.url);
  resolveStream.clearCache = () => { try { localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ } };
  resolveStream.helpers = { fromTemplate, fromJson };

  window.resolveStream = resolveStream;
})();
