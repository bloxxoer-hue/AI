// patchright — playwright без его следов (CDP-сигнатуры, аргументы запуска):
// slice молча не даёт триал «подозрительным» клиентам, ручной проход — даёт
let chromium;
try {
  ({ chromium } = await import("patchright"));
} catch {
  ({ chromium } = await import("playwright"));
}
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sleep } from "./human.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, "..");
const STATE_DIR = path.join(__dirname, "state");
fs.mkdirSync(STATE_DIR, { recursive: true });

let browser = null;
const sessions = new Map();

// живой Chrome под Windows: без HeadlessChrome в UA — slice молча не даёт
// триал «нештатным» клиентам, поэтому профиль обязан выглядеть обычным
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

async function ensureBrowser() {
  if (browser) return browser;
  const opts = {
    headless: process.env.HEADLESS === "1",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  };
  try {
    browser = await chromium.launch({ ...opts, channel: "chrome" });
  } catch {
    try {
      browser = await chromium.launch(opts);
    } catch (err) {
      throw new Error(
        /executable|browser/i.test(err.message)
          ? "браузер не установлен — выполни: npx playwright install chromium (или поставь Google Chrome)"
          : err.message
      );
    }
  }
  return browser;
}

async function makeContext(storageState) {
  const b = await ensureBrowser();
  const context = await b.newContext({
    viewport: { width: 1360, height: 940 },
    locale: "ru-RU",
    userAgent: UA,
    ...(storageState ? { storageState } : {}),
  });
  const pages = context.pages();
  const page = pages[0] || (await context.newPage());
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  return { context, page };
}

export async function getSession(site) {
  if (sessions.has(site)) return sessions.get(site);

  const stateFile = path.join(STATE_DIR, `${site}.json`);
  const entry = await makeContext(fs.existsSync(stateFile) ? stateFile : undefined);
  const full = { ...entry, site };
  sessions.set(site, full);
  return full;
}

/** свежий контекст без сохранённых кук — каждый запрос со своим новым аккаунтом */
export async function freshSession(storageState) {
  return await makeContext(storageState);
}

export async function saveSession(site, entry = sessions.get(site)) {
  if (!entry) return;
  const stateFile = path.join(STATE_DIR, `${site}.json`);
  await entry.context.storageState({ path: stateFile });
}

export function hasSession(site) {
  return sessions.has(site);
}

export function stateExists(site) {
  return fs.existsSync(path.join(STATE_DIR, `${site}.json`));
}

/** опрос состояния: возвращает true, когда predicate выполнен */
export async function waitUntil(predicate, { timeout = 60000, interval = 2000, onProgress, message } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await predicate()) return true;
    } catch {}
    if (message) onProgress?.(message);
    await sleep(interval);
  }
  return false;
}

export async function closeAll() {
  for (const { context } of sessions.values()) await context.close().catch(() => {});
  sessions.clear();
  if (browser) await browser.close().catch(() => {});
  browser = null;
}
