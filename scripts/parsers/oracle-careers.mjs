#!/usr/bin/env node
// @ts-check
/**
 * Oracle Careers parser for career-ops scan.mjs (local_parser contract).
 *
 * Oracle is NOT a first-class ATS provider in scan.mjs, so it would otherwise
 * fall back to expensive, low-recall agent WebSearch. Oracle careers
 * (careers.oracle.com) runs on Oracle Recruiting Cloud (ORC / Fusion) and is
 * backed by a public JSON API, so we can hit it with plain HTTP + pagination
 * (zero tokens, no browser) and enumerate every Swiss listing.
 *
 * How it works (all discovered live, nothing hard-coded that can drift):
 *   1. Fetch the careers site URL (argv[2]) and read the SPA's <base> tag for
 *      `data-apibaseurl` (the ORC REST host, e.g. eeho.fa.us2.oraclecloud.com)
 *      and `data-sitenumber` (e.g. CX_45001).
 *   2. Resolve the location facet id for the target ("Switzerland" by default,
 *      overridable via a `?location=` query param on argv[2]) by asking the API
 *      to match the location name and reading back `locationsFacet`.
 *   3. Page through recruitingCEJobRequisitions filtered by that
 *      `selectedLocationsFacet`, reading the API's own `TotalJobsCount`.
 *   4. Emit one row per requisition: { title, url, company:"Oracle", location }.
 *      `url` is the public posting URL: {publicBase}/job/{Id}.
 *
 * The ORC location facet matches on primary OR secondary location, so a role
 * whose primary is elsewhere but which lists a Swiss secondary location is
 * (correctly, per house rules) still returned — we don't drop it.
 *
 * HARD RULE (modes/_custom.md): a search failure must never be silent. This
 * parser reads the API's authoritative `TotalJobsCount` for the filtered set
 * and EXITS NON-ZERO if it cannot reach it (HTTP error, blocked/empty body,
 * non-JSON, missing total field, failed location resolution, partial
 * pagination). It only prints an empty list when the API itself reports 0
 * matching jobs. scan.mjs surfaces a non-zero exit under its "Errors" section
 * and the agent relays it. Never emit [] to paper over a broken fetch.
 *
 * Usage:  node scripts/parsers/oracle-careers.mjs "https://careers.oracle.com/"
 *         node scripts/parsers/oracle-careers.mjs "https://careers.oracle.com/?location=Zurich"
 * Output: JSON array of { title, url, company, location } on stdout.
 */

const DEFAULT_LOCATION = 'Switzerland';
const PAGE_SIZE = 100;          // ORC accepts large limits; CH is a single small page
const MAX_PAGES = 60;           // safety cap so a bug can't loop forever
const FETCH_TIMEOUT_MS = 12_000;
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';
// expand is REQUIRED for the API to include requisitionList[] in the response.
const EXPAND = 'requisitionList.secondaryLocations,flexFieldsFacet.values';

/** Exit loudly so scan.mjs records this source as FAILED (never silent). */
function fail(msg) {
  process.stderr.write(`oracle-careers: ${msg}\n`);
  process.exit(1);
}

async function fetchWithTimeout(url, accept) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': accept, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
  } catch (err) {
    fail(`fetch failed for ${url} — ${err.name === 'AbortError' ? `timeout after ${FETCH_TIMEOUT_MS}ms` : err.message}`);
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) fail(`HTTP ${res.status} for ${url}`);
  return res;
}

/** Fetch the careers SPA shell and read the API host + site number + public base. */
async function discover(pageUrl) {
  const res = await fetchWithTimeout(pageUrl, 'text/html');
  const html = await res.text();
  if (!html || html.length < 2_000) {
    fail(`suspiciously small body (${html ? html.length : 0} bytes) for ${pageUrl} — likely blocked`);
  }
  const baseTag = (html.match(/<base\b[^>]*>/i) || [])[0];
  if (!baseTag) fail(`no <base> tag in ${pageUrl} — not an Oracle Recruiting Cloud careers page, or blocked`);

  const apiBaseRaw = (baseTag.match(/data-apibaseurl=["']([^"']+)["']/i) || [])[1];
  const siteNumber = (baseTag.match(/data-sitenumber=["']([^"']+)["']/i) || [])[1];
  const baseHref = (baseTag.match(/\bhref=["']([^"']+)["']/i) || [])[1];

  if (!apiBaseRaw) fail(`could not read data-apibaseurl from ${pageUrl} — page structure changed or blocked`);
  if (!siteNumber) fail(`could not read data-sitenumber from ${pageUrl} — page structure changed or blocked`);

  let apiHost;
  try {
    apiHost = new URL(apiBaseRaw).origin; // strips the :443 default port
  } catch {
    fail(`invalid data-apibaseurl "${apiBaseRaw}" from ${pageUrl}`);
  }

  // Public posting base: the site's own origin + its SPA base path.
  let publicBase;
  try {
    publicBase = new URL(baseHref || '/', res.url).href.replace(/\/+$/, '');
  } catch {
    publicBase = res.url.replace(/\/+$/, '');
  }

  return { apiHost, siteNumber, publicBase };
}

function reqUrl(apiHost, finderParts, { expand = false } = {}) {
  const finder = 'findReqs;' + finderParts.join(',');
  const params = new URLSearchParams({ onlyData: 'true' });
  if (expand) params.set('expand', EXPAND);
  params.set('finder', finder);
  return `${apiHost}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?${params.toString()}`;
}

async function fetchJson(url) {
  const res = await fetchWithTimeout(url, 'application/json');
  const txt = await res.text();
  if (!txt || txt.length < 2) fail(`empty body for ${url} — likely blocked`);
  let data;
  try {
    data = JSON.parse(txt);
  } catch {
    // ORC returns the SPA HTML shell instead of JSON when a request is blocked
    // or the path is wrong — treat that as a failure, never as "0 jobs".
    fail(`non-JSON response for ${url} (first 120 chars: ${txt.slice(0, 120).replace(/\s+/g, ' ')})`);
  }
  const item = data && Array.isArray(data.items) ? data.items[0] : null;
  if (!item) fail(`unexpected response shape for ${url} — no items[0]`);
  return item;
}

/** Resolve the location-facet id for a location name (e.g. "Switzerland"). */
async function resolveLocationFacet(apiHost, siteNumber, term) {
  const item = await fetchJson(
    reqUrl(apiHost, [`siteNumber=${siteNumber}`, `location=${term}`, 'limit=1']),
  );
  const total = item.TotalJobsCount;
  if (typeof total !== 'number') {
    fail(`missing TotalJobsCount while resolving location "${term}" — page structure changed or blocked`);
  }
  const facet = Array.isArray(item.locationsFacet) ? item.locationsFacet : [];
  const norm = s => String(s || '').trim().toLowerCase();
  // Prefer an exact name match (the country/city node), else the best partial.
  const hit =
    facet.find(f => norm(f.Name) === norm(term)) ||
    facet.find(f => norm(f.Name).startsWith(norm(term) + ',')) ||
    facet.find(f => norm(f.Name).includes(norm(term)));

  return { total, hit: hit || null };
}

async function main() {
  const base = process.argv[2];
  if (!base) fail('missing careers-page URL argument (e.g. https://careers.oracle.com/)');
  let pageUrl;
  try {
    pageUrl = new URL(base);
  } catch {
    fail(`invalid URL: ${base}`);
  }
  const term = (pageUrl.searchParams.get('location') || DEFAULT_LOCATION).trim();

  const { apiHost, siteNumber, publicBase } = await discover(pageUrl.href);

  // Step 1: resolve the location facet id for the target location.
  const { total: locTotal, hit } = await resolveLocationFacet(apiHost, siteNumber, term);
  if (!hit) {
    if (locTotal === 0) {
      // Genuine zero — the site truly has no jobs for this location.
      process.stdout.write('[]');
      return;
    }
    fail(`could not resolve a location facet for "${term}" although the API reports ${locTotal} matching job(s) — location resolution failed, refusing to report 0`);
  }
  const facetId = hit.Id;

  // Step 2: page through the requisitions filtered by that location facet.
  const jobs = new Map(); // dedup by requisition Id
  let total = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_SIZE;
    const item = await fetchJson(
      reqUrl(
        apiHost,
        [
          `siteNumber=${siteNumber}`,
          `selectedLocationsFacet=${facetId}`,
          `limit=${PAGE_SIZE}`,
          `offset=${offset}`,
          'sortBy=POSTING_DATES_DESC',
        ],
        { expand: true },
      ),
    );
    if (typeof item.TotalJobsCount !== 'number') {
      fail('missing TotalJobsCount in requisitions response — page structure changed or blocked');
    }
    if (total === null) total = item.TotalJobsCount;

    if (total === 0) {
      process.stdout.write('[]');
      return;
    }

    const list = Array.isArray(item.requisitionList) ? item.requisitionList : [];
    if (list.length === 0) break; // no more rows; the count check below decides pass/fail
    for (const r of list) {
      if (r && r.Id != null && !jobs.has(String(r.Id))) jobs.set(String(r.Id), r);
    }
    if (jobs.size >= total) break;
  }

  if (total === null) fail('never received a TotalJobsCount from the requisitions API');

  // SELF-VERIFY: partial coverage is a failure, not a clean scan.
  if (jobs.size < total) {
    fail(`partial result: extracted ${jobs.size} of ${total} jobs the API reports for "${term}" — pagination or markup failure, refusing to report as complete`);
  }

  const payload = [...jobs.values()].map(r => {
    const secCH = (Array.isArray(r.secondaryLocations) ? r.secondaryLocations : [])
      .filter(s => String(s.CountryCode).toUpperCase() === 'CH' || /switzerland/i.test(s.Name || ''))
      .map(s => String(s.Name || '').trim())
      .filter(Boolean);
    let location = String(r.PrimaryLocation || '').trim();
    if (String(r.PrimaryLocationCountry).toUpperCase() !== 'CH' && secCH.length) {
      const extra = secCH.filter(n => n.toLowerCase() !== location.toLowerCase());
      if (extra.length) location = location ? `${location}; ${extra.join('; ')}` : extra.join('; ');
    }
    return {
      title: String(r.Title || '').trim(),
      url: `${publicBase}/job/${encodeURIComponent(String(r.Id))}`,
      company: 'Oracle',
      location,
    };
  });

  process.stdout.write(JSON.stringify(payload));
}

main().catch(err => fail(err && err.message ? err.message : String(err)));
