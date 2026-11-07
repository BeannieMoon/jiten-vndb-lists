// ==UserScript==
// @name         Jiten Difficulty for VNDB Lists
// @namespace    https://github.com/BeannieMoon/jiten-vndb-lists
// @author       BeannieMoon
// @license      MIT
// @homepageURL  https://github.com/BeannieMoon/jiten-vndb-lists
// @supportURL   https://github.com/BeannieMoon/jiten-vndb-lists/issues
// @downloadURL  https://raw.githubusercontent.com/BeannieMoon/jiten-vndb-lists/main/jiten-vndb-list-difficulty.user.js
// @updateURL    https://raw.githubusercontent.com/BeannieMoon/jiten-vndb-lists/main/jiten-vndb-list-difficulty.user.js
// @version      3.5.3
// @description  Adds a Jiten difficulty column to VNDB lists (your ulist/wishlist/votes, the /v browse list, tag pages, staff/VA pages) and shows it on producer pages, marks what isn't on Jiten (NA), and sorts by difficulty.
// @match        https://vndb.org/v
// @match        https://vndb.org/v?*
// @match        https://vndb.org/u*
// @match        https://vndb.org/p*
// @match        https://vndb.org/s*
// @match        https://vndb.org/g*
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
  const CLIENT_NAME = 'Jiten VNDB List Difficulty/3.5.3';
  // Measured: 4-5 parallel requests is the fastest; more makes Jiten slower, and bursts get 429s.
  const CONCURRENCY = 4;
  const CATALOGUE_TTL = 24 * 60 * 60 * 1000;
  const REQUEST_TTL = 7 * 24 * 60 * 60 * 1000;
  const CATALOGUE_TYPES = [7, 6]; // visual novels, video games
  // Lists up to this size are loaded whole to sort them (200 rows per request, so at most 10
  // requests). Longer ones (the /v browse list, big tag pages) are sorted by their titles on
  // Jiten, loading only the page you're looking at.
  const MAX_LIST_TITLES = 2000;
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
    return Number.isNaN(date) ? 5000 : Math.max(0, date - Date.now());
  }

  // Same pace as Jiten Everywhere: requests start at least 120 ms apart, and a 429 is retried
  // once, after Retry-After if that's 10 s or less. A second 429 stops Jiten requests in this tab
  // for a minute (or as long as Jiten asks).
  const JITEN_GAP = 120;
  let nextJiten = 0;
  let jitenStoppedUntil = 0;
  async function jitenGet(path, extraHeaders = {}) {
    const headers = { Accept: 'application/json', 'X-Client-Name': CLIENT_NAME, ...extraHeaders };
    for (let attempt = 0; ; attempt++) {
      await acquire();
      let r;
      try {
        if (jitenStoppedUntil > Date.now()) return { status: 429, text: '' };
        const start = Math.max(Date.now(), pausedUntil, nextJiten);
        nextJiten = start + JITEN_GAP;
        if (start > Date.now()) await sleep(start - Date.now());
        r = await gmGet(JITEN_API + path, headers);
      } finally {
        release();
      }
      if (r.status !== 429) return r;
      const wait = retryAfterMs(r.retryAfter);
      if (attempt >= 1 || wait > 10000) {
        jitenStoppedUntil = Date.now() + Math.max(wait, 60000);
        return r;
      }
      pausedUntil = Math.max(pausedUntil, Date.now() + wait);
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
    if (state.keyRejected) return { state: 'missing-unchecked', keyRejected: true };
    const cacheKey = 'req:' + vid;
    const cached = await getVal(cacheKey);
    if (cached && Date.now() - cached.ts < REQUEST_TTL) return cached;
    const q = new URLSearchParams({ title, externalUrl: `https://vndb.org/${vid}`, mediaType: '7' });
    const r = await jitenGet(`/requests/duplicate-check?${q}`, { 'X-Api-Key': key });
    if (r.status === 401 || r.status === 403) { // no point asking about the other titles
      state.keyRejected = true;
      return { state: 'missing-unchecked', keyRejected: true };
    }
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
    if (!requestsInFlight.has(vid)) {
      requestsInFlight.set(vid, requestStatus(vid, title, key).catch((e) => { requestsInFlight.delete(vid); throw e; }));
    }
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
  // Sorting: the ▴ ▾ links in the Jiten column header (and the optional floating button).
  // ---------------------------------------------------------------------------

  // complete: the catalogue is whole (cached or fully loaded); before that it may be partial.
  const state = { catalogue: {}, byDeck: new Map(), complete: false, error: null, catDone: 0, catTotal: 0, reqDone: 0, reqTotal: 0, key: '' };
  const items = [];
  const sortableTables = new Set();
  const headerCells = new Map(); // table -> header cell
  let sortDir = null; // null | 'desc' | 'asc'
  let pendingSort = null; // a sort clicked while the Jiten data was still loading
  let button = null;

  const diffOf = (r) => (r.dataset.jvlDiff !== undefined ? parseFloat(r.dataset.jvlDiff) : null);
  const compareRows = (dir) => (a, b) => {
    const av = diffOf(a);
    const bv = diffOf(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1; // not on Jiten: always last
    if (bv == null) return -1;
    return dir === 'desc' ? bv - av : av - bv;
  };

  // A multi-page list, once loaded and sorted, is shown in pages of the size VNDB uses, with
  // tabs that look like VNDB's but switch pages here instead of reloading. For long lists only
  // the sorted ids are kept (view.lazy), and a page's rows are loaded when that page is shown.
  const view = { rows: null, lazy: null, page: 1, perPage: 50, restHref: null, restLabel: '' };
  const diffOfId = (v) => state.catalogue[v]?.[1] ?? -1;

  function sortTable(table, dir) {
    if (view.lazy) {
      view.lazy.ids.sort((a, b) => (dir === 'desc' ? diffOfId(b) - diffOfId(a) : diffOfId(a) - diffOfId(b)));
      renderLazy(table);
      return;
    }
    if (view.rows) {
      view.rows.sort(compareRows(dir));
      renderPage(table);
      return;
    }
    // Rows that aren't VN rows keep their place at the top.
    const body = table.tBodies[0] || table;
    for (const r of [...body.rows].filter((r) => r.dataset.jvlRow).sort(compareRows(dir))) body.appendChild(r);
  }

  const showPage = (table) => (view.lazy ? renderLazy(table) : renderPage(table));

  function renderPage(table) {
    const pageCount = Math.max(1, Math.ceil(view.rows.length / view.perPage));
    view.page = Math.min(Math.max(1, view.page), pageCount);
    const start = (view.page - 1) * view.perPage;
    putRows(table, view.rows.slice(start, start + view.perPage));
    drawTabs(table, pageCount);
  }

  function putRows(table, rows, message) {
    const body = table.tBodies[0] || table;
    for (const r of [...body.rows]) if (r.dataset.jvlRow || r.classList.contains('jvl-msg')) r.remove();
    if (message) {
      const tr = document.createElement('tr');
      tr.className = 'jvl-msg';
      const td = document.createElement('td');
      td.colSpan = 99;
      td.style.cssText = 'text-align:center;padding:10px';
      td.textContent = message;
      tr.append(td);
      body.append(tr);
    }
    body.append(...rows);
  }

  function drawTabs(table, pageCount) {
    for (const nav of document.querySelectorAll('.browsetabs:not(.jvl-tabs)')) {
      if (!nav.querySelector('a[href*="p="]')) continue;
      nav.style.display = 'none';
      let mine = nav.nextElementSibling;
      if (!mine?.classList.contains('jvl-tabs')) {
        mine = document.createElement(nav.tagName);
        mine.className = 'browsetabs jvl-tabs';
        nav.after(mine);
      }
      mine.replaceChildren(...tabItems(pageCount, table));
    }
  }

  // Same markup as VNDB's own page tabs: ‹ previous 1 ⋯ 5 6 [7] 8 9 ⋯ 40 next ›
  function tabItems(pageCount, table) {
    const out = [];
    const tab = (label, p, rel) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = label;
      if (rel) a.rel = rel; else if (p === view.page) a.className = 'highlightselected';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        view.page = p;
        showPage(table);
        if (table.getBoundingClientRect().top < 0) table.scrollIntoView({ block: 'start' });
      });
      li.append(a);
      out.push(li);
    };
    if (pageCount > 1) {
      if (view.page > 1) tab('‹ previous', view.page - 1, 'prev');
      const shown = [...new Set([1, pageCount, ...[-2, -1, 0, 1, 2].map((d) => view.page + d)])]
        .filter((p) => p >= 1 && p <= pageCount).sort((a, b) => a - b);
      let last = 0;
      for (const p of shown) {
        if (p > last + 1) {
          const li = document.createElement('li');
          li.className = 'ellipsis';
          li.textContent = '⋯';
          out.push(li);
        }
        tab(String(p), p);
        last = p;
      }
      if (view.page < pageCount) tab('next ›', view.page + 1, 'next');
    }
    if (view.restHref) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = view.restHref;
      a.textContent = view.restLabel;
      a.title = 'Back to VNDB\'s own order, which includes the titles that aren\'t on Jiten';
      li.append(a);
      out.push(li);
    }
    return out;
  }

  // VNDB keeps a table's settings (sort, columns, results per page) in one number, the "s"
  // parameter (same encoding as VNDB's own TableOpts code).
  const RESULTS = [50, 10, 25, 100, 200];
  const B64 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-';
  function tableOpts() {
    try {
      const v = pageWin.pageVars?.widget?.TableOpts?.[0]?.[1]?.value;
      return typeof v === 'number' ? v : null;
    } catch { return null; }
  }

  function readPerPage() {
    const n = tableOpts();
    if (n != null) return RESULTS[(n >> 2) & 7] || 50;
    return parseInt(document.querySelector('.tableopts-results > a')?.textContent, 10) || 50;
  }

  const shownAt200 = () => tableOpts() != null && readPerPage() === 200;

  // The same list (same filters, columns and sort) at 200 rows per page: a quarter of the requests.
  function at200(url) {
    const u = new URL(url);
    const n = tableOpts();
    if (n == null) return u;
    let v = (n & ~28) | (4 << 2);
    let enc = '';
    do { enc = B64[v & 63] + enc; v = Math.floor(v / 64); } while (v > 0);
    u.searchParams.set('s', enc);
    return u;
  }

  // Loading the rest of a multi-page list, only when you sort it.
  // - Lists up to MAX_LIST_TITLES (your lists, most searches) are loaded whole, 200 rows per request.
  // - Longer ones (the /v browse list, big tag pages) never are: VNDB's API, which is meant for
  //   scripts, says which titles in the list are on Jiten, and then only the page you're looking
  //   at is loaded from VNDB, the same as clicking to that page.
  // progress: the spinner's tooltip; step: the short counter next to it ("2/6").
  const pages = { total: 1, current: 1, template: null, loading: false, loaded: false, progress: '', step: '', failed: 0, note: '' };
  let fetchSeq = 0;

  // VNDB rate-limits by IP, together with your own browsing, and doesn't publish the limit. So:
  // at most one VNDB page every 3 seconds, shared by all VNDB tabs; nothing is retried; and after
  // a 429 nothing more is loaded from VNDB (pages or API) for 10 minutes, in any tab.
  // The API's published limit is 200 requests per 5 minutes, one every 1.5 seconds, which is
  // also Jiten Everywhere's pace for it.
  const VNDB_GAP = 3000;
  const API_GAP = 1500;
  const VNDB_COOLDOWN = 10 * 60 * 1000;
  class SlowDown extends Error {}
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const slowDownError = (until) => new SlowDown(`VNDB asked to slow down, so nothing more is loaded from it until ${clock(until)}`);

  async function vndbTurn(key, gap) {
    const until = (await getVal('vndbCooldownUntil')) || 0;
    if (until > Date.now()) throw slowDownError(until);
    const now = Date.now();
    let at = (await getVal(key)) || 0;
    if (at < now || at > now + 60000) at = now; // a stale or odd value from another tab
    await setVal(key, at + gap);
    if (at > now) await sleep(at - now);
  }

  async function hitLimit() {
    const until = Date.now() + VNDB_COOLDOWN;
    await setVal('vndbCooldownUntil', until);
    return slowDownError(until);
  }

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

  const multiPage = () => !pages.loaded && pages.template && pages.total > 1 && sortableTables.size === 1;
  const canLoadAll = () => multiPage() && pages.total * readPerPage() <= MAX_LIST_TITLES;
  const canLoadJitenOnly = () => multiPage() && pages.total * readPerPage() > MAX_LIST_TITLES
    && (location.pathname === '/v' || /^\/g\d+$/.test(location.pathname))
    && !new URL(location.href).searchParams.get('ch'); // the API has no "first letter" filter

  // One page of a list: its VN rows, the number of pages, and the data VNDB needs to build
  // the vote, label and date editors in those rows (page JSON keyed by "widget<N>" ids).
  async function fetchPage(url, p) {
    const u = new URL(url);
    u.searchParams.set('p', p);
    await vndbTurn('vndbNextAt', VNDB_GAP);
    // no-store: VNDB's 429 page is marked cacheable for months.
    const r = await fetch(u, { credentials: 'same-origin', cache: 'no-store' });
    if (r.status === 429) throw await hitLimit();
    if (!r.ok) throw new Error(`VNDB returned an error (${r.status})`);
    const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
    let widgetData = {};
    try { widgetData = JSON.parse(doc.getElementById('pagevars')?.textContent || '{}').widget || {}; } catch { /* none */ }
    const byId = {};
    for (const [name, entries] of Object.entries(widgetData)) for (const [id, data] of entries) byId[id] = { name, data };
    const rows = [...doc.querySelectorAll('table.stripe tr')]
      .filter((tr) => tr.querySelector('td.tc_title a[href^="/v"], td.tc1 a[href^="/v"]'))
      .map((tr) => document.importNode(tr, true));
    const widgets = [];
    const seq = ++fetchSeq;
    for (const tr of rows) {
      for (const el of tr.querySelectorAll('[id^="widget"]')) {
        const w = byId[el.id.slice(6)];
        el.id = `jvl-${seq}-${el.id}`; // the same ids repeat on every page
        if (w) widgets.push({ el, ...w });
      }
    }
    let total = 1;
    for (const a of doc.querySelectorAll('.browsetabs a[href]')) {
      total = Math.max(total, parseInt(new URL(a.getAttribute('href'), u).searchParams.get('p'), 10) || 1);
    }
    return { rows, widgets, total };
  }

  async function vndbApi(body) {
    await vndbTurn('vndbApiNextAt', API_GAP);
    const r = await fetch('https://api.vndb.org/kana/vn', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (r.status === 429) throw await hitLimit();
    if (!r.ok) throw new Error(`VNDB's API returned an error (${r.status})`);
    return r.json();
  }

  // Rows copied from other pages arrive as plain HTML. VNDB turns the vote, label and date
  // cells into editors with its own components (Mithril), set up once when the page loads,
  // so here the same components are taken from a row VNDB already set up and attached to the
  // copied rows. They're attached as rows come near the screen, under one shared root, so a
  // 2,000-title list stays fast. If anything about this fails, the copied rows simply keep
  // VNDB's plain-text version of those cells.
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
              // Rows on other pages are out of the document: they catch up when shown again.
              for (const w of liveWidgets) if (w.el.isConnected) m.render(w.el, m(w.component, w.attrs), m.redraw);
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

  // Collects loaded rows in list order. A title that's already on this page keeps its own row
  // (with VNDB's own editors) instead of the loaded copy.
  const rowHref = (tr) => tr.querySelector('td.tc_title a[href^="/v"], td.tc1 a[href^="/v"]')?.getAttribute('href');
  function collector(table) {
    const own = new Map();
    for (const r of [...(table.tBodies[0] || table).rows]) {
      const h = r.dataset.jvlRow && rowHref(r);
      if (h && !own.has(h)) own.set(h, r);
    }
    const used = new Set();
    const c = {
      own,
      rows: [],
      widgets: [],
      take(res) {
        const skipped = new Set();
        for (const tr of res.rows) {
          const mine = own.get(rowHref(tr));
          if (mine && !used.has(mine)) { used.add(mine); skipped.add(tr); c.rows.push(mine); } else c.rows.push(tr);
        }
        c.widgets.push(...res.widgets.filter((w) => !skipped.has(w.el.closest('tr'))));
      },
      unused: () => [...own.values()].filter((r) => !used.has(r)),
    };
    return c;
  }

  // Puts loaded rows in the table once, so they get their Jiten cell and editors.
  function adoptRows(table, rows, widgets) {
    const body = table.tBodies[0] || table;
    body.append(...rows.filter((r) => !r.isConnected));
    scan();
    attachWidgets(widgets);
  }

  // A whole list: all or nothing. If any request fails, the table stays as VNDB sent it
  // (with VNDB's own tabs) and only this page is sorted.
  async function loadAllPages(table) {
    const c = collector(table);
    const url = at200(pages.template);
    const maxRequests = Math.ceil(MAX_LIST_TITLES / (tableOpts() != null ? 200 : readPerPage()));
    // Already showing 200 rows per page: the page on screen is one of the pages to load, so
    // it's used as it is instead of being loaded again.
    const onScreen = shownAt200() ? pages.current : 0;
    let total = onScreen ? pages.total : 1;
    let n = 0;
    for (let p = 1; p <= total; p++) {
      if (p === onScreen) {
        c.take({ rows: c.unused(), widgets: [] });
        continue;
      }
      const of = onScreen ? total - 1 : p > 1 ? total : '?';
      pages.step = `${++n}/${of}`;
      pages.progress = `Loading the whole list from VNDB (request ${n} of ${of}, one every 3 seconds)…`;
      updateButton();
      const res = await fetchPage(url, p);
      if (p === 1) total = res.total;
      if (total > maxRequests) throw new Error('This list is too long to load whole');
      c.take(res);
    }
    const rows = [...c.rows, ...c.unused()];
    adoptRows(table, rows, c.widgets);
    view.perPage = readPerPage();
    view.rows = rows.filter((r) => r.dataset.jvlRow);
  }

  const unfilteredBrowse = (u) => u.pathname === '/v' && !['f', 'q', 'ch'].some((k) => u.searchParams.get(k));

  async function loadJitenTitles(table) {
    const here = new URL(location.href);
    here.searchParams.delete('p');
    // Only titles with a difficulty matter here: everything else sorts last anyway.
    const ids = Object.keys(state.catalogue).filter((v) => state.catalogue[v][1] != null && state.catalogue[v][1] >= 0);
    let members;
    if (unfilteredBrowse(here)) {
      members = ids; // the browse list without filters is every VN
    } else {
      const parts = [];
      const f = here.searchParams.get('f');
      if (f) {
        const n = (await vndbApi({ filters: f, normalized_filters: true, results: 0 })).normalized_filters;
        if (Array.isArray(n) && n.length) parts.push(n);
      }
      const q = here.searchParams.get('q')?.trim();
      if (q) parts.push(['search', '=', q]);
      // A tag page (/g…) lists the VNs with that tag, at the spoiler level picked on the page.
      const tag = /^\/(g\d+)$/.exec(here.pathname)?.[1];
      if (tag) {
        const spoil = parseInt(document.querySelector('.browseopts button.optselected[name="m"]')?.value, 10) || 0;
        parts.push(['tag', '=', [tag, spoil, 0]]);
      }
      members = [];
      const count = Math.ceil(ids.length / 100);
      for (let i = 0; i < count; i++) {
        pages.step = `${i + 1}/${count}`;
        pages.progress = `Asking VNDB's API which titles in this list are on Jiten (request ${i + 1} of ${count})…`;
        updateButton();
        const byId = ['or', ...ids.slice(i * 100, i * 100 + 100).map((v) => ['id', '=', v])];
        const r = await vndbApi({ filters: parts.length ? ['and', ...parts, byId] : byId, fields: 'id', results: 100 });
        members.push(...(r.results || []).map((x) => x.id));
      }
    }
    const memberSet = new Set(members);
    const cache = new Map();
    const original = [...(table.tBodies[0] || table).rows].filter((r) => r.dataset.jvlRow);
    for (const r of original) {
      const v = rowHref(r)?.slice(1);
      if (memberSet.has(v)) cache.set(v, r);
    }
    const total = parseInt((document.body.innerText.match(/([\d,]+) results/) || [])[1]?.replace(/,/g, ''), 10);
    view.restHref = here.pathname + here.search;
    view.restLabel = total > members.length ? `+ ${fmt(total - members.length)} not on Jiten ›` : 'VNDB order ›';
    view.perPage = readPerPage();
    view.lazy = { ids: members, cache, base: here, original, busy: false, again: false, stopped: null, fetched: false };
  }

  // If the very first page can't be loaded, go back to the page as VNDB sent it, sorted on its own.
  function restoreOriginal(table, L) {
    view.lazy = null;
    view.restHref = null;
    putRows(table, L.original);
    for (const nav of document.querySelectorAll('.jvl-tabs')) nav.remove();
    for (const nav of document.querySelectorAll('.browsetabs')) nav.style.display = '';
    pages.note += '. Sorted this page only.';
    sortTable(table, sortDir);
    updateButton();
  }

  // Shows the current page of a long list, loading its rows first if needed: one request covers
  // this page and the next few (200 rows), so paging on is usually instant.
  async function renderLazy(table) {
    const L = view.lazy;
    if (L.busy) { L.again = true; return; }
    for (;;) {
      L.again = false;
      const pageCount = Math.max(1, Math.ceil(L.ids.length / view.perPage));
      view.page = Math.min(Math.max(1, view.page), pageCount);
      const start = (view.page - 1) * view.perPage;
      const want = L.ids.slice(start, start + view.perPage);
      if (!L.stopped && want.some((v) => !L.cache.has(v))) {
        L.busy = true;
        pages.loading = true;
        pages.step = '';
        pages.progress = 'Loading this page from VNDB…';
        drawTabs(table, pageCount);
        updateButton();
        let error = null;
        try {
          await fetchRows(table, L.ids.slice(start, start + 200).filter((v) => !L.cache.has(v)));
          L.fetched = true;
        } catch (e) {
          error = e;
        }
        L.busy = false;
        pages.loading = false;
        if (error) {
          pages.note = error.message;
          pages.failed++;
          if (!L.fetched) { restoreOriginal(table, L); return; }
          L.stopped = error.message;
        }
        continue; // the ids may have changed, or another page was asked for meanwhile
      }
      const rows = want.map((v) => L.cache.get(v)).filter(Boolean);
      putRows(table, rows, rows.length < want.length ? `${want.length - rows.length} titles here couldn't be loaded. ${L.stopped || ''}` : null);
      drawTabs(table, pageCount);
      updateButton();
      if (!L.again) return;
    }
  }

  async function fetchRows(table, vids) {
    const L = view.lazy;
    const r = await vndbApi({ filters: ['or', ...vids.map((v) => ['id', '=', v])], results: 0, compact_filters: true });
    const u = at200(L.base);
    u.searchParams.set('f', r.compact_filters);
    const res = await fetchPage(u, 1);
    const asked = new Set(vids);
    let found = 0;
    for (const tr of res.rows) {
      const v = rowHref(tr)?.slice(1);
      if (asked.has(v)) { L.cache.set(v, tr); found++; }
    }
    // Never keep asking if VNDB answers with something else: that would walk the whole list.
    if (!found) throw new Error('VNDB didn\'t return the titles for this page');
    // Titles VNDB didn't return (hidden or merged entries) leave the list.
    L.ids = L.ids.filter((v) => L.cache.has(v) || !asked.has(v));
    adoptRows(table, res.rows, res.widgets);
  }

  // Loading other pages is the user's call (Settings → "Sorting lists with several pages"):
  // ask first (the default), always, or never. The question says how many requests it takes.
  async function okToLoad(whole) {
    const mode = (await getVal('loadMode')) || 'ask';
    if (mode === 'never') return false;
    const until = (await getVal('vndbCooldownUntil')) || 0;
    if (until > Date.now()) {
      pages.note = `${slowDownError(until).message}. Sorted this page only.`;
      return false;
    }
    if (mode === 'always') return true;
    if (whole) {
      // At 200 rows per page, the page on screen doesn't need loading again.
    const requests = Math.ceil((pages.total * readPerPage()) / (tableOpts() != null ? 200 : readPerPage()))
      - (shownAt200() ? 1 : 0);
      return askToLoad(`Sort the whole list (${pages.total} pages)?`,
        `This loads the list from VNDB in ${requests} request${requests === 1 ? '.' : 's'}`
        + (requests > 1 ? `, one every 3 seconds (about ${(requests - 1) * 3 + 1} seconds).` : ''),
        'Sort the whole list');
    }
    const calls = unfilteredBrowse(new URL(location.href)) ? 0
      : Math.ceil(Object.values(state.catalogue).filter((c) => c[1] != null && c[1] >= 0).length / 100);
    return askToLoad('Sort this long list by its titles on Jiten?',
      (calls ? `First, VNDB's API is asked which titles here are on Jiten (${calls} small request${calls === 1 ? '' : 's'}, about ${Math.ceil((calls - 1) * 1.5) + 1} seconds). Then each`
        : 'Each') + ' page is loaded from VNDB only when you open it (one request covers four pages).',
      'Sort by Jiten titles');
  }

  async function applySort(dir) {
    if (!sortableTables.size || pages.loading) return;
    if (!state.complete) { // sort as soon as the Jiten data is in
      pendingSort = dir;
      updateButton();
      return;
    }
    const table = [...sortableTables][0];
    const whole = canLoadAll();
    if ((whole || canLoadJitenOnly()) && await okToLoad(whole)) {
      pages.loading = true;
      updateButton();
      try {
        if (whole) await loadAllPages(table); else await loadJitenTitles(table);
      } catch (e) {
        console.warn('[Jiten VNDB] could not load the whole list:', e);
        pages.note = `${e.message}. Sorted this page only.`;
        pages.failed++;
      }
      pages.loading = false;
    }
    pages.loaded = true; // asked once per page view: later sorts reuse what's here
    if (!sortDir) for (const t of sortableTables) releaseVndbSort(t);
    sortDir = dir;
    view.page = 1;
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
    if (!sortDir || resortQueued || view.lazy) return; // a long list's order comes from the catalogue
    resortQueued = true;
    requestAnimationFrame(() => {
      resortQueued = false;
      for (const t of sortableTables) sortTable(t, sortDir);
    });
  }

  // The column header looks like VNDB's own ("Vote ▴▾": links, the active direction as plain
  // text), with a spinner and a counter next to it while anything is loading.
  function link(text, title, onClick) {
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = text;
    a.title = title;
    a.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
    return a;
  }

  function busyText() {
    if (state.error) return null;
    if (!state.complete && state.waiting) return 'Waiting for another VNDB tab that is downloading the Jiten data…';
    if (!state.complete) return `Downloading the list of Jiten decks, once a day (${state.catDone}/${state.catTotal || '?'})…`
      + (pendingSort ? ' The list sorts as soon as it\'s in.' : '');
    if (pages.loading) return pages.progress;
    if (state.reqTotal > state.reqDone) return `Checking which titles are already requested on Jiten (${state.reqDone}/${state.reqTotal})…`;
    return null;
  }

  // The short counter next to the spinner, so you can see it moving along.
  function busyCount() {
    if (!state.complete) return state.catTotal ? `${state.catDone}/${state.catTotal}` : '';
    if (pages.loading) return pages.step;
    if (state.reqTotal > state.reqDone) return `${state.reqDone}/${state.reqTotal}`;
    return '';
  }

  // A small ring in the skin's text color. It's a Web Animation on transform, so it keeps
  // turning even while the browser is busy sorting a big list.
  function makeSpinner() {
    const s = document.createElement('span');
    s.className = 'jvl-spinner';
    s.style.cssText = 'display:inline-block;vertical-align:middle;margin-left:6px;width:8px;height:8px;'
      + 'border:2px solid currentColor;border-right-color:transparent;border-radius:50%;opacity:.75';
    s.animate?.([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 800, iterations: Infinity });
    return s;
  }

  // The header's parts are kept between updates: re-creating the spinner on every progress
  // update restarted its animation each time, so it looked stuck.
  const headerParts = new WeakMap();
  function renderHeader(h) {
    if (state.error) {
      headerParts.delete(h);
      h.textContent = 'Jiten ';
      h.append(link('⚠', `Jiten: ${state.error.message} — click to retry`, start));
      return;
    }
    let parts = headerParts.get(h);
    if (!parts || parts.arrows.parentNode !== h) {
      h.textContent = 'Jiten ';
      parts = { arrows: document.createElement('span'), spin: makeSpinner(), count: document.createElement('span'),
        warn: document.createElement('span') };
      parts.count.style.cssText = 'margin-left:4px;font-size:smaller;opacity:.75;font-variant-numeric:tabular-nums;white-space:nowrap';
      parts.warn.className = 'jvl-warn';
      parts.warn.style.cursor = 'help';
      h.append(parts.arrows);
      headerParts.set(h, parts);
    }
    const { arrows, spin, count, warn } = parts;
    const note = canLoadAll() ? ` (the whole list: ${pages.total} pages)`
      : canLoadJitenOnly() ? ' (the titles in this list that are on Jiten)'
        : pages.total > 1 && !pages.loaded ? ' (this page only)' : '';
    arrows.textContent = '';
    for (const [dir, arrow, label] of [['asc', '▴', 'Easiest first'], ['desc', '▾', 'Hardest first']]) {
      arrows.append(sortDir === dir ? arrow : link(arrow, label + note, () => applySort(dir)));
    }
    const busy = busyText();
    if (busy) {
      spin.title = count.title = busy;
      count.textContent = busyCount();
      if (!spin.isConnected) arrows.after(spin, count);
    } else {
      spin.remove();
      count.remove();
    }
    if (pages.note) {
      warn.textContent = ' ⚠';
      warn.title = pages.note;
      if (!warn.isConnected) h.append(warn);
    } else warn.remove();
  }

  function updateButton() {
    for (const h of headerCells.values()) renderHeader(h);
    updateStatus();
    if (!button) return;
    let text;
    const busy = busyText();
    if (state.error) text = `⚠ Jiten: ${state.error.message} — click to retry`;
    else if (busy && (!state.complete || pages.loading)) text = `⇅ Jiten % — ${busy}`;
    else {
      let label = sortDir === 'desc' ? 'hardest first ▼' : sortDir === 'asc' ? 'easiest first ▲' : 'click to sort';
      const shown = view.lazy?.ids || view.rows;
      if (shown) label += ` · ${fmt(shown.length)} titles`;
      else if (sortableTables.size && pages.total > 1 && !canLoadAll() && !canLoadJitenOnly()) label += ' (this page only)';
      if (pages.note) label += ` · ⚠ ${pages.note}`;
      text = sortableTables.size ? `⇅ Jiten % — ${label}` : '⇅ Jiten % — loaded';
    }
    button.textContent = text;
    button.style.cursor = state.error || sortableTables.size ? 'pointer' : 'default';
  }

  // Pages without a Jiten column (producer pages) have no header spinner, so while the Jiten
  // data downloads (about 10 seconds, once a day) or fails, a small note in the corner says so.
  let statusBox = null;
  function updateStatus() {
    const busy = started && !state.complete ? busyText() : null;
    const wanted = (busy || state.error) && !headerCells.size && items.length && !button;
    if (!wanted) {
      statusBox?.remove();
      statusBox = null;
      return;
    }
    if (!statusBox) {
      statusBox = document.createElement('div');
      statusBox.className = 'jvl-status';
      statusBox.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:999999;display:flex;gap:8px;align-items:center;'
        + 'max-width:calc(100vw - 32px);box-sizing:border-box;padding:7px 12px;border-radius:8px;border:1px solid #546e7a;'
        + 'background:#263238;color:#eceff1;box-shadow:0 2px 10px rgba(0,0,0,.5);font:12px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif';
      statusBox.append(makeSpinner(), document.createElement('span'));
      statusBox.firstChild.style.marginLeft = '0';
      statusBox.addEventListener('click', () => { if (state.error) start(); });
      document.body.append(statusBox);
    }
    statusBox.firstChild.style.display = state.error ? 'none' : '';
    statusBox.lastChild.textContent = state.error ? `⚠ Jiten: ${state.error.message} — click to retry` : `Jiten: ${busy}`;
    statusBox.style.cursor = state.error ? 'pointer' : 'default';
  }

  // The floating button (bottom left) is off by default: the header does the same job.
  // The Tampermonkey menu turns it on; its × turns it off again.
  let buttonBox = null;
  let buttonHidden = true;
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
    close.title = 'Hide this button (the Jiten column header sorts too). Bring it back in Settings (Tampermonkey menu).';
    close.style.cssText = base + 'padding:7px 10px 7px 6px;opacity:.6;font-size:14px;line-height:1';
    close.addEventListener('click', () => { setVal('showButton', false); removeButton(); });
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
    item.state = result.state;
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
    checkWhenVisible(item);
  }

  // One request to Jiten per title, so only for titles that come on screen: a 1,000-title list
  // that isn't on Jiten shouldn't mean 1,000 requests at once. Answers are kept for a week.
  let checkObserver = null;
  const waitingChecks = new Map();
  function checkWhenVisible(item) {
    const target = item.tr || item.holder;
    if (!checkObserver) {
      checkObserver = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          checkObserver.unobserve(e.target);
          const it = waitingChecks.get(e.target);
          waitingChecks.delete(e.target);
          if (it) checkRequest(it);
        }
      }, { rootMargin: '400px 0px' });
    }
    waitingChecks.set(target, item);
    checkObserver.observe(target);
  }

  function checkRequest(item) {
    if (item.done) return;
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
      holder.title = 'Waiting for the Jiten data';
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
    let cached = await getVal('catalogue');
    // Opening several VNDB tabs at once shouldn't mean several downloads: one tab loads the
    // catalogue, the others wait for it.
    if (!cached?.map && !(await takeCatalogueLock())) {
      state.waiting = true;
      updateButton();
      cached = await waitForCatalogue();
      state.waiting = false;
    }
    if (cached?.map) {
      // Show the cached data right away; if it's over a day old, refresh it quietly behind it.
      setCatalogue(cached.map);
      state.complete = true;
      updateButton();
      for (const item of items) if (!item.done) settle(item);
      if (Date.now() - cached.ts > CATALOGUE_TTL) refreshInBackground();
      runPendingSort();
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
    await releaseCatalogueLock();
    updateButton();
    for (const item of items) if (!item.done) settle(item);
    runPendingSort();
  }

  function runPendingSort() {
    const dir = pendingSort;
    pendingSort = null;
    if (dir && state.complete) applySort(dir);
    else updateButton();
  }

  // The downloading tab renews its claim every 2 seconds. If it's closed or navigates away
  // midway, the claim goes stale and a waiting tab takes over within a few seconds.
  const LOCK_STALE = 7000;
  let lockBeat = null;
  async function takeCatalogueLock() {
    const t = (await getVal('catalogueLock')) || 0;
    if (Date.now() - t < LOCK_STALE) return false;
    await setVal('catalogueLock', Date.now());
    clearInterval(lockBeat);
    lockBeat = setInterval(() => setVal('catalogueLock', Date.now()), 2000);
    return true;
  }

  async function releaseCatalogueLock() {
    if (!lockBeat) return;
    clearInterval(lockBeat);
    lockBeat = null;
    await setVal('catalogueLock', 0);
  }
  addEventListener('pagehide', () => { releaseCatalogueLock(); });

  async function waitForCatalogue() {
    for (;;) {
      await sleep(1000);
      const c = await getVal('catalogue');
      if (c?.map) return c;
      if (await takeCatalogueLock()) return null; // the other tab stopped: load it here
    }
  }

  async function refreshInBackground() {
    if (!(await takeCatalogueLock())) return; // another tab is on it
    let map;
    try {
      const c = await getVal('catalogue');
      if (c && Date.now() - c.ts < CATALOGUE_TTL) return; // another tab just did it
      map = await buildCatalogue(() => {});
    } catch {
      return; // keep the old data
    } finally {
      await releaseCatalogueLock();
    }
    await setVal('catalogue', { ts: Date.now(), map });
    setCatalogue(map);
    for (const item of items) {
      const hit = map[item.vid];
      const key = hit ? `${hit[0]}:${hit[1]}` : null;
      if (item.done && key !== item.foundKey && !(key === null && !item.foundKey)) settle(item);
    }
  }

  // ---------------------------------------------------------------------------
  // Dialogs: the Settings window and the "load the whole list?" question. They live in a
  // shadow root, so VNDB's skins can't restyle their checkboxes and buttons, and they take a
  // light or dark look from the skin behind them (like Jiten Everywhere's settings).
  // ---------------------------------------------------------------------------

  const DIALOG_THEMES = {
    dark: { bg: '#1c1e24', fg: '#e4e6eb', muted: '#a0a6b0', line: '#3a3f4b', field: '#262a33', accent: '#8ab4f8', onAccent: '#10131a' },
    light: { bg: '#ffffff', fg: '#1f2328', muted: '#5f6670', line: '#d0d5dc', field: '#f3f4f6', accent: '#2557c9', onAccent: '#ffffff' },
  };

  function dialogCss() {
    // A dark panel where white text reads better than black on the page behind it.
    const behind = backgroundOf(document.querySelector('article') || document.body);
    const dark = contrast([255, 255, 255], behind) > contrast([0, 0, 0], behind);
    const t = DIALOG_THEMES[dark ? 'dark' : 'light'];
    return `
    :host{all:initial}
    .overlay{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.45);display:flex;align-items:center;
      justify-content:center;padding:16px;box-sizing:border-box}
    .box{color-scheme:${dark ? 'dark' : 'light'};background:${t.bg};color:${t.fg};border:1px solid ${t.line};border-radius:10px;
      box-shadow:0 12px 40px rgba(0,0,0,.45);font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:18px 20px;
      width:460px;max-width:100%;max-height:100%;overflow:auto;box-sizing:border-box;text-align:left}
    h2{font-size:15px;font-weight:700;margin:0 0 10px}
    p{margin:0 0 8px}
    .section{margin:0 0 14px}
    .title{font-weight:700;margin:0 0 4px}
    label{display:flex;gap:8px;align-items:center;margin:4px 0;cursor:pointer}
    label.remember{margin:10px 0 14px}
    input[type=checkbox],input[type=radio]{accent-color:${t.accent};width:15px;height:15px;margin:0;flex:none;cursor:pointer}
    input[type=password]{width:100%;box-sizing:border-box;padding:6px 8px;border-radius:6px;border:1px solid ${t.line};
      background:${t.field};color:${t.fg};font:inherit}
    input:focus-visible,button:focus-visible{outline:2px solid ${t.accent};outline-offset:2px}
    .note{font-size:12px;color:${t.muted};margin:4px 0 0}
    .dim{color:${t.muted}}
    .spaced{margin:6px 0 0}
    a{color:${t.accent}}
    button{font:inherit;font-weight:600;border-radius:6px;padding:6px 14px;cursor:pointer;border:1px solid ${t.line};
      background:${t.field};color:${t.fg}}
    button:hover{border-color:${t.accent}}
    button.main{background:${t.accent};border-color:${t.accent};color:${t.onAccent}}
    .buttons{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
    .foot{display:flex;gap:8px;justify-content:space-between;align-items:center;flex-wrap:wrap;
      border-top:1px solid ${t.line};padding-top:12px;margin-top:4px}
    .foot .note{margin:0}`;
  }

  function el(tag, cls, ...kids) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    e.append(...kids);
    return e;
  }

  function field(type, props = {}) {
    const i = document.createElement('input');
    i.type = type;
    return Object.assign(i, props);
  }

  function dialogButton(label, cls, onClick) {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  const note = (...kids) => el('div', 'note', ...kids);
  const outLink = (href, text) => Object.assign(el('a', '', text), { href, target: '_blank', rel: 'noopener' });

  // A centered panel over a dimmed page. Escape or a click outside closes it like "Cancel".
  function openDialog(label, onClose) {
    const host = document.createElement('div');
    host.className = 'jvl-dialog';
    host.style.cssText = 'all:initial'; // page CSS on plain divs (transforms, display) can't reach the panel
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = dialogCss();
    const overlay = el('div', 'overlay');
    const box = el('div', 'box');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', label);
    box.addEventListener('keydown', (e) => e.stopPropagation()); // keep VNDB's own shortcuts out of it
    overlay.append(box);
    root.append(style, overlay);
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(null); } };
    const close = (value) => {
      host.remove();
      document.removeEventListener('keydown', onKey, true);
      onClose?.(value);
    };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
    document.body.append(host);
    return { box, close };
  }

  function askToLoad(title, text, yesLabel) {
    return new Promise((resolve) => {
      const remember = field('checkbox');
      const d = openDialog(title, (yes) => resolve(!!yes));
      const answer = (yes) => {
        if (remember.checked) setVal('loadMode', yes ? 'always' : 'never');
        d.close(yes);
      };
      const yes = dialogButton(yesLabel, 'main', () => answer(true));
      d.box.append(
        el('h2', '', title),
        el('p', '', text),
        el('p', 'dim', 'The script stops at once if VNDB asks it to slow down.'),
        el('label', 'remember', remember, 'Remember my choice (you can change it in Settings)'),
        el('div', 'buttons', dialogButton('Just this page', '', () => answer(false)), yes),
      );
      yes.focus();
    });
  }

  // Applies a new or removed API key to the titles already on the page.
  function applyKey(key) {
    state.key = key;
    state.keyRejected = false;
    requestsInFlight.clear();
    if (!state.complete) return;
    for (const item of items) {
      if (['missing-unchecked', 'missing', 'requested', 'error'].includes(item.state)) { item.done = false; settle(item); }
    }
  }

  // The kinds of VNDB pages the script works on. Each can be turned off in Settings.
  const PAGE_TYPES = [
    ['lists', 'Your lists, wishlist and votes', /^\/u\d+/],
    ['browse', 'Browse and search (/v)', /^\/v$/],
    ['tags', 'Tag pages', /^\/g\d+/],
    ['staff', 'Staff and voice-actor pages', /^\/s\d+/],
    ['producers', 'Producer pages', /^\/p\d+/],
  ];
  const pageType = PAGE_TYPES.find(([, , re]) => re.test(location.pathname))?.[0] || null;

  let settingsOpen = false;
  async function openSettings() {
    if (settingsOpen) return;
    settingsOpen = true;
    const d = openDialog('Jiten for VNDB settings', () => { settingsOpen = false; });
    const section = (title, ...kids) => el('div', 'section', el('div', 'title', title), ...kids);
    const check = (value, checked, ...label) => el('label', '', field('checkbox', { value, checked }), ...label);

    const pagesOff = (await getVal('pagesOff')) || [];
    const types = PAGE_TYPES.map(([value, label]) => check(value, !pagesOff.includes(value), label,
      ...(value === pageType ? [el('span', 'dim', '(this page)')] : [])));

    const mode = (await getVal('loadMode')) || 'ask';
    const modes = [
      ['ask', 'Ask first, saying how many requests it takes (recommended)'],
      ['always', 'Load without asking'],
      ['never', 'Never: only sort the page I\'m on'],
    ].map(([value, label]) => el('label', '', field('radio', { name: 'jvl-load-mode', value, checked: value === mode }), label));

    const buttonRow = check('button', !buttonHidden, 'Show the sort button in the bottom-left corner');
    const showButton = buttonRow.querySelector('input');

    const oldKey = ((await getVal('apiKey')) || '').trim();
    const key = field('password', { value: oldKey, placeholder: 'Paste your key here', autocomplete: 'off', spellcheck: false });

    const cached = await getVal('catalogue');
    const age = cached?.ts ? Math.round((Date.now() - cached.ts) / 60000) : null;
    const ageText = age == null ? 'Not downloaded yet.'
      : `Downloaded ${age < 1 ? 'just now' : `${age < 60 ? `${age} min` : `${Math.round(age / 60)} h`} ago`}; it refreshes once a day by itself.`;

    const save = async () => {
      const picked = modes.map((l) => l.querySelector('input')).find((r) => r.checked)?.value || 'ask';
      await setVal('loadMode', picked);
      await setVal('showButton', showButton.checked);
      if (showButton.checked) { buttonHidden = false; if (items.length) ensureButton(); } else removeButton();
      const newKey = key.value.trim();
      if (newKey !== oldKey) {
        await setVal('apiKey', newKey);
        applyKey(newKey);
      }
      const off = types.map((l) => l.querySelector('input')).filter((c) => !c.checked).map((c) => c.value);
      await setVal('pagesOff', off);
      d.close();
      if (pageType && off.includes(pageType) && running) location.reload(); // takes the column away again
      else if (pageType && !off.includes(pageType)) run();
    };

    d.box.append(
      el('h2', '', 'Jiten Difficulty for VNDB Lists'),
      section('Show the Jiten column on', ...types,
        note('Turning off the kind of page you\'re on reloads it.')),
      section('Sorting lists with several pages', ...modes,
        note('Loading other pages counts toward VNDB\'s rate limit, together with your own browsing. '
          + 'Sorting up and down again afterwards is free.')),
      section('Floating button', buttonRow),
      section('Jiten API key (optional)', key,
        note('Shows which titles that aren\'t on Jiten are already requested. Find it at ',
          outLink('https://jiten.moe/settings', 'jiten.moe/settings'), ' → Advanced → API Key.')),
      section('Jiten data', el('div', '', ageText),
        el('div', 'spaced', dialogButton('Download again now', '', async () => {
          for (const k of await listVals()) if (k === 'catalogue' || k.startsWith('req:')) await delVal(k);
          location.reload();
        })), note('Reloads this page.')),
      el('div', 'foot',
        note(`Version ${CLIENT_NAME.split('/')[1]} · `, outLink('https://github.com/BeannieMoon/jiten-vndb-lists', 'GitHub')),
        el('div', 'buttons', dialogButton('Cancel', '', () => d.close()), dialogButton('Save', 'main', save))),
    );
  }

  menu('Settings', openSettings);

  (async () => {
    // Per-VN cache entries from versions 1-2 aren't used any more.
    for (const k of await listVals()) if (k.startsWith('jvl:')) await delVal(k);
    // 3.4.2 had an on/off switch for loading other pages; 3.5 has three choices.
    if ((await getVal('pageOnly')) === true && !(await getVal('loadMode'))) await setVal('loadMode', 'never');
    await delVal('pageOnly');
  })();

  let running = false;
  function run() {
    if (running) return;
    running = true;
    if (scan()) start();
    let debounce = null;
    new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(() => { if (scan() && !started) start(); }, 200);
    }).observe(document.body, { childList: true, subtree: true });
  }

  (async () => {
    buttonHidden = (await getVal('showButton')) !== true;
    // Turned off for this kind of page: do nothing at all (no Jiten or VNDB requests) until
    // it's turned back on in Settings.
    if (pageType && ((await getVal('pagesOff')) || []).includes(pageType)) return;
    run();
  })();
})();
