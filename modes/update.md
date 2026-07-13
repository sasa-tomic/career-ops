# Mode: update — Interactive System Update

When the user runs `/career-ops update` (or asks to update career-ops), execute this interactive update flow.

> **HARD RULE (authoritative in `modes/_custom.md`): update ONLY by rebasing onto upstream. NEVER run `node update-system.mjs apply` / `npm run update`.** `apply` only syncs system-file snapshots and never merges git history, so a checkout with local commits (custom providers, parsers, local fixes/docs) silently keeps diverging even after a "successful" apply; its self-reexec can also break across releases. This mode uses `git rebase` exclusively. `update-system.mjs` is used only for the non-destructive `check` / `dismiss` subcommands.

## Step 1 — Check for Updates

Run `node update-system.mjs check` and parse the JSON output.

- If `up-to-date`: Tell the user "career-ops is up to date (v{version})." and stop.
- If `offline`: Tell the user "Cannot reach GitHub to check for updates. Try again later." and stop.
- If `dismissed`: Tell the user "Update check was previously dismissed. Clearing the dismissal and re-checking now." Remove `.update-dismissed`, then re-run `node update-system.mjs check` and branch on the new status.
- If `no-remote-version`: treat as offline (silent non-failure) and stop.
- If `update-available`: Continue to Step 2.

## Step 2 — Fetch and Show What Changed

```bash
git fetch https://github.com/santifer/career-ops.git main || {
  echo "Failed to fetch latest changes. Cannot generate an accurate diff preview."
  exit 1
}
```

If the fetch fails, stop and tell the user you couldn't preview the changes — don't proceed on a stale `FETCH_HEAD`.

Only if the fetch succeeded, summarize the diff:

```bash
git diff HEAD..FETCH_HEAD --stat -- modes/ AGENTS.md CLAUDE.md *.mjs providers/ scripts/ batch/ dashboard/ templates/ docs/ VERSION DATA_CONTRACT.md
```

Present a concise summary (Modes / Scripts / Providers / Dashboard / Templates / Other file counts + the changelog from Step 1). Note: "Your personal files (cv.md, config/profile.yml, modes/_profile.md, modes/_custom.md, portals.yml, data/, reports/, output/, interview-prep/) will NOT be touched." Show specific diffs with `git diff HEAD..FETCH_HEAD -- {path}` on request.

## Step 3 — Compatibility Check (read-only)

Before rebasing, flag anything that could affect the user's customizations:

1. Read `modes/_profile.md` (if it exists) — strictly read-only here.
2. `git diff HEAD..FETCH_HEAD -- modes/_shared.md`.
3. If the "Archetype Detection" section changed and `_profile.md` references archetype names, warn: "⚠️ Archetypes/scoring were updated; I'll reconcile `_profile.md` after the update."
4. If new mode files exist upstream, mention them.

## Step 4 — Confirm, then Rebase (NEVER apply)

Ask: "Ready to update to v{remote} by rebasing onto upstream. Your local commits and personal files are preserved. Proceed?"

If yes, run the rebase flow (this is the ONLY accepted update mechanism):

1. **Clean tree first.** `git status --porcelain` must be clean. If there are uncommitted tracked changes, commit them (branch/commit as appropriate) or stash — do not rebase over a dirty tree. Untracked personal/ignored files are fine.
2. **Record a recovery point:** `PRE_REBASE=$(git rev-parse HEAD)` (also recoverable via `git reflog`).
3. **Fetch + rebase:**
   ```bash
   git fetch https://github.com/santifer/career-ops.git main
   git rebase FETCH_HEAD
   ```
4. **Resolve conflicts file-by-file** — do NOT `--skip` or blindly pick a side without checking:
   - Keep BOTH upstream improvements AND local features (custom providers, `scripts/parsers/*`, `scripts/full-scan.mjs`, JobSpy, onlyfy, geo-filter, Swiss/CH portals config). When both sides purely ADD independent entries (a script, a provider, a list item), keep both.
   - `git rebase --skip` a local commit ONLY after concretely verifying upstream now ships an equivalent-or-better implementation (e.g. the file exists on `FETCH_HEAD`).
   - Note the structure: upstream keeps doc content in `AGENTS.md` (`CLAUDE.md` is a `@AGENTS.md` pointer). Fold any local doc changes into `AGENTS.md`, not the old monolithic `CLAUDE.md`.
   - Syntax-check every resolved file (`node --check x.mjs`; `node -e "JSON.parse(...)"` for JSON) BEFORE `git add` + `git rebase --continue`.
5. **After the rebase completes:**
   - Register any new local system files (e.g. `scripts/parsers/*.mjs`, new providers) in `update-system.mjs` `SYSTEM_PATHS` (checked by `validate-system-paths-coverage.mjs`).
   - Run `node test-all.mjs`. Fix real regressions; re-run until green (or a failure is confirmed pre-existing/unrelated).
   - Run `node doctor.mjs` to validate setup.
6. If Step 3 flagged archetype/scoring changes, reconcile `modes/_profile.md` against the new `modes/_shared.md`:
   - Compare `git show $PRE_REBASE:modes/_shared.md` vs the new `modes/_shared.md`; classify each `_profile.md` archetype reference as Unchanged / Renamed (single strong fuzzy match) / Removed.
   - Ask before editing `_profile.md`, per change: "references archetype '{old}' which was renamed to '{new}' / removed — update it?" Never batch-edit without per-change consent.
7. Show final status: "✅ Rebased onto v{version}. `node test-all.mjs` green. Run `node doctor.mjs` anytime to verify setup."

If no:
1. Run `node update-system.mjs dismiss`.
2. Tell the user they can run `/career-ops update` anytime.

## Step 5 — Recovery / Rollback (if requested)

Rebase is abortable and reversible:
- **Mid-rebase** (before it completes): `git rebase --abort` restores the pre-rebase state — always safe.
- **After completion:** find the pre-rebase SHA with `git reflog`, confirm with the user, then `git reset --hard <PRE_REBASE_SHA>`.
- Do NOT use `node update-system.mjs rollback` (that undoes the forbidden checkout-based `apply`, which this mode never runs).
- NEVER `git push --force` or rewrite already-pushed history without the user's explicit go-ahead.

## Rules

- **NEVER run `node update-system.mjs apply` / `npm run update`.** Rebase only. (Authoritative HARD RULE: `modes/_custom.md`.)
- NEVER auto-modify User Layer files during update (`cv.md`, `config/profile.yml`, `modes/_profile.md`, `modes/_custom.md`, `data/`, `reports/`, `output/`, `interview-prep/`, `jds/`, `article-digest.md`, `portals.yml`). These are gitignored, so the rebase does not touch them.
- `modes/_profile.md` may be edited **only** in Step 4.6, and **only** after the user confirms each individual rename/removal.
- User-specific customizations (archetypes, scoring weights, narrative) belong in `modes/_profile.md` or `config/profile.yml`; procedural/house rules belong in `modes/_custom.md`; never in `modes/_shared.md`.
- Keep output concise — users don't want walls of text during an update.
