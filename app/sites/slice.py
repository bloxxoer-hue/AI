# slice.video — TikTok/Shorts: /videos/new, фикс 15s, триал ◆200 (приходит не всегда)
import re
import time

from .. import pool, warmer
from ..browser import fresh_session, human_pause, sleep
from ..media import snapshot_media, wait_result
from ..register import register_slice

HOME = "https://slice.video"
NEW_FORM = f"{HOME}/videos/new"


def _balance(page):
    return page.evaluate(
        "() => Number((document.body.innerText.match(/◆\\s*(\\d+)/) || [])[1] || 0)"
    )


def _ensure_balance(page, on_progress):
    """триал на свежем аккаунте приходит не сразу/не всегда — ждём до 10 минут"""
    page.goto(f"{HOME}/videos", wait_until="domcontentloaded", timeout=60000)
    sleep(2500)
    t0 = time.time()
    while True:
        bal = 0
        try:
            bal = _balance(page)
        except Exception:
            pass
        if bal > 0:
            if time.time() - t0 > 5:
                on_progress(f"slice: кредиты на месте (◆ {bal})")
            return bal
        if time.time() - t0 > 600:
            raise RuntimeError("slice: триал-кредиты не пришли за 10 минут")
        on_progress("slice: ждём триал-кредиты (свежий аккаунт стартует с 0)...")
        sleep(20000)
        try:
            page.reload(wait_until="domcontentloaded")
        except Exception:
            pass
        sleep(2500)


def _start(on_progress):
    """готовый аккаунт из пула, иначе свежая регистрация"""
    item = pool.pop()
    warmer.kick()  # место в пуле заняли — фон готовит замену
    if item:
        on_progress(f"slice: берём готовый аккаунт из пула (◆ {item['balance']})")
        ctx, page = fresh_session(storage_state=item["state"])
        return ctx, page
    on_progress("slice: аккаунта нет — регистрируем новый через temp-почту...")
    ctx, page = fresh_session()
    try:
        page.goto(HOME, wait_until="domcontentloaded", timeout=60000)
        register_slice(page, on_progress)
        return ctx, page
    except Exception:
        try:
            ctx.close()
        except Exception:
            pass
        raise


def _click_label(page, pattern):
    lab = page.locator("label").filter(has_text=pattern).first
    try:
        if lab.count() == 0:
            return False
        lab.click(timeout=4000)
        return True
    except Exception:
        return False


def generate(p, on_progress):
    label = "slice"
    ctx, page = _start(on_progress)
    try:
        credits = _ensure_balance(page, on_progress)

        on_progress(f"{label}: открываем форму нового slice...")
        page.goto(NEW_FORM, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector("#video_prompt", timeout=30000)
        sleep(1200)

        baseline = snapshot_media(page)

        on_progress(f"{label}: вписываем тему...")
        human_pause()
        page.locator("#video_prompt").fill(p["topic"])

        dur = page.locator("#video_target_duration_s")
        if dur.count() > 0:
            try:
                dur.select_option("15")
                on_progress(f"{label}: длина 15s")
            except Exception:
                pass

        # motion=0 — still (доступен на триале), motion=1 — animated (нужен paid pack)
        if p.get("visuals") == "animated":
            anim = page.locator('input[name="video[motion]"][value="1"]')
            ok = anim.count() > 0 and not anim.first.is_disabled()
            if ok:
                anim.first.check(force=True)
                on_progress(f"{label}: визуал animated")
            else:
                on_progress(f"{label}: animated залочен на триале — ставим still images")
        elif p.get("visuals") == "still":
            _click_label(page, re.compile(r"still\s*images", re.I))

        if p.get("whoSpeaks") == "characters":
            ch = page.locator('input[name="video[speech_mode]"]:not([value="narration"])')
            ok = ch.count() > 0 and not ch.first.is_disabled()
            if ok:
                _click_label(page, re.compile(r"the\s*characters", re.I))
            else:
                on_progress(f"{label}: персонажи залочены на триале — ставим A narrator")

        style_value = {"Photoreal": "photorealistic", "Cinematic": "cinematic"}.get(
            p.get("visualStyle"), ""
        )
        style_radio = page.locator(f'input[name="video[style_preset]"][value="{style_value}"]')
        if style_radio.count() > 0:
            try:
                style_radio.first.check(force=True)
            except Exception:
                _click_label(page, re.compile("photoreal|cinematic|auto", re.I))
            on_progress(f"{label}: стиль {p.get('visualStyle') or 'Auto'}")

        if p.get("captions") is False:
            try:
                cb = page.locator("#video_captions_enabled")
                if cb.count() and cb.is_checked():
                    cb.uncheck(force=True)
            except Exception:
                pass

        # submit + ловля 422 (кредиты/валидация)
        on_progress(f"{label}: нажимаем Generate video (◆ {credits} на балансе)...")
        rejected = []

        def on_resp(r):
            try:
                if r.request.method == "POST" and r.status >= 400 and re.search(r"/videos(\?|$)", r.url):
                    try:
                        html = r.text()
                        m = re.search(r"[^<>]{0,80}(credits|error|invalid|too)[^<>]{0,120}", html, re.I)
                        rejected.append(m.group(0).strip() if m else f"HTTP {r.status}")
                    except Exception:
                        rejected.append(f"HTTP {r.status}")
            except Exception:
                pass

        page.on("response", on_resp)
        try:
            page.locator("#generate-slice-btn").first.click(timeout=15000)
            sleep(6000)
            if rejected:
                raise RuntimeError("slice: генерация отклонена — " + rejected[0])
            if not re.search(r"/videos/\d+", page.url):
                warn = page.evaluate(
                    "() => { const m = document.body.innerText.match(/[^^\\n]*(need|need[s]? about|not enough|"
                    "log in|sign in|Buy credits)[^^\\n]*/i); return m ? m[0].trim() : ''; }"
                )
                if warn:
                    raise RuntimeError("slice: форма не принята — " + warn)
                raise RuntimeError("slice: после Generate не открылась страница создания (url=" + page.url() + ")")
        finally:
            try:
                page.remove_listener("response", on_resp)
            except Exception:
                pass

        on_progress(f"{label}: видео создаётся на стороне сайта...")

        # статусы: Creating your video… → ready
        t0 = time.time()
        ready = False
        while time.time() - t0 < 1200:
            try:
                body = page.evaluate("() => document.body.innerText")
                if re.search(r"\bready\b", body, re.I) and page.locator("video").count() > 0:
                    ready = True
                    break
            except Exception:
                pass
            on_progress(f"{label}: рендерим... {int((time.time() - t0) / 60)} мин")
            sleep(5000)
        if not ready:
            on_progress(f"{label}: статус ready не пойман — забираем, что есть")

        result = wait_result(page, baseline, timeout_s=300, on_progress=on_progress, label=label)
        try:
            on_progress(f"{label}: готово (баланс после: ◆ {_balance(page)})")
        except Exception:
            pass
        return result
    finally:
        try:
            ctx.close()
        except Exception:
            pass
