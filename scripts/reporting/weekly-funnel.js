'use strict';

/**
 * The weekly numbers: one view of the funnel by product and by channel,
 * produced by a system, not a person with a spreadsheet.
 *
 * Activity view: how many opportunities ENTERED each stage during the week.
 * Cohort view:   of the enquiries received N weeks ago, how many have funded by now.
 * Channel comes from last-touch attribution when a journey exists, otherwise
 * from Salesforce Lead Source (and the report says which).
 */

const fs = require('fs');
const path = require('path');
const config = require('../../lib/config');
const db = require('../../lib/db');
const ui = require('../../lib/ui');
const { weeksEnding, isoWeek, addDays, ymd } = require('../../lib/dates');
const { logger } = require('../../lib/logger');

const log = logger('weekly');

function weekRows(conn, weekStart) {
  return db.all(conn, 'SELECT * FROM v_weekly_funnel WHERE week_start = ?', weekStart);
}

function sumBy(rows, keyFn) {
  const out = {};
  for (const r of rows) {
    const k = keyFn(r);
    out[k] = out[k] || { enquiries: 0, applications: 0, offers: 0, funded: 0, principal_gbp: 0 };
    for (const f of ['enquiries', 'applications', 'offers', 'funded', 'principal_gbp']) out[k][f] += r[f] || 0;
  }
  return out;
}

function build({ week, quiet = false } = {}) {
  const conn = db.open();
  const weeks = weeksEnding(config.WORLD_END, 12);
  const current = week || weeks.at(-1);
  const prev = ymd(addDays(current, -7));
  const rows = weekRows(conn, current);
  const prevRows = weekRows(conn, prev);
  const spendRows = db.all(conn, 'SELECT channel, spend_gbp FROM v_weekly_spend WHERE week_start = ?', current);
  const spend = Object.fromEntries(spendRows.map((r) => [r.channel, r.spend_gbp]));

  const total = Object.values(sumBy(rows, () => 'all'))[0] || { enquiries: 0, applications: 0, offers: 0, funded: 0, principal_gbp: 0 };
  const prevTotal = Object.values(sumBy(prevRows, () => 'all'))[0] || total;
  const byProduct = sumBy(rows, (r) => r.product);
  const byChannel = sumBy(rows, (r) => r.channel);
  const totalSpend = Object.values(spend).reduce((a, b) => a + b, 0);

  const channelTable = Object.keys(config.LENDER.channels)
    .concat(Object.keys(byChannel).filter((c) => !config.LENDER.channels[c]))
    .filter((ch) => byChannel[ch] || spend[ch])
    .map((ch) => {
      const c = byChannel[ch] || { enquiries: 0, applications: 0, offers: 0, funded: 0, principal_gbp: 0 };
      const s = spend[ch] || 0;
      return { channel: ch, label: config.LENDER.channels[ch] || ch, ...c, spend: s, cpl: c.enquiries && s > 0 ? s / c.enquiries : null, cost_per_funded: c.funded && s > 0 ? s / c.funded : null };
    });

  // trailing 12 weeks
  const trend = weeks.map((w) => {
    const t = Object.values(sumBy(weekRows(conn, w), () => 'all'))[0] || { enquiries: 0, applications: 0, offers: 0, funded: 0, principal_gbp: 0 };
    const s = db.scalar(conn, 'SELECT COALESCE(SUM(spend_gbp),0) FROM v_weekly_spend WHERE week_start = ?', w);
    return { week_start: w, iso: isoWeek(w), ...t, spend: s };
  });

  // cohort: enquiries received 8 weeks ago → where are they now
  const cohortWeek = ymd(addDays(current, -7 * 8));
  const cohort = db.all(
    conn,
    `SELECT o.product, COUNT(*) AS enquiries,
            SUM(EXISTS (SELECT 1 FROM sf_opportunity_history h WHERE h.opp_id = o.opp_id AND h.stage = 'Application')) AS reached_application,
            SUM(EXISTS (SELECT 1 FROM sf_opportunity_history h WHERE h.opp_id = o.opp_id AND h.stage = 'Offer')) AS reached_offer,
            SUM(CASE WHEN o.stage = 'Funded' THEN 1 ELSE 0 END) AS funded,
            SUM(CASE WHEN o.stage IN ('Declined','Withdrawn') THEN 1 ELSE 0 END) AS lost,
            SUM(CASE WHEN o.stage IN ('Enquiry','Application','Offer') THEN 1 ELSE 0 END) AS still_open
     FROM sf_opportunities o WHERE date(o.created_at,'-6 days','weekday 1') = ? GROUP BY o.product`,
    cohortWeek,
  );

  const channelSource = db.one(conn, `SELECT SUM(CASE WHEN channel_source='attribution' THEN 1 ELSE 0 END) AS attributed, COUNT(*) AS total FROM v_opp_channel WHERE date(created_at,'-6 days','weekday 1') = ?`, current);

  const out = {
    week_start: current,
    iso_week: isoWeek(current),
    generated_at: new Date().toISOString(),
    totals: { ...total, spend: totalSpend, cost_per_funded: total.funded && totalSpend > 0 ? totalSpend / total.funded : null },
    previous: prevTotal,
    by_product: byProduct,
    by_channel: channelTable,
    trend,
    cohort: { week_start: cohortWeek, iso_week: isoWeek(cohortWeek), rows: cohort },
    channel_source: channelSource,
  };

  const dir = path.join(config.REPORTS_DIR, 'weekly');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${out.iso_week}.json`), JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(dir, `${out.iso_week}.md`), toMarkdown(out));
  fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(out, null, 2));
  log.info('weekly report built', { week: out.iso_week, enquiries: total.enquiries, funded: total.funded });

  if (!quiet) print(out);
  return out;
}

const delta = (cur, prev) => {
  if (!prev) return ui.c.dim('—');
  const d = (cur - prev) / prev;
  const s = `${d >= 0 ? '+' : ''}${(d * 100).toFixed(0)}%`;
  return d > 0.02 ? ui.c.green(s) : d < -0.02 ? ui.c.red(s) : ui.c.dim(s);
};

function print(r) {
  ui.section(`Weekly numbers · ${r.iso_week} (w/c ${r.week_start}) · ${config.LENDER.name}`);
  const t = r.totals;
  const p = r.previous;
  ui.table(
    [
      { k: 'Enquiries', v: t.enquiries, d: delta(t.enquiries, p.enquiries) },
      { k: 'Applications', v: t.applications, d: delta(t.applications, p.applications) },
      { k: 'Offers', v: t.offers, d: delta(t.offers, p.offers) },
      { k: 'Funded loans', v: t.funded, d: delta(t.funded, p.funded) },
      { k: 'Principal funded', v: ui.money(t.principal_gbp), d: delta(t.principal_gbp, p.principal_gbp) },
      { k: 'Marketing spend', v: ui.money(t.spend), d: '' },
      { k: 'Spend per funded loan', v: ui.money(t.cost_per_funded), d: '' },
    ],
    [{ key: 'k', label: 'this week' }, { key: 'v', label: 'value', align: 'right' }, { key: 'd', label: 'vs last week', align: 'right' }],
  );
  ui.blank();
  ui.info('by product');
  ui.table(
    Object.entries(r.by_product).map(([prod, v]) => ({ product: config.LENDER.products[prod]?.label || prod, ...v })),
    [
      { key: 'product', label: 'product' },
      { key: 'enquiries', label: 'enq', align: 'right' },
      { key: 'applications', label: 'app', align: 'right' },
      { key: 'offers', label: 'offer', align: 'right' },
      { key: 'funded', label: 'funded', align: 'right' },
      { key: 'principal_gbp', label: 'principal', align: 'right', fmt: (v) => ui.money(v) },
    ],
  );
  ui.blank();
  ui.info(`by channel · channel from attribution for ${r.channel_source.attributed}/${r.channel_source.total} enquiries this week, Salesforce Lead Source for the rest`);
  ui.table(r.by_channel, [
    { key: 'label', label: 'channel' },
    { key: 'enquiries', label: 'enq', align: 'right' },
    { key: 'applications', label: 'app', align: 'right' },
    { key: 'offers', label: 'offer', align: 'right' },
    { key: 'funded', label: 'funded', align: 'right' },
    { key: 'principal_gbp', label: 'principal', align: 'right', fmt: (v) => ui.money(v) },
    { key: 'spend', label: 'spend', align: 'right', fmt: (v) => ui.money(v) },
    { key: 'cpl', label: '£/enq', align: 'right', fmt: (v) => ui.money(v) },
    { key: 'cost_per_funded', label: '£/funded', align: 'right', fmt: (v) => ui.money(v) },
  ]);
  ui.blank();
  ui.info(`cohort: enquiries received in ${r.cohort.iso_week}, where they are 8 weeks later`);
  ui.table(r.cohort.rows.map((c) => ({ ...c, product: config.LENDER.products[c.product]?.label || c.product, conv: c.enquiries ? c.funded / c.enquiries : 0 })), [
    { key: 'product', label: 'product' },
    { key: 'enquiries', label: 'enq', align: 'right' },
    { key: 'reached_application', label: '→app', align: 'right' },
    { key: 'reached_offer', label: '→offer', align: 'right' },
    { key: 'funded', label: '→funded', align: 'right' },
    { key: 'lost', label: 'lost', align: 'right' },
    { key: 'still_open', label: 'open', align: 'right' },
    { key: 'conv', label: 'enq→funded', align: 'right', fmt: (v) => ui.pct(v) },
  ]);
  ui.blank();
  ui.info('trailing 12 weeks');
  ui.table(r.trend, [
    { key: 'iso', label: 'week' },
    { key: 'enquiries', label: 'enq', align: 'right' },
    { key: 'applications', label: 'app', align: 'right' },
    { key: 'offers', label: 'offer', align: 'right' },
    { key: 'funded', label: 'funded', align: 'right' },
    { key: 'principal_gbp', label: 'principal', align: 'right', fmt: (v) => ui.money(v) },
    { key: 'spend', label: 'spend', align: 'right', fmt: (v) => ui.money(v) },
    { key: (row) => (row.funded ? row.spend / row.funded : null), label: '£/funded', align: 'right', fmt: (v) => ui.money(v) },
  ]);
  ui.ok(`written reports/weekly/${r.iso_week}.md and .json`);
}

function toMarkdown(r) {
  const t = r.totals;
  const L = [
    `# Weekly numbers · ${r.iso_week} (w/c ${r.week_start})`,
    ``,
    `Generated ${r.generated_at} by gtm-engine. Channel = last-touch attribution where a journey exists (${r.channel_source.attributed}/${r.channel_source.total} this week), else Salesforce Lead Source.`,
    ``,
    `| metric | this week | last week |`,
    `|---|---:|---:|`,
    `| Enquiries | ${t.enquiries} | ${r.previous.enquiries} |`,
    `| Applications | ${t.applications} | ${r.previous.applications} |`,
    `| Offers | ${t.offers} | ${r.previous.offers} |`,
    `| Funded loans | ${t.funded} | ${r.previous.funded} |`,
    `| Principal funded | £${Math.round(t.principal_gbp).toLocaleString('en-GB')} | £${Math.round(r.previous.principal_gbp).toLocaleString('en-GB')} |`,
    `| Marketing spend | £${Math.round(t.spend).toLocaleString('en-GB')} | |`,
    ``,
    `## By channel`,
    ``,
    `| channel | enquiries | applications | offers | funded | principal | spend | £/enquiry | £/funded |`,
    `|---|---:|---:|---:|---:|---:|---:|---:|---:|`,
  ];
  for (const c of r.by_channel) L.push(`| ${c.label} | ${c.enquiries} | ${c.applications} | ${c.offers} | ${c.funded} | £${Math.round(c.principal_gbp).toLocaleString('en-GB')} | £${Math.round(c.spend).toLocaleString('en-GB')} | ${c.cpl ? '£' + Math.round(c.cpl) : '—'} | ${c.cost_per_funded ? '£' + Math.round(c.cost_per_funded) : '—'} |`);
  L.push(``, `## By product`, ``, `| product | enquiries | applications | offers | funded | principal |`, `|---|---:|---:|---:|---:|---:|`);
  for (const [p, v] of Object.entries(r.by_product)) L.push(`| ${config.LENDER.products[p]?.label || p} | ${v.enquiries} | ${v.applications} | ${v.offers} | ${v.funded} | £${Math.round(v.principal_gbp).toLocaleString('en-GB')} |`);
  L.push(``, `## Cohort: enquiries from ${r.cohort.iso_week}, eight weeks on`, ``, `| product | enquiries | reached application | reached offer | funded | lost | still open |`, `|---|---:|---:|---:|---:|---:|---:|`);
  for (const c of r.cohort.rows) L.push(`| ${config.LENDER.products[c.product]?.label || c.product} | ${c.enquiries} | ${c.reached_application} | ${c.reached_offer} | ${c.funded} | ${c.lost} | ${c.still_open} |`);
  L.push(``, `## Trailing 12 weeks`, ``, `| week | enquiries | applications | offers | funded | principal | spend |`, `|---|---:|---:|---:|---:|---:|---:|`);
  for (const w of r.trend) L.push(`| ${w.iso} | ${w.enquiries} | ${w.applications} | ${w.offers} | ${w.funded} | £${Math.round(w.principal_gbp).toLocaleString('en-GB')} | £${Math.round(w.spend).toLocaleString('en-GB')} |`);
  return L.join('\n') + '\n';
}

module.exports = { build };
