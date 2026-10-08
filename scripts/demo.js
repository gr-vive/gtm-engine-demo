'use strict';

/**
 * `gtm demo`: the whole engine, end to end, in one terminal session.
 * Each step is the same code the scheduled jobs run; nothing is faked for the demo.
 */

const config = require('../lib/config');
const ui = require('../lib/ui');

async function demo(flags = {}) {
  const t0 = Date.now();
  const timings = [];
  const step = async (label, fn) => {
    const s = Date.now();
    const out = await fn();
    timings.push([label, Date.now() - s]);
    return out;
  };

  ui.banner(`${config.LENDER.name} · growth engine`, 'synthetic data · every number below is generated from one seed');

  await step('seed', async () => {
    ui.section('1 · Seed the world');
    const r = require('./seed').seed({ reset: true });
    ui.ok(`${ui.num(r.firms)} firms, ${ui.num(r.contacts)} contacts, ${ui.num(r.touches)} touches, ${ui.num(r.opps)} opportunities, ${ui.num(r.loans)} funded loans, ${r.enquiries} enquiries`);
  });

  await step('audience', async () => {
    ui.banner('2 · Audience', 'keep the professional audience current and deliverable');
    await require('./audience/pipeline').runPipeline();
    await require('./audience/signals').statusSync();
    await require('./audience/signals').signals();
    require('./audience/pipeline').registrySummary();
  });

  await step('attribution', async () => {
    ui.banner('3 · Attribution', 'first click → funded loan, five models, cost per funded loan');
    await require('./attribution').run();
  });

  const weekly = await step('reporting', async () => {
    ui.banner('4 · One set of numbers', 'weekly funnel by product and channel, produced by the system');
    const w = require('./reporting/weekly-funnel').build();
    await require('./reporting/digest').send();
    return w;
  });

  const evalResult = await step('ai-layer', async () => {
    ui.banner('5 · AI capability layer', 'rules route and do the arithmetic · AI reads and drafts · a person decides · shadow mode first');
    await require('./ai-layer/triage').triage({ limit: Number(flags.limit || 240), mode: flags.live ? 'live' : flags.mock ? 'mock' : 'auto' });
    const ev = require('./ai-layer/shadow-eval').shadowEval();
    if (ev && ev.flagged.length) {
      ui.blank();
      ui.info('one of the disagreements, as the audit log sees it:');
      require('./ai-layer/audit').auditTrail(ev.flagged[0].enquiry_id);
    }
    return ev;
  });

  await step('dashboard', async () => {
    ui.banner('6 · Dashboard', 'the same numbers as a page anyone can open');
    const out = require('./reporting/build-dashboard').build();
    ui.ok(`written ${out.file}`);
  });

  ui.banner('Done', `${((Date.now() - t0) / 1000).toFixed(1)} s end to end`);
  ui.table(timings.map(([k, v]) => ({ step: k, ms: v })), [{ key: 'step', label: 'step' }, { key: 'ms', label: 'ms', align: 'right', fmt: (v) => ui.num(v) }]);
  ui.blank();
  ui.kv([
    ['weekly report', `reports/weekly/${weekly.iso_week}.md`],
    ['attribution report', 'reports/attribution/latest.md'],
    ['dashboard', 'site/index.html'],
    ['run manifests', 'runs/audience/<run_id>/manifest.json'],
    ['logs', 'logs/YYYY-MM-DD.log'],
    ['ai gate', evalResult ? `${ui.pct(evalResult.route_agreement)} route agreement · ${evalResult.would_decline_wrongly} wrongful declines` : '—'],
  ]);
  ui.blank();
  ui.info('try: gtm ai audit <enquiry_id> · gtm audience status · gtm schedule · gtm report weekly --week 2026-08-31');
}

module.exports = { demo };
