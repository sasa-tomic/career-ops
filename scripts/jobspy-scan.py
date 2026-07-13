#!/usr/bin/env python3
"""jobspy-scan.py — zero-token board discovery for career-ops.

Reads a JSON config from stdin, runs python-jobspy over the requested
sites x search_terms x locations, dedups by job_url, and writes a single JSON
document {"jobs": [...], "meta": {...}, "errors": [...]} to stdout.

Spawned by jobspy-scan.mjs. Exit codes:
  0  success (per-query failures are reported in "errors", not fatal)
  2  bad/empty config on stdin
  3  python-jobspy not importable (tells the caller to pip install)
"""
import sys
import json


def fail(msg, code):
    sys.stderr.write(msg + "\n")
    sys.exit(code)


def cell(row, col):
    """Return a JSON-safe scalar for a DataFrame cell, or None when missing/NaN."""
    try:
        import pandas as pd
        v = row.get(col)
        if v is None or (not isinstance(v, (list, dict)) and pd.isna(v)):
            return None
        return v
    except Exception:
        return None


def main():
    raw = sys.stdin.read()
    try:
        cfg = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as e:
        fail(f"jobspy-scan: invalid JSON config on stdin: {e}", 2)

    try:
        from jobspy import scrape_jobs
    except Exception as e:  # ImportError or a broken transitive dependency
        fail(f"jobspy-scan: cannot import jobspy ({e}). Install: pip install python-jobspy", 3)

    # JobSpy's Country.from_string raises on micro-states it doesn't enumerate
    # (e.g. Liechtenstein, which shows up in Zurich-area LinkedIn results) and
    # that aborts the entire LinkedIn query. Fall back to WORLDWIDE for any
    # unknown country so one border-region posting can't drop a whole query.
    try:
        from jobspy.model import Country
        _orig_from_string = Country.from_string.__func__

        def _safe_from_string(cls, country_str):
            try:
                return _orig_from_string(cls, country_str)
            except ValueError:
                return Country.WORLDWIDE

        Country.from_string = classmethod(_safe_from_string)
    except Exception:
        pass  # best-effort hardening — never block the scan if JobSpy's API shifts

    sites = cfg.get("sites") or ["indeed", "google", "glassdoor"]
    terms = [t for t in (cfg.get("search_terms") or []) if isinstance(t, str) and t.strip()]
    locations = cfg.get("locations") or [""]
    results_wanted = int(cfg.get("results_wanted", 20))
    hours_old = cfg.get("hours_old")
    hours_old = int(hours_old) if hours_old is not None else None
    country_indeed = cfg.get("country_indeed") or "Switzerland"
    linkedin_fetch_description = bool(cfg.get("linkedin_fetch_description", False))

    if not terms:
        fail("jobspy-scan: config.search_terms is empty", 2)

    seen = set()
    jobs = []
    errors = []
    raw_count = 0

    for term in terms:
        for loc in locations:
            try:
                df = scrape_jobs(
                    site_name=sites,
                    search_term=term,
                    google_search_term=f"{term} jobs near {loc}".strip(),
                    location=(loc or None),
                    results_wanted=results_wanted,
                    hours_old=hours_old,
                    country_indeed=country_indeed,
                    linkedin_fetch_description=linkedin_fetch_description,
                    verbose=0,
                )
            except Exception as e:
                errors.append({"term": term, "location": loc, "message": f"{type(e).__name__}: {e}"})
                continue

            if df is None or len(df) == 0:
                continue
            raw_count += len(df)

            for _, row in df.iterrows():
                url = cell(row, "job_url")
                if not isinstance(url, str) or not url or url in seen:
                    continue
                seen.add(url)
                date_posted = cell(row, "date_posted")
                jobs.append({
                    "title": cell(row, "title") or "",
                    "company": cell(row, "company") or "",
                    "location": cell(row, "location") or "",
                    "url": url,
                    "site": cell(row, "site") or "",
                    "date_posted": str(date_posted) if date_posted is not None else None,
                    "min_amount": cell(row, "min_amount"),
                    "max_amount": cell(row, "max_amount"),
                    "currency": cell(row, "currency"),
                })

    out = {
        "jobs": jobs,
        "meta": {
            "sites": sites,
            "terms": len(terms),
            "locations": len(locations),
            "raw_count": raw_count,
            "deduped_count": len(jobs),
            "hours_old": hours_old,
        },
        "errors": errors,
    }
    # default=str coerces numpy scalars / Timestamps that slipped through cell().
    sys.stdout.write(json.dumps(out, default=str))


if __name__ == "__main__":
    main()
