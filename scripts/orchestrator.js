'use strict';

/**
 * Task registry and schedule. One place that says what runs, when, and where.
 *
 *   node scripts/orchestrator.js --list          print the schedule
 *   node scripts/orchestrator.js --run=<task>    run one task now
 *   node scripts/orchestrator.js --daemon        keep the process up and run on cron
 *
 * In production the same tasks run on GitHub Actions (.github/workflows/) so
 * nothing depends on a laptop being switched on. The daemon mode exists for
 * local testing and for anything that must run next to a private resource.
 */

const ui = require('../lib/ui');
const { logger } = require('../lib/logger');

const log = logger('orchestrator');

const TASKS = [
  { name: 'audience-daily', cron: '0 7 * * 1-5', tz: 'Europe/London', where: 'github-actions', what: 'discover → dedup → enrich → qualify → push (cap)', run: () => require('./audience/pipeline').runPipeline() },
  { name: 'audience-status-sync', cron: '30 7 * * 1-5', tz: 'Europe/London', where: 'github-actions', what: 'pull replies / meetings from the sequencer', run: () => require('./audience/signals').statusSync() },
  { name: 'audience-signals', cron: '0 9 * * 1,3,5', tz: 'Europe/London', where: 'github-actions', what: 'buying signals on registry firms → alerts', run: () => require('./audience/signals').signals() },
  { name: 'attribution-nightly', cron: '0 3 * * *', tz: 'Europe/London', where: 'github-actions', what: 'resolve identities → stitch journeys → models → report', run: () => require('./attribution').run() },
  { name: 'weekly-numbers', cron: '0 8 * * 1', tz: 'Europe/London', where: 'github-actions', what: 'funnel by product × channel → markdown + Slack + dashboard', run: async () => { require('./reporting/weekly-funnel').build(); await require('./reporting/digest').send(); require('./reporting/build-dashboard').build(); } },
  { name: 'ai-triage-shadow', cron: '*/30 8-18 * * 1-5', tz: 'Europe/London', where: 'github-actions', what: 'read new enquiries, apply rules, log decisions (shadow)', run: () => require('./ai-layer/triage').triage() },
  { name: 'ai-shadow-eval', cron: '0 17 * * 5', tz: 'Europe/London', where: 'github-actions', what: 'compare AI routes with human decisions, gate promotion', run: () => require('./ai-layer/shadow-eval').shadowEval() },
];

function list() {
  ui.section('Schedule');
  ui.table(TASKS, [
    { key: 'name', label: 'task' },
    { key: 'cron', label: 'cron' },
    { key: 'tz', label: 'tz' },
    { key: 'where', label: 'runs on' },
    { key: 'what', label: 'what it does' },
  ]);
  ui.info('run one now: gtm schedule --run=<task> · keep a local daemon: gtm schedule --daemon');
}

async function runTask(name) {
  const task = TASKS.find((t) => t.name === name);
  if (!task) throw new Error(`unknown task ${name}; try --list`);
  const started = Date.now();
  log.info('task started', { task: name });
  try {
    await task.run();
    log.info('task finished', { task: name, ms: Date.now() - started });
  } catch (err) {
    log.error('task failed', { task: name, error: err.message });
    throw err;
  }
}

function daemon() {
  const cron = require('node-cron');
  for (const t of TASKS) {
    cron.schedule(t.cron, () => runTask(t.name).catch((e) => ui.fail(`${t.name}: ${e.message}`)), { timezone: t.tz });
  }
  ui.ok(`daemon up with ${TASKS.length} scheduled tasks (ctrl-c to stop)`);
  log.info('daemon started', { tasks: TASKS.length });
}

module.exports = { TASKS, list, runTask, daemon };

if (require.main === module) {
  const arg = process.argv.slice(2);
  const run = arg.find((a) => a.startsWith('--run='));
  if (arg.includes('--daemon')) daemon();
  else if (run) runTask(run.split('=')[1]).catch((e) => { ui.fail(e.message); process.exit(1); });
  else list();
}
