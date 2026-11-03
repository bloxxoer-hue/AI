# авто-регистрация через temp-почту: h3-max (письмо → verify), polyfaced (без
# верификации), slice (6-значный код).PASSWORD и имя — единые для всех
import re

from .browser import sleep
from .mail import extract_code, message_link, new_address, wait_message

PASSWORD = "VidStuDio!2026x"
NAME = "studio nyx"


def _h3_logged_in(page):
    if "h3-max.me" not in page.url:
        return False
    sign_in = page.locator('header button:has-text("Sign in")')
    if sign_in.count() == 0:
        return True
    return not sign_in.first.is_visible()


def _read_verify_and_login(page, mail_page, log, addr, mail_timeout_s):
    msg = wait_message(mail_page, re.compile("h3-max", re.I), mail_timeout_s)
    verify = message_link(msg["links"], re.compile("verify-email", re.I))

    # ссылка может быть спрятана в HTML письма
    if not verify:
        html = mail_page.content()
        m = re.search(r"https?://[^\s'\"<>\\]+verify-email[^\s'\"<>\\]*", html, re.I)
        if m:
            verify = m.group(0).replace("&amp;", "&")

    # кнопка с JS-переходом — кликаем и ловим навигацию
    if not verify:
        try:
            with mail_page.expect_navigation(timeout=12000):
                mail_page.get_by_text(re.compile("confirm email", re.I)).first.click(timeout=6000)
            verify = mail_page.url
        except Exception:
            verify = mail_page.url if "h3-max" in mail_page.url else None

    if not verify or "h3-max" not in verify:
        raise RuntimeError("verify-ссылка не найдена в письме")

    page.goto(verify, wait_until="domcontentloaded", timeout=60000)
    sleep(3000)
    log("email подтверждён")

    if not _h3_logged_in(page):
        log("вхожу email/password…")
        page.click('[data-testid="navbar-login-trigger"]', timeout=15000)
        page.click('button:has-text("Sign in with email")', timeout=10000)
        page.fill('input[type="email"]', addr)
        page.fill('input[type="password"]', PASSWORD)
        page.click('button[type="submit"]', timeout=10000)
        sleep(4000)
        if not _h3_logged_in(page):
            raise RuntimeError("вход не подтвердился после verify")


def register_h3(page, on_progress):
    log = lambda m: on_progress(f"h3: {m}")  # noqa: E731
    mail_page = page.context.new_page()
    try:
        addr = None
        # цикл живёт и по форме (400 Invalid email), и по письму: не вышло читать
        # письмо на temp-mail — следующая попытка на emailnator (там ссылка в DOM)
        attempt = 1
        while attempt <= 4 and not addr:
            page.goto("https://h3-max.me/", wait_until="domcontentloaded", timeout=60000)
            sleep(1500)

            provider = "tempmail" if attempt == 1 else "emailnator"
            a = new_address(mail_page, provider)
            addr = a["addr"]
            log(f"temp-почта ({a['kind']}): {addr}")

            page.click('[data-testid="navbar-login-trigger"]', timeout=20000)
            page.click('button:has-text("Sign up")', timeout=8000)
            page.fill('input[name="name"]', NAME)
            page.fill('input[name="email"]', addr)
            page.fill('input[name="password"]', PASSWORD)
            page.fill('input[name="confirmPassword"]', PASSWORD)

            resp = None
            try:
                with page.expect_response(
                    lambda r: re.search(r"/api/auth/sign-?up", r.url) and r.request.method == "POST",
                    timeout=60000,
                ) as ri:
                    page.click('[data-testid="auth-register-submit"]')
                resp = ri.value
            except Exception:
                pass

            if not (resp and resp.ok):
                info = f"HTTP {resp.status}" if resp else "ответ не пришёл"
                why = ""
                if resp:
                    try:
                        why = resp.text()[:120]
                    except Exception:
                        why = ""
                log(f"попытка {attempt} не прошла [{info}] — пробую другой адрес")
                addr = None
                attempt += 1
                continue

            log("регистрация принята (200), читаю письмо...")
            try:
                mail_timeout = 45 if provider == "tempmail" else 120
                _read_verify_and_login(page, mail_page, log, addr, mail_timeout)
                break
            except Exception as e:  # noqa: BLE001
                log(f"письмо/verify не вышло ({e}) — попытка {attempt + 1}, другой провайдер")
                addr = None
                attempt += 1

        if not addr:
            raise RuntimeError("h3: не удалось получить рабочий аккаунт за 4 попытки")
        log("аккаунт готов")
    finally:
        mail_page.close()


def register_polyfaced(page, on_progress):
    log = lambda m: on_progress(f"polyfaced: {m}")  # noqa: E731
    mail_page = page.context.new_page()
    try:
        page.goto("https://polyfaced.com/sign-up", wait_until="domcontentloaded", timeout=60000)
        a = new_address(mail_page, "tempmail")
        log(f"temp-почта ({a['kind']}): {a['addr']}")

        page.fill("#name", NAME)
        page.fill("#email", a["addr"])
        page.fill("#password", PASSWORD)
        page.fill("#confirmPassword", PASSWORD)
        page.click('form button[type="submit"], form button:has-text("Sign Up")')
        try:
            page.wait_for_url(re.compile(r"/(studio|$)"), timeout=30000)
        except Exception:
            pass
        log("аккаунт создан")
    finally:
        mail_page.close()


def register_slice(page, on_progress):
    log = lambda m: on_progress(f"slice: {m}")  # noqa: E731
    mail_page = page.context.new_page()
    try:
        page.goto("https://slice.video/registration/new", wait_until="domcontentloaded", timeout=60000)
        # slice блокирует явно-временные домены — для него emailnator c gmail-выбором
        a = new_address(mail_page, "emailnator")
        log(f"temp-почта ({a['kind']}): {a['addr']}")

        page.fill('input[name="email_address"]', a["addr"])
        page.click(
            'button:has-text("Email me a code"), '
            'input[type="submit"][value="Email me a code"], input[type="submit"][name="commit"]'
        )
        page.wait_for_url(re.compile(r"session/code"), timeout=30000)
        log("ждём 6-значный код…")

        msg = None
        try:
            msg = wait_message(mail_page, re.compile(r"slice\.video", re.I), 120)
        except Exception:
            log("первое письмо не пришло — запрашиваю код заново")
            try:
                page.click('a:has-text("Send a new code"), button:has-text("Send a new code")', timeout=10000)
            except Exception:
                pass
            msg = wait_message(mail_page, re.compile(r"slice\.video", re.I), 150)
        code = extract_code(msg["text"])
        if not code:
            raise RuntimeError("slice: код не найден в письме")
        log(f"код {code}")

        page.fill(
            'input#code, input[name="code"], input[placeholder="123456"], input[placeholder="6-digit code"]',
            code,
        )
        try:
            page.click(
                'input[type="submit"][name="commit"], '
                'button[type="submit"]:has-text("Continue"), button:has-text("Continue")',
                timeout=10000,
            )
        except Exception:
            page.keyboard.press("Enter")
        page.wait_for_url(re.compile(r"videos"), timeout=30000)
        log("аккаунт создан")
    finally:
        mail_page.close()
