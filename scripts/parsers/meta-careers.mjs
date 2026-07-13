#!/usr/bin/env node
// @ts-check
/**
 * Meta Careers parser for career-ops scan.mjs (local_parser contract).
 *
 * Meta (metacareers.com) is NOT a supported ATS provider, and its job list is
 * NOT in the initial HTML — the page is a client-rendered Relay app that loads
 * results from a GraphQL endpoint. scan.mjs would otherwise hand Meta off to
 * expensive, low-recall agent WebSearch. Instead we reproduce the exact request
 * the site's own front-end makes (zero tokens, no browser):
 *
 *   1. GET https://www.metacareers.com/jobs/  (302 -> /jobsearch/) to obtain a
 *      fresh `lsd` CSRF token from the inlined `["LSD",[],{"token":"..."}]` blob.
 *   2. POST https://www.metacareers.com/graphql  (form-encoded) with the
 *      persisted query `CareersJobSearchResultsV2DataQuery` (doc_id below) and a
 *      `search_input` whose `offices` array pins Zurich/Switzerland.
 *
 * The response's `data.job_search_with_featured_jobs_v2.all_jobs[]` is the full
 * office-filtered result set the site renders as "N Items / Page 1 of 1" (this
 * query is not server-paginated — `results_per_page:null` returns every match).
 * `featured_jobs[]` are unrelated promoted roles (often US-only) and are IGNORED.
 *
 * Request shape (captured from a real Chrome session on 2026-07-13):
 *   fb_api_req_friendly_name = CareersJobSearchResultsV2DataQuery
 *   doc_id                   = 27129360303422352
 *   fb_api_caller_class      = RelayModern
 *   variables = {"search_input":{...,"offices":["Zurich, Switzerland"],...},
 *                "viewasUserID":null,"isLoggedIn":false}
 *
 * HARD RULE (modes/_custom.md): a search failure must never be silent. Meta
 * aggressively rate-limits/soft-blocks scripted access — when throttled it
 * returns a generic "Sorry, something went wrong" HTML page with HTTP 400, or a
 * GraphQL `errors[]` payload. This parser EXITS NON-ZERO on: HTTP error, a
 * non-JSON / HTML "blocked" body, a GraphQL `errors[]` payload, a missing LSD
 * token, or a missing `all_jobs` array. It only prints `[]` when Meta itself
 * returns an empty `all_jobs` for the office filter. scan.mjs surfaces a
 * non-zero exit under its "Errors" section, and the agent relays it to the
 * user. Never emit [] to paper over a block, a challenge page, or a rotated
 * doc_id.
 *
 * If `doc_id` is ever rotated by Meta, the POST returns a GraphQL error and this
 * parser fails loudly (never silently) — update the constant below to the new
 * persisted-query id (capture it from the site's `graphql` XHR).
 *
 * Usage:  node scripts/parsers/meta-careers.mjs "<jobs-url-or-base>"
 *         e.g. ".../jobs/?offices[0]=Zurich%2C%20Switzerland"
 * Output: JSON array of { title, url, company:"Meta", location } on stdout.
 */

const GRAPHQL_URL = 'https://www.metacareers.com/graphql';
const HTML_URL = 'https://www.metacareers.com/jobs/';
const DOC_ID = '27129360303422352'; // CareersJobSearchResultsV2DataQuery (see header)
const FRIENDLY_NAME = 'CareersJobSearchResultsV2DataQuery';
const DEFAULT_OFFICES = ['Zurich, Switzerland'];
const FETCH_TIMEOUT_MS = 15_000;
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/** Exit loudly so scan.mjs records this source as FAILED (never silent). */
function fail(msg) {
  process.stderr.write(`meta-careers: ${msg}\n`);
  process.exit(1);
}

async function httpFetch(url, options, label) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { ...options, signal: ctrl.signal });
  } catch (err) {
    fail(
      `${label} fetch failed for ${url} — ${
        err && err.name === 'AbortError' ? `timeout after ${FETCH_TIMEOUT_MS}ms` : (err && err.message) || String(err)
      }`,
    );
  } finally {
    clearTimeout(t);
  }
  return res;
}

/**
 * Read the offices to filter on from the caller's URL. scan.mjs passes the
 * configured `careers_url`, e.g. ".../jobs/?offices[0]=Zurich, Switzerland".
 * Collect every `offices[N]` param; fall back to Zurich if none are present so
 * the parser is honestly scoped even when handed a bare base URL.
 */
function officesFromUrl(u) {
  const offices = [];
  for (const [key, value] of u.searchParams.entries()) {
    if (/^offices\[\d+\]$/.test(key) && value.trim()) offices.push(value.trim());
  }
  return offices.length ? offices : DEFAULT_OFFICES.slice();
}

/** Extract the fresh LSD CSRF token Meta inlines into the jobs page. */
function parseLsd(html) {
  const m = html.match(/"LSD",\[\],\{"token":"([^"]+)"/);
  return m ? m[1] : null;
}

/**
 * A Switzerland-relevant location: matches the requested office(s) or any
 * ", Switzerland" location. Multi-location roles that include a CH office (e.g.
 * "Zurich, Switzerland" + "London, UK") are genuinely CH-eligible and kept.
 */
function isSwissMatch(locations, offices) {
  const lower = locations.map(l => String(l).toLowerCase());
  const officeLower = offices.map(o => o.toLowerCase());
  return lower.some(
    loc => loc.includes('switzerland') || officeLower.some(o => o && loc.includes(o)),
  );
}

async function main() {
  const arg = process.argv[2];
  if (!arg) fail('missing jobs-url-or-base argument');
  let inputUrl;
  try {
    inputUrl = new URL(arg);
  } catch {
    fail(`invalid URL: ${arg}`);
  }
  if (inputUrl.protocol !== 'http:' && inputUrl.protocol !== 'https:') {
    fail(`URL must be http(s): ${arg}`);
  }
  const offices = officesFromUrl(inputUrl);

  // Step 1: GET the jobs page for a fresh LSD token (also establishes a normal
  // navigation, which Meta's edge expects before it will answer the graphql XHR).
  const htmlRes = await httpFetch(
    HTML_URL,
    {
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1',
      },
    },
    'html',
  );
  if (!htmlRes.ok) fail(`HTTP ${htmlRes.status} fetching ${HTML_URL} — likely blocked`);
  const html = await htmlRes.text();
  if (!html || html.length < 2_000) {
    fail(`suspiciously small jobs page (${html ? html.length : 0} bytes) — likely blocked`);
  }
  const lsd = parseLsd(html);
  if (!lsd) {
    fail('could not extract LSD token from jobs page — blocked, served a challenge page, or markup changed');
  }

  // Step 2: POST the persisted job-search query, filtered to the requested offices.
  const variables = {
    search_input: {
      q: null,
      divisions: [],
      offices,
      roles: [],
      leadership_levels: [],
      saved_jobs: [],
      saved_searches: [],
      sub_teams: [],
      teams: [],
      is_leadership: false,
      is_remote_only: false,
      sort_by_new: false,
      results_per_page: null,
    },
    viewasUserID: null,
    isLoggedIn: false,
  };
  const body = new URLSearchParams({
    lsd,
    fb_api_caller_class: 'RelayModern',
    fb_api_req_friendly_name: FRIENDLY_NAME,
    variables: JSON.stringify(variables),
    server_timestamps: 'true',
    __a: '1',
    doc_id: DOC_ID,
  });

  const gqlRes = await httpFetch(
    GRAPHQL_URL,
    {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-FB-LSD': lsd,
        Origin: 'https://www.metacareers.com',
        Referer: HTML_URL,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
      },
      body: body.toString(),
    },
    'graphql',
  );
  if (!gqlRes.ok) {
    fail(`GraphQL HTTP ${gqlRes.status} — Meta is rate-limiting/soft-blocking scripted access (generic error page)`);
  }
  const raw = await gqlRes.text();
  if (!raw) fail('empty GraphQL response body — likely blocked');
  // A block/challenge returns an HTML error document, not JSON.
  if (/^\s*</.test(raw)) {
    fail('GraphQL returned an HTML error page instead of JSON — blocked/challenge (rate-limited)');
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    fail(`GraphQL response was not valid JSON (first 120 chars: ${raw.slice(0, 120).replace(/\s+/g, ' ')})`);
  }
  if (json.errors && json.errors.length) {
    const first = json.errors[0] || {};
    fail(
      `GraphQL error: ${first.message || first.summary || 'unknown'} — the persisted query (doc_id ${DOC_ID}) may have rotated or been blocked`,
    );
  }

  const node = json.data && json.data.job_search_with_featured_jobs_v2;
  if (!node || !Array.isArray(node.all_jobs)) {
    fail('response missing data.job_search_with_featured_jobs_v2.all_jobs[] — query shape changed or request was blocked');
  }
  const allJobs = node.all_jobs; // authoritative full result set for the office filter

  if (allJobs.length === 0) {
    // Genuine zero — legitimate to report an empty list.
    process.stdout.write('[]');
    return;
  }

  const payload = [];
  for (const j of allJobs) {
    const id = j && (j.id != null ? String(j.id) : '');
    const title = j && j.title ? String(j.title).trim() : '';
    const locations = Array.isArray(j && j.locations) ? j.locations.map(String) : [];
    if (!id || !title) continue;
    // Defensive CH filter: the office-filtered query already scopes results, but
    // never surface a row that isn't Switzerland-relevant.
    if (!isSwissMatch(locations, offices)) continue;
    payload.push({
      title,
      url: `https://www.metacareers.com/jobs/${id}/`,
      company: 'Meta',
      location: locations.join('; ') || offices.join('; '),
    });
  }

  process.stdout.write(JSON.stringify(payload));
}

main().catch(err => fail(err && err.message ? err.message : String(err)));
