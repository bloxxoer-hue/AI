import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { sleep } from "./human.js";
import { ROOT } from "./session.js";

const OUTPUTS = path.join(ROOT, "outputs");
fs.mkdirSync(OUTPUTS, { recursive: true });

function saveBuffer(buf, ext) {
  const name = `${crypto.randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(OUTPUTS, name), buf);
  return `/outputs/${name}`;
}

const b64ToBuf = (b64) => Buffer.from(b64, "base64");

/** снимок того, что уже есть на странице — чтобы не принять демо-видео за результат */
export async function snapshotMedia(page) {
  return page.evaluate(() => {
    const out = [];
    for (const v of document.querySelectorAll("video")) {
      if (v.currentSrc || v.src) out.push(v.currentSrc || v.src);
      const s = v.querySelector("source");
      if (s?.src) out.push(s.src);
    }
    for (const a of document.querySelectorAll("a[href]")) out.push(a.href);
    for (const i of document.querySelectorAll("img")) if (i.src) out.push(i.src);
    return out;
  });
}

async function grabFromPage(page, url) {
  return page.evaluate(async (src) => {
    try {
      const res = await fetch(src);
      if (!res.ok) return null;
      const buf = new Uint8Array(await res.arrayBuffer());
      let bin = "";
      const chunk = 0x8000;
      for (let i = 0; i < buf.length; i += chunk) {
        bin += String.fromCharCode(...buf.subarray(i, i + chunk));
      }
      return btoa(bin);
    } catch {
      return null;
    }
  }, url);
}

function extFrom(url, fallback) {
  const m = url.split("?")[0].match(/\.(mp4|webm|png|jpe?g|webp|gif)$/i);
  return m ? m[1].toLowerCase().replace("jpeg", "jpg") : fallback;
}

/**
 * ждёт, пока на странице появится новый результат (видео или картинка).
 * смотрит: сетевой трафик, DOM-элементы после клика по generate, кнопки Download.
 */
export async function waitForResult(page, baseline, { timeout = 15 * 60 * 1000, onProgress, label = "медиа" } = {}) {
  const seen = new Set(baseline || []);
  const captured = [];

  const onResponse = async (res) => {
    try {
      const ct = res.headers()["content-type"] || "";
      const url = res.url();
      if (/^video\//.test(ct) || /\.(mp4|webm)(\?|$)/i.test(url)) {
        const body = await res.body();
        if (body.length > 30000) captured.push({ kind: "video", body, url });
      }
    } catch {}
  };
  page.on("response", onResponse);

  const start = Date.now();
  let tick = 0;
  try {
    while (Date.now() - start < timeout) {
      tick++;
      if (captured.length) {
        const c = captured[0];
        return { file: saveBuffer(c.body, extFrom(c.url, "mp4")) };
      }

      const found = await page.evaluate(() => {
        const out = [];
        const isNew = (el) => !el.dataset.rpaSeen;
        for (const v of document.querySelectorAll("video")) {
          const src = v.currentSrc || v.src || v.querySelector("source")?.src;
          if (src && (src.startsWith("blob:") || src.startsWith("http"))) {
            out.push({ type: "video", src, w: v.videoWidth || 0, isNew: isNew(v), time: v.currentTime || 0 });
          }
        }
        for (const a of document.querySelectorAll("a[href]")) {
          if (/download|\.mp4|\.webm/i.test((a.getAttribute("download") || "") + a.href)) {
            out.push({ type: "link", src: a.href, isNew: isNew(a) });
          }
        }
        for (const i of document.querySelectorAll("img")) {
          if (i.src && i.naturalWidth >= 256 && !/logo|icon|avatar/i.test(i.src)) {
            out.push({ type: "image", src: i.src, w: i.naturalWidth, isNew: isNew(i) });
          }
        }
        return out;
      });

      for (const f of found) {
        if (seen.has(f.src)) continue;
        if (!f.isNew && f.type !== "video") continue;
        if (f.type === "image" && !f.isNew) continue;
        if (f.type === "video" && !f.isNew && f.time === 0) continue;

        seen.add(f.src);

        if (f.src.startsWith("blob:")) {
          const b64 = await grabFromPage(page, f.src);
          if (b64) {
            return { file: saveBuffer(b64ToBuf(b64), "mp4") };
          }
          continue;
        }
        if (f.type === "image") {
          const b64 = await grabFromPage(page, f.src);
          if (b64) return { file: saveBuffer(b64ToBuf(b64), extFrom(f.src, "png")) };
        } else if (f.src.startsWith("http")) {
          const b64 = await grabFromPage(page, f.src);
          if (b64) {
            const ext = f.type === "video" ? extFrom(f.src, "mp4") : extFrom(f.src, "png");
            return { file: saveBuffer(b64ToBuf(b64), ext) };
          }
        }
      }

      if (tick % 6 === 0) {
        const dl = page.locator('a[download], button:has-text("Download")').first();
        if ((await dl.count()) > 0 && (await dl.isVisible().catch(() => false))) {
          try {
            const [download] = await Promise.all([
              page.waitForEvent("download", { timeout: 5000 }),
              dl.click(),
            ]);
            const tmp = await download.path();
            if (tmp) {
              const ext = extFrom(download.suggestedFilename(), "mp4");
              return { file: saveBuffer(fs.readFileSync(tmp), ext) };
            }
          } catch {}
        }
        onProgress?.(`${label}: ждём результат на сайте... ${Math.round((Date.now() - start) / 1000)}с`);
      }

      await sleep(2500);
    }
    throw new Error(`${label}: сайт не вернул результат за отведённое время`);
  } finally {
    page.off("response", onResponse);
  }
}

export function makeTmpFile(base64, mime) {
  const ext = (mime || "").split("/")[1]?.replace("jpeg", "jpg") || "png";
  const dir = path.join(ROOT, "tmp");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${crypto.randomUUID()}.${ext}`);
  fs.writeFileSync(file, b64ToBuf(base64));
  return file;
}

export function cleanupTmp(file) {
  try {
    fs.unlinkSync(file);
  } catch {}
}
