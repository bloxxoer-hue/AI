const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

let activeMode = "minimax";

// ---- режимы ----
$$(".mode").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$(".mode").forEach((b) => b.classList.remove("active"));
    $$(".panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    activeMode = btn.dataset.mode;
    $(`#panel-${activeMode}`).classList.add("active");
    hideResult();
  });
});

// ---- слайдеры ----
const bindRange = (rangeId, valId) => {
  const r = $(rangeId);
  r.addEventListener("input", () => ($(valId).textContent = r.value));
};
bindRange("#mx-duration", "#mx-dur-val");
bindRange("#kl-duration", "#kl-dur-val");

// ---- файлы ----
function bindFile(inputId) {
  const input = $(inputId);
  const name = input.parentElement.querySelector(".file-name");
  input.addEventListener("change", () => {
    name.textContent = input.files[0]?.name || "файл не выбран";
  });
}
bindFile("#mx-image");
bindFile("#ph-image");

function readImage(input) {
  const file = input.files[0];
  if (!file) return Promise.resolve(null);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ base64: reader.result.split(",")[1], mime: file.type });
    reader.readAsDataURL(file);
  });
}

// ---- статус / результат ----
const statusBox = $("#status");
const statusText = $("#status-text");

function showStatus(text) {
  statusBox.hidden = false;
  statusText.textContent = text;
}
function hideStatus() {
  statusBox.hidden = true;
}

function hideResult() {
  $("#result").hidden = true;
  $("#result-video").hidden = true;
  $("#result-image").hidden = true;
  $("#result-slice").hidden = true;
  $("#download").hidden = true;
}

function showVideo(file) {
  const v = $("#result-video");
  v.src = file;
  v.hidden = false;
  const d = $("#download");
  d.href = file;
  d.hidden = false;
  $("#result").hidden = false;
}

function showImage(file) {
  const img = $("#result-image");
  img.src = file;
  img.hidden = false;
  const d = $("#download");
  d.href = file;
  d.download = "image.png";
  d.hidden = false;
  $("#result").hidden = false;
}

// ---- история ----
function addToHistory(mode, result) {
  const list = $("#history-list");
  const empty = list.querySelector(".empty");
  if (empty) empty.remove();

  const item = document.createElement("div");
  item.className = "hist-item";
  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = mode;
  item.appendChild(tag);

  if (result.file) {
    if (result.file.endsWith(".mp4")) {
      const v = document.createElement("video");
      v.src = result.file;
      v.muted = true;
      v.loop = true;
      item.appendChild(v);
    } else {
      const img = document.createElement("img");
      img.src = result.file;
      item.appendChild(img);
    }
    const a = document.createElement("a");
    a.href = result.file;
    a.download = "";
    a.textContent = "скачать";
    item.appendChild(a);
  } else if (result.slice) {
    const a = document.createElement("a");
    a.href = result.slice.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = result.slice.title;
    item.appendChild(a);
  }
  list.prepend(item);
}

const MODE_NAMES = {
  minimax: "Minimax H3",
  kling: "Kling 2.1",
  photo: "Фото",
  slice: "TikTok / Shorts",
};

// ---- генерация ----
const btn = $("#generate");
btn.addEventListener("click", async () => {
  btn.disabled = true;
  hideResult();
  showStatus("собираем запрос...");

  try {
    let payload = {};

    if (activeMode === "minimax") {
      const prompt = $("#mx-prompt").value.trim();
      if (!prompt) throw new Error("впиши промпт");
      const img = await readImage($("#mx-image"));
      payload = {
        prompt,
        duration: Number($("#mx-duration").value),
        aspectRatio: $("#mx-aspect").value,
        imageBase64: img?.base64 || null,
        imageMime: img?.mime || null,
      };
    } else if (activeMode === "kling") {
      const prompt = $("#kl-prompt").value.trim();
      if (!prompt) throw new Error("впиши промпт");
      payload = { prompt, duration: Number($("#kl-duration").value) };
    } else if (activeMode === "photo") {
      const prompt = $("#ph-prompt").value.trim();
      if (!prompt) throw new Error("впиши промпт");
      const img = await readImage($("#ph-image"));
      payload = {
        prompt,
        model: $("#ph-model").value,
        imageBase64: img?.base64 || null,
        imageMime: img?.mime || null,
      };
    } else if (activeMode === "slice") {
      const topic = $("#sl-topic").value.trim();
      if (!topic) throw new Error("впиши тему");
      payload = {
        topic,
        visuals: document.querySelector('input[name="sl-visuals"]:checked').value,
        whoSpeaks: document.querySelector('input[name="sl-speaker"]:checked').value,
        length: $("#sl-length").value,
        voiceover: $("#sl-voiceover").value.trim(),
        captions: $("#sl-captions").checked,
        visualStyle: $("#sl-style").value,
      };
    }

    const res = await fetch(`/api/generate/${activeMode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    showStatus("задача ушла на сервер...");
    const job = await pollJob(data.jobId);
    hideStatus();

    if (job.result.file.endsWith(".mp4")) showVideo(job.result.file);
    else showImage(job.result.file);
    addToHistory(MODE_NAMES[activeMode], job.result);
  } catch (err) {
    showStatus(`ошибка: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

async function pollJob(id) {
  // slice иногда ждёт триал-кредиты минутами — держим поллинг до часа
  for (let i = 0; i < 1800; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(`/api/job/${id}`);
    const job = await res.json();
    if (job.status === "done") return job;
    if (job.status === "error") throw new Error(job.error);
    showStatus(job.progress || "работаем...");
  }
  throw new Error("таймаут генерации");
}

// ---- аккаунты ----
const SITE_STATES = {
  in: ["in", "сессия активна"],
  out: ["out", "вход не сохранён"],
  untouched: ["out", "зарегистрируется само при запросе"],
};

async function loadSites() {
  try {
    const res = await fetch("/api/sites");
    const { sites } = await res.json();
    const list = $("#accounts-list");
    list.innerHTML = "";
    for (const s of sites) {
      const [cls, text] = SITE_STATES[s.status] || SITE_STATES.untouched;
      const div = document.createElement("div");
      div.className = "acc";
      div.innerHTML = `<span class="dot ${cls}"></span><span class="name">${s.name}</span><span class="state">${text}</span>`;
      const b = document.createElement("button");
      b.textContent = "открыть окно";
      b.addEventListener("click", async () => {
        b.disabled = true;
        b.textContent = "открываем...";
        try {
          const r = await fetch(`/api/sites/${s.id}/login`, { method: "POST" });
          const data = await r.json();
          if (data.error) alert(data.error);
        } catch (e) {
          alert(e.message);
        }
        b.disabled = false;
        b.textContent = "закрыто";
        setTimeout(loadSites, 4000);
      });
      div.appendChild(b);
      list.appendChild(div);
    }
  } catch {}
}
loadSites();
setInterval(loadSites, 15000);
