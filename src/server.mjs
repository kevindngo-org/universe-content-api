import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadHighlights } from "./highlights.mjs";

function send(res, status, body) {
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        // Public, read-only content consumed by the static landing page on another origin.
        "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(body));
}

export function createApp({ data = loadHighlights() } = {}) {
    return createServer((req, res) => {
        const url = new URL(req.url, "http://localhost");
        if (url.pathname === "/health") return send(res, 200, { ok: true });
        if (url.pathname === "/api/highlights") {
            return send(res, 200, { event: data.event, count: data.highlights.length, highlights: data.highlights });
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
