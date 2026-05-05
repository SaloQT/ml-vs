// Compares browser PPO training throughput between the JS fallback path
// (window.__DISABLE_ORT__ = true) and the onnxruntime-web WASM path.
// Reports ticksPerSecond and per-minibatch update latency for each.
//
// Usage:  node scripts/bench-browser-ort.mjs
// Env:    RUN_MS=10000 (per-condition window), ALGO=ppo
import { startDevServer, launchBrowser, collectPageErrors } from "../tests/browser/helper.mjs";

const RUN_MS = Number.parseInt(process.env.RUN_MS ?? "10000", 10);
const ALGO = process.env.ALGO ?? "ppo";

async function runOnce({ disableOrt }) {
  const server = await startDevServer();
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    collectPageErrors(page);
    if (disableOrt) {
      await page.evaluateOnNewDocument(() => {
        window.__DISABLE_ORT__ = true;
      });
    }
    await page.goto(`${server.url}/index.html`, { waitUntil: "networkidle2" });

    // Open Training Lab and select target algo only.
    await page.click("#open-ppo");
    await page.waitForSelector("[data-algo-checkbox='ppo']", { timeout: 3000 });
    await page.evaluate((algo) => {
      const wanted = new Set(algo.split(","));
      for (const c of document.querySelectorAll("[data-algo-checkbox]")) {
        const want = wanted.has(c.dataset.algoCheckbox);
        if (c.checked !== want) c.click();
      }
    }, ALGO);

    // Modest knobs so we get plenty of iterations per RUN_MS window.
    await page.evaluate(() => {
      const set = (id, val) => {
        const el = document.querySelector(`#${id}`);
        if (!el) return;
        el.value = val;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };
      set("ppo-workers", "1");
      set("ppo-batch", "2");
      set("ppo-game-length", "20");
      set("ppo-warmup", "0");
    });

    await page.click("#start-ppo");
    await new Promise((r) => setTimeout(r, RUN_MS));

    const stats = await page.evaluate(() => window.__labStats?.() ?? {});
    return { stats, disableOrt };
  } finally {
    await browser.close().catch(() => {});
    await server.stop().catch(() => {});
  }
}

const a = await runOnce({ disableOrt: true });
const b = await runOnce({ disableOrt: false });

const fmt = (s) => {
  const ppo = s.stats.ppo ?? {};
  return {
    iterations: ppo.iterations,
    ticksPerSecond: ppo.ticksPerSecond,
    elapsedMs: ppo.elapsedMs,
    ticksLast: ppo.ticksLast,
    ortReady: ppo.ortReady,
  };
};

console.log("=== Browser PPO benchmark ===");
console.log(`RUN_MS=${RUN_MS}  ALGO=${ALGO}`);
console.log("\n[JS path] (DISABLE_ORT=1):");
console.log(JSON.stringify(fmt(a), null, 2));
console.log("\n[ORT-Web path]:");
console.log(JSON.stringify(fmt(b), null, 2));

const tpsA = a.stats.ppo?.ticksPerSecond ?? 0;
const tpsB = b.stats.ppo?.ticksPerSecond ?? 0;
const itPerSec = (s) => (s.stats.ppo?.iterations ?? 0) / (RUN_MS / 1000);
console.log(`\nIterations/sec  JS=${itPerSec(a).toFixed(1)}   ORT-Web=${itPerSec(b).toFixed(1)}`);
if (itPerSec(a) > 0) {
  console.log(`ORT-Web vs JS iteration throughput: ${(itPerSec(b) / itPerSec(a)).toFixed(2)}x`);
}
