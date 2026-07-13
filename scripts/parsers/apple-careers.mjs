#!/usr/bin/env node
// @ts-check
/**
 * Apple Careers parser for career-ops scan.mjs (local_parser contract).
 *
 * Apple is NOT a supported ATS provider, so scan.mjs would otherwise hand it
 * off to expensive, low-recall agent WebSearch. jobs.apple.com is a hard SPA
 * (results are loaded client-side, never server-rendered into the HTML), but
 * it is backed by a public JSON search API we can drive with plain HTTP
 * (zero tokens, no browser) and read every listing:
 *
 *   1. GET  https://jobs.apple.com/api/v1/CSRFToken
 *        -> sets the `jobs` session cookie and returns the token in the
 *           `x-apple-csrf-token` RESPONSE header.
 *   2. POST https://jobs.apple.com/api/v1/search
 *        headers: X-Apple-CSRF-Token: <token>, Cookie: <jar from step 1>
 *        body:    {"query":"","filters":{"locations":["postLocation-CHEC"]},
 *                  "page":1,"locale":"en-us","sort":"newest","format":{...}}
 *        -> {"res":{"totalRecords":<N>,"searchResults":[{positionId,
 *            postingTitle, transformedPostingTitle, locations:[...]}, ...]}}
 *      (`locale` is REQUIRED — omitting it makes the API return 0 records.)
 *   Public posting URL: /en-us/details/{positionId}/{transformedPostingTitle}
 *
 * Switzerland filter: the country-level Apple location code is CHEC, sent as
 * `postLocation-CHEC`. This covers Zurich, Lausanne, etc. (region rolls up to
 * the country). Every Swiss role Apple lists is full-time (40-42 weekly hours).
 *
 * HARD RULE (modes/_custom.md): a search failure must never be silent. This
 * parser reads Apple's own `res.totalRecords` and EXITS NON-ZERO if it cannot
 * reach that count (HTTP error, blocked/empty/non-JSON body, missing total
 * field => structure changed, or partial pagination). It only prints an empty
 * list when Apple itself reports 0 records. scan.mjs surfaces a non-zero exit
 * under its "Errors" section, and the agent relays it to the user. Never emit
 * [] to paper over a broken fetch.
 *
 * Usage:  node scripts/parsers/apple-careers.mjs "<query-url-or-base>"
 *   The argument may be a full search URL (?location=switzerland-CHEC), a bare
 *   location slug (switzerland-CHEC / CHEC), or a `postLocation-XXX` code.
 *   With no recognisable location it defaults to Switzerland (postLocation-CHEC).
 * Output: JSON array of { title, url, company, location } on stdout.
 */

const HOST = 'https://jobs.apple.com';
const LOCALE = 'en-us';
const PAGE_SIZE = 20;          // Apple returns 20 results/page (loop guard only)
const MAX_PAGES = 60;          // safety cap (=> up to 1200 roles) so a bug can't loop forever
const FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_LOCATION = 'postLocation-CHEC'; // Switzerland (country-level)
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';

/** Exit loudly so scan.mjs records this source as FAILED (never silent). */
function fail(msg) {
  process.stderr.write(`apple-careers: ${msg}\n`);
  process.exit(1);
}

async function httpFetch(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (err) {
    fail(`fetch failed for ${url} — ${err.name === 'AbortError' ? `timeout after ${FETCH_TIMEOUT_MS}ms` : err.message}`);
  } finally {
    clearTimeout(t);
  }
  return res;
}

/** Accumulate Set-Cookie name=value pairs into a jar object. */
function storeCookies(res, jar) {
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const raw of setCookies) {
    const pair = raw.split(';', 1)[0];
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name || value === '' || value === '_remove_') continue;
    jar[name] = value;
  }
}

function cookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * Map the CLI argument to the API's `postLocation-XXX` filter value.
 * Accepts a full URL (?location=switzerland-CHEC), a slug (switzerland-CHEC),
 * a bare code (CHEC), or a ready `postLocation-XXX` string.
 */
function resolveLocation(arg) {
  let raw = String(arg || '');
  try {
    const u = new URL(raw);
    raw = u.searchParams.get('location') || raw;
  } catch {
    /* not a URL — treat as a slug/code */
  }
  const ready = raw.match(/postLocation-[A-Za-z0-9]+/);
  if (ready) return ready[0];
  const code = raw.split('-').pop().trim();
  if (/^[A-Za-z]{3,6}$/.test(code)) return `postLocation-${code.toUpperCase()}`;
  return DEFAULT_LOCATION;
}

/** GET the CSRF token; also populates the cookie jar Apple ties it to. */
async function getCsrf(jar) {
  const res = await httpFetch(`${HOST}/api/v1/${'CSRFToken'}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json', Referer: `${HOST}/${LOCALE}/search` },
  });
  if (!res.ok) fail(`HTTP ${res.status} fetching CSRF token — API changed or blocked`);
  storeCookies(res, jar);
  const token = res.headers.get('x-apple-csrf-token');
  if (!token) fail('no x-apple-csrf-token response header — CSRF flow changed or request was blocked');
  if (!jar.jobs) fail('CSRF request did not set the `jobs` session cookie — request was blocked');
  return token;
}

/** POST one page of search results; validates the response shape (hard-fail). */
async function searchPage(csrf, jar, location, page) {
  const body = {
    query: '',
    filters: { locations: [location] },
    page,
    locale: LOCALE,
    sort: 'newest',
    format: { longDate: 'MMMM D, YYYY', mediumDate: 'MMM D, YYYY' },
  };
  const res = await httpFetch(`${HOST}/api/v1/search`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Apple-CSRF-Token': csrf,
      Origin: HOST,
      Referer: `${HOST}/${LOCALE}/search`,
      Cookie: cookieHeader(jar),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) fail(`HTTP ${res.status} on search page ${page} — API changed, rate-limited, or blocked`);
  const text = await res.text();
  if (!text || text.length < 2) fail(`empty body on search page ${page} — likely blocked`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    fail(`non-JSON body on search page ${page} (${text.length} bytes) — likely blocked or an error page`);
  }
  const resObj = json && typeof json === 'object' && json.res ? json.res : json;
  if (!resObj || typeof resObj.totalRecords !== 'number' || !Array.isArray(resObj.searchResults)) {
    fail(`unexpected response on page ${page}: no numeric res.totalRecords / res.searchResults[] — API changed or blocked. Body: ${text.slice(0, 200)}`);
  }
  return resObj;
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function jobLocation(job) {
  const locs = Array.isArray(job.locations) ? job.locations : [];
  const names = locs.map(l => (l && (l.name || l.city || l.countryName)) || '').filter(Boolean);
  return [...new Set(names)].join(', ') || 'Switzerland';
}

/** Add a page's results to the dedup map (keyed by positionId). */
function collect(resObj, jobs) {
  for (const job of resObj.searchResults) {
    const positionId = String(job.positionId || '').trim();
    if (!positionId || jobs.has(positionId)) continue;
    const title = String(job.postingTitle || job.title || '').trim();
    if (!title) continue;
    const slug = job.transformedPostingTitle || slugify(title);
    jobs.set(positionId, {
      title,
      url: `${HOST}/${LOCALE}/details/${positionId}/${slug}`,
      company: 'Apple',
      location: jobLocation(job),
    });
  }
}

async function main() {
  const arg = process.argv[2];
  if (!arg) fail('missing query-url-or-base argument');
  const location = resolveLocation(arg);

  const jar = {};
  const csrf = await getCsrf(jar);

  // Page 1 establishes the authoritative total.
  const first = await searchPage(csrf, jar, location, 1);
  const total = first.totalRecords;

  const jobs = new Map();
  collect(first, jobs);

  if (total === 0) {
    // Genuine zero — legitimate to report an empty list.
    process.stdout.write('[]');
    return;
  }

  // Paginate until we have every record Apple claims exist.
  for (let page = 2; jobs.size < total && page <= MAX_PAGES; page++) {
    const resObj = await searchPage(csrf, jar, location, page);
    const before = jobs.size;
    collect(resObj, jobs);
    if (jobs.size === before) break; // page yielded nothing new — stop; the count check below decides
    void PAGE_SIZE;
  }

  // SELF-VERIFY: partial coverage is a failure, not a clean scan.
  if (jobs.size < total) {
    fail(`partial result: extracted ${jobs.size} of ${total} records Apple reports for ${location} — pagination or API failure, refusing to report as complete`);
  }

  process.stdout.write(JSON.stringify([...jobs.values()]));
}

main().catch(err => fail(err && err.message ? err.message : String(err)));
