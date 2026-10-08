'use strict';

/**
 * SQLite via the Node built-in `node:sqlite` module. No native build step.
 * Migrations live in sql/NNN-name.sql and are applied in order, once each
 * (tracked in `schema_migrations`), so the schema is reproducible from the repo.
 */

// node:sqlite still emits an ExperimentalWarning on Node 22-24. Silence only that one.
const origEmitWarning = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  const type = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].type) || (warning && warning.name);
  if (type === 'ExperimentalWarning') return undefined;
  return origEmitWarning.call(process, warning, ...args);
};

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const { logger } = require('./logger');

const log = logger('db');
let _db = null;

function open(dbPath = config.DB_PATH) {
  if (_db) return _db;
  _db = new DatabaseSync(dbPath);
  _db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;');
  migrate(_db);
  return _db;
}

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  const files = fs
    .readdirSync(config.SQL_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(config.SQL_DIR, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
      db.exec('COMMIT');
      log.info(`applied migration ${file}`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${file} failed: ${err.message}`);
    }
  }
}

/** Reset the database file entirely (used by `gtm seed --reset`). */
function reset(dbPath = config.DB_PATH) {
  if (_db) {
    _db.close();
    _db = null;
  }
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch (_) {
      /* not present */
    }
  }
}

// ---- small helpers -------------------------------------------------------

function insertMany(db, table, rows) {
  if (!rows.length) return 0;
  const cols = Object.keys(rows[0]);
  const stmt = db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  db.exec('BEGIN');
  try {
    for (const r of rows) stmt.run(...cols.map((k) => (r[k] === undefined ? null : r[k])));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return rows.length;
}

const one = (db, sql, ...params) => db.prepare(sql).get(...params);
const all = (db, sql, ...params) => db.prepare(sql).all(...params);
const scalar = (db, sql, ...params) => {
  const row = db.prepare(sql).get(...params);
  return row ? Object.values(row)[0] : null;
};

module.exports = { open, reset, migrate, insertMany, one, all, scalar };
