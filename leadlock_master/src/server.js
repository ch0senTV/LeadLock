// src/server.js
//
// Entry point for the lead locking server. Sets up the Express
// application, handles RingCentral webhooks, exposes admin APIs and
// manages timers for batching writes and unlocking expired leads.

import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

import { SheetsStore } from "./sheets.js";
import { state, queueIncrement, dedupeEvent } from "./memory.js";
import { normalizePhone } from "./util.js";
import { COUNT_INBOUND, COUNT_OUTBOUND } from "./config.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

const store = new SheetsStore();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "..", "public")));

function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"] || req.query.adminKey;
  if (!process.env.ADMIN_KEY) return res.status(500).send("Missing ADMIN_KEY");
  if (key !== process.env.ADMIN_KEY) return res.status(401).send("Unauthorized");
  next();
}

function requireWebhookSecret(req, res, next) {
  const secret = process.env.WEBHOOK_SHARED_SECRET;
  if (!secret) return next();
  const got = req.headers["x-webhook-secret"] || req.query.secret;
  if (got !== secret) return res.status(401).send("Unauthorized");
  next();
}

function isEnded(payload) {
  const code =
    payload?.body?.party?.status?.code ||
    payload?.body?.status?.code ||
    payload?.body?.party?.status ||
    payload?.body?.status ||
    "";
  const s = String(code).toLowerCase();
  return s.includes("disconnected") || s.includes("ended") || s.includes("completed");
}

function getDirection(payload) {
  const d =
    payload?.body?.party?.direction ||
    payload?.body?.direction ||
    "";
  return String(d).toLowerCase();
}

function extractPhone(payload) {
  // Best-effort across shapes
  const candidates = [
    payload?.body?.party?.to?.phoneNumber,
    payload?.body?.party?.from?.phoneNumber,
    payload?.body?.to?.phoneNumber,
    payload?.body?.from?.phoneNumber
  ];
  for (const c of candidates) {
    const p = normalizePhone(c);
    if (p) return p;
  }
  const parties = payload?.body?.parties;
  if (Array.isArray(parties)) {
    for (const party of parties) {
      const p1 = normalizePhone(party?.to?.phoneNumber);
      if (p1) return p1;
      const p2 = normalizePhone(party?.from?.phoneNumber);
      if (p2) return p2;
    }
  }
  return null;
}

function extractEventId(payload) {
  // Build a stable-ish dedupe key (best effort)
  const sessionId = payload?.body?.telephonySessionId || payload?.telephonySessionId || payload?.uuid || payload?.id || "";
  const partyId = payload?.body?.party?.id || payload?.body?.partyId || "";
  const status = payload?.body?.party?.status?.code || payload?.body?.status?.code || "";
  const ts = payload?.timestamp || payload?.eventTime || payload?.body?.eventTime || "";
  return `${sessionId}|${partyId}|${status}|${ts}`;
}

// Webhook endpoint
app.post("/ringcentral/webhook", requireWebhookSecret, async (req, res) => {
  // RingCentral validation handshake
  const validationToken = req.get("Validation-Token");
  if (validationToken) {
    res.set("Validation-Token", validationToken);
    return res.status(200).send("OK");
  }

  res.status(200).send("OK");

  try {
    state.metrics.webhookEvents += 1;

    const payload = req.body;

    // Only ended calls count
    if (!isEnded(payload)) return;

    const dir = getDirection(payload);
    const isOut = dir.includes("out");
    const isIn = dir.includes("in");
    if ((isOut && !COUNT_OUTBOUND) || (isIn && !COUNT_INBOUND)) return;

    const phone = extractPhone(payload);
    if (!phone) return;

    const eventId = extractEventId(payload);
    if (dedupeEvent(eventId)) return;

    // Buffer increment; eventId is stored at flush time
    queueIncrement(phone, 1);
    state.metrics.endedCounted += 1;

    // Store last seen eventId per phone in memory (so we can write it to Locks)
    // lightweight: attach to pending map by expanding value to object
    // We'll keep it simple by tracking a separate map:
    state._lastEventIdByPhone ??= new Map();
    state._lastEventIdByPhone.set(phone, eventId);

  } catch (e) {
    state.metrics.lastError = String(e?.message || e);
  }
});

// Admin API
app.get("/api/status", requireAdmin, (req, res) => {
  const sheet = String(req.query.sheet || "").trim();
  const effective = sheet ? store.getHoldMinutesForSheet(sheet) : state.holdMinutes;
  res.json({
    holdMinutes: effective,
    defaultHoldMinutes: state.holdMinutes,
    holdMinutesBySheet: Object.fromEntries(state.holdMinutesBySheet.entries()),
    leadsSheets: store.leadsNames,
    pendingPhones: state.pendingIncrements.size,
    metrics: state.metrics
  });
});

// List configured lead sheet tabs (for UI dropdown)
app.get("/api/leads-sheets", requireAdmin, (req, res) => {
  res.json({
    leadsSheets: store.leadsNames,
    defaultHoldMinutes: state.holdMinutes,
    holdMinutesBySheet: Object.fromEntries(state.holdMinutesBySheet.entries())
  });
});

app.post("/api/settings", requireAdmin, async (req, res) => {
  const { holdMinutes, leadSheet } = req.body || {};
  const m = Number(holdMinutes);
  if (!Number.isFinite(m) || m <= 0 || m > 1440) {
    return res.status(400).json({ error: "holdMinutes must be between 1 and 1440" });
  }

  const sheet = String(leadSheet || "").trim();
  if (sheet) {
    state.holdMinutesBySheet.set(sheet, m);
    try { await store.saveHoldMinutesToSettings(m, sheet); } catch {}
    return res.json({ ok: true, leadSheet: sheet, holdMinutes: m });
  }

  state.holdMinutes = m;
  try { await store.saveHoldMinutesToSettings(m); } catch {}
  res.json({ ok: true, holdMinutes: state.holdMinutes });
});

app.post("/api/refresh-index", requireAdmin, async (req, res) => {
  try {
    const sheet = String(req.query.sheet || req.body?.sheet || "").trim();
    await store.refreshLeadsIndex(sheet || undefined);
    res.json({ ok: true, sheet: sheet || null });
  } catch (e) {
    state.metrics.lastError = String(e?.message || e);
    res.status(500).json({ error: state.metrics.lastError });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

// Timers
const FLUSH_INTERVAL_MS = Number(process.env.FLUSH_INTERVAL_MS || 3000);
const UNLOCK_SWEEP_INTERVAL_MS = Number(process.env.UNLOCK_SWEEP_INTERVAL_MS || 15000);
const CACHE_REFRESH_INTERVAL_MS = Number(process.env.CACHE_REFRESH_INTERVAL_MS || 30000);

setInterval(async () => {
  try {
    if (state.pendingIncrements.size === 0) return;

    // Build entries list
    const entries = [];
    for (const [phone, inc] of state.pendingIncrements.entries()) {
      const eventId = state._lastEventIdByPhone?.get(phone) || "";
      entries.push({ phone, inc, eventId });
    }
    state.pendingIncrements.clear();

    await store.upsertLocksAndHideIfNeeded(entries);

    state.metrics.flushes += 1;
    state.metrics.lastFlushAt = new Date().toISOString();
  } catch (e) {
    state.metrics.lastError = `flush: ${String(e?.message || e)}`;
  }
}, FLUSH_INTERVAL_MS);

setInterval(async () => {
  try {
    await store.unlockExpiredAndUnhide();
    state.metrics.unlockSweeps += 1;
    state.metrics.lastUnlockSweepAt = new Date().toISOString();
  } catch (e) {
    state.metrics.lastError = `unlock: ${String(e?.message || e)}`;
  }
}, UNLOCK_SWEEP_INTERVAL_MS);

setInterval(async () => {
  try { await store.refreshLeadsIndex(); }
  catch (e) { state.metrics.lastError = `index: ${String(e?.message || e)}`; }
}, CACHE_REFRESH_INTERVAL_MS);

const port = Number(process.env.PORT || 3000);
app.listen(port, async () => {
  console.log(`✅ Server running on :${port}`);
  try {
    await store.loadHoldMinutesFromSettings();
  } catch {}
  try {
    await store.refreshLeadsIndex();
    console.log("✅ Leads index loaded");
  } catch (e) {
    console.error("⚠️ Leads index load failed:", e.message);
  }
});