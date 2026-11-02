import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { alertPages, buildPlan, collectAlerts, execute, main, pages, preview, REPO, snapshot, validateState } from "../demo/remote-reset.mjs";

const sha = "a".repeat(40);
const changed = "b".repeat(40);
const zero = "0".repeat(40);
const prefix = `repos/${REPO}`;
const clone = structuredClone;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) :
    value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort()
        .filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])])) : value;

function fixture() {
    const state = {
        version: 1, repo: REPO, branches: { "feature/seed": sha },
        prs: [{ number: 7, head: "feature/seed", base: "main", title: "Seed", body: "", draft: false, labels: ["demo"] }],
        issues: [{ number: 1, assignees: [] }],
    };
    const live = {
        repositoryId: "R_demo", actor: { id: 100, login: "presenter" },
        branches: { main: sha, "feature/seed": sha },
        prs: [{
            number: 7, node_id: "PR_original", user: { id: 100, login: "presenter" },
            issueComments: [], state: "open", title: "Seed", merged_at: null,
            body: "", draft: false, labels: [{ name: "demo" }], reviews: [], reviewComments: [],
            head: { ref: "feature/seed", sha, repo: { full_name: REPO } }, base: { ref: "main", sha },
        }],
        issues: [{ number: 1, state: "open", assignees: [] }],
        alerts: { "code-scanning": [], dependabot: [] },
    };
    const calls = [], output = [];
    function request(path, method = "GET", body) {
        calls.push({ path, method, body: clone(body) });
        if (method === "GET") {
            if (path === "user") return clone(live.actor);
            if (path === prefix) return { full_name: REPO, node_id: live.repositoryId,
                default_branch: "main", permissions: { push: true } };
            if (path.includes("/git/ref/tags/")) return { object: { type: "commit", sha } };
            if (path.includes("/contents/")) return { content: Buffer.from(JSON.stringify(state)).toString("base64") };
            if (path.includes("/git/ref/heads/")) {
                const name = decodeURIComponent(path.split("/git/ref/heads/")[1]);
                return { object: { sha: live.branches[name] } };
            }
            for (const pr of live.prs) {
                if (path.startsWith(`${prefix}/pulls/${pr.number}/reviews?`)) return clone(pr.reviews);
                if (path.startsWith(`${prefix}/pulls/${pr.number}/comments?`)) return clone(pr.reviewComments);
                if (path.startsWith(`${prefix}/issues/${pr.number}/comments?`)) return clone(pr.issueComments);
            }
            for (const [kind, alerts] of Object.entries(live.alerts)) {
                const alert = alerts.find((alert) => path === `${prefix}/${kind}/alerts/${alert.number}`);
                if (alert) return clone(alert);
            }
            const pr = live.prs.find((pr) => path === `${prefix}/pulls/${pr.number}`);
            if (pr) return clone(pr);
        }
        for (const [kind, alerts] of Object.entries(live.alerts)) {
            const alert = alerts.find((alert) => path === `${prefix}/${kind}/alerts/${alert.number}`);
            if (alert && method === "PATCH") {
                Object.assign(alert, body, { updated_at: "2026-11-02T00:00:00Z" });
                return clone(alert);
            }
        }
        if (path === "graphql") {
            const { repositoryId, refUpdates } = body.variables.input;
            assert.equal(repositoryId, live.repositoryId);
            assert.match(body.query, /updateRefs\(input: \$input\)/);
            for (const update of refUpdates) {
                const name = update.name.slice("refs/heads/".length);
                if ((live.branches[name] || zero) !== update.beforeOid) return { errors: [{ message: "CAS mismatch" }] };
                if (update.afterOid === zero) delete live.branches[name];
                else live.branches[name] = update.afterOid;
                for (const pr of live.prs.filter((pr) => pr.head.ref === name)) pr.head.sha = update.afterOid;
            }
            return { data: { updateRefs: { clientMutationId: null } } };
        }
        if (path === `${prefix}/pulls` && method === "POST") {
            const pr = {
                ...clone(live.prs[0]), number: 20 + live.prs.length, node_id: `PR_${20 + live.prs.length}`,
                user: clone(live.actor), issueComments: [], state: "open", merged_at: null,
                title: body.title, body: body.body, draft: body.draft, labels: [], reviews: [], reviewComments: [],
                head: { ref: body.head, sha: live.branches[body.head], repo: { full_name: REPO } },
                base: { ref: body.base }, html_url: `https://github.com/${REPO}/pull/${20 + live.prs.length}`,
            };
            live.prs.push(pr);
            return clone(pr);
        }
        for (const pr of live.prs) {
            if (path === `${prefix}/issues/${pr.number}/comments` && method === "POST") {
                const comment = { id: 1000 + pr.issueComments.length, body: body.body, user: clone(live.actor) };
                pr.issueComments.push(comment);
                return clone(comment);
            }
            if (path === `${prefix}/pulls/${pr.number}` && method === "PATCH") {
                Object.assign(pr, { ...body, ...(body.base ? { base: { ref: body.base } } : {}) });
                return clone(pr);
            }
            if (path === `${prefix}/issues/${pr.number}/labels` && method === "PUT") {
                pr.labels = body.labels.map((name) => ({ name }));
                return clone(pr.labels);
            }
        }
        assert.fail(`Unexpected API request: ${method} ${path}`);
    }
    function command(name, args) {
        assert.equal(name, "gh");
        const pr = live.prs.find((pr) => String(pr.number) === args[2]);
        pr.draft = args.includes("--undo");
    }
    const log = (message) => output.push(message);
    const services = {
        request, readSnapshot: () => clone(live), readState: () => clone(state),
        apply: (action) => execute(action, request, command, log), log,
    };
    const confirm = () => main(["--confirm", "--expected-preview", preview(state, live, sha).fingerprint], services);
    return { state, live, calls, output, request, command, log, services, confirm };
}

test("baseline planning is pure; preview contains complete normalized state and exact payload hash", () => {
    const { state, live } = fixture();
    const before = clone({ state, live });
    assert.deepEqual(buildPlan(state, live, sha), []);
    const plan = preview(state, live, sha);
    assert.deepEqual({ state, live }, before);
    assert.deepEqual(Object.keys(plan).sort(), ["actions", "fingerprint", "repo", "version", "warnings"]);
    assert.equal(plan.actions[0].kind, "verify-state");
    assert.deepEqual(plan.actions[0].expected.baseline, state);
    const { fingerprint, ...payload } = clone(plan);
    assert.equal(fingerprint, createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex"));
    const modified = clone(payload);
    modified.warnings.push("Changed safety warning");
    assert.notEqual(fingerprint, createHash("sha256").update(JSON.stringify(canonical(modified))).digest("hex"));
});

test("missing, malformed and stale fingerprints fail before all mutations", () => {
    const f = fixture();
    for (const args of [
        ["--confirm"], ["--confirm", "--expected-preview"], ["--expected-preview", sha],
        ["--confirm", "--expected-preview", "bad"], ["--preview-json", "--confirm"],
        ["--record", "--preview-json"], ["--unknown"],
    ]) assert.throws(() => main(args, f.services), /Use preview/);
    assert.deepEqual(f.calls, []);
    const fingerprint = preview(f.state, f.live, sha).fingerprint;
    f.live.branches.main = changed;
    assert.throws(() => main(["--confirm", "--expected-preview", fingerprint], f.services), /changed since preview/);
    assert.ok(f.calls.every((call) => call.method === "GET"));
});

test("JSON CLI is a single object; human preview and help require the reviewed fingerprint", () => {
    const f = fixture();
    main(["--preview-json"], f.services);
    assert.equal(f.output.length, 1);
    assert.deepEqual(JSON.parse(f.output[0]), preview(f.state, f.live, sha));
    main([], f.services);
    assert.ok(f.output.some((line) => line.includes(`--confirm --expected-preview ${preview(f.state, f.live, sha).fingerprint}`)));
    main(["--help"], f.services);
    assert.ok(f.output.some((line) => line.includes("--confirm --expected-preview <sha256>")));
    assert.ok(f.calls.every((call) => call.method === "GET"));
});

test("deterministic planning normalizes sets, but preserves meaningful action order in its hash", () => {
    const f = fixture();
    f.live.branches = { main: changed, "feature/seed": changed, z: changed, a: changed };
    f.live.prs[0].head.sha = changed;
    f.live.alerts.dependabot = [{ number: 2, state: "dismissed" }, { number: 1, state: "dismissed" }];
    const plan = preview(f.state, f.live, sha);
    const reordered = clone(f.live);
    reordered.branches = Object.fromEntries(Object.entries(reordered.branches).reverse());
    reordered.alerts.dependabot.reverse();
    assert.deepEqual(preview(f.state, reordered, sha), plan);
    const { fingerprint, ...payload } = clone(plan);
    payload.actions.reverse();
    assert.notEqual(fingerprint, createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex"));
    const updates = plan.actions.filter((a) => a.kind === "ref-update");
    assert.deepEqual(updates.map((a) => a.body.variables.input.refUpdates[0].name),
        ["refs/heads/main", "refs/heads/feature/seed", "refs/heads/a", "refs/heads/z"]);
});

test("fingerprint detects PR reviews, head/base, metadata, issue, alert and baseline drift", () => {
    const f = fixture();
    const original = preview(f.state, f.live, sha).fingerprint;
    for (const mutate of [
        (s, l) => { l.prs[0].reviews.push({ id: 1, state: "APPROVED" }); },
        (s, l) => { l.prs[0].reviewComments.push({ id: 1, body: "Comment" }); },
        (s, l) => { l.prs[0].title = "Changed"; },
        (s, l) => { l.prs[0].body = "Changed"; },
        (s, l) => { l.prs[0].head.sha = changed; },
        (s, l) => { l.prs[0].base.ref = "other"; },
        (s, l) => { l.prs[0].draft = true; },
        (s, l) => { l.prs[0].labels = []; },
        (s, l) => { l.issues[0].assignees = [{ login: "Copilot" }]; },
        (s, l) => { l.alerts.dependabot.push({ number: 1, state: "auto_dismissed" }); },
        (s) => { s.prs[0].body = "New seed"; },
    ]) {
        const copy = clone({ state: f.state, live: f.live });
        mutate(copy.state, copy.live);
        assert.notEqual(preview(copy.state, copy.live, sha).fingerprint, original);
    }
});

test("creation, restoration and deletion use repository-keyed GraphQL CAS", () => {
    for (const scenario of ["create", "update", "delete"]) {
        const f = fixture();
        if (scenario === "create") delete f.live.branches["feature/seed"];
        if (scenario === "update") f.live.branches["feature/seed"] = changed;
        if (scenario === "delete") f.live.branches.extra = changed;
        const action = buildPlan(f.state, f.live, sha).find((a) => a.kind === "ref-update");
        const update = action.body.variables.input.refUpdates[0];
        assert.equal(update.beforeOid, scenario === "create" ? zero : changed);
        assert.equal(update.afterOid, scenario === "delete" ? zero : sha);
        assert.equal(update.force, true);
        execute(action, f.request);
        assert.equal(f.calls.length, 1);
        assert.equal(f.calls[0].path, "graphql");
    }
});

test("CAS rejects creation/update/deletion races without overwriting concurrent state", () => {
    for (const scenario of ["create", "update", "delete"]) {
        const f = fixture();
        if (scenario === "create") delete f.live.branches["feature/seed"];
        else f.live.branches["feature/seed"] = changed;
        if (scenario === "delete") {
            f.state.prs = [];
            f.state.branches = {};
        }
        const action = buildPlan(f.state, f.live, sha).find((a) => a.kind === "ref-update");
        f.live.branches["feature/seed"] = scenario === "create" ? changed : sha;
        const before = clone(f.live.branches);
        assert.throws(() => execute(action, f.request), /Atomic ref update rejected.*CAS mismatch/);
        assert.deepEqual(f.live.branches, before);
    }
});

test("special-character branch names survive CAS unchanged and encoded REST head guards", () => {
    const f = fixture();
    const name = "feature/seed#100%+topic";
    f.state.branches = { [name]: sha };
    f.state.prs[0].head = name;
    f.live.branches = { main: sha, [name]: changed };
    Object.assign(f.live.prs[0], { state: "closed", head: { ref: name, sha: changed, repo: { full_name: REPO } } });
    f.confirm();
    assert.equal(f.calls.find((c) => c.path === "graphql").body.variables.input.refUpdates[0].name, `refs/heads/${name}`);
    assert.ok(f.calls.some((c) => c.path === `${prefix}/git/ref/heads/feature/seed%23100%25%2Btopic`));
    assert.deepEqual(buildPlan(f.state, f.live, sha), []);
});

test("original PR base drift restores base without closing or rewriting unrelated history", () => {
    const f = fixture();
    f.live.prs[0].base.ref = "other";
    const actions = buildPlan(f.state, f.live, sha);
    assert.equal(actions.length, 1);
    assert.deepEqual(actions[0].body, { title: "Seed", body: "", base: "main" });
    f.confirm();
    assert.equal(f.live.prs[0].state, "open");
    assert.equal(f.live.prs[0].base.ref, "main");
});

test("unknown open same-head PRs fail closed and unknown closed history is left untouched", () => {
    for (const state of ["open", "closed"]) {
        const f = fixture();
        f.live.prs.push({ ...clone(f.live.prs[0]), number: 100, state, base: { ref: "other" } });
        if (state === "open") assert.throws(() => preview(f.state, f.live, sha), /Unknown open same-head/);
        else assert.deepEqual(buildPlan(f.state, f.live, sha), []);
        assert.deepEqual(f.calls, []);
    }
    const f = fixture();
    f.live.prs[0].head.repo.full_name = "someone/fork";
    assert.throws(() => buildPlan(f.state, f.live, sha), /changed identity/);
});

test("open prepared metadata repairs are fully previewed and guarded", () => {
    const f = fixture();
    Object.assign(f.live.prs[0], { title: "Changed", body: "Changed", draft: true, labels: [{ name: "extra" }] });
    const actions = buildPlan(f.state, f.live, sha);
    assert.deepEqual(actions.map((a) => a.kind), ["request", "request", "draft-pr"]);
    assert.deepEqual(actions[1].body, { labels: ["demo"] });
    assert.ok(actions.every((a) => a.guard.sha === sha && a.guard.number === 7));
    f.confirm();
    assert.deepEqual(buildPlan(f.state, f.live, sha), []);
});

test("reopen preview explicitly includes base/title/body/labels/draft repairs and 422 replacement", () => {
    const f = fixture();
    Object.assign(f.live.prs[0], { state: "closed", title: "Changed", body: "Changed", draft: true, base: { ref: "other" } });
    const action = buildPlan(f.state, f.live, sha)[0];
    assert.equal(action.kind, "restore-pr");
    assert.deepEqual(action.reopen.action.body, { state: "open" });
    assert.deepEqual(action.reopen.repairs.map((a) => a.kind), ["request", "request", "draft-pr"]);
    assert.deepEqual(action.reopen.repairs[0].body, { title: "Seed", body: "", base: "main" });
    assert.deepEqual(action.reopen.onHTTP422.create.body, {
        head: "feature/seed", base: "main", title: "Seed",
        body: "", draft: false,
    });
    assert.equal(action.reopen.onHTTP422.repairs[0].path, `${prefix}/issues/$created.number/labels`);
    f.confirm();
    assert.equal(f.live.prs.length, 1);
    assert.deepEqual(buildPlan(f.state, f.live, sha), []);
});

test("only reopen 422 uses previewed fallback, never repair errors", () => {
    for (const errorAt of ["reopen", "repair"]) {
        const f = fixture();
        Object.assign(f.live.prs[0], { state: "closed", title: "Changed" });
        const request = (path, method, body) => {
            if (method === "PATCH" && (errorAt === "reopen" ? body.state === "open" : body.title)) {
                throw Object.assign(new Error(`Failed ${errorAt}`), { stderr: "HTTP 422" });
            }
            return f.request(path, method, body);
        };
        const action = buildPlan(f.state, f.live, sha)[0];
        if (errorAt === "repair") {
            assert.throws(() => execute(action, request, f.command, f.log), /Failed repair.*HTTP 422/);
            assert.equal(f.live.prs.length, 1);
        } else {
            execute(action, request, f.command, f.log);
            assert.equal(f.live.prs.length, 2);
            assert.deepEqual(buildPlan(f.state, f.live, sha), []);
        }
    }
});

test("reviewed/commented originals use restored seed head guard and fresh PR URLs with exact recorded body", () => {
    for (const key of ["reviews", "reviewComments"]) {
        const f = fixture();
        f.live.branches["feature/seed"] = changed;
        f.live.prs[0].head.sha = changed;
        f.live.prs[0][key].push({ id: 1, state: "DISMISSED", body: "Review" });
        const actions = buildPlan(f.state, f.live, sha);
        assert.equal(actions[0].kind, "ref-update");
        assert.equal(actions[1].guard.sha, sha);
        assert.equal(actions[2].headGuard.sha, sha);
        assert.equal(actions[2].create.method, "POST");
        f.confirm();
        assert.equal(f.live.prs[0].state, "closed");
        assert.equal(f.live.prs.length, 2);
        assert.equal(f.live.prs[1].body, f.state.prs[0].body);
        assert.match(f.live.prs[0].issueComments[0].body, /Demo reset replacement receipt/);
        assert.ok(f.output.some((line) => line.includes(f.live.prs[1].html_url)));
        assert.deepEqual(buildPlan(f.state, f.live, sha), []);
    }
});

test("PR head drift blocks closing, reopening and metadata edits, even when guards are serialized", () => {
    for (const scenario of ["reviewed", "closed", "metadata"]) {
        const f = fixture();
        if (scenario === "reviewed") f.live.prs[0].reviews.push({ id: 1 });
        if (scenario === "closed") f.live.prs[0].state = "closed";
        if (scenario === "metadata") f.live.prs[0].title = "Changed";
        const action = JSON.parse(JSON.stringify(buildPlan(f.state, f.live, sha)[0]));
        f.live.prs[0].head.sha = changed;
        assert.throws(() => execute(action, f.request), /PR head\/review\/metadata changed/);
        assert.ok(f.calls.every((call) => call.method === "GET"));
    }
});

test("partial creation label failure is reported and retries the known replacement without duplicating it", () => {
    const f = fixture();
    f.live.prs[0].reviews.push({ id: 1 });
    const originalRequest = f.request;
    f.services.apply = (action) => execute(action, (path, method, body) => {
        if (path.includes("/labels") && method === "PUT") throw new Error("Label write failed");
        return originalRequest(path, method, body);
    }, f.command, f.log);
    assert.throws(() => f.confirm(), /Failed action "Recreate seeded PR: Seed".*Earlier actions may have applied.*Label write failed/);
    assert.equal(f.live.prs.length, 2);
    const retry = buildPlan(f.state, f.live, sha);
    assert.equal(retry.length, 1);
    assert.match(retry[0].path, /\/issues\/21\/labels$/);
    f.services.apply = (action) => execute(action, originalRequest, f.command, f.log);
    f.confirm();
    assert.equal(f.live.prs.length, 2);
    assert.deepEqual(buildPlan(f.state, f.live, sha), []);
});

test("retry after closing a reviewed PR recreates it; a copied replacement identity fails closed", () => {
    const f = fixture();
    f.live.prs[0].reviews.push({ id: 1 });
    execute(buildPlan(f.state, f.live, sha)[0], f.request);
    assert.equal(f.live.prs[0].state, "closed");
    f.confirm();
    const replacement = clone(f.live.prs[1]);
    replacement.number++;
    f.live.prs.push(replacement);
    assert.throws(() => buildPlan(f.state, f.live, sha), /Unknown open same-head/);
});

test("merged originals recreate after restoring missing heads, without trying to reopen", () => {
    const f = fixture();
    delete f.live.branches["feature/seed"];
    Object.assign(f.live.prs[0], { state: "closed", merged_at: "2026-10-30T00:00:00Z" });
    const actions = buildPlan(f.state, f.live, sha);
    assert.equal(actions[0].body.variables.input.refUpdates[0].beforeOid, zero);
    assert.equal(actions[1].reopen, undefined);
    f.confirm();
    assert.equal(f.live.prs.length, 2);
    assert.deepEqual(buildPlan(f.state, f.live, sha), []);
});

test("known replacement base drift is restored; missing receipt fails closed instead of selecting by recency", () => {
    const f = fixture();
    f.live.prs[0].reviews.push({ id: 1 });
    f.confirm();
    f.live.prs[1].base.ref = "other";
    f.confirm();
    assert.equal(f.live.prs[1].base.ref, "main");
    f.live.prs[0].issueComments = [];
    assert.throws(() => preview(f.state, f.live, sha), /Unknown open same-head/);
    assert.equal(f.live.prs.length, 2);
});

test("lost creation response blocks retries without adopting an unverified replacement", () => {
    const f = fixture();
    f.live.prs[0].reviews.push({ id: 1 });
    f.services.apply = (action) => execute(action, (path, method, body) => {
        const result = f.request(path, method, body);
        if (path === `${prefix}/pulls` && method === "POST") throw new Error("Connection lost after POST");
        return result;
    }, f.command, f.log);
    assert.throws(() => f.confirm(), /Earlier actions may have applied.*Connection lost/);
    assert.equal(f.live.prs.length, 2);
    f.services.apply = (action) => execute(action, f.request, f.command, f.log);
    assert.throws(() => f.confirm(), /Unknown open same-head/);
    assert.equal(f.live.prs.length, 2);
});

test("replacement preview preserves exact body and explicitly shows the original-PR provenance receipt", () => {
    const f = fixture();
    f.state.prs[0].body = "Prepared body\n\nWith exact whitespace.\n";
    f.live.prs[0].reviews.push({ id: 1 });
    const action = preview(f.state, f.live, sha).actions.find((a) => a.kind === "restore-pr");
    assert.equal(action.create.body.body, f.state.prs[0].body);
    assert.equal(action.receipt.path, `${prefix}/issues/7/comments`);
    assert.equal(action.receipt.method, "POST");
    assert.equal(action.receipt.body.body, "Demo reset replacement receipt\n\n```json\n" + JSON.stringify({
        version: 1, repo: REPO, originalNumber: 7, replacementNumber: "$created.number",
        replacementNodeId: "$created.node_id", seededHead: { ref: "feature/seed", sha },
        creator: { id: 100, login: "presenter" },
    }, null, 2) + "\n```");
    assert.deepEqual(action.receipt.author, f.live.actor);
    f.confirm();
    assert.equal(f.live.prs[1].body, f.state.prs[0].body);
    assert.deepEqual(buildPlan(f.state, f.live, sha), []);
});

test("copied legacy hidden markers never establish replacement provenance", () => {
    const f = fixture();
    f.live.prs[0].state = "closed";
    f.live.prs.push({ ...clone(f.live.prs[0]), number: 30, node_id: "PR_other", state: "open",
        body: `\n\n<!-- demo-reset:${REPO}:7:${sha} -->` });
    assert.throws(() => preview(f.state, f.live, sha), /Unknown open same-head/);
    assert.deepEqual(f.calls, []);
});

test("copied/forged receipt identity, author, creator and seed bindings cannot authorize a candidate", () => {
    for (const tamper of [
        (f) => { f.live.prs[1].number++; },
        (f) => { f.live.prs[1].node_id = "PR_copied_node"; },
        (f) => { f.live.prs[1].user.id++; },
        (f) => { f.live.prs[1].user.login = "different_creator"; },
        (f) => { f.live.prs[0].issueComments[0].user.id++; },
        (f) => { f.live.prs[0].issueComments[0].user.login = "forged_author"; },
        (f) => { f.live.prs[0].issueComments[0].body = f.live.prs[0].issueComments[0].body.replace('"originalNumber": 7', '"originalNumber": 8'); },
        (f) => { f.live.prs[0].issueComments[0].body = f.live.prs[0].issueComments[0].body.replace(sha, changed); },
        (f) => { f.live.prs[0].issueComments[0].body = f.live.prs[0].issueComments[0].body.replace('"repo":', '"otherRepo":'); },
        (f) => { f.live.prs[0].issueComments[0].body = "Demo reset replacement receipt\n\n```json\nnot-json\n```"; },
        (f) => { f.live.prs[1].issueComments = f.live.prs[0].issueComments; f.live.prs[0].issueComments = []; },
    ]) {
        const f = fixture();
        f.live.prs[0].reviews.push({ id: 1 });
        f.confirm();
        tamper(f);
        const before = clone(f.live);
        assert.throws(() => preview(f.state, f.live, sha), /Unknown open same-head/);
        assert.deepEqual(f.live, before);
    }
});

test("even multiple receipted open replacements block planning rather than selecting by recency", () => {
    const f = fixture();
    f.live.prs[0].reviews.push({ id: 1 });
    f.confirm();
    const extra = clone(f.live.prs[1]);
    extra.number = 50;
    extra.node_id = "PR_extra";
    f.live.prs.push(extra);
    const receipt = clone(f.live.prs[0].issueComments[0]);
    receipt.id++;
    receipt.body = receipt.body.replace('"replacementNumber": 21', '"replacementNumber": 50')
        .replace('"replacementNodeId": "PR_21"', '"replacementNodeId": "PR_extra"');
    f.live.prs[0].issueComments.push(receipt);
    assert.throws(() => buildPlan(f.state, f.live, sha), /Multiple known open/);
});

test("receipt body/author and replacement immutable identities are fingerprinted", () => {
    const f = fixture();
    f.live.prs[0].reviews.push({ id: 1 });
    f.confirm();
    const before = preview(f.state, f.live, sha);
    f.live.prs[0].issueComments.push({ id: 5000, body: "Visible receipt discussion", user: clone(f.live.actor) });
    const after = preview(f.state, f.live, sha);
    assert.notEqual(after.fingerprint, before.fingerprint);
    const original = after.actions[0].expected.prs.find((pr) => pr.number === 7);
    assert.deepEqual(original.issueComments, f.live.prs[0].issueComments);
    const replacement = after.actions[0].expected.prs.find((pr) => pr.number === 21);
    assert.equal(replacement.nodeId, f.live.prs[1].node_id);
    assert.deepEqual(replacement.creator, f.live.actor);
});

test("receipt write failure without persistence blocks retry instead of duplicating or adopting", () => {
    const f = fixture();
    f.live.prs[0].reviews.push({ id: 1 });
    f.services.apply = (action) => execute(action, (path, method, body) => {
        if (path === `${prefix}/issues/7/comments` && method === "POST") throw new Error("Receipt write denied");
        return f.request(path, method, body);
    }, f.command, f.log);
    assert.throws(() => f.confirm(), /Failed repair "Post visible replacement provenance receipt.*Receipt write denied/);
    assert.equal(f.live.prs.length, 2);
    assert.equal(f.live.prs[0].issueComments.length, 0);
    assert.throws(() => f.confirm(), /Unknown open same-head.*reconcile provenance manually/);
    assert.equal(f.live.prs.length, 2);
});

test("lost receipt response safely retries known replacement metadata without posting another receipt", () => {
    const f = fixture();
    f.live.prs[0].reviews.push({ id: 1 });
    f.services.apply = (action) => execute(action, (path, method, body) => {
        const result = f.request(path, method, body);
        if (path === `${prefix}/issues/7/comments` && method === "POST") throw new Error("Receipt response lost");
        return result;
    }, f.command, f.log);
    assert.throws(() => f.confirm(), /Receipt response lost/);
    assert.equal(f.live.prs[0].issueComments.length, 1);
    f.services.apply = (action) => execute(action, f.request, f.command, f.log);
    f.confirm();
    assert.equal(f.live.prs.length, 2);
    assert.equal(f.live.prs[0].issueComments.length, 1);
    assert.deepEqual(buildPlan(f.state, f.live, sha), []);
});

test("changed creator or receipt author aborts execution before posting unverifiable provenance", () => {
    for (const scenario of ["actor", "creator", "node"]) {
        const f = fixture();
        f.live.prs[0].reviews.push({ id: 1 });
        const action = buildPlan(f.state, f.live, sha)[1];
        if (scenario === "actor") f.live.actor.id++;
        const request = (path, method, body) => {
            const result = f.request(path, method, body);
            if (path === `${prefix}/pulls` && method === "POST") {
                if (scenario === "creator") result.user.id++;
                if (scenario === "node") result.node_id = "PR_wrong";
            }
            return result;
        };
        assert.throws(() => execute(action, request, f.command, f.log),
            /creator changed|Missing replacement PR response|PR head\/review\/metadata changed/);
        assert.equal(f.live.prs[0].issueComments.length, 0);
    }
});

test("demo-created PR heads are checked before closure and branch deletion is atomic", () => {
    const f = fixture();
    f.live.branches["demo/new"] = changed;
    f.live.prs.push({ ...clone(f.live.prs[0]), number: 8,
        head: { ref: "demo/new", sha: changed, repo: { full_name: REPO } } });
    const actions = buildPlan(f.state, f.live, sha);
    assert.equal(actions[0].body.state, "closed");
    assert.equal(actions[0].guard.sha, changed);
    assert.equal(actions[1].body.variables.input.refUpdates[0].afterOid, zero);
    f.confirm();
    assert.equal(f.live.prs[1].state, "closed");
    assert.equal(f.live.branches["demo/new"], undefined);
});

test("unknown alerts block all writes; auto-dismissed warnings and alert actions are explicit", () => {
    const f = fixture();
    f.state.prs = [];
    f.state.branches = {};
    for (const status of [403, 404, 500]) {
        assert.throws(() => alertPages("alerts", () => {
            throw Object.assign(new Error("Denied"), { stderr: `HTTP ${status}` });
        }), new RegExp(`Cannot inspect alerts.*HTTP ${status}`));
    }
    f.services.readSnapshot = () => alertPages("dependabot/alerts", () => {
        throw Object.assign(new Error("Denied"), { stderr: "HTTP 403" });
    });
    assert.throws(() => main(["--confirm", "--expected-preview", "a".repeat(64)], f.services), /Cannot inspect alerts/);
    assert.ok(f.calls.every((call) => call.method === "GET"));
    f.live.prs = [];
    f.live.branches = { main: sha };
    f.live.alerts.dependabot = [{ number: 1, state: "auto_dismissed" }, { number: 2, state: "fixed" }];
    const plan = preview(f.state, f.live, sha);
    assert.ok(plan.warnings.some((warning) => /override auto-triage/.test(warning)));
    assert.equal(plan.actions.length, 2);
    assert.deepEqual(plan.actions[1].body, { state: "open" });
});

test("snapshot collects review state; issue and alert resets retain existing behavior", () => {
    const { state, live } = fixture();
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
    assert.equal(calls.length, 22);
    state.issues[0].assignees = ["presenter"];
    live.issues[0] = { number: 1, state: "closed", assignees: [{ login: "Copilot" }] };
    live.alerts["code-scanning"] = [{ number: 1, state: "dismissed", assignees: [{ login: "Copilot" }] }];
    assert.deepEqual(buildPlan(state, live, sha).map((a) => a.body), [
        { state: "open" }, { assignees: ["Copilot"] }, { assignees: ["presenter"] },
        { state: "open", assignees: [] },
    ]);
});

test("pagination explicitly follows all pages and rejects malformed paginated responses", () => {
    const calls = [];
    assert.deepEqual(pages("alerts?state=dismissed&per_page=100", (command, args) => {
        calls.push({ command, args });
        return JSON.stringify([[{ number: 1 }], [{ number: 2 }]]);
    }), [{ number: 1 }, { number: 2 }]);
    assert.deepEqual(calls, [{ command: "gh",
        args: ["api", "--paginate", "--slurp", "alerts?state=dismissed&per_page=100"] }]);
    for (const response of [{ message: "Denied" }, [null], [{ number: 1 }]]) {
        assert.throws(() => pages("alerts", () => JSON.stringify(response)), /Invalid paginated list response/);
    }
});

test("snapshot explicitly collects every alert state and previews dismissed/auto-dismissed actions", () => {
    const f = fixture();
    const calls = [];
    const alerts = {
        "code-scanning": {
            open: [{ number: 1, state: "open" }],
            closed: [{ number: 2, state: "dismissed" }, { number: 3, state: "fixed" }],
            dismissed: [{ number: 2, state: "dismissed" }],
            fixed: [{ number: 3, state: "fixed" }],
        },
        dependabot: {
            open: [{ number: 4, state: "open" }],
            dismissed: [{ number: 5, state: "dismissed" }],
            fixed: [{ number: 6, state: "fixed" }],
            auto_dismissed: [{ number: 7, state: "auto_dismissed" }],
        },
    };
    const live = snapshot((path) => {
        calls.push(path);
        const [endpoint, query] = path.split("?");
        const kind = endpoint.includes("/code-scanning/") ? "code-scanning" :
            endpoint.includes("/dependabot/") ? "dependabot" : undefined;
        if (kind) {
            const params = new URLSearchParams(query);
            assert.equal(params.get("per_page"), "100");
            assert.ok(params.has("state"));
            const data = alerts[kind][params.get("state")];
            // Exercise the real paginator adapter with multiple pages per explicit state.
            return pages(path, (_, args) => {
                assert.deepEqual(args.slice(0, 3), ["api", "--paginate", "--slurp"]);
                return JSON.stringify([data.slice(0, 1), data.slice(1)]);
            });
        }
        if (endpoint.endsWith("/branches")) return Object.entries(f.live.branches)
            .map(([name, sha]) => ({ name, commit: { sha } }));
        if (endpoint.endsWith("/pulls")) return f.live.prs;
        if (endpoint.endsWith("/issues")) return f.live.issues;
        return [];
    });
    live.repositoryId = f.live.repositoryId;
    live.actor = f.live.actor;
    assert.deepEqual(live.alerts["code-scanning"].map((a) => a.number), [1, 2, 3]);
    assert.deepEqual(live.alerts.dependabot.map((a) => a.number), [4, 5, 6, 7]);
    assert.equal(calls.filter((path) => path.includes("/alerts?state=")).length, 16);
    const plan = preview(f.state, live, sha);
    assert.deepEqual(plan.actions.filter((a) => a.method === "PATCH").map((a) => a.path), [
        `${prefix}/code-scanning/alerts/2`, `${prefix}/dependabot/alerts/5`, `${prefix}/dependabot/alerts/7`,
    ]);
    assert.ok(plan.actions[0].expected.alerts.dependabot.some((a) => a.state === "auto_dismissed"));
    assert.ok(plan.warnings.some((warning) => /override auto-triage/.test(warning)));
});

test("alert collection deduplicates consistent observations but fails on state or assignee disagreement", () => {
    const duplicate = { number: 1, state: "dismissed", assignees: [{ login: "z" }, { login: "a" }] };
    const read = (path) => {
        const state = new URLSearchParams(path.split("?")[1]).get("state");
        return ["closed", "dismissed"].includes(state) ? [clone(duplicate), clone(duplicate)] : [];
    };
    const collected = collectAlerts("code-scanning", read);
    assert.equal(collected.length, 1);
    assert.deepEqual(collected[0].assignees, [{ login: "a" }, { login: "z" }]);
    for (const conflicting of [
        { number: 1, state: "fixed", assignees: [] },
        { number: 1, state: "dismissed", assignees: [] },
    ]) {
        assert.throws(() => collectAlerts("code-scanning", (path) => {
            const state = new URLSearchParams(path.split("?")[1]).get("state");
            if (state === "closed") return [clone(conflicting)];
            if (state === "dismissed") return [clone(duplicate)];
            return [];
        }), /Inconsistent code-scanning alert #1/);
    }
    assert.throws(() => collectAlerts("dependabot", (path) => path.includes("state=open") ?
        [{ number: 1, state: "dismissed" }] : []), /Invalid or inconsistent/);
});

test("access failures on later alert states abort the entire snapshot rather than returning partial alerts", () => {
    for (const kind of ["code-scanning", "dependabot"]) {
        const failing = kind === "code-scanning" ? "fixed" : "auto_dismissed";
        assert.throws(() => collectAlerts(kind, (path) => {
            const state = new URLSearchParams(path.split("?")[1]).get("state");
            if (state === failing) throw Object.assign(new Error("Forbidden"), { stderr: "HTTP 403" });
            return state === "open" ? [{ number: 1, state: "open" }] : [];
        }), new RegExp(`Cannot inspect alerts.*state=${failing}.*HTTP 403`));
    }
});

test("missing scope, invalid baseline, missing seeded issue and incomplete PR state fail closed", () => {
    const { state, live } = fixture();
    assert.throws(() => buildPlan({ ...state, repo: "upstream/repo" }, live, sha), /wrong repository/);
    assert.throws(() => buildPlan(state, live, "bad"), /Invalid demo-baseline/);
    assert.throws(() => validateState({ ...state, branches: { main: sha } }), /Invalid baseline/);
    assert.throws(() => validateState({ ...state, branches: {} }), /recorded head/);
    assert.throws(() => buildPlan(state, { ...live, repositoryId: undefined }, sha), /node ID/);
    assert.throws(() => buildPlan(state, { ...live, issues: [] }, sha), /missing/);
    delete live.prs[0].reviews;
    assert.throws(() => buildPlan(state, live, sha), /head\/review state/);
});

test("two full alert sweeps reject disappearance, transitions, assignments and updated-time drift", () => {
    for (const kind of ["code-scanning", "dependabot"]) {
        const statesPerSweep = 4;
        for (const change of ["missing", "state", "assignee", "updated"]) {
            let calls = 0;
            assert.throws(() => collectAlerts(kind, (path) => {
                const sweep = Math.floor(calls++ / statesPerSweep);
                const state = new URLSearchParams(path.split("?")[1]).get("state");
                const alert = { number: 10, state: "open", assignees: [], updated_at: "2026-11-01T00:00:00Z" };
                if (sweep) {
                    if (change === "missing") return [];
                    if (change === "state") alert.state = "dismissed";
                    if (change === "assignee") alert.assignees = [{ login: "new-writer" }];
                    if (change === "updated") alert.updated_at = "2026-11-01T00:01:00Z";
                }
                return state === alert.state || (state === "closed" && alert.state === "dismissed") ? [alert] : [];
            }), /Changed .* alert inventory between complete sweeps/);
        }
    }
});

test("filter-transition disappearance in first sweep is detected when second inventory observes the alert", () => {
    let calls = 0;
    assert.throws(() => collectAlerts("dependabot", (path) => {
        const sweep = Math.floor(calls++ / 4);
        const state = new URLSearchParams(path.split("?")[1]).get("state");
        // First sweep misses an alert that became open after the open query and before dismissed query.
        return sweep && state === "open" ? [{ number: 1, state: "open", updated_at: "2026-11-01T00:00:00Z" }] : [];
    }), /Changed dependabot alert inventory/);
});

test("new mid-run PR reviews or metadata abort repairs and preserve concurrent work", () => {
    for (const mutate of [
        (pr) => pr.reviews.push({ id: 2, state: "APPROVED" }),
        (pr) => pr.reviewComments.push({ id: 3, body: "New review comment" }),
        (pr) => { pr.body = "Concurrent body edit"; },
        (pr) => { pr.title = "Concurrent title edit"; },
        (pr) => { pr.labels.push({ name: "concurrent" }); },
        (pr) => { pr.base.ref = "other"; },
        (pr) => { pr.draft = false; },
    ]) {
        const f = fixture();
        Object.assign(f.live.prs[0], { title: "Needs restoration", draft: true, labels: [] });
        f.services.apply = (action) => {
            execute(action, f.request, f.command, f.log);
            if (action.method === "PATCH" && action.body.title === "Seed") mutate(f.live.prs[0]);
        };
        assert.throws(() => f.confirm(), /Failed action "Restore labels.*Earlier actions may have applied.*PR head\/review\/metadata changed/);
        assert.ok(!f.calls.some((c) => c.method === "PUT"));
    }
});

test("review arriving after planned closure blocks replacement creation", () => {
    const f = fixture();
    f.live.prs[0].reviews.push({ id: 1, state: "APPROVED" });
    f.services.apply = (action) => {
        execute(action, f.request, f.command, f.log);
        if (action.method === "PATCH" && action.body.state === "closed") {
            f.live.prs[0].reviews.push({ id: 2, state: "COMMENTED" });
        }
    };
    assert.throws(() => f.confirm(), /Failed action "Recreate seeded PR.*Earlier actions may have applied.*PR head\/review\/metadata changed/);
    assert.equal(f.live.prs.length, 1);
    assert.equal(f.live.prs[0].state, "closed");
});

test("alert assignment/state/time drift immediately before write aborts without erasing new assignments", () => {
    for (const mutate of [
        (alert) => { alert.assignees.push({ login: "concurrent" }); },
        (alert) => { alert.state = "fixed"; },
        (alert) => { alert.updated_at = "2026-11-01T00:01:00Z"; },
    ]) {
        const f = fixture();
        f.live.alerts.dependabot = [{ number: 1, state: "dismissed",
            assignees: [{ login: "old" }], updated_at: "2026-11-01T00:00:00Z" }];
        f.services.apply = (action) => {
            if (action.alertGuard) mutate(f.live.alerts.dependabot[0]);
            execute(action, f.request, f.command, f.log);
        };
        assert.throws(() => f.confirm(), /Failed action "Restore dependabot alert.*Earlier actions may have applied.*Alert state\/assignees\/update time changed/);
        assert.ok(!f.calls.some((c) => c.method === "PATCH"));
    }
});

test("combined guarded alert repair accounts for reopen and assignment clearing in one write", () => {
    const f = fixture();
    f.live.alerts.dependabot = [{ number: 1, state: "auto_dismissed",
        assignees: [{ login: "old" }], updated_at: "2026-11-01T00:00:00Z" }];
    const actions = buildPlan(f.state, f.live, sha);
    assert.equal(actions.length, 1);
    assert.deepEqual(actions[0].body, { state: "open", assignees: [] });
    assert.equal(actions[0].alertGuard.updated_at, "2026-11-01T00:00:00Z");
    f.confirm();
    assert.equal(f.live.alerts.dependabot[0].state, "open");
    assert.deepEqual(f.live.alerts.dependabot[0].assignees, []);
    assert.equal(f.calls.filter((c) => c.method === "PATCH").length, 1);
});
