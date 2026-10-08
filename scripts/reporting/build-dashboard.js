'use strict';

/**
 * Builds site/index.html: one self-contained page with the weekly numbers,
 * attribution by model, the AI shadow-mode gate and the outbound registry.
 * No build step, no external scripts; the data is embedded as JSON so the
 * page can be served from GitHub Pages or opened from disk.
 */

const fs = require('fs');
const path = require('path');
const config = require('../../lib/config');
const db = require('../../lib/db');
const { logger } = require('../../lib/logger');

const log = logger('dashboard');

function gather() {
  const conn = db.open();
  const weeklyFile = path.join(config.REPORTS_DIR, 'weekly', 'latest.json');
  const attrFile = path.join(config.REPORTS_DIR, 'attribution', 'latest.json');
  const weekly = fs.existsSync(weeklyFile) ? JSON.parse(fs.readFileSync(weeklyFile, 'utf8')) : require('./weekly-funnel').build({ quiet: true });
  const attribution = fs.existsSync(attrFile) ? JSON.parse(fs.readFileSync(attrFile, 'utf8')) : require('../attribution').report(conn, { quiet: true });
  const evalRow = db.one(conn, 'SELECT * FROM shadow_evals ORDER BY run_at DESC LIMIT 1');
  const ai = evalRow
    ? {
        ...evalRow,
        confusion: JSON.parse(evalRow.confusion_json),
        flagged: JSON.parse(evalRow.flagged_json || '[]'),
        decisions: db.scalar(conn, 'SELECT COUNT(*) FROM ai_decisions'),
        audit_rows: db.scalar(conn, 'SELECT COUNT(*) FROM audit_log'),
        providers: db.all(conn, 'SELECT provider, COUNT(*) AS n FROM ai_decisions GROUP BY provider'),
        rules_version: db.scalar(conn, 'SELECT rules_version FROM ai_decisions ORDER BY created_at DESC LIMIT 1'),
        history: db.all(conn, 'SELECT run_at, route_agreement, n FROM shadow_evals ORDER BY run_at DESC LIMIT 5'),
      }
    : null;
  const registry = require('../audience/pipeline').registrySummary(true);
  const funnel12 = db.all(
    conn,
    `SELECT product, SUM(enquiries) AS enquiries, SUM(applications) AS applications, SUM(offers) AS offers, SUM(funded) AS funded, SUM(principal_gbp) AS principal
     FROM v_weekly_funnel WHERE week_start >= ? GROUP BY product`,
    weekly.trend[0].week_start,
  );
  return { weekly, attribution, ai, registry, funnel12, lender: config.LENDER, generated_at: new Date().toISOString(), seed: config.SEED };
}

function html(d) {
  const L = d.lender;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${L.short} Growth Engine</title>
<meta name="description" content="Weekly numbers, attribution and the AI shadow-mode gate for ${L.name}. Synthetic data generated from one seed.">
<style>
:root{color-scheme:light;
  --surface:#fcfcfb;--surface-2:#f3f2ef;--text:#0b0b0b;--text-2:#52514e;--muted:#8a8984;--grid:#e6e5e1;--line:#dedcd6;
  --s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;--s6:#008300;--s7:#4a3aa7;--ref:#a9a8a2;
  --q1:#86b6ef;--q2:#5598e7;--q3:#2a78d6;--q4:#1c5cab;
  --good:#0ca30c;--warn:#fab219;--critical:#d03b3b;}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){color-scheme:dark;
  --surface:#1a1a19;--surface-2:#232322;--text:#ffffff;--text-2:#c3c2b7;--muted:#8d8c86;--grid:#2e2e2c;--line:#36362f;
  --s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#008300;--s7:#9085e9;--ref:#6f6e69;
  --q1:#184f95;--q2:#256abf;--q3:#3987e5;--q4:#6da7ec;}}
:root[data-theme="dark"]{color-scheme:dark;
  --surface:#1a1a19;--surface-2:#232322;--text:#ffffff;--text-2:#c3c2b7;--muted:#8d8c86;--grid:#2e2e2c;--line:#36362f;
  --s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#008300;--s7:#9085e9;--ref:#6f6e69;
  --q1:#184f95;--q2:#256abf;--q3:#3987e5;--q4:#6da7ec;}
*{box-sizing:border-box}
body{margin:0;background:var(--surface);color:var(--text);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:28px 20px 60px}
header{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 18px;margin-bottom:18px}
h1{font-size:22px;margin:0;font-weight:650;letter-spacing:-.01em}
h2{font-size:15px;margin:0 0 10px;font-weight:650}
.sub{color:var(--text-2)}
.badge{font-size:11px;padding:2px 8px;border:1px solid var(--line);border-radius:999px;color:var(--text-2);background:var(--surface-2)}
.grid{display:grid;gap:14px}
.tiles{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.tile{background:var(--surface-2);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.tile .k{font-size:12px;color:var(--text-2)}
.tile .v{font-size:24px;font-weight:650;letter-spacing:-.01em;margin-top:2px;font-variant-numeric:tabular-nums}
.tile .d{font-size:12px;color:var(--muted);margin-top:2px;font-variant-numeric:tabular-nums}
.d.up{color:var(--good)}.d.down{color:var(--critical)}
.cards{grid-template-columns:repeat(2,minmax(0,1fr));margin-top:16px}
@media (max-width:760px){.cards{grid-template-columns:1fr}}
.card{border:1px solid var(--line);border-radius:12px;padding:16px 18px;background:var(--surface);min-width:0;overflow:hidden}
.card.wide{grid-column:1/-1}
.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:12px 0 14px}
.stat{background:var(--surface-2);border-radius:8px;padding:9px 11px;min-width:0}
.stat .k{font-size:11px;color:var(--text-2);line-height:1.3}
.stat .v{font-size:20px;font-weight:650;letter-spacing:-.01em;font-variant-numeric:tabular-nums;margin-top:2px}
.stat .v.good{color:var(--good)}.stat .v.bad{color:var(--critical)}
table.kv td:first-child{color:var(--text-2);white-space:normal;padding-right:14px}
table.kv td:last-child{font-weight:600;white-space:nowrap}
table.kv tr:last-child td{border-bottom:0}
.sub-h{font-size:12px;font-weight:600;color:var(--text-2);margin:14px 0 4px;text-transform:uppercase;letter-spacing:.04em}
.note{font-size:12px;color:var(--muted);margin:6px 0 0}
svg{width:100%;height:auto;display:block;overflow:visible}
.scroll{overflow-x:auto;padding-bottom:4px}
.scroll svg{min-width:720px}
.axis text,.lbl{fill:var(--text-2);font-size:11px}
.axis line,.grid-line{stroke:var(--grid);stroke-width:1}
.base{stroke:var(--line);stroke-width:1}
.dl{fill:var(--text);font-size:11px;font-weight:600}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:var(--text-2);margin:4px 0 8px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;font-size:13px}
th,td{padding:6px 8px;border-bottom:1px solid var(--grid);text-align:right;white-space:nowrap;vertical-align:top}
th:first-child,td:first-child{text-align:left;white-space:normal}
th{color:var(--text-2);font-weight:600;font-size:12px}
.tabs{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px}
.tabs button{font:inherit;font-size:12px;padding:5px 10px;border-radius:999px;border:1px solid var(--line);background:var(--surface-2);color:var(--text-2);cursor:pointer}
.tabs button[aria-pressed="true"]{background:var(--text);color:var(--surface);border-color:var(--text)}
.tip{position:fixed;pointer-events:none;background:var(--text);color:var(--surface);padding:6px 9px;border-radius:6px;font-size:12px;line-height:1.35;opacity:0;transition:opacity .08s;z-index:9;font-variant-numeric:tabular-nums;max-width:260px}
.gate{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;font-weight:600;font-size:13px}
.gate.pass{background:color-mix(in srgb,var(--good) 14%,var(--surface));color:var(--good)}
.gate.hold{background:color-mix(in srgb,var(--critical) 12%,var(--surface));color:var(--critical)}
details{margin-top:8px}summary{cursor:pointer;color:var(--text-2);font-size:12px}
.cm td.diag{font-weight:600;color:var(--good)}.cm td.off{color:var(--critical)}
footer{margin-top:28px;color:var(--muted);font-size:12px;line-height:1.6}
a{color:var(--s1)}
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>${L.name} · growth engine</h1>
  <span class="sub">week ${d.weekly.iso_week} (w/c ${d.weekly.week_start})</span>
  <span class="badge">synthetic data · seed ${d.seed}</span>
  <span class="badge">generated ${d.generated_at.slice(0, 16)}Z</span>
</header>

<div class="grid tiles" id="tiles"></div>

<div class="grid cards">
  <div class="card wide">
    <h2>Enquiries and funded loans, trailing 12 weeks</h2>
    <div class="legend" id="trend-legend"></div>
    <div id="trend" class="scroll"></div>
    <details><summary>table</summary><div id="trend-table"></div></details>
  </div>

  <div class="card">
    <h2>Funnel by product, trailing 12 weeks</h2>
    <div id="funnel"></div>
    <p class="note">Stage entries in the window. Shade order: enquiry → application → offer → funded.</p>
  </div>

  <div class="card">
    <h2>Marketing spend per funded loan, by week</h2>
    <div id="spend"></div>
    <p class="note">Ad platforms and invoices only; referral commission is shown in the attribution table.</p>
  </div>

  <div class="card wide">
    <h2>Which channel produced the funded loans</h2>
    <div class="tabs" id="models" role="group" aria-label="attribution model"></div>
    <div class="legend"><span><i style="background:var(--s1)"></i>attribution (selected model)</span><span><i style="background:var(--ref)"></i>Salesforce “Lead Source” as typed</span></div>
    <div id="channels" class="scroll"></div>
    <div id="channel-table" class="scroll"></div>
    <p class="note" id="attr-note"></p>
  </div>

  <div class="card">
    <h2>AI triage · shadow mode gate</h2>
    <div id="ai"></div>
  </div>

  <div class="card">
    <h2>Outbound registry</h2>
    <div id="registry"></div>
  </div>
</div>

<footer>
  Produced by <code>gtm report dashboard</code>. Inputs: Salesforce-shaped lead, opportunity, stage history and loan tables; ad-platform spend and invoices; website and email touches; identity links; the AI decision log. Everything on this page is generated from one integer seed and describes a fictional lender.
</footer>
</div>
<div class="tip" id="tip"></div>
<script>
const D = ${JSON.stringify(d)};
const $ = (s) => document.querySelector(s);
const gbp = (n) => n == null ? '—' : '£' + Math.round(n).toLocaleString('en-GB');
const num = (n, f = 0) => n == null ? '—' : Number(n).toLocaleString('en-GB', { maximumFractionDigits: f, minimumFractionDigits: f });
const pct = (x) => x == null ? '—' : (x * 100).toFixed(1) + '%';
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const tip = $('#tip');
function showTip(e, html) { tip.innerHTML = html; tip.style.opacity = 1; tip.style.left = Math.min(e.clientX + 14, innerWidth - 280) + 'px'; tip.style.top = (e.clientY + 14) + 'px'; }
function hideTip() { tip.style.opacity = 0; }

// ---- tiles
(function () {
  const t = D.weekly.totals, p = D.weekly.previous;
  const delta = (a, b) => { if (!b) return ''; const x = (a - b) / b; const cls = x > 0.02 ? 'up' : x < -0.02 ? 'down' : ''; return '<div class="d ' + cls + '">' + (x >= 0 ? '+' : '') + (x * 100).toFixed(0) + '% vs last week</div>'; };
  const tiles = [
    ['Enquiries', num(t.enquiries), delta(t.enquiries, p.enquiries)],
    ['Applications', num(t.applications), delta(t.applications, p.applications)],
    ['Offers', num(t.offers), delta(t.offers, p.offers)],
    ['Funded loans', num(t.funded), delta(t.funded, p.funded)],
    ['Principal funded', gbp(t.principal_gbp), delta(t.principal_gbp, p.principal_gbp)],
    ['Spend per funded loan', gbp(t.cost_per_funded), '<div class="d">spend ' + gbp(t.spend) + '</div>'],
  ];
  $('#tiles').innerHTML = tiles.map(([k, v, d]) => '<div class="tile"><div class="k">' + k + '</div><div class="v">' + v + '</div>' + d + '</div>').join('');
})();

// ---- trend (two lines, legend + end labels, crosshair tooltip)
(function () {
  const rows = D.weekly.trend, W = 1100, H = 260, m = { t: 16, r: 90, b: 28, l: 36 };
  const series = [['enquiries', 'Enquiries', 'var(--s1)'], ['funded', 'Funded loans', 'var(--s3)']];
  const max = Math.max(...rows.map((r) => r.enquiries)) * 1.1;
  const x = (i) => m.l + (i / (rows.length - 1)) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - v / max) * (H - m.t - m.b);
  const ticks = [0, Math.round(max / 2), Math.round(max)];
  let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Enquiries and funded loans per week">';
  s += ticks.map((t) => '<line class="grid-line" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + y(t) + '" y2="' + y(t) + '"/><text class="lbl" x="' + (m.l - 6) + '" y="' + (y(t) + 4) + '" text-anchor="end">' + t + '</text>').join('');
  s += rows.map((r, i) => '<text class="lbl" x="' + x(i) + '" y="' + (H - 8) + '" text-anchor="middle">' + r.iso.slice(5) + '</text>').join('');
  for (const [k, label, col] of series) {
    const d = rows.map((r, i) => (i ? 'L' : 'M') + x(i) + ' ' + y(r[k])).join(' ');
    s += '<path d="' + d + '" fill="none" stroke="' + col + '" stroke-width="2" stroke-linejoin="round"/>';
    s += rows.map((r, i) => '<circle cx="' + x(i) + '" cy="' + y(r[k]) + '" r="4" fill="' + col + '" stroke="var(--surface)" stroke-width="2"/>').join('');
    s += '<text class="dl" x="' + (x(rows.length - 1) + 10) + '" y="' + (y(rows.at(-1)[k]) + 4) + '">' + label + ' ' + rows.at(-1)[k] + '</text>';
  }
  s += '<line id="xh" class="base" x1="0" x2="0" y1="' + m.t + '" y2="' + (H - m.b) + '" style="opacity:0"/>';
  s += rows.map((r, i) => '<rect x="' + (x(i) - (W - m.l - m.r) / (rows.length - 1) / 2) + '" y="0" width="' + ((W - m.l - m.r) / (rows.length - 1)) + '" height="' + H + '" fill="transparent" data-i="' + i + '"/>').join('');
  s += '</svg>';
  $('#trend').innerHTML = s;
  $('#trend-legend').innerHTML = series.map(([, l, c]) => '<span><i style="background:' + c + '"></i>' + l + '</span>').join('');
  const xh = $('#xh');
  $('#trend').querySelectorAll('rect').forEach((rect) => {
    rect.addEventListener('mousemove', (e) => { const r = rows[+rect.dataset.i]; xh.setAttribute('x1', x(+rect.dataset.i)); xh.setAttribute('x2', x(+rect.dataset.i)); xh.style.opacity = 1; showTip(e, '<b>' + r.iso + '</b><br>enquiries ' + r.enquiries + ' · applications ' + r.applications + '<br>offers ' + r.offers + ' · funded ' + r.funded + '<br>principal ' + gbp(r.principal_gbp) + ' · spend ' + gbp(r.spend)); });
    rect.addEventListener('mouseleave', () => { xh.style.opacity = 0; hideTip(); });
  });
  $('#trend-table').innerHTML = '<table><tr><th>week</th><th>enquiries</th><th>applications</th><th>offers</th><th>funded</th><th>principal</th><th>spend</th></tr>' + rows.map((r) => '<tr><td>' + r.iso + '</td><td>' + r.enquiries + '</td><td>' + r.applications + '</td><td>' + r.offers + '</td><td>' + r.funded + '</td><td>' + gbp(r.principal_gbp) + '</td><td>' + gbp(r.spend) + '</td></tr>').join('') + '</table>';
})();

// ---- funnel by product (ordinal ramp, horizontal bars)
(function () {
  const stages = [['enquiries', 'Enquiries', 'var(--q1)'], ['applications', 'Applications', 'var(--q2)'], ['offers', 'Offers', 'var(--q3)'], ['funded', 'Funded', 'var(--q4)']];
  const W = 520, rowH = 22, gap = 4, labelW = 150, blockGap = 18;
  const max = Math.max(...D.funnel12.map((r) => r.enquiries));
  let y = 8, s = '';
  for (const p of D.funnel12) {
    const label = (D.lender.products[p.product] || {}).label || p.product;
    s += '<text class="dl" x="0" y="' + (y + 12) + '">' + esc(label) + '</text>';
    y += 18;
    for (const [k, name, col] of stages) {
      const w = Math.max(2, (p[k] / max) * (W - labelW - 60));
      s += '<text class="lbl" x="' + (labelW - 8) + '" y="' + (y + 15) + '" text-anchor="end">' + name + '</text>';
      s += '<rect x="' + labelW + '" y="' + y + '" width="' + w + '" height="' + rowH + '" rx="4" fill="' + col + '" data-tip="' + esc(label) + ' · ' + name + ': ' + p[k] + '"/>';
      s += '<text class="dl" x="' + (labelW + w + 6) + '" y="' + (y + 15) + '">' + num(p[k]) + (k === 'funded' ? ' · ' + gbp(p.principal) : '') + '</text>';
      y += rowH + gap;
    }
    y += blockGap;
  }
  $('#funnel').innerHTML = '<svg viewBox="0 0 ' + W + ' ' + y + '" role="img" aria-label="Funnel by product">' + s + '</svg>';
})();

// ---- spend per funded loan, weekly bars (single series, sequential hue)
(function () {
  const rows = D.weekly.trend, W = 520, H = 200, m = { t: 14, r: 10, b: 26, l: 44 };
  const vals = rows.map((r) => (r.funded && r.spend ? r.spend / r.funded : 0));
  const max = Math.max(...vals) * 1.15;
  const bw = (W - m.l - m.r) / rows.length;
  const y = (v) => m.t + (1 - v / max) * (H - m.t - m.b);
  let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Spend per funded loan by week">';
  [0, max / 2].forEach((t) => { s += '<line class="grid-line" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + y(t) + '" y2="' + y(t) + '"/><text class="lbl" x="' + (m.l - 6) + '" y="' + (y(t) + 4) + '" text-anchor="end">' + gbp(t) + '</text>'; });
  rows.forEach((r, i) => {
    const h = (H - m.b) - y(vals[i]);
    s += '<rect x="' + (m.l + i * bw + 3) + '" y="' + y(vals[i]) + '" width="' + (bw - 6) + '" height="' + h + '" rx="4" fill="var(--s1)" data-tip="' + r.iso + ': ' + gbp(vals[i]) + ' per funded loan (' + gbp(r.spend) + ' / ' + r.funded + ')"/>';
    if (i % 2 === 0 || i === rows.length - 1) s += '<text class="lbl" x="' + (m.l + i * bw + bw / 2) + '" y="' + (H - 8) + '" text-anchor="middle">' + r.iso.slice(5) + '</text>';
  });
  s += '<text class="dl" x="' + (m.l + (rows.length - 1) * bw + bw / 2) + '" y="' + (y(vals.at(-1)) - 6) + '" text-anchor="middle">' + gbp(vals.at(-1)) + '</text>';
  $('#spend').innerHTML = s + '</svg>';
})();

// ---- channels by model vs CRM
(function () {
  const models = Object.keys(D.attribution.models);
  const labels = { first_touch: 'first touch', last_touch: 'last touch', linear: 'linear', position_based: 'position-based', time_decay: 'time decay' };
  const crmMap = { 'Google Ads': 'google_ads', LinkedIn: 'linkedin_ads', Event: 'events', 'Solicitor Referral': 'solicitor_referral', Outbound: 'outbound_email', Email: 'outbound_email', Organic: 'organic_search', Phone: 'direct' };
  const crm = {};
  for (const [src, r] of Object.entries(D.attribution.crm_lead_source)) { const k = crmMap[src] || (src === 'Web' ? 'web_unknown' : 'blank'); crm[k] = (crm[k] || 0) + r.funded; }
  const order = Object.keys(D.lender.channels).concat(['web_unknown', 'blank']);
  const names = { ...D.lender.channels, web_unknown: '“Web” (CRM only)', blank: 'blank (CRM only)' };
  let current = 'position_based';
  function render() {
    const rows = D.attribution.models[current];
    const byCh = Object.fromEntries(rows.map((r) => [r.channel, r]));
    const data = order.map((ch) => ({ ch, name: names[ch], attr: byCh[ch] ? byCh[ch].funded : 0, crm: crm[ch] || 0, row: byCh[ch] }));
    const W = 1100, rowH = 16, gap = 10, labelW = 170, max = Math.max(...data.map((d) => Math.max(d.attr, d.crm))) * 1.1;
    const scale = (v) => (v / max) * (W - labelW - 70);
    let y = 6, s = '';
    for (const d of data) {
      s += '<text class="lbl" x="' + (labelW - 8) + '" y="' + (y + rowH + 2) + '" text-anchor="end">' + esc(d.name) + '</text>';
      s += '<rect x="' + labelW + '" y="' + y + '" width="' + Math.max(1, scale(d.attr)) + '" height="' + rowH + '" rx="4" fill="var(--s1)" data-tip="' + esc(d.name) + ' · ' + labels[current] + ': ' + num(d.attr, 1) + ' funded"/>';
      s += '<text class="dl" x="' + (labelW + scale(d.attr) + 6) + '" y="' + (y + 12) + '">' + num(d.attr, 1) + '</text>';
      y += rowH + 2;
      s += '<rect x="' + labelW + '" y="' + y + '" width="' + Math.max(1, scale(d.crm)) + '" height="' + rowH + '" rx="4" fill="var(--ref)" data-tip="' + esc(d.name) + ' · Salesforce Lead Source: ' + d.crm + ' funded"/>';
      s += '<text class="lbl" x="' + (labelW + scale(d.crm) + 6) + '" y="' + (y + 12) + '">' + d.crm + '</text>';
      y += rowH + gap;
    }
    $('#channels').innerHTML = '<svg viewBox="0 0 ' + W + ' ' + y + '" role="img" aria-label="Funded loans by channel, attribution versus CRM">' + s + '</svg>';
    $('#channel-table').innerHTML = '<table><tr><th>channel</th><th>enquiries</th><th>funded</th><th>principal</th><th>spend</th><th>commission</th><th>£ / enquiry</th><th>£ / funded loan</th></tr>' + rows.map((r) => '<tr><td>' + esc(r.label) + '</td><td>' + num(r.enquiries, 1) + '</td><td>' + num(r.funded, 1) + '</td><td>' + gbp(r.principal) + '</td><td>' + gbp(r.spend) + '</td><td>' + gbp(r.commission) + '</td><td>' + gbp(r.cost_per_enquiry) + '</td><td>' + gbp(r.cost_per_funded) + '</td></tr>').join('') + '</table>';
    $('#models').innerHTML = models.map((m) => '<button aria-pressed="' + (m === current) + '" data-m="' + m + '">' + labels[m] + '</button>').join('');
    $('#models').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { current = b.dataset.m; render(); }));
    bindTips();
  }
  const t = D.attribution.totals;
  $('#attr-note').textContent = D.attribution.window.weeks + ' weeks to ' + D.attribution.window.end + ' · ' + t.enquiries + ' opportunities, ' + t.funded + ' funded · ' + t.unresolved + ' (' + pct(t.unattributed_share) + ') could not be tied to any touch and are left unattributed · lookback ' + ${config.ATTRIBUTION_LOOKBACK_DAYS} + ' days · referral commission 2% of funded principal counted as cost.';
  render();
})();

// ---- AI gate
(function () {
  const a = D.ai;
  if (!a) { $('#ai').innerHTML = '<p class="note">No shadow evaluation yet. Run <code>gtm ai triage</code> then <code>gtm ai shadow-eval</code>.</p>'; return; }
  const routes = ['family_team', 'probate_team', 'decline', 'needs_more_info'];
  const wrongDecline = routes.filter((h) => h !== 'decline').reduce((s, h) => s + (a.confusion[h].decline || 0), 0);
  const pass = a.route_agreement >= 0.9 && wrongDecline === 0;
  const provs = Object.fromEntries(a.providers.map((p) => [p.provider, p.n]));
  const reader = provs.anthropic || provs.fixture ? esc(a.model) + (provs.fixture ? ' · cached readings' : ' · live') : 'mock reader (no API key)';
  let h = '<div class="gate ' + (pass ? 'pass' : 'hold') + '">' + (pass ? '✔ gate: pass · safe to move to assist mode' : '✖ gate: hold · stay in shadow') + '</div>';
  h += '<div class="stats">'
    + '<div class="stat"><div class="k">route agreement with the human decision</div><div class="v ' + (a.route_agreement >= 0.9 ? 'good' : 'bad') + '">' + pct(a.route_agreement) + '</div></div>'
    + '<div class="stat"><div class="k">max-loan arithmetic error</div><div class="v">' + pct(a.amount_mape) + '</div></div>'
    + '<div class="stat"><div class="k">would have declined a case a person took</div><div class="v ' + (wrongDecline === 0 ? 'good' : 'bad') + '">' + wrongDecline + '</div></div>'
    + '</div>';
  h += '<table class="kv"><tr><td>enquiries evaluated</td><td>' + a.n + '</td></tr><tr><td>product agreement</td><td>' + pct(a.product_agreement) + '</td></tr><tr><td>reader</td><td>' + reader + '</td></tr><tr><td>prompt · rules</td><td>' + esc(a.prompt_version) + ' · ' + esc(a.rules_version || '') + '</td></tr><tr><td>model cost for the batch</td><td>$' + Number(a.cost_usd).toFixed(2) + '</td></tr><tr><td>audit log rows</td><td>' + num(a.audit_rows) + '</td></tr></table>';
  h += '<details><summary>confusion matrix (rows = human, columns = rules + AI)</summary><table class="cm"><tr><th></th>' + routes.map((r) => '<th>' + r.replace('_', ' ') + '</th>').join('') + '</tr>' + routes.map((hr) => '<tr><td>' + hr.replace('_', ' ') + '</td>' + routes.map((ar) => '<td class="' + (hr === ar ? 'diag' : a.confusion[hr][ar] ? 'off' : '') + '">' + a.confusion[hr][ar] + '</td>').join('') + '</tr>').join('') + '</table></details>';
  h += '<p class="note">Shadow mode: the model reads, coded rules route, the decision is logged and compared with what a person decided. Nothing is sent. Promotion needs at least 90% agreement and zero wrongful declines.</p>';
  $('#ai').innerHTML = h;
})();

// ---- registry
(function () {
  const r = D.registry;
  let h = '<div class="stats">'
    + '<div class="stat"><div class="k">profiles in the registry</div><div class="v">' + num(r.total) + '</div></div>'
    + '<div class="stat"><div class="k">pushed to a sequence</div><div class="v">' + num(r.pushed) + '</div></div>'
    + '<div class="stat"><div class="k">reply rate of pushed</div><div class="v">' + pct(r.replied / (r.pushed || 1)) + '</div></div>'
    + '</div>';
  h += '<table class="kv"><tr><td>replied · meetings booked</td><td>' + num(r.replied) + ' · ' + num(r.meetings) + '</td></tr><tr><td>waiting for the daily cap of ' + ${config.AUDIENCE_DAILY_PUSH_CAP} + '</td><td>' + num(r.eligible) + '</td></tr>' + (r.awaiting_contact_data ? '<tr><td>real people from the Companies House register, parked until a real enrichment provider finds contact details</td><td>' + num(r.awaiting_contact_data) + '</td></tr>' : '') + '<tr><td>suppressed (do not contact)</td><td>' + num(r.suppressed) + '</td></tr></table>';
  h += '<div class="sub-h">by segment</div><table><tr><th>segment</th><th>profiles</th><th>pushed</th><th>replied</th><th>reply rate</th></tr>' + r.segments.map((s) => '<tr><td>' + s.segment.replace(/_/g, ' ') + '</td><td>' + s.n + '</td><td>' + s.pushed + '</td><td>' + s.replied + '</td><td>' + pct(s.pushed ? s.replied / s.pushed : null) + '</td></tr>').join('') + '</table>';
  h += '<p class="note">The registry is the source of truth for who is in the outbound audience. The sequencing tool only ever sees the next ' + ${config.AUDIENCE_DAILY_PUSH_CAP} + ' eligible profiles per day, and nobody without real contact details.</p>';
  $('#registry').innerHTML = h;
})();

function bindTips() {
  document.querySelectorAll('[data-tip]').forEach((el) => {
    el.addEventListener('mousemove', (e) => showTip(e, el.dataset.tip));
    el.addEventListener('mouseleave', hideTip);
  });
}
bindTips();
</script>
</body>
</html>
`;
}

function build() {
  const data = gather();
  fs.mkdirSync(config.SITE_DIR, { recursive: true });
  const file = path.join(config.SITE_DIR, 'index.html');
  fs.writeFileSync(file, html(data));
  log.info('dashboard built', { file, bytes: fs.statSync(file).size });
  return { file: path.relative(config.ROOT, file), bytes: fs.statSync(file).size };
}

module.exports = { build, gather };
