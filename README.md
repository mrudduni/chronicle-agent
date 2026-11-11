# Chronicle

A chat agent with web search that remembers what you talked about, and when, so you can come back days later and ask *"has any of that changed?"*

The design and its trade-offs are in [DESIGN.md](DESIGN.md).

## Run it

Requires Node 22.13 or newer (it uses the built-in `node:sqlite`).

```bash
cp .env.example .env        # then fill in the keys
npm install
npm run dev
```

Open http://localhost:5173. The API runs on :8787 and the UI proxies to it.

| Key | Needed | What for |
|---|---|---|
| `ANTHROPIC_API_KEY` | one of these two | Claude: chat on Opus 5.5, background memory jobs on Haiku 5.5 |
| `GEMINI_API_KEY` | one of these two | Gemini: chat on Gemini 3.6 Flash, memory jobs on Gemini 3.5 Flash-Lite (both have a free tier) |
| `TAVILY_API_KEY` | recommended | web search with publish-date filters; free tier, no card. Without it, Claude falls back to Anthropic's built-in search (no date filter) and Gemini runs without search |

If both model keys are set, Claude is used; set `LLM_PROVIDER=gemini` to override.

On first start, a ~34 MB embedding model downloads into `.cache/`. Until it's ready, memory search uses keywords only.

## Try these

**Fastest: demo data.** On the start screen, click **Try demo data**. It loads a few earlier conversations (a CRM shortlist on Monday, Postgres hosting the Tuesday before last, email tools about two weeks ago), dated relative to today and kept apart from your own memory. Then ask the suggested questions, such as *"Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"* Prices in the demo are sample values, so the re-check finds real changes. **Reset** reloads it for today's dates; **Exit demo** goes back to your own data.

Or build up your own history:

1. Ask *"Shortlist 5 CRM tools for a 20-person sales team, with current pricing."*
2. Start a **new chat** and ask *"What did I ask you today? Is your answer still correct?"*
3. Ask something about a day with no conversation: *"What did we discuss last Friday?"*

To test answers about the past without waiting days, freeze the clock in `.env` (`NOW=2026-11-11T10:00:00+05:30`), have a conversation, move `NOW` forward, restart, and ask about it. The UI shows a badge while the clock is frozen.

## Tests and evals

```bash
npm test            # 55 unit tests: date rules, memory, recall, provider adapters, demo data. No keys or network needed.
npm run typecheck
npm run eval        # end-to-end scenarios with a real model + grader (needs keys, costs a few cents)
```

Test names carry edge-case IDs (`T2`, `R3`, `M5`, ...) that match the comments in the code.

## Reading the code

Start at `src/agent/orchestrator.ts`: it walks through one turn (PRE, LOOP, POST) and links to everything else.

```
src/
  agent/        orchestrator (one turn), model loop, prompt + context block, re-check plans
  demo/         the demo history and the code that loads it
  time/         clock, timezone handling, resolvers, ambiguity policy, adapters
  memory/
    store.ts    the append-only log (write side)
    derive/     background jobs: claim ledger, entities, digests, topics, indexing
    retrieve/   recall (read side): filter, hybrid rank, fallbacks, packing, rendering
  search/       provider interface, Tavily, Anthropic fallback, result formatting, cache
  llm/          the only place that talks to a model API: Claude and Gemini behind one interface
  jobs/         durable SQLite job queue
  embed/        local embeddings
  db/           SQLite + schema
  server/       HTTP + SSE (thin)
web/src/        React UI
test/           unit tests
eval/           end-to-end evals
```
