# h3-max.me — MiniMax H3 Turbo: текст→видео / фото→видео, дурэйшн 5-8s
import os
import re
import time

from ..browser import fresh_session, human_pause, sleep
from ..media import OUTPUTS, grab_from_page, snapshot_media, wait_result
from ..register import register_h3

SITE = "https://h3-max.me/"


def generate(p, on_progress):
    label = "h3-max"
    ctx, page = fresh_session()
    tmp = None
    try:
        on_progress(f"{label}: регистрируем аккаунт...")
        register_h3(page, on_progress)

        image_mode = bool(p.get("image_path"))
        on_progress(f"{label}: открываем генератор...")
        mode_url = SITE + ("?mode=image" if image_mode else "?mode=text") + "#generator"
        page.goto(mode_url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector("textarea", timeout=30000)

        baseline = snapshot_media(page)

        if image_mode:
            try:
                page.click("#tab-image")
            except Exception:
                pass
        else:
            try:
                page.click("#tab-text")
            except Exception:
                pass

        on_progress(f"{label}: вписываем промпт...")
        human_pause()
        page.locator("textarea").first.fill(p["prompt"])

        dur = str(min(8, max(5, int(p.get("duration") or 6))))
        sel = page.locator('select[name="duration"]')
        if sel.count() > 0:
            try:
                sel.select_option(dur)
            except Exception:
                try:
                    sel.select_option(index=0)
                except Exception:
                    pass
            sleep(300)

        aspect = p.get("aspect_ratio")
        if aspect:
            ar = page.get_by_role("button", name=aspect, exact=True).first
            try:
                if ar.count() > 0 and ar.is_visible():
                    ar.click()
            except Exception:
                pass

        if image_mode:
            on_progress(f"{label}: загружаем фото...")
            page.locator('input[type="file"]').first.set_input_files(p["image_path"])
            sleep(1500)

        # ловим отказ сервера (нехватка кредитов) — генерация либо ушла, либо нет
        failure = []

        def on_resp(r):
            try:
                if "/api/video/jobs" in r.url and r.request.method == "POST" and not r.ok:
                    try:
                        msg = r.json().get("error") or f"HTTP {r.status}"
                    except Exception:
                        msg = f"HTTP {r.status}"
                    failure.append(msg)
            except Exception:
                pass

        page.on("response", on_resp)
        try:
            on_progress(f"{label}: нажимаем Generate...")
            page.locator("button").filter(has_text=re.compile("^Generate")).first.click()
            on_progress(f"{label}: генерация идёт на стороне сайта...")

            start = time.time()
            while time.time() - start < 720:
                if failure:
                    raise RuntimeError("генерация не запустилась: " + failure[0])
                # запрос ушёл? проверяем по ответу в первые секунды не надо — ждём медиа
                try:
                    url = wait_result(page, baseline, timeout_s=15, on_progress=None, label=label)
                    return url
                except Exception:
                    continue
            raise RuntimeError("timeout генерации (12 мин)")
        finally:
            try:
                page.remove_listener("response", on_resp)
            except Exception:
                pass
    finally:
        try:
            ctx.close()
        except Exception:
            pass
