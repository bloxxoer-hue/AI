// фоновый догоняльщик пула slice: регистрирует аккаунт, ждёт триал-кредиты,
// кладёт готовый в pool. запросы генерации берут готовый аккаунт мгновенно.
import fs from "node:fs";
import { freshSession } from "./session.js";
import { registerSlice } from "./register.js";
import { sleep } from "./human.js";
import * as pool from "./pool.js";

const TARGET = 2;          // держим столько готовых аккаунтов
const TRIAL_WAIT = 75 * 60 * 1000; // столько максимум ждём триал (по факту — эксперимент)
const TICK = 30000;

let running = false;

export function kickWarmer() {
  if (running) return;
  running = true;
  loop()
    .catch((e) => console.error("[pool] " + (e && e.message ? e.message : e)))
    .finally(() => { running = false; });
}

async function balance(page) {
  return page.evaluate(() =>
    Number((document.body.innerText.match(/◆\s*(\d+)/) || [])[1] || 0)
  );
}

async function loop() {
  while (pool.count() < TARGET) {
    const owned = await freshSession();
    const h = { page: owned.page, ctx: owned.context };
    const statePath = pool.pendingFile(Date.now().toString(36));
    try {
      await h.page.goto("https://slice.video", { waitUntil: "domcontentloaded" });
      await registerSlice(h.page, (m) => console.log("[pool] " + m));

      const t0 = Date.now();
      for (;;) {
        const bal = await balance(h.page).catch(() => 0);
        const waited = Math.round((Date.now() - t0) / 60000);
        if (bal > 0) {
          await h.ctx.storageState({ path: statePath });
          pool.push(statePath, bal);
          console.log(`[pool] аккаунт готов: ◆${bal} (ждали ${waited} мин), в пуле ${pool.count()}`);
          break;
        }
        if (Date.now() - t0 > TRIAL_WAIT) {
          console.log(`[pool] триал не пришёл за ${waited} мин — аккаунт в утиль`);
          break;
        }
        if (waited > 0 && waited % 5 === 0) {
          console.log(`[pool] ждём триал на свежем аккаунте... ${waited} мин`);
        }
        await sleep(TICK);
        await h.page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
        await sleep(2500);
      }
    } catch (e) {
      console.log("[pool] ошибка подготовки: " + (e && e.message ? e.message : e));
      await sleep(60000); // пауза перед следующей попыткой — не давим slice
    } finally {
      await h.ctx?.close().catch(() => {});
    }
    if (pool.count() >= TARGET) break;
  }
}
