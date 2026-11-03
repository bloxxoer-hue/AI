# FastAPI: статика (public), очередь генерации, отдача результатов из outputs/
import os
import uuid

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import jobs as jobs_mod
from . import warmer
from .media import OUTPUTS

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = os.path.join(ROOT, "public")
TMP = os.path.join(ROOT, "tmp")
os.makedirs(TMP, exist_ok=True)

app = FastAPI(title="video generator")

SITES = [
    {"id": "h3max", "name": "h3-max.me", "url": "https://h3-max.me/"},
    {"id": "polyface", "name": "polyfaced.com", "url": "https://polyfaced.com/"},
    {"id": "slice", "name": "slice.video", "url": "https://slice.video/"},
]


@app.on_event("startup")
def _boot():
    jobs_mod.start_worker()
    warmer.kick()  # заранее готовим slice-аккаунты с кредитами


@app.post("/api/generate/{mode}")
async def generate(mode: str, request: Request):
    if mode not in jobs_mod.MODES:
        return JSONResponse({"error": "неизвестный режим"}, status_code=404)

    ctype = (request.headers.get("content-type") or "").lower()
    image_path = None
    image_name = None

    if ctype.startswith("application/json"):
        # интерфейс шлёт JSON, фото — base64
        body = await request.json()
        data = {k: (v if v is not None else "") for k, v in body.items()}
    else:
        # multipart/form-data или urlencoded
        form = await request.form()
        data = {k: v for k, v in form.items() if not hasattr(v, "read")}
        photo = form.get("photo")
        if photo is not None and hasattr(photo, "read") and getattr(photo, "filename", ""):
            ext = os.path.splitext(photo.filename)[1].lower() or ".png"
            image_path = os.path.join(TMP, f"{uuid.uuid4().hex}{ext}")
            with open(image_path, "wb") as f:
                f.write(await photo.read())
            image_name = photo.filename

    if not image_path and data.get("imageBase64"):
        import base64 as _b64

        mime = str(data.get("imageMime") or "image/png")
        ext = {"image/jpeg": ".jpg", "image/jpg": ".jpg", "image/webp": ".webp"}.get(mime, ".png")
        image_path = os.path.join(TMP, f"{uuid.uuid4().hex}{ext}")
        with open(image_path, "wb") as f:
            f.write(_b64.b64decode(data["imageBase64"]))
        image_name = "photo" + ext

    prompt = str(data.get("prompt") or data.get("topic") or "").strip()
    if not prompt:
        return JSONResponse({"error": "нет промта"}, status_code=400)

    def as_int(key, default):
        try:
            return int(data.get(key) or default)
        except (TypeError, ValueError):
            return default

    captions = data.get("captions")
    params = {
        "prompt": prompt,
        "topic": prompt,
        "duration": as_int("duration", 5),
        "aspect_ratio": data.get("aspectRatio") or data.get("aspect_ratio"),
        "model": data.get("model") or "gpt-image-2",
        "visuals": data.get("visuals") or "still",
        "whoSpeaks": data.get("whoSpeaks") or "narrator",
        "length": data.get("length") or "15s",
        "voiceover": data.get("voiceover"),
        "captions": (str(captions).lower() in ("1", "true", "on", "yes")) if captions is not None else True,
        "visualStyle": data.get("visualStyle") or "Auto",
        "image_path": image_path,
        "image_name": image_name,
    }
    job = jobs_mod.create_job(mode, params)
    return {"jobId": job["id"]}


@app.get("/api/job/{job_id}")
def job_status(job_id: str):
    job = jobs_mod.get_job(job_id)
    if not job:
        return JSONResponse({"error": "job not found"}, status_code=404)
    return {
        "id": job["id"],
        "mode": job["mode"],
        "status": job["status"],
        "progress": job["progress"],
        "result": job["result"],
        "error": job["error"],
        "logs": job["logs"],
    }


@app.get("/api/jobs")
def jobs_list():
    return [
        {
            "id": j["id"],
            "mode": j["mode"],
            "status": j["status"],
            "progress": j["progress"],
            "result": j["result"],
            "error": j["error"],
            "createdAt": j["createdAt"],
        }
        for j in jobs_mod.list_jobs()
    ]


@app.get("/api/sites")
def sites():
    return {"sites": [{**s, "status": "untouched"} for s in SITES]}


@app.post("/api/sites/{site_id}/login")
def site_login(site_id: str):
    # python-версия работает без ручных входов: аккаунты создаются сами
    return {"ok": True}


# --- результаты (видео/фото) ---
app.mount("/outputs", StaticFiles(directory=OUTPUTS), name="outputs")

# --- статика интерфейса ---
app.mount("/", StaticFiles(directory=PUBLIC, html=True), name="public")
