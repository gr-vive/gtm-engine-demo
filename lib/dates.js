'use strict';

/** Date helpers. Everything is UTC and ISO-8601 strings; weeks start on Monday. */

const DAY = 86400000;

const toDate = (v) => (v instanceof Date ? v : new Date(v));
const iso = (d) => toDate(d).toISOString();
const ymd = (d) => toDate(d).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(toDate(d).getTime() + n * DAY);
const diffDays = (a, b) => (toDate(a).getTime() - toDate(b).getTime()) / DAY;

/** Monday 00:00 UTC of the week containing d */
function weekStart(d) {
  const date = toDate(d);
  const day = (date.getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day));
  return monday;
}

/** ISO week label like 2026-W40 */
function isoWeek(d) {
  const date = new Date(Date.UTC(toDate(d).getUTCFullYear(), toDate(d).getUTCMonth(), toDate(d).getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / DAY + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** list of Monday dates (YYYY-MM-DD) for n weeks ending at the week containing `end` */
function weeksEnding(end, n) {
  const last = weekStart(end);
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(ymd(addDays(last, -7 * i)));
  return out;
}

/** random-ish time of day inside a date, using an rng in [0,1) */
function atTime(dayYmd, frac, startHour = 8, endHour = 18) {
  const base = new Date(`${dayYmd}T00:00:00.000Z`);
  const mins = Math.floor((startHour * 60 + frac * (endHour - startHour) * 60));
  return new Date(base.getTime() + mins * 60000);
}

module.exports = { DAY, iso, ymd, addDays, diffDays, weekStart, isoWeek, weeksEnding, atTime, toDate };
