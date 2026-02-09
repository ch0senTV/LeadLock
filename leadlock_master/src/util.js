// utility functions used throughout the lead locking system. These
// helpers encapsulate common operations such as date handling,
// phone normalisation, array chunking and retry/backoff logic.

import { DEFAULT_COUNTRY_CODE } from "./config.js";

export function nowIso() {
  return new Date().toISOString();
}

export function minutesFromNowIso(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

export function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function normalizePhone(raw) {
  if (!raw) return null;
  let p = String(raw).trim().replace(/[^\d+]/g, "");

  if (p.startsWith("+") && p.length >= 8) return p;

  if (/^\d{10}$/.test(p)) return `+${DEFAULT_COUNTRY_CODE}${p}`;
  if (/^\d{11}$/.test(p) && p.startsWith(DEFAULT_COUNTRY_CODE)) return `+${p}`;

  return p.startsWith("+") ? p : null;
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// simple exponential backoff retry for 429/5xx
export async function withRetry(fn, { tries = 5, baseMs = 250 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      const retryable =
        msg.includes("429") || msg.includes("503") || msg.includes("502") || msg.includes("500");
      if (!retryable || i === tries - 1) throw e;
      await sleep(baseMs * Math.pow(2, i));
    }
  }
  throw lastErr;
}