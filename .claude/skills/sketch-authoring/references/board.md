# board.canvas: placing tiles

`board.canvas` is [JSON Canvas 1.0](https://jsoncanvas.org): `{ "nodes": [...], "edges": [...] }`.

## Nodes

| type | fields | renders as |
|---|---|---|
| `file` | `file` (path relative to the sketch folder: `hld.d2`, `ports.md`) | `.d2` → SVG diagram, `.md` → markdown |
| `text` | `text` (markdown) | a markdown card, good for forks and short notes |
| `group` | `label` | a dashed frame with an uppercase label |
| `link` | `url` | a link card (rarely useful) |

Every node needs `id`, `x`, `y`, `width` and `height`. Optional `color` is `"1"`–`"6"` (red, orange,
yellow, green, cyan, purple) or a hex value; on a tile it's a colored top border.

**How the board treats geometry:**

- `x` and `width` are honoured exactly. **Heights adapt to content**. A tile that grows pushes the tiles
  below it down, and groups grow to wrap the tiles that started inside them. Get `x`/`width` right, give a
  sensible `height`, and leave ~40 px gaps.
- `vocab.md` is always on the board. If the canvas doesn't place it, it's pinned left of everything else.
- With no `board.canvas`, every file is laid out automatically in two columns. That's fine for a first
  draft, but a real board has a canvas.

## Edges

```json
{ "id": "e1", "fromNode": "hld", "toNode": "domain", "label": "Trip" }
```

Optional fields: `fromSide` / `toSide` (`top | right | bottom | left`; facing sides are picked
automatically), `toEnd: "none"`, `fromEnd: "arrow"`, `color`. Use few edges, each saying how one tile
zooms into another ("Trip", "stored as"). Don't connect everything.

## Sizing D2 tiles

A D2 diagram is scaled down to fit its tile's width, never up. Read each tile's natural size from the
board API (`tiles["<file>"].size.width`) and set the tile `width` to about **natural width + 20**, capped
around 1200. If the diagram is still too wide, change its `direction`, split it, or cut boxes.
Readable means a scale of at least ~75%.

Rough natural widths: left-to-right HLD with 6–8 boxes ≈ 1000–1300; sequence with 3 participants ≈ 460;
class + rules ≈ 580; 4–5 state lifecycle ≈ 900; two `sql_table`s ≈ 650.

## Layout recipes

Pick by the center of gravity. Coordinates are a starting point; adjust widths to the real sizes.

**Flow-centric** (the core is a protocol: dispatch, payments, booking). HLD on top, the sequence next to
the aggregate below it:

```
 [vocab 0,0 w420]  [HLD 460,0 w≈1100 ···················] [forks 1600,0 w320]
                   [sequence 460,·  w480] [aggregate+lifecycle 980,· w≈900]
                   [schema 460,· w≈650]   [ports.md 1150,· w440]
```

**Data-centric** (the core is the data shape: ledger, analytics, search index). Keep the HLD small and
make the schema the biggest tile:

```
 [vocab 0,0 w420]  [HLD 460,0 w≈800]        [forks 1300,0 w320]
                   [schema + access pattern 460,· w≈1000 ···········]
                   [aggregate 460,· w≈580] [ports.md 1080,· w440]
```

**State-centric** (the core is a lifecycle: orders, workflows, approvals). The state machine is the hero:

```
 [vocab 0,0 w420]  [lifecycle 460,0 w≈1000 ············] [forks 1500,0 w320]
                   [HLD 460,· w≈800]  [schema 1300,· w≈650]
                   [ports.md 460,· w440]
```

Frame the related tiles with `group`s ("HLD", "LLD · Dispatch") only when it helps the reading order. Two or
three groups at most.

## Minimal example

```json
{
  "nodes": [
    { "id": "vocab", "type": "file", "file": "vocab.md", "x": 0, "y": 0, "width": 420, "height": 360 },
    { "id": "hld", "type": "file", "file": "hld.d2", "x": 460, "y": 0, "width": 1100, "height": 300 },
    { "id": "forks", "type": "text", "color": "2", "x": 1600, "y": 0, "width": 320, "height": 200,
      "text": "### ⚠ Open forks\n- **Offer** one **Driver** at a time, or broadcast (first accept wins)?" },
    { "id": "seq", "type": "file", "file": "dispatch.d2", "x": 460, "y": 360, "width": 480, "height": 740 },
    { "id": "trip", "type": "file", "file": "trip.d2", "x": 980, "y": 360, "width": 900, "height": 520 }
  ],
  "edges": [
    { "id": "e1", "fromNode": "hld", "toNode": "seq", "label": "Dispatch" },
    { "id": "e2", "fromNode": "seq", "toNode": "trip", "label": "Trip" }
  ]
}
```
