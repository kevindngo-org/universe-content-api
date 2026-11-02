import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/server.mjs";
import { loadHighlights, slugify } from "../src/highlights.mjs";

async function withServer(fn) {
    const server = createApp().listen(0);
    await new Promise((done) => server.once("listening", done));
    try {
        await fn(`http://127.0.0.1:${server.address().port}`);
    } finally {
        server.close();
    }
}

test("slugify produces stable ids", () => {
    assert.equal(slugify("Media in issues from the CLI"), "media-in-issues-from-the-cli");
});

test("every highlight has a unique id and the landing page fields", () => {
    const { highlights } = loadHighlights();
    assert.equal(new Set(highlights.map((item) => item.id)).size, highlights.length);
    for (const item of highlights) {
        for (const field of ["id", "topic", "title", "summary", "tryIt"]) assert.equal(typeof item[field], "string");
    }
});

test("GET /api/highlights returns all highlights with CORS", () => withServer(async (base) => {
    const response = await fetch(`${base}/api/highlights`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    const body = await response.json();
    assert.equal(body.count, 6);
    assert.deepEqual(body, { ...loadHighlights(), count: 6 });
}));

test("GET /api/highlights filters each URL-encoded topic name without changing fields", () => withServer(async (base) => {
    const data = loadHighlights();
    for (const topic of new Set(data.highlights.map((item) => item.topic))) {
        const response = await fetch(`${base}/api/highlights?topic=${encodeURIComponent(topic)}`);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("access-control-allow-origin"), "*");
        const highlights = data.highlights.filter((item) => item.topic === topic);
        assert.deepEqual(await response.json(), { event: data.event, count: highlights.length, highlights });
    }
    assert.deepEqual(await (await fetch(`${base}/api/highlights`)).json(), { ...data, count: 6 });
}));

test("GET /api/highlights matches topic names case-insensitively", () => withServer(async (base) => {
    const response = await fetch(`${base}/api/highlights?topic=aGeNtIc%20SoFtWaRe%20DeVeLoPmEnT`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.count, 2);
    assert.deepEqual(body.highlights.map((item) => item.id), ["copilot-automations", "security-review"]);
}));

test("GET /api/highlights returns an empty list for unknown names, slugs, and empty topics", () => withServer(async (base) => {
    for (const topic of ["unknown", "agentic-software-development", ""]) {
        const response = await fetch(`${base}/api/highlights?topic=${encodeURIComponent(topic)}`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { event: loadHighlights().event, count: 0, highlights: [] });
    }
}));

test("GET /api/topics returns ordered topic names, slugs, and counts with CORS", () => withServer(async (base) => {
    const response = await fetch(`${base}/api/topics`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(await response.json(), {
        topics: [
            { name: "The modern GitHub experience", slug: "the-modern-github-experience", count: 3 },
            { name: "Open source maintainers", slug: "open-source-maintainers", count: 1 },
            { name: "Agentic software development", slug: "agentic-software-development", count: 2 },
        ],
    });
}));

test("GET /api/highlights/:id returns one highlight or 404", () => withServer(async (base) => {
    const found = await fetch(`${base}/api/highlights/stacked-pull-requests`);
    assert.equal((await found.json()).tryIt, "gh stack");
    assert.equal((await fetch(`${base}/api/highlights/nope`)).status, 404);
}));
