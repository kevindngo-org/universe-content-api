# API smoke test

Run the standalone client with Node.js 20 or later:

```sh
node api-smoke.mjs https://api.example.com
```

Provide the API's HTTP(S) origin, without a path. The client checks health,
the highlight collection, one listed highlight, and an unknown highlight.
It reports errors and exits nonzero if any check fails.

Run the focused tests with `node --test tests/smoke-test.test.mjs`.
