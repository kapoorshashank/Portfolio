// Transcript utilities: merge chunks, build LLM windows, snap clips to
// sentence boundaries, and split words into caption "pages".

/** Merge per-chunk transcription results, shifting timestamps by chunk start. */
export function mergeChunks(results) {
  const words = [];
  const segments = [];
  let language = "";
  for (const { offset, data } of results) {
    language ||= data.language;
    for (const w of data.words) if (w.w) words.push({ w: w.w, s: w.s + offset, e: w.e + offset });
    for (const s of data.segments) if (s.t) segments.push({ s: s.s + offset, e: s.e + offset, t: s.t });
  }
  words.sort((a, b) => a.s - b.s);
  segments.sort((a, b) => a.s - b.s);
  return { words, segments, language };
}

/**
 * Lines for the LLM: one per Whisper segment, prefixed by its start time.
 * Windows of ~windowSec with overlapSec overlap so moments on a boundary
 * are not cut in half.
 */
export function buildWindows(segments, windowSec = 480, overlapSec = 60) {
  if (!segments.length) return [];
  const end = segments[segments.length - 1].e;
  const windows = [];
  for (let start = 0; start < end; start += windowSec - overlapSec) {
    const segs = segments.filter((s) => s.s >= start && s.s < start + windowSec);
    if (segs.length) {
      windows.push({
        start,
        end: Math.min(end, start + windowSec),
        text: segs.map((s) => `[${s.s.toFixed(1)}] ${s.t}`).join("\n"),
      });
    }
    if (start + windowSec >= end) break;
  }
  return windows;
}

const SENTENCE_END = /[.!?…]["')\]]?$/;

/**
 * Snap AI-proposed times to real word boundaries:
 * start → first word at/after (start - 0.4s); end → end of the word that
 * finishes nearest `end`, preferring a sentence ending close by.
 */
export function snapClip(clip, words, minLen, maxLen) {
  if (!words.length) return clip;
  let si = words.findIndex((w) => w.s >= clip.start - 0.4);
  if (si < 0) si = 0;
  // If the AI landed mid-sentence, back up (max 3 words) to the sentence start.
  for (let k = 0; k < 3 && si > 0; k++) {
    if (SENTENCE_END.test(words[si - 1].w) || words[si].s - words[si - 1].e > 0.7) break;
    si--;
  }
  const start = Math.max(0, words[si].s - 0.08);

  // Candidate end words between min and max length; pick a sentence end closest to AI end.
  let best = -1;
  let bestCost = Infinity;
  for (let i = si; i < words.length; i++) {
    const len = words[i].e - start;
    if (len > maxLen + 2) break;
    if (len < minLen * 0.8) continue;
    const isEnd = SENTENCE_END.test(words[i].w) || (words[i + 1] && words[i + 1].s - words[i].e > 0.8);
    const cost = Math.abs(words[i].e - clip.end) + (isEnd ? 0 : 6);
    if (cost < bestCost) {
      bestCost = cost;
      best = i;
    }
  }
  if (best < 0) {
    // Fall back to the word nearest the AI end within maxLen.
    best = si;
    while (best + 1 < words.length && words[best + 1].e - start <= Math.min(maxLen, clip.end - start + 1)) best++;
  }
  const end = words[best].e + 0.25;
  return { ...clip, start, end };
}

/** Remove near-duplicates (overlap > 40% of the shorter clip), keeping the higher score. */
export function dedupe(clips) {
  const sorted = [...clips].sort((a, b) => b.score - a.score);
  const kept = [];
  for (const c of sorted) {
    const clash = kept.some((k) => {
      const ov = Math.min(k.end, c.end) - Math.max(k.start, c.start);
      return ov > 0.4 * Math.min(k.end - k.start, c.end - c.start);
    });
    if (!clash) kept.push(c);
  }
  return kept;
}

export function wordsIn(words, start, end) {
  return words.filter((w) => w.s >= start - 0.05 && w.e <= end + 0.3);
}

/**
 * Group words into short caption pages (max ~3 words / 16 chars),
 * breaking on pauses and punctuation. Pages carry their own timing.
 */
export function buildCaptionPages(words, { maxWords = 3, maxChars = 16 } = {}) {
  const pages = [];
  let cur = [];
  const flush = () => {
    if (cur.length) pages.push({ words: cur, s: cur[0].s, e: cur[cur.length - 1].e });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = cur[cur.length - 1];
    const chars = cur.reduce((n, x) => n + x.w.length + 1, 0) + w.w.length;
    if (cur.length && (cur.length >= maxWords || chars > maxChars || w.s - prev.e > 0.6)) flush();
    cur.push(w);
    if (/[.!?,;:…]$/.test(w.w)) flush();
  }
  flush();
  // Hold each page on screen until the next one starts (no flicker), max +0.6s.
  for (let i = 0; i < pages.length; i++) {
    const next = pages[i + 1];
    pages[i].hold = next ? Math.min(next.s, pages[i].e + 0.6) : pages[i].e + 0.6;
  }
  return pages;
}

export function fmtTime(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
}
