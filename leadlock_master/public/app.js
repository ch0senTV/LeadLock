// minimal UI for changing cooldown (holdMinutes).
//
// the backend requires ADMIN_KEY. This UI stores it in localStorage
// and sends it as the `x-admin-key` header.

const $ = (id) => document.getElementById(id);

const adminKeyInput = $("adminKey");
const leadSheetSelect = $("leadSheet");
const holdMinutesInput = $("holdMinutes");
const saveBtn = $("saveBtn");
const reloadBtn = $("reloadBtn");
const refreshIndexBtn = $("refreshIndexBtn");
const pill = $("pill");
const current = $("current");
const lastFlush = $("lastFlush");
const msg = $("msg");

// metrics panel
const metricsUpdated = $("metricsUpdated");
const mUptime = $("mUptime");
const mWebhook = $("mWebhook");
const mEnded = $("mEnded");
const mPending = $("mPending");
const mQueued = $("mQueued");
const mFlushes = $("mFlushes");
const mUnlocks = $("mUnlocks");
const mLastUnlock = $("mLastUnlock");
const mLastError = $("mLastError");

function setMetrics(data) {
  if (!data) {
    metricsUpdated.textContent = "—";
    mUptime.textContent = "—";
    mWebhook.textContent = "—";
    mEnded.textContent = "—";
    mPending.textContent = "—";
    mQueued.textContent = "—";
    mFlushes.textContent = "—";
    mUnlocks.textContent = "—";
    mLastUnlock.textContent = "—";
    mLastError.textContent = "—";
    return;
  }

  const met = data?.metrics || {};
  metricsUpdated.textContent = fmtIso(new Date().toISOString());
  mUptime.textContent = fmtDuration(Date.now() - Number(met.startedAt || 0));
  mWebhook.textContent = String(met.webhookEvents ?? "—");
  mEnded.textContent = String(met.endedCounted ?? "—");
  mPending.textContent = String(data?.pendingPhones ?? "—");
  mQueued.textContent = String(met.queued ?? "—");
  mFlushes.textContent = String(met.flushes ?? "—");
  mUnlocks.textContent = String(met.unlockSweeps ?? "—");
  mLastUnlock.textContent = fmtIso(met.lastUnlockSweepAt);
  mLastError.textContent = met.lastError ? String(met.lastError) : "—";
}

function setMsg(text, kind = "") {
  msg.textContent = text || "";
  msg.className = `msg ${kind}`.trim();
}

function setPill(text, kind = "") {
  pill.textContent = text;
  pill.className = `pill ${kind}`.trim();
}

function fmtIso(v) {
  if (!v) return "—";
  try {
    const d = new Date(v);
    if (!Number.isFinite(d.getTime())) return String(v);
    return d.toLocaleString();
  } catch {
    return String(v);
  }
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h || d) parts.push(`${h}h`);
  if (m || h || d) parts.push(`${m}m`);
  parts.push(`${r}s`);
  return parts.join(" ");
}

function getAdminKey() {
  return (adminKeyInput.value || "").trim();
}

async function api(path, { method = "GET", body } = {}) {
  const key = getAdminKey();
  if (!key) throw new Error("Admin key required");

  const res = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-admin-key": key
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(t || `HTTP ${res.status}`);
  }
  return res.json();
}

async function loadStatus() {
  setMsg("");
  try {
    const sheet = (leadSheetSelect.value || "").trim();
    const data = await api(`/api/status${sheet ? `?sheet=${encodeURIComponent(sheet)}` : ""}`);
    setPill("Connected", "ok");
    current.textContent = String(data?.holdMinutes ?? "—");
    holdMinutesInput.value = String(data?.holdMinutes ?? "");
    lastFlush.textContent = data?.metrics?.lastFlushAt ? String(data.metrics.lastFlushAt) : "—";
    setMetrics(data);
  } catch (e) {
    setPill("Not connected", "bad");
    current.textContent = "—";
    lastFlush.textContent = "—";
    setMetrics(null);
    setMsg(e.message, "bad");
  }
}

async function loadSheets() {
  setMsg("");
  try {
    const data = await api("/api/leads-sheets");
    const sheets = Array.isArray(data?.leadsSheets) ? data.leadsSheets : [];
    if (!sheets.length) throw new Error("No lead sheets configured");

    // restore last selected sheet if possible
    const last = localStorage.getItem("lead_lock_selected_sheet") || "";

    leadSheetSelect.innerHTML = "";
    for (const name of sheets) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      leadSheetSelect.appendChild(opt);
    }
    if (last && sheets.includes(last)) leadSheetSelect.value = last;
    else leadSheetSelect.value = sheets[0];
  } catch (e) {
    setPill("Not connected", "bad");
    setMsg(e.message, "bad");
  }
}

async function saveHoldMinutes() {
  setMsg("");
  const m = Number(holdMinutesInput.value);
  if (!Number.isFinite(m) || m < 1 || m > 1440) {
    setMsg("Please enter a value between 1 and 1440.", "bad");
    return;
  }

  try {
    const sheet = (leadSheetSelect.value || "").trim();
    if (!sheet) throw new Error("Select a lead sheet");
    await api("/api/settings", { method: "POST", body: { holdMinutes: m, leadSheet: sheet } });
    setMsg("Saved.", "ok");
    await loadStatus();
  } catch (e) {
    setMsg(e.message, "bad");
  }
}

async function refreshIndex() {
  setMsg("");
  try {
    const sheet = (leadSheetSelect.value || "").trim();
    if (!sheet) throw new Error("Select a lead sheet");
    await api(`/api/refresh-index?sheet=${encodeURIComponent(sheet)}`, { method: "POST" });
    setMsg("Index refreshed.", "ok");
    await loadStatus();
  } catch (e) {
    setMsg(e.message, "bad");
  }
}

// persist admin key locally for convenience.
const LS_KEY = "lead_lock_admin_key";
adminKeyInput.value = localStorage.getItem(LS_KEY) || "";

adminKeyInput.addEventListener("input", () => {
  const v = getAdminKey();
  if (v) localStorage.setItem(LS_KEY, v);
  else localStorage.removeItem(LS_KEY);
});

saveBtn.addEventListener("click", saveHoldMinutes);
reloadBtn.addEventListener("click", loadStatus);
refreshIndexBtn.addEventListener("click", refreshIndex);

leadSheetSelect.addEventListener("change", () => {
  localStorage.setItem("lead_lock_selected_sheet", leadSheetSelect.value);
  loadStatus();
});

// initial load
// load sheet list first, then load status for selected sheet.
(async () => {
  await loadSheets();
  await loadStatus();
})();
