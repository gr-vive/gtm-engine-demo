'use strict';

/**
 * Inbound enquiry triage.
 *
 *   enquiry text ─► AI reads (extract.js) ─► coded rules route + arithmetic (rules.js)
 *                 ─► decision logged (ai_decisions) ─► audit trail (audit_log)
 *
 * shadow mode (default): the decision is logged and compared later against the
 *   human decision. Nothing is queued, nothing is sent, nobody sees a draft.
 * assist mode: the draft lands in review_queue for a named person to approve or edit.
 * live mode: does not exist. Every customer-facing message passes a human.
 */

const config = require('../../lib/config');
const db = require('../../lib/db');
const ui = require('../../lib/ui');
const { logger } = require('../../lib/logger');
const { extractEnquiry } = require('./extract');
const { applyRules, RULES_VERSION } = require('./rules');
const { sha } = require('../../lib/hash');

const log = logger('triage');

function audit(conn, row) {
  conn
    .prepare('INSERT INTO audit_log (ts, actor, enquiry_id, event, detail_json, prompt_hash, model_version) VALUES (?,?,?,?,?,?,?)')
    .run(row.ts || new Date().toISOString(), row.actor, row.enquiry_id || null, row.event, row.detail ? JSON.stringify(row.detail) : null, row.prompt_hash || null, row.model_version || null);
}

function makeFirmLookup(conn) {
  const firms = conn.prepare('SELECT firm_id, name, on_panel FROM firms').all();
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const byName = new Map(firms.map((f) => [norm(f.name), f]));
  return (name) => byName.get(norm(name)) || null;
}

async function triage({ limit = 60, mode = 'auto', aiMode = config.AI_MODE, quiet = false } = {}) {
  const conn = db.open();
  const runId = `triage_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  const firmLookup = makeFirmLookup(conn);

  const pending = conn
    .prepare(`SELECT e.* FROM enquiries e
              WHERE NOT EXISTS (SELECT 1 FROM ai_decisions d WHERE d.enquiry_id = e.enquiry_id AND d.prompt_version = ?)
              ORDER BY e.received_at ASC LIMIT ?`)
    .all(config.PROMPT_VERSION, limit);

  if (!quiet) {
    ui.section(`AI triage · ${aiMode} mode · run ${runId}`);
    ui.step(`${pending.length} enquiries without a decision for prompt ${config.PROMPT_VERSION}`);
  }
  audit(conn, { actor: 'system:triage', event: 'run_started', detail: { run_id: runId, ai_mode: aiMode, provider_mode: mode, n: pending.length, rules: RULES_VERSION } });

  const insertDecision = conn.prepare(`INSERT INTO ai_decisions
    (decision_id, enquiry_id, run_id, mode, provider, model, prompt_version, prompt_hash, extracted_json, rules_json, route, product, max_loan_gbp, priority, confidence, draft_reply, latency_ms, input_tokens, output_tokens, cost_usd, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const humanStmt = conn.prepare('SELECT route FROM human_decisions WHERE enquiry_id = ?');

  const rows = [];
  let cost = 0;
  const providers = {};
  for (const e of pending) {
    audit(conn, { ts: e.received_at, actor: `system:intake:${e.channel}`, enquiry_id: e.enquiry_id, event: 'enquiry_received', detail: { from: e.from_email, subject: e.subject } });

    const ex = await extractEnquiry(e, { mode });
    providers[ex.provider] = (providers[ex.provider] || 0) + 1;
    audit(conn, { actor: `model:${ex.model}`, enquiry_id: e.enquiry_id, event: 'fields_extracted', detail: { provider: ex.provider, extracted: ex.extracted, latency_ms: ex.latency_ms, tokens: [ex.input_tokens, ex.output_tokens] }, prompt_hash: ex.prompt_hash, model_version: ex.model });

    const rules = applyRules(ex.extracted, { firmLookup });
    audit(conn, { actor: `rules:${rules.version}`, enquiry_id: e.enquiry_id, event: 'rules_applied', detail: { route: rules.route, reason: rules.reason, max_loan_gbp: rules.max_loan_gbp, priority: rules.priority, fired: rules.fired, flags: rules.flags } });

    const decisionId = `dec_${sha(`${runId}|${e.enquiry_id}`, 12)}`;
    insertDecision.run(
      decisionId, e.enquiry_id, runId, aiMode, ex.provider, ex.model, ex.prompt_version, ex.prompt_hash,
      JSON.stringify(ex.extracted), JSON.stringify(rules), rules.route, rules.product, rules.max_loan_gbp, rules.priority,
      ex.extracted.confidence ?? null, ex.extracted.draft_reply || null, ex.latency_ms, ex.input_tokens, ex.output_tokens, ex.cost_usd, new Date().toISOString(),
    );
    if (rules.firm_id) conn.prepare('UPDATE enquiries SET firm_id = ? WHERE enquiry_id = ? AND firm_id IS NULL').run(rules.firm_id, e.enquiry_id);
    audit(conn, { actor: 'system:triage', enquiry_id: e.enquiry_id, event: aiMode === 'shadow' ? 'decision_logged_shadow' : 'decision_queued_for_review', detail: { decision_id: decisionId, route: rules.route } });

    if (aiMode === 'assist') {
      conn.prepare('INSERT OR REPLACE INTO review_queue (enquiry_id, decision_id, status, assigned_to, queued_at) VALUES (?,?,?,?,?)').run(e.enquiry_id, decisionId, 'pending', rules.product === 'probate' ? 'probate-desk' : 'family-desk', new Date().toISOString());
    }
    cost += ex.cost_usd || 0;
    const human = humanStmt.get(e.enquiry_id);
    rows.push({ id: e.enquiry_id, product: rules.product || ex.extracted.product, route: rules.route, human: human ? human.route : null, reason: rules.reason, max: rules.max_loan_gbp, priority: rules.priority, provider: ex.provider });
  }

  audit(conn, { actor: 'system:triage', event: 'run_finished', detail: { run_id: runId, n: rows.length, cost_usd: cost, providers } });
  log.info('triage run finished', { run_id: runId, n: rows.length, providers, cost_usd: cost });

  if (!quiet && rows.length) {
    ui.table(rows.slice(0, 14), [
      { key: 'id', label: 'enquiry' },
      { key: 'product', label: 'product', fmt: (v) => v || ui.c.dim('unclear') },
      { key: 'route', label: 'rules route', fmt: (v) => (v === 'decline' ? ui.c.red(v) : v === 'needs_more_info' ? ui.c.yellow(v) : ui.c.green(v)) },
      { key: 'human', label: 'human route', fmt: (v, r) => (v ? (v === r.route ? ui.c.green(v) : ui.c.yellow(v)) : ui.c.dim('pending')) },
      { key: 'reason', label: 'reason' },
      { key: 'max', label: 'max loan', align: 'right', fmt: (v) => (v ? ui.money(v) : '—') },
      { key: 'priority', label: 'priority', fmt: (v) => (v === 'high' ? ui.c.magenta(v) : v) },
      { key: 'provider', label: 'reader' },
    ], { footer: rows.length > 14 ? `… ${rows.length - 14} more in ai_decisions` : undefined });
    const agree = rows.filter((r) => r.human && r.human === r.route).length;
    const withHuman = rows.filter((r) => r.human).length;
    ui.ok(`${rows.length} decisions logged in ${aiMode} mode · reader: ${Object.entries(providers).map(([k, v]) => `${k}×${v}`).join(', ')} · est. model cost $${cost.toFixed(4)}`);
    if (withHuman) ui.info(`${agree}/${withHuman} agree with the human decision so far (${ui.pct(agree / withHuman)}); run shadow-eval for the full picture`);
    if (aiMode === 'shadow') ui.info('shadow mode: nothing was queued, nothing was sent');
  }
  return { run_id: runId, n: rows.length, cost_usd: cost, providers };
}

module.exports = { triage, audit, makeFirmLookup };
