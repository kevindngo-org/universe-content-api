import assert from "node:assert/strict";
import test from "node:test";
import { buildPlan, REPO, validateState } from "../demo/remote-reset.mjs";

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
