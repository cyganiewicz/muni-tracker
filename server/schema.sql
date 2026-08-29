-- Municipal Client Review Tracker schema (v2)
--
-- Key design choice: `clients` holds static roster info (who they are, what
-- territory, persistent notes). `reviews` holds one row per client PER
-- REVIEW CYCLE (due date, done flag, material count, etc). Starting a new
-- cycle creates a fresh row per client instead of clearing the old one, so
-- "reset for the new quarter" never destroys history -- old cycles stay
-- queryable for trend metrics. Every mutable row also carries a `version`
-- for optimistic-concurrency checks -- that's what actually fixes the
-- "someone saved over my changes" problem the old spreadsheet had.

CREATE TABLE IF NOT EXISTS regions (
  id INTEGER PRIMARY KEY,        -- matches the old tab numbers, but admin can add more
  label TEXT NOT NULL,           -- e.g. "1-Sue"
  advisor TEXT NOT NULL          -- e.g. "Sue", "Brian", "Kath", "Michelle", "B,M,K"
);

CREATE TABLE IF NOT EXISTS team_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS communities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  municipal_type TEXT,           -- Town / City
  county TEXT,
  region_id INTEGER REFERENCES regions(id),
  status TEXT DEFAULT 'client',  -- client / prospect
  datawrapper_code TEXT,         -- this town's id in Datawrapper's MA-municipalities basemap, for map matching
  UNIQUE(name)
);

CREATE TABLE IF NOT EXISTS cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,                 -- e.g. "FY26", "Q1 2027"
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT,                      -- NULL = this is the current/active cycle
  started_by TEXT
);

-- exactly one row with closed_at IS NULL at a time (enforced in app code)
CREATE INDEX IF NOT EXISTS idx_cycles_open ON cycles(closed_at);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  household_name TEXT NOT NULL,
  community_id INTEGER REFERENCES communities(id),
  mailing_city TEXT,
  region_id INTEGER NOT NULL REFERENCES regions(id),

  special_notes TEXT,            -- persistent facts about the client (conflicts of interest, relationship notes) - carries forward across cycles
  coverage_note TEXT,            -- persistent coverage arrangement, e.g. "2 advisors", "needs Kathleen"

  active INTEGER NOT NULL DEFAULT 1,   -- soft-delete flag

  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_clients_region ON clients(region_id);
CREATE INDEX IF NOT EXISTS idx_clients_community ON clients(community_id);
CREATE INDEX IF NOT EXISTS idx_clients_active ON clients(active);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  cycle_id INTEGER NOT NULL REFERENCES cycles(id),

  last_review_text TEXT,
  last_review_date TEXT,         -- ISO date, best-effort parsed, nullable
  next_review_text TEXT,         -- free text, e.g. "9/17 @ 11:30 (lunch)"
  next_review_date TEXT,         -- ISO date, best-effort parsed, nullable

  material_count INTEGER,
  assigned_rep_note TEXT,        -- who actually ran/will run this review
  review_notes TEXT,             -- notes specific to this cycle's review (what happened, action items)

  done INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,

  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT,

  UNIQUE(client_id, cycle_id)
);

CREATE INDEX IF NOT EXISTS idx_reviews_cycle ON reviews(cycle_id);
CREATE INDEX IF NOT EXISTS idx_reviews_client ON reviews(client_id);
CREATE INDEX IF NOT EXISTS idx_reviews_done ON reviews(done);

CREATE TABLE IF NOT EXISTS change_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,     -- 'client' | 'review' | 'region' | 'team_member' | 'cycle'
  entity_id INTEGER NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  changed_by TEXT,
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_changelog_entity ON change_log(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
