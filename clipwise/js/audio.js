// Extracts a small speech-quality audio track from the video, in the browser,
// split into ~10 minute mp3 chunks that fit under the serverless payload limit.
// Uses ffmpeg.wasm (single-threaded, no special headers needed). The video file
// is mounted read-only (WORKERFS) so a 1 GB file is never copied into memory.

import { FFmpeg } from "../vendor/ffmpeg/index.js";

let ffmpeg = null;
let loading = null;

export async function loadEngine(onLog) {
  if (ffmpeg) return ffmpeg;
  if (loading) return loading;
  loading = (async () => {
    const ff = new FFmpeg();
    if (onLog) ff.on("log", ({ message }) => onLog(message));
    const base = new URL("../vendor/ffmpeg-core/", import.meta.url).href;
    await ff.load({ coreURL: base + "ffmpeg-core.js", wasmURL: base + "ffmpeg-core.wasm" });
    ffmpeg = ff;
    return ff;
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

/**
 * @param {File} file
 * @param {number} duration seconds (for progress)
 * @param {(p:number)=>void} onProgress 0..1
 * @returns {Promise<{start:number,end:number,bytes:Uint8Array}[]>}
 */
export async function extractAudioChunks(file, duration, onProgress, chunkSeconds = 600) {
  const ff = await loadEngine();
  const progressFromLog = ({ message }) => {
    const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message);
    if (m && duration) onProgress?.(Math.min(0.999, (+m[1] * 3600 + +m[2] * 60 + +m[3]) / duration));
  };
  ff.on("log", progressFromLog);

  const safeName = "input" + (file.name.match(/\.[a-z0-9]{2,5}$/i)?.[0] || ".mp4").toLowerCase();
  let inputPath;
  let mounted = false;
  try {
    try {
      await ff.createDir("/in").catch(() => {});
      await ff.mount("WORKERFS", { files: [new File([file], safeName, { type: file.type })] }, "/in");
      inputPath = "/in/" + safeName;
      mounted = true;
    } catch {
      // Fallback: copy into memory (fine for smaller files).
      await ff.writeFile(safeName, new Uint8Array(await file.arrayBuffer()));
      inputPath = safeName;
    }

    await ff.createDir("/out").catch(() => {});
    const code = await ff.exec([
      "-hide_banner", "-nostdin", "-y",
      "-i", inputPath,
      "-vn", "-sn", "-dn",
      "-ac", "1", "-ar", "16000",
      "-c:a", "libmp3lame", "-b:a", "32k",
      "-f", "segment", "-segment_time", String(chunkSeconds),
      "-segment_list", "/out/list.csv", "-segment_list_type", "csv",
      "-reset_timestamps", "1",
      "/out/chunk%03d.mp3",
    ]);
    if (code !== 0) throw new Error("Could not read audio from this video. Try an MP4 (H.264/AAC) file.");

    const csv = new TextDecoder().decode(await ff.readFile("/out/list.csv"));
    const chunks = [];
    for (const line of csv.trim().split(/\r?\n/)) {
      const [name, start, end] = line.split(",");
      if (!name) continue;
      const bytes = await ff.readFile("/out/" + name);
      if (bytes.byteLength > 1000) chunks.push({ start: parseFloat(start), end: parseFloat(end), bytes });
      await ff.deleteFile("/out/" + name).catch(() => {});
    }
    await ff.deleteFile("/out/list.csv").catch(() => {});
    if (!chunks.length) throw new Error("This video has no audio track.");
    onProgress?.(1);
    return chunks;
  } finally {
    ff.off("log", progressFromLog);
    if (mounted) await ff.unmount("/in").catch(() => {});
    else if (inputPath) await ff.deleteFile(inputPath).catch(() => {});
  }
}
