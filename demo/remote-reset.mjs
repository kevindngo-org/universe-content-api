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

function pages(path) {
    return JSON.parse(run("gh", ["api", "--paginate", "--slurp", path])).flat();
}

export function alertPages(path, read = pages) {
    try {
        return read(path);
    } catch (error) {
        throw new Error(`Cannot inspect alerts at ${path}; check alert access and feature availability. ` +
            `Refusing an incomplete reset: ${String(error.stderr || error.message).trim()}`, { cause: error });
    }
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
}

const samePR = (pr, seed, repo) =>
    pr.head.repo?.full_name === repo && pr.head.ref === seed.head && pr.base.ref === seed.base;

const reviewed = (pr) => Boolean(pr.reviews?.length || pr.reviewComments?.length);
const labelNames = (pr) => pr.labels.map((label) => label.name).sort();
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function metadataActions(seed, pr) {
    const prefix = `repos/${REPO}`;
    const actions = [];
    if (pr.title !== seed.title || (pr.body || "") !== seed.body) {
        actions.push({ kind: "request", label: `Restore title/body on prepared PR #${pr.number}`,
            path: `${prefix}/pulls/${pr.number}`, method: "PATCH", body: { title: seed.title, body: seed.body } });
    }
    if (!equal(labelNames(pr), [...seed.labels].sort())) {
        actions.push({ kind: "request", label: `Restore labels on prepared PR #${pr.number}`,
            path: `${prefix}/issues/${pr.number}/labels`, method: "PUT", body: { labels: seed.labels } });
    }
    if (pr.draft !== seed.draft) {
        actions.push({ kind: "draft-pr", label: `Restore draft status on prepared PR #${pr.number}`,
            number: pr.number, draft: seed.draft });
    }
    return actions;
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical).sort((a, b) => {
        const left = JSON.stringify(a), right = JSON.stringify(b);
        return left < right ? -1 : left > right ? 1 : 0;
    });
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort()
        .filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])]));
    return value;
}

export function preview(state, live, baselineSha) {
    const actions = buildPlan(state, live, baselineSha);
    const normalized = {
        state, baselineSha, branches: live.branches,
        prs: live.prs.map((pr) => ({
            number: pr.number, state: pr.state, title: pr.title, body: pr.body || "", draft: pr.draft,
            merged_at: pr.merged_at, head: {
                ref: pr.head.ref, sha: pr.head.sha, repo: pr.head.repo?.full_name,
            }, base: { ref: pr.base.ref, sha: pr.base.sha, repo: pr.base.repo?.full_name },
            labels: labelNames(pr), reviews: pr.reviews, reviewComments: pr.reviewComments,
        })),
        issues: live.issues.filter((issue) => state.issues.some((seed) => seed.number === issue.number))
            .map(({ number, state, assignees }) => ({ number, state, assignees: assignees.map((a) => a.login) })),
        alerts: Object.fromEntries(Object.entries(live.alerts).map(([kind, alerts]) => [kind,
            alerts.map(({ number, state, assignees }) => ({
                number, state, assignees: (assignees || []).map((a) => a.login),
            })),
        ])),
    };
    return {
        version: 1, repo: REPO,
        fingerprint: createHash("sha256").update(JSON.stringify(canonical(normalized))).digest("hex"),
        actions,
        warnings: [
            "Destructive repository-wide demo reset: post-baseline PRs and branches are closed/deleted.",
            "Fixed alerts require a rescan; replacing reviewed prepared PRs creates new URLs but preserves old history.",
        ],
    };
}

export function assertExpectedPreview(plan, expected) {
    if (expected !== undefined && expected !== plan.fingerprint) {
        throw new Error("Reset plan changed since preview. Preview again and confirm the new fingerprint.");
    }
}

// Pure planning keeps destructive scope and execution ordering testable without GitHub.
export function buildPlan(state, live, baselineSha) {
    validateState(state);
    if (!/^[a-f0-9]{40}$/.test(baselineSha)) throw new Error("Invalid demo-baseline commit.");
    const actions = [];
    const request = (label, path, method, body, guard) =>
        actions.push({ kind: "request", label, path, method, body, ...(guard ? { guard } : {}) });
    const prefix = `repos/${state.repo}`;
    const wanted = { main: baselineSha, ...state.branches };
    for (const pr of live.prs.filter((pr) => pr.state === "open")) {
        if (state.prs.some((seed) => samePR(pr, seed, state.repo))) continue;
        request(`Close demo-created PR #${pr.number}: ${pr.title}`,
            `${prefix}/pulls/${pr.number}`, "PATCH", { state: "closed" });
    }
    for (const [name, sha] of Object.entries(wanted)) {
        const current = live.branches[name];
        if (!current) {
            request(`Recreate branch ${name} at ${sha.slice(0, 7)}`,
                `${prefix}/git/refs`, "POST", { ref: `refs/heads/${name}`, sha });
        } else if (current !== sha) {
            request(`Restore ${name} to ${sha.slice(0, 7)} (was ${current.slice(0, 7)})`,
                `${prefix}/git/refs/heads/${name}`, "PATCH", { sha, force: true }, current);
        }
    }
    // Restore refs first: merged PRs need their original diff before they can be recreated.
    for (const seed of state.prs) {
        const matches = live.prs.filter((pr) => samePR(pr, seed, state.repo));
        const open = matches.filter((pr) => pr.state === "open").sort((a, b) => b.number - a.number);
        const reusable = open.find((pr) => !reviewed(pr));
        for (const pr of open.filter((pr) => pr !== reusable)) {
            request(`Close reviewed or duplicate prepared PR #${pr.number} before replacement`,
                `${prefix}/pulls/${pr.number}`, "PATCH", { state: "closed" });
        }
        if (reusable) {
            actions.push(...metadataActions(seed, reusable));
            continue;
        }
        const prior = matches.sort((a, b) => b.number - a.number)[0];
        actions.push({
            kind: "restore-pr", seed, prior,
            label: `${prior && !prior.merged_at && !reviewed(prior) ? "Reopen" : "Recreate"} seeded PR: ${seed.title}`,
        });
    }
    for (const [name, sha] of Object.entries(live.branches)) {
        if (Object.hasOwn(wanted, name)) continue;
        request(`Delete post-baseline branch ${name}`,
            `${prefix}/git/refs/heads/${name}`, "DELETE", undefined, sha);
    }
    for (const seed of state.issues) {
        const issue = live.issues.find((issue) => issue.number === seed.number);
        if (!issue) throw new Error(`Seeded issue #${seed.number} is missing; refusing partial reset.`);
        if (issue.state !== "open") {
            request(`Reopen issue #${seed.number}`, `${prefix}/issues/${seed.number}`, "PATCH", { state: "open" });
        }
        const current = issue.assignees.map((assignee) => assignee.login);
        const extra = current.filter((login) => !seed.assignees.includes(login));
        const missing = seed.assignees.filter((login) => !current.includes(login));
        if (extra.length) request(`Unassign ${extra.join(", ")} from issue #${seed.number}`,
            `${prefix}/issues/${seed.number}/assignees`, "DELETE", { assignees: extra });
        if (missing.length) request(`Reassign ${missing.join(", ")} to issue #${seed.number} (may start an agent)`,
            `${prefix}/issues/${seed.number}/assignees`, "POST", { assignees: missing });
    }
    for (const [kind, alerts] of Object.entries(live.alerts)) {
        for (const alert of alerts) {
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
            "code-scanning": alertPages(`${prefix}/code-scanning/alerts?per_page=100`, read),
            dependabot: alertPages(`${prefix}/dependabot/alerts?per_page=100`, read),
        },
    };
}

export function execute(action, request = api, command = run, log = console.log) {
    if (action.kind === "request") {
        if (action.guard && request(action.path.replace("/git/refs/", "/git/ref/")).object.sha !== action.guard) {
            throw new Error(`Branch changed since preview: ${action.label}. Run again after stopping writers.`);
        }
        request(action.path, action.method, action.body);
        return;
    }
    if (action.kind === "draft-pr") {
        command("gh", ["pr", "ready", String(action.number), "--repo", REPO, ...(action.draft ? ["--undo"] : [])]);
        return;
    }
    const { seed, prior } = action;
    if (prior && prior.state !== "open" && !prior.merged_at && !reviewed(prior)) {
        let reopened;
        try {
            reopened = request(`repos/${REPO}/pulls/${prior.number}`, "PATCH", { state: "open" });
        } catch (error) {
            // GitHub refuses to reopen some PRs after their head was force-pushed.
            if (!String(error.stderr).includes("HTTP 422")) throw error;
            log(`  GitHub refused reopening #${prior.number}; recreating its seeded diff.`);
        }
        if (reopened) {
            for (const update of metadataActions(seed, reopened)) execute(update, request, command, log);
            return;
        }
    }
    const created = request(`repos/${REPO}/pulls`, "POST", {
        head: seed.head, base: seed.base, title: seed.title, body: seed.body, draft: seed.draft,
    });
    log(`  Seeded PR replacement: ${created.html_url}`);
    request(`repos/${REPO}/issues/${created.number}/labels`, "PUT", { labels: seed.labels });
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
    if ((index !== -1 && (!/^[a-f0-9]{64}$/.test(expected || "") || !flags.includes("--confirm"))) ||
        flags.some((arg) => !["--confirm", "--record", "--help", "--preview-json"].includes(arg)) ||
        new Set(flags).size !== flags.length ||
        (flags.includes("--record") && flags.length !== 1) ||
        (flags.includes("--preview-json") && flags.length !== 1)) {
        throw new Error("Use preview, --preview-json, --confirm [--expected-preview <sha256>], or --record.");
    }
    if (args.includes("--help")) {
        log("node demo/remote-reset.mjs [--preview-json | --confirm [--expected-preview <sha256>] | --record]\n" +
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
    const plan = preview(state, readSnapshot(), tag.object.sha);
    if (args.includes("--preview-json")) {
        log(JSON.stringify(plan));
        return;
    }
    assertExpectedPreview(plan, expected);
    const { actions } = plan;
    const confirm = args.includes("--confirm");
    log(`${confirm ? "Resetting" : "Preview (no changes) for"} ${REPO}:`);
    if (!actions.length) log("Already at baseline. Nothing to do.");
    for (const action of actions) {
        log(`- ${action.label}`);
        if (confirm) apply(action);
    }
    if (!confirm && actions.length) log("Run with --confirm to apply this destructive remote reset.");
    if (confirm && actions.length) {
        const remaining = buildPlan(state, readSnapshot(), tag.object.sha);
        if (remaining.length) throw new Error(`Reset incomplete; re-run preview:\n${remaining.map((a) => a.label).join("\n")}`);
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
