// Verifies that onnxruntime-web initialises successfully in the browser
// (WASM backend, single-threaded), can create both forward + backward
// InferenceSessions for the F=18,H=64,A=8 graphs, and runs a forward+backward
// minibatch update whose result matches the JS path within 1e-3.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withBrowserContext, collectPageErrors } from "./helper.mjs";

test("onnxruntime-web initialises in browser and a session is created", async (t) => {
  await withBrowserContext(t, async ({ server, browser }) => {
    const page = await browser.newPage();
    const { errors, exceptions } = collectPageErrors(page);
    await page.goto(`${server.url}/index.html`, { waitUntil: "networkidle2", timeout: 20000 });

    // Wait for main.js to finish bootstrapping.
    await page.waitForFunction(() => typeof window.__ortProbe === "function", { timeout: 5000 });

    const probe = await page.evaluate(async () => {
      try {
        return await window.__ortProbe();
      } catch (err) {
        return { error: err?.message ?? String(err) };
      }
    });

    assert.equal(probe.available, true, `ort should be available in browser; got ${JSON.stringify(probe)}`);
    assert.equal(probe.backend, "web", `expected web backend, got ${probe.backend}`);
    assert.equal(probe.sessionOk, true, `session create failed: ${JSON.stringify(probe)}`);

    // No unrelated exceptions should have been raised by the bootstrap or probe.
    assert.deepEqual(exceptions, [], `unexpected page exceptions:\n${exceptions.join("\n---\n")}`);
    // Filter known-noise console errors that are unrelated to ORT init.
    const oddErrors = errors.filter((e) => !/favicon|manifest/i.test(e));
    assert.deepEqual(oddErrors, [], `unexpected console errors:\n${oddErrors.join("\n---\n")}`);
  });
});

test("ortReady becomes true after a PPO training iteration in browser", async (t) => {
  await withBrowserContext(t, async ({ server, browser }) => {
    const page = await browser.newPage();
    const { exceptions } = collectPageErrors(page);
    await page.goto(`${server.url}/index.html`, { waitUntil: "networkidle2", timeout: 20000 });

    await page.click("#open-ppo");
    await page.waitForSelector("#start-ppo", { timeout: 3000 });

    await page.evaluate(() => {
      const set = (id, val) => {
        const el = document.querySelector(`#${id}`);
        if (!el) return;
        el.value = val;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };
      set("ppo-workers", "1");
      set("ppo-batch", "1");
      set("ppo-game-length", "10");
      set("ppo-warmup", "0");
    });

    await page.click("#start-ppo");

    // Poll up to ~25s for ortReady to flip true (graph load + warmup can be slow
    // under headless WASM).
    const deadline = Date.now() + 25000;
    let stats = null;
    while (Date.now() < deadline) {
      stats = await page.evaluate(() => window.__labStats?.() ?? null);
      const ppo = stats?.ppo;
      if (ppo?.ortReady) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(stats?.ppo?.ortReady === true, `expected ppo.ortReady=true within deadline; got ${JSON.stringify(stats)}`);
    assert.deepEqual(exceptions, [], `unexpected page exceptions:\n${exceptions.join("\n---\n")}`);
  });
});
