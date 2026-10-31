# Daily Nasdaq Publisher

Public source for the daily.nasdaq.kr card-generation and official Instagram publishing workflow. Uses standard GitHub-hosted runners. Apple system font files are not distributed.

## Repository separation
- This public repository: reviewed source, synthetic offline tests, workflow definitions.
- Private operational repository: encrypted managed-auth session, account-specific baseline, duplicate-publication receipts, generated editions and checkpoint state. Existing private visibility is unchanged.
- Public nasdaq-card-assets repository: approved immutable JPEG card images only.
- Credentials live in GitHub Actions Secrets, never tracked files. Public logs must never contain credentials or private operational file contents.

## Current readiness
**Subscription authentication and isolated model execution are configured. Publication remains disabled until the complete generation and posting checks pass.**

- Codex 0.166.0 uses a fixed `editorial-models.json` catalog: shell disabled, no apply_patch handler, no experimental tools, direct tool mode, and optional capabilities disabled. `verify_editorial_isolation.py` verifies that only hosted web search is offered and forced shell/file tool calls are rejected, before private state or credentials are restored. Unknown CLI versions are rejected.
- A dedicated ChatGPT subscription login is encrypted in the private state repository. No existing laptop auth cache is reused; API-key authentication is explicitly rejected; usage limits or expired login stop generation rather than switching to paid API billing.
- Instagram account identity and publishing-limit access have been verified; an end-to-end test is pending. A passing environment or SSH-connection test is not a successful generation or Instagram publication.

## Workflows
- `health`: public-source-only offline tests and macOS Python 3.13 / Pillow 13 / AppleSDGothicNeo font check. No private checkout or secrets, zero model/KIS/Meta calls.
- `connections`: checks the private state connection, with no auth decrypt, data collection, generation, media upload or publication. A dry-run push does not update the private repository.
- `editorial`: live subscription research, fresh KIS crosscheck, composition and rendering in a disposable workspace; never publishes or replaces saved editions.
- `render`: explicit one-off rendering of reviewed independently checked private inputs for a specified trade date. No model/provider calls, auth restoration, asset deployment or publication.
- `generate`, `daily`, `publish`: fail-closed gates. Once approved and enabled, schedule is Tuesday-Saturday 07:00 Asia/Seoul, best effort. No automatic historical backfill or date substitution.

Manual **Run workflow** now defaults to `daily` (generate then publish). Choose `health` explicitly for offline checks. The schedule starts the pipeline at 07:00 KST; generation and queue delays mean this is not a guarantee of a 07:00 publication. Existing readiness gates remain enforced.

## Safety boundaries
Runtime source is copied using an explicit allowlist into a separate PRIVATE SSH worktree. State checkpointing rejects any other raw or effective Git fetch/push destination before mutation. Only approved edition files and encrypted auth can be checkpointed. No `git add .`, no workflow artifact uploads, no private state in public history.

Instagram publication requires a durable private preclaim pushed before the first media POST. Ambiguous/cancelled jobs require manual inspection, never an automatic retry. Hard runner termination can interrupt encrypted session refresh persistence.

Only trusted main-branch manual/scheduled jobs can access Secrets. No pull_request_target triggers. Do not enable generation or publication until all authentication, isolation and integration checks pass.
