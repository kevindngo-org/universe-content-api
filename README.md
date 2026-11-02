# universe-content-api

Read-only content API for the GitHub Universe '26 landing page in [kevindngo-org/virtual-universe-26](https://github.com/kevindngo-org/virtual-universe-26). It is the second repository in the multi-repo Copilot Project demo.

```sh
npm start   # http://localhost:3001 (set PORT to change)
npm test
```

| Endpoint | Returns |
| --- | --- |
| `GET /health` | `{ "ok": true }` |
| `GET /api/highlights` | `{ event, count, highlights: [{ id, topic, title, summary, tryIt }] }` |
| `GET /api/highlights?topic=<topic name>` | Same response, filtered by case-insensitive topic name; unknown names return `200` with `count: 0` and `highlights: []` |
| `GET /api/topics` | `{ topics: [{ name, slug, count }] }` in the order topics first appear in the highlights |
| `GET /api/highlights/:id` | One highlight, or `404` |

Omit `topic` to return all six sample highlights. Use the URL-encoded topic **name**, not its slug, when filtering:

```sh
curl 'http://localhost:3001/api/highlights?topic=agentic%20software%20development'
curl http://localhost:3001/api/topics
```

Both list endpoints retain cross-origin support for the static landing page. Topic metadata for the samples is ordered as The modern GitHub experience (3), Open source maintainers (1), and Agentic software development (2).

Demo run of show and reset instructions: [demo/DEMO.md](demo/DEMO.md).
