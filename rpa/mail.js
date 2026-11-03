// temp-почта для авто-регистрации:
//   slice.video → emailnator.com с выбором gmail-домена (+Gmail / .Gmail чипы)
//   h3-max, polyfaced → temp-mail.io (домены любые)
// если выбранный провайдер не дал адрес — авто-откат на второй
import { sleep } from "./human.js";

const EMAILNATOR = "https://www.emailnator.com/";
const TEMPMAIL = "https://temp-mail.io/en";

// ---------- emailnator (gmail) ----------

// всплывающие оверлеи emailnator (cookie-баннер, фидбек, consent) блокируют клики — снимаем
async function killOverlays(page) {
  await page.evaluate(() => {
    document.querySelectorAll(".fc-message-root, .fc-dialog-overlay, .fc-consent-root").forEach((d) => d.remove());
    document.body.style.overflow = "";
    document.documentElement.style.overflow = "";
  }).catch(() => {});
}

async function emailnatorAddress(page) {
  const prev = page.__enAddr || null; // повторный заход в один профиль = нужен новый адрес
  page.__tmAddr = null; // сброс привязки temp-mail при смене провайдера
  const isGood = (a) => /@(gmail|googlemail)\.com$/.test(a);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(EMAILNATOR, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector(".mf-chip", { timeout: 30000 });
    await sleep(3000);
    await page.locator("#accept-cookies-usage").click({ timeout: 5000 }).catch(() => {});
    await killOverlays(page);

    // выбор gmail-домена: +Gmail и .Gmail включены, Domain и GoogleMail выключены
    // (GoogleMail на самом деле выдаёт ротационные домены вроде mydefipet.live)
    await page.evaluate(() => {
      const want = { "Domain": false, "GoogleMail": false, "+Gmail": true, ".Gmail": true };
      for (const c of document.querySelectorAll(".mf-chip")) {
        const name = c.innerText.trim();
        if (!(name in want)) continue;
        if ((c.getAttribute("aria-pressed") === "true") !== want[name]) c.click();
      }
    });
    await sleep(1000);
    await killOverlays(page);

    // профиль/предыдущая попытка уже держит адрес — генерируем новый
    if (prev || attempt > 1) {
      await page.evaluate(() =>
        [...document.querySelectorAll(".mf-btn-ghost, button")]
          .find((b) => /generate new/i.test(b.innerText || ""))?.click()
      );
      await sleep(3000);
      await killOverlays(page);
    }

    // DOM-клик мимо оверлеев: consent-диалог перехватывает указатель
    await page.evaluate(() => document.querySelector(".mf-btn-go")?.click());
    try {
      await page.waitForURL(/\/inbox#/, { timeout: 25000 });
    } catch {}

    let addr = page.url().includes("#") ? decodeURIComponent(page.url().split("#")[1]) : "";
    if (!addr.includes("@")) addr = await page.evaluate(() => document.querySelector(".mf-mono")?.innerText?.trim() || "");
    if (!addr.includes("@")) throw new Error("emailnator: адрес не появился (попытка " + attempt + ")");
    if (addr === prev) {
      console.log("[mail] emailnator вернул прежний адрес — перегенерирую");
      continue;
    }
    if (isGood(addr)) {
      page.__enAddr = addr;
      return { addr, kind: "emailnator" };
    }
    console.log(`[mail] не-gmail адрес (попытка ${attempt}): ${addr} — перегенерирую`);
  }
  throw new Error("emailnator: gmail-адрес не выдаётся");
}

// ---------- temp-mail.io ----------

async function tempMailAddress(page) {
  await page.goto(TEMPMAIL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("input#email", { timeout: 30000 });
  // cookie-баннер мешает кликам — снимаем
  await page.locator('[data-qa="close-button"]').last().click({ timeout: 4000 }).catch(() => {});
  await sleep(1500);

  const read = () => page.evaluate(() => document.querySelector("input#email")?.value?.trim() || "");

  // адрес приезжает асинхронно после загрузки
  let prev = "";
  const boot = Date.now() + 10000;
  while (Date.now() < boot) {
    prev = await read();
    if (prev.includes("@")) break;
    await sleep(600);
  }

  // «random» реально ротирует (POST /api/v3/email/new); «change» в free-режиме no-op
  await page.locator('[data-qa="random-button"]').click({ timeout: 8000 }).catch(() => {});
  let addr = prev;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await sleep(800);
    addr = await read();
    if (addr && addr.includes("@") && addr !== prev) break;
  }

  if (!addr || !addr.includes("@")) throw new Error("temp-mail: адрес не появился");
  if (addr === prev) throw new Error("temp-mail: адрес не ротируется");
  page.__tmAddr = addr; // для чтения писем через api/v3
  return { addr, kind: "temp-mail" };
}

// ---------- выбор провайдера ----------

/**
 * provider: "emailnator" (gmail) | "tempmail" (любой домен)
 * по умолчанию temp-mail; при отказе — откат на второй провайдер
 */
export async function newAddress(page, provider = "tempmail") {
  const first = provider === "emailnator"
    ? ["emailnator", emailnatorAddress, "tempmail", tempMailAddress]
    : ["tempmail", tempMailAddress, "emailnator", emailnatorAddress];
  try {
    return await first[1](page);
  } catch (err) {
    console.log(`[mail] ${first[0]} не дал адрес (${err.message}) — откат на ${first[2]}`);
    return await first[3](page);
  }
}

/** читает открытое письмо: текст + ссылки, включая iframe-тело */
async function readMessage(page) {
  return page.evaluate(() => {
    let text = (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 6000);
    const links = [];
    for (const a of document.querySelectorAll("a[href]")) {
      if (a.href.startsWith("http")) links.push(a.href);
    }
    for (const f of document.querySelectorAll("iframe")) {
      try {
        const d = f.contentDocument;
        if (!d) continue;
        text += " " + (d.body?.innerText || "").replace(/\s+/g, " ").slice(0, 4000);
        for (const a of d.querySelectorAll("a[href]")) {
          if (a.href.startsWith("http")) links.push(a.href);
        }
      } catch {}
    }
    return { text, links: [...new Set(links)] };
  });
}

/** письма temp-mail через их API: тело письма (body_html) отдаётся целиком,
 *  в отличие от веб-превью, которое обрезает ссылки (line-clamp) */
async function tempMailApi(page, addr, senderRe) {
  const msgs = await page.evaluate(async (a) => {
    try {
      const res = await fetch(`https://api.internal.temp-mail.io/api/v3/email/${encodeURIComponent(a)}/messages`);
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }, addr);
  if (!Array.isArray(msgs) || !msgs.length) return null;

  const re = new RegExp(senderRe.source, senderRe.flags.includes("i") ? senderRe.flags : senderRe.flags + "i");
  const hit = msgs.find((m) => re.test(`${m.from || ""} ${m.subject || ""} ${m.body_text || ""}`));
  if (!hit) return null;

  const links = await page.evaluate((html) => {
    const doc = new DOMParser().parseFromString(html || "", "text/html");
    return [...doc.querySelectorAll("a[href]")].map((a) => a.href).filter((h) => h.startsWith("http"));
  }, hit.body_html || "");
  return { text: `${hit.from || ""} ${hit.subject || ""} ${hit.body_text || ""}`, links };
}

/** ждёт письмо от отправителя; возвращает { text, links } */
export async function waitMessage(page, senderRe, timeout = 180000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const onTempMail = page.url().includes("temp-mail.io");
    const isTempMail = onTempMail || Boolean(page.__tmAddr);

    // ветка API — только когда страница реально на temp-mail (адрес не протух от смены провайдера)
    if (onTempMail && page.__tmAddr) {
      // их бэк подтягивает почту на клик Refresh — без него список отстаёт
      await page.locator('[data-qa="refresh-button"]').click({ timeout: 6000 }).catch(() => {});
      await sleep(1500);
      const hit = await tempMailApi(page, page.__tmAddr, senderRe);
      if (hit) return hit;
      await sleep(4000);
      continue;
    }

    if (isTempMail) {
      // refresh-кнопка: inbox без неё не обновляется
      await page.locator('[data-qa="refresh-button"]').click({ timeout: 6000 }).catch(() => {});
      await sleep(1200);
    } else {
      // emailnator: явный Reload по UI
      await page.evaluate(() =>
        [...document.querySelectorAll("button, a")]
          .find((e) => /^\s*reload\s*$/i.test(e.innerText || ""))?.click()
      ).catch(() => {});
      await sleep(3500);
    }

    const hit = await page.evaluate((src) => {
      const re = new RegExp(src, "i");
      const box = document.querySelector('[data-qa="inbox"]') || document.body;
      const rows = [...box.querySelectorAll("a, li, tr, [class*='message'], [class*='row']")]
        .filter((r) => r.innerText && r.innerText.trim().length > 2 && re.test(r.innerText));
      if (!rows.length) return null;
      const row = rows[0];
      return {
        text: row.innerText.replace(/\s+/g, " ").trim(),
        href: row.tagName === "A" ? row.href : (row.querySelector("a[href]")?.href || null),
      };
    }, senderRe);

    if (hit) {
      // emailnator: тело письма живёт на отдельной странице /inbox/<addr>/<token>
      if (hit.href && /\/inbox\/.+\/gp/i.test(hit.href)) {
        await page.goto(hit.href, { waitUntil: "domcontentloaded", timeout: 60000 });
      } else if (hit.href) {
        await page.goto(hit.href, { waitUntil: "domcontentloaded", timeout: 60000 });
      } else {
        await page.evaluate((src) => {
          const re = new RegExp(src, "i");
          const box = document.querySelector('[data-qa="inbox"]') || document.body;
          const row = [...box.querySelectorAll("a, li, tr, [class*='message'], [class*='row']")]
            .find((r) => r.innerText && r.innerText.trim().length > 2 && re.test(r.innerText));
          if (row) (row.tagName === "A" ? row : row.querySelector("a[href]") || row).click();
        }, senderRe).catch(() => {});
      }
      await sleep(3000);
      const body = await readMessage(page);
      return { text: hit.text + " " + body.text, links: body.links };
    }

    await sleep(4500);
  }
  throw new Error("письмо не пришло от " + senderRe);
}

export function messageLink(links, hrefRe) {
  return (links || []).find((l) => hrefRe.test(l)) || null;
}

export function extractCode(text) {
  const m = String(text).match(/\b(\d{6})\b/);
  return m ? m[1] : null;
}
