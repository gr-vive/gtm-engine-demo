'use strict';

/**
 * Deterministic pseudo-random helpers (mulberry32).
 * Every synthetic dataset in this repo is reproducible from one integer seed,
 * so the numbers in the README match the numbers you get when you run it.
 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  constructor(seed) {
    this.seed = seed;
    this.next = mulberry32(seed);
  }

  /** float in [0, 1) */
  float() {
    return this.next();
  }

  /** integer in [min, max] inclusive */
  int(min, max) {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /** true with probability p */
  chance(p) {
    return this.next() < p;
  }

  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** pick a key from {key: weight} */
  weighted(weights) {
    const entries = Object.entries(weights);
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [k, w] of entries) {
      r -= w;
      if (r <= 0) return k;
    }
    return entries[entries.length - 1][0];
  }

  /** approximately normal via Box-Muller */
  normal(mean = 0, sd = 1) {
    const u = 1 - this.next();
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** log-normal, handy for money amounts */
  lognormal(median, sigma) {
    return median * Math.exp(this.normal(0, sigma));
  }

  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** short stable id like "frm_0a3f9c" */
  id(prefix, len = 6) {
    const alphabet = '0123456789abcdef';
    let s = '';
    for (let i = 0; i < len; i++) s += alphabet[this.int(0, 15)];
    return `${prefix}_${s}`;
  }
}

module.exports = { Rng, mulberry32 };
