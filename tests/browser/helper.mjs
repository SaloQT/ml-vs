// Shared helpers for browser smoke tests.
// Spawns the dev server on an ephemeral port and launches headless Chrome
// via puppeteer-core, using whichever Chrome/Chromium binary the host already has.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");

function findFreePort() {
  return new Promise((resolveP, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolveP(port));
    });
  });
}

function findChromeExecutable() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const candidates = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

export async function startDevServer() {
  const port = await findFreePort();
  const child = spawn(process.execPath, ["scripts/dev-server.mjs"], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolveP, reject) => {
    const onErr = (err) => reject(err);
    child.once("error", onErr);
    child.stdout.on("data", (buf) => {
      if (buf.toString().includes("Serving")) {
        child.off("error", onErr);
        resolveP();
      }
    });
    child.stderr.on("data", () => {});
    setTimeout(() => reject(new Error("dev server did not start in time")), 5000).unref();
  });
  return {
    url: `http://127.0.0.1:${port}`,
    async stop() {
      if (!child.killed) child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
    },
  };
}

export async function launchBrowser() {
  const exe = findChromeExecutable();
  if (!exe) {
    const e = new Error("No Chrome/Chromium executable found; skipping browser tests");
    e.code = "NO_BROWSER";
    throw e;
  }
  const puppeteer = (await import("puppeteer-core")).default;
  try {
    return await puppeteer.launch({
      executablePath: exe,
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });
  } catch (err) {
    const e = new Error(`Failed to launch headless Chrome: ${err.message}`);
    e.code = "NO_BROWSER";
    throw e;
  }
}

// Returns { errors, exceptions } collectors and attaches listeners.
export function collectPageErrors(page) {
  const errors = [];
  const exceptions = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const loc = msg.location && msg.location();
    const url = (loc && loc.url) || "";
    // Browser auto-requests /favicon.ico; we don't ship one. Ignore that noise.
    if (url.endsWith("/favicon.ico")) return;
    const text = msg.text();
    if (text.includes("favicon.ico")) return;
    errors.push(text);
  });
  page.on("pageerror", (err) => {
    exceptions.push(err.stack || err.message || String(err));
  });
  page.on("requestfailed", (req) => {
    // Ignore favicon/data requests; report module/script failures.
    const url = req.url();
    if (url.startsWith("data:") || url.endsWith("favicon.ico")) return;
    const failure = req.failure();
    errors.push(`requestfailed ${url}: ${failure ? failure.errorText : "unknown"}`);
  });
  return { errors, exceptions };
}

export async function withBrowserContext(t, fn) {
  let server;
  let browser;
  try {
    server = await startDevServer();
  } catch (err) {
    t.skip(`could not start dev server: ${err.message}`);
    return;
  }
  try {
    browser = await launchBrowser();
  } catch (err) {
    await server.stop();
    if (err.code === "NO_BROWSER") {
      t.skip(err.message);
      return;
    }
    throw err;
  }
  try {
    await fn({ server, browser });
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await server.stop().catch(() => {});
  }
}
