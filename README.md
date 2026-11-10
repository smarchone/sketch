# Sketch

**A whiteboard for system design that Claude draws and you react to.**

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

## On the board

- Drag to pan, ⌘/ctrl + scroll (or pinch) to zoom, double-click a tile to focus it, `F` to fit.
- **changed** badges mark tiles that differ from the last time you clicked *Mark seen*. *N changed* dims
  everything else.
- Tiles with D2 `steps` / `layers` get ◀ ▶ controls.
- A D2 error shows on its own tile; the rest of the board keeps working.
