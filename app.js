(() => {
  'use strict';

  const CFG = Object.assign({ TMDB_API_KEY: '', LANGUAGE: 'uk-UA', REGION: 'UA' }, window.CONFIG || {});
  const API = 'https://api.themoviedb.org/3';
  const IMG = 'https://image.tmdb.org/t/p/';
  const LS = { key: 'kz_tmdb_key', fav: 'kz_favorites', prog: 'kz_progress' };

  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  const getKey = () => CFG.TMDB_API_KEY || store.get(LS.key, '');

  async function tmdb(path, params = {}) {
    const key = getKey();
    const url = new URL(API + path);
    url.searchParams.set('language', CFG.LANGUAGE);
    for (const [k, v] of Object.entries(params)) if (v !== '' && v != null) url.searchParams.set(k, v);
    const headers = { accept: 'application/json' };
    if (key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + key;
    else url.searchParams.set('api_key', key);
    const res = await fetch(url, { headers });
    if (res.status === 401) { const e = new Error('Невірний ключ TMDB'); e.auth = true; throw e; }
    if (!res.ok) throw new Error('TMDB ' + res.status);
    return res.json();
  }

  // ---------- State ----------
  const state = { tab: 'popular', query: '', genre: '', sort: 'popularity.desc', year: '', page: 1, totalPages: 1, loading: false, genres: {} };

  const el = {
    grid: $('#grid'), status: $('#status'), more: $('#more'), heading: $('#heading'), sentinel: $('#sentinel'),
    search: $('#search'), genre: $('#genre'), sort: $('#sort'), year: $('#year'), tabs: $('#tabs'),
    keyBox: $('#keyBox'), keyForm: $('#keyForm'), keyInput: $('#keyInput'),
    details: $('#details'), detailsBody: $('#detailsBody'), player: $('#player'), stage: $('#playerStage'),
  };

  const TAB_TITLES = {
    popular: 'Популярні фільми', trending: 'Тренди тижня', top_rated: 'Найкращі за рейтингом',
    now_playing: 'Зараз у кінотеатрах', upcoming: 'Скоро в прокаті', favorites: 'Обране', continue: 'Продовжити перегляд',
  };

  // ---------- Favorites / progress ----------
  const slim = (m) => ({ id: m.id, title: m.title, poster_path: m.poster_path, release_date: m.release_date, vote_average: m.vote_average, genre_ids: m.genre_ids || (m.genres || []).map((g) => g.id) });
  const favs = () => store.get(LS.fav, []);
  const isFav = (id) => favs().some((m) => m.id === id);
  function toggleFav(m) {
    const list = favs();
    const i = list.findIndex((x) => x.id === m.id);
    if (i >= 0) list.splice(i, 1); else list.unshift(slim(m));
    store.set(LS.fav, list);
    return i < 0;
  }
  const progress = () => store.get(LS.prog, {});
  function saveProgress(m, time, duration) {
    const p = progress();
    if (duration && time / duration > 0.95) delete p[m.id];
    else p[m.id] = { time, duration, at: Date.now(), movie: slim(m) };
    store.set(LS.prog, p);
  }

  // ---------- Rendering ----------
  const year = (d) => (d ? d.slice(0, 4) : '');
  const genreNames = (ids = []) => ids.map((id) => state.genres[id]).filter(Boolean).slice(0, 2).join(', ');

  function card(m) {
    const p = progress()[m.id];
    const pct = p && p.duration ? Math.min(100, (p.time / p.duration) * 100) : 0;
    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML = `
      ${m.vote_average ? `<span class="badge">★ ${m.vote_average.toFixed(1)}</span>` : ''}
      ${m.poster_path ? `<img loading="lazy" src="${IMG}w342${m.poster_path}" alt="">` : `<div class="noimg">${esc(m.title)}</div>`}
      ${pct ? `<div class="progress"><i style="width:${pct}%"></i></div>` : ''}
      <div class="meta"><div class="title">${esc(m.title)}</div><div class="sub">${esc([year(m.release_date), genreNames(m.genre_ids)].filter(Boolean).join(' · '))}</div></div>`;
    div.addEventListener('click', () => openMovie(m.id));
    return div;
  }

  function renderList(list, append) {
    if (!append) el.grid.innerHTML = '';
    const frag = document.createDocumentFragment();
    list.forEach((m) => frag.appendChild(card(m)));
    el.grid.appendChild(frag);
  }

  function currentRequest() {
    const filtered = state.genre || state.year || state.sort !== 'popularity.desc';
    if (state.query) return { path: '/search/movie', params: { query: state.query, primary_release_year: state.year, region: CFG.REGION }, title: `Пошук: «${state.query}»` };
    if (filtered) {
      return {
        path: '/discover/movie',
        params: { with_genres: state.genre, sort_by: state.sort, primary_release_year: state.year, 'vote_count.gte': state.sort === 'vote_average.desc' ? 300 : '', include_adult: false },
        title: [state.genre ? state.genres[state.genre] : 'Фільми', state.year].filter(Boolean).join(' · '),
      };
    }
    const map = { popular: '/movie/popular', trending: '/trending/movie/week', top_rated: '/movie/top_rated', now_playing: '/movie/now_playing', upcoming: '/movie/upcoming' };
    return { path: map[state.tab], params: { region: CFG.REGION }, title: TAB_TITLES[state.tab] };
  }

  async function load(reset) {
    if (!getKey()) { showKeyBox(); return; }
    if (state.loading) return;
    if (reset) { state.page = 1; state.totalPages = 1; window.scrollTo({ top: 0 }); }
    if (state.page > state.totalPages) return;

    if (!state.query && (state.tab === 'favorites' || state.tab === 'continue')) {
      const list = state.tab === 'favorites' ? favs() : Object.values(progress()).sort((a, b) => b.at - a.at).map((p) => p.movie);
      el.heading.textContent = TAB_TITLES[state.tab];
      renderList(list, false);
      el.status.textContent = list.length ? '' : (state.tab === 'favorites' ? 'Тут поки порожньо. Додавай фільми зірочкою.' : 'Ти ще нічого не почав дивитись.');
      state.totalPages = 0;
      updateMore();
      return;
    }

    const req = currentRequest();
    state.loading = true;
    el.status.textContent = 'Завантаження…';
    try {
      const data = await tmdb(req.path, Object.assign({ page: state.page }, req.params));
      el.heading.textContent = req.title;
      state.totalPages = Math.min(data.total_pages || 1, 500);
      renderList(data.results || [], state.page > 1);
      state.page += 1;
      el.status.textContent = !data.results?.length && state.page === 2 ? 'Нічого не знайдено.' : (state.page > state.totalPages ? 'Це все.' : '');
    } catch (e) {
      if (e.auth) { store.set(LS.key, ''); showKeyBox('Ключ не підійшов, перевір його.'); }
      el.status.textContent = e.message;
    } finally {
      state.loading = false;
      updateMore();
    }
  }

  function updateMore() {
    const listTab = !state.query && (state.tab === 'favorites' || state.tab === 'continue');
    el.more.classList.toggle('hidden', listTab || !getKey() || state.page <= 1 || state.page > state.totalPages);
  }

  function showKeyBox(msg) {
    el.keyBox.classList.remove('hidden');
    el.heading.textContent = '';
    el.grid.innerHTML = '';
    el.status.textContent = msg || '';
  }

  // ---------- Details ----------
  let current = null;

  async function openMovie(id) {
    if (location.hash !== '#movie/' + id) history.pushState(null, '', '#movie/' + id);
    el.details.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    el.detailsBody.innerHTML = '<div class="status">Завантаження…</div>';
    try {
      const m = await tmdb('/movie/' + id, { append_to_response: 'videos,credits,watch/providers,similar,external_ids', include_video_language: 'uk,en,null' });
      current = m;
      renderDetails(m);
    } catch (e) {
      el.detailsBody.innerHTML = `<button class="close" data-close="details">✕</button><div class="status">${esc(e.message)}</div>`;
    }
  }

  function trailerOf(m) {
    const v = (m.videos?.results || []).filter((x) => x.site === 'YouTube');
    return v.find((x) => x.type === 'Trailer' && x.iso_639_1 === 'uk') || v.find((x) => x.type === 'Trailer') || v.find((x) => x.type === 'Teaser') || v[0] || null;
  }

  function renderDetails(m) {
    const hours = m.runtime ? `${Math.floor(m.runtime / 60)} год ${m.runtime % 60} хв` : '';
    const cast = (m.credits?.cast || []).slice(0, 12);
    const director = (m.credits?.crew || []).filter((c) => c.job === 'Director').map((c) => c.name).join(', ');
    const p = progress()[m.id];
    const trailer = trailerOf(m);
    const fav = isFav(m.id);

    el.detailsBody.innerHTML = `
      <button class="close" data-close="details" aria-label="Закрити">✕</button>
      <div class="hero" style="${m.backdrop_path ? `background-image:url(${IMG}w1280${m.backdrop_path})` : ''}"></div>
      <div class="info">
        ${m.poster_path ? `<img class="poster" src="${IMG}w342${m.poster_path}" alt="">` : ''}
        <div>
          <h2>${esc(m.title)}</h2>
          ${m.original_title && m.original_title !== m.title ? `<div class="orig">${esc(m.original_title)}</div>` : ''}
          <div class="facts">
            ${m.vote_average ? `<span class="rating">★ ${m.vote_average.toFixed(1)}</span><span>${m.vote_count} голосів</span>` : ''}
            ${m.release_date ? `<span>${esc(m.release_date.split('-').reverse().join('.'))}</span>` : ''}
            ${hours ? `<span>${hours}</span>` : ''}
            ${director ? `<span>Режисер: ${esc(director)}</span>` : ''}
          </div>
          <div class="chips">${(m.genres || []).map((g) => `<span class="chip">${esc(g.name)}</span>`).join('')}</div>
          ${m.tagline ? `<p class="tagline">${esc(m.tagline)}</p>` : ''}
          <p>${esc(m.overview || 'Опису українською поки немає.')}</p>
          <div class="actions">
            <button class="btn primary" data-act="watch">▶ ${p ? 'Продовжити' : 'Дивитись'}</button>
            ${trailer ? `<button class="btn" data-act="trailer">Трейлер</button>` : ''}
            <button class="btn" data-act="fav">${fav ? '★ В обраному' : '☆ В обране'}</button>
            ${m.imdb_id ? `<a class="btn" href="https://www.imdb.com/title/${esc(m.imdb_id)}/" target="_blank" rel="noopener">IMDb</a>` : ''}
          </div>
        </div>
      </div>
      ${cast.length ? `<div class="section"><h3>Актори</h3><div class="cast">${cast.map((c) => `
        <div class="person">${c.profile_path ? `<img loading="lazy" src="${IMG}w185${c.profile_path}" alt="">` : '<div class="noimg"></div>'}
        <div>${esc(c.name)}</div><div class="role">${esc(c.character)}</div></div>`).join('')}</div></div>` : ''}
      ${m.similar?.results?.length ? `<div class="section"><h3>Схожі</h3><div class="similar" id="similar"></div></div>` : ''}`;

    const sim = $('#similar', el.detailsBody);
    if (sim) m.similar.results.slice(0, 12).forEach((s) => sim.appendChild(card(s)));
  }

  function closeDetails() {
    el.details.classList.add('hidden');
    document.body.style.overflow = '';
    current = null;
    if (location.hash.startsWith('#movie/')) history.pushState(null, '', location.pathname + location.search);
  }

  // ---------- Player ----------
  let kzp = null;      // поточний KZPlayer
  let watchToken = 0;  // щоб старі async-відповіді не перемальовували плеєр

  function unmountPlayer() {
    if (!kzp) return;
    try { kzp.unmount(); } catch (e) { console.error(e); }
    kzp = null;
  }

  async function watch(m) {
    const token = ++watchToken;
    unmountPlayer();
    el.player.classList.remove('hidden');
    el.stage.innerHTML = '<div class="status">Шукаю джерело…</div>';
    let res = null;
    try {
      if (typeof window.resolveStream === 'function') res = await window.resolveStream(m);
    } catch (e) {
      console.error('resolveStream error', e);
    }
    if (token !== watchToken) return;
    // resolveStream може повернути один кандидат або масив. Спершу всі video, потім iframe.
    const list = (Array.isArray(res) ? res : [res])
      .filter((s) => s && s.url && (s.type === 'video' || s.type === 'iframe'))
      .sort((a, b) => (a.type === 'video' ? 0 : 1) - (b.type === 'video' ? 0 : 1));
    playCandidate(m, list, 0, token);
  }

  function playCandidate(m, list, i, token) {
    if (token !== watchToken) return;
    unmountPlayer();
    const src = list[i];
    if (!src) { renderNoSource(m); return; }

    if (src.type === 'video') {
      if (!window.KZPlayer) { console.warn('[player] KZPlayer не завантажився'); playCandidate(m, list, i + 1, token); return; }
      const saved = progress()[m.id];
      let last = 0;
      kzp = window.KZPlayer.mount(el.stage, src, m, {
        startAt: saved ? saved.time : 0,
        poster: m.backdrop_path ? `${IMG}w1280${m.backdrop_path}` : '',
        onTime: (t, d) => { if (Math.abs(t - last) > 5) { last = t; saveProgress(m, t, d); } },
        onPause: (t, d) => saveProgress(m, t, d),
        onEnded: (d) => saveProgress(m, d, d),
        onError: (reason) => {
          console.warn(`[player] ${src.source || 'джерело'} не відтворилось:`, reason, src.url);
          if (window.resolveStream && typeof window.resolveStream.invalidate === 'function') window.resolveStream.invalidate(m, src);
          playCandidate(m, list, i + 1, token);
        },
      });
      return;
    }

    el.stage.innerHTML = `<iframe src="${esc(src.url)}" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
    saveProgress(m, 1, 0);
  }

  function renderNoSource(m) {
    const wp = m['watch/providers']?.results?.[CFG.REGION] || null;
    const groups = wp ? [['flatrate', 'Підписка'], ['free', 'Безкоштовно'], ['ads', 'З рекламою'], ['rent', 'Оренда'], ['buy', 'Купівля']]
      .filter(([k]) => wp[k]?.length) : [];
    const trailer = trailerOf(m);
    el.stage.innerHTML = `
      <div class="nosource">
        <h3>${esc(m.title)}</h3>
        <p class="muted">Джерело відео не підключене. Додай його у функцію <code>resolveStream</code> у файлі <code>player.js</code>.</p>
        ${groups.length ? `<h3>Де подивитись легально</h3>${groups.map(([k, label]) => `
          <div class="providers">${wp[k].map((p) => `<a class="provider" href="${esc(wp.link)}" target="_blank" rel="noopener">
            <img src="${IMG}w92${p.logo_path}" alt=""><span>${esc(p.provider_name)}<br><small>${label}</small></span></a>`).join('')}</div>`).join('')}` : ''}
        ${trailer ? `<h3>Трейлер</h3><iframe src="https://www.youtube-nocookie.com/embed/${esc(trailer.key)}" allow="autoplay; fullscreen" allowfullscreen></iframe>` : ''}
      </div>`;
  }

  function playTrailer(m) {
    const t = trailerOf(m);
    if (!t) return;
    watchToken++;
    unmountPlayer();
    el.player.classList.remove('hidden');
    el.stage.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${esc(t.key)}?autoplay=1" allow="autoplay; fullscreen" allowfullscreen></iframe>`;
  }

  function closePlayer() {
    watchToken++;
    unmountPlayer();
    el.player.classList.add('hidden');
    el.stage.innerHTML = '';
    if (current) renderDetails(current);
  }

  // ---------- Events ----------
  el.detailsBody.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || !current) return;
    if (b.dataset.act === 'watch') watch(current);
    if (b.dataset.act === 'trailer') playTrailer(current);
    if (b.dataset.act === 'fav') { const on = toggleFav(current); b.textContent = on ? '★ В обраному' : '☆ В обране'; }
  });

  document.addEventListener('click', (e) => {
    const c = e.target.closest('[data-close]');
    if (c) { c.dataset.close === 'player' ? closePlayer() : closeDetails(); return; }
    if (e.target === el.player) closePlayer();
    else if (e.target === el.details) closeDetails();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!el.player.classList.contains('hidden')) closePlayer();
    else if (!el.details.classList.contains('hidden')) closeDetails();
  });

  window.addEventListener('popstate', () => {
    const m = location.hash.match(/^#movie\/(\d+)/);
    if (m) openMovie(+m[1]); else if (!el.details.classList.contains('hidden')) { el.details.classList.add('hidden'); document.body.style.overflow = ''; current = null; }
  });

  el.tabs.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    [...el.tabs.children].forEach((x) => x.classList.toggle('active', x === b));
    state.tab = b.dataset.tab;
    state.query = ''; el.search.value = '';
    state.genre = ''; el.genre.value = '';
    state.year = ''; el.year.value = '';
    state.sort = 'popularity.desc'; el.sort.value = state.sort;
    load(true);
  });

  let t;
  el.search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { state.query = el.search.value.trim(); load(true); }, 350); });
  el.genre.addEventListener('change', () => { state.genre = el.genre.value; load(true); });
  el.sort.addEventListener('change', () => { state.sort = el.sort.value; load(true); });
  el.year.addEventListener('change', () => { state.year = /^\d{4}$/.test(el.year.value) ? el.year.value : ''; load(true); });
  $('#brand').addEventListener('click', () => el.tabs.querySelector('[data-tab="popular"]').click());

  el.keyForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const k = el.keyInput.value.trim();
    if (!k) return;
    store.set(LS.key, k);
    el.keyBox.classList.add('hidden');
    init();
  });

  el.more.addEventListener('click', () => load(false));

  new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && state.page > 1 && !state.loading) load(false);
  }, { rootMargin: '600px' }).observe(el.sentinel);

  // ---------- Init ----------
  async function init() {
    if (!getKey()) { showKeyBox(); return; }
    try {
      const g = await tmdb('/genre/movie/list');
      el.genre.innerHTML = '<option value="">Усі жанри</option>';
      g.genres.forEach((x) => { state.genres[x.id] = x.name; el.genre.insertAdjacentHTML('beforeend', `<option value="${x.id}">${esc(x.name)}</option>`); });
    } catch (e) {
      if (e.auth) { store.set(LS.key, ''); showKeyBox('Ключ не підійшов, перевір його.'); return; }
    }
    await load(true);
    const m = location.hash.match(/^#movie\/(\d+)/);
    if (m) openMovie(+m[1]);
  }

  init();
})();
