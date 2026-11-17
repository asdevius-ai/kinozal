// KZPlayer: власний плеєр поверх <video>.
//
//   const p = KZPlayer.mount(container, source, movie, opts)
//   p.unmount()
//
// source: рядок-URL або { url, format?, subtitles?, qualities?, audios?, live? }
//   format:    'hls' | 'mpegts' | 'flv' | 'native' (якщо не вказано, визначається з розширення URL)
//   subtitles: [{ label, lang, url, default? }]  (.vtt або .srt)
//   qualities: [{ label, url }]                  (для mp4 без HLS: ручне перемикання якості)
//   audios:    [{ label, lang, url, default? }]  (озвучки; пріоритет uk -> ru -> перша)
// opts: { startAt, poster, timeout, onTime(t, d), onPause(t, d), onEnded(d), onError(reason) }
//   Якщо onError не передано, помилка показується прямо в плеєрі.

(() => {
  'use strict';

  const ICON = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
    back: '<svg viewBox="0 0 24 24"><path d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/></svg>',
    fwd: '<svg viewBox="0 0 24 24"><path d="M12 5V1l5 5-5 5V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z"/></svg>',
    vol: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 5V4L8 9zm12.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z"/></svg>',
    mute: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 5V4L8 9z"/><path d="M16 9l5 6m0-6-5 6" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
    fs: '<svg viewBox="0 0 24 24"><path d="M5 5h5V3H3v7h2zm9-2v2h5v5h2V3zM5 14H3v7h7v-2H5zm14 5h-5v2h7v-7h-2z"/></svg>',
    fsExit: '<svg viewBox="0 0 24 24"><path d="M8 3v5H3v2h7V3zm8 0h-2v7h7V8h-5zM3 16h5v5h2v-7H3zm11 5h2v-5h5v-2h-7z"/></svg>',
  };
  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };
  const fmt = (s) => {
    if (!isFinite(s)) return '0:00';
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
  };
  const detect = (src) => {
    if (src.format) return src.format;
    const u = src.url.split(/[?#]/)[0].toLowerCase();
    if (u.endsWith('.m3u8')) return 'hls';
    if (u.endsWith('.flv')) return 'flv';
    if (u.endsWith('.ts')) return 'mpegts';
    return 'native';
  };
  // Safari/iOS: HLS нативно.
  const appleNativeHls = (v) => /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent) && !!v.canPlayType('application/vnd.apple.mpegurl');

  async function subtitleBlob(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('subtitles ' + r.status);
    let t = await r.text();
    if (!/^\uFEFF?WEBVTT/.test(t.trimStart())) t = 'WEBVTT\n\n' + t.replace(/\r/g, '').replace(/(\d\d:\d\d:\d\d),(\d{3})/g, '$1.$2');
    return URL.createObjectURL(new Blob([t], { type: 'text/vtt' }));
  }

  function mount(container, source, movie = {}, opts = {}) {
    const src = typeof source === 'string' ? { url: source } : Object.assign({}, source);
    const kind = detect(src);
    const cleanup = [];
    const blobs = [];
    const on = (t, ev, fn, o) => { t.addEventListener(ev, fn, o); cleanup.push(() => t.removeEventListener(ev, fn, o)); };
    let engine = { kind: 'native' };
    let destroyed = false, errored = false, started = false, dragging = false;
    let loadTimer = 0, idleTimer = 0, qIndex = 0;

    container.innerHTML = `
      <div class="kzp" tabindex="0">
        <video playsinline preload="auto"></video>
        <div class="kzp-title">${esc(movie.title || '')}</div>
        <div class="kzp-spin"></div>
        <div class="kzp-err hidden"></div>
        <button class="kzp-big" type="button" aria-label="Відтворити">${ICON.play}</button>
        <div class="kzp-ctrl">
          <div class="kzp-seek">
            <div class="kzp-buf"></div><div class="kzp-fill"></div>
            <input class="kzp-range" type="range" min="0" max="1000" step="1" value="0" aria-label="Перемотка">
            <div class="kzp-tip"></div>
          </div>
          <div class="kzp-row">
            <button type="button" data-k="play" aria-label="Відтворити / пауза">${ICON.play}</button>
            <button type="button" data-k="back" aria-label="Назад 10 с">${ICON.back}</button>
            <button type="button" data-k="fwd" aria-label="Вперед 10 с">${ICON.fwd}</button>
            <div class="kzp-volwrap">
              <button type="button" data-k="mute" aria-label="Звук">${ICON.vol}</button>
              <input class="kzp-vol" type="range" min="0" max="1" step="0.05" aria-label="Гучність">
            </div>
            <span class="kzp-time">0:00 / 0:00</span>
            <span class="kzp-sp"></span>
            <div class="kzp-menu hidden" data-m="subs"><button type="button" class="kzp-txt">CC</button><ul></ul></div>
            <div class="kzp-menu hidden" data-m="audio"><button type="button" class="kzp-txt">Озвучка</button><ul></ul></div>
            <div class="kzp-menu hidden" data-m="quality"><button type="button" class="kzp-txt">Авто</button><ul></ul></div>
            <div class="kzp-menu" data-m="speed"><button type="button" class="kzp-txt">1×</button><ul></ul></div>
            <button type="button" data-k="fs" aria-label="На весь екран">${ICON.fs}</button>
          </div>
        </div>
      </div>`;

    const root = container.querySelector('.kzp');
    const q = (s) => root.querySelector(s);
    const v = q('video');
    const range = q('.kzp-range'), fill = q('.kzp-fill'), buf = q('.kzp-buf'), tip = q('.kzp-tip');
    const vol = q('.kzp-vol'), timeEl = q('.kzp-time');
    const btn = (k) => q(`[data-k="${k}"]`);
    if (opts.poster) v.poster = opts.poster;

    // ---------- озвучки ----------
    // Варіанти: source.audios (окремі посилання на ту саму дорожку різними мовами)
    // або доріжки всередині HLS (EXT-X-MEDIA). Пріоритет: українська -> російська -> перша.
    const AUDIOS = (src.audios || []).filter((a) => a && a.url);
    const aText = (a) => String((a && (a.lang || a.label || a.name)) || '').toLowerCase();
    const aRank = (a) => (/^(uk|ua)|укр|укра/.test(aText(a)) ? 0 : /^(ru|rus)|рос|рус/.test(aText(a)) ? 1 : 2);
    const prefLang = ls.get('kz_audio_lang', -1); // запам'ятовуємо мову між фільмами
    let audioIndex = 0, audioPicked = false;
    if (AUDIOS.length) {
      const byPref = prefLang >= 0 ? AUDIOS.findIndex((a) => aRank(a) === prefLang) : -1;
      const byDef = AUDIOS.findIndex((a) => a.default);
      let best = 0;
      AUDIOS.forEach((a, i) => { if (aRank(a) < aRank(AUDIOS[best])) best = i; });
      audioIndex = byPref >= 0 ? byPref : byDef >= 0 ? byDef : best;
    }
    const startUrl = AUDIOS.length ? AUDIOS[audioIndex].url : src.url;

    // ---------- помилки ----------
    function fail(reason) {
      if (errored || destroyed) return;
      errored = true;
      clearTimeout(loadTimer);
      if (typeof opts.onError === 'function') {
        setTimeout(() => { if (!destroyed) opts.onError(reason); }, 0);
      } else {
        const e = q('.kzp-err');
        e.textContent = 'Не вдалося відтворити відео. ' + reason;
        e.classList.remove('hidden');
        root.classList.remove('loading');
      }
    }
    loadTimer = setTimeout(() => { if (!started) fail('timeout'); }, opts.timeout || 20000);

    // ---------- рушій ----------
    if (kind === 'hls' && !appleNativeHls(v) && window.Hls && window.Hls.isSupported()) {
      const Hls = window.Hls;
      const hls = new Hls({ enableWorker: true, maxBufferLength: 30 });
      engine = { kind: 'hls', hls };
      let netRetry = 0, mediaRetry = 0;
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (!d.fatal) return;
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR && started && netRetry++ < 2) hls.startLoad();
        else if (d.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRetry++ < 2) hls.recoverMediaError();
        else fail('hls: ' + d.details);
      });
      hls.on(Hls.Events.MANIFEST_PARSED, buildQuality);
      hls.on(Hls.Events.LEVEL_SWITCHED, buildQuality);
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, buildAudio);
      hls.loadSource(startUrl);
      hls.attachMedia(v);
    } else if ((kind === 'mpegts' || kind === 'flv') && window.mpegts && window.mpegts.isSupported()) {
      const mp = window.mpegts.createPlayer({ type: kind, isLive: !!src.live, url: startUrl });
      engine = { kind, mp };
      mp.on(window.mpegts.Events.ERROR, (type, detail) => fail(`mpegts: ${type} ${detail}`));
      mp.attachMediaElement(v);
      mp.load();
      on(v, 'error', () => fail('video: ' + (v.error ? v.error.code : '')));
    } else if (kind === 'hls' && !v.canPlayType('application/vnd.apple.mpegurl')) {
      fail('HLS не підтримується (hls.js не завантажився?)');
    } else if ((kind === 'mpegts' || kind === 'flv') && !window.mpegts) {
      fail('mpegts.js не завантажився');
    } else {
      const first = src.qualities && src.qualities.length ? src.qualities[0].url : startUrl;
      v.src = first;
      on(v, 'error', () => fail('video: ' + (v.error ? v.error.code : '')));
    }

    // ---------- субтитри з source.subtitles ----------
    (src.subtitles || []).forEach(async (s, i) => {
      try {
        const url = await subtitleBlob(s.url);
        if (destroyed) { URL.revokeObjectURL(url); return; }
        blobs.push(url);
        const tr = document.createElement('track');
        tr.kind = 'subtitles';
        tr.label = s.label || s.lang || `Субтитри ${i + 1}`;
        if (s.lang) tr.srclang = s.lang;
        tr.src = url;
        v.appendChild(tr);
        if (s.default) setTimeout(() => pickSub(String([...v.textTracks].indexOf(tr.track))), 0);
      } catch (e) {
        console.warn('[KZPlayer] субтитри не завантажились:', s.url, e);
      }
    });

    // ---------- меню ----------
    function setMenu(name, items, current, label, onPick) {
      const wrap = q(`[data-m="${name}"]`);
      wrap.classList.toggle('hidden', items.length < 2);
      wrap.querySelector('.kzp-txt').textContent = label;
      const ul = wrap.querySelector('ul');
      ul.innerHTML = items.map((it) => `<li><button type="button" data-v="${esc(it.value)}" class="${String(it.value) === String(current) ? 'on' : ''}">${esc(it.label)}</button></li>`).join('');
      ul.onclick = (e) => {
        const b = e.target.closest('button[data-v]');
        if (!b) return;
        onPick(b.dataset.v);
        wrap.classList.remove('open');
      };
    }

    function buildQuality() {
      if (engine.kind === 'hls') {
        const hls = engine.hls;
        const levels = hls.levels.map((l, i) => ({ i, h: l.height || 0, b: l.bitrate || 0 })).sort((a, b) => b.h - a.h || b.b - a.b);
        const name = (l) => (l.h ? `${l.h}p` : `${Math.round(l.b / 1000)} kbps`);
        const auto = hls.autoLevelEnabled;
        const cur = levels.find((l) => l.i === hls.currentLevel);
        const items = [{ label: auto && cur ? `Авто (${name(cur)})` : 'Авто', value: -1 }].concat(levels.map((l) => ({ label: name(l), value: l.i })));
        setMenu('quality', items, auto ? -1 : hls.currentLevel, auto ? 'Авто' : (cur ? name(cur) : 'Якість'), (val) => {
          hls.currentLevel = Number(val);
          buildQuality();
        });
      } else if (engine.kind === 'native' && src.qualities && src.qualities.length > 1) {
        const items = src.qualities.map((x, i) => ({ label: x.label || `#${i + 1}`, value: i }));
        setMenu('quality', items, qIndex, items[qIndex].label, (val) => {
          qIndex = Number(val);
          const t = v.currentTime, paused = v.paused;
          v.src = src.qualities[qIndex].url;
          v.addEventListener('loadedmetadata', () => { v.currentTime = t; if (!paused) v.play().catch(() => {}); }, { once: true });
          buildQuality();
        });
      }
    }

    // ---------- меню озвучок ----------
    function switchAudio(i) {
      if (i === audioIndex || !AUDIOS[i]) return;
      audioIndex = i;
      ls.set('kz_audio_lang', aRank(AUDIOS[i]));
      const t = v.currentTime, paused = v.paused;
      const restore = () => { try { v.currentTime = t; } catch { /* ignore */ } if (!paused) v.play().catch(() => {}); };
      if (engine.hls) { engine.hls.once(window.Hls.Events.MANIFEST_PARSED, restore); engine.hls.loadSource(AUDIOS[i].url); }
      else { v.src = AUDIOS[i].url; v.addEventListener('loadedmetadata', restore, { once: true }); }
      root.classList.add('loading');
      buildAudio();
    }

    function buildAudio() {
      // 1) окремі посилання-озвучки з джерела
      if (AUDIOS.length > 1) {
        const label = (a) => a.label || a.lang || 'Доріжка';
        setMenu('audio', AUDIOS.map((a, i) => ({ label: label(a), value: i })), audioIndex, label(AUDIOS[audioIndex]), (val) => switchAudio(Number(val)));
        return;
      }
      // 2) доріжки всередині HLS (EXT-X-MEDIA)
      const tracks = engine.hls && engine.hls.audioTracks;
      if (tracks && tracks.length > 1) {
        const hls = engine.hls;
        const name = (t, i) => (t && (t.name || t.lang)) || `Доріжка ${i + 1}`;
        if (!audioPicked || !(hls.audioTrack >= 0)) {
          audioPicked = true;
          let best = 0;
          tracks.forEach((t, i) => { if (aRank(t) < aRank(tracks[best])) best = i; });
          hls.audioTrack = best;
        }
        const cur = hls.audioTrack;
        setMenu('audio', tracks.map((t, i) => ({ label: name(t, i), value: i })), cur, name(tracks[cur], cur), (val) => { hls.audioTrack = Number(val); buildAudio(); });
        return;
      }
      setMenu('audio', [], 0, 'Озвучка', () => {});
    }

    function subTracks() { return [...v.textTracks].filter((t) => t.kind === 'subtitles' || t.kind === 'captions'); }
    function pickSub(val) {
      const idx = Number(val);
      [...v.textTracks].forEach((t, i) => { t.mode = i === idx ? 'showing' : 'disabled'; });
      buildSubs();
    }
    function buildSubs() {
      const all = [...v.textTracks];
      const list = subTracks();
      const showing = all.findIndex((t) => t.mode === 'showing');
      const items = [{ label: 'Вимкнено', value: -1 }].concat(list.map((t) => ({ label: t.label || t.language || `Доріжка ${all.indexOf(t) + 1}`, value: all.indexOf(t) })));
      setMenu('subs', items, showing, showing >= 0 ? 'CC ✓' : 'CC', pickSub);
    }
    on(v.textTracks, 'addtrack', buildSubs);
    on(v.textTracks, 'removetrack', buildSubs);

    setMenu('speed', SPEEDS.map((s) => ({ label: s === 1 ? 'Звичайна' : `${s}×`, value: s })), 1, '1×', (val) => {
      v.playbackRate = Number(val);
    });
    on(v, 'ratechange', () => {
      setMenu('speed', SPEEDS.map((s) => ({ label: s === 1 ? 'Звичайна' : `${s}×`, value: s })), v.playbackRate, `${v.playbackRate}×`, (val) => { v.playbackRate = Number(val); });
    });

    root.querySelectorAll('.kzp-menu > .kzp-txt').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const wrap = b.parentElement, open = !wrap.classList.contains('open');
        root.querySelectorAll('.kzp-menu.open').forEach((m) => m.classList.remove('open'));
        wrap.classList.toggle('open', open);
      });
    });
    on(document, 'click', (e) => { if (!e.target.closest('.kzp-menu')) root.querySelectorAll('.kzp-menu.open').forEach((m) => m.classList.remove('open')); });

    // ---------- відтворення ----------
    const toggle = () => { if (v.paused || v.ended) v.play().catch(() => {}); else v.pause(); };
    const seekBy = (s) => { if (isFinite(v.duration)) v.currentTime = Math.min(Math.max(0, v.currentTime + s), v.duration - 0.5); };

    on(v, 'loadedmetadata', () => {
      if (started) return;
      started = true;
      clearTimeout(loadTimer);
      if (opts.startAt > 5 && isFinite(v.duration) && opts.startAt < v.duration - 10) v.currentTime = opts.startAt;
      v.play().catch(() => root.classList.add('paused'));
      buildQuality();
      buildSubs();
      buildAudio();
    });
    on(v, 'play', () => { root.classList.remove('paused'); btn('play').innerHTML = ICON.pause; poke(); });
    on(v, 'pause', () => {
      root.classList.add('paused');
      btn('play').innerHTML = ICON.play;
      if (started && !v.ended && typeof opts.onPause === 'function') opts.onPause(v.currentTime, v.duration);
    });
    on(v, 'ended', () => { if (typeof opts.onEnded === 'function') opts.onEnded(v.duration); });
    on(v, 'waiting', () => root.classList.add('loading'));
    ['playing', 'canplay', 'seeked'].forEach((ev) => on(v, ev, () => root.classList.remove('loading')));
    root.classList.add('loading', 'paused');

    on(v, 'timeupdate', () => {
      const d = v.duration;
      if (!dragging && isFinite(d) && d > 0) {
        range.value = String(Math.round((v.currentTime / d) * 1000));
        fill.style.width = `${(v.currentTime / d) * 100}%`;
      }
      timeEl.textContent = `${fmt(v.currentTime)} / ${fmt(d)}`;
      if (started && typeof opts.onTime === 'function') opts.onTime(v.currentTime, d);
    });
    on(v, 'progress', () => {
      const d = v.duration, b = v.buffered;
      if (!isFinite(d) || !b.length) return;
      let end = 0;
      for (let i = 0; i < b.length; i++) if (b.start(i) <= v.currentTime + 1) end = Math.max(end, b.end(i));
      buf.style.width = `${(end / d) * 100}%`;
    });

    // перемотка
    range.addEventListener('input', () => {
      dragging = true;
      const d = v.duration;
      if (isFinite(d)) { fill.style.width = `${range.value / 10}%`; timeEl.textContent = `${fmt((range.value / 1000) * d)} / ${fmt(d)}`; }
    });
    range.addEventListener('change', () => {
      dragging = false;
      if (isFinite(v.duration)) v.currentTime = (range.value / 1000) * v.duration;
    });
    q('.kzp-seek').addEventListener('mousemove', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      const f = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
      tip.textContent = fmt(f * v.duration);
      tip.style.left = `${f * 100}%`;
    });

    // гучність
    const savedVol = ls.get('kz_volume', { v: 1, m: false });
    v.volume = savedVol.v; v.muted = savedVol.m; vol.value = String(savedVol.v);
    const syncVol = () => {
      btn('mute').innerHTML = v.muted || v.volume === 0 ? ICON.mute : ICON.vol;
      vol.value = String(v.muted ? 0 : v.volume);
      ls.set('kz_volume', { v: v.volume, m: v.muted });
    };
    syncVol();
    on(v, 'volumechange', syncVol);
    vol.addEventListener('input', () => { v.volume = Number(vol.value); v.muted = v.volume === 0; });

    // fullscreen
    const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
    function toggleFs() {
      if (fsEl()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else if (root.requestFullscreen) root.requestFullscreen().catch(() => {});
      else if (root.webkitRequestFullscreen) root.webkitRequestFullscreen();
      else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
    }
    const syncFs = () => { btn('fs').innerHTML = fsEl() === root ? ICON.fsExit : ICON.fs; };
    on(document, 'fullscreenchange', syncFs);
    on(document, 'webkitfullscreenchange', syncFs);

    // кнопки
    q('.kzp-row').addEventListener('click', (e) => {
      const b = e.target.closest('[data-k]');
      if (!b) return;
      const k = b.dataset.k;
      if (k === 'play') toggle();
      if (k === 'back') seekBy(-10);
      if (k === 'fwd') seekBy(10);
      if (k === 'mute') { v.muted = !v.muted; if (!v.muted && v.volume === 0) v.volume = 0.5; }
      if (k === 'fs') toggleFs();
    });
    q('.kzp-big').addEventListener('click', toggle);
    v.addEventListener('click', toggle);
    v.addEventListener('dblclick', toggleFs);

    // автоприховування контролів
    function poke() {
      root.classList.remove('idle');
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { if (!v.paused && !root.querySelector('.kzp-menu.open')) root.classList.add('idle'); }, 2500);
    }
    root.addEventListener('mousemove', poke);
    root.addEventListener('touchstart', poke, { passive: true });

    // клавіатура
    on(document, 'keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && (t.isContentEditable || (t.tagName === 'INPUT' && !t.classList.contains('kzp-range') && !t.classList.contains('kzp-vol')) || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      const k = e.key.toLowerCase();
      const map = {
        ' ': toggle, k: toggle,
        arrowleft: () => seekBy(-10), j: () => seekBy(-10),
        arrowright: () => seekBy(10), l: () => seekBy(10),
        arrowup: () => { v.muted = false; v.volume = Math.min(1, v.volume + 0.1); },
        arrowdown: () => { v.volume = Math.max(0, v.volume - 0.1); },
        f: toggleFs, m: () => { v.muted = !v.muted; },
      };
      if (!map[k]) return;
      e.preventDefault();
      map[k]();
      poke();
    });

    root.focus({ preventScroll: true });

    // ---------- unmount ----------
    function unmount() {
      if (destroyed) return;
      if (started && !errored && !v.ended && typeof opts.onPause === 'function') opts.onPause(v.currentTime, v.duration);
      destroyed = true;
      clearTimeout(loadTimer);
      clearTimeout(idleTimer);
      cleanup.forEach((f) => f());
      try { if (fsEl() === root) (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch { /* ignore */ }
      try { if (engine.hls) engine.hls.destroy(); } catch { /* ignore */ }
      try { if (engine.mp) { engine.mp.pause(); engine.mp.unload(); engine.mp.detachMediaElement(); engine.mp.destroy(); } } catch { /* ignore */ }
      try { v.pause(); v.removeAttribute('src'); v.load(); } catch { /* ignore */ }
      blobs.forEach((u) => URL.revokeObjectURL(u));
      container.innerHTML = '';
    }

    return { video: v, engine: engine.kind, unmount };
  }

  window.KZPlayer = { mount };
})();
