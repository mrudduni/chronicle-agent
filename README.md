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
| `ANTHROPIC_API_KEY` | yes | the chat model (Claude Opus 5.5) and background memory jobs (Claude Haiku 5.5) |
| `TAVILY_API_KEY` | recommended | web search with publish-date filters; free tier, no card. Without it the agent uses Anthropic's built-in search, which can't filter by date |

On first start, a ~34 MB embedding model downloads into `.cache/`. Until it's ready, memory search uses keywords only.

## Try these

1. Ask *"Shortlist 5 CRM tools for a 20-person sales team, with current pricing."*
2. Start a **new chat** and ask *"What did I ask you today? Is your answer still correct?"*
3. Ask something about a day with no conversation: *"What did we discuss last Friday?"*

To test answers about the past without waiting days, freeze the clock in `.env` (`NOW=2026-11-11T10:00:00+05:30`), have a conversation, move `NOW` forward, restart, and ask about it. The UI shows a badge while the clock is frozen.

## Tests and evals

```bash
npm test            # 46 unit tests: date rules, memory, recall. No keys or network needed.
npm run typecheck
npm run eval        # end-to-end scenarios with a real model + grader (needs keys, costs a few cents)
```

Test names carry edge-case IDs (`T2`, `R3`, `M5`, ...) that match the comments in the code.

## Reading the code

Start at `src/agent/orchestrator.ts`: it walks through one turn (PRE, LOOP, POST) and links to everything else.

```
src/
  agent/        orchestrator (one turn), model loop, prompt + context block, re-check plans
  time/         clock, timezone handling, resolvers, ambiguity policy, adapters
  memory/
    store.ts    the append-only log (write side)
    derive/     background jobs: claim ledger, entities, digests, topics, indexing
    retrieve/   recall (read side): filter, hybrid rank, fallbacks, packing, rendering
  search/       provider interface, Tavily, Anthropic fallback, result formatting, cache
  llm/          the only place that talks to the model API
  jobs/         durable SQLite job queue
  embed/        local embeddings
  db/           SQLite + schema
  server/       HTTP + SSE (thin)
web/src/        React UI
test/           unit tests
eval/           end-to-end evals
```
