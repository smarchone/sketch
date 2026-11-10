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
- **Author with the `sketch-authoring` skill.** Load it with the Skill tool before your first job in this
  session (it stays loaded), and follow it for everything you write: vocab, HLD, lean LLD, forms, layout,
  resketch rules and the render check.
- Questions only: answer, no edits. Truly ambiguous: ask one concrete question, no edits.
- **Check your render** before replying (step 8 of `sketch-authoring`): no tile errors, and no D2 tile
  narrower than its diagram.
- Finish with **one** call (this posts your reply in the sketch's chat):

  ```bash
  curl -sf -X POST "${SKETCH_URL:-http://127.0.0.1:3460}/api/jobs/complete" -H 'Content-Type: application/json' -d @- <<'JSON'
  {"job_id":"<id>","sketch":"<name, required for a new sketch>","reply":"<1–3 sentences: what you drew or changed, and the one fork worth discussing>"}
  JSON
  ```

  409 means the job was released: drop it and keep listening.

Terminal output: at most one line per job. The conversation happens in the chat.
