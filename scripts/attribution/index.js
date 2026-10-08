'use strict';

/**
 * Attribution: first click → funded loan.
 *
 *   resolve   anonymous ids → people (identity_links, confidence-weighted)
 *   stitch    every opportunity gets a journey: the person's touches in the
 *             lookback window before the enquiry
 *   models    first / last / linear / position-based / time-decay credit per channel
 *   report    credited enquiries and funded loans per channel, against spend,
 *             next to what Salesforce Lead Source says
 *
 * Deliberate choices (see docs/decisions/ADR-002-attribution.md):
 *   - impressions ride along in the journey but only earn credit when they are
 *     all a journey has; clicks, visits, opens, events and referrals earn credit
 *   - journeys with no resolvable touches are reported as unattributed, never
 *     silently dropped and never guessed
 *   - the referral channel has no ad spend but carries a 2% commission on
 *     funded principal, so cost per funded loan is still comparable
 */

const fs = require('fs');
const path = require('path');
const config = require('../../lib/config');
const db = require('../../lib/db');
const ui = require('../../lib/ui');
const { weeksEnding, diffDays, addDays } = require('../../lib/dates');
const { logger } = require('../../lib/logger');
const { Rng } = require('../../lib/rng');

const log = logger('attribution');
const MODELS = ['first_touch', 'last_touch', 'linear', 'position_based', 'time_decay'];
const CREDIT_TYPES = new Set(['click', 'visit', 'form_submit', 'email_click', 'event_attend', 'referral_intro', 'call', 'email_open']);
const REFERRAL_COMMISSION = 0.02;
const MIN_CONFIDENCE = 0.75;

// ---- 1. identity resolution ---------------------------------------------

function resolve(conn) {
  const before = db.scalar(conn, 'SELECT COUNT(*) FROM touches WHERE contact_id IS NOT NULL');
  // highest-confidence link per anon id wins
  conn.exec(`
    UPDATE touches SET contact_id = (
      SELECT il.contact_id FROM identity_links il
      WHERE il.anon_id = touches.anon_id AND il.confidence >= ${MIN_CONFIDENCE}
      ORDER BY il.confidence DESC, il.linked_at ASC LIMIT 1)
    WHERE contact_id IS NULL AND anon_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM identity_links il WHERE il.anon_id = touches.anon_id AND il.confidence >= ${MIN_CONFIDENCE});
    UPDATE touches SET firm_id = (SELECT c.firm_id FROM contacts c WHERE c.contact_id = touches.contact_id)
    WHERE firm_id IS NULL AND contact_id IS NOT NULL;
  `);
  const after = db.scalar(conn, 'SELECT COUNT(*) FROM touches WHERE contact_id IS NOT NULL');
  const total = db.scalar(conn, 'SELECT COUNT(*) FROM touches');
  const anonTotal = db.scalar(conn, 'SELECT COUNT(DISTINCT anon_id) FROM touches WHERE anon_id IS NOT NULL');
  const anonLinked = db.scalar(conn, `SELECT COUNT(DISTINCT anon_id) FROM identity_links WHERE confidence >= ${MIN_CONFIDENCE}`);
  const methods = db.all(conn, 'SELECT method, COUNT(*) AS n, ROUND(AVG(confidence),2) AS conf FROM identity_links GROUP BY method ORDER BY n DESC');
  const out = { touches_total: total, touches_resolved: after, newly_resolved: after - before, anon_ids: anonTotal, anon_linked: anonLinked, methods };
  log.info('identity resolution', out);
  return out;
}

// ---- 2. journeys ----------------------------------------------------------

function stitch(conn, { lookbackDays = config.ATTRIBUTION_LOOKBACK_DAYS } = {}) {
  conn.exec('DELETE FROM journey_touches; DELETE FROM journeys; DELETE FROM attribution_credits;');
  const opps = db.all(conn, 'SELECT opp_id, contact_id, firm_id, created_at FROM sf_opportunities ORDER BY created_at');
  const touchStmt = conn.prepare(`SELECT touch_id, channel, touch_type, ts FROM touches
    WHERE contact_id = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC`);
  const insJ = conn.prepare('INSERT INTO journeys (journey_id, opp_id, contact_id, firm_id, enquiry_at, lookback_days, touch_count, first_touch_id, last_touch_id, resolution, built_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const insJT = conn.prepare('INSERT INTO journey_touches (journey_id, touch_id, position, channel, touch_type, ts, days_before_enquiry) VALUES (?,?,?,?,?,?,?)');
  const rng = new Rng(config.SEED + 11);
  const now = new Date().toISOString();
  let resolved = 0;
  let unresolved = 0;
  let touchesUsed = 0;
  conn.exec('BEGIN');
  for (const o of opps) {
    const from = addDays(o.created_at, -lookbackDays).toISOString();
    const to = addDays(o.created_at, 0.05).toISOString(); // the form submit itself sits a minute after creation at most
    const touches = o.contact_id ? touchStmt.all(o.contact_id, from, to) : [];
    const jid = rng.id('jny', 10);
    const resolution = touches.length ? 'resolved' : 'unresolved';
    insJ.run(jid, o.opp_id, o.contact_id, o.firm_id, o.created_at, lookbackDays, touches.length, touches[0]?.touch_id || null, touches.at(-1)?.touch_id || null, resolution, now);
    touches.forEach((t, i) => insJT.run(jid, t.touch_id, i + 1, t.channel, t.touch_type, t.ts, Math.max(0, diffDays(o.created_at, t.ts))));
    if (touches.length) resolved++;
    else unresolved++;
    touchesUsed += touches.length;
  }
  conn.exec('COMMIT');
  const dist = db.all(conn, 'SELECT touch_count AS n, COUNT(*) AS journeys FROM journeys GROUP BY touch_count ORDER BY touch_count');
  const out = { opportunities: opps.length, resolved, unresolved, avg_touches: resolved ? touchesUsed / resolved : 0, distribution: dist };
  log.info('journeys stitched', { opportunities: opps.length, resolved, unresolved });
  return out;
}

// ---- 3. models ------------------------------------------------------------

function creditsFor(model, touches) {
  // touches: [{channel, touch_type, days_before_enquiry}] in time order
  let eligible = touches.filter((t) => CREDIT_TYPES.has(t.touch_type));
  if (!eligible.length) eligible = touches; // impressions only: they get the credit
  const n = eligible.length;
  const weights = new Array(n).fill(0);
  if (model === 'first_touch') weights[0] = 1;
  else if (model === 'last_touch') weights[n - 1] = 1;
  else if (model === 'linear') weights.fill(1 / n);
  else if (model === 'position_based') {
    if (n === 1) weights[0] = 1;
    else if (n === 2) weights[0] = weights[1] = 0.5;
    else {
      weights[0] = 0.4;
      weights[n - 1] = 0.4;
      for (let i = 1; i < n - 1; i++) weights[i] = 0.2 / (n - 2);
    }
  } else if (model === 'time_decay') {
    const raw = eligible.map((t) => Math.pow(2, -t.days_before_enquiry / 7));
    const sum = raw.reduce((a, b) => a + b, 0);
    raw.forEach((w, i) => (weights[i] = w / sum));
  }
  const byChannel = {};
  eligible.forEach((t, i) => (byChannel[t.channel] = (byChannel[t.channel] || 0) + weights[i]));
  return byChannel;
}

function models(conn) {
  conn.exec('DELETE FROM attribution_credits');
  const journeys = db.all(conn, 'SELECT journey_id, opp_id FROM journeys WHERE touch_count > 0');
  const jt = conn.prepare('SELECT channel, touch_type, days_before_enquiry FROM journey_touches WHERE journey_id = ? ORDER BY position');
  const ins = conn.prepare('INSERT INTO attribution_credits (model, opp_id, journey_id, channel, credit, run_at) VALUES (?,?,?,?,?,?)');
  const now = new Date().toISOString();
  let rows = 0;
  conn.exec('BEGIN');
  for (const j of journeys) {
    const touches = jt.all(j.journey_id);
    for (const model of MODELS) {
      for (const [channel, credit] of Object.entries(creditsFor(model, touches))) {
        ins.run(model, j.opp_id, j.journey_id, channel, credit, now);
        rows++;
      }
    }
  }
  conn.exec('COMMIT');
  log.info('credits computed', { journeys: journeys.length, rows });
  return { journeys: journeys.length, credit_rows: rows };
}

// ---- 4. report ------------------------------------------------------------

function report(conn, { weeks = config.WORLD_WEEKS, quiet = false } = {}) {
  const wk = weeksEnding(config.WORLD_END, weeks);
  const start = wk[0];
  const endExclusive = addDays(wk.at(-1), 7).toISOString().slice(0, 10);
  const channels = Object.keys(config.LENDER.channels);

  const spend = {};
  for (const r of db.all(conn, 'SELECT channel, SUM(spend_gbp) AS s FROM ad_spend WHERE week_start >= ? AND week_start < ? GROUP BY channel', start, endExclusive)) spend[r.channel] = r.s;

  const credited = {};
  for (const model of MODELS) {
    credited[model] = {};
    const rows = db.all(
      conn,
      `SELECT ac.channel,
              SUM(ac.credit) AS enquiries,
              SUM(CASE WHEN o.stage='Funded' THEN ac.credit ELSE 0 END) AS funded,
              SUM(CASE WHEN o.stage='Funded' THEN ac.credit * COALESCE(l.principal_gbp,0) ELSE 0 END) AS principal
       FROM attribution_credits ac
       JOIN sf_opportunities o ON o.opp_id = ac.opp_id
       LEFT JOIN loans l ON l.opp_id = o.opp_id
       WHERE ac.model = ? AND o.created_at >= ? AND o.created_at < ?
       GROUP BY ac.channel`,
      model,
      start,
      endExclusive,
    );
    for (const r of rows) credited[model][r.channel] = r;
  }

  // what Salesforce says
  const crm = {};
  for (const r of db.all(
    conn,
    `SELECT COALESCE(NULLIF(l.lead_source,''),'(blank)') AS src, COUNT(*) AS enquiries,
            SUM(CASE WHEN o.stage='Funded' THEN 1 ELSE 0 END) AS funded
     FROM sf_opportunities o LEFT JOIN sf_leads l ON l.lead_id=o.lead_id
     WHERE o.created_at >= ? AND o.created_at < ? GROUP BY src ORDER BY enquiries DESC`,
    start,
    endExclusive,
  )) crm[r.src] = r;

  const totals = db.one(conn, `SELECT COUNT(*) AS enquiries, SUM(CASE WHEN stage='Funded' THEN 1 ELSE 0 END) AS funded FROM sf_opportunities WHERE created_at >= ? AND created_at < ?`, start, endExclusive);
  const unresolved = db.one(conn, `SELECT COUNT(*) AS n, SUM(CASE WHEN o.stage='Funded' THEN 1 ELSE 0 END) AS funded FROM journeys j JOIN sf_opportunities o ON o.opp_id=j.opp_id WHERE j.touch_count = 0 AND o.created_at >= ? AND o.created_at < ?`, start, endExclusive);

  const table = (model) =>
    channels
      .map((ch) => {
        const c = credited[model][ch] || { enquiries: 0, funded: 0, principal: 0 };
        const commission = ch === 'solicitor_referral' ? c.principal * REFERRAL_COMMISSION : 0;
        const cost = (spend[ch] || 0) + commission;
        return {
          channel: ch,
          label: config.LENDER.channels[ch],
          enquiries: c.enquiries,
          funded: c.funded,
          principal: c.principal,
          spend: spend[ch] || 0,
          commission,
          cost,
          cost_per_enquiry: c.enquiries && cost > 0 ? cost / c.enquiries : null,
          cost_per_funded: c.funded && cost > 0 ? cost / c.funded : null,
          cost_per_pound_funded: c.principal && cost > 0 ? cost / c.principal : null,
        };
      })
      .filter((r) => r.enquiries > 0 || r.spend > 0);

  const out = {
    window: { start, end: wk.at(-1), weeks },
    totals: { ...totals, unresolved: unresolved.n, unresolved_funded: unresolved.funded, unattributed_share: totals.enquiries ? unresolved.n / totals.enquiries : 0 },
    models: Object.fromEntries(MODELS.map((m) => [m, table(m)])),
    crm_lead_source: crm,
    generated_at: new Date().toISOString(),
  };

  const dir = path.join(config.REPORTS_DIR, 'attribution');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(dir, 'latest.md'), toMarkdown(out));

  if (!quiet) {
    ui.section(`Attribution · ${weeks} weeks to ${wk.at(-1)} · lookback ${config.ATTRIBUTION_LOOKBACK_DAYS} days`);
    ui.kv([
      ['opportunities in window', `${ui.num(totals.enquiries)}  (${ui.num(totals.funded)} funded)`],
      ['journeys with no resolvable touch', `${ui.num(unresolved.n)}  (${ui.pct(out.totals.unattributed_share)} · reported as unattributed, never guessed)`],
    ]);
    ui.blank();
    ui.info('position-based model (40% first touch, 40% last touch, 20% in between) · cost includes 2% referral commission');
    ui.table(table('position_based'), [
      { key: 'label', label: 'channel' },
      { key: 'enquiries', label: 'enquiries', align: 'right', fmt: (v) => ui.num(v, 1) },
      { key: 'funded', label: 'funded', align: 'right', fmt: (v) => ui.num(v, 1) },
      { key: 'principal', label: 'principal', align: 'right', fmt: (v) => ui.money(v) },
      { key: 'cost', label: 'cost', align: 'right', fmt: (v) => ui.money(v) },
      { key: 'cost_per_enquiry', label: '£ / enquiry', align: 'right', fmt: (v) => ui.money(v) },
      { key: 'cost_per_funded', label: '£ / funded loan', align: 'right', fmt: (v) => ui.money(v) },
    ]);
    ui.blank();
    ui.info('the same funded loans under every model, next to what Salesforce Lead Source says');
    const compare = channels.map((ch) => ({ label: config.LENDER.channels[ch], ...Object.fromEntries(MODELS.map((m) => [m, (credited[m][ch] || {}).funded || 0])) }));
    ui.table(compare.filter((r) => MODELS.some((m) => r[m] > 0)), [
      { key: 'label', label: 'channel' },
      ...MODELS.map((m) => ({ key: m, label: m.replace('_', ' '), align: 'right', fmt: (v) => ui.num(v, 1) })),
    ]);
    ui.blank();
    ui.table(
      Object.entries(crm).map(([src, r]) => ({ src, enquiries: r.enquiries, funded: r.funded })),
      [
        { key: 'src', label: 'Salesforce "Lead Source"' },
        { key: 'enquiries', label: 'enquiries', align: 'right', fmt: (v) => ui.num(v) },
        { key: 'funded', label: 'funded', align: 'right', fmt: (v) => ui.num(v) },
      ],
    );
    ui.ok(`written reports/attribution/latest.md and latest.json`);
  }
  return out;
}

function toMarkdown(r) {
  const row = (x) => `| ${x.label} | ${x.enquiries.toFixed(1)} | ${x.funded.toFixed(1)} | £${Math.round(x.principal).toLocaleString('en-GB')} | £${Math.round(x.cost).toLocaleString('en-GB')} | ${x.cost_per_funded ? '£' + Math.round(x.cost_per_funded).toLocaleString('en-GB') : '—'} |`;
  const lines = [
    `# Attribution report`,
    ``,
    `Window: ${r.window.start} to ${r.window.end} (${r.window.weeks} weeks). Generated ${r.generated_at}.`,
    ``,
    `Opportunities: ${r.totals.enquiries} (${r.totals.funded} funded). Unattributed: ${r.totals.unresolved} (${(r.totals.unattributed_share * 100).toFixed(1)}%).`,
    ``,
  ];
  for (const [model, rows] of Object.entries(r.models)) {
    lines.push(`## ${model.replace('_', ' ')}`, ``, `| channel | enquiries | funded | principal | cost | cost per funded loan |`, `|---|---:|---:|---:|---:|---:|`);
    rows.forEach((x) => lines.push(row(x)));
    lines.push(``);
  }
  lines.push(`## Salesforce Lead Source (as typed by people)`, ``, `| source | enquiries | funded |`, `|---|---:|---:|`);
  for (const [src, x] of Object.entries(r.crm_lead_source)) lines.push(`| ${src} | ${x.enquiries} | ${x.funded} |`);
  return lines.join('\n') + '\n';
}

async function run({ quiet = false } = {}) {
  const conn = db.open();
  if (!quiet) ui.section('Attribution pipeline');
  const r = resolve(conn);
  if (!quiet) ui.ok(`identity resolution: ${ui.num(r.touches_resolved)} of ${ui.num(r.touches_total)} touches now belong to a known person (${ui.num(r.anon_linked)} of ${ui.num(r.anon_ids)} anonymous ids linked)`);
  if (!quiet) ui.info(r.methods.map((m) => `${m.method} ×${m.n} @${m.conf}`).join(' · '));
  const s = stitch(conn);
  if (!quiet) ui.ok(`journeys: ${ui.num(s.resolved)} resolved, ${ui.num(s.unresolved)} unresolved · avg ${s.avg_touches.toFixed(1)} touches per resolved journey`);
  const m = models(conn);
  if (!quiet) ui.ok(`credits: ${MODELS.length} models × ${ui.num(m.journeys)} journeys → ${ui.num(m.credit_rows)} credit rows`);
  const rep = report(conn, { quiet });
  return { resolve: r, stitch: s, models: m, report: rep };
}

module.exports = { run, resolve, stitch, models, report, creditsFor, MODELS };
