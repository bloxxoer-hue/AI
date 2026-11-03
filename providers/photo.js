const OPENAI_BASE = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const GEMINI_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";

async function gptImage({ prompt, referenceBase64, referenceMime }, onProgress) {
  onProgress?.("gpt-image: рисуем...");

  if (referenceBase64) {
    const form = new FormData();
    form.append("model", process.env.OPENAI_IMAGE_MODEL || "gpt-image-2");
    form.append("prompt", prompt);
    form.append("image", new Blob([Buffer.from(referenceBase64, "base64")], {
      type: referenceMime || "image/png",
    }), "reference.png");

    const res = await fetch(`${OPENAI_BASE}/images/edits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `OpenAI HTTP ${res.status}`);
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) throw new Error("OpenAI: пустой ответ");
    return { b64 };
  }

  const res = await fetch(`${OPENAI_BASE}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-2",
      prompt,
      size: "1536x1024",
      n: 1,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `OpenAI HTTP ${res.status}`);
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI: пустой ответ");
  return { b64 };
}

async function nanoBanana({ prompt, referenceBase64, referenceMime }, onProgress) {
  onProgress?.("nano banana: рисуем...");
  const parts = [{ text: prompt }];
  if (referenceBase64) {
    parts.push({
      inline_data: {
        mime_type: referenceMime || "image/png",
        data: referenceBase64,
      },
    });
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts }] }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Gemini HTTP ${res.status}`);

  const outParts = data.candidates?.[0]?.content?.parts || [];
  const img = outParts.find((p) => p.inlineData?.data || p.inline_data?.data);
  const b64 = img?.inlineData?.data || img?.inline_data?.data;
  if (!b64) {
    const text = outParts.find((p) => p.text)?.text;
    throw new Error(text || "Nano Banana: нет изображения в ответе");
  }
  return { b64 };
}

/** model: "gpt-image-2" | "nano-banana" */
export async function generate({ prompt, model, referenceBase64, referenceMime }, onProgress) {
  if (model === "nano-banana") return nanoBanana({ prompt, referenceBase64, referenceMime }, onProgress);
  return gptImage({ prompt, referenceBase64, referenceMime }, onProgress);
}
