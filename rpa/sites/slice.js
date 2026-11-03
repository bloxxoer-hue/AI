import { getSession, saveSession, freshSession, waitUntil } from "../session.js";
import { humanFill, humanClick, sleep } from "../human.js";
import { snapshotMedia, waitForResult } from "../media.js";
import { registerSlice } from "../register.js";
import * as pool from "../pool.js";
import { kickWarmer } from "../warmer.js";

const SITE = "slice";
const HOME = "https://slice.video";
const NEW_FORM = `${HOME}/videos/new`;

async function isLoggedIn(page) {
  if (!page.url().includes("slice.video")) return false;
  if (/\/(log-?in|sign-?up|auth|registration)/.test(page.url())) return false;
  const login = page.locator('a:has-text("Log in"), a:has-text("Sign up")').first();
  if ((await login.count()) > 0 && (await login.isVisible().catch(() => false))) return false;
  return true;
}

async function ensureLogin(page, onProgress) {
  if (await isLoggedIn(page)) return;
  onProgress?.("slice: нужен вход — залогинься в открытом окне (вручную)");
  const start = page.locator('a:has-text("Start free"), a:has-text("Log in")').first();
  await humanClick(start).catch(() => {});
  const ok = await waitUntil(() => isLoggedIn(page), {
    timeout: 5 * 60 * 1000,
    interval: 2500,
    message: "slice: жду входа на сайте...",
    onProgress,
  });
  if (!ok) throw new Error("slice: вход не выполнен");
  await saveSession(SITE);
  onProgress?.("slice: вход сохранён");
}

/** готовый аккаунт из пула (зарегистрирован заранее, кредиты уже капнули) */
async function fromPool(onProgress) {
  const item = pool.pop();
  kickWarmer(); // место в пуле заняли — фон сразу готовит замену
  if (!item) return null;
  const owned = await freshSession(item.state);
  onProgress?.(`slice: берём готовый аккаунт из пула (◆ ${item.balance})`);
  return { page: owned.page, ctx: owned.context };
}

/** свежий контекст + авто-регистрация через temp-почту (код из письма) */
async function start(onProgress) {
  // путь без ожидания: аккаунт с кредитами уже ждёт на полке
  const pooled = await fromPool(onProgress).catch(() => null);
  if (pooled) return pooled;

  const owned = await freshSession();
  const h = { page: owned.page, ctx: owned.context };

  try {
    await h.page.goto(HOME, { waitUntil: "domcontentloaded" });
    if (!(await isLoggedIn(h.page))) {
      try {
        onProgress?.("slice: аккаунта нет — регистрируем новый через temp-почту...");
        await registerSlice(h.page, onProgress);
        await saveSession(SITE, { context: h.ctx });
      } catch (err) {
        onProgress?.(`slice: авто-регистрация не удалась (${err.message}) — пробуем сохранённый вход`);
        if (h.ctx) {
          await h.ctx.close().catch(() => {});
          h.ctx = null;
        }
        const s = await getSession(SITE);
        h.page = s.page;
        await h.page.goto(HOME, { waitUntil: "domcontentloaded" });
        await ensureLogin(h.page, onProgress);
      }
      await h.page.goto(HOME, { waitUntil: "domcontentloaded" });
    }
    return h;
  } catch (err) {
    if (h.ctx) await h.ctx.close().catch(() => {});
    throw err;
  }
}

async function balance(page) {
  return page.evaluate(() =>
    Number((document.body.innerText.match(/◆\s*(\d+)/) || [])[1] || 0)
  );
}

/**
 * триал (200 ◆) приходит с задержкой после регистрации — свежие аккаунты
 * стартуют с нуля. Ждём, пока баланс станет положительным.
 */
async function ensureBalance(page, onProgress) {
  await page.goto(`${HOME}/videos`, { waitUntil: "domcontentloaded" });
  await sleep(2500);
  const t0 = Date.now();
  for (;;) {
    const bal = await balance(page).catch(() => 0);
    if (bal > 0) {
      if (Date.now() - t0 > 5000) onProgress?.(`slice: кредиты на месте (◆ ${bal})`);
      return bal;
    }
    if (Date.now() - t0 > 10 * 60 * 1000) {
      throw new Error("slice: триал-кредиты не пришли за 10 минут");
    }
    onProgress?.("slice: ждём триал-кредиты (свежий аккаунт стартует с 0)...");
    await sleep(20000);
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    await sleep(2500);
  }
}

/** чекбокс с учётом Rails-хака: скрытый input[name] = 0 рядом с чекбоксом = 1 */
async function setCheckbox(page, id, want) {
  const cb = page.locator(`#${id}`);
  if ((await cb.count()) === 0) return false;
  const checked = await cb.isChecked().catch(() => null);
  if (checked === null || checked === want) return true;
  if (want) await cb.check({ force: true }).catch(() => {});
  else await cb.uncheck({ force: true }).catch(() => {});
  return true;
}

/** кликает label по тексту — Rails-радио часто спрятаны за подписью */
async function clickLabel(page, pattern) {
  const lab = page.locator("label").filter({ hasText: pattern }).filter({ visible: true }).first();
  if ((await lab.count()) === 0) return false;
  await humanClick(lab).catch(() => {});
  return true;
}

/**
 * topic, visuals: animated|still, whoSpeaks: narrator|characters,
 * length ("15s"), voiceover, captions, visualStyle (Auto|Photoreal|Cinematic)
 */
export async function generate(body, onProgress) {
  const label = "slice";

  onProgress?.(`${label}: открываем slice.video...`);
  const h = await start(onProgress);
  const page = h.page;

  try {
    const credits = await ensureBalance(page, onProgress);

    onProgress?.(`${label}: открываем форму нового slice...`);
    await page.goto(NEW_FORM, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#video_prompt", { timeout: 30000 });
    await sleep(1200);

    const baseline = await snapshotMedia(page);

    onProgress?.(`${label}: вписываем тему...`);
    await humanFill(page.locator("#video_prompt"), body.topic);

    // длина — всегда 15s (триал), остальные опции залочены
    const dur = page.locator("#video_target_duration_s");
    if ((await dur.count()) > 0) {
      await dur.selectOption("15").catch(() => page.selectOption("#video_target_duration_s", { label: /15s/ }).catch(() => {}));
      onProgress?.(`${label}: длина 15s`);
    }

    // визуал: motion=0 — still (всегда доступен), motion=1 — animated (нужен paid-пак)
    if (body.visuals === "animated") {
      const anim = page.locator('input[name="video[motion]"][value="1"]');
      const ok = (await anim.count()) > 0 && !(await anim.isDisabled().catch(() => true));
      if (ok) {
        await anim.check({ force: true }).catch(() => {});
        onProgress?.(`${label}: визуал animated`);
      } else {
        onProgress?.(`${label}: animated залочен на триале — ставим still images`);
      }
    } else if (body.visuals === "still") {
      await clickLabel(page, /still\s*images/i);
    }

    // кто говорит
    if (body.whoSpeaks === "characters") {
      const chRadio = page.locator('input[name="video[speech_mode]"]:not([value="narration"])');
      const ok = (await chRadio.count()) > 0 && !(await chRadio.first().isDisabled().catch(() => true));
      if (ok) await clickLabel(page, /the\s*characters/i);
      else onProgress?.(`${label}: персонажи залочены на триале — ставим A narrator`);
    }

    // стиль
    const styleValue = body.visualStyle === "Photoreal" ? "photorealistic"
      : body.visualStyle === "Cinematic" ? "cinematic" : "";
    const styleRadio = page.locator(`input[name="video[style_preset]"][value="${styleValue}"]`);
    if ((await styleRadio.count()) > 0) {
      await styleRadio.check({ force: true }).catch(() => {
        // radio спрятан за label — кликаем подпись
        const names = { "": /auto/i, photorealistic: /photoreal/i, cinematic: /cinematic/i };
        return clickLabel(page, names[styleValue] || /auto/i);
      });
      onProgress?.(`${label}: стиль ${body.visualStyle || "Auto"}`);
    }

    // озвучка и субтитры — по умолчанию включены
    if (body.voiceoverEnabled === false) await setCheckbox(page, "video_voiceover_enabled", false);
    if (body.captions === false) await setCheckbox(page, "video_captions_enabled", false);

    // submit + ловля 422 (кредиты/валидация)
    onProgress?.(`${label}: нажимаем Generate video (◆ ${credits} на балансе)...`);
    let reject = null;
    const onResponse = async (r) => {
      if (r.request().method() === "POST" && r.status() >= 400 && /\/videos(\?|$)/.test(r.url())) {
        try {
          const html = await r.text();
          const m = html.match(/[^<>]{0,80}(credits|error|invalid|too)[^<>]{0,120}/i);
          reject = m ? m[0].replace(/\s+/g, " ").trim() : `HTTP ${r.status()}`;
        } catch { reject = `HTTP ${r.status()}`; }
      }
    };
    page.on("response", onResponse);

    try {
      await page.locator("#generate-slice-btn").first().click({ timeout: 15000 });
      await sleep(6000);
      if (reject) throw new Error("slice: генерация отклонена — " + reject);
      if (!/\/videos\/\d+/.test(page.url())) {
        // могла вылезла валидация — собираем текст
        const warn = await page.evaluate(() => {
          const m = document.body.innerText.match(/[^\n]*(need|need[s]? about|not enough|log in|sign in|Buy credits)[^\n]*/i);
          return m ? m[0].trim() : "";
        });
        if (warn) throw new Error("slice: форма не принята — " + warn);
        throw new Error("slice: после Generate не открылась страница создания (url=" + page.url() + ")");
      }
    } finally {
      page.off("response", onResponse);
    }

    onProgress?.(`${label}: видео создаётся на стороне сайта...`);

    // статусы: Creating your video… → ready
    const ready = await waitUntil(
      () => page.evaluate(() => /\bready\b/i.test(document.body.innerText) && !!document.querySelector("video")),
      { timeout: 20 * 60 * 1000, interval: 5000, message: `${label}: рендерим...`, onProgress }
    );
    if (!ready) onProgress?.(`${label}: статус ready не пойман — забираем, что есть`);

    const result = await waitForResult(page, baseline, { onProgress, label, timeout: 5 * 60 * 1000 });
    onProgress?.(`${label}: готово (баланс после: ◆ ${await balance(page).catch(() => "?")})`);
    return result;
  } finally {
    if (h.ctx) await h.ctx.close().catch(() => {});
  }
}

export async function openLogin(onProgress) {
  const { page } = await getSession(SITE);
  await page.goto(HOME, { waitUntil: "domcontentloaded" });
  const start = page.locator('a:has-text("Start free"), a:has-text("Log in")').first();
  if ((await start.count()) > 0) await humanClick(start).catch(() => {});
  onProgress?.("slice: окно открыто, залогинься");
}

export async function status() {
  const { page } = await getSession(SITE);
  if (!page.url().includes("slice.video")) return "untouched";
  return (await isLoggedIn(page)) ? "in" : "out";
}
