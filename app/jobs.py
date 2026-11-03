# очередь задач: строго по одной, логи шагов в job, результаты в outputs/
import os
import queue
import threading
import time
import uuid

MODES = {"minimax", "kling", "photo", "slice"}

jobs = {}
_q = queue.Queue()


def create_job(mode, params):
    job = {
        "id": uuid.uuid4().hex,
        "mode": mode,
        "status": "queued",
        "progress": "запуск...",
        "result": None,
        "error": None,
        "logs": [],
        "params": params,
        "createdAt": int(time.time() * 1000),
    }
    jobs[job["id"]] = job
    if len(jobs) > 200:
        old = sorted(jobs.values(), key=lambda j: j["createdAt"])[: len(jobs) - 200]
        for j in old:
            jobs.pop(j["id"], None)
    _q.put(job["id"])
    return job


def get_job(job_id):
    return jobs.get(job_id)


def list_jobs():
    return sorted(jobs.values(), key=lambda j: -j["createdAt"])


def _progress(job):
    def cb(msg):
        stamp = f"[{time.strftime('%H:%M:%S')}] {msg}"
        job["logs"].append(stamp)
        job["progress"] = msg
        print(f"job {job['id'][:8]} {stamp}", flush=True)

    return cb


def _run(job):
    from .sites import h3max, polyface, slice as slice_site

    p = job["params"]
    job["status"] = "running"
    log = _progress(job)
    log(f"старт режима {job['mode']}")
    try:
        if job["mode"] == "minimax":
            file = h3max.generate(p, log)
        elif job["mode"] == "kling":
            file = polyface.generate_kling(p, log)
        elif job["mode"] == "photo":
            file = polyface.generate_photo(p, log)
        elif job["mode"] == "slice":
            file = slice_site.generate(p, log)
        else:
            raise RuntimeError("неизвестный режим")
        job["result"] = {"file": file}
        job["status"] = "done"
        job["progress"] = "готово"
        log("готово")
    except Exception as e:  # noqa: BLE001
        job["status"] = "error"
        job["error"] = str(e)
        job["progress"] = "ошибка"
        log(f"ошибка: {e}")


def _worker():
    while True:
        job_id = _q.get()
        job = jobs.get(job_id)
        if job:
            _run(job)


def start_worker():
    t = threading.Thread(target=_worker, daemon=True, name="jobs")
    t.start()
