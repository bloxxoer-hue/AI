# запуск браузера и свежие контексты: живой Chrome если есть, иначе bundled chromium
import os
import platform
import random
import time

from playwright.sync_api import sync_playwright

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36"
)

_pw = None
_browser = None
_tls = __import__("threading").local()  # у каждого потока свой playwright — sync-API не переживает переходы


def sleep(ms):
    time.sleep(ms / 1000.0)


def rnd(a, b):
    return random.uniform(a, b)


def human_pause(ms_from=120, ms_to=340):
    sleep(rnd(ms_from, ms_to))


def launch_browser():
    """браузер текущего потока (главный/джобы/пул — у каждого свой)"""
    existing = getattr(_tls, "browser", None)
    if existing:
        return existing

    pw = sync_playwright().start()
    headless = os.environ.get("HEADLESS") == "1" or platform.system() == "Linux"
    args = [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
    ]
    errors = []
    browser = None
    for kwargs in ({"channel": "chrome"}, {}):
        try:
            browser = pw.chromium.launch(headless=headless, args=args, **kwargs)
            break
        except Exception as e:  # noqa: BLE001 — собираем причины всех попыток
            errors.append(str(e).split("\n")[0][:160])
    if not browser:
        pw.stop()
        raise RuntimeError(
            "браузер не установлен — выполни: python -m playwright install chromium "
            "(или поставь Google Chrome). Причина: " + (errors[-1] if errors else "нет деталей")
        )
    _tls.pw = pw
    _tls.browser = browser
    return browser


def fresh_session(storage_state=None):
    """свежий контекст = новый «человек»; storage_state — готовый аккаунт из пула"""
    browser = launch_browser()
    ctx = browser.new_context(
        viewport={"width": 1360, "height": 940},
        locale="ru-RU",
        user_agent=UA,
        storage_state=storage_state,
    )
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    ctx.add_init_script("Object.defineProperty(navigator,'webdriver',{get:()=>undefined})")
    return ctx, page
