#!/usr/bin/env node
// Prints a Markdown coverage table from the frontend (Istanbul `coverage-summary.json`) and backend
// (`cargo llvm-cov report --json --summary-only`) summaries. A missing file shows as "not available".
//
// Usage: node coverage-summary.mjs <frontend coverage-summary.json> <backend summary.json>

import { readFileSync } from 'node:fs';

const [frontendPath, backendPath] = process.argv.slice(2);

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function cell(metric) {
  if (!metric || !metric.count) return '–';
  const pct = (100 * metric.covered) / metric.count;
  return `${pct.toFixed(1)}% <sub>(${metric.covered}/${metric.count})</sub>`;
}

/** [lines, functions, branches] as `{ covered, count }`, or null. */
function frontendMetrics(summary) {
  const t = summary?.total;
  if (!t) return null;
  const m = (x) => ({ covered: x.covered, count: x.total });
  return [m(t.lines), m(t.functions), m(t.branches)];
}

function backendMetrics(summary) {
  const t = summary?.data?.[0]?.totals;
  if (!t) return null;
  // llvm-cov only reports branches with `--branch` (nightly); regions are the closest equivalent.
  return [t.lines, t.functions, t.branches?.count ? t.branches : t.regions];
}

const suites = [
  ['Frontend (Vitest)', frontendMetrics(readJson(frontendPath))],
  ['Backend (Rust)', backendMetrics(readJson(backendPath))],
];

const lines = [
  '## Coverage',
  '',
  '| Suite | Lines | Functions | Branches / regions |',
  '| --- | ---: | ---: | ---: |',
];
for (const [name, metrics] of suites) {
  lines.push(metrics ? `| ${name} | ${metrics.map(cell).join(' | ')} |` : `| ${name} | not available | | |`);
}
lines.push('', '<sub>Rust counts regions instead of branches. HTML reports are in the run artifacts.</sub>');

console.log(lines.join('\n'));
