// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// onlyfy.jobs provider — scrapes the server-rendered careers listing.
// onlyfy.jobs (a Prescreen.io product) is a Next.js App Router site whose job
// data is fully server-rendered in HTML; there is no public JSON API (the
// data is fetched server-side by React server components). We therefore parse
// the rendered DOM, which exposes stable `data-testid` attributes.
//
// Auto-detects from careers_url pattern `https://<slug>.onlyfy.jobs/<locale>`.
// Per-tenant subdomains are the variable part — SSRF defence uses a regex
// match on `<safe-slug>.onlyfy.jobs` rather than a static allowlist, mirroring
// the recruitee provider.

const ONLYFY_HOST_RE = /^[a-z0-9][a-z0-9-]*\.onlyfy\.jobs$/;
const ONLYFY_MAX_PAGES = 50;  // safety cap (~500 postings @ 10/page)
const DEFAULT_LOCALE = 'de';
const LOCALE_RE = /^[a-z]{2}(-[a-z0-9]+)?$/i;  // e.g. de, en, fr, pt-BR

function assertOnlyfyUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`onlyfy: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`onlyfy: URL must use HTTPS: ${url}`);
  if (!ONLYFY_HOST_RE.test(parsed.hostname)) {
    throw new Error(`onlyfy: untrusted hostname "${parsed.hostname}" — must match <slug>.onlyfy.jobs`);
  }
  return url;
}

function resolveListingBase(entry) {
  const raw = typeof entry.careers_url === 'string' ? entry.careers_url : '';
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (!ONLYFY_HOST_RE.test(parsed.hostname)) return null;
  // Locale = first path segment (e.g. /de). Falls back to 'de' when absent or
  // when the URL points straight at a /job/ posting (not a listing page).
  const segs = parsed.pathname.split('/').filter(Boolean);
  let locale = DEFAULT_LOCALE;
  if (segs.length > 0 && segs[0] !== 'job' && LOCALE_RE.test(segs[0])) locale = segs[0];
  return { origin: `https://${parsed.hostname}`, hostname: parsed.hostname, locale };
}

function buildListingUrl(base, page) {
  return `${base.origin}/${base.locale}?page=${page}`;
}

/** @type {Provider} */
export default {
  id: 'onlyfy',

  detect(entry) {
    const base = resolveListingBase(entry);
    return base ? { url: buildListingUrl(base, 1) } : null;
  },

  async fetch(entry, ctx) {
    const base = resolveListingBase(entry);
    if (!base) throw new Error(`onlyfy: cannot derive listing URL for ${entry.name}`);

    const all = [];
    for (let page = 1; page <= ONLYFY_MAX_PAGES; page++) {
      const pageUrl = buildListingUrl(base, page);
      assertOnlyfyUrl(pageUrl);
      // onlyfy.jobs signals an exhausted listing by 307-redirecting to the
      // locale root (e.g. /de) instead of rendering an empty page. We use
      // redirect:'manual' and treat any 3xx as "end of listing". The redirect
      // is never FOLLOWED, so a redirect to an off-domain host cannot be an
      // SSRF vector — and the request URL itself is already host-validated by
      // assertOnlyfyUrl above. ctx.fetchText throws on non-2xx (incl. 3xx,
      // since res.ok is false for redirects), carrying err.status — so a 3xx
      // surfaces here as a thrown error we break on.
      let html;
      try {
        html = await ctx.fetchText(pageUrl, { redirect: 'manual' });
      } catch (err) {
        if (err && typeof err.status === 'number' && err.status >= 300 && err.status < 400) {
          break;  // redirect ⇒ listing exhausted
        }
        throw err;  // network error / 4xx / 5xx — surface to caller
      }
      const parsed = parseOnlyfyHtml(html, `${base.origin}/${base.locale}`, entry.name);
      if (parsed.length === 0) break;  // defensive: empty 200 page ⇒ listing exhausted
      all.push(...parsed);
    }
    return all;
  },
};

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(s) {
  return s.replace(/<[^>]*>/g, '');
}

/**
 * Parse the server-rendered onlyfy.jobs careers HTML. Exported for unit tests.
 *
 * The rendered DOM exposes stable `data-testid` attributes per job card:
 *   <a data-testid="job-card" aria-label="{TITLE}" href="/<locale>/job/{id}">
 *     <h3 data-testid="job-title">{TITLE}</h3>
 *     <div data-testid="job-more-info">{CITY} | {TYPE} | {DATE}</div>
 *   </a>
 *
 * Pagination uses `?page=N`; each full page renders 10 cards, the last page
 * renders the remainder, and a page past the end renders zero cards.
 *
 * - url: href (relative) resolved against the listing base; must land on the
 *   same `<slug>.onlyfy.jobs` host over HTTPS with a `/job/` path, else dropped.
 * - title: prefer the anchor's `aria-label` (a clean attribute value); fall
 *   back to the `job-title` h3 text when aria-label is absent.
 * - location: city = the segment before the first "|" in `job-more-info`.
 *
 * @param {string} html
 * @param {string} baseUrl  absolute listing base, e.g. https://<host>/<locale>
 * @param {string} companyName
 * @returns {Array<{title: string, url: string, company: string, location: string}>}
 */
export function parseOnlyfyHtml(html, baseUrl, companyName) {
  if (typeof html !== 'string' || !html) return [];
  const jobs = [];
  const cardRe = /<a\b[^>]*\bdata-testid="job-card"[^>]*>/gi;
  const matches = [...html.matchAll(cardRe)];
  for (let i = 0; i < matches.length; i++) {
    const openTag = matches[i][0];
    const startIdx = matches[i].index ?? 0;
    // Window from this card's open tag up to the next card's (or end of doc)
    // — enough context to capture this card's nested title / more-info nodes.
    const endIdx = i + 1 < matches.length ? (matches[i + 1].index ?? html.length) : html.length;
    const block = html.slice(startIdx, endIdx);

    const hrefMatch = openTag.match(/\bhref="([^"]*)"/i);
    if (!hrefMatch) continue;
    const hrefRaw = decodeEntities(hrefMatch[1]);

    let url = '';
    try {
      const abs = new URL(hrefRaw, baseUrl);
      if (abs.protocol === 'https:'
          && ONLYFY_HOST_RE.test(abs.hostname)
          && abs.pathname.includes('/job/')) {
        url = abs.href;
      }
    } catch {
      // malformed href → drop
    }
    if (!url) continue;

    let title = '';
    const ariaMatch = openTag.match(/\baria-label="([^"]*)"/i);
    if (ariaMatch) title = decodeEntities(ariaMatch[1]).trim();
    if (!title) {
      const titleMatch = block.match(/<h3\b[^>]*\bdata-testid="job-title"[^>]*>([\s\S]*?)<\/h3>/i);
      if (titleMatch) title = decodeEntities(stripTags(titleMatch[1])).trim();
    }
    if (!title) continue;

    let location = '';
    const moreInfoMatch = block.match(/<div\b[^>]*\bdata-testid="job-more-info"[^>]*>([\s\S]*?)<\/div>/i);
    if (moreInfoMatch) {
      const raw = decodeEntities(stripTags(moreInfoMatch[1]));
      location = raw.split('|')[0].trim();
    }

    jobs.push({ title, url, location, company: companyName });
  }
  return jobs;
}
