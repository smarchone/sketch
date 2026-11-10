---
name: sketch-authoring
description: How to author a system-design sketch board in sketches/<name>/ (vocab.md + board.canvas + D2 / markdown tiles) that a human can grasp in ~30 seconds: business vocab, HLD, and a lean LLD (core aggregate, data schema, port interfaces). Use whenever creating or resketching a sketch, whether from a Sketch chat job (/sketch) or when the user asks directly to "sketch", "draw the design of", or "whiteboard" a system.
---

# Authoring a sketch

A sketch is a **whiteboard drawing, not a spec**. Someone glances at the board for ~30 seconds and gets the
*feel* of the design: what the business does, how the system is shaped, and the few low-level decisions
that make it work. They react, and you resketch. Every choice below serves that glance.

**Signal, not noise.** Leave out anything the reader doesn't need for the feel. Omission is fine; clutter
isn't. When they want more, they ask.

## 1. Find the center of gravity first

Before drawing anything, name the 1–3 things that make *this* design what it is, not a generic web app.
Usually one of these:

- **a hot path** (redirect lookup, location ingest, feed fan-out)
- **a contention or consistency point** (one Match per Driver, double-spend, inventory hold)
- **a lifecycle** that drives everything (Trip, Order, Payment)
- **a data shape** that everything depends on (ledger entries, geo cells, a time series)

Every tile should serve one of these. Ask of each tile: *does this show the center of gravity, or is it here
because sketches usually have one?* Different systems get **different boards**. Never copy the tile set or
layout of an earlier sketch.

## 2. Write `vocab.md` (required, always first)

````markdown
# Ride-Hailing Dispatch

```
Rider  —requests→ Trip —offered to→ Driver —accepts→ Match
Driver —streams→  Location —feeds→ Supply index
```

- **Trip**: one pickup → dropoff journey for a Rider
- **Offer**: a time-boxed proposal of a Trip to one Driver
- **Match**: an accepted Offer binding a Driver to a Trip
````

- The title, then the **core business process as 1–2 verb chains** (`Actor —verb→ Thing`), then a glossary,
  one line per term: `- **Term**: meaning`.
- **Business words only**: no tables, services or tech. 5–10 terms.
- The board highlights these exact strings in every tile, with the definition on hover. **Use them verbatim
  everywhere**: same case, no synonyms. A new concept goes into the vocab first.

## 3. HLD: shape and interactions

- **4–8 boxes.** Actors as `shape: person`, stores as `cylinder`, queues as `queue`.
- **Label the flows with vocab verbs** ("requests Trip", "Offer (10s)"), not "calls", "uses" or HTTP verbs.
  Dashed = async.
- Mark the center of gravity: a thicker or colored stroke on the box where the hard part lives.

## 4. LLD: only the core

Three lenses. Show each **only as far as the center of gravity needs**:

- **Domain**: the central aggregate(s), their key **invariants** written as plain rules, and the lifecycle
  if it matters.
- **Data schema**: the core tables / collections / indexes and **the access pattern that drives them**
  (the query on the hot path, the key layout, the index). A schema without its access pattern is noise.
- **Adapters = interfaces only**: the 2–4 port signatures in domain types. No implementation, no
  framework code.

Not required: every entity, every field, every index, every port.

## 5. Pick the form per idea

Choose whatever costs the reader the least attention. D2 recipes for each are in
[references/d2.md](references/d2.md).

| To show… | Use |
|---|---|
| components and who talks to whom | D2 boxes, `direction: right` |
| order in time, retries, timeouts, races | D2 `shape: sequence_diagram` |
| a lifecycle | D2 states and transitions |
| an aggregate + its rules | D2 `shape: class` + a `\|md\|` invariants note |
| storage shape + access pattern | D2 `sql_table` (crisp) + a one-line query note |
| a contract | a ` ```ts ` block in a `.md` tile, or `\|ts\|` inside D2 |
| a trade-off | a short markdown tile, or a 2-column D2 `grid` |
| numbers (capacity, cost) | a small markdown table |
| a story told in stages | D2 `steps` (the tile gets ◀ ▶) |

Combine forms freely, e.g. a class next to its state machine in one D2 file. A sequence diagram often
beats another class box when the core is a protocol (offers, handshakes, sagas).

## 6. Forks: the open decisions

Add **1–3 forks**: real trade-offs tied to the center of gravity, each phrased as *A or B?* plus what each
costs. Put them in a small colored text tile beside the HLD (`"color": "2"`). They're where the discussion
should go, so skip filler like "SQL or NoSQL?" unless it's genuinely the crux.

## 7. Lay out the board

`board.canvas` is JSON Canvas 1.0. Fields, layout recipes and sizing rules are in
[references/board.md](references/board.md). The essentials:

- Reading order: **left → right, top → bottom**. Vocab is pinned top-left; HLD comes next; the LLD sits
  below or to the right.
- Pick a layout by the center of gravity (flow-, data- or state-centric). Don't default to the last one.
- **Size each D2 tile to its diagram.** Tiles narrower than the diagram shrink it; below ~75% it's hard to
  read. Heights adapt automatically.

## 8. Check the render, then look at it

```bash
curl -s "${SKETCH_URL:-http://127.0.0.1:3460}/api/board?sketch=<name>" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const b=JSON.parse(s);if(b.canvas_error)console.log("CANVAS",b.canvas_error);for(const[f,t]of Object.entries(b.tiles))console.log(f,t.error?"ERROR "+t.error.join("; "):"ok",t.size?`${t.size.width}x${t.size.height}`:"")})'
```

Fix every error. Then compare each D2 tile's natural `width` with its tile `width` in `board.canvas` and
widen the tile, or switch to `direction: down`, when the diagram would shrink below ~75%. (No server
running? Compile-check D2 another way, or keep to the recipes.)

Self-review before you finish:

- [ ] Could someone say what the business does, the core aggregate and its rule, what's stored and how
      it's queried, and the key port, in 30 seconds?
- [ ] Does every tile serve the center of gravity? Remove the one that doesn't.
- [ ] Are vocab terms used verbatim, with no synonyms and no undefined business words?
- [ ] HLD ≤ 8 boxes, code blocks ≤ 12 lines, no paragraph longer than 3 lines?
- [ ] Does this board look like *this* system, not the previous sketch?

## Resketching

- Read the existing files first. **Change only what the request touches**; keep tile ids, positions and
  vocab stable so the reader's mental map survives. The board badges whatever you changed.
- "More detail on X": add a tile next to X, or `steps` inside X's tile. Don't cram more into X.
- If the user's change contradicts something else on the board, fix both and say so.
- When a request changes the business itself (a new actor or concept), update `vocab.md` first.

## Anti-patterns

- Copying the previous sketch's tiles, coordinates or edge labels.
- Tiles "for completeness": every port, every table, a generic "Analytics" box.
- One giant D2 file holding everything. One idea per tile reads faster.
- Labels on every edge, or prose inside boxes. Keep labels to 1–4 words.
- Drifting names: "Ride" in one tile and "Trip" in another.
- Tiny tiles that shrink their diagram until it's unreadable.
