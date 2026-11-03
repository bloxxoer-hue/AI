import { getSession, saveSession, freshSession, waitUntil } from "../session.js";
import { humanFill, humanClick, sleep } from "../human.js";
import { snapshotMedia, waitForResult, makeTmpFile, cleanupTmp } from "../media.js";
import { registerH3 } from "../register.js";

const SITE = "h3max";
const HOME = "https://h3-max.me/";

async function isLoggedIn(page) {
  if (!page.url().includes("h3-max.me")) return false;
  const header = page.locator("header").first();
  if (!(await header.isVisible().catch(() => false))) return false;
  const signIn = page.locator('header button:has-text("Sign in")');
  const n = await signIn.count();
  if (n === 0) return true;
  return !(await signIn.first().isVisible().catch(() => false));
}

async function ensureLogin(page, onProgress) {
  if (await isLoggedIn(page)) return;
  onProgress?.("h3-max: нужен вход — залогинься в открытом окне браузера (первый и последний раз)");
  const btn = page.locator('header button:has-text("Sign in")').first();
  await humanClick(btn).catch(() => {});
  const ok = await waitUntil(() => isLoggedIn(page), {
    timeout: 5 * 60 * 1000,
    interval: 2500,
    message: "h3-max: жду входа на сайте...",
    onProgress,
  });
  if (!ok) throw new Error("h3-max: вход не выполнен");
  await saveSession(SITE);
  onProgress?.("h3-max: вход сохранён, дальше автоматически");
}

export async function openLogin(onProgress) {
  const { page } = await getSession(SITE);
  await page.goto(HOME, { waitUntil: "domcontentloaded" });
  const btn = page.locator('header button:has-text("Sign in")').first();
  if (await btn.isVisible().catch(() => false)) await humanClick(btn);
  onProgress?.("h3-max: окно открыто, залогинься");
}

/** prompt, duration 1-8, aspectRatio, imageBase64? */
export async function generate({ prompt, duration, aspectRatio, imageBase64, imageMime }, onProgress) {
  const imageMode = Boolean(imageBase64);
  const label = "h3-max";

  // каждый запрос — свежий контекст = новый аккаунт через temp-почту
  let owned = await freshSession();
  let page = owned.page;
  let ctx = owned.context;
  let tmp = null;

  try {
    onProgress?.(`${label}: открываем h3-max...`);
    await page.goto(HOME, { waitUntil: "domcontentloaded" });
    await sleep(1500);

    if (!(await isLoggedIn(page))) {
      try {
        onProgress?.(`${label}: аккаунта нет — регистрируем новый через temp-почту...`);
        await registerH3(page, onProgress);
        await saveSession(SITE, { context: ctx });
      } catch (err) {
        onProgress?.(`${label}: авто-регистрация не удалась (${err.message}) — пробуем сохранённый вход`);
        await ctx.close().catch(() => {});
        const s = await getSession(SITE);
        page = s.page;
        ctx = null;
        await page.goto(HOME, { waitUntil: "domcontentloaded" });
        await ensureLogin(page, onProgress);
      }
    }

    onProgress?.(`${label}: открываем генератор...`);
    await page.goto(`${HOME}?mode=${imageMode ? "image" : "text"}#generator`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("textarea", { timeout: 30000 });

    const baseline = await snapshotMedia(page);

    if (imageMode) await humanClick(page.locator("#tab-image")).catch(() => {});
    else await humanClick(page.locator("#tab-text")).catch(() => {});

    onProgress?.(`${label}: вписываем промпт...`);
    const ta = page.locator("textarea").first();
    await humanFill(ta, prompt);

    const dur = String(Math.min(8, Math.max(5, Number(duration) || 6)));
    const sel = page.locator('select[name="duration"]');
    if ((await sel.count()) > 0) {
      await sel.selectOption(dur).catch(async () => {
        await sel.selectOption({ index: 0 }).catch(() => {});
      });
      await sleep(300);
    }

    if (aspectRatio) {
      const ar = page.getByRole("button", { name: aspectRatio, exact: true }).first();
      if ((await ar.count()) > 0 && (await ar.isVisible().catch(() => false))) {
        await humanClick(ar).catch(() => {});
      }
    }

    if (imageMode) {
      onProgress?.(`${label}: загружаем фото...`);
      tmp = makeTmpFile(imageBase64, imageMime);
      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.setInputFiles(tmp).catch((e) => {
        cleanupTmp(tmp);
        tmp = null;
        throw e;
      });
      await sleep(1500);
    }

    onProgress?.(`${label}: нажимаем Generate...`);
    const gen = page.locator('button').filter({ hasText: /^Generate/ }).first();
    await humanClick(gen);

    // подстраховка: если вылезла стена входа — логинимся и жмём ещё раз
    await sleep(2500);
    const wall = page.locator('button:has-text("Sign in to generate")');
    if ((await wall.count()) > 0 && (await wall.first().isVisible().catch(() => false))) {
      await ensureLogin(page, onProgress);
      await humanClick(gen);
    }

    onProgress?.(`${label}: генерация идёт на стороне сайта...`);
    return await waitForResult(page, baseline, { onProgress, label, timeout: 12 * 60 * 1000 });
  } finally {
    if (tmp) setTimeout(() => cleanupTmp(tmp), 60000);
    if (ctx) await ctx.close().catch(() => {});
  }
}

export async function status() {
  const { page } = await getSession(SITE);
  if (page.url().includes("h3-max.me")) return (await isLoggedIn(page)) ? "in" : "out";
  return "untouched";
}
