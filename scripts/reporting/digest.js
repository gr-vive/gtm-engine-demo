'use strict';

/**
 * Turns the latest weekly report into a Slack Block Kit message.
 * Posts it when SLACK_WEBHOOK_URL is set; otherwise prints the payload (dry run).
 */

const fs = require('fs');
const path = require('path');
const config = require('../../lib/config');
const ui = require('../../lib/ui');
const { logger } = require('../../lib/logger');

const log = logger('digest');
const gbp = (n) => `£${Math.round(n || 0).toLocaleString('en-GB')}`;
const arrow = (cur, prev) => (!prev ? '' : cur > prev * 1.02 ? ' ▲' : cur < prev * 0.98 ? ' ▼' : ' ▬');

function buildBlocks(r) {
  const t = r.totals;
  const p = r.previous;
  const top = [...r.by_channel].sort((a, b) => b.funded - a.funded).slice(0, 4);
  return [
    { type: 'header', text: { type: 'plain_text', text: `📊 ${config.LENDER.short} weekly numbers · ${r.iso_week}`, emoji: true } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Enquiries*\n${t.enquiries}${arrow(t.enquiries, p.enquiries)}` },
        { type: 'mrkdwn', text: `*Applications*\n${t.applications}${arrow(t.applications, p.applications)}` },
        { type: 'mrkdwn', text: `*Offers*\n${t.offers}${arrow(t.offers, p.offers)}` },
        { type: 'mrkdwn', text: `*Funded*\n${t.funded}${arrow(t.funded, p.funded)} · ${gbp(t.principal_gbp)}` },
      ],
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*By product*\n${Object.entries(r.by_product).map(([k, v]) => `• ${config.LENDER.products[k]?.label || k}: ${v.enquiries} enq → ${v.funded} funded (${gbp(v.principal_gbp)})`).join('\n')}` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Top channels by funded loans*\n${top.map((c) => `• ${c.label}: ${c.funded} funded from ${c.enquiries} enq · spend ${gbp(c.spend)}${c.cost_per_funded ? ` · ${gbp(c.cost_per_funded)}/funded` : ''}`).join('\n')}` },
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Spend ${gbp(t.spend)} · ${gbp(t.cost_per_funded)} per funded loan · channel from attribution for ${r.channel_source.attributed}/${r.channel_source.total} enquiries · generated ${r.generated_at.slice(0, 16)}Z by gtm-engine` }] },
  ];
}

async function send({ quiet = false } = {}) {
  const file = path.join(config.REPORTS_DIR, 'weekly', 'latest.json');
  if (!fs.existsSync(file)) throw new Error('no weekly report yet; run `gtm report weekly` first');
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  const blocks = buildBlocks(r);
  const payload = { text: `${config.LENDER.short} weekly numbers ${r.iso_week}: ${r.totals.enquiries} enquiries, ${r.totals.funded} funded`, blocks };

  if (config.SLACK_WEBHOOK_URL) {
    const res = await fetch(config.SLACK_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    log.info('digest posted to slack', { status: res.status });
    if (!quiet) ui.ok(`posted to Slack (HTTP ${res.status})`);
    return { posted: true, status: res.status };
  }
  log.info('digest dry run (no SLACK_WEBHOOK_URL)');
  if (!quiet) {
    ui.section('Slack digest · dry run (set SLACK_WEBHOOK_URL to post)');
    for (const b of blocks) {
      if (b.type === 'header') ui.out(`  ${ui.c.bold(b.text.text)}`);
      else if (b.type === 'section' && b.fields) ui.out('  ' + b.fields.map((f) => f.text.replace(/\*/g, '').replace('\n', ' ')).join('   '));
      else if (b.type === 'section') ui.out('  ' + b.text.text.replace(/\*/g, '').replace(/\n/g, '\n  '));
      else if (b.type === 'context') ui.out('  ' + ui.c.dim(b.elements[0].text));
      else if (b.type === 'divider') ui.out('  ' + ui.c.dim('────────'));
    }
    const outFile = path.join(config.REPORTS_DIR, 'weekly', `${r.iso_week}.slack.json`);
    fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
    ui.info(`payload saved to reports/weekly/${r.iso_week}.slack.json`);
  }
  return { posted: false, payload };
}

module.exports = { send, buildBlocks };
