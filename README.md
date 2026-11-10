# Sketch

**A whiteboard for system design that Claude (or any local coding agent) draws and you react to.**

Describe a system in the chat. Claude, working in your repo, sketches it as a board: the business vocab,
an HLD, and a lean LLD (the core aggregate, the schema that matters, the key ports). It uses D2 diagrams
and markdown tiles on an infinite canvas. Don't like something? Say so, and Claude resketches it. The board
updates live and badges what changed.

It's a sketch layer, not a spec: for brainstorming, design-review interviews, interview prep and presenting.

## How it works

```
 ┌──────────────────────────┐   chat    ┌─────────────────────────┐   jobs    ┌─────────────────────┐
 │  Browser                 │ ────────▶ │  Sketch server          │ ────────▶ │  Claude Code in     │
 │  sidebar · board · chat  │ ◀──────── │  npm start · :3460      │ ◀──────── │  this repo: /sketch │
 └──────────────────────────┘ live SVG  │  watches sketches/      │  replies  │  skill + poll.sh    │
                                        │  renders D2 (WASM)      │           │  writes the files   │
                                        └─────────────────────────┘           └─────────────────────┘
```

1. `npm start` serves `sketches/` from this repo.
2. `/sketch` in Claude Code long-polls the server for chat messages in the background, so an idle session
   uses no tokens. Each batch of messages becomes one job.
3. Claude writes `sketches/<name>/…`. The server watches the folder, renders `.d2` tiles to SVG with
   `@d2lang/d2`, and pushes the change to the browser over SSE.

## A sketch on disk

```
sketches/<name>/
  vocab.md        # required: core business process + glossary; terms are highlighted on every tile
  board.canvas    # JSON Canvas 1.0: where tiles sit, groups, edges
  *.d2 / *.md     # tiles: any visual that explains the design best
```

How Claude decides what to draw (center of gravity, vocab, lean LLD, which visual form, layout, the render check) lives in the `sketch-authoring` skill (`.claude/skills/sketch-authoring/`). The `/sketch` skill only runs the chat relay and loads it.

## Get started

```bash
npm i          # Node 22+
npm start      # http://127.0.0.1:3460  (PORT and SKETCHES=<folder> override the defaults)
```

Then, in this repo:

```bash
claude
> /sketch
```

Open http://127.0.0.1:3460 and ask for a sketch. `npm run dev` restarts the server when `server.js` changes.

## Use any local coding agent

Claude Code is the default, but the worker can be any local agent that can run shell commands and edit
files (Codex, Cursor, Aider, Gemini CLI, …). The relay is plain HTTP on localhost, and the skills are plain
Markdown, so the agent can read them as instructions.

Start the server, then give your agent this prompt in this repo:

```text
Act as the Sketch board's worker. Follow .claude/skills/sketch/SKILL.md for the job loop,
and .claude/skills/sketch-authoring/SKILL.md (plus its references/) for how to draw every sketch.
```

The whole protocol is three calls:

| Call | What it does |
|---|---|
| `GET /api/jobs/next?timeout=300` | Waits for the next chat job (or run `.claude/skills/sketch/scripts/poll.sh`) |
| write `sketches/<name>/…` | The board re-renders as files change |
| `POST /api/jobs/complete` `{ job_id, sketch, reply }` | Posts the reply in that sketch's chat |

## On the board

- Drag to pan, ⌘/ctrl + scroll (or pinch) to zoom, double-click a tile to focus it, `F` to fit.
- **changed** badges mark tiles that differ from the last time you clicked *Mark seen*. *N changed* dims
  everything else.
- Tiles with D2 `steps` / `layers` get ◀ ▶ controls.
- A D2 error shows on its own tile; the rest of the board keeps working.
