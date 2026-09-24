// 本機圖片辨識系統 - 前端邏輯
// 三種輸入方式（上傳圖片 / 相機拍照 / 語音查詢）都會找出「工作目錄」中最相似或最相關的圖片。
// 視覺相似度：使用 TensorFlow.js + 本機端 MobileNet v1 模型（vendor/ 內），完全離線運算。
// 語音查詢：使用瀏覽器內建語音辨識取得文字，再與 tags.json 的中文關鍵字比對。

const MODEL_URL = "vendor/mobilenet_v1_1.0_224/model.json";
const EMBEDDING_LAYER = "global_average_pooling2d_1";
const CACHE_KEY = "img_recognition_index_v1";
const TOP_N = 5;

const state = {
  embeddingModel: null,
  images: [],          // [{name, size, mtime}]
  tagsMap: {},          // {filename: [tags...]}
  index: {},            // {filename: {size, mtime, embedding: number[]}}
  visualReady: false,
};

// ---------- 共用小工具 ----------

function $(id) { return document.getElementById(id); }

function setIndexStatus(text, kind) {
  const el = $("indexStatus");
  el.textContent = text;
  el.classList.remove("ready", "error");
  if (kind) el.classList.add(kind);
}

function l2Normalize(arr) {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i];
  const norm = Math.sqrt(sum) || 1;
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i] / norm;
  return out;
}

function cosineSim(a, b) {
  // 兩向量皆已 L2 正規化，內積即為 cosine similarity
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// 將來源畫面（img/video/canvas）置中裁切成正方形後縮放到 224x224
function toSquareCanvas(source, srcW, srcH) {
  const size = Math.min(srcW, srcH);
  const sx = (srcW - size) / 2;
  const sy = (srcH - size) / 2;
  const canvas = document.createElement("canvas");
  canvas.width = 224;
  canvas.height = 224;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(source, sx, sy, size, size, 0, 0, 224, 224);
  return canvas;
}

function computeEmbeddingFromCanvas(canvas) {
  return tf.tidy(() => {
    let t = tf.browser.fromPixels(canvas).toFloat();
    t = t.div(127.5).sub(1); // Keras MobileNet 前處理：縮放到 [-1, 1]
    t = t.expandDims(0);
    const out = state.embeddingModel.predict(t);
    return out.dataSync();
  });
}

async function computeEmbeddingFromElement(element, w, h) {
  const canvas = toSquareCanvas(element, w, h);
  const raw = computeEmbeddingFromCanvas(canvas);
  return l2Normalize(Array.from(raw));
}

// ---------- 模型 / 索引初始化 ----------

async function loadModel() {
  const fullModel = await tf.loadLayersModel(MODEL_URL);
  const layer = fullModel.getLayer(EMBEDDING_LAYER);
  state.embeddingModel = tf.model({ inputs: fullModel.inputs, outputs: layer.output });
  // 暖機一次，讓第一次查詢不會太慢
  tf.tidy(() => {
    const warm = tf.zeros([1, 224, 224, 3]);
    state.embeddingModel.predict(warm);
  });
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* 忽略壞掉的快取 */ }
  return {};
}

function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(state.index));
  } catch (e) {
    console.warn("無法寫入本機快取", e);
  }
}

async function fetchJSON(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function buildIndex() {
  const cache = loadCache();
  const newIndex = {};
  let done = 0;
  const total = state.images.length;

  for (const img of state.images) {
    const cached = cache[img.name];
    if (cached && cached.size === img.size && cached.mtime === img.mtime) {
      newIndex[img.name] = cached;
      done++;
      setIndexStatus(`建立索引中... (${done}/${total})`);
      continue;
    }
    try {
      const el = await loadImageElement(img.name + "?v=" + img.mtime);
      const embedding = await computeEmbeddingFromElement(el, el.naturalWidth, el.naturalHeight);
      newIndex[img.name] = { size: img.size, mtime: img.mtime, embedding };
    } catch (e) {
      console.error("無法處理圖片", img.name, e);
    }
    done++;
    setIndexStatus(`建立索引中... (${done}/${total})`);
  }

  state.index = newIndex;
  saveCache();
}

async function fetchImageList() {
  // 本機開發：server.ps1 提供 /api/images 動態掃描資料夾
  // 雲端部署（例如 Zeabur，靜態網站沒有後端）：改讀部署前產生的 images.json 靜態清單
  try {
    const list = await fetchJSON("/api/images");
    if (Array.isArray(list)) return list;
  } catch (e) {
    console.warn("找不到 /api/images 動態端點，改用 images.json 靜態清單", e);
  }
  return fetchJSON("images.json");
}

async function initVisualSearch() {
  try {
    setIndexStatus("載入辨識模型中...");
    await loadModel();
    setIndexStatus("讀取圖片清單中...");
    state.images = await fetchImageList();
    if (state.images.length === 0) {
      setIndexStatus("工作目錄中沒有找到圖片", "error");
      return;
    }
    await buildIndex();
    state.visualReady = true;
    setIndexStatus(`索引就緒（共 ${state.images.length} 張圖片）`, "ready");
  } catch (e) {
    console.error(e);
    setIndexStatus("視覺辨識模型載入失敗，語音/文字關鍵字查詢仍可使用", "error");
  }
}

async function rebuildIndex() {
  localStorage.removeItem(CACHE_KEY);
  await initVisualSearch();
}

async function initTags() {
  try {
    state.tagsMap = await fetchJSON("tags.json");
  } catch (e) {
    console.warn("無法讀取 tags.json，語音查詢將只能比對檔名", e);
    state.tagsMap = {};
  }
}

// ---------- 查詢與呈現結果 ----------

function searchByEmbedding(queryEmbedding) {
  const results = [];
  for (const [name, entry] of Object.entries(state.index)) {
    const score = cosineSim(queryEmbedding, entry.embedding);
    results.push({ name, score });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, TOP_N);
}

function tagsFor(name) {
  return state.tagsMap[name] || [name.replace(/\.[^.]+$/, "")];
}

function imageSrcFor(name) {
  // 加上跟建索引時相同的快取破壞參數，避免瀏覽器沿用先前（可能是 404）的快取結果
  const fromIndex = state.index[name];
  if (fromIndex && fromIndex.mtime) return name + "?v=" + fromIndex.mtime;
  const fromList = state.images.find((i) => i.name === name);
  if (fromList && fromList.mtime) return name + "?v=" + fromList.mtime;
  return name;
}

function searchByText(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const names = state.images.length ? state.images.map((i) => i.name) : Object.keys(state.tagsMap);
  const results = [];
  for (const name of names) {
    const tags = tagsFor(name);
    let score = 0;
    for (const tag of tags) {
      const t = tag.toLowerCase();
      if (!t) continue;
      if (q.includes(t) || (t.length >= 2 && t.includes(q))) {
        score = Math.max(score, t.length);
      }
    }
    if (score > 0) results.push({ name, score });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, TOP_N);
}

function renderResults(results, options) {
  const grid = $("resultsGrid");
  const noResults = $("noResults");
  grid.innerHTML = "";

  if (!results || results.length === 0) {
    noResults.hidden = false;
    return;
  }
  noResults.hidden = true;

  const isVisual = !!(options && options.visual);
  const maxScore = results[0].score || 1;

  results.forEach((r, i) => {
    const card = document.createElement("div");
    card.className = "result-card" + (i === 0 ? " rank-1" : "");

    const img = document.createElement("img");
    img.alt = r.name;
    img.onerror = () => {
      // 極端情況下（例如快取問題）仍載入失敗，就退回不加參數的原始路徑再試一次
      if (img.src.indexOf("?v=") !== -1) {
        img.onerror = null;
        img.src = r.name;
      }
    };
    img.src = imageSrcFor(r.name);

    const meta = document.createElement("div");
    meta.className = "meta";

    const filename = document.createElement("div");
    filename.className = "filename";
    filename.textContent = r.name;

    const score = document.createElement("div");
    score.className = "score";
    score.textContent = isVisual
      ? `相似度 ${(r.score * 100).toFixed(1)}%`
      : `相關度 ${((r.score / maxScore) * 100).toFixed(0)}%`;

    const tags = document.createElement("div");
    tags.className = "tags";
    tags.textContent = tagsFor(r.name).slice(0, 3).join("、");

    meta.appendChild(filename);
    meta.appendChild(score);
    meta.appendChild(tags);
    card.appendChild(img);
    card.appendChild(meta);
    grid.appendChild(card);
  });
}

// ---------- 分頁切換 ----------

function setupTabs() {
  const buttons = document.querySelectorAll(".tab-btn");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      buttons.forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      $("tab-" + btn.dataset.tab).classList.add("active");
    });
  });
}

// ---------- 上傳圖片 ----------

function setupUpload() {
  $("uploadInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const url = URL.createObjectURL(file);
    const preview = $("uploadPreview");
    preview.src = url;
    preview.hidden = false;

    if (!state.visualReady) {
      setIndexStatus("模型尚未就緒，請稍候再試", "error");
      return;
    }

    try {
      const el = await loadImageElement(url);
      const embedding = await computeEmbeddingFromElement(el, el.naturalWidth, el.naturalHeight);
      const results = searchByEmbedding(embedding);
      renderResults(results, { visual: true });
    } catch (err) {
      console.error(err);
      alert("圖片讀取失敗，請換一張圖片再試一次");
    }
  });
}

// ---------- 相機拍照 ----------

let cameraStream = null;

function setupCamera() {
  const startBtn = $("cameraStartBtn");
  const shotBtn = $("cameraShotBtn");
  const video = $("cameraVideo");

  startBtn.addEventListener("click", async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert("此瀏覽器不支援相機功能，請改用「上傳圖片」");
      return;
    }
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      video.srcObject = cameraStream;
      shotBtn.disabled = false;
      startBtn.textContent = "相機已啟動";
      startBtn.disabled = true;
    } catch (err) {
      console.error(err);
      alert("無法開啟相機，請確認已允許瀏覽器使用相機權限。");
    }
  });

  shotBtn.addEventListener("click", async () => {
    if (!state.visualReady) {
      setIndexStatus("模型尚未就緒，請稍候再試", "error");
      return;
    }
    const canvas = $("cameraCanvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const preview = $("cameraPreview");
    preview.src = canvas.toDataURL("image/jpeg", 0.9);
    preview.hidden = false;

    try {
      const embedding = await computeEmbeddingFromElement(canvas, canvas.width, canvas.height);
      const results = searchByEmbedding(embedding);
      renderResults(results, { visual: true });
    } catch (err) {
      console.error(err);
      alert("拍照查詢失敗，請再試一次");
    }
  });
}

// ---------- 語音查詢 ----------

function setupVoice() {
  const voiceBtn = $("voiceBtn");
  const voiceStatus = $("voiceStatus");
  const transcriptEl = $("voiceTranscript");
  const textInput = $("voiceTextInput");
  const textBtn = $("voiceTextBtn");

  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

  function runTextSearch(query) {
    transcriptEl.hidden = false;
    transcriptEl.textContent = `查詢關鍵字：「${query}」`;
    const results = searchByText(query);
    renderResults(results, { visual: false });
  }

  if (!SpeechRecognitionCtor) {
    voiceBtn.disabled = true;
    voiceStatus.textContent = "此瀏覽器不支援語音辨識，請改用下方文字輸入（建議使用 Chrome 或 Edge）";
  } else {
    const recognition = new SpeechRecognitionCtor();
    recognition.lang = "zh-TW";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      voiceStatus.textContent = "聆聽中，請說出關鍵字...";
      voiceBtn.disabled = true;
    };
    recognition.onerror = (e) => {
      voiceStatus.textContent = "語音辨識發生錯誤：" + e.error;
      voiceBtn.disabled = false;
    };
    recognition.onend = () => {
      voiceBtn.disabled = false;
    };
    recognition.onresult = (event) => {
      const text = event.results[0][0].transcript;
      voiceStatus.textContent = "辨識完成";
      textInput.value = text;
      runTextSearch(text);
    };

    voiceBtn.addEventListener("click", () => {
      try {
        recognition.start();
      } catch (e) {
        console.warn(e);
      }
    });
  }

  textBtn.addEventListener("click", () => {
    const q = textInput.value;
    if (q.trim()) runTextSearch(q);
  });
  textInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && textInput.value.trim()) runTextSearch(textInput.value);
  });
}

// ---------- 進入點 ----------

window.addEventListener("DOMContentLoaded", async () => {
  setupTabs();
  setupUpload();
  setupCamera();
  setupVoice();
  $("rebuildBtn").addEventListener("click", () => {
    if (confirm("確定要重新掃描並重建圖片索引嗎？")) rebuildIndex();
  });
  await initTags();
  await initVisualSearch();
});
