#!/usr/bin/env node
'use strict';

/**
 * gtm: the one CLI for the growth engine.
 *
 *   gtm seed                          build the synthetic world (resets the database)
 *   gtm status                        what is in the database right now
 *   gtm audience run|resume|status    staged, checkpointed audience pipeline
 *   gtm audience <stage>              run one stage (discover dedup enrich qualify push)
 *   gtm audience signals|sync|registry
 *   gtm attribution run               identity → journeys → 5 models → cost per funded loan
 *   gtm report weekly|digest|dashboard
 *   gtm ai triage [--limit N] [--live|--fixtures|--mock] [--assist]
 *   gtm ai shadow-eval
 *   gtm ai audit <enquiry_id>
 *   gtm schedule [--run=<task>] [--daemon]
 *   gtm demo                          everything, end to end, in one go
 */

const ui = require('../lib/ui');
const config = require('../lib/config');

const VALUE_FLAGS = new Set(['limit', 'week', 'run-id', 'run']);

function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      args.push(a);
      continue;
    }
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) flags[k] = v;
    else if (VALUE_FLAGS.has(k) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
    else flags[k] = true;
  }
  return { args, flags };
}

async function main() {
  const { args, flags } = parseArgs(process.argv.slice(2));
  const [cmd, sub, third] = args;
  const t0 = Date.now();

  switch (cmd) {
    case 'seed': {
      const { seed } = require('../scripts/seed');
      ui.banner('Seeding the synthetic world', `${config.LENDER.name} · seed ${config.SEED} · everything here is invented`);
      const r = seed({ reset: !flags.keep });
      ui.ok(`done in ${r.ms} ms`);
      break;
    }
    case 'status': {
      const db = require('../lib/db');
      const conn = db.open();
      const count = (t) => db.scalar(conn, `SELECT COUNT(*) FROM ${t}`);
      ui.section(`Database · ${config.DB_PATH}`);
      ui.kv([
        ['firms / contacts', `${ui.num(count('firms'))} / ${ui.num(count('contacts'))}`],
        ['registry profiles', ui.num(count('audience_registry'))],
        ['touches / identity links', `${ui.num(count('touches'))} / ${ui.num(count('identity_links'))}`],
        ['leads → opportunities → funded loans', `${ui.num(count('sf_leads'))} → ${ui.num(count('sf_opportunities'))} → ${ui.num(count('loans'))}`],
        ['journeys / credit rows', `${ui.num(count('journeys'))} / ${ui.num(count('attribution_credits'))}`],
        ['enquiries / ai decisions / human decisions', `${ui.num(count('enquiries'))} / ${ui.num(count('ai_decisions'))} / ${ui.num(count('human_decisions'))}`],
        ['audit log rows', ui.num(count('audit_log'))],
      ]);
      break;
    }
    case 'audience': {
      const p = require('../scripts/audience/pipeline');
      const s = require('../scripts/audience/signals');
      if (!sub || sub === 'run') await p.runPipeline({ force: Boolean(flags.force) });
      else if (sub === 'resume') await p.runPipeline({ runId: flags['run-id'] || (require('../lib/manifest').latest('audience') || {}).run_id, force: Boolean(flags.force) });
      else if (sub === 'status') p.status(flags['run-id']);
      else if (sub === 'registry') p.registrySummary();
      else if (sub === 'signals') await s.signals();
      else if (sub === 'sync') await s.statusSync();
      else if (p.STAGES.includes(sub)) await p.runPipeline({ runId: flags['run-id'] || (require('../lib/manifest').latest('audience') || {}).run_id, only: sub, force: Boolean(flags.force) });
      else throw new Error(`unknown audience command ${sub}`);
      break;
    }
    case 'attribution': {
      await require('../scripts/attribution').run();
      break;
    }
    case 'report': {
      if (sub === 'weekly' || !sub) require('../scripts/reporting/weekly-funnel').build({ week: flags.week });
      else if (sub === 'digest') await require('../scripts/reporting/digest').send();
      else if (sub === 'dashboard') require('../scripts/reporting/build-dashboard').build();
      else throw new Error(`unknown report ${sub}`);
      break;
    }
    case 'ai': {
      if (sub === 'triage') {
        const mode = flags.live ? 'live' : flags.fixtures ? 'fixtures' : flags.mock ? 'mock' : 'auto';
        await require('../scripts/ai-layer/triage').triage({ limit: Number(flags.limit || 60), mode, aiMode: flags.assist ? 'assist' : config.AI_MODE });
      } else if (sub === 'shadow-eval') require('../scripts/ai-layer/shadow-eval').shadowEval();
      else if (sub === 'audit') {
        if (!third) throw new Error('usage: gtm ai audit <enquiry_id>');
        require('../scripts/ai-layer/audit').auditTrail(third);
      } else throw new Error(`unknown ai command ${sub}`);
      break;
    }
    case 'schedule': {
      const o = require('../scripts/orchestrator');
      if (flags.daemon) o.daemon();
      else if (flags.run) await o.runTask(flags.run);
      else o.list();
      break;
    }
    case 'demo': {
      await require('../scripts/demo').demo(flags);
      break;
    }
    default:
      ui.out(require('fs').readFileSync(__filename, 'utf8').split('\n').slice(3, 19).map((l) => l.replace(/^ \*\s?/, '')).join('\n'));
      if (cmd) process.exitCode = 1;
      return;
  }
  if (flags.time) ui.info(`${Date.now() - t0} ms`);
}

main().catch((err) => {
  ui.fail(err.message);
  if (process.env.GTM_DEBUG) console.error(err.stack);
  process.exit(1);
});
