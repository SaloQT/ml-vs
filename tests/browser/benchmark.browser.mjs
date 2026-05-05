// Smoke tests for benchmark.html (multi-algorithm training dashboard).
import { test } from "node:test";
import assert from "node:assert/strict";
import { withBrowserContext, collectPageErrors } from "./helper.mjs";

test("benchmark.html loads with no console errors or page exceptions", async (t) => {
  await withBrowserContext(t, async ({ server, browser }) => {
    const page = await browser.newPage();
    const { errors, exceptions } = collectPageErrors(page);
    const response = await page.goto(`${server.url}/benchmark.html`, {
      waitUntil: "networkidle2",
      timeout: 15000,
    });
    assert.equal(response.status(), 200, "benchmark.html should serve 200");

    for (const sel of ["#start", "#stop", "#reset", "#iters", "#batch", "#cards"]) {
      const found = await page.$(sel);
      assert.ok(found, `missing #${sel} on benchmark page`);
    }

    // Cards for individual algorithms should be rendered.
    const cardCount = await page.$$eval("#cards .card, #cards > *", (els) => els.length);
    assert.ok(cardCount > 0, "expected algorithm cards to render");

    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(exceptions, [], `unexpected page exceptions:\n${exceptions.join("\n---\n")}`);
    assert.deepEqual(errors, [], `unexpected console errors:\n${errors.join("\n---\n")}`);
  });
});
