# Multi-repo demo: universe-content-api

This repository is the second half of the Copilot Project demo. The main run of show lives in [virtual-universe-26/demo/DEMO-PROMPTS.md](https://github.com/kevindngo-org/virtual-universe-26/blob/main/demo/DEMO-PROMPTS.md#act-1b--multi-repo-coordination-optional-6-min); this file covers the parts specific to this repo.

**Story:** "Keynote highlights need topic filters on the landing page. The data lives in a separate API repo, so the change spans two repositories. One Project coordinates a session in each repo and hands the API contract to the frontend session."

## Prepared issues
| Issue | Use |
| --- | --- |
| [#1 Support topic filtering and a topics endpoint](https://github.com/kevindngo-org/universe-content-api/issues/1) (`multi-repo`) | API half of the multi-repo moment |
| [virtual-universe-26#11 Load keynote highlights from the content API](https://github.com/kevindngo-org/virtual-universe-26/issues/11) (`multi-repo`) | Frontend half |
| [#2 OpenAPI description](https://github.com/kevindngo-org/universe-content-api/issues/2), [#3 JSON errors](https://github.com/kevindngo-org/universe-content-api/issues/3), [#4 ETag caching](https://github.com/kevindngo-org/universe-content-api/issues/4) (`demo:cloud-agent`) | Spare cloud agent tasks |

## Before the audience arrives
- [ ] The Copilot Project has both `kevindngo-org/virtual-universe-26` and `kevindngo-org/universe-content-api`.
- [ ] `GET /api/highlights?topic=...` still returns all six highlights, and `/api/topics` returns 404 (nothing built yet).
- [ ] `npm test` passes and `npm start` serves http://localhost:3001/api/highlights.

## Multi-repo prompt
```text
Implement keynote highlights with topic filters across both repositories
in this Project:
- universe-content-api #1: add ?topic filtering and GET /api/topics.
- virtual-universe-26 #11: load highlights from the API with topic filters.

Start one coding session per repository. Have the API session finish
first and report the final contract (routes, fields, example responses),
then give that contract to the landing page session as context so it
builds against the real API, not a guess.

Run the API on port 3001, serve docs/ on port 8000, and open the landing
page in a browser canvas. Open one PR in each repository and link them
to each other. Do not merge.
```

*Talk track:* "The Project knows both repositories. It starts a session in each, and each session reads its own repo's instructions. The API session's result becomes context for the frontend session, so the contract is agreed before the UI is written, and I review two linked PRs instead of hoping two teams lined up."

If the frontend session starts before the API contract is ready, say so: "This is where I'd steer the Project," then send it the contract yourself.

## Resetting after the demo
Each repository has its own repo-locked reset command. Run both from their own checkouts:

```sh
node demo/remote-reset.mjs           # Preview; no changes
node demo/remote-reset.mjs --preview-json # Machine-readable preview for the Project reset panel
node demo/remote-reset.mjs --confirm --expected-preview <fingerprint> # Apply only the reviewed plan
node demo/remote-reset.mjs --record  # Replace the baseline after intentional changes
```

It mirrors virtual-universe-26's command: restores `main` to the `demo-baseline` tag, closes post-baseline PRs and deletes their branches, reopens seeded issues and restores assignees, and reopens dismissed alerts if alerts are enabled. It never changes the other repository.

The JSON preview prints only `{version: 1, repo, fingerprint, actions, warnings}`. Bare `--confirm` is rejected: always supply the fingerprint from the reviewed preview. The fingerprint is SHA-256 of the entire preview excluding `fingerprint`, serialized with recursively sorted object keys and preserved array order. The first `verify-state` action exposes the normalized baseline and live action-relevant state (including PR heads, reviews, and review comments); subsequent actions are deterministically ordered, including complete reopen repairs, replacement metadata, and the conditional HTTP 422 reopen fallback. A missing or changed fingerprint is rejected before any reset mutation.

Stop agents and other writers before confirming. Branch creation, update, and deletion use GraphQL `updateRefs` with the repository node ID and atomic `beforeOid`/`afterOid` compare-and-swap; 40 zeroes denote an absent/deleted ref. PR writes check the expected head, using the restored recorded SHA for prepared PRs. PR/issue/alert writes are not transactional, so stopping writers remains necessary. This is a repository-wide demo reset, not a way to preserve unrelated branches or PRs inside this demo repository. Local sessions/worktrees are not changed by this script; the Project panel handles only explicitly selected demo sessions.

Recorded prepared PRs are identified by their recorded number, head repository, and head branch even if their base was changed. Their title, body, base, labels, and draft status are restored. Reviewed/commented prepared PRs are closed and replaced with fresh PRs and new URLs (old review history remains on the closed PR). Merged prepared PRs are also recreated. A replacement preserves the **exact recorded body**, without hidden markers. Its explicitly previewed next step posts a visible "Demo reset replacement receipt" comment on the original PR. The receipt binds repository, original number, replacement number, immutable replacement node ID, seeded head branch/SHA, and creator ID/login. The comment's actual GitHub author must match that replacement creator. The authenticated identity, receipt actions, existing receipt comments, and immutable PR identities are fingerprinted.

Copied hidden markers are ignored. A receipt copied to a different original or replacement, a changed node identity, a mismatched author/creator, or changed seeded head cannot authorize adoption. Unknown **open** same-head candidates and multiple known open replacements block planning for manual inspection; unknown **closed** history is never adopted, reopened, or rewritten. Receipt authorship is authenticated GitHub provenance, not a cryptographic attestation against a replacement creator deliberately forging their own statements. Do not copy or manually fabricate receipts to bypass uncertainty.

The current baseline has no prepared PRs, but fixture tests cover those scenarios. Failures name the failed action/repair and warn that earlier actions may have applied. After a partial failure, preview again and confirm the new fingerprint: a known already-created replacement is reused and unfinished metadata restoration is retried rather than creating duplicate PRs. A lost receipt response is recoverable if the posted receipt is present and verifiable. If creation succeeded but the receipt was not persisted (or the creation response was lost), a new preview stops on the unverified open candidate: inspect its identity and reconcile it manually before another reset. The script will not guess, adopt it by recency, post a fabricated receipt on retry, or create a duplicate. Do not retry with the old fingerprint or record a new baseline to hide an incomplete reset.

Alert reads must succeed. HTTP 403/404 is not treated as an empty result: it can mean insufficient permission, disabled alerts, or an inaccessible endpoint. Resolve the reported feature/access problem before resetting; no successful/complete reset is claimed with unknown alert state. Reopening auto-dismissed alerts may override auto-triage decisions; this warning appears in both preview formats. Fixed alerts require a later CodeQL/Dependabot rescan. GraphQL `updateRefs` and draft-state restoration (`gh pr ready`/`--undo`) require corresponding GitHub authorization, including organization SSO authorization where applicable.

Alert collection never relies on an undocumented default state filter. Code scanning explicitly queries `open`, `closed`, `dismissed`, and `fixed`; Dependabot explicitly queries `open`, `dismissed`, `fixed`, and `auto_dismissed`. Each query follows all pages. Consistent duplicate alert numbers (including overlapping code-scanning `closed` results) are deduplicated; conflicting state/assignee observations, malformed responses, or an error on any page/state abort the preview instead of returning partial alerts.
