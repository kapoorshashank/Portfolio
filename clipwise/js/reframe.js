// Speaker-aware 9:16 reframing. Samples frames from the clip, detects faces
// with MediaPipe (on-device, free), and builds a smooth "virtual camera" path.
// Falls back to a centered crop if face detection is unavailable.

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";

let detectorPromise = null;

async function getDetector() {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const { FaceDetector, FilesetResolver } = await import("../vendor/mediapipe/vision_bundle.mjs");
      const fileset = await FilesetResolver.forVisionTasks(new URL("../vendor/mediapipe/wasm", import.meta.url).href);
      try {
        return await FaceDetector.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
          runningMode: "IMAGE",
          minDetectionConfidence: 0.5,
        });
      } catch {
        return await FaceDetector.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
          runningMode: "IMAGE",
          minDetectionConfidence: 0.5,
        });
      }
    })().catch((e) => {
      console.warn("[reframe] face detector unavailable, using center crop", e);
      detectorPromise = Promise.resolve(null);
      return null;
    });
  }
  return detectorPromise;
}

function seek(video, t) {
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener("seeked", done);
      resolve();
    };
    video.addEventListener("seeked", done);
    video.currentTime = t;
    setTimeout(done, 3000); // never hang on a bad seek
  });
}

/**
 * @param {string} src object URL of the source video
 * @returns {Promise<{points:{t:number,x:number}[], faces:boolean}>}
 *   x = normalized horizontal center (0..1) of the virtual camera at time t (relative to clip start)
 */
export async function trackSpeaker(src, start, end, { step = 0.5, onProgress } = {}) {
  const detector = await getDetector();
  if (!detector) return { points: [], faces: false };

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = src;
  await new Promise((r, j) => {
    video.onloadedmetadata = r;
    video.onerror = () => j(new Error("video load failed"));
  });

  const scale = 320 / video.videoWidth;
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = Math.round(video.videoHeight * scale);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const raw = [];
  let found = 0;
  const total = Math.max(1, Math.ceil((end - start) / step));
  for (let i = 0; i <= total; i++) {
    const t = Math.min(end, start + i * step);
    await seek(video, t);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    let x = null;
    try {
      const res = detector.detect(canvas);
      // Largest face ≈ main/active speaker in most podcast & talking-head shots.
      let best = null;
      for (const d of res.detections || []) {
        const b = d.boundingBox;
        if (!b) continue;
        const area = b.width * b.height;
        if (!best || area > best.area) best = { area, cx: (b.originX + b.width / 2) / canvas.width };
      }
      if (best) {
        x = best.cx;
        found++;
      }
    } catch {}
    raw.push({ t: t - start, x });
    onProgress?.(i / total);
  }
  video.removeAttribute("src");
  video.load();

  if (found < raw.length * 0.15) return { points: [], faces: false };
  return { points: smoothPath(raw), faces: true };
}

/**
 * Virtual camera: hold position unless the subject leaves a dead zone,
 * then glide toward it. Gaps (no face) hold the last position.
 */
function smoothPath(raw) {
  // Fill gaps with nearest known value.
  let last = raw.find((p) => p.x != null)?.x ?? 0.5;
  const filled = raw.map((p) => {
    if (p.x != null) last = p.x;
    return { t: p.t, x: last };
  });
  // Median of 3 to kill single-frame detection jumps.
  const med = filled.map((p, i) => {
    const a = filled[Math.max(0, i - 1)].x, b = p.x, c = filled[Math.min(filled.length - 1, i + 1)].x;
    return { t: p.t, x: [a, b, c].sort((m, n) => m - n)[1] };
  });
  const DEAD = 0.07; // ignore small movements
  const EASE = 0.35; // fraction of the gap closed per sample
  let cam = med[0].x;
  return med.map((p) => {
    if (Math.abs(p.x - cam) > DEAD) cam += (p.x - cam) * EASE;
    return { t: p.t, x: cam };
  });
}

/** Interpolate the camera center at clip-relative time t. */
export function cameraAt(points, t) {
  if (!points || !points.length) return 0.5;
  if (t <= points[0].t) return points[0].x;
  for (let i = 1; i < points.length; i++) {
    if (t <= points[i].t) {
      const a = points[i - 1], b = points[i];
      const k = (t - a.t) / (b.t - a.t || 1);
      return a.x + (b.x - a.x) * k;
    }
  }
  return points[points.length - 1].x;
}
