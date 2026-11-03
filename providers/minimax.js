const BASE = process.env.MINIMAX_BASE_URL || "https://api.minimax.io";
const MODEL = process.env.MINIMAX_MODEL || "MiniMax-Hailuo-02";

async function api(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.MINIMAX_API_KEY}`,
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data.base_resp && data.base_resp.status_code !== 0)) {
    const msg = data.base_resp?.status_msg || data.message || `MiniMax HTTP ${res.status}`;
    const err = new Error(msg);
    err.retryable = /duration|duration is not/i.test(msg);
    throw err;
  }
  return data;
}

async function startTask(body) {
  const q = process.env.MINIMAX_GROUP_ID ? `?GroupId=${process.env.MINIMAX_GROUP_ID}` : "";
  const data = await api(`/v1/video_generation${q}`, { method: "POST", body: JSON.stringify(body) });
  return data.task_id;
}

async function poll(taskId, onProgress) {
  const q = process.env.MINIMAX_GROUP_ID ? `?GroupId=${process.env.MINIMAX_GROUP_ID}` : "";
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const data = await api(`/v1/query/video_generation${q}&task_id=${taskId}`);
    const status = data.status;
    onProgress?.(data.status_msg === "processing" ? "генерация..." : status);
    if (status === "Success") return data.file_id;
    if (status === "Fail") throw new Error(data.status_msg || "MiniMax task failed");
  }
  throw new Error("MiniMax: timeout");
}

async function getFileIdUrl(fileId) {
  const data = await api(`/v1/files/retrieve?file_id=${fileId}`);
  return data.file?.download_url;
}

/**
 * prompt, duration (1-8), aspectRatio ("16:9" | "9:16" | "1:1"), imageBase64?
 */
export async function generate({ prompt, duration, aspectRatio, imageBase64 }, onProgress) {
  const base = {
    model: MODEL,
    prompt,
    duration: String(Math.min(8, Math.max(1, Number(duration) || 6))),
    aspect_ratio: aspectRatio || "16:9",
  };
  if (imageBase64) base.first_frame_image = `data:image/png;base64,${imageBase64}`;

  let taskId;
  try {
    taskId = await startTask(base);
  } catch (err) {
    // MiniMax принимает только 6/10 у части моделей
    if (err.retryable) {
      base.duration = Number(duration) > 6 ? "10" : "6";
      taskId = await startTask(base);
    } else throw err;
  }

  onProgress?.("задача создана, ждём видео...");
  const fileId = await poll(taskId, onProgress);
  const url = await getFileIdUrl(fileId);
  if (!url) throw new Error("MiniMax: пустой download_url");
  return { url };
}
