-- ============================================================
-- 002 touches: everything marketing does that a person can be exposed to,
-- plus what it cost. This is the "first click" end of attribution.
-- ============================================================

CREATE TABLE IF NOT EXISTS ad_spend (
  spend_id        TEXT PRIMARY KEY,
  week_start      TEXT NOT NULL,                -- Monday, YYYY-MM-DD
  channel         TEXT NOT NULL,
  campaign        TEXT,
  product         TEXT,                         -- family_law | probate | both
  spend_gbp       REAL NOT NULL DEFAULT 0,
  impressions     INTEGER,
  clicks          INTEGER,
  source          TEXT                          -- ads_api | invoice | finance_export
);
CREATE INDEX IF NOT EXISTS idx_spend_week ON ad_spend(week_start, channel);

-- One row per exposure. anon_id is what the website/ad platform knows;
-- contact_id is filled in by identity resolution, never by the source system.
CREATE TABLE IF NOT EXISTS touches (
  touch_id        TEXT PRIMARY KEY,
  ts              TEXT NOT NULL,
  channel         TEXT NOT NULL,
  campaign        TEXT,
  touch_type      TEXT NOT NULL,                -- impression | click | visit | form_submit | email_open | email_click | event_attend | referral_intro | call
  anon_id         TEXT,
  contact_id      TEXT,
  firm_id         TEXT,
  utm_source      TEXT,
  utm_medium      TEXT,
  utm_campaign    TEXT,
  utm_content     TEXT,
  landing_path    TEXT,
  product_hint    TEXT,
  cost_gbp        REAL                          -- click-level cost where the platform reports it
);
CREATE INDEX IF NOT EXISTS idx_touches_anon ON touches(anon_id);
CREATE INDEX IF NOT EXISTS idx_touches_contact ON touches(contact_id, ts);
CREATE INDEX IF NOT EXISTS idx_touches_ts ON touches(ts);

-- How an anonymous id became a known person. Append-only, with the method and
-- a confidence so a later audit can see why a journey was stitched the way it was.
CREATE TABLE IF NOT EXISTS identity_links (
  link_id         TEXT PRIMARY KEY,
  anon_id         TEXT NOT NULL,
  contact_id      TEXT NOT NULL,
  method          TEXT NOT NULL,                -- form_email | email_click_token | crm_match | referral_partner
  confidence      REAL NOT NULL,
  linked_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_links_anon ON identity_links(anon_id);
