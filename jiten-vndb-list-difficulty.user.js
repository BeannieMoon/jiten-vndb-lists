// ==UserScript==
// @name         Jiten Difficulty for VNDB Lists
// @namespace    https://github.com/BeannieMoon/jiten-vndb-lists
// @author       BeannieMoon
// @license      MIT
// @homepageURL  https://github.com/BeannieMoon/jiten-vndb-lists
// @supportURL   https://github.com/BeannieMoon/jiten-vndb-lists/issues
// @downloadURL  https://raw.githubusercontent.com/BeannieMoon/jiten-vndb-lists/main/jiten-vndb-list-difficulty.user.js
// @updateURL    https://raw.githubusercontent.com/BeannieMoon/jiten-vndb-lists/main/jiten-vndb-list-difficulty.user.js
// @version      3.3.0
// @description  Adds a Jiten difficulty column to VNDB lists (your ulist/wishlist/votes, the /v browse list, staff/VA pages) and shows it on producer pages, marks what isn't on Jiten (NA), and sorts by difficulty.
// @match        https://vndb.org/v
// @match        https://vndb.org/v?*
// @match        https://vndb.org/u*
// @match        https://vndb.org/p*
// @match        https://vndb.org/s*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @sandbox      JavaScript
// @connect      api.jiten.moe
// ==/UserScript==

(function () {
  'use strict';

  const JITEN = 'https://jiten.moe';
  const JITEN_API = 'https://api.jiten.moe/api';
  const CLIENT_NAME = 'Jiten VNDB List Difficulty/3.3.0';
  // Measured: 4-5 parallel requests is the fastest; more makes Jiten slower, and bursts get 429s.
  const CONCURRENCY = 4;
  const CATALOGUE_TTL = 24 * 60 * 60 * 1000;
  const REQUEST_TTL = 7 * 24 * 60 * 60 * 1000;
  const CATALOGUE_TYPES = [7, 6]; // visual novels, video games
  // Load at most this many pages of a list to sort it whole (60 x 50 = 3,000 titles).
  // The /v browse list has 1,000+ pages, so there sorting stays per page.
  const MAX_LIST_PAGES = 60;
  const DIFF_NAMES = ['Beginner', 'Easy', 'Average', 'Hard', 'Expert', 'Insane'];
  // VNDB has 23 skins, from black to white to mid-tone colors. The colors are picked to suit
  // the skin (see pickColors): light text on dark skins, dark text on light skins, and small
  // colored chips on mid-tone skins where neither kind of text would be readable.
  const LIGHT_TEXT = { diff: ['#66bb6a', '#9ccc65', '#e6c84a', '#ffa726', '#ff7043', '#ef5350'], req: '#c9a88f' };
  const DARK_TEXT = { diff: ['#1b5e20', '#33691e', '#6d5200', '#a33c00', '#a52a0a', '#9b1111'], req: '#6b4f3a' };
  let colors = { mode: 'text', ...LIGHT_TEXT };

  // The color actually behind an element: its background layers composited down to the
  // first opaque one (VNDB skins use semi-transparent boxes over a background image).
  function backgroundOf(el) {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const m = getComputedStyle(e).backgroundColor.match(/[\d.]+/g);
      if (!m) continue;
      const [r, g, b, a = 1] = m.map(Number);
      if (a === 0) continue;
      layers.push([r, g, b, a]);
      if (a >= 1) break;
    }
    let c = [255, 255, 255];
    for (const [r, g, b, a] of layers.reverse()) c = [r, g, b].map((v, i) => v * a + c[i] * (1 - a));
    return c;
  }

  const luminance = (rgb) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  };
  const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const contrast = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };

  let colorsPicked = false;
  function pickColors(el) {
    if (colorsPicked || !el) return;
    colorsPicked = true;
    // Table rows alternate between two stripes, which on some skins differ a lot: check both.
    const tr = el.closest('tr');
    const bgs = [backgroundOf(el), ...(tr?.nextElementSibling ? [backgroundOf(tr.nextElementSibling)] : [])];
    const worst = (set) => Math.min(...[...set.diff, set.req].flatMap((c) => bgs.map((bg) => contrast(hexRgb(c), bg))));
    // 3.5 rather than 3, to leave some margin over the background image behind the boxes.
    if (worst(LIGHT_TEXT) >= 3.5) colors = { mode: 'text', ...LIGHT_TEXT };
    else if (worst(DARK_TEXT) >= 3.5) colors = { mode: 'text', ...DARK_TEXT };
    else colors = { mode: 'chip', ...LIGHT_TEXT };
  }

  const GM4 = typeof GM === 'object' && GM ? GM : null;
  const gmXhr = typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest
    : GM4?.xmlHttpRequest ? (d) => GM4.xmlHttpRequest(d) : null;
  const getVal = async (k) => (typeof GM_getValue === 'function' ? GM_getValue(k) : GM4?.getValue(k));
  const setVal = async (k, v) => (typeof GM_setValue === 'function' ? GM_setValue(k, v) : GM4?.setValue(k, v));
  const delVal = async (k) => (typeof GM_deleteValue === 'function' ? GM_deleteValue(k) : GM4?.deleteValue(k));
  const listVals = async () => (typeof GM_listValues === 'function' ? GM_listValues() : (await GM4?.listValues()) || []);
  const menu = typeof GM_registerMenuCommand === 'function' ? GM_registerMenuCommand
    : GM4?.registerMenuCommand ? (n, f) => GM4.registerMenuCommand(n, f) : () => {};

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmt = (n) => Number(n).toLocaleString('en-US');

  // ---------------------------------------------------------------------------
  // HTTP: a shared pool of CONCURRENCY slots; a 429 pauses every request.
  // ---------------------------------------------------------------------------

  function gmGet(url, headers) {
    return new Promise((resolve, reject) => {
      gmXhr({
        method: 'GET', url, headers, timeout: 20000, anonymous: true,
        onload: (r) => resolve({
          status: r.status, text: r.responseText,
          retryAfter: /^retry-after:\s*(.+)$/im.exec(r.responseHeaders || '')?.[1]?.trim(),
        }),
        onerror: () => reject(new Error("couldn't reach Jiten")),
        onabort: () => reject(new Error('request aborted')),
        ontimeout: () => reject(new Error('Jiten took too long to answer')),
      });
    });
  }

  let active = 0;
  const waiting = [];
  let pausedUntil = 0;
  function acquire() {
    if (active < CONCURRENCY) { active++; return Promise.resolve(); }
    return new Promise((r) => waiting.push(r));
  }
  function release() {
    const next = waiting.shift();
    if (next) next(); else active--;
  }

  function retryAfterMs(value) {
    const secs = Number(value);
    if (value && !Number.isNaN(secs)) return secs * 1000;
    const date = Date.parse(value || '');
    return Number.isNaN(date) ? 3000 : Math.max(0, date - Date.now());
  }

  async function jitenGet(path, extraHeaders = {}) {
    const headers = { Accept: 'application/json', 'X-Client-Name': CLIENT_NAME, ...extraHeaders };
    for (let attempt = 0; ; attempt++) {
      await acquire();
      let r;
      try {
        const wait = pausedUntil - Date.now();
        if (wait > 0) await sleep(wait);
        r = await gmGet(JITEN_API + path, headers);
      } finally {
        release();
      }
      if (r.status !== 429 || attempt >= 5) return r;
      pausedUntil = Math.max(pausedUntil, Date.now() + Math.min(retryAfterMs(r.retryAfter), 15000));
    }
  }

  async function getJson(path, extraHeaders) {
    const r = await jitenGet(path, extraHeaders);
    if (r.status < 200 || r.status >= 300) throw new Error(`Jiten returned an error (${r.status})`);
    return JSON.parse(r.text);
  }

  // ---------------------------------------------------------------------------
  // Catalogue: every Jiten VN/game deck with a VNDB link, fetched in pages of 50.
  // onPage runs after each page, so titles show up while the rest is still loading.
  // ---------------------------------------------------------------------------

  async function buildCatalogue(onPage) {
    const map = {};
    const add = (decks) => {
      for (const d of decks || []) {
        for (const l of d.links || []) {
          const m = l.linkType === 2 && /vndb\.org\/(v\d+)/i.exec(l.url || '');
          if (!m) continue;
          const vid = m[1].toLowerCase();
          if (!map[vid] || d.mediaType === 7) map[vid] = [d.deckId, d.difficultyRaw, d.characterCount];
        }
      }
    };
    const page = (type, offset) => getJson(`/media-deck/get-media-decks?mediaType=${type}&offset=${offset}`);
    const firsts = await Promise.all(CATALOGUE_TYPES.map((t) => page(t, 0)));
    const rest = [];
    firsts.forEach((p, i) => {
      add(p.data);
      const size = p.pageSize || 50;
      for (let off = size; off < (p.totalItems || 0); off += size) rest.push([CATALOGUE_TYPES[i], off]);
    });
    let done = firsts.length;
    const total = firsts.length + rest.length;
    onPage(map, done, total);
    await Promise.all(rest.map(async ([t, off]) => {
      add((await page(t, off)).data);
      onPage(map, ++done, total);
    }));
    return map;
  }

  // ---------------------------------------------------------------------------
  // "Already requested?" check for VNs not in the catalogue (needs an API key).
  // ---------------------------------------------------------------------------

  async function requestStatus(vid, title, key) {
    const cacheKey = 'req:' + vid;
    const cached = await getVal(cacheKey);
    if (cached && Date.now() - cached.ts < REQUEST_TTL) return cached;
    const q = new URLSearchParams({ title, externalUrl: `https://vndb.org/${vid}`, mediaType: '7' });
    const r = await jitenGet(`/requests/duplicate-check?${q}`, { 'X-Api-Key': key });
    if (r.status === 401 || r.status === 403) return { state: 'missing-unchecked', keyRejected: true };
    if (r.status !== 200) throw new Error(`Jiten returned an error (${r.status})`);
    const body = JSON.parse(r.text);
    const open = (body.existingRequests || []).find((x) => [1, 2].includes(x.status));
    const exact = (body.existingDecks || []).find((d) => d.isExactMatch && [6, 7].includes(d.mediaType));
    const result = open ? { state: 'requested', requestId: open.id }
      : exact ? { state: 'unlinked', deckId: exact.deckId }
        : { state: 'missing' };
    result.ts = Date.now();
    await setVal(cacheKey, result);
    return result;
  }

  const requestsInFlight = new Map();
  function requestShared(vid, title, key) {
    if (!requestsInFlight.has(vid)) requestsInFlight.set(vid, requestStatus(vid, title, key));
    return requestsInFlight.get(vid);
  }

  // ---------------------------------------------------------------------------
  // Badges: plain colored text, in its own column where the page is a list.
  // ---------------------------------------------------------------------------

  const pct = (raw) => Math.round((Math.max(0, Math.min(5, raw)) / 5) * 100);

  function badgeFor(result, inline) {
    const b = document.createElement('a');
    b.target = '_blank';
    b.rel = 'noopener';
    b.className = 'jvl-badge';
    b.style.cssText = 'text-decoration:none;white-space:nowrap;font-size:0.92em;' + (inline ? 'margin-left:6px;' : '');
    let diff = null;
    const set = (color, text, title, href, { bold = false, dim = false } = {}) => {
      if (color && colors.mode === 'chip') {
        b.style.cssText += `background:${color};color:#111;padding:0 5px;border-radius:4px;`;
      } else {
        b.style.color = color || 'inherit';
      }
      if (bold) b.style.fontWeight = '700';
      if (dim) b.style.opacity = '0.45';
      b.textContent = text;
      if (title) b.title = title;
      if (href) b.href = href; else b.removeAttribute('target');
    };
    switch (result.state) {
      case 'found': {
        const raw = result.difficultyRaw;
        const href = `${JITEN}/decks/media/${result.deckId}/detail`;
        const note = result.unlinked ? '\nFound by its title: Jiten doesn\'t link this deck to this VNDB entry.' : '';
        const mark = result.unlinked ? '*' : '';
        if (raw != null && raw >= 0) {
          const band = Math.min(Math.max(Math.floor(raw), 0), 5);
          diff = raw;
          set(colors.diff[band], `${pct(raw)}%${mark}`, `Jiten difficulty ${raw.toFixed(1)}/5 · ${DIFF_NAMES[band]}`
            + (result.characterCount ? ` · ${fmt(result.characterCount)} characters` : '') + note, href, { bold: true });
        } else {
          set(null, `on Jiten${mark}`, 'On Jiten, no difficulty rating yet' + note, href, { dim: true });
        }
        break;
      }
      case 'requested':
        set(colors.req, 'req.', 'Not on Jiten yet, but already requested',
          result.requestId ? `${JITEN}/requests/${result.requestId}` : `${JITEN}/requests`);
        break;
      case 'missing':
        set(null, 'NA', 'Not on Jiten, and no open request (click to request it)', `${JITEN}/requests/new`, { dim: true });
        break;
      case 'missing-unchecked':
        set(null, 'NA', 'Not on Jiten' + (result.keyRejected ? '. Your API key was rejected, so requests weren\'t checked.'
          : '. Set a Jiten API key (Tampermonkey menu) to also see which ones are already requested.'), `${JITEN}/requests/new`, { dim: true });
        break;
      default:
        set(null, '?', result.message || 'lookup failed', null, { dim: true });
    }
    return { node: b, diff };
  }

  // ---------------------------------------------------------------------------
  // Sorting: the floating button and the column header both toggle it.
  // ---------------------------------------------------------------------------

  // complete: the catalogue is whole (cached or fully loaded); before that it may be partial.
  const state = { catalogue: {}, byDeck: new Map(), complete: false, error: null, catDone: 0, catTotal: 0, reqDone: 0, reqTotal: 0, key: '' };
  const items = [];
  const sortableTables = new Set();
  const headerCells = new Map(); // table -> header cell
  let sortDir = null; // null | 'desc' | 'asc'
  let button = null;

  function sortTable(table, dir) {
    const body = table.tBodies[0] || table;
    const rows = [...body.rows];
    // Rows that aren't VN rows keep their place at the top.
    const pinned = rows.filter((r) => !r.dataset.jvlRow);
    const vnRows = rows.filter((r) => r.dataset.jvlRow);
    const val = (r) => (r.dataset.jvlDiff !== undefined ? parseFloat(r.dataset.jvlDiff) : null);
    vnRows.sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return dir === 'desc' ? bv - av : av - bv;
    });
    for (const r of [...pinned, ...vnRows]) body.appendChild(r);
  }

  // Multi-page lists: VNDB shows 50 per page (200 at most), so sorting one page isn't
  // enough for a 1,300-title list. The first sort click loads the other pages of the same
  // list (same filters and columns) into this table, then sorts everything together.
  const pages = { total: 1, current: 1, template: null, loading: false, loaded: false, done: 0, failed: 0 };
  let vndbPausedUntil = 0; // VNDB answers bursts with 429 and no Retry-After

  function readPagination() {
    for (const a of document.querySelectorAll('.browsetabs a[href]')) {
      const u = new URL(a.getAttribute('href'), location.href);
      const p = parseInt(u.searchParams.get('p'), 10);
      if (!p) continue;
      pages.template = u;
      pages.total = Math.max(pages.total, p);
    }
    pages.current = parseInt(new URL(location.href).searchParams.get('p'), 10) || 1;
    pages.total = Math.max(pages.total, pages.current);
  }

  const canLoadAll = () => !pages.loaded && pages.template && pages.total > 1
    && pages.total <= MAX_LIST_PAGES && sortableTables.size === 1;

  // One page of the list: its VN rows, plus the data VNDB needs to build the vote, label
  // and date editors in those rows (page-level JSON, keyed by "widget<N>" element ids).
  async function fetchPage(p) {
    const u = new URL(pages.template);
    u.searchParams.set('p', p);
    for (let attempt = 0; ; attempt++) {
      const wait = vndbPausedUntil - Date.now();
      if (wait > 0) await sleep(wait);
      // no-store: VNDB's 429 page is marked cacheable for months.
      const r = await fetch(u, { credentials: 'same-origin', cache: 'no-store' });
      if (r.ok) {
        const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
        let widgetData = {};
        try { widgetData = JSON.parse(doc.getElementById('pagevars')?.textContent || '{}').widget || {}; } catch { /* none */ }
        const byId = {};
        for (const [name, entries] of Object.entries(widgetData)) for (const [id, data] of entries) byId[id] = { name, data };
        const rows = [...doc.querySelectorAll('table.stripe tr')]
          .filter((tr) => tr.querySelector('td.tc_title a[href^="/v"], td.tc1 a[href^="/v"]'))
          .map((tr) => document.importNode(tr, true));
        const widgets = [];
        for (const tr of rows) {
          for (const el of tr.querySelectorAll('[id^="widget"]')) {
            const w = byId[el.id.slice(6)];
            el.id = `jvl-p${p}-${el.id}`; // the same ids repeat on every page
            if (w) widgets.push({ el, ...w });
          }
        }
        return { rows, widgets };
      }
      if (attempt >= 6) throw new Error(`VNDB page ${p}: ${r.status}`);
      vndbPausedUntil = Math.max(vndbPausedUntil, Date.now() + (r.status === 429 ? 4000 : 1500) * (attempt + 1));
    }
  }

  // Rows copied from other pages arrive as plain HTML. VNDB turns the vote, label and date
  // cells into editors with its own components (Mithril), set up once when the page loads,
  // so here the same components are taken from a row VNDB already set up and attached to the
  // copied rows. They're attached as rows scroll near the screen, under one shared root,
  // so a 2,000-title list stays fast. If anything about this fails, the copied rows simply
  // keep VNDB's plain-text version of those cells.
  const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const liveWidgets = new Set();
  let widgetsBroken = false;
  let widgetRoot = null;

  function attachWidgets(list) {
    try {
      const m = pageWin.m;
      const widgetPages = pageWin.pageVars?.widget;
      if (typeof m !== 'function' || typeof m.mount !== 'function' || !widgetPages) return;
      const components = {};
      for (const [name, entries] of Object.entries(widgetPages)) {
        for (const [id] of entries) {
          const vnodes = pageWin.document.getElementById('widget' + id)?.vnodes;
          const tag = (Array.isArray(vnodes) ? vnodes[0] : vnodes)?.instance?.tag;
          if (tag) { components[name] = tag; break; }
        }
      }
      const byRow = new Map();
      for (const w of list) {
        const component = components[w.name];
        const tr = w.el.closest('tr');
        if (!component || !tr) continue;
        if (!byRow.has(tr)) byRow.set(tr, []);
        byRow.get(tr).push({ el: w.el, component, attrs: { data: w.data, oldContents: Array.from(w.el.childNodes) } });
      }
      if (!byRow.size) return;
      if (!widgetRoot) {
        widgetRoot = document.createElement('div');
        widgetRoot.hidden = true;
        document.body.append(widgetRoot);
        m.mount(widgetRoot, {
          view: () => {
            if (widgetsBroken) return null;
            try {
              for (const w of liveWidgets) m.render(w.el, m(w.component, w.attrs), m.redraw);
            } catch (e) {
              widgetsBroken = true; // never let this break VNDB's own redraws
              console.warn('[Jiten VNDB] could not set up editors on loaded rows:', e);
            }
            return null;
          },
        });
      }
      const io = new IntersectionObserver((entries) => {
        let added = false;
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          io.unobserve(e.target);
          for (const w of byRow.get(e.target) || []) liveWidgets.add(w);
          added = true;
        }
        if (added) m.redraw();
      }, { rootMargin: '800px 0px' });
      for (const tr of byRow.keys()) io.observe(tr);
    } catch (e) {
      console.warn('[Jiten VNDB] could not set up editors on loaded rows:', e);
    }
  }

  async function loadAllPages() {
    pages.loading = true;
    updateButton();
    const todo = [];
    for (let p = 1; p <= pages.total; p++) if (p !== pages.current) todo.push(p);
    const got = {};
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const p = todo[next++];
        try { got[p] = await fetchPage(p); } catch { pages.failed++; }
        pages.done++;
        updateButton();
      }
    };
    await Promise.all([worker(), worker()]); // gentle on VNDB
    const table = [...sortableTables][0];
    const body = table.tBodies[0] || table;
    const firstOwn = body.querySelector('tr[data-jvl-row]');
    const widgets = [];
    for (const p of todo) {
      if (!got[p]) continue;
      for (const tr of got[p].rows) {
        if (p < pages.current && firstOwn) firstOwn.before(tr); else body.append(tr);
      }
      widgets.push(...got[p].widgets);
    }
    for (const nav of document.querySelectorAll('.browsetabs')) {
      if (nav.querySelector('a[href*="p="]')) nav.style.display = 'none';
    }
    pages.loading = false;
    pages.loaded = true;
    scan(); // adds the Jiten cell to the new rows
    attachWidgets(widgets);
  }

  async function applySort(dir) {
    if (!sortableTables.size || pages.loading) return;
    if (canLoadAll()) await loadAllPages();
    if (!sortDir) for (const t of sortableTables) releaseVndbSort(t);
    sortDir = dir;
    for (const t of sortableTables) sortTable(t, sortDir);
    updateButton();
  }

  const toggleSort = () => applySort(sortDir === 'desc' ? 'asc' : 'desc');
  const onSortClick = () => { if (state.error) start(); else toggleSort(); };

  // VNDB shows the active sort as a plain arrow (e.g. "Title ▴"). Once the rows are sorted by
  // Jiten instead, turn that arrow back into a link, so every column can be re-sorted by VNDB.
  function releaseVndbSort(table) {
    const href = new URL(location.href);
    href.searchParams.delete('p');
    for (const cell of table.tHead?.rows[0]?.cells || []) {
      if (cell.classList.contains('tc_jiten')) continue;
      for (const node of [...cell.childNodes]) {
        const m = node.nodeType === 3 && /^(.*?)([▴▾])\s*$/s.exec(node.textContent);
        if (!m) continue;
        const a = document.createElement('a');
        a.href = href.pathname + href.search;
        a.textContent = m[2];
        node.textContent = m[1];
        node.after(a);
      }
    }
  }

  let resortQueued = false;
  function resortSoon() {
    if (!sortDir || resortQueued) return;
    resortQueued = true;
    requestAnimationFrame(() => {
      resortQueued = false;
      for (const t of sortableTables) sortTable(t, sortDir);
    });
  }

  // The column header looks like VNDB's own ("Vote ▴▾": links, the active direction as plain
  // text) and also shows loading progress and errors, so the floating button can be hidden.
  function link(text, title, onClick) {
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = text;
    a.title = title;
    a.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
    return a;
  }

  function renderHeader(h) {
    h.textContent = 'Jiten ';
    h.removeAttribute('title');
    if (state.error) {
      h.append(link('⚠', `Jiten: ${state.error.message} — click to retry`, start));
      return;
    }
    const busy = !state.complete ? [`${state.catDone}/${state.catTotal || '?'}`, 'Loading Jiten data…']
      : pages.loading ? [`${pages.done}/${pages.total - 1}`, 'Loading the other pages of this list…'] : null;
    if (busy) {
      const s = document.createElement('small');
      s.textContent = busy[0] + ' ';
      s.title = busy[1];
      h.append(s);
    }
    const all = canLoadAll() ? ` (loads all ${pages.total} pages)` : '';
    for (const [dir, arrow, label] of [['asc', '▴', 'Easiest first'], ['desc', '▾', 'Hardest first']]) {
      h.append(sortDir === dir ? arrow : link(arrow, label + all, () => { if (state.error) start(); else applySort(dir); }));
    }
    if (pages.failed) h.title = `${pages.failed} page(s) of this list failed to load`;
  }

  function updateButton() {
    for (const h of headerCells.values()) renderHeader(h);
    if (!button) return;
    let text;
    if (state.error) text = `⚠ Jiten: ${state.error.message} — click to retry`;
    else if (!state.complete) text = `⇅ Jiten % — loading ${state.catDone}/${state.catTotal || '?'}`;
    else if (pages.loading) text = `⇅ Jiten % — loading list pages ${pages.done}/${pages.total - 1}`;
    else {
      let label = sortDir === 'desc' ? 'hardest first ▼' : sortDir === 'asc' ? 'easiest first ▲' : 'click to sort';
      if (!sortDir && canLoadAll()) label += ` all ${pages.total} pages`;
      if (sortableTables.size && pages.total > MAX_LIST_PAGES) label += ' (this page only)';
      if (pages.loaded) label += ` · ${fmt(items.filter((i) => i.tr).length)} titles`;
      if (pages.failed) label += ` · ${pages.failed} page(s) failed to load`;
      text = sortableTables.size ? `⇅ Jiten % — ${label}` : '⇅ Jiten % — loaded';
    }
    if (state.reqTotal > state.reqDone) text += `  (checking requests ${state.reqDone}/${state.reqTotal})`;
    button.textContent = text;
    button.style.cursor = state.error || sortableTables.size ? 'pointer' : 'default';
  }

  // The floating button (bottom left). Its × hides it for good; the Tampermonkey menu
  // brings it back.
  let buttonBox = null;
  let buttonHidden = false;
  let pagesRead = false;

  function ensureButton() {
    if (!pagesRead) { pagesRead = true; readPagination(); }
    if (button || buttonHidden) return;
    buttonBox = document.createElement('div');
    buttonBox.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:999999;display:flex;' +
      'border-radius:8px;border:1px solid #546e7a;background:#263238;box-shadow:0 2px 10px rgba(0,0,0,.5);' +
      'font:12px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;font-weight:700';
    const base = 'background:none;border:0;color:#eceff1;font:inherit;cursor:pointer;';
    button = document.createElement('button');
    button.type = 'button';
    button.style.cssText = base + 'padding:7px 6px 7px 14px';
    button.addEventListener('click', onSortClick);
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.title = 'Hide this button (the Jiten column header sorts too). Bring it back from the Tampermonkey menu.';
    close.style.cssText = base + 'padding:7px 10px 7px 6px;opacity:.6;font-size:14px;line-height:1';
    close.addEventListener('click', () => { setVal('hideButton', true); removeButton(); });
    buttonBox.append(button, close);
    document.body.append(buttonBox);
    updateButton();
  }

  function removeButton() {
    buttonHidden = true;
    buttonBox?.remove();
    buttonBox = null;
    button = null;
  }

  function addHeader(table, afterIndex) {
    if (headerCells.has(table)) return;
    const ref = table.tHead?.rows[0]?.cells[afterIndex];
    if (!ref) return;
    const h = document.createElement(ref.tagName);
    h.className = 'tc_jiten';
    h.style.cssText = 'white-space:nowrap;padding-left:8px;padding-right:8px';
    ref.after(h);
    headerCells.set(table, h);
    updateButton();
  }

  // ---------------------------------------------------------------------------
  // Scanning and resolving
  // ---------------------------------------------------------------------------

  const foundResult = (hit, unlinked = false) =>
    ({ state: 'found', deckId: hit[0], difficultyRaw: hit[1], characterCount: hit[2], unlinked });

  function show(item, result) {
    const { node, diff } = badgeFor(result, item.inline);
    item.holder.replaceWith(node);
    item.holder = node;
    item.done = result.state !== 'error';
    item.foundKey = result.state === 'found' && !result.unlinked ? `${result.deckId}:${result.difficultyRaw}` : null;
    if (item.tr) {
      if (diff != null) item.tr.dataset.jvlDiff = diff; else delete item.tr.dataset.jvlDiff;
    }
    resortSoon();
  }

  // The final answer for one title, once the whole catalogue is known.
  function settle(item) {
    if (state.error) { show(item, { state: 'error', message: state.error.message }); return; }
    const hit = state.catalogue[item.vid];
    if (hit) { show(item, foundResult(hit)); return; }
    if (!state.key) { show(item, { state: 'missing-unchecked' }); return; }
    state.reqTotal++;
    updateButton();
    requestShared(item.vid, item.title, state.key)
      .then((r) => {
        if (r.state !== 'unlinked') { show(item, r); return; }
        const hitByDeck = state.byDeck.get(r.deckId);
        show(item, hitByDeck ? foundResult(hitByDeck, true) : { state: 'found', deckId: r.deckId, difficultyRaw: null, unlinked: true });
      }, (e) => show(item, { state: 'error', message: e.message }))
      .finally(() => { state.reqDone++; updateButton(); });
  }

  function setCatalogue(map) {
    state.catalogue = map;
    state.byDeck = new Map(Object.values(map).map((v) => [v[0], v]));
  }

  function scan() {
    const links = [...document.querySelectorAll('a[href^="/v"]')]
      .filter((a) => !a.dataset.jvlDone && /^\/v\d+$/.test(new URL(a.href).pathname));
    for (const a of links) {
      a.dataset.jvlDone = '1';
      const td = a.closest('td');
      const tr = a.closest('tr');
      const table = a.closest('table');
      const holder = document.createElement('span');
      holder.textContent = '…';
      holder.style.cssText = 'opacity:0.4';
      // One-row-per-VN lists (ulist/wishlist/votes, browse, staff pages) get their own Jiten
      // column and can be sorted. Producer pages put the VN as a header row above its release
      // rows in the same table, so there the value goes next to the title instead.
      const listRow = table && tr && td && !tr.dataset.jvlRow
        && (td.classList.contains('tc_title') || td.classList.contains('tc1'));
      if (listRow) {
        sortableTables.add(table);
        tr.dataset.jvlRow = '1';
        addHeader(table, td.cellIndex);
        const cell = document.createElement(td.tagName);
        cell.className = 'tc_jiten';
        cell.style.cssText = 'white-space:nowrap;padding-left:8px;padding-right:8px';
        td.after(cell);
        cell.append(holder);
      } else {
        holder.style.marginLeft = '6px';
        a.after(holder);
      }
      pickColors(holder.parentElement); // once per page, from where the first value goes
      const item = {
        vid: new URL(a.href).pathname.slice(1).toLowerCase(), title: a.title || a.textContent,
        holder, tr: listRow ? tr : null, inline: !listRow,
      };
      items.push(item);
      if (state.complete || state.error) settle(item);
      else if (state.catalogue[item.vid]) show(item, foundResult(state.catalogue[item.vid]));
    }
    if (links.length) { ensureButton(); updateButton(); }
    return links.length;
  }

  let started = false;
  async function start() {
    started = true;
    state.error = null;
    updateButton();
    state.key = ((await getVal('apiKey')) || '').trim();
    const cached = await getVal('catalogue');
    if (cached?.map) {
      // Show the cached data right away; if it's over a day old, refresh it quietly behind it.
      setCatalogue(cached.map);
      state.complete = true;
      updateButton();
      for (const item of items) if (!item.done) settle(item);
      if (Date.now() - cached.ts > CATALOGUE_TTL) refreshInBackground();
      return;
    }
    try {
      const map = await buildCatalogue((partial, done, total) => {
        setCatalogue(partial);
        state.catDone = done;
        state.catTotal = total;
        updateButton();
        for (const item of items) if (!item.done && partial[item.vid]) show(item, foundResult(partial[item.vid]));
      });
      setCatalogue(map);
      state.complete = true;
      await setVal('catalogue', { ts: Date.now(), map });
    } catch (e) {
      state.error = e;
    }
    updateButton();
    for (const item of items) if (!item.done) settle(item);
  }

  async function refreshInBackground() {
    let map;
    try { map = await buildCatalogue(() => {}); } catch { return; } // keep the old data
    await setVal('catalogue', { ts: Date.now(), map });
    setCatalogue(map);
    for (const item of items) {
      const hit = map[item.vid];
      const key = hit ? `${hit[0]}:${hit[1]}` : null;
      if (item.done && key !== item.foundKey && !(key === null && !item.foundKey)) settle(item);
    }
  }

  menu('Set Jiten API key (shows which ones are already requested)', async () => {
    const next = prompt('Jiten API key (jiten.moe/settings → Advanced → API Key). Leave empty to remove it:', '');
    if (next === null) return;
    await setVal('apiKey', next.trim());
    alert(next.trim() ? 'Key saved. Reload the page to check requests.' : 'Key removed.');
  });
  menu('Show or hide the floating Jiten button', async () => {
    const hide = !buttonHidden;
    await setVal('hideButton', hide);
    if (hide) removeButton();
    else { buttonHidden = false; if (items.length) ensureButton(); }
  });
  menu('Refresh Jiten data now', async () => {
    for (const k of await listVals()) if (k === 'catalogue' || k.startsWith('req:') || k.startsWith('jvl:')) await delVal(k);
    location.reload();
  });

  (async () => {
    // Per-VN cache entries from versions 1-2 aren't used any more.
    for (const k of await listVals()) if (k.startsWith('jvl:')) await delVal(k);
  })();

  (async () => {
    buttonHidden = !!(await getVal('hideButton'));
    if (scan()) start();
    let debounce = null;
    new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(() => { if (scan() && !started) start(); }, 200);
    }).observe(document.body, { childList: true, subtree: true });
  })();
})();
