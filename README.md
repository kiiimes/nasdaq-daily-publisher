# Daily Nasdaq Publisher

Public source for the daily.nasdaq.kr card-generation and official Instagram publishing workflow. Uses standard GitHub-hosted runners. Apple system font files are not distributed.

## Repository separation
- This public repository: reviewed source, synthetic offline tests, workflow definitions.
- Private operational repository: encrypted managed-auth session, account-specific baseline, duplicate-publication receipts, generated editions and checkpoint state. Existing private visibility is unchanged.
- Public nasdaq-card-assets repository: approved immutable JPEG card images only.
- Credentials live in GitHub Actions Secrets, never tracked files. Public logs must never contain credentials or private operational file contents.

## Current readiness
**Subscription-based generation and Instagram publication are enabled and verified.**

- Codex 0.166.0 uses a fixed `editorial-models.json` catalog: shell disabled, no apply_patch handler, no experimental tools, direct tool mode, and optional capabilities disabled. `verify_editorial_isolation.py` verifies that only hosted web search is offered and forced shell/file tool calls are rejected, before private state or credentials are restored. Unknown CLI versions are rejected.
- A dedicated ChatGPT subscription login is encrypted in the private state repository. No existing laptop auth cache is reused; API-key authentication is explicitly rejected; usage limits or expired login stop generation rather than switching to paid API billing.
- Live subscription research, fresh KIS crosschecking, Korean composition and card rendering passed in [run 41178256553](https://github.com/kiiimes/nasdaq-daily-publisher/actions/runs/41178256553).
- First real publication passed in [run 41178519010](https://github.com/kiiimes/nasdaq-daily-publisher/actions/runs/41178519010), with the returned account, caption and [Instagram permalink](https://www.instagram.com/p/DfJkbo-m-RU/) verified.
- Local offline regressions: 74 Python tests (Python 3.13/Pillow 13) and 83 Node tests passed.
- Transient read-only KIS failures retry at most three times. An independent quote mismatch permits one new investigation of the same date; a second mismatch stops publication. Unknown facts and failed checks are never filled with guesses.

## Workflows
- `health`: public-source-only offline tests and macOS Python 3.13 / Pillow 13 / AppleSDGothicNeo font check. No private checkout or secrets, zero model/KIS/Meta calls.
- `connections`: checks the private state connection, with no auth decrypt, data collection, generation, media upload or publication. A dry-run push does not update the private repository.
- `editorial`: live subscription research, fresh KIS crosscheck, composition and rendering in a disposable workspace; never publishes or replaces saved editions.
- `render`: explicit one-off rendering of reviewed independently checked private inputs for a specified trade date. No model/provider calls, auth restoration, asset deployment or publication.
- `generate`, `daily`, `publish`: fail-closed gates. Once approved and enabled, schedule is Tuesday-Saturday 07:00 Asia/Seoul, best effort. No automatic historical backfill or date substitution.

### Reposting a deleted post
Open **Run workflow**, keep branch **main**, select **repost**, and enter the US trade date (for example `2026-10-30`) in **trade_date**. This explicitly authorizes another Instagram post for that date; it does not check whether the original Instagram post was deleted.

Repost reuses the stored images, refreshes the caption with 🇺🇸 📊 📈 📉 🇰🇷 section markers, updates the matching ZIP, and retains previous receipts in private publication history. Only previously posted dates are eligible, and the existing 120-hour freshness limit still applies. Uncertain/blocked publications require review. Re-running the same GitHub run cannot authorize a second repost; a new manual dispatch is a separate explicit request. Ordinary `daily` runs continue to skip posted dates. No model or new quote collection is needed for a repost.

Manual **Run workflow** now defaults to `daily` (generate then publish). Choose `health` explicitly for offline checks. The schedule starts the pipeline at 07:00 KST; generation and queue delays mean this is not a guarantee of a 07:00 publication. All three readiness gates are enabled. Subscription limits, expired credentials or failed verification stop the run; there is no paid API fallback.

## Safety boundaries
Runtime source is copied using an explicit allowlist into a separate PRIVATE SSH worktree. State checkpointing rejects any other raw or effective Git fetch/push destination before mutation. Only approved edition files and encrypted auth can be checkpointed. No `git add .`, no workflow artifact uploads, no private state in public history.

Instagram publication requires a durable private preclaim pushed before the first media POST. Ambiguous/cancelled jobs require manual inspection, never an automatic retry. Hard runner termination can interrupt encrypted session refresh persistence.

Only trusted main-branch manual/scheduled jobs can access Secrets. No pull_request_target triggers. Keep authentication, isolation and integration checks passing before changing the enabled production configuration. The previous local card-generation heartbeat was removed after verified GitHub publication to avoid duplicate generation.

## Editorial design v2

New daily/generate editions use the approved navy/white editorial design with a fixed type hierarchy, separate company-name and ticker/business lines, full-width concrete reasons and a daily takeaway outro. Body text never shrinks to fit: overflow fails rendering. Korean company names use the same size across cards. Five cards are the baseline; one source-covered focus card may be inserted before Korea impacts (six total). PNG, JPEG, ZIP, preview, checkpoint and publication all use the same ordered card count. Existing `-five-cards` directory names remain stable for receipt compatibility, including six-card editions.

Research prioritizes familiar US large-cap companies; at most one less familiar exception needs a material market/Korea link. Reasons identify the announcement, period and supported actual/guidance/consensus figures instead of vague sentiment. Named Korean supply links need evidence. Korea impacts distinguish verified business mechanisms from future interpretation without requiring repetitive uncertainty keywords. Focus content requires explicit `focus.0` source coverage. These are editorial instructions and evidence checks, not an automatic guarantee of causal truth.

The Tue–Sat 07:00 KST schedule and manual daily trigger are unchanged. Already-posted editions are not regenerated or reposted by this design update. `repost` continues reusing saved images.
