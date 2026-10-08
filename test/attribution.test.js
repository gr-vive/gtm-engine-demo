'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { creditsFor, MODELS } = require('../scripts/attribution');

const journey = [
  { channel: 'linkedin_ads', touch_type: 'impression', days_before_enquiry: 40 },
  { channel: 'google_ads', touch_type: 'click', days_before_enquiry: 21 },
  { channel: 'organic_search', touch_type: 'visit', days_before_enquiry: 7 },
  { channel: 'outbound_email', touch_type: 'email_click', days_before_enquiry: 3 },
  { channel: 'google_ads', touch_type: 'form_submit', days_before_enquiry: 0 },
];

const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

test('every model distributes exactly one unit of credit', () => {
  for (const m of MODELS) assert.ok(Math.abs(sum(creditsFor(m, journey)) - 1) < 1e-9, m);
});

test('impressions do not earn credit when clicks exist', () => {
  for (const m of MODELS) assert.equal(creditsFor(m, journey).linkedin_ads, undefined, m);
});

test('an impressions-only journey still credits the impression', () => {
  const only = [{ channel: 'linkedin_ads', touch_type: 'impression', days_before_enquiry: 5 }];
  assert.equal(creditsFor('last_touch', only).linkedin_ads, 1);
});

test('first and last touch pick the ends of the eligible touches', () => {
  assert.equal(creditsFor('first_touch', journey).google_ads, 1);
  assert.equal(creditsFor('last_touch', journey).google_ads, 1);
});

test('position-based gives 40/40 to the ends and 20 to the middle', () => {
  const c = creditsFor('position_based', journey);
  assert.ok(Math.abs(c.google_ads - 0.8) < 1e-9); // first and last are both google_ads
  assert.ok(Math.abs(c.organic_search - 0.1) < 1e-9);
  assert.ok(Math.abs(c.outbound_email - 0.1) < 1e-9);
});

test('time decay favours the touches closest to the enquiry', () => {
  const c = creditsFor('time_decay', journey);
  assert.ok(c.google_ads > c.organic_search);
  assert.ok(c.outbound_email > c.organic_search);
});
