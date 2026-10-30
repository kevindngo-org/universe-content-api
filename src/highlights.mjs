import { readFileSync } from "node:fs";

const DATA_URL = new URL("../data/keynote-highlights.json", import.meta.url);

export const slugify = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function loadHighlights(url = DATA_URL) {
    const { event, highlights } = JSON.parse(readFileSync(url, "utf8"));
    return {
        event,
        highlights: highlights.map((item) => ({ id: slugify(item.title), ...item })),
    };
}
// throwaway
