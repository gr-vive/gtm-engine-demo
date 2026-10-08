-- ============================================================
-- 003 crm: a Salesforce-shaped mirror. In production these tables are
-- filled by a read-only sync from Salesforce (Bulk API / exports).
-- The engine never writes into Salesforce; it specifies that work.
-- ============================================================

CREATE TABLE IF NOT EXISTS sf_leads (
  lead_id         TEXT PRIMARY KEY,
  created_at      TEXT NOT NULL,
  contact_id      TEXT,
  firm_id         TEXT,
  email           TEXT,
  lead_source     TEXT,                         -- what Salesforce was told (often wrong or blank; attribution fixes this)
  product         TEXT,                         -- family_law | probate
  status          TEXT NOT NULL,                -- Open | Converted | Disqualified
  converted_opportunity_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_leads_created ON sf_leads(created_at);

CREATE TABLE IF NOT EXISTS sf_opportunities (
  opp_id          TEXT PRIMARY KEY,
  created_at      TEXT NOT NULL,                -- = enquiry date
  lead_id         TEXT,
  contact_id      TEXT,
  firm_id         TEXT,
  product         TEXT NOT NULL,
  stage           TEXT NOT NULL,                -- Enquiry | Application | Offer | Funded | Declined | Withdrawn
  stage_entered_at TEXT NOT NULL,
  amount_gbp      REAL,                         -- requested / offered amount
  close_date      TEXT,
  lost_reason     TEXT
);
CREATE INDEX IF NOT EXISTS idx_opps_created ON sf_opportunities(created_at);
CREATE INDEX IF NOT EXISTS idx_opps_stage ON sf_opportunities(stage);

-- Stage history = OpportunityHistory in Salesforce. One row per stage entered.
CREATE TABLE IF NOT EXISTS sf_opportunity_history (
  history_id      TEXT PRIMARY KEY,
  opp_id          TEXT NOT NULL REFERENCES sf_opportunities(opp_id),
  stage           TEXT NOT NULL,
  entered_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opphist_opp ON sf_opportunity_history(opp_id);
CREATE INDEX IF NOT EXISTS idx_opphist_stage ON sf_opportunity_history(stage, entered_at);

-- The financial transaction. Funded loans are the number the whole business works from.
CREATE TABLE IF NOT EXISTS loans (
  loan_id         TEXT PRIMARY KEY,
  opp_id          TEXT NOT NULL REFERENCES sf_opportunities(opp_id),
  product         TEXT NOT NULL,
  principal_gbp   REAL NOT NULL,
  funded_at       TEXT NOT NULL,
  term_months     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_loans_funded ON loans(funded_at);
