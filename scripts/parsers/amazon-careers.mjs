#!/usr/bin/env node
// @ts-check
/**
 * Amazon Jobs parser for career-ops scan.mjs (local_parser contract).
 *
 * Amazon is NOT a supported ATS provider, so scan.mjs would otherwise hand it
 * off to expensive, low-recall agent WebSearch. Amazon exposes a public JSON
 * search API (https://www.amazon.jobs/en/search.json) that we can hit with
 * plain HTTP (zero tokens, no browser) and paginate to get every listing.
 *
 * HARD RULE (modes/_custom.md): a search failure must never be silent. This
 * parser reads the API's own authoritative `hits` total and EXITS NON-ZERO if
 * it cannot reach that count (HTTP error, blocked/non-JSON body, `error` field
 * set, `hits` missing => structure changed, or partial pagination). It only
 * prints an empty list when the API itself reports hits: 0. scan.mjs surfaces a
 * non-zero exit under its "Errors" section, and the agent relays it to the
 * user. Never emit [] to paper over a broken fetch.
 *
 * Usage:  node scripts/parsers/amazon-careers.mjs "<search.json-or-search-URL>"
 *   The URL should pin the location via query params, e.g.
 *   https://www.amazon.jobs/en/search.json?loc_query=Zurich,%20Switzerland&country=CHE&sort=recent
 *   A plain .../en/search HTML-page URL is accepted too (rewritten to search.json).
 * Output: JSON array of { title, url, company, location } on stdout.
 */

const DEFAULT_RESULT_LIMIT = 100;   // Amazon's max page size
const MAX_PAGES = 60;               // safety cap (=> up to 6000 roles) so a bug can't loop forever
const FETCH_TIMEOUT_MS = 12_000;
const JOBS_ORIGIN = 'https://www.amazon.jobs';
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';

/** Exit loudly so scan.mjs records this source as FAILED (never silent). */
function fail(msg) {
  process.stderr.write(`amazon-careers: ${msg}\n`);
  process.exit(1);
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: ctrl.signal,
    });
  } catch (err) {
    fail(`fetch failed for ${url} — ${err.name === 'AbortError' ? `timeout after ${FETCH_TIMEOUT_MS}ms` : err.message}`);
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) fail(`HTTP ${res.status} for ${url}`);
  const body = await res.text();
  if (!body || body.length < 2) fail(`empty body for ${url} — likely blocked`);
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    // A blocked/challenge/HTML response parses as non-JSON — that is a failure,
    // never a "0 results" we can silently swallow.
    fail(`non-JSON body (${body.length} bytes) for ${url} — likely blocked or wrong endpoint`);
  }
  if (json && json.error) fail(`API returned error for ${url}: ${JSON.stringify(json.error)}`);
  return json;
}

/**
 * Normalize the caller-supplied URL into an amazon.jobs search.json request with
 * pagination params set. A non-amazon.jobs host is left untouched so a bad host
 * fails loudly at fetch time instead of being silently redirected.
 */
function buildQueryUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`invalid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail(`URL must be http(s): ${raw}`);
  }
  if (/(^|\.)amazon\.jobs$/i.test(url.hostname) && !/search\.json$/.test(url.pathname)) {
    // Accept the human search page (/en/search) and rewrite to the JSON endpoint.
    url.pathname = url.pathname.replace(/\/search\/?$/i, '/search.json');
    if (!/search\.json$/.test(url.pathname)) url.pathname = '/en/search.json';
  }
  if (!url.searchParams.has('result_limit')) url.searchParams.set('result_limit', String(DEFAULT_RESULT_LIMIT));
  if (!url.searchParams.has('sort')) url.searchParams.set('sort', 'recent');
  url.searchParams.set('offset', '0');
  return url;
}

function dedupKey(job) {
  return String(job.id_icims || job.id || job.job_path || '').trim();
}

function jobLocation(job) {
  const loc = job.normalized_location || job.location;
  if (loc) return String(loc).trim();
  const parts = [job.city, job.state, job.country_code].filter(Boolean);
  return parts.join(', ');
}

function jobUrl(job) {
  const path = String(job.job_path || '').trim();
  if (!path) return '';
  try {
    return new URL(path, JOBS_ORIGIN).href;
  } catch {
    return '';
  }
}

async function main() {
  const arg = process.argv[2];
  if (!arg) fail('missing search URL argument');

  const url = buildQueryUrl(arg);
  const step = Number(url.searchParams.get('result_limit')) || DEFAULT_RESULT_LIMIT;

  // Page 1 establishes the authoritative total.
  const first = await fetchJson(url.href);
  const total = first.hits;
  if (typeof total !== 'number' || !Number.isFinite(total)) {
    fail('could not read numeric `hits` total — API structure changed or request was blocked');
  }
  if (!Array.isArray(first.jobs)) {
    fail('response has no `jobs` array — API structure changed or request was blocked');
  }

  const jobs = new Map();
  for (const job of first.jobs) {
    const key = dedupKey(job);
    if (key && !jobs.has(key)) jobs.set(key, job);
  }

  if (total === 0) {
    // Genuine zero — legitimate to report an empty list.
    process.stdout.write('[]');
    return;
  }

  // Paginate via offset until we have every hit the API claims exist.
  for (let page = 1; jobs.size < total && page < MAX_PAGES; page++) {
    url.searchParams.set('offset', String(page * step));
    const data = await fetchJson(url.href);
    if (!Array.isArray(data.jobs)) {
      fail(`response has no \`jobs\` array at offset ${page * step} — API structure changed or request was blocked`);
    }
    const before = jobs.size;
    for (const job of data.jobs) {
      const key = dedupKey(job);
      if (key && !jobs.has(key)) jobs.set(key, job);
    }
    if (jobs.size === before) break; // page yielded nothing new — let the count check below decide
  }

  // SELF-VERIFY: partial coverage is a failure, not a clean scan.
  if (jobs.size < total) {
    fail(`partial result: extracted ${jobs.size} of ${total} hits the API reports — pagination or markup failure, refusing to report as complete`);
  }

  const payload = [];
  for (const job of jobs.values()) {
    const title = String(job.title || '').trim();
    const url2 = jobUrl(job);
    if (!title || !url2) continue;
    payload.push({
      title,
      url: url2,
      company: 'Amazon',
      location: jobLocation(job),
    });
  }
  process.stdout.write(JSON.stringify(payload));
}

main().catch(err => fail(err && err.message ? err.message : String(err)));
