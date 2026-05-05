// Measures browser Training Lab it/s and ticksPerSecond after a fixed window.
// Optionally captures a CPU profile via the Chrome DevTools Protocol.
import { startDevServer, launchBrowser, collectPageErrors } from "../tests/browser/helper.mjs";
import { writeFileSync } from "node:fs";

const ALGO = process.env.ALGO ?? "ppo"; // comma-separated
const RUN_MS = Number.parseInt(process.env.RUN_MS ?? "12000", 10);
const PROFILE = process.env.PROFILE === "1";
const PROFILE_OUT = process.env.PROFILE_OUT ?? "tmp/cpu-profile.cpuprofile";

const server = await startDevServer();
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  collectPageErrors(page);
  await page.goto(server.url, { waitUntil: "load" });

  // Open the Training Lab panel.
  await page.click("#open-ppo");
  // Make sure only the requested algo is selected.
  await page.evaluate((algo) => {
    const wanted = new Set(algo.split(","));
    const checks = document.querySelectorAll('input[type="checkbox"][data-algo-checkbox]');
    for (const c of checks) {
      const want = wanted.has(c.dataset.algoCheckbox);
      if (c.checked !== want) c.click();
    }
  }, ALGO).catch(() => {});

  // Click the Start button.
  await page.click("#start-ppo");

  let profilePromise = null;
  let client = null;
  if (PROFILE) {
    client = await page.target().createCDPSession();
    await client.send("Profiler.enable");
    await client.send("Profiler.start");
  }

  await new Promise((r) => setTimeout(r, RUN_MS));

  if (PROFILE) {
    const { profile } = await client.send("Profiler.stop");
    writeFileSync(PROFILE_OUT, JSON.stringify(profile));
    console.log(`wrote profile -> ${PROFILE_OUT}`);
  }

  // Read trainer history from the page.
  const stats = await page.evaluate((algo) => {
    // Try to expose trainer histories via window.__labStats if main.js sets it.
    const dbg = window.__labStats?.();
    return { dbg, rowsRaw: (() => null)() };
  }, ALGO);
  console.log("dbg:", JSON.stringify(stats.dbg, null, 2));
  const rowsScrape = await page.evaluate((algo) => {
    // The trainers map is module-scoped; expose via a known path if available.
    // Fallback: scrape It/s from the stats row DOM.
    const rows = [...document.querySelectorAll(".ppo-algo-row")];
    const entries = rows.map((row) => {
      const name = row.querySelector(".algo-name")?.textContent?.trim().split("\n")[0] ?? "?";
      const stats = [...row.querySelectorAll(".algo-stat")].map((s) => ({
        label: s.querySelector("small")?.textContent ?? "",
        value: s.querySelector("strong")?.textContent ?? "",
      }));
      return { name, stats };
    });
    return { rows: entries };
  }, ALGO);
  console.log("rows:", JSON.stringify(rowsScrape, null, 2));
} finally {
  await browser.close().catch(() => {});
  await server.stop().catch(() => {});
}
