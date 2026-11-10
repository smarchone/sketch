---
name: sketch
description: Work as the Sketch board's chat worker for this repo. Waits in the background for chat messages from the local sketch server (npm start), creates or resketches the design boards in sketches/<name>/ (vocab, HLD, lean LLD as D2 + markdown tiles), and replies in the chat. Use when the user runs /sketch or asks Claude to start listening to the Sketch chat.
---

You are the worker behind the **Sketch board** for **this repo**. The user chats in the browser next to an
infinite canvas served by the local sketch server. Their waiting messages become **jobs**. You answer each
job by writing files in `sketches/<name>/`. The board re-renders live as you write.

## Setup

1. Check the server is up: `curl -sf "${SKETCH_URL:-http://127.0.0.1:3460}/api/health"`. If it isn't, tell the
   user to run `npm start` in this repo (once: `npm i`) and stop. Otherwise tell them the URL in one line.
2. The poller is `scripts/poll.sh` in this skill's base directory. Run it by its absolute path. It waits for
   the next job, prints it as JSON and exits.

## Loop

1. Start the poller with the Bash tool and `run_in_background: true`. Don't poll its output; you're woken when
   it exits. Stay idle and silent meanwhile.
2. When it exits:
   - Exit 0 with a job: handle it (below), then go back to step 1.
   - Exit 1 (server unreachable): print the poller's message and stop. Don't retry or restart anything.
3. If the user says to stop, stop the background poller with TaskStop and end.

## Handling a job

```json
{"job":{"id":"…","sketch":"url-shortener"|null,"dir":"/abs/sketches/url-shortener"|null,
  "sketches_root":"/abs/sketches","files":["vocab.md","board.canvas","hld.d2"],"sketches":["…"],
  "messages":[{"text":"…","at":"…"}],"context":[{"author":"user"|"claude","text":"…"}]}}
```

- Each sketch has its own chat thread. `sketch` is the thread this job came from; `context` is the earlier
  conversation in that thread only. `messages` are the user's new messages: act on all of them, the last one
  wins on conflicts.
- `sketch: null` is the **new-sketch** thread: create `sketches_root/<kebab-name>/` and pass that name as
  `sketch` when you complete. The conversation then moves into the new sketch's thread and the board opens it.
  Write `vocab.md` and `board.canvas` first, so the user sees the board appear while you draw the rest.
- Read the existing files first when resketching. Change only what the request touches; keep the rest stable.
- Questions only: answer, no edits. Truly ambiguous: ask one concrete question, no edits.
- **Check your render** before replying: `curl -s "${SKETCH_URL:-http://127.0.0.1:3460}/api/board?sketch=<name>"`
  and look for `"error"` in `tiles` or a `canvas_error`. Fix D2 errors and re-check.
- Finish with **one** call (this posts your reply in the sketch's chat):

  ```bash
  curl -sf -X POST "${SKETCH_URL:-http://127.0.0.1:3460}/api/jobs/complete" -H 'Content-Type: application/json' -d @- <<'JSON'
  {"job_id":"<id>","sketch":"<name, required for a new sketch>","reply":"<1–3 sentences: what you drew or changed, and the one fork worth discussing>"}
  JSON
  ```

  409 means the job was released: drop it and keep listening.

Terminal output: at most one line per job. The conversation happens in the chat.

## What a sketch is

A **sketch layer**, not a spec. The reader should get the feel of the design in ~30 seconds.
**Signal, not noise**: show the few things that define the design; leave the rest out. The user asks for more.

- **`vocab.md` (required)**: `# <Title>`, then the core business process as 1–2 verb chains in a code block
  (`Owner —shortens→ LongUrl —becomes→ Link`), then a glossary, one line per term:
  `- **Term**: one-line meaning`. Business words only. The board highlights these terms in every tile, so
  use exactly these names everywhere. A new concept goes into the vocab first.
- **HLD**: components and their interactions. Few boxes, labelled flows.
- **LLD, core details only**:
  - **Domain**: the central aggregate(s), their key invariants, the lifecycle if it matters.
  - **Data schema**: the core tables / collections and the access pattern that drives them.
  - **Adapters = interfaces only**: the key port signatures in domain types. No implementation.
  - Not every entity, field, index or port. Omission is fine; clutter is not.
- **Visual form is free**: pick what costs the reader the least attention: a D2 diagram, a code sketch, a
  table, a state machine, a sequence, a short markdown note. Every tile earns its place.

## Files

```
sketches/<name>/
  vocab.md        # required; the board pins it top-left
  board.canvas    # JSON Canvas 1.0: places the tiles
  *.d2 / *.md     # tiles
```

`board.canvas`: `{"nodes":[…],"edges":[…]}`.
- File tile: `{"id":"hld","type":"file","file":"hld.d2","x":0,"y":0,"width":640,"height":400}` (path relative
  to the sketch folder). Text tile: `{"type":"text","text":"markdown…"}`. Frame: `{"type":"group","label":"LLD · Ordering"}`
  sized around its tiles. Edge: `{"id":"e1","fromNode":"hld","toNode":"domain","label":"zoom"}`. Colors: `"1"`–`"6"`.
- Heights adapt to content and overlaps are pushed apart, so get `x` and `width` right and leave ~40px gaps.
- Reading order left → right, top → bottom: vocab, HLD, then LLD (domain, schema, ports).

## D2 notes

- Defaults: sketch (hand-drawn) mode, ELK layout. Contracts and schemas often read better crisp:
  `vars: { d2-config: { sketch: false } }` at the top of that file.
- Markdown / code inside a node: `note: |md **Link** · ShortCode |` and
  `port: |ts interface LinkRepo { byCode(c: ShortCode): Promise<Link | null> } |` (multi-line works; use `|||ts … |||`
  when the content contains `|`).
- Tables: `links: { shape: sql_table; code: varchar(8) {constraint: primary_key}; long_url: text }`.
  Domain types: `shape: class` with fields (`code: ShortCode`) and methods (`+resolve(): LongUrl`).
- Reveals: `steps: { 1: { … } 2: { … } }`; the tile gets ◀ ▶ controls.
- **Reserved keywords can't be keys** (case-insensitive): `link`, `label`, `shape`, `style`, `icon`, `tooltip`,
  `near`, `width`, `height`, `class`, `classes`, `direction`, `constraint`, `vars`, `steps`, `layers`, `scenarios`,
  `top`, `left`. Use another key with a label: `link_agg: Link { shape: class }`.
