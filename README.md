# video-generator-py

Python-версия (FastAPI + Playwright). Все четыре режима: MiniMax H3, Kling 2.1,
AI Photo, TikTok/Shorts — браузер сам регистрирует аккаунты через temp-почту,
вводит промты, ждёт генерацию и скачивает результат в `outputs/`.

Человек во время генерации ничего не делает — только ждёт готовый файл в интерфейсе.

## Запуск локально (Windows)

```bash
cd video-generator-py
python -m venv venv
venv\Scripts\pip install -r requirements.txt
venv\Scripts\python -m playwright install chromium
venv\Scripts\python -m uvicorn app.main:app --port 3100
```

Открыть `http://localhost:3100`.

## Деплой на Render (Docker — браузеры уже внутри образа)

В `Dockerfile` базовый образ `mcr.microsoft.com/playwright/python` — chromium и
все системные библиотеки в нём уже есть, поэтому **никаких `playwright install`
на сборке и никаких ошибок** вида «Executable doesn't exist» / «su: failure».

1. Залей **всю** папку проекта в GitHub (см. корневой README — там список файлов).
2. Render → **New + → Web Service** → выбери репозиторий.
3. В форме:
   - **Root Directory**: `video-generator-py`
   - **Language / Environment**: **Docker**
   - Build/Start команды не нужны (их нет у Docker — всё из Dockerfile)
4. Deploy.

`render.yaml` в этой папке — готовая конфигурация Blueprint (`runtime: docker`,
`rootDir: video-generator-py`), можно сразу через **New + → Blueprint**.

## Структура

```
app/main.py         — FastAPI: статика + API (/api/generate/:mode, /api/job/:id)
app/jobs.py         — очередь: строго одна задача за раз, логи шагов
app/browser.py      — playwright: потоко-локальные браузеры, живой Chrome если есть
app/mail.py         — temp-mail.io (любые домены) + emailnator (gmail для slice)
app/register.py     — авто-регистрация h3 / polyfaced / slice
app/media.py        — забора результата: трафик mp4/webm, DOM, кнопка Download
app/sites/          — сценарии генерации по сайтам
app/pool.py         — пул заранее подготовленных slice-аккаунтов
app/warmer.py       — фон готовит аккаунты slice (регистрация + триал)
public/             — интерфейс (тот же, что у node-версии)
outputs/            — готовые видео/фото
```

## Режимы

| Режим | Сайт | Длительность | Почта |
|---|---|---|---|
| MiniMax H3 | h3-max.me | 5–8 сек | temp-mail → emailnator (фолбэк) |
| Kling 2.1 | polyfaced.com | 1–5 сек | temp-mail |
| Фото | polyfaced.com | — | temp-mail, GPT Image 2 / Nano Banana |
| TikTok/Shorts | slice.video | 15 сек (trial) | emailnator (gmail) — slice блокирует temp-домены |

Нюанс slice: свежий аккаунт стартует с ◆0 — триал (200 ◆) приходит не всегда,
поэтому warmer в фоне держит запас аккаунтов с кредитами: запрос генерации берёт
готовый с полки и ждёт только рендер.
