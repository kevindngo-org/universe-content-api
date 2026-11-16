import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { createApp } from "../src/server.mjs";
import { smokeTest } from "../api-smoke.mjs";

async function withServer(server, fn) {
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    try {
        await fn(`http://127.0.0.1:${server.address().port}`);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
}

test("checks the existing API, including an unknown id that does not collide", async () => {
    const item = { id: "smoke-test-unknown-highlight", topic: "Topic", title: "Title", summary: "Summary", tryIt: "Try it" };
    await withServer(createApp({ data: { event: "Event", highlights: [item] } }), smokeTest);
});

test("reports bad statuses and malformed JSON", async () => {
    await withServer(createServer((req, res) => {
        res.writeHead(503);
        res.end();
    }), async (base) => {
        await assert.rejects(smokeTest(base), /\/health: expected HTTP 200, received 503/);
    });
    await withServer(createServer((req, res) => res.end("not json")), async (base) => {
        await assert.rejects(smokeTest(base), /\/health: invalid JSON/);
    });
});

test("rejects malformed collections and mismatched individual records", async () => {
    const item = { id: "one", topic: "Topic", title: "Title", summary: "Summary", tryIt: "Try it" };
    for (const [collection, single, message] of [
        [{ event: "Event", count: 2, highlights: [item] }, item, /matching count/],
        [{ event: "Event", count: 1, highlights: [{ ...item, summary: 1 }] }, item, /non-empty string fields/],
        [{ event: "Event", count: 1, highlights: [item] }, { ...item, title: "Changed" }, /title does not match/],
    ]) {
        await withServer(createServer((req, res) => {
            const body = req.url === "/health" ? { ok: true } :
                req.url === "/api/highlights" ? collection : single;
            res.end(JSON.stringify(body));
        }), async (base) => {
            await assert.rejects(smokeTest(base), message);
        });
    }
});

test("rejects a malformed unknown-highlight response", async () => {
    const item = { id: "one", topic: "Topic", title: "Title", summary: "Summary", tryIt: "Try it" };
    await withServer(createServer((req, res) => {
        if (req.url === "/health") return res.end(JSON.stringify({ ok: true }));
        if (req.url === "/api/highlights") {
            return res.end(JSON.stringify({ event: "Event", count: 1, highlights: [item] }));
        }
        if (req.url === "/api/highlights/one") return res.end(JSON.stringify(item));
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Wrong error" }));
    }), async (base) => {
        await assert.rejects(smokeTest(base), /expected a Highlight not found error/);
    });
});

test("CLI checks a running API", async () => {
    await withServer(createApp(), async (base) => {
        const child = spawn(process.execPath, ["api-smoke.mjs", base]);
        let output = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => { output += chunk; });
        const status = await new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("close", resolve);
        });
        assert.equal(status, 0);
        assert.match(output, /API smoke checks passed/);
    });
});

test("rejects invalid URLs and exits nonzero for invalid CLI usage", async () => {
    await assert.rejects(smokeTest("https://example.com/prefix"), /HTTP\(S\) origin/);
    const result = spawnSync(process.execPath, ["api-smoke.mjs"], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
});
