'use strict';

/**
 * Terminal output helpers. No dependencies.
 * Colours switch off automatically when stdout is not a TTY (CI logs stay clean).
 */

const useColor = process.stdout.isTTY || process.env.FORCE_COLOR === '1';
const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

const c = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
  gray: wrap('90'),
  white: wrap('97'),
};

const out = (s = '') => process.stdout.write(s + '\n');

function banner(title, subtitle) {
  const width = Math.max(title.length, (subtitle || '').length) + 4;
  const line = '─'.repeat(width);
  out('');
  out(c.cyan(`┌${line}┐`));
  out(c.cyan('│') + c.bold(`  ${title.padEnd(width - 2)}`) + c.cyan('│'));
  if (subtitle) out(c.cyan('│') + c.dim(`  ${subtitle.padEnd(width - 2)}`) + c.cyan('│'));
  out(c.cyan(`└${line}┘`));
}

function section(title) {
  out('');
  out(c.bold(c.magenta(`▸ ${title}`)));
}

const step = (msg) => out(`  ${c.cyan('→')} ${msg}`);
const ok = (msg) => out(`  ${c.green('✓')} ${msg}`);
const warn = (msg) => out(`  ${c.yellow('!')} ${msg}`);
const fail = (msg) => out(`  ${c.red('✗')} ${msg}`);
const info = (msg) => out(`    ${c.dim(msg)}`);
const blank = () => out('');

// ---- formatting ---------------------------------------------------------

const money = (n, opts = {}) => {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const v = Math.round(n);
  const s = Math.abs(v).toLocaleString('en-GB');
  return `${v < 0 ? '-' : ''}£${s}${opts.suffix || ''}`;
};
const num = (n, d = 0) => (n === null || n === undefined || Number.isNaN(n) ? '—' : Number(n).toLocaleString('en-GB', { maximumFractionDigits: d, minimumFractionDigits: d }));
const pct = (x, d = 1) => (x === null || x === undefined || Number.isNaN(x) ? '—' : `${(x * 100).toFixed(d)}%`);
const dateShort = (iso) => (iso ? String(iso).slice(0, 10) : '—');

// ---- table --------------------------------------------------------------

/**
 * table(rows, [{ key, label, align: 'left'|'right', fmt }])
 */
function table(rows, columns, opts = {}) {
  const cells = rows.map((r) =>
    columns.map((col) => {
      const raw = typeof col.key === 'function' ? col.key(r) : r[col.key];
      return col.fmt ? col.fmt(raw, r) : raw === null || raw === undefined ? '—' : String(raw);
    }),
  );
  const widths = columns.map((col, i) => Math.max(col.label.length, ...cells.map((row) => stripAnsi(row[i]).length)));
  const pad = (s, w, align) => {
    const len = stripAnsi(s).length;
    const fill = ' '.repeat(Math.max(0, w - len));
    return align === 'right' ? fill + s : s + fill;
  };
  const indent = opts.indent === undefined ? '    ' : opts.indent;
  out(indent + columns.map((col, i) => c.bold(pad(col.label, widths[i], col.align))).join('  '));
  out(indent + c.dim(widths.map((w) => '─'.repeat(w)).join('  ')));
  for (const row of cells) out(indent + row.map((cell, i) => pad(cell, widths[i], columns[i].align)).join('  '));
  if (opts.footer) out(indent + c.dim(opts.footer));
}

function kv(pairs, indent = '    ') {
  const entries = Array.isArray(pairs) ? pairs : Object.entries(pairs);
  const w = Math.max(...entries.map(([k]) => k.length));
  for (const [k, v] of entries) out(`${indent}${c.dim(k.padEnd(w))}  ${v}`);
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

module.exports = { c, out, banner, section, step, ok, warn, fail, info, blank, money, num, pct, dateShort, table, kv };
