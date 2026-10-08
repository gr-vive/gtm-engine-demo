-- ============================================================
-- 001 core: the professional audience (law firms + the people in them)
-- and the outbound registry that keeps it current and deliverable.
-- ============================================================

CREATE TABLE IF NOT EXISTS firms (
  firm_id         TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  sra_number      TEXT,                         -- Solicitors Regulation Authority id (synthetic)
  city            TEXT,
  region          TEXT,
  jurisdiction    TEXT NOT NULL DEFAULT 'England and Wales',
  practice_areas  TEXT NOT NULL,                -- csv: family,probate
  size_band       TEXT,                         -- 1-5 | 6-20 | 21-50 | 51-200 | 200+
  website_domain  TEXT,
  on_panel        INTEGER NOT NULL DEFAULT 0,   -- 1 = already a referral partner
  source          TEXT,                         -- where we first saw it
  first_seen_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_firms_domain ON firms(website_domain);

CREATE TABLE IF NOT EXISTS contacts (
  contact_id      TEXT PRIMARY KEY,
  firm_id         TEXT NOT NULL REFERENCES firms(firm_id),
  first_name      TEXT NOT NULL,
  last_name       TEXT NOT NULL,
  title           TEXT,
  role_type       TEXT,                         -- partner | solicitor | head_of_department | paralegal | finance
  practice_area   TEXT,                         -- family | probate | other
  email           TEXT,
  linkedin_url    TEXT,
  source          TEXT,
  first_seen_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_firm ON contacts(firm_id);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);

-- One row per discovered profile per pipeline run, in whatever state it reached.
CREATE TABLE IF NOT EXISTS audience_candidates (
  candidate_id    TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  source          TEXT NOT NULL,                -- sra_register | law_society | companies_house | events | linkedin
  firm_name       TEXT,
  website_domain  TEXT,
  person_name     TEXT,
  email           TEXT,
  linkedin_url    TEXT,
  raw_json        TEXT,
  status          TEXT NOT NULL DEFAULT 'new',  -- new | duplicate | enriched | qualified | disqualified | pushed
  reason          TEXT,
  fit_score       INTEGER,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_candidates_run ON audience_candidates(run_id);

-- The registry = source of truth for "who is in our outbound audience".
-- profile_key is the dedup key (lower-cased email, else linkedin url).
-- pushed_at is the cursor: the daily push takes the next N rows where pushed_at IS NULL.
CREATE TABLE IF NOT EXISTS audience_registry (
  profile_key     TEXT PRIMARY KEY,
  contact_id      TEXT REFERENCES contacts(contact_id),
  firm_id         TEXT REFERENCES firms(firm_id),
  segment         TEXT NOT NULL,                -- family_partners | probate_partners | mixed | panel_expansion
  fit_score       INTEGER,
  qualified_at    TEXT,
  pushed_at       TEXT,
  sequencer       TEXT,                         -- which tool holds the sequence (mock: instantly | heyreach)
  sequencer_lead_id TEXT,
  replied_at      TEXT,
  meeting_at      TEXT,
  suppressed      INTEGER NOT NULL DEFAULT 0,   -- 1 = do-not-contact (opt-out, bounced, existing customer)
  dedup_run_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_registry_cursor ON audience_registry(pushed_at, suppressed, fit_score);

-- Buying signals on firms already in the registry (expansion, hires, rankings, news).
CREATE TABLE IF NOT EXISTS signals (
  signal_id       TEXT PRIMARY KEY,
  firm_id         TEXT REFERENCES firms(firm_id),
  contact_id      TEXT REFERENCES contacts(contact_id),
  signal_type     TEXT NOT NULL,                -- new_partner | new_office | ranking | job_ad | news
  headline        TEXT NOT NULL,
  url             TEXT,
  score           INTEGER,                      -- 1..10 relevance
  detected_at     TEXT NOT NULL,
  alerted_at      TEXT
);
