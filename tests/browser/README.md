# Browser smoke tests

These tests load the project's actual HTML pages in headless Chromium and
verify they boot without errors. They exist to catch regressions that the
Node-only suite (`npm test`) cannot see — for example:

- Top-level imports of Node-only modules (e.g. `import "node:url"`) sneaking
  into a module that the browser's import graph reaches.
- Bare `process.env` references in browser-loaded code, producing
  `ReferenceError: process is not defined`.
- Missing or renamed buttons / DOM elements the UI depends on.
- Click handlers that throw on first invocation.

## Running

```
npm run test:browser
```

The Node-only suite is unchanged:

```
npm test            # 310 tests, no browser
npm run test:browser  # ~4 tests, headless Chromium, ~10s
npm run test:all      # both
```

## Requirements

- Google Chrome or Chromium installed on the host. The tests use
  `puppeteer-core` (no bundled browser download) and auto-detect common
  install paths (`/usr/bin/google-chrome`, `/usr/bin/chromium`, etc.).
  Override with the `PUPPETEER_EXECUTABLE_PATH` env var.
- If no browser is found, or Chrome cannot launch (missing libs in WSL2,
  sandbox issues, etc.), tests are **skipped** with a clear message rather
  than failing — so CI without a browser still goes green.

## Layout

- `helper.mjs` — shared utilities. Spawns the dev server on an ephemeral
  port, launches Chrome, and exposes `withBrowserContext(t, fn)` plus
  `collectPageErrors(page)` for capturing console errors / page exceptions /
  failed network requests.
- `*.browser.mjs` — actual tests. They use the `.browser.mjs` extension so
  Node's default test discovery does **not** pick them up — only the explicit
  `npm run test:browser` script runs them.

## Adding a new test

1. Create `tests/browser/<name>.browser.mjs`.
2. Use the helper:

   ```js
   import { test } from "node:test";
   import assert from "node:assert/strict";
   import { withBrowserContext, collectPageErrors } from "./helper.mjs";

   test("my page boots cleanly", async (t) => {
     await withBrowserContext(t, async ({ server, browser }) => {
       const page = await browser.newPage();
       const { errors, exceptions } = collectPageErrors(page);
       await page.goto(`${server.url}/my-page.html`, { waitUntil: "networkidle2" });
       // ...assertions...
       assert.deepEqual(exceptions, []);
       assert.deepEqual(errors, []);
     });
   });
   ```

3. Add the file to the `test:browser` script in `package.json` (the script
   lists files explicitly so unrelated `.mjs` files in the directory are not
   accidentally executed).

## Guidelines

- Prefer stable selectors: ids (`#start-ppo`) and ARIA roles. Avoid relying
  on visual layout, computed styles, or screenshots.
- Keep individual tests under ~5s. The whole suite should stay under 30s.
- When asserting "no errors", always check **both** `exceptions` (uncaught
  page exceptions) and `errors` (console errors). The two regression classes
  this suite was created for surfaced via different channels — `process is
  not defined` was a `pageerror`, while a bad `node:url` import showed up as
  a failed module fetch in the console.
- If a test legitimately produces a console error (e.g. an expected 404
  during a fetch test), filter it explicitly inside the test body rather
  than loosening the global filters in `helper.mjs`.
