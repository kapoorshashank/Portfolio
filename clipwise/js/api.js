// Client for the AI calls. Two modes:
//  - "server": same-origin Netlify Functions (/api/*) hold the key (production)
//  - "direct": static hosting (e.g. GitHub Pages); the browser calls Groq
//    itself with the user's own key (BYOK). Groq allows browser (CORS) calls.

import { buildPayload, parseClips, parseTranscription, transcriptionForm } from "./llm.js";

const GROQ = "https://api.groq.com/openai/v1";
let mode = "server";

const LS_KEY = "clipwise.settings";

export function getSettings() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "{}");
  } catch {
    return {};
  }
}

export function saveSettings(s) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch {}
}

function authHeaders() {
  const s = getSettings();
  const h = {};
  if (s.groqKey) h["x-groq-key"] = s.groqKey;
  if (s.accessCode) h["x-access-code"] = s.accessCode;
  return h;
}

export class ApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * POST with automatic waiting on 429 (free-tier rate limits).
 * onWait(seconds) lets the UI show "waiting for AI quota…".
 */
async function post(path, body, { headers = {}, onWait, retries = 6 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(path, { method: "POST", headers: { ...authHeaders(), ...headers }, body });
    } catch (e) {
      if (attempt >= 2) throw new ApiError("Network error, check your connection.", "network", 0);
      await sleep(2000);
      continue;
    }
    if (res.ok) return res.json();
    let data = {};
    try {
      data = await res.json();
    } catch {}
    if (res.status === 429 && attempt < retries) {
      const wait = Math.min(65, (data.retryAfter || Number(res.headers.get("retry-after")) || 20) + 1);
      onWait?.(wait);
      await sleep(wait * 1000);
      continue;
    }
    if (res.status >= 500 && attempt < 2) {
      await sleep(3000);
      continue;
    }
    throw new ApiError(data.message || `Request failed (${res.status})`, data.error || "http", res.status);
  }
}

export async function getStatus() {
  try {
    const r = await fetch("/api/status", { cache: "no-store" });
    if (r.ok && (r.headers.get("content-type") || "").includes("json")) {
      mode = "server";
      return { ...(await r.json()), mode };
    }
  } catch {}
  mode = "direct";
  return { serverKey: false, accessCodeRequired: false, mode };
}

/** Direct-to-Groq request with the same retry semantics as the server path. */
async function groq(path, init, opts = {}) {
  const key = getSettings().groqKey;
  if (!key) throw new ApiError("Add your free Groq API key in Settings (console.groq.com/keys).", "no_key", 401);
  const headers = { Authorization: `Bearer ${key}`, ...(init.headers || {}) };
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(GROQ + path, { ...init, headers, body: init.body() });
    } catch {
      if (attempt >= 2) throw new ApiError("Couldn't reach the AI service. Check your connection.", "network", 0);
      await sleep(2000);
      continue;
    }
    if (res.ok) return res.json();
    if (res.status === 429 && attempt < (opts.retries ?? 6)) {
      const wait = Math.min(65, (Number(res.headers.get("retry-after")) || 20) + 1);
      opts.onWait?.(wait);
      await sleep(wait * 1000);
      continue;
    }
    if (res.status === 400 && init.onBadRequest && attempt === 0) {
      init.onBadRequest();
      continue;
    }
    if (res.status >= 500 && attempt < 2) {
      await sleep(3000);
      continue;
    }
    if (res.status === 401) throw new ApiError("Your Groq API key was rejected. Check it in Settings.", "bad_key", 401);
    let msg = "";
    try {
      msg = (await res.json()).error?.message || "";
    } catch {}
    throw new ApiError(msg || `AI request failed (${res.status})`, "http", res.status);
  }
}

export async function transcribeChunk(bytes, opts = {}) {
  const lang = getSettings().language || "";
  if (mode === "direct") {
    const data = await groq(
      "/audio/transcriptions",
      { method: "POST", body: () => transcriptionForm(new Blob([bytes], { type: "audio/mpeg" }), { language: lang }) },
      opts,
    );
    return parseTranscription(data);
  }
  return post(`/api/transcribe${lang ? `?lang=${encodeURIComponent(lang)}` : ""}`, bytes, {
    headers: { "content-type": "audio/mpeg" },
    ...opts,
  });
}

export async function findHighlights(payload, opts = {}) {
  if (mode === "direct") {
    const req = buildPayload(payload);
    const data = await groq(
      "/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: () => JSON.stringify(req),
        onBadRequest: () => delete req.response_format,
      },
      opts,
    );
    return parseClips(data);
  }
  return post("/api/highlights", JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    ...opts,
  });
}
