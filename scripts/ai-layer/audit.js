'use strict';

/**
 * Print the full audit trail for one enquiry: who did what, when, with which
 * model and prompt version, and what the person decided in the end.
 * This is the view a compliance reviewer would ask for.
 */

const db = require('../../lib/db');
const ui = require('../../lib/ui');

function auditTrail(enquiryId) {
  const conn = db.open();
  const e = conn.prepare('SELECT * FROM enquiries WHERE enquiry_id = ?').get(enquiryId);
  if (!e) {
    ui.fail(`no enquiry ${enquiryId}`);
    return null;
  }
  ui.section(`Audit trail · ${enquiryId}`);
  ui.kv([
    ['received', e.received_at],
    ['channel', e.channel],
    ['from', `${e.from_name || ''} <${e.from_email || ''}>`],
    ['subject', e.subject || '—'],
  ]);
  ui.blank();
  ui.info(e.raw_text.split('\n').map((l) => `│ ${l}`).join('\n    '));

  const events = conn.prepare('SELECT * FROM audit_log WHERE enquiry_id = ? ORDER BY ts, audit_id').all(enquiryId);
  const human = conn.prepare('SELECT * FROM human_decisions WHERE enquiry_id = ?').get(enquiryId);
  ui.blank();
  ui.table(
    events.map((ev) => {
      const d = ev.detail_json ? JSON.parse(ev.detail_json) : {};
      let detail = '';
      if (ev.event === 'fields_extracted') detail = `product=${d.extracted.product} jurisdiction=${d.extracted.jurisdiction} requested=${d.extracted.requested_gbp ?? '∅'} security=${d.extracted.security_gbp ?? '∅'} hearing=${d.extracted.hearing_in_days ?? '∅'}d solicitor=${d.extracted.has_solicitor}`;
      else if (ev.event === 'rules_applied') detail = `${d.route} (${d.reason})${d.max_loan_gbp ? ` max ${ui.money(d.max_loan_gbp)}` : ''} · ${d.fired.filter((f) => !['pass', 'normal'].includes(f.outcome)).map((f) => `${f.rule}:${f.outcome}`).join(', ') || 'all rules passed'}`;
      else if (ev.event === 'enquiry_received') detail = `${d.subject || ''}`;
      else detail = JSON.stringify(d).slice(0, 90);
      return { ts: ev.ts, actor: ev.actor, event: ev.event, detail, hash: ev.prompt_hash || '' };
    }),
    [
      { key: 'ts', label: 'time' },
      { key: 'actor', label: 'actor', fmt: (v) => (v.startsWith('model:') ? ui.c.cyan(v) : v.startsWith('rules:') ? ui.c.magenta(v) : v.startsWith('human:') ? ui.c.green(v) : ui.c.dim(v)) },
      { key: 'event', label: 'event' },
      { key: 'detail', label: 'detail' },
      { key: 'hash', label: 'prompt hash', fmt: (v) => (v ? ui.c.dim(v) : '') },
    ],
  );
  if (human) {
    ui.blank();
    ui.ok(`${ui.c.green('human:' + human.reviewer)} decided ${ui.c.bold(human.route)} at ${human.decided_at}${human.approved_gbp ? ` · approved ${ui.money(human.approved_gbp)}` : ''}${human.notes ? ` · "${human.notes}"` : ''}`);
  } else ui.warn('no human decision recorded yet');
  const last = conn.prepare('SELECT draft_reply, mode, provider FROM ai_decisions WHERE enquiry_id = ? ORDER BY created_at DESC LIMIT 1').get(enquiryId);
  if (last && last.draft_reply) {
    ui.blank();
    ui.info(`draft acknowledgement (${last.mode} mode, never sent, reader: ${last.provider}):`);
    ui.info(last.draft_reply.split('\n').map((l) => `│ ${l}`).join('\n    '));
  }
  return { enquiry: e, events, human };
}

module.exports = { auditTrail };
