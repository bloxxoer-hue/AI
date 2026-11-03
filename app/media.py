# забора результата со страницы: сетевой трафик mp4/webm, DOM-видео, кнопка
# Download; blob выгружается из страницы. Всё падает в outputs/
import base64
import os
import re
import time
import uuid

from .browser import sleep

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUTS = os.path.join(ROOT, "outputs")
os.makedirs(OUTPUTS, exist_ok=True)

BAD_URL = re.compile(
    r"site-assets|h3-home|example|signup|avatar|font|icon|doubleclick|googlesyndication|adsbygoogle|pagead|/ads?/",
    re.I,
)
EXT_URL = re.compile(r"\.(mp4|webm|png|jpe?g|webp|gif)(\?|$)", re.I)


def _ext_from(url, fallback):
    m = re.search(r"\.(mp4|webm|png|jpg|jpeg|webp|gif)(\?|$)", url or "", re.I)
    if not m:
        return fallback
    return "jpg" if m.group(1).lower() == "jpeg" else m.group(1).lower()


def _save(data: bytes, ext: str) -> str:
    name = f"{uuid.uuid4()}.{ext}"
    with open(os.path.join(OUTPUTS, name), "wb") as f:
        f.write(data)
    return f"/outputs/{name}"


def snapshot_media(page):
    return page.evaluate("""() => {
      const out = [];
      for (const v of document.querySelectorAll('video')) {
        if (v.currentSrc || v.src) out.push(v.currentSrc || v.src);
        const s = v.querySelector('source');
        if (s && s.src) out.push(s.src);
      }
      for (const a of document.querySelectorAll('a[href]')) out.push(a.href);
      for (const i of document.querySelectorAll('img')) if (i.src) out.push(i.src);
      return out;
    }""")


def grab_from_page(page, url):
    """fetch прямо из страницы (обход CORS) → bytes"""
    b64 = page.evaluate("""async (src) => {
      try {
        const res = await fetch(src);
        if (!res.ok) return null;
        const buf = new Uint8Array(await res.arrayBuffer());
        let bin = '';
        const chunk = 0x8000;
        for (let i = 0; i < buf.length; i += chunk) bin += String.fromCharCode(...buf.subarray(i, i + chunk));
        return btoa(bin);
      } catch (e) { return null; }
    }""", url)
    if not b64:
        return None
    return base64.b64decode(b64)


DOM_SCAN = """() => {
  const out = [];
  const isNew = (el) => !el.dataset.rpaSeen;
  for (const v of document.querySelectorAll('video')) {
    const src = v.currentSrc || v.src || v.querySelector('source')?.src;
    if (src && (src.startsWith('blob:') || src.startsWith('http'))) {
      out.push({ type: 'video', src, w: v.videoWidth || 0, isNew: isNew(v), time: v.currentTime || 0 });
    }
  }
  for (const a of document.querySelectorAll('a[href]')) {
    if (/download|\\.mp4|\\.webm/i.test((a.getAttribute('download') || '') + a.href)) {
      out.push({ type: 'link', src: a.href, isNew: isNew(a) });
    }
  }
  for (const i of document.querySelectorAll('img')) {
    if (i.src && i.naturalWidth >= 256 && !/logo|icon|avatar/i.test(i.src)) {
      out.push({ type: 'image', src: i.src, w: i.naturalWidth, isNew: isNew(i) });
    }
  }
  return out;
}"""


def wait_result(page, baseline, timeout_s=720, on_progress=None, label="медиа"):
    seen = set(baseline or [])
    captured = []

    def on_resp(r):
        try:
            u = r.url
            ct = r.headers.get("content-type", "")
            if (ct.startswith("video/") or re.search(r"\.(mp4|webm)(\?|$)", u, re.I)) and not BAD_URL.search(u):
                body = r.body()
                if len(body) > 30000:
                    captured.append((u, body))
        except Exception:
            pass

    page.on("response", on_resp)
    try:
        start = time.time()
        tick = 0
        while time.time() - start < timeout_s:
            tick += 1
            if captured:
                u, body = captured[0]
                return _save(body, _ext_from(u, "mp4"))

            for f in page.evaluate(DOM_SCAN):
                src = f["src"]
                if src in seen:
                    continue
                if not f["isNew"] and f["type"] != "video":
                    continue
                if f["type"] == "image" and not f["isNew"]:
                    continue
                if f["type"] == "video" and not f["isNew"] and f.get("time") == 0:
                    continue
                seen.add(src)
                if src.startswith("blob:"):
                    data = grab_from_page(page, src)
                    if data:
                        return _save(data, "mp4")
                    continue
                if f["type"] in ("image", "video") or src.startswith("http"):
                    data = grab_from_page(page, src)
                    if data:
                        ext = _ext_from(src, "mp4" if f["type"] == "video" else "png")
                        return _save(data, ext)

            if tick % 6 == 0:
                dl = page.locator('a[download], button:has-text("Download")').first
                try:
                    if dl.count() > 0 and dl.is_visible():
                        try:
                            with page.expect_download(timeout=5000) as di:
                                dl.click()
                            path = di.value.path()
                            if path:
                                with open(path, "rb") as fh:
                                    return _save(fh.read(), _ext_from(di.value.suggested_filename, "mp4"))
                        except Exception:
                            pass
                except Exception:
                    pass
                if on_progress:
                    on_progress(f"{label}: ждём результат на сайте... {int(time.time() - start)}с")

            sleep(2500)
        raise RuntimeError(f"{label}: сайт не вернул результат за отведённое время")
    finally:
        try:
            page.remove_listener("response", on_resp)
        except Exception:
            pass
