# universe-content-api

Read-only Node.js (no dependencies) API that serves GitHub Universe '26 keynote highlights to the landing page in `kevindngo-org/virtual-universe-26` (`docs/index.html`).

- The response shape of `GET /api/highlights` is a contract with that landing page. When you change it, describe the change in the PR so the frontend session can match it, and keep existing fields backward compatible.
- Keep the server dependency-free (`node:http`). Run `npm test` (`node --test`) before finishing.
- Highlight content lives in `data/keynote-highlights.json`; ids are derived from titles.
- `demo/` holds demo-only tooling. Don't change it during feature work.
