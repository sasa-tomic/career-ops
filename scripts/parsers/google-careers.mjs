#!/usr/bin/env node
// @ts-check
/**
 * Google Careers parser for career-ops scan.mjs (local_parser contract).
 *
 * Google is NOT a supported ATS provider, so scan.mjs would otherwise hand it
 * off to expensive, low-recall agent WebSearch. Google's careers results page
 * is fully server-rendered, so we can fetch + paginate it with plain HTTP
 * (zero tokens, no browser) and get every listing.
 *
 * HARD RULE (modes/_custom.md): a search failure must never be silent. This
 * parser reads Google's own "of {N} rows" total and EXITS NON-ZERO if it
 * cannot reach that count (HTTP error, blocked, markup change, partial
 * pagination). It only prints an empty list when Google itself reports 0 rows.
 * scan.mjs surfaces a non-zero exit under its "Errors" section, and the agent
 * relays it to the user. Never emit [] to paper over a broken fetch.
 *
 * Usage:  node scripts/parsers/google-careers.mjs "<results-page-url>"
 * Output: JSON array of { title, url, company, location } on stdout.
 */

const PAGE_SIZE_HINT = 20;      // Google returns 20 rows/page; used only as a loop guard
const MAX_PAGES = 40;           // safety cap (=> up to 800 roles) so a bug can't loop forever
const FETCH_TIMEOUT_MS = 12_000;
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';

/** Exit loudly so scan.mjs records this source as FAILED (never silent). */
function fail(msg) {
  process.stderr.write(`google-careers: ${msg}\n`);
  process.exit(1);
}

async function fetchPage(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: ctrl.signal,
    });
  } catch (err) {
    fail(`fetch failed for ${url} — ${err.name === 'AbortError' ? `timeout after ${FETCH_TIMEOUT_MS}ms` : err.message}`);
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) fail(`HTTP ${res.status} for ${url}`);
  const html = await res.text();
  if (!html || html.length < 2_000) fail(`suspiciously small body (${html.length} bytes) for ${url} — likely blocked`);
  return html;
}

/** Read the authoritative total Google prints as "… of {N} rows". */
function parseTotal(html) {
  const m = html.match(/of\s+([0-9]+)\s+rows/i);
  return m ? Number(m[1]) : null;
}

/**
 * Extract { url, title } per job. The href and its "Learn more about {title}"
 * aria-label sit on the same <a>, which excludes filter chips like
 * "Learn more about remote eligibility" (their href is not a jobs/results link).
 */
function parseJobs(html, baseUrl) {
  const re =
    /href="([^"]*jobs\/results\/(\d+)-[^"]*?)"[^>]*?aria-label="Learn more about ([^"]+)"/g;
  const out = new Map(); // dedup by numeric job id
  let m;
  while ((m = re.exec(html)) !== null) {
    const [, rawHref, id, rawTitle] = m;
    if (out.has(id)) continue;
    let href;
    try {
      href = new URL(rawHref.replace(/&amp;/g, '&'), baseUrl).href;
    } catch {
      continue;
    }
    const title = rawTitle
      .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      .replace(/&#61;/g, '=').trim();
    if (title) out.set(id, { title, url: href });
  }
  return out;
}

async function main() {
  const base = process.argv[2];
  if (!base) fail('missing results-page URL argument');
  let baseUrl;
  try {
    baseUrl = new URL(base);
  } catch {
    fail(`invalid URL: ${base}`);
  }
  // Location for downstream filtering: the query pins Zurich, so every result is
  // CH-eligible by construction. Read it back from the query for honesty.
  const locParam = baseUrl.searchParams.get('location') || 'Switzerland';

  // Page 1 establishes the authoritative total.
  baseUrl.searchParams.set('page', '1');
  const firstHtml = await fetchPage(baseUrl.href);
  const total = parseTotal(firstHtml);
  if (total === null) {
    fail('could not find "of N rows" total — page structure changed or request was blocked');
  }

  const jobs = new Map();
  for (const [id, job] of parseJobs(firstHtml, baseUrl.href)) jobs.set(id, job);

  if (total === 0) {
    // Genuine zero — legitimate to report an empty list.
    process.stdout.write('[]');
    return;
  }

  // Paginate until we have every row Google claims exist.
  for (let page = 2; jobs.size < total && page <= MAX_PAGES; page++) {
    baseUrl.searchParams.set('page', String(page));
    const html = await fetchPage(baseUrl.href);
    const before = jobs.size;
    for (const [id, job] of parseJobs(html, baseUrl.href)) if (!jobs.has(id)) jobs.set(id, job);
    if (jobs.size === before) break; // page yielded nothing new — stop and let the count check below decide
    if (jobs.size - before < 1 && jobs.size < total) break;
    void PAGE_SIZE_HINT;
  }

  // SELF-VERIFY: partial coverage is a failure, not a clean scan.
  if (jobs.size < total) {
    fail(`partial result: extracted ${jobs.size} of ${total} rows Google reports — pagination or markup failure, refusing to report as complete`);
  }

  const payload = [...jobs.values()].map(j => ({
    title: j.title,
    url: j.url,
    company: 'Google',
    location: locParam.replace(/\+/g, ' '),
  }));
  process.stdout.write(JSON.stringify(payload));
}

main().catch(err => fail(err && err.message ? err.message : String(err)));
