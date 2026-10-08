'use strict';

/**
 * Structured file logger. One line per event:
 *   [2026-10-08T09:00:00.000Z] [gtm:attribution] stitched 412 journeys
 *
 * Every module logs to logs/YYYY-MM-DD.log (UTC date). Pretty terminal output
 * is handled separately by lib/ui.js so the log stays greppable.
 * Set GTM_LOG_STDOUT=1 to mirror log lines to stderr.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

function logFile() {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(config.LOGS_DIR, `${day}.log`);
}

function write(level, module, message, extra) {
  const line = `[${new Date().toISOString()}] [gtm:${module}] ${level === 'info' ? '' : level.toUpperCase() + ' '}${message}${
    extra ? ' ' + JSON.stringify(extra) : ''
  }\n`;
  fs.appendFileSync(logFile(), line);
  if (process.env.GTM_LOG_STDOUT === '1') process.stderr.write(line);
}

function logger(module) {
  return {
    info: (msg, extra) => write('info', module, msg, extra),
    warn: (msg, extra) => write('warn', module, msg, extra),
    error: (msg, extra) => write('error', module, msg, extra),
  };
}

module.exports = { logger, logFile };
