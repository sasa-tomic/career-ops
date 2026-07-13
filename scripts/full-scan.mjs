#!/usr/bin/env node
// @ts-check
/**
 * full-scan.mjs — one-command orchestrator for the ENTIRE career-ops search.
 *
 * Runs the complete zero-token scan (all providers + local parsers + JobSpy via
 * scan.mjs) and stores the COMPLETE output of the run to files under
 * data/scan-runs/{date}/ so the agent can process the run from disk without
 * re-scraping:
 *
 *   data/scan-runs/{date}/scan.log     full console output (stdout + stderr)
 *   data/scan-runs/{date}/summary.json structured result: counts, new offers,
 *                                      per-status dispositions, and — per the
 *                                      HARD RULE (modes/_custom.md) — an explicit
 *                                      `failures` list (errored sources + every
 *                                      company that fell back to WebSearch, i.e.
 *                                      was NOT covered by a zero-token source).
 *
 * Any argument is passed through to scan.mjs (e.g. --since-last-scan, --verify).
 *
 * Exit code: non-zero if any source failed OR any company fell back to WebSearch,
 * so a partial/incomplete search can never look like a clean one.
 */

import { spawn } from 'child_process';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_HISTORY = resolve(ROOT, 'data/scan-history.tsv');

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Snapshot the current line count of scan-history so we can diff after the run. */
function historyLineCount() {
  if (!existsSync(SCAN_HISTORY)) return 0;
  return readFileSync(SCAN_HISTORY, 'utf8').split('\n').filter(Boolean).length;
}

/** Rows appended to scan-history during this run (the run's full disposition record). */
function rowsSince(startCount) {
  if (!existsSync(SCAN_HISTORY)) return [];
  const lines = readFileSync(SCAN_HISTORY, 'utf8').split('\n').filter(Boolean);
  return lines.slice(startCount).map(line => {
    const [url, first_seen, portal, title, company, status, location] = line.split('\t');
    return { url, first_seen, portal, title, company, status, location: location || '' };
  });
}

/** Parse scan.mjs console output for the pieces not persisted to scan-history. */
function parseLog(log) {
  const counts = {};
  for (const [key, re] of [
    ['companiesScanned', /Companies scanned:\s+(\d+)/],
    ['totalFound', /Total jobs found:\s+(\d+)/],
    ['filteredTitle', /Filtered by title:\s+(\d+)/],
    ['filteredLocation', /Filtered by location:\s+(\d+)/],
    ['duplicates', /Duplicates:\s+(\d+)/],
    ['newAdded', /New offers added:\s+(\d+)/],
  ]) {
    const m = log.match(re);
    if (m) counts[key] = Number(m[1]);
  }

  const errors = [];
  const errBlock = log.match(/\nErrors \(\d+\):\n([\s\S]*?)(?:\n\n|\nNew offers:|\n→|$)/);
  if (errBlock) {
    for (const line of errBlock[1].split('\n')) {
      const m = line.match(/^\s*✗\s+(.+?):\s+(.+)$/);
      if (m) errors.push({ company: m[1].trim(), error: m[2].trim() });
    }
  }

  const handoff = [];
  const hoBlock = log.match(/Agent\/WebSearch handoff:[^\n]*\n([\s\S]*?)(?:\nErrors|\n\nNew offers:|\n→|$)/);
  if (hoBlock) {
    for (const line of hoBlock[1].split('\n')) {
      const m = line.match(/^\s*•\s+(.+?)\s+\((\w+)\)(?:\s+—\s+(.+))?$/);
      if (m) handoff.push({ company: m[1].trim(), method: m[2], query: m[3] || null });
    }
  }

  return { counts, errors, handoff };
}

async function main() {
  const passthrough = process.argv.slice(2);
  const date = today();
  const runDir = resolve(ROOT, 'data/scan-runs', date);
  mkdirSync(runDir, { recursive: true });
  const logPath = resolve(runDir, 'scan.log');
  const summaryPath = resolve(runDir, 'summary.json');

  const startCount = historyLineCount();
  const logStream = createWriteStream(logPath);
  let logBuf = '';

  console.log(`full-scan: running scan.mjs ${passthrough.join(' ')} → ${runDir}\n`);

  const code = await new Promise(res => {
    const child = spawn('node', ['scan.mjs', ...passthrough], { cwd: ROOT });
    const tee = chunk => { const s = chunk.toString(); logBuf += s; process.stdout.write(s); logStream.write(s); };
    child.stdout.on('data', tee);
    child.stderr.on('data', tee);
    child.on('close', res);
  });
  logStream.end();

  const { counts, errors, handoff } = parseLog(logBuf);
  const rows = rowsSince(startCount);
  const dispositions = {};
  for (const r of rows) dispositions[r.status] = (dispositions[r.status] || 0) + 1;
  const newOffers = rows.filter(r => r.status === 'added')
    .map(r => ({ company: r.company, title: r.title, location: r.location, url: r.url }));

  // HARD RULE: a source that errored OR fell back to WebSearch did NOT deliver a
  // zero-token complete result. Both are failures of coverage and must be loud.
  const failures = [
    ...errors.map(e => ({ type: 'error', company: e.company, detail: e.error })),
    ...handoff.map(h => ({ type: 'websearch-handoff', company: h.company, detail: h.query || 'no zero-token provider' })),
  ];

  const summary = {
    runDate: date,
    command: `node scan.mjs ${passthrough.join(' ')}`.trim(),
    scanExitCode: code,
    counts,
    dispositions,
    newOffersCount: newOffers.length,
    newOffers,
    failures,
    logFile: logPath,
  };
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  console.log(`\n${'━'.repeat(45)}`);
  console.log(`full-scan complete — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Complete output:  ${logPath}`);
  console.log(`Structured JSON:  ${summaryPath}`);
  console.log(`New offers:        ${newOffers.length}`);
  if (failures.length > 0) {
    console.log(`\n⚠️  ${failures.length} source(s) did NOT return a complete zero-token result (HARD RULE — not silent):`);
    for (const f of failures.slice(0, 40)) console.log(`   ✗ [${f.type}] ${f.company}: ${f.detail}`);
    if (failures.length > 40) console.log(`   … ${failures.length - 40} more (see summary.json)`);
  }
  // Non-zero exit if coverage was incomplete, so callers/CI can't treat a partial scan as clean.
  process.exit(failures.length > 0 || code !== 0 ? 2 : 0);
}

main().catch(err => { console.error('full-scan fatal:', err.message); process.exit(1); });
