'use strict';

const crypto = require('crypto');

/** short sha256 hex, used for prompt hashes in the audit log */
const sha = (text, len = 16) => crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, len);

/** 32-bit FNV-1a, used to derive deterministic per-record seeds */
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

module.exports = { sha, fnv1a };
