#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

export const REPO = "kevindngo-org/universe-content-api";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const STATE_FILE = "demo/demo-state.json";
const TAG = "demo-baseline";
const REMOTE = `https://github.com/${REPO}.git`;

function run(command, args, options = {}) {
    return execFileSync(command, args, {
        cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 32 * 1024 * 1024, ...options,
    }).trim();
}

function api(path, method = "GET", body) {
    const args = ["api", "-X", method, path];
    if (body !== undefined) args.push("--input", "-");
    const output = run("gh", args, body === undefined ? {} : { input: JSON.stringify(body) });
    return output ? JSON.parse(output) : null;
}

export function pages(path, command = run) {
    const result = JSON.parse(command("gh", ["api", "--paginate", "--slurp", path]));
    if (!Array.isArray(result) || !result.every(Array.isArray)) {
        throw new Error(`Invalid paginated list response at ${path}; refusing an incomplete snapshot.`);
    }
    return result.flat();
}

export function alertPages(path, read = pages) {
    try {
        return read(path);
    } catch (error) {
        throw new Error(`Cannot inspect alerts at ${path}; check alert access and feature availability. ` +
            `Refusing an incomplete reset: ${String(error.stderr || error.message).trim()}`, { cause: error });
    }
}

export function collectAlerts(kind, read = pages) {
    const states = kind === "code-scanning" ? ["open", "closed", "dismissed", "fixed"] :
        kind === "dependabot" ? ["open", "dismissed", "fixed", "auto_dismissed"] : undefined;
    if (!states) throw new Error(`Unsupported alert kind: ${kind}`);
    const found = new Map();
    for (const state of states) {
        const path = `repos/${REPO}/${kind}/alerts?state=${state}&per_page=100`;
        const alerts = alertPages(path, read);
        if (!Array.isArray(alerts)) throw new Error(`Invalid alert list at ${path}.`);
        for (const alert of alerts) {
            const allowed = kind === "code-scanning" && state === "closed" ? ["closed", "dismissed", "fixed"] : [state];
            if (!Number.isSafeInteger(alert.number) || alert.number < 1 || !allowed.includes(alert.state) ||
                (alert.assignees !== undefined && (!Array.isArray(alert.assignees) ||
                    !alert.assignees.every((a) => typeof a.login === "string")))) {
                throw new Error(`Invalid or inconsistent ${kind} alert in ${state} response; preview again after stopping writers.`);
            }
            const normalized = {
                number: alert.number, state: alert.state,
                assignees: (alert.assignees || []).map(({ login }) => ({ login }))
                    .sort((a, b) => compareText(a.login, b.login)),
            };
            const prior = found.get(alert.number);
            if (prior && !equal(prior, normalized)) {
                throw new Error(`Inconsistent ${kind} alert #${alert.number} across observations; preview again after stopping writers.`);
            }
            found.set(alert.number, normalized);
        }
    }
    return [...found.values()].sort(byNumber);
}

export function validateState(state) {
    if (state.repo !== REPO || state.version !== 1 || !Array.isArray(state.prs) ||
        !Array.isArray(state.issues) || !state.branches || Array.isArray(state.branches) ||
        typeof state.branches !== "object" || Object.hasOwn(state.branches, "main")) {
        throw new Error("Invalid baseline or wrong repository. Refusing to reset.");
    }
    for (const [name, sha] of Object.entries(state.branches)) {
        if (!name || !/^[a-f0-9]{40}$/.test(sha)) throw new Error(`Invalid baseline branch: ${name}`);
    }
    for (const pr of state.prs) {
        if (!Number.isSafeInteger(pr.number) || !Object.hasOwn(state.branches, pr.head) || pr.base !== "main" ||
            typeof pr.title !== "string" || typeof pr.body !== "string" ||
            typeof pr.draft !== "boolean" || !Array.isArray(pr.labels) ||
            !pr.labels.every((label) => typeof label === "string")) {
            throw new Error(`Seeded PR #${pr.number} must have a recorded head and main base.`);
        }
    }
    for (const issue of state.issues) {
        if (!Number.isSafeInteger(issue.number) || !Array.isArray(issue.assignees) ||
            !issue.assignees.every((login) => typeof login === "string")) {
            throw new Error("Invalid seeded issue or assignees.");
        }
    }
    if (new Set(state.prs.map((pr) => pr.number)).size !== state.prs.length ||
        new Set(state.prs.map((pr) => pr.head)).size !== state.prs.length ||
        new Set(state.issues.map((issue) => issue.number)).size !== state.issues.length) {
        throw new Error("Duplicate prepared PR identity/head or seeded issue in baseline.");
    }
}

const ZERO = "0".repeat(40);
const UPDATE_REFS = "mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }";
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const byNumber = (a, b) => a.number - b.number;
const sortedEntries = (object) => Object.entries(object).sort(([a], [b]) => compareText(a, b));
const branchPath = (name) => name.split("/").map(encodeURIComponent).join("/");
const headMatches = (pr, seed) => pr.head.repo?.full_name === REPO && pr.head.ref === seed.head;
const reviewed = (pr) => Boolean(pr.reviews?.length || pr.reviewComments?.length);
const labelNames = (pr) => pr.labels.map((label) => label.name).sort();
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const marker = (seed, sha) => `<!-- demo-reset:${REPO}:${seed.number}:${sha} -->`;
const replacementBody = (seed, sha) => `${seed.body}\n\n${marker(seed, sha)}`;
const replacementMatches = (pr, seed, sha) => headMatches(pr, seed) && pr.number > seed.number &&
    (pr.body || "").includes(marker(seed, sha));
const prGuard = (pr, sha = pr.head.sha) => ({
    number: pr.number, head: pr.head.ref, repo: pr.head.repo?.full_name ?? null, sha,
});
const requestAction = (label, path, method, body, guard) => ({
    kind: "request", label, path, method, body, ...(guard ? { guard } : {}),
});

function metadataActions(seed, pr, sha, full = false) {
    const prefix = `repos/${REPO}`;
    const actions = [];
    const body = pr.number === seed.number ? seed.body : replacementBody(seed, sha);
    const guard = prGuard(pr, sha);
    if (full || pr.title !== seed.title || (pr.body || "") !== body || pr.base.ref !== seed.base) {
        actions.push(requestAction(`Restore title/body/base on prepared PR #${pr.number}`,
            `${prefix}/pulls/${pr.number}`, "PATCH", { title: seed.title, body, base: seed.base }, guard));
    }
    if (full || !equal(labelNames(pr), [...seed.labels].sort())) {
        actions.push(requestAction(`Restore labels on prepared PR #${pr.number}`,
            `${prefix}/issues/${pr.number}/labels`, "PUT", { labels: [...seed.labels].sort() }, guard));
    }
    if (pr.draft !== seed.draft) {
        actions.push({ kind: "draft-pr", label: `Restore draft status on prepared PR #${pr.number}`,
            number: pr.number, draft: seed.draft, guard });
    }
    return actions;
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort()
        .filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])]));
    return value;
}

function normalizedState(state) {
    return { ...state, branches: Object.fromEntries(sortedEntries(state.branches)),
        prs: [...state.prs].sort(byNumber).map((pr) => ({ ...pr, labels: [...pr.labels].sort() })),
        issues: [...state.issues].sort(byNumber).map((issue) => ({
            ...issue, assignees: [...issue.assignees].sort(),
        })) };
}

export function preview(state, live, baselineSha) {
    const actions = buildPlan(state, live, baselineSha);
    const normalized = {
        baseline: normalizedState(state), baselineSha, repositoryId: live.repositoryId,
        branches: Object.fromEntries(sortedEntries(live.branches)),
        prs: [...live.prs].sort(byNumber).map((pr) => ({
            number: pr.number, state: pr.state, title: pr.title, body: pr.body || "", draft: pr.draft,
            merged_at: pr.merged_at, head: {
                ref: pr.head.ref, sha: pr.head.sha, repo: pr.head.repo?.full_name,
            }, base: { ref: pr.base.ref, sha: pr.base.sha, repo: pr.base.repo?.full_name },
            labels: labelNames(pr),
            reviews: [...pr.reviews].sort((a, b) => a.id - b.id),
            reviewComments: [...pr.reviewComments].sort((a, b) => a.id - b.id),
        })),
        issues: live.issues.filter((issue) => state.issues.some((seed) => seed.number === issue.number))
            .sort(byNumber).map(({ number, state, assignees }) => ({
                number, state, assignees: assignees.map((a) => a.login).sort(),
            })),
        alerts: Object.fromEntries(sortedEntries(live.alerts).map(([kind, alerts]) => [kind,
            [...alerts].sort(byNumber).map(({ number, state, assignees }) => ({
                number, state, assignees: (assignees || []).map((a) => a.login).sort(),
            })),
        ])),
    };
    const payload = {
        version: 1, repo: REPO,
        actions: [{ kind: "verify-state", label: "Verify the complete reviewed reset state", expected: normalized }, ...actions],
        warnings: [
            "Destructive repository-wide demo reset: post-baseline PRs and branches are closed/deleted.",
            "Fixed alerts require a rescan; replacing reviewed prepared PRs creates new URLs but preserves old history.",
            "Reopening auto-dismissed alerts may override auto-triage decisions.",
            "Stop all writers: refs use atomic compare-and-swap, but GitHub PR/issue/alert mutations are not transactional.",
        ],
    };
    return canonical({ ...payload,
        fingerprint: createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex") });
}

export function assertExpectedPreview(plan, expected) {
    if (expected !== plan.fingerprint) {
        throw new Error("Reset plan changed since preview. Preview again and confirm the new fingerprint.");
    }
}

// Pure planning keeps destructive scope and execution ordering testable without GitHub.
export function buildPlan(state, live, baselineSha) {
    validateState(state);
    if (!/^[a-f0-9]{40}$/.test(baselineSha)) throw new Error("Invalid demo-baseline commit.");
    if (typeof live.repositoryId !== "string" || !live.repositoryId) throw new Error("Missing repository node ID.");
    if (Object.values(live.branches).some((sha) => !/^[a-f0-9]{40}$/.test(sha))) {
        throw new Error("Invalid live branch SHA; refusing an incomplete reset.");
    }
    for (const pr of live.prs) {
        if (!/^[a-f0-9]{40}$/.test(pr.head.sha) || !Array.isArray(pr.reviews) || !Array.isArray(pr.reviewComments)) {
            throw new Error(`Missing PR head/review state for #${pr.number}; refusing an incomplete reset.`);
        }
    }
    const actions = [];
    const request = (...args) => actions.push(requestAction(...args));
    const prefix = `repos/${state.repo}`;
    const wanted = { main: baselineSha, ...state.branches };
    const seeds = [...state.prs].sort(byNumber);
    const identities = new Map(seeds.map((seed) => {
        const sha = state.branches[seed.head];
        const original = live.prs.find((pr) => pr.number === seed.number);
        if (original && !headMatches(original, seed)) throw new Error(`Recorded PR #${seed.number} changed identity.`);
        const candidates = live.prs.filter((pr) => headMatches(pr, seed));
        if (candidates.some((pr) => pr !== original && !replacementMatches(pr, seed, sha))) {
            throw new Error(`Ambiguous same-head PR history for prepared PR #${seed.number}; refusing to modify it.`);
        }
        const known = candidates.filter((pr) => pr === original || replacementMatches(pr, seed, sha)).sort(byNumber);
        if (known.filter((pr) => pr.state === "open").length > 1) {
            throw new Error(`Multiple known open prepared PRs for #${seed.number}; review manually.`);
        }
        return [seed.number, known];
    }));
    for (const pr of [...live.prs].sort(byNumber).filter((pr) => pr.state === "open")) {
        if ([...identities.values()].some((known) => known.includes(pr))) continue;
        request(`Close demo-created PR #${pr.number}: ${pr.title}`,
            `${prefix}/pulls/${pr.number}`, "PATCH", { state: "closed" }, prGuard(pr));
    }
    const refUpdate = (label, name, beforeOid, afterOid) => actions.push({
        kind: "ref-update", label, path: "graphql", method: "POST",
        body: { query: UPDATE_REFS, variables: { input: {
            repositoryId: live.repositoryId,
            refUpdates: [{ name: `refs/heads/${name}`, beforeOid, afterOid, force: true }],
        } } },
    });
    for (const [name, sha] of [["main", baselineSha], ...sortedEntries(state.branches)]) {
        const current = live.branches[name] || ZERO;
        if (current !== sha) refUpdate(`${current === ZERO ? "Recreate" : "Restore"} ${name} to ${sha.slice(0, 7)}`,
            name, current, sha);
    }
    // Restore refs first: merged PRs need their original diff before they can be recreated.
    for (const seed of seeds) {
        const sha = state.branches[seed.head];
        const known = identities.get(seed.number);
        const open = known.find((pr) => pr.state === "open");
        if (open && !reviewed(open)) {
            actions.push(...metadataActions(seed, open, sha));
            continue;
        }
        if (open) request(`Close reviewed prepared PR #${open.number} before replacement`,
            `${prefix}/pulls/${open.number}`, "PATCH", { state: "closed" }, prGuard(open, sha));
        const reopenable = known.filter((pr) => pr.state === "closed" && !pr.merged_at && !reviewed(pr));
        const prior = !open && reopenable.length === 1 ? reopenable[0] : undefined;
        const create = requestAction(`Create fresh prepared PR for #${seed.number}`, `${prefix}/pulls`, "POST", {
            head: seed.head, base: seed.base, title: seed.title,
            body: replacementBody(seed, sha), draft: seed.draft,
        });
        const repairs = [requestAction("Restore replacement labels",
            `${prefix}/issues/$created.number/labels`, "PUT", { labels: [...seed.labels].sort() },
            { number: "$created.number", head: seed.head, sha, repo: REPO })];
        actions.push({
            kind: "restore-pr", label: `${prior ? "Reopen" : "Recreate"} seeded PR: ${seed.title}`,
            headGuard: { head: seed.head, sha, repo: REPO },
            ...(prior ? { reopen: {
                action: requestAction(`Reopen prepared PR #${prior.number}`, `${prefix}/pulls/${prior.number}`,
                    "PATCH", { state: "open" }, prGuard(prior, sha)),
                repairs: metadataActions(seed, prior, sha, true),
                onHTTP422: { create, repairs },
            } } : { create, repairs }),
        });
    }
    for (const [name, sha] of sortedEntries(live.branches)) {
        if (Object.hasOwn(wanted, name)) continue;
        refUpdate(`Delete post-baseline branch ${name}`, name, sha, ZERO);
    }
    for (const seed of [...state.issues].sort(byNumber)) {
        const issue = live.issues.find((issue) => issue.number === seed.number);
        if (!issue) throw new Error(`Seeded issue #${seed.number} is missing; refusing partial reset.`);
        if (issue.state !== "open") {
            request(`Reopen issue #${seed.number}`, `${prefix}/issues/${seed.number}`, "PATCH", { state: "open" });
        }
        const current = issue.assignees.map((assignee) => assignee.login).sort();
        const extra = current.filter((login) => !seed.assignees.includes(login));
        const missing = seed.assignees.filter((login) => !current.includes(login)).sort();
        if (extra.length) request(`Unassign ${extra.join(", ")} from issue #${seed.number}`,
            `${prefix}/issues/${seed.number}/assignees`, "DELETE", { assignees: extra });
        if (missing.length) request(`Reassign ${missing.join(", ")} to issue #${seed.number} (may start an agent)`,
            `${prefix}/issues/${seed.number}/assignees`, "POST", { assignees: missing });
    }
    for (const [kind, alerts] of sortedEntries(live.alerts)) {
        for (const alert of [...alerts].sort(byNumber)) {
            if (["dismissed", "auto_dismissed"].includes(alert.state)) {
                request(`Reopen ${kind} alert #${alert.number}`, `${prefix}/${kind}/alerts/${alert.number}`,
                    "PATCH", { state: "open" });
            }
            if (alert.assignees?.length) {
                request(`Clear assignees on ${kind} alert #${alert.number}`, `${prefix}/${kind}/alerts/${alert.number}`,
                    "PATCH", { assignees: [] });
            }
        }
    }
    return actions;
}

export function snapshot(read = pages) {
    const prefix = `repos/${REPO}`;
    return {
        branches: Object.fromEntries(read(`${prefix}/branches?per_page=100`).map((b) => [b.name, b.commit.sha])),
        prs: read(`${prefix}/pulls?state=all&per_page=100`).map((pr) => ({
            ...pr,
            reviews: read(`${prefix}/pulls/${pr.number}/reviews?per_page=100`).map(
                ({ id, state, body, commit_id, submitted_at }) => ({ id, state, body, commit_id, submitted_at })),
            reviewComments: read(`${prefix}/pulls/${pr.number}/comments?per_page=100`).map(
                ({ id, body, updated_at, commit_id }) => ({ id, body, updated_at, commit_id })),
        })),
        issues: read(`${prefix}/issues?state=all&per_page=100`).filter((issue) => !issue.pull_request),
        alerts: {
            "code-scanning": collectAlerts("code-scanning", read),
            dependabot: collectAlerts("dependabot", read),
        },
    };
}

export function execute(action, request = api, command = run, log = console.log) {
    if (action.kind === "verify-state") return;
    if (action.guard) {
        const pr = request(`repos/${REPO}/pulls/${action.guard.number}`);
        const actual = prGuard(pr);
        if (!equal(actual, action.guard)) throw new Error(`PR head changed since preview: ${action.label}.`);
    }
    if (action.kind === "ref-update") {
        const result = request(action.path, action.method, action.body);
        if (result?.errors?.length || !result?.data?.updateRefs) {
            throw new Error(`Atomic ref update rejected: ${JSON.stringify(result?.errors || result)}.`);
        }
        return;
    }
    if (action.kind === "request") {
        request(action.path, action.method, action.body);
        return;
    }
    if (action.kind === "draft-pr") {
        command("gh", ["pr", "ready", String(action.number), "--repo", REPO, ...(action.draft ? ["--undo"] : [])]);
        return;
    }
    if (action.kind !== "restore-pr") throw new Error(`Unknown reset action: ${action.kind}`);
    const ref = request(`repos/${REPO}/git/ref/heads/${branchPath(action.headGuard.head)}`);
    if (ref.object.sha !== action.headGuard.sha) {
        throw new Error(`Prepared branch changed since restoration: ${action.headGuard.head}.`);
    }
    let creation = action;
    if (action.reopen) {
        let fallback = false;
        // Only a 422 from the reopen request selects the explicitly previewed fallback.
        // Guard or repair failures must never create a second PR.
        const { guard, ...reopen } = action.reopen.action;
        const current = request(`repos/${REPO}/pulls/${guard.number}`);
        if (!equal(prGuard(current), guard)) throw new Error(`PR head changed since preview: ${reopen.label}.`);
        try {
            execute(reopen, request, command, log);
        } catch (error) {
            if (!String(error.stderr).includes("HTTP 422")) throw error;
            fallback = true;
            log(`  GitHub refused reopening #${guard.number}; using the previewed replacement fallback.`);
        }
        if (!fallback) {
            for (const update of action.reopen.repairs) executeRepair(update, request, command, log);
            return;
        }
        creation = action.reopen.onHTTP422;
    }
    const created = request(creation.create.path, creation.create.method, creation.create.body);
    if (!Number.isSafeInteger(created?.number) || !created?.html_url) {
        throw new Error("Missing replacement PR response. Creation may have applied; preview again before retrying.");
    }
    log(`  Seeded PR replacement: ${created.html_url}`);
    for (const repair of creation.repairs) executeRepair({
        ...repair, path: repair.path.replace("$created.number", String(created.number)),
        guard: { ...repair.guard, number: created.number },
    }, request, command, log);
}

function executeRepair(action, request, command, log) {
    try {
        execute(action, request, command, log);
    } catch (error) {
        throw new Error(`Failed repair "${action.label}": ${String(error.stderr || error.message).trim()}`, { cause: error });
    }
}

function record() {
    if (run("git", ["status", "--porcelain"])) throw new Error("--record requires a clean working tree and index.");
    const live = snapshot();
    const head = run("git", ["rev-parse", "HEAD"]);
    if (head !== live.branches.main) throw new Error("Land changes on remote main first; local HEAD must equal remote main.");
    if (live.prs.some((pr) => pr.state === "open" && pr.head.repo?.full_name !== REPO)) {
        throw new Error("Cannot record PRs from other repositories; baseline heads must belong to this demo fork.");
    }
    const state = {
        version: 1, repo: REPO,
        branches: Object.fromEntries(Object.entries(live.branches).filter(([name]) => name !== "main")),
        prs: live.prs.filter((pr) => pr.state === "open").map((pr) => ({
            number: pr.number, head: pr.head.ref, base: pr.base.ref, title: pr.title,
            body: pr.body || "", draft: pr.draft, labels: pr.labels.map((label) => label.name),
        })),
        issues: live.issues.filter((issue) => issue.state === "open").map((issue) => ({
            number: issue.number, assignees: issue.assignees.map((assignee) => assignee.login),
        })),
    };
    validateState(state);
    const content = `${JSON.stringify(state, null, 2)}\n`;
    const tracked = run("git", ["ls-files", STATE_FILE]);
    if (!tracked || readFileSync(resolve(ROOT, STATE_FILE), "utf8") !== content) {
        writeFileSync(resolve(ROOT, STATE_FILE), content);
        run("git", ["add", "--", STATE_FILE]);
        run("git", ["commit", "--only", "-m",
            "Record demo reset baseline\n\nCo-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>",
            "--", STATE_FILE]);
    }
    run("git", ["push", `--force-with-lease=refs/heads/main:${head}`, REMOTE, "HEAD:refs/heads/main"]);
    const sha = run("git", ["rev-parse", "HEAD"]);
    if (api(`repos/${REPO}/git/ref/heads/main`).object.sha !== sha) {
        throw new Error("Remote main changed while recording; refusing to move demo-baseline.");
    }
    const tags = pages(`repos/${REPO}/git/matching-refs/tags/${TAG}`);
    const tag = tags.find((ref) => ref.ref === `refs/tags/${TAG}`);
    if (tag) {
        api(`repos/${REPO}/git/refs/tags/${TAG}`, "PATCH", { sha, force: true });
    } else {
        api(`repos/${REPO}/git/refs`, "POST", { ref: `refs/tags/${TAG}`, sha });
    }
    console.log(`Recorded ${state.prs.length} PRs, ${Object.keys(state.branches).length} seeded branches, ` +
        `${state.issues.length} issues. ${TAG} -> ${sha}`);
}

export function main(args = process.argv.slice(2), {
    request = api, readSnapshot = snapshot,
    readState = () => JSON.parse(readFileSync(resolve(ROOT, STATE_FILE), "utf8")),
    apply = execute, log = console.log,
} = {}) {
    const index = args.indexOf("--expected-preview");
    const expected = index === -1 ? undefined : args[index + 1];
    const flags = args.filter((_, i) => i !== index && (index === -1 || i !== index + 1));
    if ((flags.includes("--confirm") && index === -1) ||
        (index !== -1 && (!/^[a-f0-9]{64}$/.test(expected || "") || !flags.includes("--confirm"))) ||
        flags.some((arg) => !["--confirm", "--record", "--help", "--preview-json"].includes(arg)) ||
        new Set(flags).size !== flags.length ||
        (flags.includes("--record") && flags.length !== 1) ||
        (flags.includes("--preview-json") && flags.length !== 1)) {
        throw new Error("Use preview, --preview-json, --confirm --expected-preview <sha256>, or --record.");
    }
    if (args.includes("--help")) {
        log("node demo/remote-reset.mjs [--preview-json | --confirm --expected-preview <sha256> | --record]\n" +
            "Preview by default. --confirm resets remote demo state. --record commits/pushes a new baseline and moves demo-baseline.");
        return;
    }
    const repo = request(`repos/${REPO}`);
    if (repo.full_name !== REPO || repo.default_branch !== "main" || !repo.permissions?.push) {
        throw new Error(`Expected write access to ${REPO} with default branch main.`);
    }
    if (args.includes("--record")) return record();
    const state = readState();
    validateState(state);
    const tag = request(`repos/${REPO}/git/ref/tags/${TAG}`);
    if (tag.object.type !== "commit") throw new Error("Expected a lightweight demo-baseline tag pointing to a commit.");
    const recorded = request(`repos/${REPO}/contents/${STATE_FILE}?ref=${tag.object.sha}`);
    const remoteState = JSON.parse(Buffer.from(recorded.content, "base64").toString("utf8"));
    if (JSON.stringify(state) !== JSON.stringify(remoteState)) {
        throw new Error("Local baseline differs from demo-baseline. Update this checkout before resetting.");
    }
    const live = () => ({ ...readSnapshot(), repositoryId: repo.node_id });
    const plan = preview(state, live(), tag.object.sha);
    if (args.includes("--preview-json")) {
        log(JSON.stringify(plan));
        return;
    }
    const confirm = args.includes("--confirm");
    if (confirm) assertExpectedPreview(plan, expected);
    const { actions } = plan;
    log(`${confirm ? "Resetting" : "Preview (no changes) for"} ${REPO}:`);
    for (const warning of plan.warnings) log(`Warning: ${warning}`);
    if (actions.length === 1) log("Already at baseline. Nothing to do.");
    for (const action of actions) {
        log(`- ${action.label}`);
        if (confirm) {
            try {
                apply(action);
            } catch (error) {
                throw new Error(`Failed action "${action.label}". Earlier actions may have applied. ` +
                    `Preview again and confirm the new fingerprint before retrying. ` +
                    String(error.stderr || error.message).trim(), { cause: error });
            }
        }
    }
    if (!confirm) log(`Run with --confirm --expected-preview ${plan.fingerprint} to apply this destructive remote reset.`);
    if (confirm) {
        let remaining;
        try {
            remaining = buildPlan(state, live(), tag.object.sha);
        } catch (error) {
            throw new Error(`Post-reset verification failed; earlier actions may have applied. Preview again before retrying. ` +
                String(error.stderr || error.message).trim(), { cause: error });
        }
        if (remaining.length) throw new Error(`Reset incomplete; earlier actions may have applied. ` +
            `Preview again and confirm the new fingerprint:\n${remaining.map((a) => a.label).join("\n")}`);
        log("Remote reset verified. Local worktrees were not changed.");
        log("Fixed alerts require a rescan; replaced prepared PRs have new URLs and old history remains.");
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        main();
    } catch (error) {
        console.error(`Reset failed: ${String(error.stderr || error.message).trim()}`);
        process.exitCode = 1;
    }
}
