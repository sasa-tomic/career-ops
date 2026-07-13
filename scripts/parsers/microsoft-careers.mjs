#!/usr/bin/env node
// @ts-check
/**
 * Microsoft Careers parser for career-ops scan.mjs (local_parser contract).
 *
 * Microsoft is NOT a supported ATS provider, so scan.mjs would otherwise hand
 * it off to expensive, low-recall agent WebSearch. careers.microsoft.com is a
 * client-side-rendered SPA (its HTML shell carries NO job data — verified: no
 * __NEXT_DATA__, no embedded jobs, no totalJobs), but the SPA is driven by a
 * public JSON search API we can hit directly with plain HTTP (zero tokens, no
 * browser) and paginate through every listing:
 *
 *   https://gcsservices.careers.microsoft.com/search/api/v1/search
 *
 * Response shape (authoritative total is operationResult.result.totalJobs):
 *   { operationResult: { result: { jobs: [ { jobId, title,
 *       properties: { locations: [...], primaryLocation } } ], totalJobs } } }
 *
 * Public posting URL:  https://jobs.careers.microsoft.com/global/en/job/{id}
 *
 * HARD RULE (modes/_custom.md): a search failure must never be silent. This
 * parser reads the API's own totalJobs and EXITS NON-ZERO if it cannot reach
 * that count (TLS/cert error, HTTP error, blocked/non-JSON body, missing total,
 * or partial pagination). It only prints an empty list when the API itself
 * reports totalJobs === 0. scan.mjs surfaces a non-zero exit under its "Errors"
 * section and the agent relays it to the user. Never emit [] to paper over a
 * broken fetch.
 *
 * KNOWN ENVIRONMENT RISK: in some networks (observed here) the gcsservices host
 * is fronted by an Azure CDN that serves a *.azureedge.net certificate, so the
 * TLS handshake fails with ERR_TLS_CERT_ALTNAME_INVALID. That is exactly the
 * kind of blocked fetch this parser must fail loudly on — it will exit 1 with
 * the cert error on stderr rather than pretend Microsoft has zero openings.
 *
 * Usage:  node scripts/parsers/microsoft-careers.mjs "<query-url-or-base>"
 *   argv[2] may be the gcsservices API URL with search params, a public
 *   jobs.careers.microsoft.com search URL, or a bare base — recognized search
 *   params (lc/city/pl/q/…) are carried over; location defaults to Switzerland.
 * Output: JSON array of { title, url, company:"Microsoft", location } on stdout.
 */

const API_BASE = 'https://gcsservices.careers.microsoft.com/search/api/v1/search';
const JOB_URL_BASE = 'https://jobs.careers.microsoft.com/global/en/job/';
const PAGE_SIZE = 20;           // API page size we request via pgSz
const MAX_PAGES = 60;           // safety cap (=> up to 1200 roles) so a bug can't loop forever
const FETCH_TIMEOUT_MS = 15_000;
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';

// Query params we carry over from argv[2] onto the API request (everything else
// is dropped; pg/pgSz/l/o are always set by us below).
const CARRY_PARAMS = ['lc', 'city', 'pl', 'q', 'rt', 'exp', 'et', 'ws', 'flt'];
// Params that pin a location — if argv[2] has none of these, default lc=Switzerland.
const LOCATION_PARAMS = ['lc', 'city', 'pl'];

/** Exit loudly so scan.mjs records this source as FAILED (never silent). */
function fail(msg) {
  process.stderr.write(`microsoft-careers: ${msg}\n`);
  process.exit(1);
}

/** Build the gcsservices API URL for a given page from the caller's input URL. */
function buildApiUrl(inputUrl, page) {
  const api = new URL(API_BASE);
  let hadLocation = false;
  for (const key of CARRY_PARAMS) {
    const val = inputUrl.searchParams.get(key);
    if (val != null && val !== '') {
      api.searchParams.set(key, val);
      if (LOCATION_PARAMS.includes(key)) hadLocation = true;
    }
  }
  if (!hadLocation) api.searchParams.set('lc', 'Switzerland');
  api.searchParams.set('l', 'en_us');
  api.searchParams.set('pg', String(page));
  api.searchParams.set('pgSz', String(PAGE_SIZE));
  api.searchParams.set('o', 'Recent');
  return api.href;
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Language': 'en-US,en;q=0.9' },
      signal: ctrl.signal,
    });
  } catch (err) {
    // TLS/cert failures (ERR_TLS_CERT_ALTNAME_INVALID), DNS, connection resets,
    // and timeouts all land here — the known blocked-fetch path.
    const code = err && err.cause && (err.cause.code || err.cause.message);
    const detail =
      err && err.name === 'AbortError'
        ? `timeout after ${FETCH_TIMEOUT_MS}ms`
        : `${err && err.message}${code ? ` (${code})` : ''}`;
    fail(`fetch failed for ${url} — ${detail}`);
    return; // unreachable (fail exits) — keeps the type checker happy
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) fail(`HTTP ${res.status} ${res.statusText} for ${url}`);
  const body = await res.text();
  if (!body || body.length < 2) fail(`empty body for ${url} — likely blocked`);
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    // A non-JSON body (HTML error/interstitial/challenge page) is a blocked
    // fetch, not zero results.
    fail(`non-JSON body (${body.length} bytes) for ${url} — likely blocked or wrong endpoint`);
  }
  return json;
}

/** Pull the { jobs, totalJobs } payload out of the API envelope, or fail loudly. */
function extractResult(json, url) {
  const result = json && json.operationResult && json.operationResult.result;
  if (!result || typeof result !== 'object') {
    fail(`missing operationResult.result in response for ${url} — API shape changed or blocked`);
  }
  const total = result.totalJobs;
  if (typeof total !== 'number' || !Number.isFinite(total)) {
    fail(`missing/invalid totalJobs in response for ${url} — refusing to guess the total`);
  }
  const jobs = Array.isArray(result.jobs) ? result.jobs : [];
  return { total, jobs };
}

/** Normalize one API job into { id, title, url, location }, or null if unusable. */
function normalizeJob(job) {
  if (!job || typeof job !== 'object') return null;
  const id = String(job.jobId || job.id || '').trim();
  const title = String(job.title || '').trim();
  if (!id || !title) return null;

  const props = job.properties || {};
  let location = '';
  if (Array.isArray(props.locations) && props.locations.length) {
    location = props.locations.map(l => String(l).trim()).filter(Boolean).join('; ');
  } else if (props.primaryLocation) {
    location = String(props.primaryLocation).trim();
  } else if (job.location) {
    location = String(job.location).trim();
  }

  return { id, title, url: JOB_URL_BASE + encodeURIComponent(id), location };
}

async function main() {
  const arg = process.argv[2];
  if (!arg) fail('missing query-url-or-base argument');
  let inputUrl;
  try {
    inputUrl = new URL(arg);
  } catch {
    fail(`invalid URL: ${arg}`);
    return; // unreachable
  }

  // Page 1 establishes the authoritative total.
  const firstUrl = buildApiUrl(inputUrl, 1);
  const first = await fetchJson(firstUrl);
  const { total } = extractResult(first, firstUrl);

  const jobs = new Map(); // dedup by jobId
  for (const j of extractResult(first, firstUrl).jobs) {
    const n = normalizeJob(j);
    if (n) jobs.set(n.id, n);
  }

  if (total === 0) {
    // Genuine zero — legitimate to report an empty list.
    process.stdout.write('[]');
    return;
  }

  // Paginate until we have every job the API claims exist.
  for (let page = 2; jobs.size < total && page <= MAX_PAGES; page++) {
    const pageUrl = buildApiUrl(inputUrl, page);
    const json = await fetchJson(pageUrl);
    const { jobs: pageJobs } = extractResult(json, pageUrl);
    const before = jobs.size;
    for (const j of pageJobs) {
      const n = normalizeJob(j);
      if (n && !jobs.has(n.id)) jobs.set(n.id, n);
    }
    if (jobs.size === before) break; // page yielded nothing new — let the check below decide
  }

  // SELF-VERIFY: partial coverage is a failure, not a clean scan.
  if (jobs.size < total) {
    fail(
      `partial result: extracted ${jobs.size} of ${total} jobs the API reports — ` +
        `pagination or shape failure, refusing to report as complete`,
    );
  }

  const payload = [...jobs.values()].map(j => ({
    title: j.title,
    url: j.url,
    company: 'Microsoft',
    location: j.location,
  }));
  process.stdout.write(JSON.stringify(payload));
}

main().catch(err => fail(err && err.message ? err.message : String(err)));
