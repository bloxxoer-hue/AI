import { getSession, saveSession, freshSession, waitUntil } from "../session.js";
import { humanFill, humanClick, sleep } from "../human.js";
import { snapshotMedia, waitForResult, makeTmpFile, cleanupTmp } from "../media.js";
import { registerPolyfaced } from "../register.js";

const SITE = "polyface";
const STUDIO_VIDEO = "https://polyfaced.com/studio/video";
const STUDIO_IMAGE = "https://polyfaced.com/studio/image";

async function isLoggedIn(page) {
  const url = page.url();
  if (/\/sign-?up|\/log-?in|\/sign-?in/.test(url)) return false;
  if (!url.includes("polyfaced.com")) return false;
  const link = page.locator('a[href*="sign-up"], a[href*="sign-in"], a[href*="log-in"]').first();
  if ((await link.count()) > 0 && (await link.isVisible().catch(() => false))) return false;
  return true;
}

async function ensureLogin(page, onProgress) {
  if (await isLoggedIn(page)) return;
  onProgress?.("polyfaced: нужен вход — залогинься в открытом окне (вручную)");
  const start = page.locator('a:has-text("Start free"), a:has-text("Log in"), a:has-text("Sign up")').first();
  await humanClick(start).catch(() => {});
  const ok = await waitUntil(() => isLoggedIn(page), {
    timeout: 5 * 60 * 1000,
    interval: 2500,
    message: "polyfaced: жду входа на сайте...",
    onProgress,
  });
  if (!ok) throw new Error("polyfaced: вход не выполнен");
  await saveSession(SITE);
  onProgress?.("polyfaced: вход сохранён");
}

/** свежий контекст + авто-регистрация через temp-почту; h.page/h.ctx могут смениться на кеш-сессию */
async function start(studioUrl, onProgress) {
  const owned = await freshSession();
  const h = { page: owned.page, ctx: owned.context };

  try {
    await h.page.goto(studioUrl, { waitUntil: "domcontentloaded" });
    if (!(await isLoggedIn(h.page))) {
      await ensureAuth(h, onProgress);
      await h.page.goto(studioUrl, { waitUntil: "domcontentloaded" });
    }
    await h.page.waitForSelector("#prompt", { timeout: 30000 });
    return h;
  } catch (err) {
    if (h.ctx) await h.ctx.close().catch(() => {});
    throw err;
  }
}

async function ensureAuth(h, onProgress) {
  if (await isLoggedIn(h.page)) return;
  try {
    onProgress?.("polyfaced: аккаунта нет — регистрируем новый через temp-почту...");
    await registerPolyfaced(h.page, onProgress);
    await saveSession(SITE, { context: h.ctx });
  } catch (err) {
    onProgress?.(`polyfaced: авто-регистрация не удалась (${err.message}) — пробуем сохранённый вход`);
    if (h.ctx) {
      await h.ctx.close().catch(() => {});
      h.ctx = null;
    }
    const s = await getSession(SITE);
    h.page = s.page;
    await h.page.goto("https://polyfaced.com/", { waitUntil: "domcontentloaded" });
    await ensureLogin(h.page, onProgress);
  }
}

/** кликает пункт в открытой выпашке (role=option / menuitem / обычные кнопки) */
async function pickOption(page, pattern, label) {
  const opts = page.locator('[role="option"], [role="menuitem"], [role="radio"], [role="menuitemradio"]');
  const n = await opts.count();
  for (let i = 0; i < n; i++) {
    const opt = opts.nth(i);
    const text = ((await opt.textContent().catch(() => "")) || "").trim();
    if (pattern.test(text) && (await opt.isVisible().catch(() => false))) {
      await humanClick(opt);
      return true;
    }
  }
  // запасной вариант: обычная кнопка с нужным текстом поверх затемнения
  const btn = page.locator("button").filter({ hasText: pattern }).filter({ visible: true }).first();
  if ((await btn.count()) > 0) {
    await humanClick(btn);
    return true;
  }
  onProgressFallback(page, label, pattern);
  return false;
}

function onProgressFallback() {}

async function pickFromButton(page, trigger, pattern, label) {
  const cur = ((await trigger.textContent().catch(() => "")) || "").trim();
  if (pattern.test(cur)) return true;
  await humanClick(trigger);
  await sleep(400);
  const ok = await pickOption(page, pattern, label);
  await sleep(300);
  return ok;
}

async function ensureModel(page, wanted, onProgress) {
  const trigger = page.locator("button").filter({ hasText: /active/ }).first();
  if ((await trigger.count()) > 0) {
    const cur = ((await trigger.textContent().catch(() => "")) || "").trim();
    if (wanted.test(cur)) return;
    await pickFromButton(page, trigger, wanted, "модель");
  } else {
    const anyModelBtn = page.locator("button").filter({ hasText: wanted }).first();
    if ((await anyModelBtn.count()) > 0) return;
  }
  onProgress?.(`polyfaced: выбираем модель ${wanted.source}`);
}

/** prompt, duration 1-5, aspectRatio */
export async function generateKling({ prompt, duration, aspectRatio }, onProgress) {
  const label = "polyfaced/kling";

  onProgress?.(`${label}: открываем студию...`);
  const h = await start(STUDIO_VIDEO, onProgress);
  const page = h.page;
  try {
    const baseline = await snapshotMedia(page);

    onProgress?.(`${label}: выбираем Kling 2.1...`);
    await ensureModel(page, /Kling\s*2\.1/i, onProgress);

    onProgress?.(`${label}: вписываем промпт...`);
    await humanFill(page.locator("#prompt"), prompt);

    const durTrigger = page.locator("#duration");
    if ((await durTrigger.count()) > 0) {
      const want = String(Math.min(5, Math.max(5, Number(duration) || 5)));
      await pickFromButton(page, durTrigger, new RegExp(`^${want}\\s*(s|ec|сек)?`, "i"), "дурэйшн");
    }

    if (aspectRatio) {
      const arTrigger = page.locator("#aspect-ratio");
      if ((await arTrigger.count()) > 0) {
        await pickFromButton(page, arTrigger, new RegExp(`^${aspectRatio.replace(":", "\\:")}$`), "аспект");
      }
    }

    onProgress?.(`${label}: нажимаем Create Video...`);
    const create = page.locator("button").filter({ hasText: /^Create Video/ }).first();
    await humanClick(create);
    await sleep(2500);

    if (/\/sign-?up|\/log-?in/.test(page.url())) {
      await ensureAuth(h, onProgress);
      await h.page.goto(STUDIO_VIDEO, { waitUntil: "domcontentloaded" });
      await h.page.waitForSelector("#prompt", { timeout: 30000 });
      await humanFill(h.page.locator("#prompt"), prompt);
      await humanClick(h.page.locator("button").filter({ hasText: /^Create Video/ }).first());
    }

    onProgress?.(`${label}: генерация идёт на стороне сайта...`);
    return await waitForResult(h.page, baseline, { onProgress, label, timeout: 12 * 60 * 1000 });
  } finally {
    if (h.ctx) await h.ctx.close().catch(() => {});
  }
}

/** prompt, model: gpt-image-2 | nano-banana, referenceBase64? */
export async function generatePhoto({ prompt, model, referenceBase64, referenceMime }, onProgress) {
  const label = "polyfaced/photo";

  onProgress?.(`${label}: открываем фотостудию...`);
  const h = await start(STUDIO_IMAGE, onProgress);
  const page = h.page;
  let tmp = null;
  try {
    const baseline = await snapshotMedia(page);

    const wanted = model === "nano-banana" ? /nano\s*banana|banana/i : /GPT\s*Image\s*2/i;
    await ensureModel(page, wanted, onProgress);

    if (referenceBase64) {
      onProgress?.(`${label}: включаем режим с референсом...`);
      const i2i = page.locator("button").filter({ hasText: /^Image to Image/ }).first();
      if ((await i2i.count()) > 0) await humanClick(i2i);
      await sleep(800);
      tmp = makeTmpFile(referenceBase64, referenceMime);
      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.setInputFiles(tmp).catch((e) => {
        cleanupTmp(tmp);
        tmp = null;
        throw e;
      });
      await sleep(1500);
    }

    onProgress?.(`${label}: вписываем промпт...`);
    await humanFill(page.locator("#prompt"), prompt);

    onProgress?.(`${label}: нажимаем Create Image...`);
    await humanClick(page.locator("button").filter({ hasText: /^Create Image/ }).first());
    await sleep(2500);

    if (/\/sign-?up|\/log-?in/.test(h.page.url())) {
      await ensureAuth(h, onProgress);
      await h.page.goto(STUDIO_IMAGE, { waitUntil: "domcontentloaded" });
      await h.page.waitForSelector("#prompt", { timeout: 30000 });
      await humanFill(h.page.locator("#prompt"), prompt);
      await humanClick(h.page.locator("button").filter({ hasText: /^Create Image/ }).first());
    }

    onProgress?.(`${label}: генерация идёт на стороне сайта...`);
    return await waitForResult(h.page, baseline, { onProgress, label, timeout: 8 * 60 * 1000 });
  } finally {
    if (tmp) setTimeout(() => cleanupTmp(tmp), 60000);
    if (h.ctx) await h.ctx.close().catch(() => {});
  }
}

export async function openLogin(onProgress) {
  const { page } = await getSession(SITE);
  await page.goto("https://polyfaced.com/", { waitUntil: "domcontentloaded" });
  const start = page.locator('a:has-text("Start free"), a:has-text("Log in")').first();
  if ((await start.count()) > 0) await humanClick(start).catch(() => {});
  onProgress?.("polyfaced: окно открыто, залогинься");
}

export async function status() {
  const { page } = await getSession(SITE);
  if (!page.url().includes("polyfaced.com")) return "untouched";
  return (await isLoggedIn(page)) ? "in" : "out";
}
