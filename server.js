// Sketch server: serves this repo's sketches/ folder as live boards, plus a chat relay to a Claude Code session.
// Each sketch is sketches/<name>/ (vocab.md, board.canvas, *.d2, *.md, and its chat in .chat.json).
//
//   npm start                      (PORT=3460, SKETCHES=./sketches by default)
import http from 'node:http';
import fs from 'node:fs';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { D2 } from '@d2lang/d2';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3460;
const ROOT = path.resolve(process.env.SKETCHES || path.join(HERE, 'sketches'));
const APP_DIR = path.join(HERE, 'app');
const RELAY_DIR = path.join(ROOT, '.relay');
const TILE_EXT = /\.(d2|md|markdown|canvas)$/i;
const NAME_OK = /^[a-z0-9][a-z0-9._-]*$/i;

fs.mkdirSync(ROOT, { recursive: true });

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);

async function readText(abs) {
  try {
    return await readFile(abs, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') return null;
    throw err;
  }
}

// ---------- Live updates (SSE) ----------

const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

// ---------- D2 rendering (WASM, in-process), cached by content ----------

let d2 = null;
const getD2 = () => (d2 ||= new D2());
const renderCache = new Map(); // key -> Promise<result>

// D2's errors come back as a JSON array of { range, errmsg }
function d2Errors(err) {
  const raw = String(err?.message || err);
  try {
    return JSON.parse(raw).map((e) => e.errmsg);
  } catch {
    return [raw];
  }
}

function renderD2(file, content, allD2) {
  // Imports (@file) need the sketch's other .d2 files, so only then do they join the cache key
  const usesImports = /(^|\s)\.{0,3}@/m.test(content);
  const key = hash(file + '\0' + content + (usesImports ? JSON.stringify(allD2) : ''));
  if (!renderCache.has(key)) {
    renderCache.set(key, doRender(file, content, usesImports ? allD2 : { [file]: content }, key));
    if (renderCache.size > 400) renderCache.delete(renderCache.keys().next().value);
  }
  return renderCache.get(key);
}

async function doRender(file, content, fsMap, salt) {
  const started = Date.now();
  const explicitSketch = content.match(/\bsketch\s*:\s*(true|false)\b/);
  const sketch = explicitSketch ? explicitSketch[1] === 'true' : true; // default: hand-drawn
  const options = /layout-engine\s*:/.test(content) ? {} : { layout: 'elk' };
  const engine = getD2();
  try {
    const r = await engine.compile({ fs: fsMap, inputPath: file, options });
    const opts = { ...r.renderOptions, sketch, themeID: 0, darkThemeID: 200, noXMLTag: true, pad: 20, scale: 1, salt };
    for (const k of Object.keys(opts)) if (opts[k] === null) delete opts[k];
    const boards = [{ name: null, svg: await engine.render(r.diagram, opts) }];
    // Steps / layers / scenarios become extra boards the tile can step through
    for (const kind of ['steps', 'layers', 'scenarios']) {
      for (const b of r.diagram[kind] || []) {
        if (!b?.name) continue;
        boards.push({ name: `${kind}.${b.name}`, svg: await engine.render(r.diagram, { ...opts, target: `${kind}.${b.name}` }) });
      }
    }
    return { kind: 'd2', boards, ms: Date.now() - started };
  } catch (err) {
    if (/disposed|worker/i.test(String(err?.message))) d2 = null; // recreate a crashed worker next time
    return { kind: 'd2', error: d2Errors(err), ms: Date.now() - started };
  }
}

// ---------- Vocab: glossary terms for linking ----------

// Glossary lines look like "- **Term**: definition" (also "**Term** — definition", or a "| Term | def |" table row)
function parseVocab(text) {
  const terms = [];
  for (const line of (text || '').split('\n')) {
    let m = line.match(/^\s*(?:[-*+]\s+)?\*\*([^*]{1,60})\*\*\s*[:—–-]?\s*(.+)$/);
    if (!m) m = line.match(/^\s*\|\s*\**([A-Za-z][\w ·.-]{0,40}?)\**\s*\|\s*([^|]+?)\s*\|\s*$/);
    if (!m) continue;
    const term = m[1].trim();
    if (/^(term|name|word)$/i.test(term) || /^-+$/.test(m[2].trim())) continue; // table header / divider
    terms.push({ term, def: m[2].trim() });
  }
  return terms;
}

// ---------- Sketches on disk ----------

function sketchDir(name) {
  if (typeof name !== 'string' || !NAME_OK.test(name)) throw httpError(400, 'sketch must be a folder name (letters, digits, . _ -)');
  return path.join(ROOT, name);
}

// A file inside a sketch folder; canvas paths may also be written from the repo or sketches root
function tilePath(sketch, rel) {
  const dir = sketchDir(sketch);
  let clean = String(rel || '').replace(/^\/+/, '');
  for (const prefix of [`sketches/${sketch}/`, `${sketch}/`]) if (clean.startsWith(prefix)) clean = clean.slice(prefix.length);
  const abs = path.resolve(dir, clean);
  if (!abs.startsWith(dir + path.sep)) throw httpError(400, `Path is outside the sketch: ${rel}`);
  return { rel: path.relative(dir, abs).split(path.sep).join('/'), abs };
}

async function listFiles(dir) {
  const out = [];
  async function walk(d) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || out.length >= 200) continue;
      if (e.isDirectory()) await walk(path.join(d, e.name));
      else if (TILE_EXT.test(e.name)) out.push(path.relative(dir, path.join(d, e.name)).split(path.sep).join('/'));
    }
  }
  await walk(dir);
  return out.sort();
}

async function listSketches() {
  let entries = [];
  try {
    entries = await readdir(ROOT, { withFileTypes: true });
  } catch {}
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || !NAME_OK.test(e.name)) continue;
    const dir = path.join(ROOT, e.name);
    const files = await listFiles(dir);
    let updated = 0;
    for (const f of files) updated = Math.max(updated, (await stat(path.join(dir, f)).catch(() => null))?.mtimeMs || 0);
    const vocab = await readText(path.join(dir, 'vocab.md'));
    const title = vocab?.match(/^#\s+(.+)$/m)?.[1]?.trim() || null;
    out.push({ name: e.name, title, files: files.length, updated: updated || null });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- Board: canvas + rendered tiles ----------

async function board(sketch) {
  const dir = sketchDir(sketch);
  if (!fs.existsSync(dir)) throw httpError(404, `No sketch ${sketch}`);
  const files = await listFiles(dir);
  const contents = {};
  for (const f of files) contents[f] = await readText(path.join(dir, f));
  const allD2 = Object.fromEntries(Object.entries(contents).filter(([f, c]) => f.endsWith('.d2') && c != null));

  let canvas = null;
  let canvasError = null;
  if (contents['board.canvas'] != null) {
    try {
      canvas = JSON.parse(contents['board.canvas']);
      canvas.nodes = Array.isArray(canvas.nodes) ? canvas.nodes : [];
      canvas.edges = Array.isArray(canvas.edges) ? canvas.edges : [];
    } catch (err) {
      canvasError = `board.canvas is not valid JSON: ${err.message}`;
    }
  }

  // Tiles: every file the canvas points at (or every tile file, when there is no usable canvas)
  const wanted = new Set();
  if (canvas) {
    for (const n of canvas.nodes) {
      if (n.type !== 'file' || !n.file) continue;
      try {
        n.file = tilePath(sketch, n.file).rel; // normalise to sketch-relative
        wanted.add(n.file);
      } catch (err) {
        n.error = err.message;
      }
    }
  } else {
    for (const f of files) if (f !== 'board.canvas') wanted.add(f);
  }
  if (contents['vocab.md'] != null) wanted.add('vocab.md');

  const tiles = {};
  await Promise.all(
    [...wanted].map(async (f) => {
      const content = contents[f] ?? (await readText(tilePath(sketch, f).abs));
      if (content == null) return (tiles[f] = { kind: 'missing', hash: 'missing', error: [`File not found: ${f}`] });
      if (f.endsWith('.d2')) tiles[f] = { ...(await renderD2(f, content, allD2)), hash: hash(content) };
      else tiles[f] = { kind: /\.(md|markdown)$/i.test(f) ? 'md' : 'text', text: content, hash: hash(content) };
    }),
  );

  return {
    sketch,
    dir,
    canvas,
    canvas_error: canvasError,
    files,
    tiles,
    vocab: contents['vocab.md'] != null ? { file: 'vocab.md', terms: parseVocab(contents['vocab.md']) } : null,
  };
}

// ---------- Chat relay: one thread per sketch, one job at a time for the sketching Claude session ----------
//
// A thread is a sketch's conversation, kept in sketches/<name>/.chat.json. The "new sketch" thread (no board
// yet) is sketches/.relay/new.json; when Claude names the sketch it created, that conversation moves into it.
//
// GET  /api/jobs/next?timeout=300  long-poll; claims the waiting messages of one thread (oldest first) as a job
// POST /api/jobs/complete          { job_id, reply, sketch? } posts Claude's reply (sketch: the board it worked on)
// POST /api/jobs/release           { job_id? } gives the messages back without replying

const NEW = ''; // thread key of the "new sketch" conversation
const threadFile = (key) => (key === NEW ? path.join(RELAY_DIR, 'new.json') : path.join(sketchDir(key), '.chat.json'));
const threads = new Map(); // key -> { messages: [{ id, author: 'you'|'claude', text, at, sketch?, handled?, job? }] }

async function loadThread(key) {
  if (threads.has(key)) return threads.get(key);
  let t;
  try {
    t = JSON.parse(await readFile(threadFile(key), 'utf8'));
  } catch {
    t = { messages: [] };
  }
  for (const m of t.messages) delete m.job; // a job from a previous server run is gone
  threads.set(key, t);
  return t;
}
async function saveThread(key) {
  const file = threadFile(key);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(threads.get(key), null, 2));
}
const threadKey = (sketch) => (sketch == null || sketch === '' ? NEW : (sketchDir(sketch), sketch));
const publicMessage = ({ job: _j, ...m }) => m;
const waitingIn = (t) => t.messages.filter((m) => m.author === 'you' && !m.handled && !m.job);

// Every thread on disk: the new-sketch one plus one per sketch folder
async function allThreads() {
  const keys = [NEW, ...(await listSketches()).map((s) => s.name)];
  return Promise.all(keys.map(async (k) => [k, await loadThread(k)]));
}

// One-time move from the old single chat.json into per-sketch threads
async function migrateChat() {
  const old = path.join(RELAY_DIR, 'chat.json');
  let data;
  try {
    data = JSON.parse(await readFile(old, 'utf8'));
  } catch {
    return;
  }
  const byKey = new Map();
  for (const m of data.messages || []) {
    let key = NEW;
    try {
      if (m.sketch && fs.existsSync(sketchDir(m.sketch))) key = m.sketch;
    } catch {}
    delete m.job;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(m);
  }
  for (const [key, msgs] of byKey) {
    const t = await loadThread(key);
    t.messages = [...msgs, ...t.messages];
    await saveThread(key);
  }
  fs.renameSync(old, `${old}.migrated`);
  console.log(`Moved ${data.messages?.length || 0} chat messages into per-sketch threads (old file kept as chat.json.migrated)`);
}

let job = null; // { id, thread, message_ids, claimed_at }
let lastClaudeActivity = 0;
let waiters = [];

function wake() {
  for (const w of waiters.slice()) w();
}
function claudeActed() {
  lastClaudeActivity = Date.now();
  broadcastPresence();
}
function presence() {
  return {
    listening: waiters.length > 0,
    last_claude_at: lastClaudeActivity || null,
    job: job && { id: job.id, sketch: job.thread || null, messages: job.message_ids.length },
  };
}
function broadcastPresence() {
  broadcast('presence', presence());
}

async function claimJob() {
  if (job) return job;
  let pick = null;
  for (const [key, t] of await allThreads()) {
    const pending = waitingIn(t);
    if (pending.length && (!pick || pending[0].at < pick.pending[0].at)) pick = { key, t, pending };
  }
  if (!pick) return null;
  job = { id: randomUUID().slice(0, 8), thread: pick.key, message_ids: pick.pending.map((m) => m.id), claimed_at: new Date().toISOString() };
  for (const m of pick.pending) m.job = job.id;
  await saveThread(pick.key);
  broadcastPresence();
  return job;
}

async function jobView(j) {
  const t = await loadThread(j.thread);
  const mine = t.messages.filter((m) => j.message_ids.includes(m.id));
  const firstIdx = t.messages.indexOf(mine[0]);
  const context = t.messages.slice(Math.max(0, firstIdx - 12), firstIdx).map((m) => ({ author: m.author === 'you' ? 'user' : 'claude', text: m.text }));
  const sketch = j.thread || null;
  const dir = sketch ? sketchDir(sketch) : null;
  return {
    job: {
      id: j.id,
      sketch,
      dir,
      sketches_root: ROOT,
      files: dir ? await listFiles(dir) : [],
      sketches: (await listSketches()).map((s) => s.name),
      messages: mine.map((m) => ({ text: m.text, at: m.at })),
      context,
    },
  };
}

function waitForWake(timeoutSec, signal) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      waiters = waiters.filter((w) => w !== done);
      broadcastPresence();
      resolve();
    };
    const timer = setTimeout(done, Math.min(timeoutSec, 300) * 1000);
    waiters.push(done);
    signal?.addEventListener('abort', done, { once: true });
    broadcastPresence();
  });
}

// The poller's session closed: it's gone, not "recently active"
function pollerGone() {
  if (!job) lastClaudeActivity = 0;
  broadcastPresence();
}

async function nextJob(timeoutSec, signal) {
  if (signal?.aborted) return pollerGone();
  claudeActed();
  let j = await claimJob();
  if (!j && timeoutSec > 0) {
    await waitForWake(timeoutSec, signal);
    if (signal?.aborted) return pollerGone();
    j = await claimJob();
  }
  if (j && signal?.aborted) {
    if (job?.id === j.id) await endJob(j, null);
    return pollerGone();
  }
  claudeActed();
  return j ? jobView(j) : { job: null };
}

function currentJob(jid) {
  if (!job) throw httpError(409, 'No job in progress. Poll /api/jobs/next for the next one.');
  if (jid && jid !== job.id) throw httpError(409, `Job ${jid} is no longer active (it was released). Poll /api/jobs/next again.`);
  return job;
}

// reply = null: give the messages back unanswered.
// A new-sketch job answered with a sketch name moves that conversation into the sketch's own thread.
async function endJob(j, reply, sketch) {
  const t = await loadThread(j.thread);
  for (const m of t.messages) {
    if (!j.message_ids.includes(m.id)) continue;
    delete m.job;
    if (reply != null) m.handled = true;
  }
  let key = j.thread;
  let moved = false;
  if (reply != null && j.thread === NEW && sketch && fs.existsSync(sketchDir(sketch))) {
    // Everything up to this job's last message is this sketch's conversation; later messages stay
    const last = t.messages.findLastIndex((m) => j.message_ids.includes(m.id));
    const convo = t.messages.splice(0, last + 1);
    await saveThread(NEW);
    const target = await loadThread(sketch);
    target.messages.push(...convo);
    key = sketch;
    moved = true;
  }
  let msg = null;
  if (reply != null) {
    msg = { id: randomUUID().slice(0, 8), author: 'claude', text: reply, at: new Date().toISOString(), ...(sketch && sketch !== key && { sketch }) };
    (await loadThread(key)).messages.push(msg);
  }
  job = null;
  await saveThread(key);
  if (msg) broadcast('chat', { sketch: key || null, message: publicMessage(msg), ...(moved && { from_new: true }) });
  claudeActed();
  wake(); // messages that arrived meanwhile can be claimed right away
}

// ---------- Watch sketches/ for changes (Claude's edits, git, an IDE) ----------

const timers = new Map();
try {
  fs.watch(ROOT, { recursive: true }, (_type, filename) => {
    if (!filename) return;
    const parts = filename.split(path.sep);
    const sketch = parts[0];
    if (!sketch || sketch.startsWith('.') || !NAME_OK.test(sketch)) return;
    if (parts.length > 1 && !TILE_EXT.test(filename)) return;
    clearTimeout(timers.get(sketch));
    timers.set(
      sketch,
      setTimeout(() => {
        timers.delete(sketch);
        broadcast('sketch_changed', { sketch });
        broadcast('sketches_changed', {});
        if (job) claudeActed();
      }, 120),
    );
  });
} catch (err) {
  console.warn('File watching unavailable:', err.message);
}

// ---------- Routes ----------

const routes = {
  'GET /api/sketches': async () => ({ root: ROOT, sketches: await listSketches() }),

  'GET /api/board': async (q) => board(q.get('sketch')),

  // ?sketch=<name> for a board's thread; no sketch for the new-sketch thread
  'GET /api/chat': async (q) => {
    const t = await loadThread(threadKey(q.get('sketch')));
    return { messages: t.messages.slice(-200).map(publicMessage), pending: waitingIn(t).map((m) => m.id) };
  },

  'POST /api/chat': async (_q, b) => {
    const text = String(b.text || '').trim();
    if (!text) throw httpError(400, 'text is required');
    const key = threadKey(b.sketch);
    if (key !== NEW && !fs.existsSync(sketchDir(key))) throw httpError(404, `No sketch ${key}`);
    const t = await loadThread(key);
    const msg = { id: randomUUID().slice(0, 8), author: 'you', text, at: new Date().toISOString() };
    t.messages.push(msg);
    await saveThread(key);
    broadcast('chat', { sketch: key || null, message: publicMessage(msg) });
    wake();
    return publicMessage(msg);
  },

  'GET /api/jobs/next': async (q, _b, signal) => nextJob(Number(q.get('timeout') ?? 300), signal),

  'GET /api/jobs/current': async () => (job ? jobView(job) : { job: null }),

  'POST /api/jobs/complete': async (_q, b) => {
    const j = currentJob(b.job_id);
    const reply = String(b.reply || '').trim();
    if (!reply) throw httpError(400, 'reply is required');
    if (b.sketch != null) sketchDir(b.sketch);
    await endJob(j, reply, b.sketch);
    return { ok: true };
  },

  'POST /api/jobs/release': async (_q, b) => {
    if (!job) return { ok: true };
    await endJob(currentJob(b.job_id), null);
    return { ok: true };
  },

  'GET /api/presence': async () => presence(),

  'GET /api/health': async () => ({ ok: true, pid: process.pid, root: ROOT }),
};

// ---------- HTTP ----------

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Only talk to local tools: a localhost Host header (no DNS rebinding) and JSON bodies (no cross-site POSTs)
const LOCAL_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (!LOCAL_HOST.test(req.headers.host || '')) return send(res, 403, { error: 'Forbidden host' });
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: presence\ndata: ${JSON.stringify(presence())}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) return send(res, 404, { error: 'Not found' });
      if (req.method !== 'GET' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
        return send(res, 415, { error: 'Send JSON (Content-Type: application/json)' });
      }
      const body = req.method === 'GET' ? {} : await readBody(req);
      // Aborts when the client hangs up before we answer (e.g. a long-poll whose Claude session closed)
      const hangup = new AbortController();
      res.on('close', () => res.writableFinished || hangup.abort());
      const result = await route(url.searchParams, body, hangup.signal);
      if (hangup.signal.aborted) return;
      return send(res, 200, result);
    }
    if (req.method !== 'GET') return send(res, 404, { error: 'Not found' });
    // Deep links (/s/<sketch>, /new) are the app itself
    const page = url.pathname === '/' || url.pathname === '/new' || url.pathname.startsWith('/s/') ? '/index.html' : url.pathname;
    const file = path.normalize(path.join(APP_DIR, page));
    if (!file.startsWith(APP_DIR + path.sep)) return send(res, 403, { error: 'Forbidden' });
    const data = await readFile(file).catch(() => null);
    if (!data) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': `${MIME[path.extname(file)] || 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch (err) {
    send(res, err.status || 500, { error: err.message });
  }
});

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use (is the sketch server already running?)` : err.message);
  process.exit(1);
});

await migrateChat();

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Sketch server at http://127.0.0.1:${PORT}`);
  console.log(`Serving ${ROOT}`);
});
