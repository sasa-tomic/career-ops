# Zurich quickstart (systems & infrastructure)

Get from a fresh clone to a scanned, filtered Zurich job list in a few minutes.
Written for a senior systems / infrastructure / reliability / storage engineer.

## 1. Get the repo

```bash
git clone https://github.com/sasa-tomic/career-ops.git
cd career-ops
npm install
```

## 2. Use the Zurich systems config

```bash
cp templates/portals.zurich-systems.example.yml portals.yml
```

This ships with a Switzerland-focused `location_filter` and a `title_filter`
tuned for distributed systems, reliability/SRE, platform, storage, HPC,
performance, and research-engineer roles. It also includes a starter set of
verified Swiss Greenhouse, Ashby, Lever, Workday, and onlyfy boards. Edit
`title_filter.positive` to match the exact titles you want.

## 3. Find the NVIDIA Switzerland facet id (one time)

NVIDIA's Zurich AI lab runs on Workday. To scope its board to Switzerland, fill
in the location facet id in `portals.yml`. Get it with one call and read the
`facets` array (descriptor to id):

```bash
curl -s -X POST \
  'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs' \
  -H 'Content-Type: application/json' \
  --data '{"appliedFacets":{},"limit":1,"offset":0,"searchText":""}' \
| node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);const walk=o=>{if(Array.isArray(o))o.forEach(walk);else if(o&&typeof o=="object"){if(o.descriptor&&/switzerland/i.test(o.descriptor))console.log(o.id,o.descriptor,o.count);for(const k in o)walk(o[k])}};walk(j)})'
```

Paste the id (the one labelled plain "Switzerland") into the
`workday.facets.locationHierarchy1` list in `portals.yml`. The same approach
works for any Workday employer: swap the tenant and site in the URL.

## 4. Add more companies

The scanner auto-detects the ATS from each `careers_url`:

- `*.greenhouse.io`, `*.ashbyhq.com`, `*.lever.co` need no extra config.
- `*.myworkdayjobs.com` needs `provider: workday` (see the NVIDIA entry).
- `*.onlyfy.jobs` is auto-detected; use `provider: onlyfy` when you want to be explicit.

The larger `templates/portals.example.yml` already lists 100+ companies with
verified mappings, so copy any that interest you. Big-tech Zurich offices
(Google, Amazon, Apple, Oracle, Meta) use bespoke ATSes, but their careers
pages/APIs are scrapable zero-token via the `scan_method: local_parser` entries
in this template that wire `scripts/parsers/*-careers.mjs` (each hard-fails if it
can't match the site's own result count). Microsoft's API is TLS-blocked in some
environments, so it stays a flagged websearch handoff until reachable.

## 5. Scan and evaluate

```bash
node scan.mjs            # zero-token: hits ATS APIs directly
```

New roles land in `data/pipeline.md`. Paste any job URL into your AI CLI to get
a full A to G evaluation, or run `/career-ops pipeline` to process the inbox.

## 6. Reading Swiss offers

See [switzerland-comp-and-employment.md](switzerland-comp-and-employment.md)
for the Swiss-specific mechanics: x13 salary, AHV/Pillar deductions,
Quellensteuer, permits, notice periods, and what comp to expect.

## What stays private

Your CV, profile, tracker, reports, and generated PDFs live in user-layer files
(`cv.md`, `config/profile.yml`, `data/*`, `reports/*`, `output/*`) that are
gitignored. They are never committed, so a public fork stays free of personal
data.
