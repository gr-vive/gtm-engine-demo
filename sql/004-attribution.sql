-- ============================================================
-- 004 attribution: journeys stitched from touches to opportunities,
-- and the credit each model gives each channel.
-- ============================================================

CREATE TABLE IF NOT EXISTS journeys (
  journey_id      TEXT PRIMARY KEY,
  opp_id          TEXT NOT NULL REFERENCES sf_opportunities(opp_id),
  contact_id      TEXT,
  firm_id         TEXT,
  enquiry_at      TEXT NOT NULL,
  lookback_days   INTEGER NOT NULL,
  touch_count     INTEGER NOT NULL,
  first_touch_id  TEXT,
  last_touch_id   TEXT,
  resolution      TEXT NOT NULL,                -- resolved | firm_only | unresolved
  built_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_journeys_opp ON journeys(opp_id);

CREATE TABLE IF NOT EXISTS journey_touches (
  journey_id      TEXT NOT NULL REFERENCES journeys(journey_id),
  touch_id        TEXT NOT NULL,
  position        INTEGER NOT NULL,             -- 1 = first
  channel         TEXT NOT NULL,
  touch_type      TEXT NOT NULL,
  ts              TEXT NOT NULL,
  days_before_enquiry REAL NOT NULL,
  PRIMARY KEY (journey_id, touch_id)
);

-- credit is a fraction in [0,1]; per (model, opp) the credits sum to 1.
CREATE TABLE IF NOT EXISTS attribution_credits (
  model           TEXT NOT NULL,                -- first_touch | last_touch | linear | position_based | time_decay
  opp_id          TEXT NOT NULL,
  journey_id      TEXT NOT NULL,
  channel         TEXT NOT NULL,
  credit          REAL NOT NULL,
  run_at          TEXT NOT NULL,
  PRIMARY KEY (model, opp_id, channel)
);
CREATE INDEX IF NOT EXISTS idx_credits_model ON attribution_credits(model, channel);

-- Credited outcomes per channel per model, joined to the money.
CREATE VIEW IF NOT EXISTS v_attribution_by_channel AS
SELECT
  ac.model,
  ac.channel,
  SUM(ac.credit)                                                        AS enquiries_credited,
  SUM(CASE WHEN o.stage = 'Application' OR o.stage='Offer' OR o.stage='Funded' THEN ac.credit ELSE 0 END) AS applications_credited,
  SUM(CASE WHEN o.stage = 'Funded' THEN ac.credit ELSE 0 END)           AS funded_credited,
  SUM(CASE WHEN o.stage = 'Funded' THEN ac.credit * COALESCE(l.principal_gbp, 0) ELSE 0 END) AS principal_credited
FROM attribution_credits ac
JOIN sf_opportunities o ON o.opp_id = ac.opp_id
LEFT JOIN loans l ON l.opp_id = o.opp_id
GROUP BY ac.model, ac.channel;

-- Total spend per channel over the whole window (ad platforms + invoices).
CREATE VIEW IF NOT EXISTS v_spend_by_channel AS
SELECT channel, SUM(spend_gbp) AS spend_gbp, SUM(clicks) AS clicks, SUM(impressions) AS impressions
FROM ad_spend GROUP BY channel;
