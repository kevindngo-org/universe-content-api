# universe-content-api

Read-only content API for the GitHub Universe '26 landing page in [kevindngo-org/virtual-universe-26](https://github.com/kevindngo-org/virtual-universe-26). It is the second repository in the multi-repo Copilot Project demo.

```sh
npm start   # http://localhost:3001 (set PORT to change)
npm test
```

| Endpoint | Returns |
| --- | --- |
| `GET /health` | `{ "ok": true }` |
| `GET /api/highlights` | `{ event, count, highlights: [{ id, topic, title, summary, tryIt }] }`; optionally filter with `?topic=<topic name>` (case-insensitive) |
| `GET /api/topics` | `{ topics: [{ name, slug, count }] }`, ordered by first appearance in the highlights |
| `GET /api/highlights/:id` | One highlight, or `404` |

For example:

```sh
curl 'http://localhost:3001/api/highlights?topic=Agentic%20software%20development'
curl 'http://localhost:3001/api/topics'
```

An unknown topic returns the normal highlights response with `count: 0` and an empty `highlights` array. Demo run of show and reset instructions: [demo/DEMO.md](demo/DEMO.md).
