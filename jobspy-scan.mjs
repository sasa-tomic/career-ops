// jobspy-scan.mjs — Node wrapper around scripts/jobspy-scan.py (python-jobspy).
//
// JobSpy is a board-wide scraper (LinkedIn, Indeed, Glassdoor, Google Jobs,
// ZipRecruiter). scan.mjs's HTTP providers cover *tracked* companies via their
// ATS APIs; JobSpy covers *discovery* across boards those APIs can't reach.
// It runs as a zero-token Python subprocess that emits JSON to stdout.
//
// This module is split so the pure parts (config build, output normalization)
// are unit-testable without spawning Python.

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCRIPT = path.join(HERE, 'scripts', 'jobspy-scan.py');
const DEFAULT_SITES = ['indeed', 'google', 'glassdoor']; // LinkedIn is opt-in (rate-limited)

// Auto-detect the project venv created by `npm run jobspy:setup`, so neither
// the user's portals.yml nor the shipped template needs to hardcode an
// interpreter path. Checked relative to cwd (scan.mjs always runs from the
// project root). Returns null when no venv exists so the caller falls back to
// an explicit `python:` field or `python3`.
function detectVenvPython() {
  for (const p of ['.venv-jobspy/bin/python', '.venv-jobspy/Scripts/python.exe']) {
    if (existsSync(p)) return p;
  }
  return null;
}

// Translate the portals.yml `jobspy:` block into the JSON payload the Python
// script reads from stdin. Fails fast on an empty search_terms list — a JobSpy
// run with no terms would silently scrape nothing.
export function buildJobspyConfig(jobspy, { hoursOld } = {}) {
  const sites = Array.isArray(jobspy.sites) && jobspy.sites.length ? jobspy.sites : DEFAULT_SITES;
  const searchTerms = (Array.isArray(jobspy.search_terms) ? jobspy.search_terms : [])
    .filter(s => typeof s === 'string' && s.trim());
  if (searchTerms.length === 0) {
    throw new Error('jobspy: search_terms is empty — add at least one term under jobspy: in portals.yml');
  }
  const locations = (Array.isArray(jobspy.locations) ? jobspy.locations : [])
    .filter(s => typeof s === 'string' && s.trim());
  return {
    sites,
    search_terms: searchTerms,
    locations: locations.length ? locations : [''],
    results_wanted: Number.isInteger(jobspy.results_wanted) ? jobspy.results_wanted : 20,
    hours_old: Number.isInteger(hoursOld) ? hoursOld
      : (Number.isInteger(jobspy.hours_old) ? jobspy.hours_old : 168),
    country_indeed: typeof jobspy.country_indeed === 'string' ? jobspy.country_indeed : 'Switzerland',
    linkedin_fetch_description: !!jobspy.linkedin_fetch_description,
  };
}

// Normalize raw JobSpy rows into scan.mjs's {title,url,company,location,source}
// shape. Drops rows without a usable http(s) URL or title. `site` becomes a
// `jobspy-<site>` source tag so scan-history records which board found the job.
export function normalizeJobspyJobs(jobs) {
  if (!Array.isArray(jobs)) throw new Error('jobspy: expected an array of jobs');
  const out = [];
  for (const j of jobs) {
    if (!j || typeof j !== 'object') continue;
    const url = typeof j.url === 'string' ? j.url.trim() : '';
    const title = typeof j.title === 'string' ? j.title.trim() : '';
    if (!/^https?:\/\//i.test(url) || !title) continue;
    out.push({
      title,
      url,
      company: typeof j.company === 'string' && j.company.trim() ? j.company.trim() : 'Unknown',
      location: typeof j.location === 'string' ? j.location : '',
      source: typeof j.site === 'string' && j.site.trim() ? `jobspy-${j.site.trim()}` : 'jobspy',
    });
  }
  return out;
}

// Spawn the Python scraper and return { jobs, meta, errors }. Throws a clear,
// actionable error when Python or python-jobspy is missing, or the script fails
// — no silent fallback (the jobspy layer is opt-in; if enabled it must work).
export async function runJobspy(jobspy, opts = {}) {
  const pythonBin = process.env.CAREER_OPS_JOBSPY_PYTHON || jobspy.python || detectVenvPython() || 'python3';
  const scriptPath = opts.scriptPath || DEFAULT_SCRIPT;
  const cfg = buildJobspyConfig(jobspy, opts);

  let stdout;
  try {
    stdout = execFileSync(pythonBin, [scriptPath], {
      input: JSON.stringify(cfg),
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      // 300s (was 180s): a multi-term board scrape across LinkedIn/Indeed/Google
      // can exceed 3min and get SIGKILLed, losing ALL results. jobspy-scan.py
      // already collects per-query errors, so more headroom lets it finish and
      // return partial results + a surfaced errors[] rather than an all-or-nothing kill.
      timeout: opts.timeoutMs || 300_000,
    });
  } catch (err) {
    const stderr = (err.stderr || '').toString().trim();
    if (err.code === 'ENOENT') {
      throw new Error(`jobspy: python interpreter "${pythonBin}" not found — run "npm run jobspy:setup" (or set jobspy.python in portals.yml)`);
    }
    if (/No module named ['"]?jobspy|ImportError.*jobspy/.test(stderr)) {
      throw new Error(`jobspy: python-jobspy not installed for "${pythonBin}" — run "npm run jobspy:setup"`);
    }
    throw new Error(`jobspy: scan script failed (exit ${err.status ?? '?'}): ${stderr || err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`jobspy: could not parse script output as JSON (first 200 chars: ${stdout.slice(0, 200)})`);
  }
  return {
    jobs: normalizeJobspyJobs(parsed.jobs || []),
    meta: parsed.meta || {},
    errors: Array.isArray(parsed.errors) ? parsed.errors : [],
  };
}
