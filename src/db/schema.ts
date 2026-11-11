/**
 * Database schema, as an ordered list of migrations.
 *
 * The tables fall into two groups, and the split is the core idea of the
 * memory design:
 *
 *   LOG (facts that never change, written on the hot path)
 *     threads, messages, searches, events
 *
 *   DERIVED (rebuilt from the log at any time, written by background jobs)
 *     entities, claims, day_digests, topics, embeddings, fts
 *
 * Every derived row records which version of its deriver built it and which
 * messages it came from, so it can be thrown away and rebuilt. The only change
 * ever made to the log is erasure ("forget this"), for privacy.
 *
 * Times are stored as UTC epoch milliseconds (ts_utc). `local_day` is the
 * calendar day in the timezone the user's clock was set to when they sent the
 * message. It's a cached index for the default "experienced" time frame, not
 * the source of truth: ts_utc + tz is.
 */
export const MIGRATIONS: string[] = [
  /* v1 */ `
  CREATE TABLE threads (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    title       TEXT,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id       TEXT NOT NULL REFERENCES threads(id),
    user_id         TEXT NOT NULL,
    role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content         TEXT NOT NULL,
    ts_utc          INTEGER NOT NULL,          -- server clock, never the client's
    tz              TEXT NOT NULL,             -- IANA zone of the user's clock at send time
    utc_offset_min  INTEGER NOT NULL,          -- kept in case tzdb rules change later
    tz_source       TEXT NOT NULL,             -- browser | declared | fallback
    local_day       TEXT NOT NULL,             -- YYYY-MM-DD in tz
    status          TEXT NOT NULL DEFAULT 'complete', -- complete | partial | forgotten
    reply_to        INTEGER REFERENCES messages(id)   -- assistant -> the user message it answers
  );
  CREATE INDEX ix_messages_day    ON messages(user_id, local_day);
  CREATE INDEX ix_messages_thread ON messages(thread_id, id);

  -- Raw evidence: every search the agent ran, with what came back.
  CREATE TABLE searches (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    turn_id       INTEGER NOT NULL REFERENCES messages(id), -- the user message being answered
    user_id       TEXT NOT NULL,
    provider      TEXT NOT NULL,
    query         TEXT NOT NULL,
    params_json   TEXT NOT NULL,
    results_json  TEXT NOT NULL,
    ts_utc        INTEGER NOT NULL
  );
  CREATE INDEX ix_searches_turn ON searches(turn_id);

  -- Things the user did that aren't chat messages: corrections, "forget",
  -- declaring a timezone.
  CREATE TABLE events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       TEXT NOT NULL,
    kind          TEXT NOT NULL,
    payload_json  TEXT NOT NULL,
    ts_utc        INTEGER NOT NULL
  );

  CREATE TABLE users (
    id             TEXT PRIMARY KEY,
    declared_tz    TEXT,        -- set when the user says which timezone to use; wins over the browser
    last_seen_tz   TEXT
  );

  -------------------------------------------------------------------- derived

  CREATE TABLE entities (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       TEXT NOT NULL,
    canonical     TEXT NOT NULL,   -- "HubSpot"
    norm          TEXT NOT NULL,   -- "hubspot", for matching
    type          TEXT NOT NULL,   -- product | company | person | place | concept
    aliases_json  TEXT NOT NULL DEFAULT '[]',
    UNIQUE (user_id, norm, type)
  );

  -- The claim ledger: atomic facts the agent stated, each tied to a source.
  -- This is what makes "is your answer still correct?" answerable.
  CREATE TABLE claims (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id              TEXT NOT NULL,
    turn_id              INTEGER NOT NULL REFERENCES messages(id),
    entity_id            INTEGER NOT NULL REFERENCES entities(id),
    attribute            TEXT NOT NULL,     -- "price", "free tier", "launched"
    value                TEXT NOT NULL,     -- "$20"
    qualifiers_json      TEXT NOT NULL DEFAULT '{}', -- plan, billing period, region, currency, seats
    quote                TEXT NOT NULL,     -- exact sentence from the answer the claim came from
    source_url           TEXT,
    source_published_at  TEXT,
    observed_at          INTEGER NOT NULL,  -- when the agent said it
    status               TEXT NOT NULL,     -- sourced | unsourced | user
    superseded_by        INTEGER REFERENCES claims(id),
    version              INTEGER NOT NULL
  );
  CREATE INDEX ix_claims_turn   ON claims(turn_id);
  CREATE INDEX ix_claims_entity ON claims(entity_id);

  CREATE TABLE day_digests (
    user_id               TEXT NOT NULL,
    local_day             TEXT NOT NULL,
    summary               TEXT NOT NULL,
    entities_json         TEXT NOT NULL DEFAULT '[]',
    turn_ids_json         TEXT NOT NULL DEFAULT '[]',
    built_through_msg_id  INTEGER NOT NULL,
    version               INTEGER NOT NULL,
    updated_at            INTEGER NOT NULL,
    PRIMARY KEY (user_id, local_day)
  );

  CREATE TABLE topics (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          TEXT NOT NULL,
    label            TEXT NOT NULL,
    summary          TEXT NOT NULL,
    entities_json    TEXT NOT NULL DEFAULT '[]',
    open_items_json  TEXT NOT NULL DEFAULT '[]',
    turn_ids_json    TEXT NOT NULL DEFAULT '[]',
    updated_at       INTEGER NOT NULL
  );

  -- One vector per indexed thing. Keyed by model so a model upgrade can
  -- re-embed in the background without mixing vectors from two models.
  CREATE TABLE embeddings (
    owner_type  TEXT NOT NULL,     -- turn | topic | digest
    owner_id    TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    model       TEXT NOT NULL,
    vector      BLOB NOT NULL,     -- Float32Array bytes, L2-normalised
    PRIMARY KEY (owner_type, owner_id, model)
  );

  -- Keyword index. porter = stemming ("priced" matches "pricing").
  CREATE VIRTUAL TABLE fts USING fts5(
    owner_type UNINDEXED,
    owner_id   UNINDEXED,
    user_id    UNINDEXED,
    local_day  UNINDEXED,
    text,
    tokenize = 'porter unicode61'
  );

  -------------------------------------------------------------------- infra

  -- Durable job queue. UNIQUE(kind, owner_id, version) makes enqueueing
  -- idempotent: a crash and restart can enqueue everything again safely.
  CREATE TABLE jobs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL,
    owner_id    TEXT NOT NULL,
    version     INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending', -- pending | done | failed
    attempts    INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT,
    created_at  INTEGER NOT NULL,
    UNIQUE (kind, owner_id, version)
  );

  CREATE TABLE traces (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    turn_id    INTEGER,
    data_json  TEXT NOT NULL,
    ts_utc     INTEGER NOT NULL
  );
  `,
];
