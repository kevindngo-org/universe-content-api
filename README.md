# universe-content-api

Read-only content API for the GitHub Universe '26 landing page in [kevindngo-org/virtual-universe-26](https://github.com/kevindngo-org/virtual-universe-26). It is the second repository in the multi-repo Copilot Project demo.

```sh
npm start   # http://localhost:3001 (set PORT to change)
npm test
```

| Endpoint | Returns |
| --- | --- |
| `GET /health` | `{ "ok": true }` |
| `GET /api/highlights` | `{ event, count, highlights: [{ id, topic, title, summary, tryIt }] }`; optional `?topic=<name>` filters by exact topic name, case-insensitively |
| `GET /api/topics` | `{ topics: [{ name, slug, count }] }`, in order of first appearance in the highlights data |
| `GET /api/highlights/:id` | One highlight, or `404` |

An unknown topic returns `200` with the event, `count: 0`, and an empty `highlights` array. For example, `/api/highlights?topic=agentic%20software%20development` returns the two highlights for that topic. Demo run of show and reset instructions: [demo/DEMO.md](demo/DEMO.md).
