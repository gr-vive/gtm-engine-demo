'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Rng } = require('../lib/rng');
const { weekStart, isoWeek, weeksEnding } = require('../lib/dates');

test('the generator is deterministic for a given seed', () => {
  const a = new Rng(42);
  const b = new Rng(42);
  const seqA = Array.from({ length: 20 }, () => a.int(0, 1000));
  const seqB = Array.from({ length: 20 }, () => b.int(0, 1000));
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, Array.from({ length: 20 }, () => new Rng(43).int(0, 1000)));
});

test('weeks start on Monday and ISO labels are right around a year boundary', () => {
  assert.equal(weekStart('2026-10-04').toISOString().slice(0, 10), '2026-09-28'); // Sunday → previous Monday
  assert.equal(weekStart('2026-09-28').toISOString().slice(0, 10), '2026-09-28'); // Monday stays
  assert.equal(isoWeek('2026-01-01'), '2026-W01');
  assert.equal(isoWeek('2027-01-01'), '2026-W53');
  assert.deepEqual(weeksEnding('2026-10-04', 2), ['2026-09-21', '2026-09-28']);
});

test('the seeded world and the reports are reproducible end to end', async () => {
  process.env.GTM_DB_PATH = require('path').join(require('os').tmpdir(), `gtm-test-${process.pid}.db`);
  // config is read once per process; set the env before requiring it
  delete require.cache[require.resolve('../lib/config')];
  const { seed } = require('../scripts/seed');
  const r1 = seed({ reset: true, quiet: true });
  const r2 = seed({ reset: true, quiet: true });
  assert.deepEqual({ ...r1, ms: 0 }, { ...r2, ms: 0 });
  assert.ok(r1.loans > 300 && r1.loans < 700, `funded loans in a sane band, got ${r1.loans}`);
  const attribution = require('../scripts/attribution');
  const out = await attribution.run({ quiet: true });
  assert.ok(out.report.totals.unattributed_share < 0.1, 'most journeys resolve');
  assert.ok(out.report.totals.unattributed_share > 0, 'and some honestly do not');
  require('../lib/db').reset(process.env.GTM_DB_PATH);
});
