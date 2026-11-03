import "dotenv/config";
import express from "express";

process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as minimax from "./providers/minimax.js";
import * as kling from "./providers/kling.js";
import * as photo from "./providers/photo.js";
import { sites, SITE_LIST } from "./rpa/index.js";
import { hasSession, stateExists } from "./rpa/session.js";
import { kickWarmer } from "./rpa/warmer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUTS = path.join(__dirname, "outputs");
fs.mkdirSync(OUTPUTS, { recursive: true });

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/outputs", express.static(OUTPUTS));

const jobs = new Map();

function createJob(mode) {
  const id = crypto.randomUUID();
  const job = { id, mode, status: "running", progress: "запуск...", result: null, error: null };
  jobs.set(id, job);
  if (jobs.size > 200) jobs.delete(jobs.keys().next().value);
  return job;
}

async function downloadTo(url, ext) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`скачивание не удалось: ${res.status}`);
  const name = `${crypto.randomUUID()}.${ext}`;
  await fs.promises.writeFile(path.join(OUTPUTS, name), Buffer.from(await res.arrayBuffer()));
  return `/outputs/${name}`;
}

// браузерные задачи идут строго по очереди: параллельные регистрации
// дёргают одни и те же сайты и ломают друг другу
let chain = Promise.resolve();

function run(job, fn) {
  chain = chain.then(() =>
    fn()
      .then((result) => {
        job.result = result;
        job.status = "done";
        job.progress = "готово";
      })
      .catch((err) => {
        job.status = "error";
        job.error = err.message || String(err);
        job.progress = "ошибка";
      })
  );
}

const hasMinimaxKey = () => Boolean(process.env.MINIMAX_API_KEY);
const hasKlingKey = () => Boolean(process.env.KLING_ACCESS_KEY && process.env.KLING_SECRET_KEY);
const hasPhotoKey = () => Boolean(process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY);

app.post("/api/generate/:mode", (req, res) => {
  const mode = req.params.mode;
  const body = req.body || {};
  const job = createJob(mode);
  const p = (msg) => (job.progress = msg);

  if (mode === "minimax") {
    if (!body.prompt?.trim()) return res.status(400).json({ error: "нет промта" });
    run(job, async () => {
      if (hasMinimaxKey()) {
        const out = await minimax.generate(
          {
            prompt: body.prompt.trim(),
            duration: body.duration,
            aspectRatio: body.aspectRatio,
            imageBase64: body.imageBase64 || null,
          },
          p
        );
        return { file: await downloadTo(out.url, "mp4") };
      }
      return await sites.h3max.generate(
        {
          prompt: body.prompt.trim(),
          duration: body.duration,
          aspectRatio: body.aspectRatio,
          imageBase64: body.imageBase64 || null,
          imageMime: body.imageMime || null,
        },
        p
      );
    });
  } else if (mode === "kling") {
    if (!body.prompt?.trim()) return res.status(400).json({ error: "нет промта" });
    run(job, async () => {
      if (hasKlingKey()) {
        const out = await kling.generate(
          { prompt: body.prompt.trim(), duration: body.duration },
          p
        );
        return { file: await downloadTo(out.url, "mp4") };
      }
      return await sites.polyface.generateKling(
        { prompt: body.prompt.trim(), duration: body.duration, aspectRatio: body.aspectRatio },
        p
      );
    });
  } else if (mode === "photo") {
    if (!body.prompt?.trim()) return res.status(400).json({ error: "нет промта" });
    run(job, async () => {
      if (hasPhotoKey()) {
        const out = await photo.generate(
          {
            prompt: body.prompt.trim(),
            model: body.model === "nano-banana" ? "nano-banana" : "gpt-image-2",
            referenceBase64: body.imageBase64 || null,
            referenceMime: body.imageMime || null,
          },
          p
        );
        return { file: await downloadTo(`data:image/png;base64,${out.b64}`, "png") };
      }
      return await sites.polyface.generatePhoto(
        {
          prompt: body.prompt.trim(),
          model: body.model === "nano-banana" ? "nano-banana" : "gpt-image-2",
          referenceBase64: body.imageBase64 || null,
          referenceMime: body.imageMime || null,
        },
        p
      );
    });
  } else if (mode === "slice") {
    if (!body.topic?.trim()) return res.status(400).json({ error: "нет темы" });
    run(job, async () => sites.slice.generate(body, p));
  } else {
    return res.status(404).json({ error: "неизвестный режим" });
  }

  res.json({ jobId: job.id });
});

app.get("/api/job/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "job not found" });
  res.json({
    id: job.id,
    mode: job.mode,
    status: job.status,
    progress: job.progress,
    result: job.result,
    error: job.error,
  });
});

// ---- аккаунты на сайтах ----
const loginLocks = new Set();

app.get("/api/sites", async (req, res) => {
  const list = [];
  for (const s of SITE_LIST) {
    let status = stateExists(s.id) ? "in" : "untouched";
    if (hasSession(s.id)) {
      try {
        status = await sites[s.id].status();
      } catch {}
    }
    list.push({ ...s, status });
  }
  res.json({ sites: list });
});

app.post("/api/sites/:id/login", async (req, res) => {
  const site = sites[req.params.id];
  if (!site) return res.status(404).json({ error: "нет такого сайта" });
  if (loginLocks.has(req.params.id)) return res.json({ ok: true, busy: true });
  loginLocks.add(req.params.id);
  try {
    await site.openLogin((msg) => console.log(msg));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    loginLocks.delete(req.params.id);
  }
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`video-generator-site → http://localhost:${port}`);
  // заранее готовим slice-аккаунты: пока триал капает — это фон, а не ожидание пользователя
  kickWarmer();
});
