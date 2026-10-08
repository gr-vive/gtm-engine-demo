'use strict';

/**
 * Shadow-mode evaluation: how often would the AI-assisted route have matched
 * what a person actually decided? This is the gate before anything moves from
 * shadow to assist. It never looks at enquiry_labels (ground truth); it compares
 * against real human decisions, because that is what production would have.
 */

const config = require('../../lib/config');
const db = require('../../lib/db');
const ui = require('../../lib/ui');
const { ROUTES } = require('./rules');
const { logger } = require('../../lib/logger');
const { Rng } = require('../../lib/rng');

const log = logger('shadow-eval');
const MINUTES_PER_ENQUIRY_MANUAL_READ = 6; // assumption, stated in the report

function shadowEval({ quiet = false } = {}) {
  const conn = db.open();
  const rows = conn
    .prepare(`SELECT d.enquiry_id, d.route AS ai_route, d.product AS ai_product, d.max_loan_gbp AS ai_max, d.provider, d.model, d.cost_usd, d.confidence,
                     h.route AS human_route, h.product AS human_product, h.approved_gbp, h.reviewer, h.notes, d.extracted_json, d.rules_json
              FROM ai_decisions d
              JOIN human_decisions h ON h.enquiry_id = d.enquiry_id
              WHERE d.prompt_version = ?
                AND d.created_at = (SELECT MAX(created_at) FROM ai_decisions d2 WHERE d2.enquiry_id = d.enquiry_id AND d2.prompt_version = d.prompt_version)`)
    .all(config.PROMPT_VERSION);

  if (!rows.length) {
    if (!quiet) ui.warn('no decisions to evaluate yet; run `gtm ai triage` first');
    return null;
  }

  const n = rows.length;
  const routeAgree = rows.filter((r) => r.ai_route === r.human_route).length;
  const productRows = rows.filter((r) => r.human_product);
  const productAgree = productRows.filter((r) => r.ai_product === r.human_product).length;
  const amountRows = rows.filter((r) => r.approved_gbp && r.ai_max);
  const mape = amountRows.length ? amountRows.reduce((s, r) => s + Math.abs(r.ai_max - r.approved_gbp) / r.approved_gbp, 0) / amountRows.length : null;

  // confusion matrix: rows = human, cols = ai
  const confusion = {};
  for (const h of ROUTES) {
    confusion[h] = {};
    for (const a of ROUTES) confusion[h][a] = 0;
  }
  for (const r of rows) confusion[r.human_route][r.ai_route] += 1;

  // the two errors that matter for a regulated lender
  const wouldDecline = rows.filter((r) => r.ai_route === 'decline' && r.human_route !== 'decline');
  const wouldProceed = rows.filter((r) => r.human_route === 'decline' && r.ai_route !== 'decline');

  const flagged = rows
    .filter((r) => r.ai_route !== r.human_route)
    .map((r) => {
      const rules = JSON.parse(r.rules_json);
      return { enquiry_id: r.enquiry_id, ai: r.ai_route, human: r.human_route, reason: rules.reason, human_notes: r.notes, confidence: r.confidence };
    });

  const cost = rows.reduce((s, r) => s + (r.cost_usd || 0), 0);
  const providers = rows.reduce((m, r) => ((m[r.provider] = (m[r.provider] || 0) + 1), m), {});
  const evalId = new Rng(Date.now() % 1e9).id('eval', 8);
  conn
    .prepare('INSERT INTO shadow_evals (eval_id, run_at, model, prompt_version, n, route_agreement, product_agreement, amount_mape, confusion_json, flagged_json, cost_usd, minutes_saved_est) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(evalId, new Date().toISOString(), rows[0].model, config.PROMPT_VERSION, n, routeAgree / n, productRows.length ? productAgree / productRows.length : null, mape, JSON.stringify(confusion), JSON.stringify(flagged), cost, n * MINUTES_PER_ENQUIRY_MANUAL_READ);
  log.info('shadow eval stored', { eval_id: evalId, n, route_agreement: routeAgree / n });

  const result = { eval_id: evalId, n, route_agreement: routeAgree / n, product_agreement: productRows.length ? productAgree / productRows.length : null, amount_mape: mape, would_decline_wrongly: wouldDecline.length, would_proceed_wrongly: wouldProceed.length, confusion, flagged, cost_usd: cost, providers };

  if (!quiet) {
    const rulesVersion = JSON.parse(rows[0].rules_json).version || '?';
    ui.section(`Shadow evaluation · ${n} enquiries · ${config.PROMPT_VERSION} + ${rulesVersion} · reader ${Object.keys(providers).join('+')}`);
    ui.kv([
      ['route agreement', `${ui.pct(routeAgree / n)}  (${routeAgree}/${n})`],
      ['product agreement', productRows.length ? `${ui.pct(productAgree / productRows.length)}  (${productAgree}/${productRows.length})` : '—'],
      ['max-loan error (MAPE)', mape == null ? '—' : ui.pct(mape)],
      ['would have declined a case a person took', `${wouldDecline.length}  ${wouldDecline.length ? ui.c.red('← blocks promotion to assist mode') : ui.c.green('ok')}`],
      ['would have progressed a case a person declined', `${wouldProceed.length}  ${wouldProceed.length ? ui.c.yellow('← review') : ui.c.green('ok')}`],
      ['model cost for this batch', `$${cost.toFixed(4)}`],
      ['reading time it represents', `${n * MINUTES_PER_ENQUIRY_MANUAL_READ} min at ${MINUTES_PER_ENQUIRY_MANUAL_READ} min per enquiry (assumption)`],
    ]);
    ui.blank();
    ui.info('confusion matrix (rows = human decided, columns = rules + AI would have routed)');
    ui.table(
      ROUTES.map((h) => ({ h, ...confusion[h] })),
      [{ key: 'h', label: 'human \\ ai' }, ...ROUTES.map((a) => ({ key: a, label: a, align: 'right', fmt: (v, r) => (r.h === a ? ui.c.green(String(v)) : v ? ui.c.yellow(String(v)) : ui.c.dim('0')) }))],
    );
    if (flagged.length) {
      ui.blank();
      ui.info(`${flagged.length} disagreements for a person to look at (first 8)`);
      ui.table(flagged.slice(0, 8), [
        { key: 'enquiry_id', label: 'enquiry' },
        { key: 'ai', label: 'rules + ai' },
        { key: 'human', label: 'human' },
        { key: 'reason', label: 'rules reason' },
        { key: 'human_notes', label: 'human note', fmt: (v) => v || ui.c.dim('—') },
      ]);
    }
    const gate = wouldDecline.length === 0 && routeAgree / n >= 0.9;
    ui.blank();
    if (gate) ui.ok(`promotion gate: PASS (≥90% route agreement, zero wrongful declines) → safe to move to assist mode`);
    else ui.warn(`promotion gate: HOLD (need ≥90% route agreement and zero wrongful declines) → stay in shadow, fix the reader or the rules`);
  }
  return result;
}

module.exports = { shadowEval };
