-- ============================================================
-- 005 ai layer: inbound enquiry triage with coded rules, an AI reader/drafter,
-- a human decision on every case, shadow-mode comparison, and an append-only audit log.
-- ============================================================

CREATE TABLE IF NOT EXISTS enquiries (
  enquiry_id      TEXT PRIMARY KEY,
  received_at     TEXT NOT NULL,
  channel         TEXT NOT NULL,                -- web_form | email | phone_note
  from_name       TEXT,
  from_email      TEXT,
  firm_id         TEXT,                         -- matched later by rules (firm lookup), may be null
  subject         TEXT,
  raw_text        TEXT NOT NULL
);

-- Ground truth used ONLY by the synthetic generator and the evaluator.
-- Triage never reads this table; that is the whole point of shadow mode.
CREATE TABLE IF NOT EXISTS enquiry_labels (
  enquiry_id      TEXT PRIMARY KEY REFERENCES enquiries(enquiry_id),
  product         TEXT NOT NULL,                -- family_law | probate | other
  jurisdiction    TEXT NOT NULL,
  requested_gbp   REAL,
  security_gbp    REAL,                         -- estate value or assets in dispute
  hearing_in_days INTEGER,
  route           TEXT NOT NULL                 -- family_team | probate_team | decline | needs_more_info
);

CREATE TABLE IF NOT EXISTS ai_decisions (
  decision_id     TEXT PRIMARY KEY,
  enquiry_id      TEXT NOT NULL REFERENCES enquiries(enquiry_id),
  run_id          TEXT NOT NULL,
  mode            TEXT NOT NULL,                -- shadow | assist
  provider        TEXT NOT NULL,                -- anthropic | fixture | mock
  model           TEXT NOT NULL,
  prompt_version  TEXT NOT NULL,
  prompt_hash     TEXT NOT NULL,
  extracted_json  TEXT NOT NULL,                -- what the model read out of the text
  rules_json      TEXT NOT NULL,                -- which coded rules fired and the arithmetic they did
  route           TEXT NOT NULL,                -- the routing decision produced by the RULES, not the model
  product         TEXT,
  max_loan_gbp    REAL,
  priority        TEXT,                         -- normal | high
  confidence      REAL,
  draft_reply     TEXT,
  latency_ms      INTEGER,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cost_usd        REAL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aidec_enquiry ON ai_decisions(enquiry_id);
CREATE INDEX IF NOT EXISTS idx_aidec_run ON ai_decisions(run_id);

CREATE TABLE IF NOT EXISTS human_decisions (
  enquiry_id      TEXT PRIMARY KEY REFERENCES enquiries(enquiry_id),
  reviewer        TEXT NOT NULL,
  route           TEXT NOT NULL,
  product         TEXT,
  approved_gbp    REAL,
  decided_at      TEXT NOT NULL,
  notes           TEXT
);

-- In assist mode drafts wait here. In shadow mode this table stays empty.
CREATE TABLE IF NOT EXISTS review_queue (
  enquiry_id      TEXT PRIMARY KEY REFERENCES enquiries(enquiry_id),
  decision_id     TEXT NOT NULL REFERENCES ai_decisions(decision_id),
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | approved | edited | rejected
  assigned_to     TEXT,
  queued_at       TEXT NOT NULL,
  resolved_at     TEXT
);

-- Append-only. Never updated, never deleted. Every actor is named.
CREATE TABLE IF NOT EXISTS audit_log (
  audit_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT NOT NULL,
  actor           TEXT NOT NULL,                -- system:<task> | rules:<version> | model:<id> | human:<name>
  enquiry_id      TEXT,
  event           TEXT NOT NULL,
  detail_json     TEXT,
  prompt_hash     TEXT,
  model_version   TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_enquiry ON audit_log(enquiry_id, ts);

CREATE TABLE IF NOT EXISTS shadow_evals (
  eval_id         TEXT PRIMARY KEY,
  run_at          TEXT NOT NULL,
  model           TEXT NOT NULL,
  prompt_version  TEXT NOT NULL,
  n               INTEGER NOT NULL,
  route_agreement REAL,
  product_agreement REAL,
  amount_mape     REAL,
  confusion_json  TEXT,
  flagged_json    TEXT,
  cost_usd        REAL,
  minutes_saved_est REAL
);
