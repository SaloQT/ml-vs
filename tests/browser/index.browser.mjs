// Smoke tests for index.html (main game page).
// Catches: import-graph regressions (e.g. node:url in browser modules),
// "process is not defined" ReferenceErrors, missing buttons, click handler throws.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withBrowserContext, collectPageErrors } from "./helper.mjs";

test("index.html loads with no console errors or page exceptions", async (t) => {
  await withBrowserContext(t, async ({ server, browser }) => {
    const page = await browser.newPage();
    const { errors, exceptions } = collectPageErrors(page);

    const response = await page.goto(`${server.url}/index.html`, {
      waitUntil: "networkidle2",
      timeout: 15000,
    });
    assert.equal(response.status(), 200, "index.html should serve 200");

    // Wait for main.js to finish initial setup (menu rendered).
    await page.waitForSelector("#main-menu", { timeout: 5000 });
    await page.waitForSelector("#open-ppo", { timeout: 5000 });

    // Give modules a moment to settle (any async bootstrap throws will surface).
    await new Promise((r) => setTimeout(r, 500));

    assert.deepEqual(exceptions, [], `unexpected page exceptions:\n${exceptions.join("\n---\n")}`);
    assert.deepEqual(errors, [], `unexpected console errors:\n${errors.join("\n---\n")}`);
  });
});

test("index.html exposes core menu buttons and PPO Lab opens without errors", async (t) => {
  await withBrowserContext(t, async ({ server, browser }) => {
    const page = await browser.newPage();
    const { errors, exceptions } = collectPageErrors(page);
    await page.goto(`${server.url}/index.html`, { waitUntil: "networkidle2", timeout: 15000 });

    for (const sel of ["#open-armory", "#open-options", "#open-ppo"]) {
      const found = await page.$(sel);
      assert.ok(found, `missing button ${sel}`);
    }

    // Open the PPO Lab and confirm the panel becomes visible.
    await page.click("#open-ppo");
    await page.waitForFunction(
      () => {
        const el = document.querySelector("#ppo-panel");
        return el && !el.classList.contains("hidden");
      },
      { timeout: 3000 },
    );
    await page.waitForSelector("#start-ppo", { timeout: 3000 });

    // Open Options panel.
    await page.click("#close-ppo");
    await page.click("#open-options");
    await page.waitForFunction(
      () => {
        const el = document.querySelector("#options-panel");
        return el && !el.classList.contains("hidden");
      },
      { timeout: 3000 },
    );
    await page.click("#close-options");

    assert.deepEqual(exceptions, [], `unexpected page exceptions:\n${exceptions.join("\n---\n")}`);
    assert.deepEqual(errors, [], `unexpected console errors:\n${errors.join("\n---\n")}`);
  });
});

test("Training Lab multi-algo checkboxes exist and concurrent training works", async (t) => {
  await withBrowserContext(t, async ({ server, browser }) => {
    const page = await browser.newPage();
    const { errors, exceptions } = collectPageErrors(page);
    await page.goto(`${server.url}/index.html`, { waitUntil: "networkidle2", timeout: 15000 });

    await page.click("#open-ppo");
    await page.waitForSelector("[data-algo-checkbox='ppo']", { timeout: 3000 });

    // Verify all four checkboxes exist.
    const algos = await page.$$eval("[data-algo-checkbox]", (els) => els.map((e) => e.dataset.algoCheckbox));
    assert.deepEqual(algos.sort(), ["a2c", "dqn", "ppo", "reinforce"]);

    // Default has only PPO checked (single-algo behavior preserved).
    const initialChecked = await page.$$eval("[data-algo-checkbox]", (els) =>
      els.filter((e) => e.checked).map((e) => e.dataset.algoCheckbox),
    );
    assert.deepEqual(initialChecked, ["ppo"], "default selection should be PPO only");

    // Enable DQN as well (so we have 2 algos).
    await page.click("[data-algo-checkbox='dqn']");

    // Reduce batch / episode length for speed.
    await page.evaluate(() => {
      const set = (id, val) => {
        const el = document.querySelector(`#${id}`);
        if (!el) return;
        el.value = val;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };
      set("ppo-workers", "1");
      set("ppo-batch", "1");
      set("ppo-game-length", "10");
      set("ppo-warmup", "0");
    });

    // Start; both algos should kick off.
    await page.click("#start-ppo");
    await new Promise((r) => setTimeout(r, 4000));
    await page.click("#start-ppo");

    // Two stats rows should be rendered.
    const rows = await page.$$eval("#ppo-stats-rows .ppo-algo-row", (els) =>
      els.map((row) => ({
        algo: row.dataset.algoKey,
        iter: Number(row.querySelector(".algo-stat strong")?.textContent ?? "0"),
      })),
    );
    assert.equal(rows.length, 2, "two stats rows should be rendered for two enabled algos");
    const nonZeroIter = rows.filter((r) => r.iter > 0).length;
    assert.ok(nonZeroIter >= 2, `expected both algo rows to have non-zero iter, got ${JSON.stringify(rows)}`);

    assert.deepEqual(exceptions, [], `unexpected page exceptions:\n${exceptions.join("\n---\n")}`);
    assert.deepEqual(errors, [], `unexpected console errors:\n${errors.join("\n---\n")}`);
  });
});

test("PPO start button triggers training tick without exceptions", async (t) => {
  await withBrowserContext(t, async ({ server, browser }) => {
    const page = await browser.newPage();
    const { errors, exceptions } = collectPageErrors(page);
    await page.goto(`${server.url}/index.html`, { waitUntil: "networkidle2", timeout: 15000 });

    await page.click("#open-ppo");
    await page.waitForSelector("#start-ppo", { timeout: 3000 });

    // Reduce workers + game length to keep this fast & deterministic.
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
    // Wait briefly to let at least one rollout tick start; we are not asserting
    // an iteration completes (could be slow), only that nothing crashes.
    await new Promise((r) => setTimeout(r, 2500));

    assert.deepEqual(
      exceptions,
      [],
      `unexpected page exceptions during PPO start:\n${exceptions.join("\n---\n")}`,
    );
    // Some console errors during training (e.g. log spam) could be acceptable in
    // future, but for now we want a clean baseline that catches regressions.
    assert.deepEqual(
      errors,
      [],
      `unexpected console errors during PPO start:\n${errors.join("\n---\n")}`,
    );
  });
});
