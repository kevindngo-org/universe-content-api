import assert from "node:assert/strict";
import test from "node:test";
import { alertPages, buildPlan, execute, main, preview, REPO, snapshot, validateState } from "../demo/remote-reset.mjs";

const sha = "a".repeat(40);
const changed = "b".repeat(40);
function fixture() {
    return {
        state: {
            version: 1, repo: REPO, branches: { "feature/seed": sha },
            prs: [{ number: 7, head: "feature/seed", base: "main", title: "Seed", body: "", draft: false, labels: ["demo"] }],
            issues: [{ number: 1, assignees: [] }],
        },
        live: {
            branches: { main: sha, "feature/seed": sha },
            prs: [{
                number: 7, state: "open", title: "Seed", merged_at: null,
                body: "", draft: false, labels: [{ name: "demo" }], reviews: [], reviewComments: [],
                head: { ref: "feature/seed", repo: { full_name: REPO } }, base: { ref: "main" },
            }],
            issues: [{ number: 1, state: "open", assignees: [] }],
            alerts: { "code-scanning": [], dependabot: [] },
        },
    };
}

test("clean baseline produces no work and planning does not mutate input", () => {
    const { state, live } = fixture();
    const before = structuredClone({ state, live });
    assert.deepEqual(buildPlan(state, live, sha), []);
    assert.deepEqual({ state, live }, before);
});

test("restores recorded metadata on an open prepared PR", () => {
    const { state, live } = fixture();
    Object.assign(live.prs[0], { title: "Changed", body: "Changed", draft: true, labels: [{ name: "extra" }] });
    const plan = buildPlan(state, live, sha);
    assert.deepEqual(plan.map((a) => a.kind), ["request", "request", "draft-pr"]);
    assert.deepEqual(plan[0].body, { title: "Seed", body: "" });
    assert.deepEqual(plan[1].body, { labels: ["demo"] });
    const calls = [];
    execute(plan[2], () => assert.fail("Unexpected API call"), (...args) => calls.push(args));
    assert.deepEqual(calls, [["gh", ["pr", "ready", "7", "--repo", REPO]]]);
    plan[2].draft = true;
    execute(plan[2], () => assert.fail("Unexpected API call"), (...args) => calls.push(args));
    assert.equal(calls[1][1].at(-1), "--undo");
});

test("reviewed and commented prepared PRs get fresh URLs, including on retry after closure", () => {
    for (const key of ["reviews", "reviewComments"]) {
        const { state, live } = fixture();
        live.prs[0][key] = [{ id: 1, state: "DISMISSED", body: "Review" }];
        const plan = buildPlan(state, live, sha);
        assert.equal(plan[0].body.state, "closed");
        assert.equal(plan[1].kind, "restore-pr");
        const calls = [], messages = [];
        execute(plan[1], (path, method, body) => {
            calls.push({ path, method, body });
            return { number: 20, html_url: `https://github.com/${REPO}/pull/20` };
        }, () => assert.fail("Unexpected command"), (message) => messages.push(message));
        assert.equal(calls[0].method, "POST");
        assert.equal(calls[0].path, `repos/${REPO}/pulls`);
        assert.match(messages[0], /\/pull\/20$/);
        live.prs[0].state = "closed";
        assert.equal(buildPlan(state, live, sha)[0].kind, "restore-pr");
    }
});

test("partial creation with a failed label update retries metadata without duplicating PRs", () => {
    const { state, live } = fixture();
    live.prs[0].state = "closed";
    live.prs[0].merged_at = "2026-10-30T00:00:00Z";
    let creates = 0;
    assert.throws(() => execute(buildPlan(state, live, sha)[0], (path, method) => {
        if (path.endsWith("/pulls") && method === "POST") {
            creates++;
            const replacement = { ...live.prs[0], number: 20, state: "open", merged_at: null, labels: [] };
            live.prs.push(replacement);
            return { ...replacement, html_url: `https://github.com/${REPO}/pull/20` };
        }
        throw new Error("Label write failed");
    }, () => {}, () => {}), /Label write failed/);
    const retry = buildPlan(state, live, sha);
    assert.equal(retry.length, 1);
    assert.equal(retry[0].path, `repos/${REPO}/issues/20/labels`);
    execute(retry[0], (_, method, body) => {
        assert.equal(method, "PUT");
        live.prs[1].labels = body.labels.map((name) => ({ name }));
    });
    assert.equal(creates, 1);
    assert.deepEqual(buildPlan(state, live, sha), []);
});

test("reopening restores metadata and a metadata error does not create another PR", () => {
    const { state, live } = fixture();
    Object.assign(live.prs[0], { state: "closed", title: "Changed" });
    const calls = [];
    assert.throws(() => execute(buildPlan(state, live, sha)[0], (path, method, body) => {
        calls.push({ path, method, body });
        if (body.state === "open") return { ...live.prs[0], state: "open" };
        throw Object.assign(new Error("Metadata failure"), { stderr: "HTTP 422" });
    }), /Metadata failure/);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.method === "PATCH"));
});

test("preview fingerprints normalize order but detect every relevant state change", () => {
    const { state, live } = fixture();
    const first = preview(state, live, sha);
    assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(first), ["version", "repo", "fingerprint", "actions", "warnings"]);
    const reordered = structuredClone(live);
    reordered.branches = Object.fromEntries(Object.entries(live.branches).reverse());
    assert.equal(preview(state, reordered, sha).fingerprint, first.fingerprint);
    for (const mutate of [
        (s, l) => { l.branches.main = changed; },
        (s, l) => { l.prs[0].reviews.push({ id: 1, state: "APPROVED" }); },
        (s, l) => { l.prs[0].reviewComments.push({ id: 1, body: "Comment" }); },
        (s, l) => { l.prs[0].title = "New title"; },
        (s, l) => { l.prs[0].body = "New body"; },
        (s, l) => { l.prs[0].head.sha = changed; },
        (s, l) => { l.prs[0].base.ref = "other"; },
        (s, l) => { l.prs[0].draft = true; },
        (s, l) => { l.prs[0].labels = []; },
        (s, l) => { l.issues[0].assignees = [{ login: "Copilot" }]; },
        (s, l) => { l.alerts.dependabot.push({ number: 1, state: "dismissed" }); },
        (s) => { s.prs[0].body = "New seed"; },
    ]) {
        const copy = structuredClone({ state, live });
        mutate(copy.state, copy.live);
        assert.notEqual(preview(copy.state, copy.live, sha).fingerprint, first.fingerprint);
    }
});

function cliFixture() {
    const { state, live } = fixture();
    const output = [], applied = [];
    return { state, live, output, applied, services: {
        request(path) {
            if (path === `repos/${REPO}`) return { full_name: REPO, default_branch: "main", permissions: { push: true } };
            if (path.includes("/git/ref/tags/")) return { object: { type: "commit", sha } };
            if (path.includes("/contents/")) return { content: Buffer.from(JSON.stringify(state)).toString("base64") };
            assert.fail(`Unexpected API request: ${path}`);
        },
        readSnapshot: () => live, readState: () => state,
        apply: (action) => applied.push(action), log: (message) => output.push(message),
    } };
}

test("JSON CLI emits only one object and changed confirmation fails before any mutation", () => {
    const f = cliFixture();
    main(["--preview-json"], f.services);
    assert.equal(f.output.length, 1);
    const plan = JSON.parse(f.output[0]);
    assert.equal(plan.version, 1);
    assert.deepEqual(f.applied, []);
    f.live.branches.main = changed;
    assert.throws(() => main(["--confirm", "--expected-preview", plan.fingerprint], f.services), /changed since preview/);
    assert.deepEqual(f.applied, []);
    for (const args of [
        ["--expected-preview", plan.fingerprint], ["--confirm", "--expected-preview"],
        ["--preview-json", "--confirm"], ["--record", "--preview-json"], ["--unknown"],
    ]) assert.throws(() => main(args, f.services), /Use preview/);
});

test("legacy human preview and confirmation remain supported; incomplete reset fails", () => {
    const f = cliFixture();
    main([], f.services);
    assert.match(f.output[0], /Preview/);
    main(["--confirm", "--expected-preview", preview(f.state, f.live, sha).fingerprint], f.services);
    f.live.branches.main = changed;
    assert.throws(() => main(["--confirm"], f.services), /Reset incomplete/);
    assert.equal(f.applied.length, 1);
});

test("matching fingerprint applies and verifies only the approved plan", () => {
    const f = cliFixture();
    f.live.branches.main = changed;
    f.services.apply = (action) => {
        f.applied.push(action);
        f.live.branches.main = action.body.sha;
    };
    main(["--confirm", "--expected-preview", preview(f.state, f.live, sha).fingerprint], f.services);
    assert.equal(f.applied.length, 1);
    assert.ok(f.output.includes("Remote reset verified. Local worktrees were not changed."));
});

test("unknown alerts abort confirmation before writes, including the empty prepared-PR baseline", () => {
    const f = cliFixture();
    f.state.prs = [];
    f.state.branches = {};
    f.services.readSnapshot = () => alertPages("dependabot/alerts", () => {
        throw Object.assign(new Error("Denied"), { stderr: "HTTP 403" });
    });
    assert.throws(() => main(["--confirm"], f.services), /Cannot inspect alerts/);
    assert.deepEqual(f.applied, []);
    assert.deepEqual(buildPlan(f.state, { ...f.live, prs: [], branches: { main: sha } }, sha), []);
});

test("branch guard rejects concurrent writers without writing, and reopen 422 can recreate", () => {
    const { state, live } = fixture();
    live.branches.main = changed;
    let writes = 0;
    assert.throws(() => execute(buildPlan(state, live, sha)[0], (_, method = "GET") => {
        if (method !== "GET") writes++;
        return { object: { sha } };
    }), /Branch changed since preview/);
    assert.equal(writes, 0);
    live.branches.main = sha;
    live.prs[0].state = "closed";
    const methods = [];
    execute(buildPlan(state, live, sha)[0], (_, method) => {
        methods.push(method);
        if (method === "PATCH") throw Object.assign(new Error("Cannot reopen"), { stderr: "HTTP 422" });
        return { number: 20, html_url: `https://github.com/${REPO}/pull/20` };
    }, () => {}, () => {});
    assert.deepEqual(methods, ["PATCH", "POST", "PUT"]);
});

test("alert access failures are errors, never empty alerts; reviews are collected", () => {
    for (const status of [403, 404, 500]) {
        assert.throws(() => alertPages("alerts", () => {
            throw Object.assign(new Error("Denied"), { stderr: `HTTP ${status}` });
        }), new RegExp(`Cannot inspect alerts.*HTTP ${status}`));
    }
    const { live } = fixture();
    const calls = [];
    const result = snapshot((path) => {
        calls.push(path);
        if (path.includes("/branches?")) return [{ name: "main", commit: { sha } }];
        if (path.includes("/pulls?")) return live.prs;
        if (path.includes("/reviews?")) return [{ id: 1, state: "APPROVED" }];
        if (path.includes("/comments?")) return [{ id: 2, body: "Review comment" }];
        if (path.includes("/issues?")) return live.issues;
        return [];
    });
    assert.equal(result.prs[0].reviews[0].state, "APPROVED");
    assert.equal(result.prs[0].reviewComments[0].id, 2);
    assert.equal(calls.length, 7);
});

test("restores main and seeded heads; closes new PRs before deleting only new branches", () => {
    const { state, live } = fixture();
    live.branches = { main: changed, "feature/seed": changed, "copilot/demo": changed };
    live.prs.push({ ...live.prs[0], number: 10, title: "Demo", head: { ref: "copilot/demo", repo: { full_name: REPO } } });
    const plan = buildPlan(state, live, sha);
    assert.deepEqual(plan.map((a) => a.method), ["PATCH", "PATCH", "PATCH", "DELETE"]);
    assert.equal(plan[0].path, `repos/${REPO}/pulls/10`);
    assert.deepEqual(plan.slice(1, 3).map((a) => a.body), [{ sha, force: true }, { sha, force: true }]);
    assert.equal(plan[3].path, `repos/${REPO}/git/refs/heads/copilot/demo`);
    assert.ok(plan.slice(1).every((a) => a.guard === changed));
});

test("recreates missing seeded branch and reopens closed seeded PR", () => {
    const { state, live } = fixture();
    delete live.branches["feature/seed"];
    live.prs[0].state = "closed";
    const plan = buildPlan(state, live, sha);
    assert.equal(plan[0].method, "POST");
    assert.deepEqual(plan[0].body, { ref: "refs/heads/feature/seed", sha });
    assert.equal(plan[1].kind, "restore-pr");
    assert.equal(plan[1].prior.number, 7);
    assert.match(plan[1].label, /Reopen/);
});

test("merged seeded PR is recreated after main restoration, preserving draft/body/labels", () => {
    const { state, live } = fixture();
    state.prs[0].draft = true;
    state.prs[0].body = "Prepared example";
    live.branches.main = changed;
    live.prs[0].state = "closed";
    live.prs[0].merged_at = "2026-10-30T00:00:00Z";
    const plan = buildPlan(state, live, sha);
    assert.match(plan[0].label, /Restore main/);
    assert.match(plan[1].label, /Recreate seeded/);
    assert.deepEqual(plan[1].seed, state.prs[0]);
});

test("replacement seeded PR is recognized across reruns, but a fork with the same head is not", () => {
    const { state, live } = fixture();
    live.prs[0].number = 20;
    assert.deepEqual(buildPlan(state, live, sha), []);
    live.prs[0].head.repo.full_name = "someone/universe-content-api";
    const plan = buildPlan(state, live, sha);
    assert.match(plan[0].label, /Close demo-created PR #20/);
    assert.equal(plan[1].kind, "restore-pr");
});

test("reopens seeded issues, removes extra assignees, and restores recorded assignees", () => {
    const { state, live } = fixture();
    state.issues[0].assignees = ["presenter"];
    live.issues[0] = { number: 1, state: "closed", assignees: [{ login: "Copilot" }] };
    const plan = buildPlan(state, live, sha);
    assert.deepEqual(plan.map((a) => a.body), [
        { state: "open" }, { assignees: ["Copilot"] }, { assignees: ["presenter"] },
    ]);
});

test("reopens dismissed alerts and clears assignees without trying to reopen fixed alerts", () => {
    const { state, live } = fixture();
    live.alerts["code-scanning"] = [
        { number: 1, state: "dismissed", assignees: [{ login: "Copilot" }] },
        { number: 2, state: "fixed", assignees: [] },
    ];
    live.alerts.dependabot = [{ number: 3, state: "auto_dismissed", assignees: [] }];
    const plan = buildPlan(state, live, sha);
    assert.deepEqual(plan.map((a) => a.body), [{ state: "open" }, { assignees: [] }, { state: "open" }]);
    assert.ok(plan.every((a) => a.path.endsWith("/1") || a.path.endsWith("/3")));
});

test("refuses upstream, malformed commits, missing seeded heads and missing issues", () => {
    const { state, live } = fixture();
    assert.throws(() => buildPlan({ ...state, repo: "octodemo/universe-content-api" }, live, sha), /wrong repository/);
    assert.throws(() => buildPlan(state, live, "bad"), /Invalid demo-baseline/);
    assert.throws(() => validateState({ ...state, branches: { main: sha } }), /Invalid baseline/);
    assert.throws(() => validateState({ ...state, branches: {} }), /recorded head/);
    assert.throws(() => buildPlan(state, { ...live, issues: [] }, sha), /missing/);
});
