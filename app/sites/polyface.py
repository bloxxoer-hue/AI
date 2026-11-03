# polyfaced.com — Kling 2.1 video (≤5s) и AI photo (GPT Image 2 / Nano Banana)
import re
import time

from ..browser import fresh_session, human_pause, sleep
from ..media import snapshot_media, wait_result
from ..register import register_polyfaced

STUDIO_VIDEO = "https://polyfaced.com/studio/video"
STUDIO_IMAGE = "https://polyfaced.com/studio/image"


def _open_studio(page, url, on_progress):
    on_progress("polyfaced: регистрируем аккаунт...")
    register_polyfaced(page, on_progress)
    page.goto(url, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_selector("#prompt", timeout=30000)


def _pick_model(page, want_re, on_progress):
    """кнопка модели: раскрываем выпашку и выбираем пункт"""
    try:
        trigger = page.locator("button").filter(has_text=re.compile("active")).first
        if trigger.count() > 0:
            cur = (trigger.text_content() or "").strip()
            if want_re.search(cur):
                return
            trigger.click()
            sleep(400)
            opts = page.locator(
                '[role="option"], [role="menuitem"], [role="radio"], [role="menuitemradio"]'
            )
            for i in range(opts.count()):
                opt = opts.nth(i)
                text = (opt.text_content() or "").strip()
                if want_re.search(text) and opt.is_visible():
                    opt.click()
                    sleep(300)
                    return
            fallback = page.locator("button").filter(has_text=want_re).first
            if fallback.count() > 0:
                fallback.click(timeout=4000)
                return
        else:
            any_btn = page.locator("button").filter(has_text=want_re).first
            if any_btn.count() > 0:
                return
    except Exception:
        pass
    on_progress(f"polyfaced: выбор модели {want_re.pattern} не найден, оставляю по умолчанию")


def generate_kling(p, on_progress):
    label = "polyfaced/kling"
    ctx, page = fresh_session()
    try:
        on_progress(f"{label}: открываем студию...")
        _open_studio(page, STUDIO_VIDEO, on_progress)
        baseline = snapshot_media(page)

        on_progress(f"{label}: выбираем Kling 2.1...")
        _pick_model(page, re.compile(r"Kling\s*2\.1", re.I), on_progress)

        on_progress(f"{label}: вписываем промпт...")
        human_pause()
        page.locator("#prompt").fill(p["prompt"])

        dur = min(5, max(1, int(p.get("duration") or 5)))
        trig = page.locator("#duration")
        if trig.count() > 0:
            try:
                cur = (trig.text_content() or "").strip()
                if not re.match(rf"^{dur}\s*(s|ec|сек)?", cur, re.I):
                    trig.click()
                    sleep(400)
                    cand = page.locator(
                        f'button:has-text("{dur}s"), button:has-text("{dur} sec"), '
                        f'[role="radio"]:has-text("{dur}")'
                    ).first
                    cand.click(timeout=5000)
            except Exception:
                on_progress(f"{label}: кнопка длительности не найдена")
        on_progress(f"{label}: длительность: {dur}s (kling max 5)")

        ar = p.get("aspect_ratio")
        if ar:
            art = page.locator("#aspect-ratio")
            if art.count() > 0:
                try:
                    art.click()
                    sleep(400)
                    page.locator(f'button:text-is("{ar}"), [role="radio"]:text-is("{ar}")').first.click(timeout=4000)
                except Exception:
                    pass

        on_progress(f"{label}: нажимаем Create Video...")
        page.locator("button").filter(has_text=re.compile("^Create Video")).first.click()
        sleep(2500)
        on_progress(f"{label}: генерация идёт на стороне сайта...")
        return wait_result(page, baseline, timeout_s=720, on_progress=on_progress, label=label)
    finally:
        try:
            ctx.close()
        except Exception:
            pass


def generate_photo(p, on_progress):
    label = "polyfaced/photo"
    ctx, page = fresh_session()
    try:
        on_progress(f"{label}: открываем фотостудию...")
        _open_studio(page, STUDIO_IMAGE, on_progress)
        baseline = snapshot_media(page)

        wanted = re.compile(r"nano\s*banana|banana", re.I) if p.get("model") == "nano-banana" else re.compile(
            r"GPT\s*Image\s*2", re.I
        )
        _pick_model(page, wanted, on_progress)

        if p.get("image_path"):
            on_progress(f"{label}: включаем режим с референсом...")
            i2i = page.locator("button").filter(has_text=re.compile("^Image to Image")).first
            if i2i.count() > 0:
                i2i.click()
            sleep(800)
            page.locator('input[type="file"]').first.set_input_files(p["image_path"])
            sleep(1500)

        on_progress(f"{label}: вписываем промпт...")
        human_pause()
        page.locator("#prompt").fill(p["prompt"])

        on_progress(f"{label}: нажимаем Create Image...")
        page.locator("button").filter(has_text=re.compile("^Create Image")).first.click()
        sleep(2500)
        on_progress(f"{label}: генерация идёт на стороне сайта...")
        return wait_result(page, baseline, timeout_s=480, on_progress=on_progress, label=label)
    finally:
        try:
            ctx.close()
        except Exception:
            pass
