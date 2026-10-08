'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyRules } = require('../scripts/ai-layer/rules');

const base = { product: 'family_law', jurisdiction: 'England and Wales', requested_gbp: 40000, security_gbp: 900000, hearing_in_days: 60, has_solicitor: true, solicitor_firm: 'Hartley & Finch Solicitors' };

test('a clean family law enquiry routes to the family team with the requested amount', () => {
  const r = applyRules(base);
  assert.equal(r.route, 'family_team');
  assert.equal(r.max_loan_gbp, 40000);
  assert.equal(r.priority, 'normal');
  assert.equal(r.reason, 'eligible');
});

test('Scotland is declined regardless of everything else', () => {
  const r = applyRules({ ...base, jurisdiction: 'Scotland' });
  assert.equal(r.route, 'decline');
  assert.equal(r.reason, 'outside_jurisdiction');
});

test('no amount means needs_more_info, not decline', () => {
  const r = applyRules({ ...base, requested_gbp: null });
  assert.equal(r.route, 'needs_more_info');
  assert.equal(r.reason, 'amount_missing');
});

test('the loan is capped at the product LTV and the cap is recorded', () => {
  const r = applyRules({ ...base, requested_gbp: 100000, security_gbp: 150000 }); // family cap = 50% → 75000
  assert.equal(r.route, 'family_team');
  assert.equal(r.max_loan_gbp, 75000);
  assert.ok(r.flags.includes('reduced_to_ltv_cap'));
});

test('security too small to reach the minimum loan is declined', () => {
  const r = applyRules({ ...base, requested_gbp: 20000, security_gbp: 8000 });
  assert.equal(r.route, 'decline');
  assert.equal(r.reason, 'insufficient_security');
});

test('a hearing inside 14 days is high priority', () => {
  assert.equal(applyRules({ ...base, hearing_in_days: 9 }).priority, 'high');
  assert.equal(applyRules({ ...base, hearing_in_days: 15 }).priority, 'normal');
});

test('probate above the maximum goes to a person, not to decline', () => {
  const r = applyRules({ ...base, product: 'probate', requested_gbp: 650000, security_gbp: 4000000 });
  assert.equal(r.route, 'needs_more_info');
  assert.equal(r.reason, 'above_maximum_refer_to_credit');
});

test('every fired rule is reported for the audit log', () => {
  const r = applyRules(base);
  assert.ok(r.fired.length >= 7);
  assert.ok(r.fired.every((f) => f.rule && f.outcome));
});
