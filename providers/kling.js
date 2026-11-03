import crypto from "node:crypto";

const BASE = process.env.KLING_BASE_URL || "https://api.klingai.com";
const MODEL = process.env.KLING_MODEL || "kling-v2-1";

function jwt() {
  const ak = process.env.KLING_ACCESS_KEY;
  const sk = process.env.KLING_SECRET_KEY;
  if (!ak || !sk) throw new Error("нет KLING_ACCESS_KEY / KLING_SECRET_KEY в .env");
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = b64({ alg: "HS256", typ: "JWT" });
  const payload = b64({
    iss: ak,
    exp: now + 1800,
    nbf: now - 5,
  });
  const sig = crypto
    .createHmac("sha256", sk)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${sig}`;
}

async function kling(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt()}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.code !== 0) {
    throw new Error(data.message || `Kling HTTP ${res.status}`);
  }
  return data;
}

/** prompt, duration (1-5) */
export async function generate({ prompt, duration }, onProgress) {
  const data = await kling("/v1/videos/text2video", {
    model_name: MODEL,
    prompt,
    negative_prompt: "",
    mode: "std",
    duration: String(Math.min(5, Math.max(1, Number(duration) || 5))),
    cfg_scale: 0.5,
    aspect_ratio: "16:9",
  });
  const taskId = data.data?.task_id;
  if (!taskId) throw new Error("Kling: нет task_id");
  onProgress?.("задача создана, ждём видео...");

  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const q = await kling(`/v1/videos/text2video/${taskId}`);
    const status = q.data?.task_status;
    if (status === "succeed") {
      const url = q.data?.task_result?.videos?.[0]?.url;
      if (!url) throw new Error("Kling: пустой url");
      return { url };
    }
    if (status === "failed") throw new Error(q.data?.task_status_msg || "Kling task failed");
    onProgress?.(`статус: ${status || "queued"}`);
  }
  throw new Error("Kling: timeout");
}
