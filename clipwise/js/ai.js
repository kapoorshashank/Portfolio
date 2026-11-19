// Orchestrates the AI passes: transcribe chunks, then score the transcript
// window by window (paced for the free-tier token budget), merge and rank.

import { transcribeChunk, findHighlights } from "./api.js";
import { mergeChunks, buildWindows, snapClip, dedupe } from "./transcript.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TPM_BUDGET = 7500; // keep under Groq free-tier 8K tokens/min

export async function transcribeAll(chunks, { onProgress, onWait } = {}) {
  const results = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.(i / chunks.length, `Transcribing part ${i + 1} of ${chunks.length}`);
    const data = await transcribeChunk(chunks[i].bytes, { onWait });
    results.push({ offset: chunks[i].start, data });
  }
  onProgress?.(1, "Transcript ready");
  return mergeChunks(results);
}

/**
 * @returns ranked clips: {id,start,end,title,hook,reason,scores,score}
 */
export async function findBestMoments(transcript, opts, { onProgress, onWait } = {}) {
  const { minLen, maxLen, count, direction, context } = opts;
  const windows = buildWindows(transcript.segments);
  if (!windows.length) throw new Error("No speech found in this video.");
  // Ask each window for a few candidates; aim for ~2x the requested total overall.
  const perWindow = Math.max(2, Math.min(4, Math.ceil((count * 2) / windows.length)));

  const all = [];
  let lastCall = 0;
  let lastTokens = 0;
  for (let i = 0; i < windows.length; i++) {
    onProgress?.(i / windows.length, `AI is watching part ${i + 1} of ${windows.length}`);
    // Pace calls so tokens/minute stays under budget.
    const minGap = (lastTokens / TPM_BUDGET) * 60000;
    const waitMs = lastCall + minGap - Date.now();
    if (waitMs > 1500) onWait?.(Math.ceil(waitMs / 1000));
    if (waitMs > 0) await sleep(waitMs);

    lastCall = Date.now();
    const res = await findHighlights(
      { transcript: windows[i].text, minLen, maxLen, maxClips: perWindow, direction, context },
      { onWait },
    );
    lastTokens = res.usage?.total_tokens || 3500;
    for (const c of res.clips || []) {
      if (c.score < 55) continue;
      const snapped = snapClip(c, transcript.words, minLen, maxLen);
      const len = snapped.end - snapped.start;
      if (len < minLen * 0.75 || len > maxLen * 1.25) continue;
      all.push(snapped);
    }
  }
  onProgress?.(1, "Ranking moments");
  return dedupe(all)
    .sort((a, b) => b.score - a.score)
    .map((c, i) => ({ ...c, id: "c" + i + "_" + Math.round(c.start) }));
}
