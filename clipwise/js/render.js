// One renderer powers both the live preview and the final export, so what
// you see in the editor is exactly what you download.

import { cameraAt } from "./reframe.js";
import { buildCaptionPages } from "./transcript.js";

export const CAPTION_STYLES = {
  pop: { label: "Bold pop" },
  clean: { label: "Clean box" },
  karaoke: { label: "Karaoke" },
  none: { label: "No captions" },
};

export const LAYOUTS = {
  auto: { label: "Track speaker" },
  center: { label: "Center crop" },
  fit: { label: "Fit + blur" },
};

const FONT = '"Montserrat", "Arial Black", "Helvetica Neue", Arial, sans-serif';
const supportsFilter = (() => {
  try {
    const c = document.createElement("canvas").getContext("2d");
    c.filter = "blur(2px)";
    return c.filter === "blur(2px)";
  } catch {
    return false;
  }
})();

export async function ensureFonts() {
  try {
    await Promise.all([document.fonts.load(`900 40px ${FONT}`), document.fonts.load(`700 40px ${FONT}`)]);
  } catch {}
}

/** Cache caption pages on the clip; invalidated when words change. */
function pagesFor(clip) {
  if (!clip._pages || clip._pagesKey !== clip.wordsVersion) {
    clip._pages = buildCaptionPages(clip.words || []);
    clip._pagesKey = clip.wordsVersion;
  }
  return clip._pages;
}

export function drawFrame(ctx, video, clip, tAbs) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
  const tRel = tAbs - clip.start;
  ctx.save();
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);

  const vertical = vw / vh <= 9 / 16 + 0.02;
  let captionY = H * 0.7;

  if (vertical) {
    drawCover(ctx, video, vw, vh, W, H, 0.5);
  } else if (clip.layout === "fit") {
    // Blurred fill background + full frame in the middle.
    if (supportsFilter) ctx.filter = "blur(28px) brightness(0.55) saturate(1.2)";
    drawCover(ctx, video, vw, vh, W, H, 0.5);
    ctx.filter = "none";
    if (!supportsFilter) {
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(0, 0, W, H);
    }
    const fh = (vh * W) / vw;
    const y = H * 0.46 - fh / 2;
    ctx.drawImage(video, 0, 0, vw, vh, 0, y, W, fh);
    captionY = Math.min(H * 0.82, y + fh + H * 0.08);
  } else {
    const cx = clip.layout === "auto" && clip.track ? cameraAt(clip.track.points, tAbs - clip.track.base) : 0.5;
    drawCover(ctx, video, vw, vh, W, H, cx);
  }

  if (clip.captionStyle !== "none") drawCaptions(ctx, clip, tAbs, W, H, captionY);
  if (clip.showHook && clip.hook) drawHook(ctx, clip.hook, tRel, W, H);
  ctx.restore();
}

function drawCover(ctx, video, vw, vh, W, H, cxNorm) {
  const targetAR = W / H;
  let sw, sh, sx, sy;
  if (vw / vh > targetAR) {
    sh = vh;
    sw = vh * targetAR;
    sx = Math.min(vw - sw, Math.max(0, cxNorm * vw - sw / 2));
    sy = 0;
  } else {
    sw = vw;
    sh = vw / targetAR;
    sx = 0;
    sy = (vh - sh) / 2;
  }
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, W, H);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawCaptions(ctx, clip, t, W, H, centerY) {
  const pages = pagesFor(clip);
  const page = pages.find((p) => t >= p.s - 0.05 && t < p.hold);
  if (!page) return;
  const style = clip.captionStyle || "pop";
  const upper = style === "pop";
  const size = Math.round(W * (style === "pop" ? 0.088 : 0.07));
  ctx.font = `${style === "pop" ? 900 : 700} ${size}px ${FONT}`;
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";

  const items = page.words.map((w) => {
    const text = upper ? w.w.toUpperCase() : w.w;
    return { w, text, width: ctx.measureText(text).width };
  });
  const space = ctx.measureText(" ").width * (style === "pop" ? 1.35 : 1.1);
  const maxW = W * 0.86;
  const lines = [[]];
  let lw = 0;
  for (const it of items) {
    if (lines[lines.length - 1].length && lw + space + it.width > maxW) {
      lines.push([]);
      lw = 0;
    }
    lines[lines.length - 1].push(it);
    lw += (lw ? space : 0) + it.width;
  }
  const lineH = size * 1.22;
  const startY = centerY - ((lines.length - 1) * lineH) / 2;

  // Page entrance: quick scale-in.
  const age = t - page.s;
  const enter = Math.min(1, Math.max(0, age / 0.12));

  lines.forEach((line, li) => {
    const total = line.reduce((n, it, i) => n + it.width + (i ? space : 0), 0);
    let x = W / 2 - total / 2;
    const y = startY + li * lineH;

    if (style === "clean") {
      ctx.fillStyle = "rgba(0,0,0,0.62)";
      roundRect(ctx, x - size * 0.35, y - lineH / 2, total + size * 0.7, lineH, size * 0.25);
      ctx.fill();
    }

    for (const it of line) {
      const active = t >= it.w.s && t < it.w.e + 0.05;
      const spoken = t >= it.w.s;
      const cx = x + it.width / 2;
      ctx.save();
      let scale = 0.92 + 0.08 * enter;
      if (style === "pop" && active) {
        const k = Math.min(1, (t - it.w.s) / 0.1);
        scale *= 1 + 0.08 * k;
      }
      ctx.translate(cx, y);
      ctx.scale(scale, scale);
      ctx.textAlign = "center";

      if (style === "clean" && active) {
        ctx.fillStyle = "#22C55E";
        roundRect(ctx, -it.width / 2 - size * 0.12, -lineH * 0.42, it.width + size * 0.24, lineH * 0.84, size * 0.18);
        ctx.fill();
      }
      if (style === "pop") {
        ctx.lineWidth = size * 0.2;
        ctx.strokeStyle = "#000";
        ctx.shadowColor = "rgba(0,0,0,0.5)";
        ctx.shadowBlur = size * 0.25;
        ctx.strokeText(it.text, 0, 0);
        ctx.shadowBlur = 0;
        ctx.fillStyle = active ? "#FFE14D" : "#FFFFFF";
      } else if (style === "karaoke") {
        ctx.lineWidth = size * 0.14;
        ctx.strokeStyle = "rgba(0,0,0,0.85)";
        ctx.strokeText(it.text, 0, 0);
        ctx.fillStyle = active ? "#5EEAD4" : spoken ? "#FFFFFF" : "rgba(255,255,255,0.45)";
      } else {
        ctx.fillStyle = "#FFFFFF";
      }
      ctx.fillText(it.text, 0, 0);
      ctx.restore();
      x += it.width + space;
    }
  });
}

function drawHook(ctx, hook, tRel, W, H) {
  const SHOW = 3.2;
  if (tRel > SHOW + 0.3) return;
  const alpha = tRel > SHOW ? 1 - (tRel - SHOW) / 0.3 : Math.min(1, tRel / 0.15 + 0.4);
  const size = Math.round(W * 0.058);
  ctx.save();
  ctx.globalAlpha = Math.max(0, alpha);
  ctx.font = `800 ${size}px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const words = hook.split(/\s+/);
  const maxW = W * 0.78;
  const lines = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? cur + " " + w : w;
    if (ctx.measureText(test).width > maxW && cur) {
      lines.push(cur);
      cur = w;
    } else cur = test;
  }
  if (cur) lines.push(cur);
  const lineH = size * 1.25;
  const boxW = Math.min(W * 0.9, Math.max(...lines.map((l) => ctx.measureText(l).width)) + size * 1.2);
  const boxH = lines.length * lineH + size * 0.7;
  const y = H * 0.13;
  ctx.fillStyle = "#FFFFFF";
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = size * 0.6;
  roundRect(ctx, W / 2 - boxW / 2, y - boxH / 2, boxW, boxH, size * 0.4);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = "#0B0B0F";
  lines.forEach((l, i) => ctx.fillText(l, W / 2, y - ((lines.length - 1) * lineH) / 2 + i * lineH));
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* Live preview player                                                 */
/* ------------------------------------------------------------------ */

export class Player {
  constructor(canvas, src) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.video = document.createElement("video");
    this.video.playsInline = true;
    this.video.preload = "auto";
    this.video.src = src;
    this.clip = null;
    this.playing = false;
    this.onTime = null;
    this._loop = this._loop.bind(this);
    this.ready = new Promise((r) => {
      if (this.video.readyState >= 1) r();
      else this.video.addEventListener("loadedmetadata", r, { once: true });
    });
  }

  async setClip(clip, { autoplay = false } = {}) {
    this.clip = clip;
    await this.ready;
    await this.seek(clip.start);
    if (autoplay) this.play();
  }

  async seek(t) {
    const v = this.video;
    await new Promise((resolve) => {
      const done = () => {
        v.removeEventListener("seeked", done);
        resolve();
      };
      v.addEventListener("seeked", done);
      v.currentTime = t;
      setTimeout(done, 2500);
    });
    this.draw();
  }

  draw() {
    if (!this.clip) return;
    drawFrame(this.ctx, this.video, this.clip, this.video.currentTime);
    this.onTime?.(this.video.currentTime);
  }

  async play() {
    if (!this.clip) return;
    if (this.video.currentTime >= this.clip.end - 0.05 || this.video.currentTime < this.clip.start - 0.5) {
      await this.seek(this.clip.start);
    }
    this.playing = true;
    try {
      await this.video.play();
    } catch {
      this.playing = false;
      return;
    }
    requestAnimationFrame(this._loop);
  }

  pause() {
    this.playing = false;
    this.video.pause();
    this.draw();
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  _loop() {
    if (!this.playing) return;
    if (this.video.currentTime >= this.clip.end) {
      this.video.pause();
      this.playing = false;
      this.seek(this.clip.start);
      this.onEnded?.();
      return;
    }
    this.draw();
    requestAnimationFrame(this._loop);
  }

  destroy() {
    this.playing = false;
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
  }
}

/* ------------------------------------------------------------------ */
/* Export (real-time canvas recording)                                 */
/* ------------------------------------------------------------------ */

export function pickRecorderType() {
  const types = [
    'video/mp4;codecs="avc1.640028,mp4a.40.2"',
    'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
    "video/mp4",
    'video/webm;codecs="vp9,opus"',
    'video/webm;codecs="vp8,opus"',
    "video/webm",
  ];
  if (typeof MediaRecorder === "undefined") return null;
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

/**
 * Call directly from a click handler (AudioContext needs a user gesture).
 * Renders at real-time speed; keep the screen on while it runs.
 */
export function exportClip(src, clip, { width = 1080, height = 1920, fps = 30, onProgress } = {}) {
  const mimeType = pickRecorderType();
  if (mimeType === null) return Promise.reject(new Error("This browser can't record video. Try Chrome or Safari."));
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  ac.resume?.();

  return (async () => {
    await ensureFonts();
    const video = document.createElement("video");
    video.playsInline = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    video.src = src;
    await new Promise((r, j) => {
      video.onloadedmetadata = r;
      video.onerror = () => j(new Error("Could not load the video for export."));
    });

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");

    const node = ac.createMediaElementSource(video);
    const dest = ac.createMediaStreamDestination();
    node.connect(dest);

    await new Promise((resolve) => {
      video.addEventListener("seeked", resolve, { once: true });
      video.currentTime = clip.start;
    });
    drawFrame(ctx, video, clip, clip.start);

    const stream = new MediaStream([
      ...canvas.captureStream(fps).getVideoTracks(),
      ...dest.stream.getAudioTracks(),
    ]);
    const rec = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: width >= 1080 ? 9_000_000 : 5_000_000,
      audioBitsPerSecond: 160_000,
    });
    const parts = [];
    rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
    const stopped = new Promise((r) => (rec.onstop = r));

    rec.start(1000);
    await video.play();
    const dur = clip.end - clip.start;
    await new Promise((resolve) => {
      video.addEventListener("ended", resolve, { once: true });
      const tick = () => {
        const t = video.currentTime;
        if (t >= clip.end || video.ended) return resolve();
        drawFrame(ctx, video, clip, t);
        onProgress?.(Math.min(1, (t - clip.start) / dur));
        if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick);
        else requestAnimationFrame(tick);
      };
      tick();
    });
    video.pause();
    drawFrame(ctx, video, clip, clip.end);
    await new Promise((r) => setTimeout(r, 120));
    rec.stop();
    await stopped;
    stream.getTracks().forEach((tr) => tr.stop());
    ac.close?.();
    video.removeAttribute("src");
    video.load();
    onProgress?.(1);
    const type = rec.mimeType || mimeType || "video/webm";
    return { blob: new Blob(parts, { type }), ext: type.includes("mp4") ? "mp4" : "webm" };
  })().catch((e) => {
    ac.close?.();
    throw e;
  });
}
