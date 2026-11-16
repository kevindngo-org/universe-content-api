import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fields = ["id", "topic", "title", "summary", "tryIt"];

function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateHighlight(item, context) {
    if (!isRecord(item) || fields.some((field) => typeof item[field] !== "string" || !item[field])) {
        throw new Error(`${context}: expected non-empty string fields ${fields.join(", ")}`);
    }
    if (!/^[a-z0-9-]+$/.test(item.id)) throw new Error(`${context}: invalid highlight id`);
}

export async function smokeTest(baseUrl) {
    let base;
    try {
        base = new URL(baseUrl);
    } catch {
        throw new Error("Provide a valid HTTP(S) API base URL");
    }
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password ||
        base.pathname !== "/" || base.search || base.hash) {
        throw new Error("API base URL must be an HTTP(S) origin without credentials, path, query, or fragment");
    }

    async function get(path, status) {
        let response;
        try {
            response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(10000) });
        } catch (error) {
            throw new Error(`${path}: request failed: ${error.message}`, { cause: error });
        }
        if (response.status !== status) {
            throw new Error(`${path}: expected HTTP ${status}, received ${response.status}`);
        }
        try {
            return await response.json();
        } catch (error) {
            throw new Error(`${path}: invalid JSON: ${error.message}`, { cause: error });
        }
    }

    const health = await get("/health", 200);
    if (!isRecord(health) || health.ok !== true) throw new Error("/health: expected { ok: true }");

    const collection = await get("/api/highlights", 200);
    if (!isRecord(collection) || typeof collection.event !== "string" || !collection.event ||
        !Array.isArray(collection.highlights) || collection.highlights.length === 0 ||
        collection.count !== collection.highlights.length) {
        throw new Error("/api/highlights: expected an event and a non-empty highlights array matching count");
    }
    const ids = new Set();
    for (const item of collection.highlights) {
        validateHighlight(item, "/api/highlights");
        if (ids.has(item.id)) throw new Error(`/api/highlights: duplicate id ${item.id}`);
        ids.add(item.id);
    }

    const expected = collection.highlights[0];
    const path = `/api/highlights/${expected.id}`;
    const item = await get(path, 200);
    validateHighlight(item, path);
    for (const field of fields) {
        if (!isDeepStrictEqual(item[field], expected[field])) {
            throw new Error(`${path}: ${field} does not match the collection`);
        }
    }

    let missing = "smoke-test-unknown-highlight";
    while (ids.has(missing)) missing += "-unknown";
    const missingPath = `/api/highlights/${missing}`;
    const notFound = await get(missingPath, 404);
    if (!isRecord(notFound) || notFound.error !== "Highlight not found") {
        throw new Error(`${missingPath}: expected a Highlight not found error`);
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        if (process.argv.length !== 3) throw new Error("Usage: node api-smoke.mjs <API base URL>");
        await smokeTest(process.argv[2]);
        console.log("API smoke checks passed");
    } catch (error) {
        console.error(`API smoke checks failed: ${error.message}`);
        process.exitCode = 1;
    }
}
