// Smoke test: every src/*.js module must load without throwing at import time.
// Catches the class of bug where module-level code (TDZ self-references, bad
// constants, mistyped imports) breaks browser-only modules without surfacing
// in any unit test, since node --test only loads what tests import.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

// Stub browser globals before importing, so modules that read document/window/
// Image/HTMLCanvasElement at module load do not crash. Module-level access to
// these is rare and usually unintentional; instance code (constructors) runs
// later in real browser use, so we don't need to stub the whole DOM.
function installBrowserStubs() {
  const noop = () => {};
  const stubCtx = new Proxy({}, { get: () => noop });
  const stubCanvas = {
    getContext: () => stubCtx,
    width: 0,
    height: 0,
    addEventListener: noop,
  };
  const stubDocument = {
    createElement: () => stubCanvas,
    getElementById: () => stubCanvas,
    addEventListener: noop,
    body: { appendChild: noop, addEventListener: noop },
    documentElement: { style: {} },
  };
  const stubWindow = {
    addEventListener: noop,
    requestAnimationFrame: noop,
    location: { href: "" },
    devicePixelRatio: 1,
  };
  if (typeof globalThis.document === "undefined") globalThis.document = stubDocument;
  if (typeof globalThis.window === "undefined") globalThis.window = stubWindow;
  if (typeof globalThis.Image === "undefined") globalThis.Image = class { constructor() {} };
  if (typeof globalThis.HTMLCanvasElement === "undefined") globalThis.HTMLCanvasElement = class {};
  if (typeof globalThis.HTMLImageElement === "undefined") globalThis.HTMLImageElement = class {};
  if (typeof globalThis.OffscreenCanvas === "undefined") globalThis.OffscreenCanvas = class { constructor() {} getContext() { return stubCtx; } };
  if (typeof globalThis.requestAnimationFrame === "undefined") globalThis.requestAnimationFrame = noop;
  if (typeof globalThis.localStorage === "undefined") {
    globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop, clear: noop };
  }
}

installBrowserStubs();

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");
const files = readdirSync(srcDir)
  .filter((f) => f.endsWith(".js"))
  // main.js is the app entry point; it wires up DOM event listeners and game
  // bootstrap at module load. Skipping is fine — its top-level imports are
  // covered by the rest of the suite.
  .filter((f) => f !== "main.js")
  // ppoNodeRolloutWorker.js intentionally throws at module load if not run
  // inside a worker_threads worker — that guard is by design, not a bug.
  .filter((f) => f !== "ppoNodeRolloutWorker.js");

for (const file of files) {
  test(`module loads: src/${file}`, async () => {
    const url = pathToFileURL(join(srcDir, file)).href;
    // Cache-bust per test so a previously failed partial load does not mask a
    // later test (ESM caches successful imports; failed ones throw fresh).
    const mod = await import(`${url}?smoke=${Date.now()}-${file}`);
    assert.ok(mod, `expected non-null module for ${file}`);
  });
}
