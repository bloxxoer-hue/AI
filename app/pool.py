# пул заранее зарегистрированных slice-аккаунтов с кредитами:
# пока пользователь ждёт только рендер, фон уже успел и код, и триал
import json
import os
import time
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
POOL_DIR = os.path.join(ROOT, "rpa_pool")
os.makedirs(POOL_DIR, exist_ok=True)
READY_FILE = os.path.join(POOL_DIR, "ready.json")


def _read():
    try:
        with open(READY_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def _write(items):
    with open(READY_FILE, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)


def count():
    return len([i for i in _read() if os.path.exists(i["state"])])


def pop():
    items = _read()
    for i, item in enumerate(items):
        if os.path.exists(item["state"]):
            del items[i]
            _write(items)
            return item
    return None


def push(state_path, balance):
    items = _read()
    items.append({"state": state_path, "balance": balance, "createdAt": int(time.time() * 1000)})
    _write(items)


def pending_file():
    return os.path.join(POOL_DIR, f"state-{uuid.uuid4().hex[:10]}.json")
