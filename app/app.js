// Sketch viewer: sidebar of sketches · infinite board of D2 / markdown tiles · chat relay to Claude.
const $ = (id) => document.getElementById(id);
const els = {
  list: $('sketch-list'), crumbs: $('crumbs'), notice: $('notice'), viewport: $('viewport'), world: $('world'), empty: $('empty'),
  onlyChanged: $('only-changed'), markSeen: $('mark-seen'), zoomIn: $('zoom-in'), zoomOut: $('zoom-out'), zoomFit: $('zoom-fit'),
  presence: $('presence'), presenceText: $('presence-text'), messages: $('messages'), composer: $('composer'), input: $('input'),
  composerTarget: $('composer-target'), tooltip: $('tooltip'), send: $('send'), theme: $('theme'),
};

const state = {
  root: '', // the sketches folder the server serves
  sketches: [],
  sketch: null, // the board on screen
  thread: null, // the chat on screen: a sketch name, or null for the new-sketch conversation
  unread: new Set(), // sketches with a Claude reply you haven't looked at
  board: null,
  presence: null,
  online: true,
  chat: [],
  pending: new Set(), // your message ids Claude hasn't answered
  view: { x: 40, y: 40, k: 1 },
  views: new Map(), // sketch -> view, so switching back keeps your place
  steps: new Map(), // tile key -> board index
  lastHashes: new Map(), // tile key -> hash at the previous render (for the arrival glow)
  onlyChanged: false,
  rects: new Map(), // node id -> laid-out rect
};

// ---------- API ----------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

// ---------- Helpers ----------

function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'style') n.style.cssText = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c);
  return n;
}
const md = (text) => DOMPurify.sanitize(marked.parse(text || ''));
const strHash = (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};
const PRESETS = { 1: 'var(--c1)', 2: 'var(--c2)', 3: 'var(--c3)', 4: 'var(--c4)', 5: 'var(--c5)', 6: 'var(--c6)' };
const colorOf = (c) => (c ? PRESETS[c] || c : null);
function ago(iso) {
  if (!iso) return '';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

// "Seen" hashes per sketch: tiles whose content differs show as changed until you mark the board seen
const seenKey = () => `sketch.seen.${state.root}/${state.sketch}`;
function loadSeen() {
  try {
    return JSON.parse(localStorage.getItem(seenKey()) || 'null');
  } catch {
    return null;
  }
}
function saveSeen(seen) {
  try {
    localStorage.setItem(seenKey(), JSON.stringify(seen));
  } catch {}
}

// ---------- Routing: /s/<sketch> · /new ----------

function parseRoute() {
  if (location.pathname === '/new') return { isNew: true };
  const m = location.pathname.match(/^\/s\/([^/]+)/);
  return m ? { sketch: decodeURIComponent(m[1]) } : {};
}
function routeTo(url, replace = false) {
  if (location.pathname !== url) history[replace ? 'replaceState' : 'pushState']({}, '', url);
}

// ---------- Sidebar ----------

async function loadSketches() {
  const { root, sketches } = await api('GET', '/api/sketches');
  state.root = root;
  state.sketches = sketches;
  renderSidebar();
}

function renderSidebar() {
  const working = state.presence?.job;
  els.list.replaceChildren(
    el('button', { class: `new-sketch${state.thread == null ? ' active' : ''}`, onclick: () => openNew() }, el('span', { class: 'plus' }, '+'), 'New sketch', working && working.sketch == null ? el('span', { class: 'dots small-dots' }, el('i'), el('i'), el('i')) : null),
    state.sketches.length
      ? el(
          'ul',
          { class: 'sketches' },
          state.sketches.map((s) =>
            el(
              'li',
              {},
              el(
                'a',
                {
                  href: `/s/${s.name}`,
                  class: s.name === state.thread ? 'active' : null,
                  onclick: (e) => {
                    e.preventDefault();
                    open(s.name);
                  },
                },
                el('span', { class: 'title' }, s.title || s.name, working?.sketch === s.name ? el('span', { class: 'dots small-dots' }, el('i'), el('i'), el('i')) : state.unread.has(s.name) ? el('span', { class: 'unread', title: 'New reply' }) : null),
                s.title ? el('span', { class: 'sub' }, s.name) : null,
              ),
            ),
          ),
        )
      : el('div', { class: 'none' }, 'No sketches yet'),
  );
}

// ---------- Open a sketch ----------

async function open(sketch, { replace = false } = {}) {
  if (state.sketch) state.views.set(state.sketch, { ...state.view });
  state.sketch = sketch || null;
  state.thread = state.sketch;
  state.unread.delete(sketch);
  state.board = null;
  state.lastHashes = new Map();
  routeTo(state.sketch ? `/s/${encodeURIComponent(state.sketch)}` : '/new', replace);
  renderSidebar();
  renderComposerTarget();
  await Promise.all([loadChat(), loadBoard({ fit: !state.views.has(sketch) })]);
}

// The new-sketch conversation: an empty board until Claude creates the sketch
function openNew({ replace = false } = {}) {
  return open(null, { replace }).then(() => els.input.focus());
}

// A sketch Claude is drawing for the new-sketch conversation: show the board, keep the chat where it is
async function showDraft(sketch) {
  state.sketch = sketch;
  state.board = null;
  state.lastHashes = new Map();
  await loadBoard({ fit: true });
}

// ---------- Board ----------

async function loadBoard({ fit = false } = {}) {
  els.crumbs.textContent = state.sketch || '';
  if (!state.sketch) {
    els.world.replaceChildren();
    els.empty.hidden = false;
    els.empty.innerHTML = `<div><div class="empty-mark">✎</div><b>New sketch</b><br>Describe a system in the chat. Claude draws it here as it goes.</div>`;
    els.onlyChanged.hidden = els.markSeen.hidden = true;
    return;
  }
  const sketch = state.sketch;
  let board;
  try {
    board = await api('GET', `/api/board?sketch=${encodeURIComponent(sketch)}`);
  } catch (err) {
    if (sketch !== state.sketch) return;
    els.world.replaceChildren();
    els.empty.hidden = false;
    els.empty.textContent = err.message;
    return;
  }
  if (sketch !== state.sketch) return; // switched meanwhile
  state.board = board;
  els.empty.hidden = true;
  renderBoard();
  if (fit) fitBoard();
  else if (state.views.has(sketch)) setView(state.views.get(sketch));
}

// Every node to show: the canvas's nodes, or an automatic layout when there is no board.canvas.
// vocab.md is always on the board, pinned top-left.
function boardNodes(b) {
  let nodes;
  if (b.canvas) nodes = b.canvas.nodes.map((n) => ({ ...n }));
  else {
    const files = Object.keys(b.tiles).filter((f) => f !== 'vocab.md');
    nodes = files.map((f, i) => ({ id: `auto-${f}`, type: 'file', file: f, x: 420 + (i % 2) * 740, y: i, width: 700, height: 100 })); // rows stack via the overlap pass
  }
  if (b.vocab && !nodes.some((n) => n.type === 'file' && n.file === 'vocab.md')) {
    const xs = nodes.map((n) => n.x);
    const ys = nodes.map((n) => n.y);
    nodes.unshift({ id: 'vocab', type: 'file', file: 'vocab.md', x: (xs.length ? Math.min(...xs) : 0) - 420, y: ys.length ? Math.min(...ys) : 0, width: 380, height: 300 });
  }
  for (const n of nodes) {
    for (const k of ['x', 'y', 'width', 'height']) n[k] = Number(n[k]) || 0;
    if (!n.width) n.width = 400;
    if (!n.height) n.height = 200;
  }
  return nodes;
}

const tileKey = (n) => (n.type === 'file' ? `file:${n.file}` : `${n.type}:${n.id}`);
const tileHash = (n, b) => (n.type === 'file' ? b.tiles[n.file]?.hash || 'missing' : strHash(`${n.text || ''}${n.url || ''}`));

function renderBoard() {
  const b = state.board;
  buildTermIndex();
  const nodes = boardNodes(b);
  const groups = nodes.filter((n) => n.type === 'group');
  const tiles = nodes.filter((n) => n.type !== 'group');

  // Change tracking
  let seen = loadSeen();
  const current = Object.fromEntries(tiles.map((n) => [tileKey(n), tileHash(n, b)]));
  if (!seen) saveSeen((seen = current)); // first visit: nothing is "changed"
  const changed = new Set(tiles.filter((n) => seen[tileKey(n)] !== current[tileKey(n)]).map(tileKey));
  const arrived = new Set(tiles.filter((n) => state.lastHashes.has(tileKey(n)) && state.lastHashes.get(tileKey(n)) !== current[tileKey(n)]).map(tileKey));
  state.lastHashes = new Map(Object.entries(current));
  els.onlyChanged.hidden = els.markSeen.hidden = !changed.size;
  els.onlyChanged.textContent = `${changed.size} changed${state.onlyChanged ? ' · showing' : ''}`;
  els.onlyChanged.classList.toggle('on', state.onlyChanged);
  if (!changed.size) state.onlyChanged = false;

  els.notice.hidden = !b.canvas_error;
  els.notice.textContent = b.canvas_error || '';

  // Tiles are sized by the canvas width; heights come from their content, then overlaps are pushed apart
  const tileEls = new Map();
  const frag = document.createDocumentFragment();
  for (const n of tiles) {
    const key = tileKey(n);
    const t = buildTile(n, b, { changed: changed.has(key), arrived: arrived.has(key) });
    t.style.left = `${n.x}px`;
    t.style.top = `${n.y}px`;
    t.style.width = `${n.width}px`;
    if (state.onlyChanged && !changed.has(key)) t.classList.add('dim');
    tileEls.set(n.id, t);
    frag.append(t);
  }
  const groupLayer = el('div', { class: 'groups' });
  const edgeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  edgeLayer.classList.add('edges');
  const labelLayer = el('div', { class: 'edge-labels' });
  els.world.replaceChildren(groupLayer, edgeLayer, labelLayer, frag);

  // Measure, then resolve overlaps (a tile taller than planned pushes the ones below it down)
  const rects = new Map();
  for (const n of tiles) rects.set(n.id, { x: n.x, y: n.y, w: n.width, h: tileEls.get(n.id).offsetHeight, y0: n.y });
  const order = [...tiles].sort((a, b2) => a.y - b2.y || a.x - b2.x);
  const placed = [];
  for (const n of order) {
    const r = rects.get(n.id);
    let moved = true;
    while (moved) {
      moved = false;
      for (const p of placed) {
        if (r.x < p.x + p.w && p.x < r.x + r.w && r.y < p.y + p.h + 24 && p.y < r.y + r.h) {
          r.y = p.y + p.h + 24;
          moved = true;
        }
      }
    }
    placed.push(r);
    tileEls.get(n.id).style.top = `${r.y}px`;
  }

  // Groups wrap the tiles that started inside them
  for (const g of groups) {
    const members = tiles.filter((n) => n.x + n.width / 2 >= g.x && n.x + n.width / 2 <= g.x + g.width && n.y + n.height / 2 >= g.y && n.y + n.height / 2 <= g.y + g.height);
    let r = { x: g.x, y: g.y, w: g.width, h: g.height };
    if (members.length) {
      const rs = members.map((m) => rects.get(m.id));
      const pad = 20;
      const x0 = Math.min(g.x, ...rs.map((q) => q.x - pad));
      const y0 = Math.min(g.y, ...rs.map((q) => q.y - pad - 22));
      const x1 = Math.max(...rs.map((q) => q.x + q.w + pad));
      const y1 = Math.max(...rs.map((q) => q.y + q.h + pad));
      r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    rects.set(g.id, r);
    const c = colorOf(g.color);
    groupLayer.append(
      el('div', { class: 'group', style: `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;${c ? `border-color:${c};` : ''}` }, g.label ? el('div', { class: 'group-label', style: c ? `color:${c}` : '' }, g.label) : null),
    );
  }
  state.rects = rects;
  drawEdges(b.canvas?.edges || [], rects, edgeLayer, labelLayer);
  linkVocab();
}

function buildTile(n, b, { changed, arrived }) {
  const key = tileKey(n);
  const c = colorOf(n.color);
  const isVocab = n.type === 'file' && n.file === 'vocab.md';
  const head = el('div', { class: 'tile-head' }, el('span', { class: 'name' }, isVocab ? 'Vocab' : n.type === 'file' ? n.file : n.type === 'link' ? 'link' : ''), changed ? el('span', { class: 'badge' }, 'changed') : null);
  const body = el('div', { class: 'tile-body' });
  const t = el('div', { class: 'tile', 'data-key': key, 'data-id': n.id, ...(c && { 'data-color': '', style: `--tile-color:${c}` }) }, head, body);
  if (isVocab) t.classList.add('vocab');
  if (changed) t.classList.add('changed');
  if (arrived) t.classList.add('pulse');

  if (n.type === 'text') {
    body.classList.add('prose');
    body.innerHTML = md(n.text);
  } else if (n.type === 'link') {
    body.append(el('a', { href: n.url, target: '_blank', rel: 'noopener' }, n.url));
  } else if (n.type === 'file') {
    const tile = b.tiles[n.file];
    if (n.error || !tile) {
      t.classList.add('error');
      body.append(el('div', { class: 'tile-error' }, n.error || `Not rendered: ${n.file}`));
    } else if (tile.error) {
      t.classList.add('error');
      body.append(el('div', { class: 'tile-error' }, tile.error.join('\n')));
    } else if (tile.kind === 'd2') {
      t.classList.add('d2');
      const boards = tile.boards;
      let idx = Math.min(state.steps.get(key) ?? 0, boards.length - 1);
      const show = () => {
        body.innerHTML = themed(boards[idx].svg);
        if (label) label.textContent = boards[idx].name ? boards[idx].name.replace(/^(\w+)\./, '$1 ') : 'base';
        linkVocab(body);
      };
      let label = null;
      if (boards.length > 1) {
        const step = (d) => (e) => {
          e.stopPropagation();
          idx = (idx + d + boards.length) % boards.length;
          state.steps.set(key, idx);
          show();
        };
        label = el('span');
        head.append(el('span', { class: 'steps' }, el('button', { class: 'ghost', title: 'Previous', onclick: step(-1), onpointerdown: (e) => e.stopPropagation() }, '◀'), label, el('button', { class: 'ghost', title: 'Next', onclick: step(1), onpointerdown: (e) => e.stopPropagation() }, '▶')));
      }
      show();
    } else if (tile.kind === 'md') {
      body.classList.add('prose');
      body.innerHTML = md(tile.text);
    } else {
      body.append(el('pre', {}, tile.text));
    }
  }
  return t;
}

// Edges between node rects: a curve from the facing sides (or the sides the canvas names)
function drawEdges(edges, rects, svg, labels) {
  const NS = 'http://www.w3.org/2000/svg';
  svg.innerHTML = '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>';
  let maxX = 0;
  let maxY = 0;
  for (const r of rects.values()) {
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  svg.setAttribute('width', maxX + 200);
  svg.setAttribute('height', maxY + 200);
  const anchor = (r, side) => ({ top: [r.x + r.w / 2, r.y, 0, -1], bottom: [r.x + r.w / 2, r.y + r.h, 0, 1], left: [r.x, r.y + r.h / 2, -1, 0], right: [r.x + r.w, r.y + r.h / 2, 1, 0] })[side];
  const facing = (a, b) => {
    const dx = b.x + b.w / 2 - (a.x + a.w / 2);
    const dy = b.y + b.h / 2 - (a.y + a.h / 2);
    if (Math.abs(dx) * 0.8 > Math.abs(dy)) return dx > 0 ? ['right', 'left'] : ['left', 'right'];
    return dy > 0 ? ['bottom', 'top'] : ['top', 'bottom'];
  };
  for (const e of edges) {
    const a = rects.get(e.fromNode);
    const b = rects.get(e.toNode);
    if (!a || !b) continue;
    const [fs, ts] = facing(a, b);
    const [x1, y1, nx1, ny1] = anchor(a, e.fromSide || fs);
    const [x2, y2, nx2, ny2] = anchor(b, e.toSide || ts);
    const d = Math.max(40, Math.hypot(x2 - x1, y2 - y1) / 3);
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', `M${x1},${y1} C${x1 + nx1 * d},${y1 + ny1 * d} ${x2 + nx2 * d},${y2 + ny2 * d} ${x2},${y2}`);
    if ((e.toEnd || 'arrow') === 'arrow') p.setAttribute('marker-end', 'url(#arrow)');
    if (e.fromEnd === 'arrow') p.setAttribute('marker-start', 'url(#arrow)');
    const c = colorOf(e.color);
    if (c) p.style.stroke = c;
    svg.append(p);
    if (e.label) {
      // Bezier midpoint (t = .5)
      const mx = (x1 + 3 * (x1 + nx1 * d) + 3 * (x2 + nx2 * d) + x2) / 8;
      const my = (y1 + 3 * (y1 + ny1 * d) + 3 * (y2 + ny2 * d) + y2) / 8;
      labels.append(el('div', { class: 'edge-label', style: `left:${mx}px;top:${my}px` }, e.label));
    }
  }
}

// ---------- Vocab linking: terms highlighted everywhere, definition on hover ----------

let termIndex = null; // { re, defs }
function buildTermIndex() {
  const terms = state.board?.vocab?.terms || [];
  if (!terms.length) return (termIndex = null);
  const defs = new Map(terms.map((t) => [t.term, t.def]));
  const esc = [...defs.keys()].sort((a, b) => b.length - a.length).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  termIndex = { re: new RegExp(`(?<![\\w])(${esc.join('|')})(?![\\w])`, 'g'), defs };
}

function linkVocab(root) {
  if (!root) {
    for (const body of els.world.querySelectorAll('.tile:not(.vocab) .tile-body')) linkVocab(body);
    return;
  }
  if (!termIndex || root.closest('.vocab')) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (t) => (t.parentElement?.closest('.term, style, script') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const hits = [];
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    termIndex.re.lastIndex = 0;
    if (termIndex.re.test(t.data)) hits.push(t);
  }
  for (const t of hits) {
    const parent = t.parentNode;
    const inSvg = parent.namespaceURI === 'http://www.w3.org/2000/svg';
    const frag = document.createDocumentFragment();
    let last = 0;
    t.data.replace(termIndex.re, (m, _g, i) => {
      if (i > last) frag.append(t.data.slice(last, i));
      const span = inSvg ? document.createElementNS('http://www.w3.org/2000/svg', 'tspan') : document.createElement('span');
      span.setAttribute('class', 'term');
      span.setAttribute('data-term', m);
      span.textContent = m;
      frag.append(span);
      last = i + m.length;
      return m;
    });
    if (last < t.data.length) frag.append(t.data.slice(last));
    parent.replaceChild(frag, t);
  }
}

document.addEventListener('pointerover', (e) => {
  const t = e.target.closest?.('[data-term]');
  if (!t || !termIndex) return void (els.tooltip.hidden = true);
  const term = t.getAttribute('data-term');
  els.tooltip.replaceChildren(el('b', {}, term), termIndex.defs.get(term) || '');
  els.tooltip.hidden = false;
  const r = t.getBoundingClientRect();
  els.tooltip.style.left = `${Math.min(r.left, innerWidth - 320)}px`;
  els.tooltip.style.top = `${r.bottom + 6}px`;
});

// ---------- Pan / zoom ----------

function setView(v) {
  state.view = { ...v };
  els.world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`;
  els.zoomFit.textContent = `${Math.round(v.k * 100)}%`;
}
const clampK = (k) => Math.min(4, Math.max(0.05, k));

function zoomAt(px, py, factor) {
  const v = state.view;
  const k = clampK(v.k * factor);
  setView({ k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k });
}

function fitRect(r, pad = 40) {
  const vw = els.viewport.clientWidth;
  const vh = els.viewport.clientHeight;
  const k = clampK(Math.min((vw - pad * 2) / r.w, (vh - pad * 2) / r.h, 1.5));
  setView({ k, x: (vw - r.w * k) / 2 - r.x * k, y: (vh - r.h * k) / 2 - r.y * k });
}

function fitBoard() {
  const rs = [...state.rects.values()];
  if (!rs.length) return setView({ x: 40, y: 40, k: 1 });
  const x0 = Math.min(...rs.map((r) => r.x));
  const y0 = Math.min(...rs.map((r) => r.y));
  const x1 = Math.max(...rs.map((r) => r.x + r.w));
  const y1 = Math.max(...rs.map((r) => r.y + r.h));
  fitRect({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
}

els.viewport.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const r = els.viewport.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.01));
    else setView({ ...state.view, x: state.view.x - e.deltaX, y: state.view.y - e.deltaY });
  },
  { passive: false },
);

let drag = null;
els.viewport.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('button, a')) return;
  drag = { x: e.clientX, y: e.clientY, vx: state.view.x, vy: state.view.y, moved: false };
  els.viewport.setPointerCapture(e.pointerId);
});
els.viewport.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 3) return;
  drag.moved = true;
  els.viewport.classList.add('panning');
  setView({ ...state.view, x: drag.vx + dx, y: drag.vy + dy });
});
const endDrag = () => {
  drag = null;
  els.viewport.classList.remove('panning');
};
els.viewport.addEventListener('pointerup', endDrag);
els.viewport.addEventListener('pointercancel', endDrag);

els.viewport.addEventListener('dblclick', (e) => {
  const t = e.target.closest('.tile');
  if (!t) return fitBoard();
  const r = state.rects.get(t.dataset.id);
  if (r) fitRect({ ...r, h: t.offsetHeight }, 30);
});

const centerZoom = (f) => zoomAt(els.viewport.clientWidth / 2, els.viewport.clientHeight / 2, f);
els.zoomIn.onclick = () => centerZoom(1.25);
els.zoomOut.onclick = () => centerZoom(0.8);
els.zoomFit.onclick = () => fitBoard();
document.addEventListener('keydown', (e) => {
  if (e.target.closest('textarea, input')) return;
  if (e.key === 'f' || e.key === 'F' || e.key === '0') fitBoard();
  else if (e.key === '+' || e.key === '=') centerZoom(1.25);
  else if (e.key === '-') centerZoom(0.8);
});

els.markSeen.onclick = () => {
  saveSeen(Object.fromEntries(state.lastHashes));
  state.onlyChanged = false;
  renderBoard();
};
els.onlyChanged.onclick = () => {
  state.onlyChanged = !state.onlyChanged;
  renderBoard();
};

// ---------- Chat relay ----------

async function loadChat() {
  try {
    const thread = state.thread;
    const { messages, pending } = await api('GET', `/api/chat${thread ? `?sketch=${encodeURIComponent(thread)}` : ''}`);
    if (thread !== state.thread) return; // switched meanwhile
    state.chat = messages;
    state.pending = new Set(pending);
  } catch {
    state.chat = [];
  }
  renderChat();
}

const SUGGESTIONS = ['Sketch a URL shortener', 'Sketch a ride-hailing dispatch system', 'Sketch a payments ledger'];
const BOARD_SUGGESTIONS = ['What is the riskiest fork here?', 'Zoom into the data schema', 'Simplify the HLD'];

function renderChat() {
  const p = state.presence;
  const connected = p?.listening || p?.job;
  const items = [];
  let prev = null;
  for (const m of state.chat) {
    const cont = prev && prev.author === m.author && Date.parse(m.at) - Date.parse(prev.at) < 5 * 60_000;
    const pending = state.pending.has(m.id);
    const tag = m.sketch && m.sketch !== state.thread ? el('a', { class: 'chip', href: `/s/${m.sketch}`, onclick: (e) => (e.preventDefault(), open(m.sketch)) }, m.sketch) : null;
    const meta = el('div', { class: 'meta' }, pending ? (connected ? 'sent' : 'queued') : ago(m.at), tag);
    items.push(
      el(
        'div',
        { class: `msg ${m.author}${cont ? ' cont' : ''}${pending ? ' pending' : ''}` },
        m.author === 'claude' ? el('span', { class: 'who' }, '✳︎') : null,
        el('div', { class: 'msg-body' }, el('div', { class: 'text prose', html: md(m.text) }), meta),
      ),
    );
    prev = m;
  }
  if (p?.job && (p.job.sketch ?? null) === state.thread) items.push(el('div', { class: 'typing' }, el('span', { class: 'who' }, '✳︎'), el('span', { class: 'dots' }, el('i'), el('i'), el('i')), `Sketching${p.job.sketch ? ` ${p.job.sketch}` : ''}`));

  const connectHint = el('div', { class: 'connect', html: state.online ? 'Claude isn\'t connected. Run <code>/sketch</code> in Claude Code in this repo.' : 'The sketch server is offline. Run <code>npm start</code>.' });
  if (!state.chat.length && !p?.job) {
    const ideas = state.thread ? BOARD_SUGGESTIONS : SUGGESTIONS;
    items.push(
      el(
        'div',
        { class: 'chat-empty' },
        el('div', { class: 'mark' }, '✳︎'),
        el('h3', {}, 'Sketch with Claude'),
        el('p', {}, state.thread ? 'React to the board, or ask for a change. Claude resketches it live.' : 'Describe a system. Claude draws the vocab, HLD and a lean LLD.'),
        el('div', { class: 'suggestions' }, ideas.map((t) => el('button', { type: 'button', onclick: () => fillInput(t) }, t))),
        connected ? null : connectHint,
      ),
    );
  } else if (!connected) {
    items.push(connectHint);
  }
  els.messages.replaceChildren(...items);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function renderPresence() {
  const p = state.presence;
  els.presence.className = `status ${p?.job ? 'busy' : p?.listening ? 'live' : ''}`;
  els.presenceText.textContent = !state.online ? 'server offline' : !p ? 'offline' : p.job ? 'sketching…' : p.listening ? 'listening' : 'not connected';
}

function renderComposerTarget() {
  els.composerTarget.textContent = state.thread ? `✎ ${state.thread}` : '+ new sketch';
  els.composerTarget.title = state.thread ? `Messages are about ${state.thread}` : 'Claude will start a new sketch';
}

function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 160)}px`;
  els.send.disabled = !els.input.value.trim();
}
function fillInput(text) {
  els.input.value = text;
  autosize();
  els.input.focus();
}

els.composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text) return;
  els.input.value = '';
  autosize();
  try {
    const m = await api('POST', '/api/chat', { text, sketch: state.thread });
    state.pending.add(m.id);
    if (!state.chat.some((x) => x.id === m.id)) state.chat.push(m);
    renderChat();
  } catch (err) {
    fillInput(text);
    alert(err.message);
  }
});
els.input.addEventListener('input', autosize);
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    els.composer.requestSubmit();
  }
});

// ---------- Theme: auto (system) → light → dark ----------

const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const THEMES = ['auto', 'light', 'dark'];
let theme = 'auto';
try {
  theme = THEMES.includes(localStorage.getItem('sketch.theme')) ? localStorage.getItem('sketch.theme') : 'auto';
} catch {}
const isDark = () => (theme === 'auto' ? darkQuery.matches : theme === 'dark');

// D2 SVGs switch to their dark theme with a prefers-color-scheme media query; pin it to the chosen theme
const themed = (svg) => svg.replace(/@media screen and \(prefers-color-scheme:\s*dark\)/g, isDark() ? '@media all' : '@media not all');

function applyTheme() {
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  els.theme.textContent = { auto: '◐', light: '☀︎', dark: '☾' }[theme];
  els.theme.title = `Theme: ${theme} (click to change)`;
  if (state.board) renderBoard();
}
els.theme.onclick = () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  try {
    localStorage.setItem('sketch.theme', theme);
  } catch {}
  applyTheme();
};
darkQuery.addEventListener('change', () => theme === 'auto' && applyTheme());
applyTheme();

// ---------- Live updates ----------

function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('presence', (e) => {
    state.presence = JSON.parse(e.data);
    renderPresence();
    renderChat();
    renderSidebar();
  });
  es.addEventListener('chat', (e) => {
    const { sketch, message, from_new } = JSON.parse(e.data);
    // Claude named the sketch it made from the new-sketch conversation: the chat follows it there
    if (from_new && state.thread == null) {
      state.pending.clear();
      return void open(sketch);
    }
    if ((sketch ?? null) !== state.thread) {
      if (message.author === 'claude' && sketch) {
        state.unread.add(sketch);
        renderSidebar();
      }
      return;
    }
    if (!state.chat.some((m) => m.id === message.id)) state.chat.push(message);
    if (message.author === 'claude') state.pending.clear();
    renderChat();
  });
  es.addEventListener('sketch_changed', (e) => {
    const { sketch } = JSON.parse(e.data);
    if (sketch === state.sketch) loadBoard();
  });
  es.addEventListener('sketches_changed', () => {
    const before = new Set(state.sketches.map((s) => s.name));
    loadSketches().then(() => {
      // In the new-sketch conversation, a sketch that just appeared is the one Claude is drawing: show it live
      const fresh = state.sketches.find((s) => !before.has(s.name));
      if (fresh && state.thread == null && state.presence?.job?.sketch == null) showDraft(fresh.name);
    });
  });
  es.onerror = () => {
    state.online = false;
    renderPresence();
    renderChat();
  };
  es.onopen = () => {
    const wasOffline = !state.online;
    state.online = true;
    renderPresence();
    if (wasOffline) loadSketches().then(() => Promise.all([loadChat(), loadBoard()]));
    else renderChat();
  };
}

addEventListener('popstate', () => {
  const r = parseRoute();
  r.sketch ? open(r.sketch, { replace: true }) : openNew({ replace: true });
});

// ---------- Start ----------

await loadSketches();
const r = parseRoute();
if (r.sketch) await open(r.sketch, { replace: true });
else if (!r.isNew && state.sketches.length) await open(state.sketches[0].name, { replace: true });
else await openNew({ replace: true });
connectEvents();
setInterval(renderPresence, 30_000);
