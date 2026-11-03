# фоновый догоняльщик пула slice: регистрирует аккаунт, ждёт триал-кредиты,
# кладёт готовый в pool. запросы генерации берут готовый аккаунт мгновенно.
import threading
import time

from . import pool
from .browser import fresh_session, sleep
from .register import register_slice

TARGET = 2            # держим столько готовых аккаунтов
TRIAL_WAIT_S = 75 * 60
TICK_MS = 30000

_lock = threading.Lock()
_thread = None


def kick():
    global _thread
    with _lock:
        if _thread and _thread.is_alive():
            return
        _thread = threading.Thread(target=_loop, daemon=True, name="slice-pool")
        _thread.start()


def balance(page):
    return page.evaluate(
        "() => Number((document.body.innerText.match(/◆\\s*(\\d+)/) || [])[1] || 0)"
    )


def _loop():
    while pool.count() < TARGET:
        ctx, page = fresh_session()
        state_path = pool.pending_file()
        try:
            page.goto("https://slice.video", wait_until="domcontentloaded", timeout=60000)
            register_slice(page, lambda m: print(f"[pool] {m}", flush=True))

            t0 = time.time()
            while True:
                bal = 0
                try:
                    bal = balance(page)
                except Exception:
                    pass
                waited = int((time.time() - t0) / 60)
                if bal > 0:
                    ctx.storage_state(path=state_path)
                    pool.push(state_path, bal)
                    print(f"[pool] аккаунт готов: ◆{bal} (ждали {waited} мин), в пуле {pool.count()}", flush=True)
                    break
                if time.time() - t0 > TRIAL_WAIT_S:
                    print(f"[pool] триал не пришёл за {waited} мин — аккаунт в утиль", flush=True)
                    break
                if waited and waited % 5 == 0:
                    print(f"[pool] ждём триал на свежем аккаунте... {waited} мин", flush=True)
                sleep(TICK_MS)
                try:
                    page.reload(wait_until="domcontentloaded")
                except Exception:
                    pass
                sleep(2500)
        except Exception as e:  # noqa: BLE001
            print(f"[pool] ошибка подготовки: {e}", flush=True)
            sleep(60000)
        finally:
            try:
                ctx.close()
            except Exception:
                pass
        if pool.count() >= TARGET:
            break
