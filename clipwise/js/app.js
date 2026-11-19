import { getSettings, saveSettings, getStatus, ApiError } from "./api.js";
import { loadEngine, extractAudioChunks } from "./audio.js";
import { transcribeAll, findBestMoments } from "./ai.js";
import { trackSpeaker } from "./reframe.js";
import { wordsIn, buildCaptionPages, fmtTime } from "./transcript.js";
import { Player, drawFrame, exportClip, ensureFonts, CAPTION_STYLES, LAYOUTS } from "./render.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const state = {
  file: null,
  src: null,
  duration: 0,
  transcript: null,
  clips: [],
  shown: 0,
  opts: { length: "30-60", count: 5, direction: "" },
  status: { serverKey: false, accessCodeRequired: false },
  cancelled: false,
};

/* ---------------- Screens ---------------- */
function show(name) {
  $$(".screen").forEach((s) => s.classList.toggle("active", s.id === "screen-" + name));
  window.scrollTo({ top: 0 });
}

/* ---------------- Settings ---------------- */
function openSettings() {
  const s = getSettings();
  $("#groqKey").value = s.groqKey || "";
  $("#accessCode").value = s.accessCode || "";
  $("#language").value = s.language || "";
  $("#quality").value = s.quality || "1080";
  $("#keyField").classList.toggle("hidden", state.status.serverKey);
  $("#codeField").classList.toggle("hidden", !state.status.accessCodeRequired);
  $("#settings").classList.remove("hidden");
}
function closeSettings(save) {
  if (save) {
    saveSettings({
      ...getSettings(),
      groqKey: $("#groqKey").value.trim(),
      accessCode: $("#accessCode").value.trim(),
      language: $("#language").value,
      quality: $("#quality").value,
    });
  }
  $("#settings").classList.add("hidden");
  refreshBanner();
}
function refreshBanner() {
  const s = getSettings();
  const needKey = !state.status.serverKey && !s.groqKey;
  const needCode = state.status.accessCodeRequired && !s.accessCode;
  $("#keyBanner").classList.toggle("hidden", !(needKey || needCode));
  if (needCode && !needKey) $("#keyBanner").innerHTML = 'This beta needs an access code. Add it in <button class="link" data-open-settings>Settings</button>.';
}
$("#settingsBtn").onclick = openSettings;
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-open-settings]")) openSettings();
  if (e.target.closest("[data-close-settings]")) closeSettings(e.target.id === "saveSettings");
});

/* ---------------- Upload ---------------- */
const fileInput = $("#fileInput");
fileInput.onchange = () => fileInput.files[0] && setFile(fileInput.files[0]);
const drop = $("#drop");
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => (e.preventDefault(), drop.classList.add("drag"))));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => (e.preventDefault(), drop.classList.remove("drag"))));
drop.addEventListener("drop", (e) => e.dataTransfer.files[0] && setFile(e.dataTransfer.files[0]));

async function setFile(file) {
  if (!file.type.startsWith("video/") && !/\.(mp4|mov|m4v|webm|mkv)$/i.test(file.name)) {
    alert("Please choose a video file.");
    return;
  }
  if (state.src) URL.revokeObjectURL(state.src);
  state.file = file;
  state.src = URL.createObjectURL(file);
  const v = $("#sourcePreview");
  v.src = state.src;
  v.classList.remove("hidden");
  $("#dropInner").classList.add("hidden");
  await new Promise((r) => (v.readyState >= 1 ? r() : v.addEventListener("loadedmetadata", r, { once: true })));
  v.currentTime = Math.min(5, v.duration / 3 || 0);
  state.duration = v.duration;
  const mb = (file.size / 1048576).toFixed(0);
  $("#fileMeta").textContent = `${file.name} · ${fmtTime(v.duration)} · ${mb} MB · tap to change`;
  $("#fileMeta").classList.remove("hidden");
  $("#startBtn").disabled = false;
  if (v.duration < 60) $("#fileMeta").textContent += " · tip: longer videos give the AI more to choose from";
}

$$(".chips").forEach((group) =>
  group.addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    e.preventDefault();
    $$(".chip", group).forEach((c) => c.classList.toggle("active", c === b));
    state.opts[group.dataset.name] = group.dataset.name === "count" ? +b.dataset.value : b.dataset.value;
  }),
);

$("#startBtn").onclick = () => run();
$("#cancelBtn").onclick = () => location.reload();
$("#newBtn").onclick = () => location.reload();

/* ---------------- Pipeline ---------------- */
function step(name, status, progress, note) {
  const li = $(`.steps li[data-step="${name}"]`);
  if (!li) return;
  if (status) {
    li.classList.toggle("active", status === "active");
    li.classList.toggle("done", status === "done");
  }
  if (progress != null) $(".bar i", li).style.width = Math.round(progress * 100) + "%";
  if (note != null) $("small", li).textContent = note;
}
function waitNote(sec) {
  const el = $("#waitNote");
  if (!sec) return el.classList.add("hidden");
  el.classList.remove("hidden");
  let left = sec;
  el.textContent = `Free AI quota is busy, continuing in ${left}s…`;
  clearInterval(waitNote.t);
  waitNote.t = setInterval(() => {
    left--;
    if (left <= 0) {
      clearInterval(waitNote.t);
      el.classList.add("hidden");
    } else el.textContent = `Free AI quota is busy, continuing in ${left}s…`;
  }, 1000);
}

async function run() {
  const s = getSettings();
  if (!state.status.serverKey && !s.groqKey) return openSettings();
  if (state.status.accessCodeRequired && !s.accessCode) return openSettings();

  state.opts.direction = $("#direction").value.trim();
  const [minLen, maxLen] = state.opts.length.split("-").map(Number);
  show("process");
  $("#errorBox").classList.add("hidden");

  try {
    step("engine", "active", 0.1);
    await loadEngine();
    step("engine", "done", 1, "Ready");

    step("audio", "active", 0, "Reading the soundtrack on your device");
    const chunks = await extractAudioChunks(state.file, state.duration, (p) => step("audio", null, p));
    const kb = chunks.reduce((n, c) => n + c.bytes.byteLength, 0) / 1024;
    step("audio", "done", 1, `${chunks.length} part(s), ${(kb / 1024).toFixed(1)} MB of audio`);

    step("transcribe", "active", 0);
    state.transcript = await transcribeAll(chunks, {
      onProgress: (p, msg) => step("transcribe", null, p, msg),
      onWait: waitNote,
    });
    const wc = state.transcript.words.length;
    if (wc < 20) throw new Error("Couldn't find enough speech in this video. Clipwise works best on podcasts, interviews and talking videos.");
    step("transcribe", "done", 1, `${wc.toLocaleString()} words${state.transcript.language ? " · " + state.transcript.language : ""}`);

    step("ai", "active", 0);
    const ranked = await findBestMoments(
      state.transcript,
      { minLen, maxLen, count: state.opts.count, direction: state.opts.direction, context: state.file.name.replace(/\.[^.]+$/, "") },
      { onProgress: (p, msg) => step("ai", null, p, msg), onWait: waitNote },
    );
    if (!ranked.length) throw new Error("The AI didn't find any moment strong enough to post. Try a longer video, a different clip length, or clear the 'Look for' filter.");
    state.clips = ranked.map(prepareClip);
    step("ai", "done", 1, `${ranked.length} strong moment(s) found`);

    step("track", "active", 0);
    const top = state.clips.slice(0, state.opts.count);
    for (let i = 0; i < top.length; i++) {
      step("track", null, i / top.length, `Clip ${i + 1} of ${top.length}`);
      await ensureTrack(top[i]);
    }
    step("track", "done", 1, "Done");

    await ensureFonts();
    showResults();
  } catch (e) {
    console.error(e);
    const box = $("#errorBox");
    box.classList.remove("hidden");
    box.innerHTML = "";
    box.append(e.message || "Something went wrong.");
    if (e instanceof ApiError && ["no_key", "bad_key", "access_code"].includes(e.code)) {
      const b = document.createElement("button");
      b.className = "btn small";
      b.style.marginLeft = "10px";
      b.textContent = "Open settings";
      b.onclick = openSettings;
      box.append(b);
    }
    $$(".steps li.active").forEach((li) => li.classList.remove("active"));
  }
}

function prepareClip(c) {
  const clip = {
    ...c,
    layout: "auto",
    captionStyle: "pop",
    showHook: true,
    track: null,
    wordsVersion: 0,
  };
  refreshWords(clip);
  return clip;
}

function refreshWords(clip) {
  clip.words = wordsIn(state.transcript.words, clip.start, clip.end);
  clip.wordsVersion = (clip.wordsVersion || 0) + 1;
}

async function ensureTrack(clip, onProgress) {
  if (clip.track) return clip.track;
  try {
    const res = await trackSpeaker(state.src, clip.start, clip.end, { onProgress });
    clip.track = { ...res, base: clip.start };
  } catch {
    clip.track = { points: [], faces: false, base: clip.start };
  }
  if (!clip.track.faces && clip.layout === "auto") clip.layout = "center";
  return clip.track;
}

/* ---------------- Results ---------------- */
function showResults() {
  state.shown = Math.min(state.opts.count, state.clips.length);
  $("#clipGrid").innerHTML = "";
  renderCards(0, state.shown);
  const extra = state.clips.length - state.shown;
  $("#resultsTitle").textContent = `Your ${state.shown} best moment${state.shown === 1 ? "" : "s"}`;
  $("#resultsSub").textContent = `Picked from ${fmtTime(state.duration)} of video, ranked by how likely each is to perform.`;
  $("#moreBtn").hidden = extra <= 0;
  $("#moreBtn").textContent = `Show ${extra} more candidate${extra === 1 ? "" : "s"}`;
  show("results");
}

$("#moreBtn").onclick = () => {
  const from = state.shown;
  state.shown = state.clips.length;
  renderCards(from, state.shown);
  $("#moreBtn").hidden = true;
};

const thumbQueue = [];
let thumbVideo = null;
async function drawThumbs() {
  if (drawThumbs.busy) return;
  drawThumbs.busy = true;
  if (!thumbVideo) {
    thumbVideo = document.createElement("video");
    thumbVideo.muted = true;
    thumbVideo.playsInline = true;
    thumbVideo.preload = "auto";
    thumbVideo.src = state.src;
    await new Promise((r) => (thumbVideo.readyState >= 1 ? r() : thumbVideo.addEventListener("loadedmetadata", r, { once: true })));
  }
  while (thumbQueue.length) {
    const { clip, canvas } = thumbQueue.shift();
    const t = Math.min(clip.end - 0.1, clip.start + 0.6);
    await new Promise((r) => {
      thumbVideo.addEventListener("seeked", r, { once: true });
      thumbVideo.currentTime = t;
      setTimeout(r, 2500);
    });
    drawFrame(canvas.getContext("2d"), thumbVideo, clip, t);
  }
  drawThumbs.busy = false;
}

function renderCards(from, to) {
  const grid = $("#clipGrid");
  for (let i = from; i < to; i++) {
    const c = state.clips[i];
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <div class="thumb"><canvas width="360" height="640"></canvas>
        <span class="rank">#${i + 1}</span><span class="score">${Math.round(c.score)}</span></div>
      <div class="body">
        <h3></h3>
        <p class="reason"></p>
        <div class="mini">${["hook", "value", "emotion", "standalone"]
          .map((k) => `<div>${k}<span><i style="width:${(c.scores?.[k] || 0) * 10}%"></i></span></div>`)
          .join("")}</div>
        <div class="meta">${fmtTime(c.start)}–${fmtTime(c.end)} · ${Math.round(c.end - c.start)}s</div>
      </div>
      <div class="actions"><button class="btn primary">Edit &amp; export</button></div>`;
    $("h3", card).textContent = c.title || "Untitled moment";
    $(".reason", card).textContent = c.reason;
    $(".actions .btn", card).onclick = () => openEditor(c, i);
    $(".thumb", card).onclick = () => openEditor(c, i);
    c._thumb = $("canvas", card);
    grid.append(card);
    thumbQueue.push({ clip: c, canvas: c._thumb });
  }
  drawThumbs();
}

/* ---------------- Editor ---------------- */
let player = null;
let edClip = null;

function segButtons(container, options, current, onPick) {
  container.innerHTML = "";
  for (const [key, { label }] of Object.entries(options)) {
    const b = document.createElement("button");
    b.textContent = label;
    b.classList.toggle("active", key === current);
    b.onclick = () => {
      $$("button", container).forEach((x) => x.classList.toggle("active", x === b));
      onPick(key);
    };
    container.append(b);
  }
}

async function openEditor(clip, index) {
  edClip = clip;
  $("#editor").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  $("#edTitle").textContent = `#${index + 1} · ${clip.title || "Clip"}`;
  $("#edWhy").innerHTML = "";
  const b = document.createElement("b");
  b.textContent = `Score ${Math.round(clip.score)}/100. `;
  $("#edWhy").append(b, clip.reason || "");
  $("#edHook").value = clip.hook || "";
  $("#edHookOn").checked = clip.showHook;
  $("#edDone").classList.add("hidden");
  $("#edExportBar").classList.add("hidden");
  $("#edExport").disabled = false;
  $("#edExport").textContent = "Export video";

  const pickLayout = async (k) => {
    clip.layout = k;
    if (k === "auto" && !clip.track?.faces) {
      await ensureTrack(clip);
      if (!clip.track.faces) {
        clip.layout = "center";
        alert("No faces detected in this clip, so it uses a center crop.");
        segButtons($("#edLayout"), LAYOUTS, clip.layout, pickLayout);
      }
    }
    redraw();
  };
  segButtons($("#edLayout"), LAYOUTS, clip.layout, pickLayout);
  segButtons($("#edStyle"), CAPTION_STYLES, clip.captionStyle, (k) => {
    clip.captionStyle = k;
    redraw();
  });

  if (player) player.destroy();
  player = new Player($("#edCanvas"), state.src);
  player.onTime = (t) => {
    const p = (t - edClip.start) / (edClip.end - edClip.start);
    $("#edScrub").value = Math.round(Math.max(0, Math.min(1, p)) * 1000);
    $("#edTime").textContent = fmtTime(Math.max(0, t - edClip.start));
  };
  player.onEnded = () => $("#edPlay").classList.remove("playing");
  updateTrimUI();
  renderCaptionEditor();
  await player.setClip(clip);
  if (!clip.track) ensureTrack(clip).then(redraw);
}

function redraw() {
  if (player && !player.playing) player.draw();
  if (edClip?._thumb) thumbQueue.push({ clip: edClip, canvas: edClip._thumb }), drawThumbs();
}

function closeEditor() {
  if (player) player.destroy();
  player = null;
  $("#editor").classList.add("hidden");
  document.body.style.overflow = "";
  redraw();
}
$("#closeEditor").onclick = closeEditor;

$("#edPlay").onclick = () => {
  player.toggle();
  setTimeout(() => $("#edPlay").classList.toggle("playing", player.playing), 50);
};
$("#edCanvas").onclick = () => $("#edPlay").click();
$("#edScrub").oninput = (e) => {
  player.pause();
  $("#edPlay").classList.remove("playing");
  player.seek(edClip.start + (e.target.value / 1000) * (edClip.end - edClip.start));
};
$("#edHook").oninput = (e) => {
  edClip.hook = e.target.value;
  redraw();
};
$("#edHookOn").onchange = (e) => {
  edClip.showHook = e.target.checked;
  redraw();
};

function updateTrimUI() {
  $("#edStart").textContent = fmtTime(edClip.start);
  $("#edEnd").textContent = fmtTime(edClip.end);
  $("#edLen").textContent = Math.round(edClip.end - edClip.start) + "s";
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-trim]");
  if (!b || !edClip) return;
  const [edge, dir] = b.dataset.trim.split(":");
  const words = state.transcript.words;
  if (edge === "start") {
    let i = words.findIndex((w) => w.s >= edClip.start);
    if (i < 0) i = words.length - 1;
    i = Math.max(0, Math.min(words.length - 1, i + Number(dir)));
    const ns = Math.max(0, words[i].s - 0.08);
    if (edClip.end - ns >= 3) edClip.start = ns;
  } else {
    let i = -1;
    for (let k = 0; k < words.length; k++) if (words[k].e <= edClip.end - 0.2) i = k;
    i = Math.max(0, Math.min(words.length - 1, i + Number(dir)));
    const ne = Math.min(state.duration, words[i].e + 0.25);
    if (ne - edClip.start >= 3) edClip.end = ne;
  }
  refreshWords(edClip);
  updateTrimUI();
  renderCaptionEditor();
  player.pause();
  $("#edPlay").classList.remove("playing");
  player.seek(edge === "start" ? edClip.start : Math.max(edClip.start, edClip.end - 2));
});

function renderCaptionEditor() {
  const box = $("#edCaptions");
  box.innerHTML = "";
  const pages = buildCaptionPages(edClip.words);
  for (const page of pages) {
    const input = document.createElement("input");
    input.type = "text";
    input.value = page.words.map((w) => w.w).join(" ");
    input.onchange = () => editCaptionPage(page, input.value);
    input.onfocus = () => player.seek(page.s + 0.01);
    box.append(input);
  }
}

/** Replace a caption page's words, keeping timing (spread evenly if word count changed). */
function editCaptionPage(page, text) {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const words = state.transcript.words;
  if (tokens.length === page.words.length) {
    page.words.forEach((w, i) => (w.w = tokens[i]));
  } else {
    const first = words.indexOf(page.words[0]);
    if (first < 0) return;
    const totalChars = tokens.reduce((n, t) => n + t.length, 0) || 1;
    let t = page.s;
    const span = page.e - page.s;
    const fresh = tokens.map((tok) => {
      const d = (tok.length / totalChars) * span;
      const w = { w: tok, s: t, e: t + d };
      t += d;
      return w;
    });
    words.splice(first, page.words.length, ...fresh);
  }
  refreshWords(edClip);
  renderCaptionEditor();
  redraw();
}

/* ---------------- Export ---------------- */
$("#edExport").onclick = async () => {
  const btn = $("#edExport");
  const q = getSettings().quality || "1080";
  const [w, h] = q === "720" ? [720, 1280] : [1080, 1920];
  player?.pause();
  $("#edPlay").classList.remove("playing");
  btn.disabled = true;
  btn.textContent = "Rendering… 0%";
  $("#edExportBar").classList.remove("hidden");
  $("#edDone").classList.add("hidden");
  let wakeLock = null;
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch {}
  const job = exportClip(state.src, edClip, {
    width: w,
    height: h,
    onProgress: (p) => {
      $("#edExportBar i").style.width = Math.round(p * 100) + "%";
      btn.textContent = `Rendering… ${Math.round(p * 100)}%`;
    },
  });
  try {
    const { blob, ext } = await job;
    const url = URL.createObjectURL(blob);
    const name = `${slug(edClip.title || "clip")}.${ext}`;
    const a = $("#edDownload");
    a.href = url;
    a.download = name;
    $("#edDone").classList.remove("hidden");
    const file = new File([blob], name, { type: blob.type });
    const share = $("#edShare");
    share.hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
    share.onclick = () => navigator.share({ files: [file], title: edClip.title }).catch(() => {});
    btn.textContent = "Export again";
    $("#edExportNote").textContent = `Done · ${(blob.size / 1048576).toFixed(1)} MB ${ext.toUpperCase()}`;
  } catch (e) {
    console.error(e);
    btn.textContent = "Export video";
    $("#edExportNote").textContent = "Export failed: " + (e.message || e);
  } finally {
    btn.disabled = false;
    wakeLock?.release?.().catch(() => {});
  }
};

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "clip";
}

/* ---------------- Boot ---------------- */
(async () => {
  state.status = await getStatus();
  refreshBanner();
  // Warm up the engine in the background once a file is chosen.
  fileInput.addEventListener("change", () => loadEngine().catch(() => {}), { once: true });
})();

// Expose for automated tests.
window.__clipwise = { state, prepareClip, showResults, ensureTrack };
