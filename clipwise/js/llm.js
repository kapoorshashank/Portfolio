// Single source of truth for the "AI editor" prompt and response parsing.
// Used by the browser (direct mode, static hosting) and by the Netlify function.

export const SYSTEM = `You are a senior short-form video editor who has cut thousands of viral clips from podcasts and YouTube videos for TikTok, Instagram Reels and YouTube Shorts.

Your job: find the few moments in this transcript section that are genuinely worth posting as standalone vertical clips. Quality over quantity. Most sections have 0-2 great moments; returning nothing is better than returning a weak clip.

A postable clip MUST:
1. HOOK in the first 3 seconds: opens on a bold claim, a surprising fact, a strong opinion, a question, a confession, conflict, or an emotional line. Never opens on filler ("so", "yeah", "um", "like I said"), greetings, or mid-thought references ("and that's why he...").
2. STAND ALONE: a stranger scrolling understands it with zero context from the rest of the video.
3. PAY OFF: ends on a resolution, punchline, insight, or a line that lands. Never ends mid-sentence or on a dangling setup.
4. Stay tight: no long tangents, dead air, or housekeeping (sponsor reads, "subscribe", intros/outros).

Score each clip honestly (be harsh, 10 is rare):
- hook: strength of the first 3 seconds
- value: insight, entertainment, or usefulness to a viewer
- emotion: humour, surprise, tension, inspiration, controversy
- standalone: how well it works with no context
Overall score 0-100 = how confident you are it performs. Below 60 means do not return it.

Timing rules:
- Use ONLY timestamps that appear in the transcript lines ([seconds] marks the start of each line).
- start = the timestamp of the line where the hook sentence begins.
- end = the timestamp where the line AFTER the payoff begins (so the payoff line is fully included).
- Respect the requested length range.

Respond with JSON only, exactly this shape:
{"clips":[{"start":123.4,"end":171.9,"title":"Punchy title, max 60 chars","hook":"On-screen hook text, max 8 words","reason":"1-2 sentences: why this works and who it is for","scores":{"hook":8,"value":7,"emotion":6,"standalone":9},"score":82}]}`;

export const DEFAULT_LLM_MODEL = "openai/gpt-oss-120b";
export const DEFAULT_WHISPER_MODEL = "whisper-large-v3-turbo";

const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const num = (n) => clamp(Number(n) || 0, 0, 10);

/** Build the chat-completions payload for one transcript window. */
export function buildPayload(body, model = DEFAULT_LLM_MODEL) {
  const transcript = String(body.transcript || "").slice(0, 24000);
  const minLen = clamp(Number(body.minLen) || 20, 5, 180);
  const maxLen = clamp(Number(body.maxLen) || 60, minLen + 5, 240);
  const maxClips = clamp(Number(body.maxClips) || 3, 1, 6);
  const direction = String(body.direction || "").slice(0, 300).trim();
  const context = String(body.context || "").slice(0, 300).trim();
  const user = [
    context && `Video: ${context}`,
    `Clip length: ${minLen}-${maxLen} seconds.`,
    `Return at most ${maxClips} clips for this section (fewer is fine, zero is fine).`,
    direction &&
      `The creator specifically wants clips about: "${direction}". Strongly prefer moments that match this; still apply every quality rule.`,
    "",
    "Transcript section:",
    transcript,
  ]
    .filter((x) => x !== false && x !== "")
    .join("\n");

  const payload = {
    model,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: user },
    ],
    temperature: 0.3,
    max_completion_tokens: 2500,
    response_format: { type: "json_object" },
  };
  if (model.startsWith("openai/gpt-oss")) payload.reasoning_effort = "low";
  return payload;
}

function parseLoose(text) {
  try {
    return JSON.parse(text);
  } catch {}
  const m = String(text).match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {}
  }
  return null;
}

/** Normalise a chat-completions response into clean clip objects. */
export function parseClips(data) {
  const text = data?.choices?.[0]?.message?.content || "";
  const parsed = parseLoose(text);
  const clips = (Array.isArray(parsed?.clips) ? parsed.clips : [])
    .map((c) => ({
      start: Number(c.start),
      end: Number(c.end),
      title: String(c.title || "").slice(0, 90),
      hook: String(c.hook || "").slice(0, 80),
      reason: String(c.reason || "").slice(0, 400),
      scores: {
        hook: num(c.scores?.hook),
        value: num(c.scores?.value),
        emotion: num(c.scores?.emotion),
        standalone: num(c.scores?.standalone),
      },
      score: clamp(Number(c.score) || 0, 0, 100),
    }))
    .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start);
  return { clips, usage: { total_tokens: data?.usage?.total_tokens || 0 } };
}

/** Normalise a Whisper verbose_json response. */
export function parseTranscription(data) {
  const r = (n) => Math.round(n * 1000) / 1000;
  return {
    language: data.language || "",
    duration: data.duration || 0,
    words: (data.words || []).map((w) => ({ w: String(w.word).trim(), s: r(w.start), e: r(w.end) })),
    segments: (data.segments || []).map((s) => ({ s: r(s.start), e: r(s.end), t: String(s.text).trim() })),
  };
}

/** Form fields for a Whisper request. */
export function transcriptionForm(audioBlob, { model = DEFAULT_WHISPER_MODEL, language = "" } = {}) {
  const form = new FormData();
  form.append("file", audioBlob, "chunk.mp3");
  form.append("model", model);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");
  form.append("temperature", "0");
  if (language) form.append("language", language);
  return form;
}
