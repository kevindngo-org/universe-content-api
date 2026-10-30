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
    assert.equal(body.highlights.length, 6);
}));

test("GET /api/highlights/:id returns one highlight or 404", () => withServer(async (base) => {
    const found = await fetch(`${base}/api/highlights/stacked-pull-requests`);
    assert.equal((await found.json()).tryIt, "gh stack");
    assert.equal((await fetch(`${base}/api/highlights/nope`)).status, 404);
}));
