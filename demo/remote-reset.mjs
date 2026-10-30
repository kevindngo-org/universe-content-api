#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

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

// This repo may not have CodeQL or Dependabot alerts enabled; treat that as "no alerts".
function optionalPages(path) {
    try {
        return pages(path);
    } catch (error) {
        if (/HTTP (403|404)/.test(String(error.stderr))) return [];
        throw error;
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
        if (matches.some((pr) => pr.state === "open")) continue;
        const prior = matches.sort((a, b) => b.number - a.number)[0];
        actions.push({
            kind: "restore-pr", seed, prior,
            label: `${prior && !prior.merged_at ? "Reopen" : "Recreate"} seeded PR: ${seed.title}`,
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

function snapshot() {
    const prefix = `repos/${REPO}`;
    return {
        branches: Object.fromEntries(pages(`${prefix}/branches?per_page=100`).map((b) => [b.name, b.commit.sha])),
        prs: pages(`${prefix}/pulls?state=all&per_page=100`),
        issues: pages(`${prefix}/issues?state=all&per_page=100`).filter((issue) => !issue.pull_request),
        alerts: {
            "code-scanning": optionalPages(`${prefix}/code-scanning/alerts?per_page=100`),
            dependabot: optionalPages(`${prefix}/dependabot/alerts?per_page=100`),
        },
    };
}

function execute(action) {
    if (action.kind === "request") {
        if (action.guard && api(action.path.replace("/git/refs/", "/git/ref/")).object.sha !== action.guard) {
            throw new Error(`Branch changed since preview: ${action.label}. Run again after stopping writers.`);
        }
        api(action.path, action.method, action.body);
        return;
    }
    const { seed, prior } = action;
    if (prior && !prior.merged_at) {
        try {
            api(`repos/${REPO}/pulls/${prior.number}`, "PATCH", { state: "open" });
            return;
        } catch (error) {
            // GitHub refuses to reopen some PRs after their head was force-pushed.
            if (!String(error.stderr).includes("HTTP 422")) throw error;
            console.log(`  GitHub refused reopening #${prior.number}; recreating its seeded diff.`);
        }
    }
    const created = api(`repos/${REPO}/pulls`, "POST", {
        head: seed.head, base: seed.base, title: seed.title, body: seed.body, draft: seed.draft,
    });
    console.log(`  Seeded PR replacement: ${created.html_url}`);
    if (seed.labels.length) api(`repos/${REPO}/issues/${created.number}/labels`, "POST", { labels: seed.labels });
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

export function main(args = process.argv.slice(2)) {
    if (args.some((arg) => !["--confirm", "--record", "--help"].includes(arg)) ||
        (args.includes("--record") && args.includes("--confirm"))) {
        throw new Error("Use no flags (preview), --confirm (apply), or --record (replace baseline).");
    }
    if (args.includes("--help")) {
        console.log("node demo/remote-reset.mjs [--confirm | --record]\n" +
            "Preview by default. --confirm resets remote demo state. --record commits/pushes a new baseline and moves demo-baseline.");
        return;
    }
    const repo = api(`repos/${REPO}`);
    if (repo.full_name !== REPO || repo.default_branch !== "main" || !repo.permissions?.push) {
        throw new Error(`Expected write access to ${REPO} with default branch main.`);
    }
    if (args.includes("--record")) return record();
    const state = JSON.parse(readFileSync(resolve(ROOT, STATE_FILE), "utf8"));
    validateState(state);
    const tag = api(`repos/${REPO}/git/ref/tags/${TAG}`);
    if (tag.object.type !== "commit") throw new Error("Expected a lightweight demo-baseline tag pointing to a commit.");
    const recorded = api(`repos/${REPO}/contents/${STATE_FILE}?ref=${tag.object.sha}`);
    const remoteState = JSON.parse(Buffer.from(recorded.content, "base64").toString("utf8"));
    if (JSON.stringify(state) !== JSON.stringify(remoteState)) {
        throw new Error("Local baseline differs from demo-baseline. Update this checkout before resetting.");
    }
    const actions = buildPlan(state, snapshot(), tag.object.sha);
    const confirm = args.includes("--confirm");
    console.log(`${confirm ? "Resetting" : "Preview (no changes) for"} ${REPO}:`);
    if (!actions.length) console.log("Already at baseline. Nothing to do.");
    for (const action of actions) {
        console.log(`- ${action.label}`);
        if (confirm) execute(action);
    }
    if (!confirm && actions.length) console.log("Run with --confirm to apply this destructive remote reset.");
    if (confirm && actions.length) {
        const remaining = buildPlan(state, snapshot(), tag.object.sha);
        if (remaining.length) throw new Error(`Reset incomplete; re-run preview:\n${remaining.map((a) => a.label).join("\n")}`);
        console.log("Remote reset verified. Local worktrees were not changed.");
        console.log("Fixed alerts return only after CodeQL/Dependabot rescan restored main; reviews and history remain.");
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
