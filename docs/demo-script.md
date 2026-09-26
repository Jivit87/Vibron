# Viberon — 90-Second Demo Script

Target run time: under 90 seconds, stopwatch on the deployed app.

## Setup (before the camera rolls)

- Browser zoom at 100%, dark mode confirmed.
- Two browser tabs open:
  1. Landing page (`/`)
  2. (Backup) the workspace URL for the Express demo, in case the navigation animation hiccups.
- Keyboard: muscle-memory of `Cmd+L` to focus the address bar if needed.

## The 90-second take

1. **0:00 — Open the landing page.**
   "Viberon turns any GitHub repo into a chat you can have with the parts that actually matter."
   Pause one beat so the gradient and demo cards finish their fade-in.

2. **0:08 — Click the Express demo card.**
   The bubble graph paints in. Drop the line:
   "Each bubble is a function or class. Size is lines of code, color is folder."

3. **0:18 — Click the first suggested question on the card** ("How does the router match a path?").
   The chat panel auto-submits and tokens start streaming.
   While the LLM streams, the corresponding bubbles pulse cyan. Call it out:
   "Watch the graph — those are the only nodes the model sees. Everything else is dropped."

4. **0:35 — Point at the token counter** as it animates.
   "That's the savings versus shipping the whole repo. We send 30 nodes max — the model never sees the rest."

5. **0:45 — Hover a related bubble** to show the neighbor highlight, then click it.
   The code panel updates with the file path, signature, and snippet.
   "And it's all real code — you can read what the model just used to answer."

6. **1:00 — Type a follow-up question** in the chat input ("Where is middleware composed?") and send.
   Tokens stream, a new pulse fires, the counter ticks again.

7. **1:20 — Wrap.**
   "Graph-aware retrieval, no embeddings, no vector store. Bubble graph, BFS depth 2, TF-IDF. Ships in 48 hours."

8. **1:30 — Stop.**

## Failure backups

- **Groq API errors during the demo**: the `/api/chat` route falls back to canned responses for the seeded demo questions (see `lib/canned.ts`). The pulse + token counter still fire, so visually nothing changes.
- **Workspace 500 on first navigation**: hard refresh once. The demos are pre-warmed in KV, so a refresh re-reads from cache.
- **Bubble graph slow to settle on Express**: pan slightly to nudge the canvas — the layout finishes in ~2 seconds.

## What to *not* say

- Don't pitch embeddings or a vector store — Viberon is the opposite of that.
- Don't promise live editing or write capabilities — read-only by design.
- Don't compare to GitHub Copilot directly. The angle is "see the slice of code the model actually used", not chat completion.

## Word-economy lines (in case you stumble)

- "Bubble graph plus retrieval-augmented chat."
- "We pulse the bubbles the model actually read."
- "Thirty nodes, two hops. That's the whole secret."
