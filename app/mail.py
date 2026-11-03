# temp-почта через интерфейс сайтов (никаких их API):
#   slice.video → emailnator.com с gmail-доменом (+Gmail/.Gmail чипы)
#   h3-max, polyfaced → temp-mail.io (домены любые, ротация кнопкой random)
# при отказе провайдера — авто-откат на второй
import re
from urllib.parse import unquote

from .browser import sleep

EMAILNATOR = "https://www.emailnator.com/"
TEMPMAIL = "https://temp-mail.io/en"

KILL_OVERLAYS = """() => {
  document.querySelectorAll('.fc-message-root, .fc-dialog-overlay, .fc-consent-root')
    .forEach((d) => d.remove());
  document.body.style.overflow = '';
  document.documentElement.style.overflow = '';
}"""


def _tempmail_address(page):
    page.goto(TEMPMAIL, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_selector("input#email", timeout=30000)
    try:
        page.locator('[data-qa="close-button"]').last.click(timeout=4000)
    except Exception:
        pass
    sleep(1500)

    def read():
        return page.evaluate("() => document.querySelector('input#email')?.value?.trim() || ''")

    prev = ""
    for _ in range(16):  # поле наполняется асинхронно
        prev = read()
        if "@" in prev:
            break
        sleep(600)

    # «random» реально ротирует; «change» в free-режиме no-op
    try:
        page.locator('[data-qa="random-button"]').click(timeout=8000)
    except Exception:
        pass
    addr = prev
    for _ in range(25):
        sleep(800)
        addr = read()
        if addr and "@" in addr and addr != prev:
            break
    if "@" not in addr:
        raise RuntimeError("temp-mail: адрес не появился")
    if addr == prev:
        raise RuntimeError("temp-mail: адрес не ротируется")
    page._tm_addr = addr
    return {"addr": addr, "kind": "temp-mail"}


def _emailnator_address(page):
    page._tm_addr = None  # сброс привязки temp-mail при смене провайдера
    prev = getattr(page, "_en_addr", None)
    for attempt in range(1, 4):
        page.goto(EMAILNATOR, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector(".mf-chip", timeout=30000)
        sleep(3000)
        try:
            page.locator("#accept-cookies-usage").click(timeout=5000)
        except Exception:
            pass
        page.evaluate(KILL_OVERLAYS)

        # выбор gmail-домена: +Gmail/.Gmail включены, Domain/GoogleMail выключены
        page.evaluate("""() => {
          const want = { 'Domain': false, 'GoogleMail': false, '+Gmail': true, '.Gmail': true };
          for (const c of document.querySelectorAll('.mf-chip')) {
            const name = c.innerText.trim();
            if (!(name in want)) continue;
            if ((c.getAttribute('aria-pressed') === 'true') !== want[name]) c.click();
          }
        }""")
        sleep(1000)
        page.evaluate(KILL_OVERLAYS)

        if prev or attempt > 1:
            page.evaluate("""() => {
              [...document.querySelectorAll('.mf-btn-ghost, button')]
                .find((b) => /generate new/i.test(b.innerText || ''))?.click();
            }""")
            sleep(3000)
            page.evaluate(KILL_OVERLAYS)

        page.evaluate("() => document.querySelector('.mf-btn-go')?.click()")
        try:
            page.wait_for_url(re.compile(r"/inbox#"), timeout=25000)
        except Exception:
            pass

        addr = ""
        if "#" in page.url:
            addr = unquote(page.url.split("#", 1)[1])
        if "@" not in addr:
            addr = page.evaluate("() => document.querySelector('.mf-mono')?.innerText?.trim() || ''")
        if "@" not in addr:
            raise RuntimeError(f"emailnator: адрес не появился (попытка {attempt})")
        if addr == prev:
            continue
        if re.search(r"@(gmail|googlemail)\.com$", addr):
            page._en_addr = addr
            return {"addr": addr, "kind": "emailnator"}
    raise RuntimeError("emailnator: gmail-адрес не выдаётся")


def new_address(page, provider="tempmail"):
    first = ("tempmail", _tempmail_address) if provider == "tempmail" else ("emailnator", _emailnator_address)
    second = ("emailnator", _emailnator_address) if provider == "tempmail" else ("tempmail", _tempmail_address)
    try:
        return first[1](page)
    except Exception as e:  # noqa: BLE001
        print(f"[mail] {first[0]} не дал адрес ({e}) — откат на {second[0]}", flush=True)
        return second[1](page)


READ_MESSAGE = """() => {
  let text = (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 6000);
  const links = [];
  for (const a of document.querySelectorAll('a[href]')) {
    if (a.href.startsWith('http')) links.push(a.href);
  }
  for (const f of document.querySelectorAll('iframe')) {
    try {
      const d = f.contentDocument;
      if (!d) continue;
      text += ' ' + (d.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 4000);
      for (const a of d.querySelectorAll('a[href]')) {
        if (a.href.startsWith('http')) links.push(a.href);
      }
    } catch (e) {}
  }
  return { text, links: [...new Set(links)] };
}"""

FIND_ROW = """(src) => {
  const re = new RegExp(src, 'i');
  const box = document.querySelector('[data-qa="inbox"]') || document.body;
  const rows = [...box.querySelectorAll('a, li, tr, [class*=message], [class*=row]')]
    .filter((r) => r.innerText && r.innerText.trim().length > 2 && re.test(r.innerText));
  if (!rows.length) return null;
  const row = rows[0];
  return {
    text: row.innerText.replace(/\\s+/g, ' ').trim(),
    href: row.tagName === 'A' ? row.href : (row.querySelector('a[href]')?.href || null),
  };
}"""


def wait_message(page, sender_re, timeout_s=180):
    """ждёт письмо от отправителя через интерфейс; возвращает {text, links}"""
    import time as _t

    deadline = _t.time() + timeout_s
    while _t.time() < deadline:
        on_tempmail = "temp-mail.io" in page.url
        if on_tempmail:
            try:
                page.locator('[data-qa="refresh-button"]').click(timeout=6000)
            except Exception:
                pass
            sleep(1200)
        else:
            page.evaluate(
                "() => [...document.querySelectorAll('button, a')]"
                ".find((e) => /^\\s*reload\\s*$/i.test(e.innerText || ''))?.click()"
            )
            sleep(3500)

        hit = page.evaluate(FIND_ROW, sender_re.pattern)
        if hit:
            if hit.get("href"):
                page.goto(hit["href"], wait_until="domcontentloaded", timeout=60000)
            else:
                page.evaluate(
                    """(src) => {
                      const re = new RegExp(src, 'i');
                      const box = document.querySelector('[data-qa="inbox"]') || document.body;
                      const row = [...box.querySelectorAll('a, li, tr, [class*=message], [class*=row]')]
                        .find((r) => r.innerText && r.innerText.trim().length > 2 && re.test(r.innerText));
                      if (row) (row.tagName === 'A' ? row : row.querySelector('a[href]') || row).click();
                    }""",
                    sender_re.pattern,
                )
            sleep(3000)
            body = page.evaluate(READ_MESSAGE)
            return {"text": hit["text"] + " " + body["text"], "links": body["links"]}
        sleep(4500)
    raise RuntimeError(f"письмо не пришло от {sender_re.pattern}")


def message_link(links, href_re):
    for l in links or []:
        if href_re.search(l):
            return l
    return None


def extract_code(text):
    m = re.search(r"\b(\d{6})\b", str(text))
    return m.group(1) if m else None
