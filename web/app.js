// Multi-Agent Crawler — UI runtime.
// Agent 05 — Frontend Engineer.
// Vanilla JS. Connects to /events (SSE), POSTs /index, GETs /search & /status.

(() => {
  'use strict';

  // ---------- tiny helpers ---------------------------------------------------
  const $  = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const fmtNum = (n) => {
    const v = Number(n ?? 0);
    if (!Number.isFinite(v)) return '0';
    return v.toLocaleString('en-US');
  };
  const fmtFloat = (n, d = 2) => Number(n ?? 0).toFixed(d);
  const timeStr = (ts) => {
    if (!ts) return '—';
    const d = new Date(ts);
    return d.toISOString().slice(11, 19);
  };
  const dateStr = (ts) => {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)}`;
  };
  const durationStr = (startedAt, endedAt) => {
    if (!startedAt) return '—';
    const end = endedAt ?? Date.now();
    const s = Math.max(0, Math.floor((end - startedAt) / 1000));
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    const hh = Math.floor(s / 3600);
    return hh ? `${hh}h ${mm}m` : `${mm}:${ss}`;
  };

  async function jget(path) {
    const r = await fetch(path, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
    return r.json();
  }
  async function jpost(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const payload = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(payload.error || `POST ${path} → ${r.status}`);
    return payload;
  }

  // ---------- hash router ----------------------------------------------------
  const ROUTES = ['deck', 'search', 'crawls'];
  function currentRoute() {
    const raw = (location.hash || '#/deck').replace(/^#\/?/, '');
    return ROUTES.includes(raw) ? raw : 'deck';
  }
  function applyRoute() {
    const route = currentRoute();
    $$('.view').forEach((v) => { v.hidden = v.dataset.view !== route; });
    $$('.nav-item').forEach((a) => {
      a.classList.toggle('active', a.dataset.route === route);
    });
    if (route === 'crawls') void refreshCrawls();
    if (route === 'search' && state.searchQuery) void runSearch();
  }

  // ---------- shared state ---------------------------------------------------
  const state = {
    es: null,
    connected: false,
    searchQuery: '',
    searchSort: 'relevance',
    lastSearchAt: 0,
    searchTimer: null,
    maxQueue: 500,
    currentQueueDepth: 0,
    eventLog: [],
    expandedCrawl: null,
  };

  // ---------- top-bar pills --------------------------------------------------
  function setStatePill(stateName) {
    const pill = $('#state-pill');
    const text = $('#state-text');
    if (!pill || !text) return;
    text.textContent = stateName;
    pill.classList.remove('pill-ok', 'pill-warn', 'pill-err');
    if (stateName === 'OK')             pill.classList.add('pill-ok');
    else if (stateName === 'THROTTLED') pill.classList.add('pill-warn');
    else                                 pill.classList.add('pill-err');
  }
  function setConnPill(connected) {
    state.connected = connected;
    const pill = $('#conn-pill');
    const dot  = $('#conn-dot');
    const txt  = $('#conn-text');
    if (!pill || !dot || !txt) return;
    txt.textContent = connected ? 'LIVE' : 'DISCONNECTED';
    dot.classList.toggle('dot-connected', connected);
    dot.classList.toggle('dot-disconnected', !connected);
    pill.classList.toggle('pill-ok', connected);
    pill.classList.toggle('pill-muted', !connected);
  }

  // ---------- telemetry render ----------------------------------------------
  function renderStatus(s) {
    if (!s) return;
    setStatePill(s.state || 'OK');
    $('#t-active').textContent = fmtNum(s.activeCrawls);

    const t = s.totals || {};
    $('#t-pages').textContent = fmtNum(t.pagesIndexed);
    $('#t-urls').textContent  = fmtNum(t.urlsVisited);
    $('#t-words').textContent = fmtNum(t.wordsIndexed);
    $('#t-pages-big').textContent = fmtNum(t.pagesIndexed);
    $('#t-words-big').textContent = fmtNum(t.wordsIndexed);

    const crawls = s.crawls || [];
    let depth = 0, maxQ = state.maxQueue, rate = 0, lastUrl = '—';
    const active = crawls.find((c) => c.status === 'running') || crawls[0];
    if (active) {
      depth = Number(active.queueDepth ?? 0);
      rate  = Number(active.rateRps ?? 0);
      if (active.lastUrl) lastUrl = active.lastUrl;
      if (active.opts?.maxQueue) maxQ = active.opts.maxQueue;
    }
    state.currentQueueDepth = depth;
    state.maxQueue = maxQ;
    $('#t-rate').textContent = fmtFloat(rate, 2);
    $('#queue-depth').textContent = fmtNum(depth);
    $('#queue-max').textContent   = fmtNum(maxQ);

    const pct = maxQ > 0 ? Math.min(100, (depth / maxQ) * 100) : 0;
    $('#queue-fill').style.width = pct + '%';

    $('#t-last').textContent = lastUrl;
    $('#telemetry-ts').textContent = timeStr(Date.now());
  }

  let statusTimer = null;
  let statusInflight = false;
  async function refreshStatus() {
    if (statusInflight) return;
    statusInflight = true;
    try {
      const s = await jget('/status');
      renderStatus(s);
    } catch (e) {
      // non-fatal; SSE will re-prime
    } finally {
      statusInflight = false;
    }
  }
  function scheduleStatusPoll() {
    clearInterval(statusTimer);
    statusTimer = setInterval(refreshStatus, 2500);
  }

  // ---------- event stream UI -----------------------------------------------
  const MAX_EVENT_ROWS = 40;
  function pushEvent(name, data) {
    const list = $('#event-list');
    if (!list) return;
    let kind = '';
    if (name === 'crawl:error')                               kind = 'kind-err';
    else if (name === 'crawl:state' || name === 'queue:change') kind = 'kind-warn';
    else if (name === 'crawl:finish' || name === 'crawl:index') kind = 'kind-ok';

    const msg =
      data?.url ? data.url :
      data?.state ? `→ ${data.state}` :
      data?.msg ? data.msg :
      data?.error ? data.error :
      data ? JSON.stringify(data).slice(0, 160) : '';

    const li = document.createElement('li');
    li.className = 'event-row ' + kind;
    li.innerHTML =
      `<span class="event-ts">${esc(timeStr(Date.now()))}</span>` +
      `<span class="event-name">${esc(name)}</span>` +
      `<span class="event-msg">${esc(msg)}</span>`;
    list.prepend(li);
    while (list.children.length > MAX_EVENT_ROWS) list.removeChild(list.lastChild);
  }

  // ---------- SSE ------------------------------------------------------------
  function connectSse() {
    try {
      const es = new EventSource('/events');
      state.es = es;

      es.onopen = () => setConnPill(true);
      es.onerror = () => {
        setConnPill(false);
        // EventSource auto-reconnects; no manual retry needed.
      };

      const handler = (name) => (ev) => {
        let data = null;
        try { data = ev.data ? JSON.parse(ev.data) : null; } catch { data = ev.data; }
        pushEvent(name, data);
        onBusEvent(name, data);
      };

      [
        'hello',
        'crawl:start',
        'crawl:fetch',
        'crawl:index',
        'crawl:error',
        'crawl:state',
        'crawl:finish',
        'queue:change',
      ].forEach((n) => es.addEventListener(n, handler(n)));
    } catch (e) {
      setConnPill(false);
    }
  }

  function onBusEvent(name, data) {
    if (name === 'hello') { setConnPill(true); return; }

    // Small updates we apply immediately; status poll (2.5 s) catches the rest.
    if (name === 'queue:change' && data) {
      const depth = Number(data.size ?? data.queueDepth ?? 0);
      const maxQ = Number(data.maxQueue ?? state.maxQueue ?? 500);
      state.currentQueueDepth = depth;
      state.maxQueue = maxQ;
      const el = $('#queue-depth'); if (el) el.textContent = fmtNum(depth);
      const ml = $('#queue-max');   if (ml) ml.textContent = fmtNum(maxQ);
      const fill = $('#queue-fill');
      if (fill) fill.style.width = (maxQ > 0 ? Math.min(100, (depth / maxQ) * 100) : 0) + '%';
      if (data.state) setStatePill(data.state);
    }
    if (name === 'crawl:state' && data?.state) setStatePill(data.state);
    if (name === 'crawl:index' && data?.url) {
      const m = $('#t-last'); if (m) m.textContent = data.url;
      // Debounced search refresh when on search view
      if (currentRoute() === 'search' && state.searchQuery) scheduleSearchRerun();
    }
    if (name === 'crawl:finish' || name === 'crawl:start') {
      void refreshStatus();
      if (currentRoute() === 'crawls') void refreshCrawls();
    }
  }

  // ---------- launch form ----------------------------------------------------
  function bindLauncher() {
    const form = $('#crawl-form');
    if (!form) return;
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const msg = $('#form-msg');
      const btn = $('#launch-btn');
      const origin = $('#f-origin').value.trim();
      const k      = Number($('#f-k').value);
      const rate   = Number($('#f-rate').value);
      const conc   = Number($('#f-conc').value);
      const maxQ   = Number($('#f-queue').value);
      const maxP   = Number($('#f-pages').value);

      if (!/^https?:\/\//i.test(origin)) {
        msg.textContent = 'origin must start with http:// or https://';
        msg.className = 'form-msg error';
        return;
      }
      if (!Number.isInteger(k) || k < 0) {
        msg.textContent = 'k must be a non-negative integer';
        msg.className = 'form-msg error';
        return;
      }

      btn.disabled = true;
      msg.textContent = 'dispatching…';
      msg.className = 'form-msg';

      try {
        const res = await jpost('/index', {
          origin, k,
          opts: {
            rateLimit: rate,
            maxConcurrency: conc,
            maxQueue: maxQ,
            maxPages: maxP,
          },
        });
        msg.textContent = `accepted → ${res.crawlerId ?? 'ok'}`;
        msg.className = 'form-msg success';
        void refreshStatus();
      } catch (e) {
        msg.textContent = String(e.message || e);
        msg.className = 'form-msg error';
      } finally {
        setTimeout(() => { btn.disabled = false; }, 500);
      }
    });
  }

  // ---------- search ---------------------------------------------------------
  function bindSearch() {
    const input = $('#q-input');
    const chips = $$('.chip');
    const meta  = $('#results-meta');

    if (input) {
      input.addEventListener('input', () => {
        state.searchQuery = input.value.trim();
        scheduleSearchRerun();
      });
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); scheduleSearchRerun(true); }
      });
    }
    chips.forEach((c) => {
      c.addEventListener('click', () => {
        chips.forEach((cc) => cc.classList.remove('chip-on'));
        c.classList.add('chip-on');
        state.searchSort = c.dataset.sort;
        if (state.searchQuery) scheduleSearchRerun(true);
      });
    });
    if (meta) meta.textContent = 'awaiting query…';
  }

  function scheduleSearchRerun(immediate = false) {
    clearTimeout(state.searchTimer);
    const run = () => { void runSearch(); };
    if (immediate) { run(); return; }
    // at most 1 per 400 ms
    const since = Date.now() - state.lastSearchAt;
    const wait = since >= 400 ? 0 : 400 - since;
    state.searchTimer = setTimeout(run, wait);
  }

  let searchInflight = false;
  async function runSearch() {
    const query = state.searchQuery;
    const sort  = state.searchSort;
    const meta  = $('#results-meta');
    const list  = $('#results');
    if (!query || !list) {
      if (list) list.innerHTML = '';
      if (meta) meta.textContent = 'awaiting query…';
      return;
    }
    if (searchInflight) return;
    searchInflight = true;
    state.lastSearchAt = Date.now();
    try {
      const qs = new URLSearchParams({ query, sortBy: sort, limit: '50' });
      const r = await jget(`/search?${qs}`);
      renderResults(r, query, sort);
    } catch (e) {
      if (meta) meta.textContent = `error: ${e.message || e}`;
    } finally {
      searchInflight = false;
    }
  }

  function renderResults(data, query, sort) {
    const meta = $('#results-meta');
    const list = $('#results');
    if (!list) return;
    const results = Array.isArray(data?.results) ? data.results : [];
    if (meta) {
      meta.textContent = results.length
        ? `${results.length} results · sort=${sort} · q="${query}"`
        : `no matches yet for "${query}"`;
    }
    // Preserve existing rows by URL to minimize reflow churn / re-animation.
    const prev = new Map();
    $$('.result', list).forEach((el) => prev.set(el.dataset.url, el));

    const frag = document.createDocumentFragment();
    for (const r of results) {
      const key = `${r.relevant_url}::${r.origin_url}::${r.depth}`;
      const existing = prev.get(key);
      if (existing) {
        existing.dataset.keep = '1';
        updateResultRow(existing, r);
        frag.appendChild(existing);
        prev.delete(key);
      } else {
        frag.appendChild(buildResultRow(r, key));
      }
    }
    list.innerHTML = '';
    list.appendChild(frag);
  }

  function buildResultRow(r, key) {
    const li = document.createElement('li');
    li.className = 'result';
    li.dataset.url = key;
    li.innerHTML = `
      <div class="result-main">
        <a class="result-url" href="${esc(r.relevant_url)}" target="_blank" rel="noopener noreferrer">${esc(r.relevant_url)}</a>
        <div class="result-origin">origin · ${esc(r.origin_url)}</div>
        <div class="result-badges">
          <span class="badge badge-match">match · ${esc(r.matched_word)}</span>
          <span class="badge badge-depth">depth · ${esc(String(r.depth))}</span>
          <span class="badge badge-freq">freq · ${esc(String(r.frequency))}</span>
        </div>
      </div>
      <div class="result-score">
        <span class="score-label">score</span>
        ${esc(String(r.score))}
      </div>
    `;
    return li;
  }
  function updateResultRow(el, r) {
    const score = el.querySelector('.result-score');
    if (score) {
      const cur = score.lastChild?.textContent?.trim();
      if (cur !== String(r.score)) {
        score.lastChild.textContent = ' ' + String(r.score);
      }
    }
  }

  // ---------- crawls view ----------------------------------------------------
  async function refreshCrawls() {
    const tbody = $('#crawls-tbody');
    if (!tbody) return;
    try {
      const rows = await jget('/crawls');
      if (!Array.isArray(rows) || rows.length === 0) {
        tbody.innerHTML = `<tr class="empty"><td colspan="7">no crawls yet</td></tr>`;
        return;
      }
      rows.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
      const html = [];
      for (const c of rows) {
        const st = c.status || 'unknown';
        const isClickable = Array.isArray(c.log) || c.crawlerId;
        const resumable = st === 'interrupted';
        html.push(`
          <tr class="${isClickable ? 'clickable' : ''}" data-id="${esc(c.crawlerId)}">
            <td>${esc(c.crawlerId)}</td>
            <td><span class="crawl-origin">${esc(c.origin || '—')}</span></td>
            <td class="num">${esc(String(c.k ?? '—'))}</td>
            <td>
              <span class="status-pill status-${esc(st)}">${esc(st)}</span>
              ${resumable ? `<a class="resume-link" data-resume="${esc(c.crawlerId)}">resume ▸</a>` : ''}
            </td>
            <td class="num">${esc(fmtNum(c.stats?.pagesCrawled ?? c.pagesCrawled ?? 0))}</td>
            <td>${esc(dateStr(c.startedAt))}</td>
            <td class="num">${esc(durationStr(c.startedAt, c.endedAt))}</td>
          </tr>
        `);
      }
      tbody.innerHTML = html.join('');
      bindCrawlRowClicks();
    } catch (e) {
      tbody.innerHTML = `<tr class="empty"><td colspan="7">error: ${esc(e.message || e)}</td></tr>`;
    }
  }

  function bindCrawlRowClicks() {
    $$('#crawls-tbody tr.clickable').forEach((tr) => {
      tr.addEventListener('click', async (ev) => {
        if (ev.target && ev.target.matches('[data-resume]')) return; // handled below
        const id = tr.dataset.id;
        await toggleCrawlLog(id, tr);
      });
    });
    $$('#crawls-tbody [data-resume]').forEach((a) => {
      a.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const id = a.dataset.resume;
        a.textContent = 'resuming…';
        try {
          await jpost(`/crawls/${encodeURIComponent(id)}/resume`, {});
          a.textContent = 'resumed ✓';
          setTimeout(refreshCrawls, 400);
        } catch (e) {
          a.textContent = 'failed';
        }
      });
    });
  }

  async function toggleCrawlLog(id, tr) {
    // Remove any existing log row after this tr
    const next = tr.nextElementSibling;
    if (next && next.classList.contains('log-row') && next.dataset.parent === id) {
      next.remove();
      state.expandedCrawl = null;
      return;
    }
    // Remove other open logs
    $$('.log-row').forEach((r) => r.remove());

    let crawl;
    try { crawl = await jget(`/crawls/${encodeURIComponent(id)}`); }
    catch (e) { return; }
    if (!crawl) return;

    const log = Array.isArray(crawl.log) ? crawl.log.slice(-200) : [];
    const logHtml = log.length
      ? log.map((l) => {
          const lvl = (l.level || 'info').toLowerCase();
          return `<div class="log-line level-${esc(lvl)}">
            <span class="log-ts">${esc(timeStr(l.ts))}</span>
            <span class="log-level">${esc(lvl.toUpperCase())}</span>
            <span class="log-msg">${esc(l.msg || '')}</span>
          </div>`;
        }).join('')
      : '<div class="log-line dim">no log entries</div>';

    const logRow = document.createElement('tr');
    logRow.className = 'log-row';
    logRow.dataset.parent = id;
    logRow.innerHTML = `<td colspan="7"><div class="log-box">${logHtml}</div></td>`;
    tr.insertAdjacentElement('afterend', logRow);
    state.expandedCrawl = id;
  }

  // ---------- boot -----------------------------------------------------------
  function init() {
    applyRoute();
    window.addEventListener('hashchange', applyRoute);

    bindLauncher();
    bindSearch();

    $('#crawls-refresh')?.addEventListener('click', () => void refreshCrawls());

    connectSse();
    void refreshStatus();
    scheduleStatusPoll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
