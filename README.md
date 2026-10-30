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
| `GET /api/highlights/:id` | One highlight, or `404` |

Topic filtering is not built yet; see the open issues. Demo run of show and reset instructions: [demo/DEMO.md](demo/DEMO.md).
