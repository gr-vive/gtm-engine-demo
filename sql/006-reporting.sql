-- ============================================================
-- 006 reporting: the weekly numbers everyone works from.
-- Activity view: what happened in each week (stage entries), by product and channel.
-- The channel comes from last-touch attribution when a journey exists,
-- otherwise from the Salesforce lead_source as entered by a human.
-- ============================================================

CREATE VIEW IF NOT EXISTS v_opp_channel AS
SELECT
  o.opp_id,
  o.product,
  o.created_at,
  COALESCE(
    (SELECT ac.channel FROM attribution_credits ac
      WHERE ac.opp_id = o.opp_id AND ac.model = 'last_touch'
      ORDER BY ac.credit DESC LIMIT 1),
    CASE l.lead_source
      WHEN 'Google Ads' THEN 'google_ads'
      WHEN 'LinkedIn' THEN 'linkedin_ads'
      WHEN 'Event' THEN 'events'
      WHEN 'Solicitor Referral' THEN 'solicitor_referral'
      WHEN 'Outbound' THEN 'outbound_email'
      WHEN 'Email' THEN 'outbound_email'
      WHEN 'Organic' THEN 'organic_search'
      WHEN 'Phone' THEN 'direct'
      ELSE 'unattributed'                      -- 'Web', blank, anything else a person typed
    END
  ) AS channel,
  CASE WHEN EXISTS (SELECT 1 FROM attribution_credits ac WHERE ac.opp_id = o.opp_id AND ac.model='last_touch')
       THEN 'attribution' ELSE 'crm_lead_source' END AS channel_source
FROM sf_opportunities o
LEFT JOIN sf_leads l ON l.lead_id = o.lead_id;

-- Stage entries bucketed by ISO week start (Monday).
CREATE VIEW IF NOT EXISTS v_stage_events_weekly AS
SELECT
  date(h.entered_at, '-6 days', 'weekday 1') AS week_start,
  oc.product,
  oc.channel,
  h.stage,
  COUNT(*) AS n,
  SUM(CASE WHEN h.stage = 'Funded' THEN COALESCE(ln.principal_gbp, 0) ELSE 0 END) AS principal_gbp
FROM sf_opportunity_history h
JOIN v_opp_channel oc ON oc.opp_id = h.opp_id
LEFT JOIN loans ln ON ln.opp_id = h.opp_id AND h.stage = 'Funded'
GROUP BY 1, 2, 3, 4;

CREATE VIEW IF NOT EXISTS v_weekly_funnel AS
SELECT
  week_start,
  product,
  channel,
  SUM(CASE WHEN stage = 'Enquiry' THEN n ELSE 0 END)     AS enquiries,
  SUM(CASE WHEN stage = 'Application' THEN n ELSE 0 END) AS applications,
  SUM(CASE WHEN stage = 'Offer' THEN n ELSE 0 END)       AS offers,
  SUM(CASE WHEN stage = 'Funded' THEN n ELSE 0 END)      AS funded,
  SUM(principal_gbp)                                     AS principal_gbp
FROM v_stage_events_weekly
GROUP BY 1, 2, 3;

CREATE VIEW IF NOT EXISTS v_weekly_spend AS
SELECT week_start, channel, SUM(spend_gbp) AS spend_gbp
FROM ad_spend GROUP BY 1, 2;
