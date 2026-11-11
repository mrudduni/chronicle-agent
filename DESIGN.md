# Chronicle: design

The test questions aren't really search questions. *"On Monday we shortlisted 5 CRMs, has anything changed since?"*, *"What did I ask on 3 November, is it still correct?"*: they're about **memory, time and change**. A good search loop is table stakes. What makes this agent different is that it remembers what it said, when, and on what evidence, and can check that again.

## How it works

```
message ─► PRE (code, ~10–50 ms)                      ─► LOOP (model)                 ─► POST (background)
           time:   "last Tuesday" → Tue 3 Nov (IST)       Opus 5.5, streamed             log answer
           memory: settle ambiguity, recall turns,         one tool: web_search           jobs: index, claims,
                   claims, digests; or say NOT FOUND       parallel calls, dated results       topic, day digest
           re-check plan from the claim ledger
```

- **Time is code, not model.** A resolver pipeline (explicit dates, calendar periods, memory-anchored "since I asked about X", LLM fallback only for things like "since Diwali") turns phrases into absolute spans. Ambiguous phrases ("last Tuesday" on a Wednesday, "3/11") return several candidates, and **memory decides**: the candidate that contains a matching conversation wins. The model gets resolved dates with precomputed ages and never does date arithmetic.
- **Storage keeps facts; queries choose the interpretation.** Each message stores the UTC instant, the IANA zone the user's clock was on, and the local day *as experienced*. A question asked at 00:30 in Mumbai stays "4 Nov" after the user flies to London. The zone comes from the browser or a declaration, never from location.
- **Memory is a log plus rebuildable derived data.** The append-only log (messages, raw search results) is the truth. Background jobs derive a **claim ledger** (entity, attribute, value, qualifiers, source, date, exact quote, checked by code against the answer), day digests, topics with open items, and the keyword and vector indexes. All of it is versioned and rebuilt on boot if missing, so a crash or a prompt change heals itself.
- **Retrieval is hybrid and honest.** Hard date filter first, then BM25 (FTS5) and local embeddings fused with reciprocal rank fusion, plus entity overlap. If the day has nothing, it says `NOT FOUND` and looks ±7 days for the topic ("not Tuesday, but on Wed 4 Nov you asked…"). A fresh install gets "no earlier conversations" instead of a made-up past.
- **Re-checks are planned, not improvised.** For "has it changed?", code builds a plan from the ledger: per item, a `page` search (current pricing page, deliberately *not* date-filtered, since evergreen pages have no publish date) plus a `news` search since the original date. The answer is a Changed / Unchanged / Couldn't verify table.
- **Fast by construction.** No LLM call before the answer starts in the common case. Recall is a few SQLite queries and dot products. Searches in one step run in parallel and are cached. Prompts are ordered fixed → growing → volatile so prompt caching hits. Everything slow happens after the answer.

## Why this shape

- **One tool, recall in code.** The brief allows one tool. Making recall a tool would cost a round trip and let the model forget to call it. Doing it in code is deterministic and adds no latency.
- **Local-first.** SQLite (`node:sqlite`, no native build) plus a 34 MB local embedding model: the user's history never leaves the machine except in the prompt. That's how minimi treats personal context too.
- **Ambiguity resolved by evidence.** English speakers genuinely disagree on what "last Tuesday" means. Any fixed grammar rule is wrong for some users; checking which Tuesday actually has the conversation isn't.
- **Visible working.** The UI streams how dates were read, what was recalled and each search, so a wrong assumption is caught in a second, not after reading the answer.

## Considered and rejected

- **Vector DB service:** wrong scale (thousands of vectors; brute-force cosine takes milliseconds), another thing to run, and against local-first. Hidden behind `Retriever` if it's ever needed.
- **LangChain or another agent framework:** the loop is ~150 lines I can explain line by line. Frameworks hide exactly the parts being judged.
- **Planner/researcher/writer multi-agent:** adds seconds of latency for chat-sized tasks.
- **Date-parsing library (chrono):** defaults lean forward ("Monday" = next Monday), which is wrong for questions about the past. A few hundred lines of tested rules return candidates instead of guesses.
- **Nightly digest cron:** a local app isn't running at midnight. Digests update per turn and are rebuilt when read if stale.
- **Summaries as memory:** lossy. Digests are for navigation only; re-checks always use raw turns and the claim ledger.
- **IP geolocation for timezone:** wrong under VPNs, invasive, and not what the user's calendar is.

## With another week

1. **Native search-result citations** (`search_result` blocks), so every cited sentence carries the exact source passage and claims are verified against it.
2. **Proactive open loops:** when the user returns to a topic with open items, re-check those entities in the background and lead with what changed.
3. **Bi-temporal knowledge graph** over the claims (valid time vs. when the agent said it), with contradiction detection across sources.
4. **Learn the ambiguity policy** from the user's corrections ("by last Tuesday I always mean the previous week").
5. **Bigger eval set** (LongMemEval's temporal-reasoning split, FreshQA) run in CI, with latency budgets as failing tests.
