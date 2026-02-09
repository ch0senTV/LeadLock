// memory state for call counting, dedupe, and everything

import { LOCK_AFTER_CALLS } from "./config.js";

export const state = {
  // default hold time (minutes) if not persisted in Settings
  holdMinutes: Number(process.env.DEFAULT_HOLD_MINUTES || 60),

  // per-lead-sheet hold minutes (optional). When present, overrides holdMinutes.
  // key: sheetName, value: minutes
  holdMinutesBySheet: new Map(),

  // phone -> increments pending (in-memory)
  pendingIncrements: new Map(),

  // event dedupe (best-effort, in-memory)
  recentEventKeys: new Map(), // key => timestamp
  recentTtlMs: 10 * 60 * 1000,

  // cache
  leadsCache: {
    loadedAt: 0,
    headerMap: new Map(),
    // phone => { sheetName, rowIndex1Based }
    phoneToLoc: new Map()
  },

  metrics: {
    startedAt: Date.now(),
    webhookEvents: 0,
    endedCounted: 0,
    queued: 0,
    flushes: 0,
    lastFlushAt: null,
    unlockSweeps: 0,
    lastUnlockSweepAt: null,
    lastError: null
  },

  lockAfterCalls: LOCK_AFTER_CALLS
};

export function queueIncrement(phone, by = 1) {
  state.pendingIncrements.set(phone, (state.pendingIncrements.get(phone) || 0) + by);
  state.metrics.queued += by;
}

export function dedupeEvent(key) {
  if (!key) return false;
  const now = Date.now();

  // cleanup occasionally
  if (state.recentEventKeys.size > 200000) {
    for (const [k, ts] of state.recentEventKeys) {
      if (now - ts > state.recentTtlMs) state.recentEventKeys.delete(k);
    }
  }

  const prev = state.recentEventKeys.get(key);
  if (prev && now - prev < state.recentTtlMs) return true;
  state.recentEventKeys.set(key, now);
  return false;
}
