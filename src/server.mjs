import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadHighlights, slugify } from "./highlights.mjs";

function send(res, status, body) {
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        // Public, read-only content consumed by the static landing page on another origin.
        "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(body));
}

export function createApp({ data = loadHighlights() } = {}) {
    const topics = new Map();
    for (const { topic } of data.highlights) {
        const existing = topics.get(topic);
        if (existing) existing.count += 1;
        else topics.set(topic, { name: topic, slug: slugify(topic), count: 1 });
    }

    return createServer((req, res) => {
        const url = new URL(req.url, "http://localhost");
        if (url.pathname === "/health") return send(res, 200, { ok: true });
        if (url.pathname === "/api/topics") {
            return send(res, 200, { topics: [...topics.values()] });
        }
        if (url.pathname === "/api/highlights") {
            const topic = url.searchParams.get("topic");
            const highlights = topic === null
                ? data.highlights
                : data.highlights.filter((item) => item.topic.toLowerCase() === topic.toLowerCase());
            return send(res, 200, { event: data.event, count: highlights.length, highlights });
        }
        const match = url.pathname.match(/^\/api\/highlights\/([a-z0-9-]+)$/);
        if (match) {
            const item = data.highlights.find((highlight) => highlight.id === match[1]);
            return item ? send(res, 200, item) : send(res, 404, { error: "Highlight not found" });
        }
        send(res, 404, { error: "Not found" });
    });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const port = Number(process.env.PORT) || 3001;
    createApp().listen(port, () => console.log(`universe-content-api listening on http://localhost:${port}`));
}
