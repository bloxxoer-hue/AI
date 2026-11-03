// patchright — playwright без его следов (CDP-сигнатуры, аргументы запуска):
// slice молча не даёт триал «подозрительным» клиентам, ручной проход — даёт.
// на сервере patchright-браузера может не быть — есть откат на обычный playwright
let primary = null;
let fallback = null;
try { primary = (await import("patchright")).chromium; } catch {}
try { fallback = (await import("playwright")).chromium; } catch {}
if (!primary && !fallback) throw new Error("playwright не установлен — выполни: npm install");
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

  // linux (сервер) — всегда headless: дисплея нет, а переменная может быть не задана
  const headless = process.env.HEADLESS === "1" || process.platform === "linux";
  const args = [
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
  ];

  const errors = [];
  for (const mod of [primary, fallback].filter(Boolean)) {
    for (const opts of [{ channel: "chrome" }, {}]) {
      try {
        browser = await mod.launch({ ...opts, headless, args });
        return browser;
      } catch (e) {
        errors.push(e.message.split("\n")[0].slice(0, 160));
      }
    }
  }
  throw new Error(
    "браузер не установлен — выполни: npx playwright install chromium (или поставь Google Chrome). Причина: "
      + (errors[errors.length - 1] || "нет деталей")
  );
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
