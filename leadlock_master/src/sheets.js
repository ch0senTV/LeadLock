// google sheets layer.
//
//  - leads tabs are NEVER edited (no cell rewrites, no moving rows).
//  - leads “disappear/reappear” is implemented ONLY via row hide/unhide.
//  - all mutable state lives in Locks + Settings tabs.
//
// multi-sheet support:
//  - set LEADS_SHEET_NAMES="Tab A,Tab B" (comma-separated)
//  - if not set, falls back to LEADS_SHEET_NAME.
//
// per-sheet cooldown:
//  - settings supports either legacy global A2 (minutes)
//  - or a table in A:B with header: LeadSheet | HoldMinutes

import { google } from "googleapis";
import { LABEL_PHONE } from "./config.js";
import { state } from "./memory.js";
import {
  chunk,
  normalizePhone,
  nowIso,
  minutesFromNowIso,
  safeNumber,
  withRetry
} from "./util.js";

function assertConfig() {
  if (!LABEL_PHONE) throw new Error("Fill config.js: LABEL_PHONE");
}

function parseLeadsNames() {
  const multi = (process.env.LEADS_SHEET_NAMES || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  if (multi.length) return multi;
  const single = (process.env.LEADS_SHEET_NAME || "").trim();
  return single ? [single] : [];
}

export class SheetsStore {
  constructor() {
    this.sheetId = process.env.SHEET_ID;
    this.leadsNames = parseLeadsNames();
    this.locksName = process.env.LOCKS_SHEET_NAME || "Locks";
    this.settingsName = process.env.SETTINGS_SHEET_NAME || "Settings";
    if (!this.sheetId) throw new Error("Missing SHEET_ID");
    if (!this.leadsNames.length) {
      throw new Error("Missing LEADS_SHEET_NAME (or LEADS_SHEET_NAMES)");
    }
    this._sheets = null;
    this._sheetIdCache = new Map();
  }

  sheets() {
    if (this._sheets) return this._sheets;
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });
    this._sheets = google.sheets({ version: "v4", auth });
    return this._sheets;
  }

  async getSpreadsheetMeta() {
    const sheets = this.sheets();
    return withRetry(() => sheets.spreadsheets.get({ spreadsheetId: this.sheetId }));
  }

  async getSheetIdByTitle(title) {
    if (this._sheetIdCache.has(title)) return this._sheetIdCache.get(title);
    const meta = await this.getSpreadsheetMeta();
    const sheet = (meta.data.sheets || []).find(s => s.properties?.title === title);
    if (!sheet) throw new Error(`Sheet not found: ${title}`);
    const id = sheet.properties.sheetId;
    this._sheetIdCache.set(title, id);
    return id;
  }

  /**
   * refresh the leads index.
   * - if sheetName is provided, refresh only that tab.
   * - otherwise refresh all configured leads tabs.
   */
  async refreshLeadsIndex(sheetName) {
    assertConfig();
    const sheets = this.sheets();

    const targetSheets = sheetName
      ? [sheetName]
      : this.leadsNames;

    // invalidate cache for any updated sheet ids (rare, but safe)
    for (const n of targetSheets) this._sheetIdCache.delete(n);

    const ranges = targetSheets.map(n => `${n}!A:Z`);
    const res = await withRetry(() =>
      sheets.spreadsheets.values.batchGet({
        spreadsheetId: this.sheetId,
        ranges
      })
    );

    // if refreshing a single sheet, first remove existing mappings for that sheet
    if (sheetName) {
      for (const [phone, loc] of state.leadsCache.phoneToLoc.entries()) {
        if (loc?.sheetName === sheetName) state.leadsCache.phoneToLoc.delete(phone);
      }
    } else {
      state.leadsCache.phoneToLoc = new Map();
      state.leadsCache.headerMap = new Map();
    }

    const valueRanges = res.data.valueRanges || [];

    for (let idx = 0; idx < valueRanges.length; idx++) {
      const vr = valueRanges[idx];
      const sheet = targetSheets[idx];
      const values = vr.values || [];
      const header = values[0] || [];

      const headerMap = new Map();
      header.forEach((h, i) => headerMap.set(String(h).trim(), i));

      // save header map for the first sheet (god tier debugging)
      if (!state.leadsCache.headerMap.size) state.leadsCache.headerMap = headerMap;

      const phoneCol = headerMap.get(LABEL_PHONE);
      if (phoneCol === undefined) {
        throw new Error(`Leads header not found in "${sheet}": "${LABEL_PHONE}"`);
      }

      for (let r = 1; r < values.length; r++) {
        const rowIndex1 = r + 1;
        const phone = normalizePhone(values[r]?.[phoneCol]);
        if (!phone) continue;
        // first sheet in configured order wins if duplicates exist.
        if (!state.leadsCache.phoneToLoc.has(phone)) {
          state.leadsCache.phoneToLoc.set(phone, { sheetName: sheet, rowIndex1 });
        }
      }
    }

    state.leadsCache.loadedAt = Date.now();
  }

  getHoldMinutesForSheet(sheetName) {
    const v = state.holdMinutesBySheet.get(sheetName);
    return Number.isFinite(v) && v > 0 ? v : state.holdMinutes;
  }

  /**
   * settings formats supported:
   *  - legacy global: Settings!A2 = minutes
   *  - per-sheet table:
   *      A1=LeadSheet, B1=HoldMinutes
   *      A2.. = sheetName, B2.. = minutes
   */
  async loadHoldMinutesFromSettings() {
    const sheets = this.sheets();
    state.holdMinutesBySheet = new Map();

    // try table first
    try {
      const res = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: this.sheetId,
          range: `${this.settingsName}!A1:B2000`
        })
      );
      const rows = res.data.values || [];
      const h1 = String(rows?.[0]?.[0] || "").trim();
      const h2 = String(rows?.[0]?.[1] || "").trim();

      if (h1.toLowerCase() === "leadsheet" && h2.toLowerCase() === "holdminutes") {
        for (let i = 1; i < rows.length; i++) {
          const name = String(rows[i]?.[0] || "").trim();
          const m = Number(rows[i]?.[1]);
          if (!name) continue;
          if (Number.isFinite(m) && m > 0 && m <= 1440) {
            state.holdMinutesBySheet.set(name, m);
          }
        }
        // also load legacy A2 as default if present
        const legacy = Number(rows?.[1]?.[0]);
        if (Number.isFinite(legacy) && legacy > 0 && legacy <= 1440) {
          // only use legacy if someone put it there intentionally; otherwise keep env default.
        }
        return;
      }
    } catch {
      // ignore
    }

    // legacy: A2
    try {
      const res = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: this.sheetId,
          range: `${this.settingsName}!A2`
        })
      );
      const v = res.data.values?.[0]?.[0];
      const m = Number(v);
      if (Number.isFinite(m) && m > 0 && m <= 1440) state.holdMinutes = m;
    } catch {
      // ok if Settings doesn't exist yet
    }
  }

  async saveHoldMinutesToSettings(minutes, sheetName) {
    const sheets = this.sheets();
    const m = Number(minutes);
    if (!Number.isFinite(m) || m <= 0 || m > 1440) throw new Error("Invalid holdMinutes");

    // if sheetName provided, use per-sheet table.
    if (sheetName) {
      // read existing table
      const res = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: this.sheetId,
          range: `${this.settingsName}!A1:B2000`
        })
      );
      const rows = res.data.values || [];
      const h1 = String(rows?.[0]?.[0] || "").trim();
      const h2 = String(rows?.[0]?.[1] || "").trim();

      // ensure header exists
      if (!(h1.toLowerCase() === "leadsheet" && h2.toLowerCase() === "holdminutes")) {
        await withRetry(() =>
          sheets.spreadsheets.values.update({
            spreadsheetId: this.sheetId,
            range: `${this.settingsName}!A1:B1`,
            valueInputOption: "RAW",
            requestBody: { values: [["LeadSheet", "HoldMinutes"]] }
          })
        );
      }

      // find existing row
      let foundRow = null;
      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i]?.[0] || "").trim() === sheetName) {
          foundRow = i + 1; // 1-based
          break;
        }
      }

      if (foundRow) {
        await withRetry(() =>
          sheets.spreadsheets.values.update({
            spreadsheetId: this.sheetId,
            range: `${this.settingsName}!B${foundRow}`,
            valueInputOption: "RAW",
            requestBody: { values: [[String(m)]] }
          })
        );
      } else {
        await withRetry(() =>
          sheets.spreadsheets.values.append({
            spreadsheetId: this.sheetId,
            range: `${this.settingsName}!A:B`,
            valueInputOption: "RAW",
            insertDataOption: "INSERT_ROWS",
            requestBody: { values: [[sheetName, String(m)]] }
          })
        );
      }
      return;
    }

    // legacy global
    await withRetry(() =>
      sheets.spreadsheets.values.update({
        spreadsheetId: this.sheetId,
        range: `${this.settingsName}!A2`,
        valueInputOption: "RAW",
        requestBody: { values: [[String(m)]] }
      })
    );
  }

  /**
   * locks schema v2 (recommended, required for multi-sheet):
   * A Phone
   * B LeadSheet
   * C LeadRow
   * D CallCount
   * E LockedUntil
   * F LastEventId
   * G UpdatedAt
   */
  async getLocksAll() {
    const sheets = this.sheets();
    const res = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: this.sheetId,
        range: `${this.locksName}!A:G`
      })
    );
    return res.data.values || [];
  }

  _detectLocksSchema(headerRow) {
    const h = (headerRow || []).map(x => String(x || "").trim().toLowerCase());
    const isV2 = h[0] === "phone" && h[1] === "leadsheet";
    return { isV2 };
  }

  async upsertLocksAndHideIfNeeded(entries) {
    if (!entries.length) return;

    if (this.leadsNames.length > 1) {
      // ensure we are operating with v2 Locks schema.
      const locksPreview = await this.getLocksAll();
      const schema = this._detectLocksSchema(locksPreview[0] || []);
      if (!schema.isV2) {
        throw new Error(
          `Locks sheet must use v2 headers for multi-sheet: Phone | LeadSheet | LeadRow | CallCount | LockedUntil | LastEventId | UpdatedAt`
        );
      }
    }

    const sheets = this.sheets();

    if (!state.leadsCache.loadedAt) await this.refreshLeadsIndex();

    const locks = await this.getLocksAll();
    const header = locks[0] || [];
    const rows = locks.slice(1);
    const { isV2 } = this._detectLocksSchema(header);

    // phone|sheet -> { rowIndex1, row }
    const lockMap = new Map();
    for (let i = 0; i < rows.length; i++) {
      const rowIndex1 = i + 2;
      const phone = normalizePhone(rows[i]?.[0]);
      if (!phone) continue;
      const sheetName = isV2 ? String(rows[i]?.[1] || "").trim() : "";
      const key = isV2 ? `${phone}|${sheetName}` : phone;
      lockMap.set(key, { rowIndex1, row: rows[i] });
    }

    const locksWrites = [];
    const hideRequests = [];

    for (const e of entries) {
      const phone = e.phone;
      const inc = e.inc;
      const eventId = e.eventId || "";

      const loc = state.leadsCache.phoneToLoc.get(phone);
      if (!loc) continue;

      const leadSheet = loc.sheetName;
      const leadRowIndex1 = loc.rowIndex1;

      const key = isV2 ? `${phone}|${leadSheet}` : phone;
      const found = lockMap.get(key);

      const curCount = found ? safeNumber(isV2 ? found.row?.[3] : found.row?.[2], 0) : 0;
      const nextCount = curCount + inc;

      const lockedUntilIdx = isV2 ? 4 : 3;
      let lockedUntil = found ? String(found.row?.[lockedUntilIdx] || "").trim() : "";
      const currentlyLocked = lockedUntil && Date.parse(lockedUntil) > Date.now();

      // lock if threshold reached and not already locked
      if (!currentlyLocked && nextCount >= state.lockAfterCalls) {
        const hold = this.getHoldMinutesForSheet(leadSheet);
        lockedUntil = minutesFromNowIso(hold);

        const leadsSheetId = await this.getSheetIdByTitle(leadSheet);
        hideRequests.push({
          updateDimensionProperties: {
            range: {
              sheetId: leadsSheetId,
              dimension: "ROWS",
              startIndex: leadRowIndex1 - 1,
              endIndex: leadRowIndex1
            },
            properties: { hiddenByUser: true },
            fields: "hiddenByUser"
          }
        });
      }

      const updatedAt = nowIso();

      if (isV2) {
        const values = [[
          phone,
          leadSheet,
          String(leadRowIndex1),
          String(nextCount),
          lockedUntil,
          eventId,
          updatedAt
        ]];
        if (found) {
          locksWrites.push({
            range: `${this.locksName}!A${found.rowIndex1}:G${found.rowIndex1}`,
            values
          });
        } else {
          locksWrites.push({ range: `${this.locksName}!A:G`, values, append: true });
        }
      } else {
        // legacy single-sheet schema
        const values = [[phone, String(leadRowIndex1), String(nextCount), lockedUntil, eventId, updatedAt]];
        if (found) {
          locksWrites.push({
            range: `${this.locksName}!A${found.rowIndex1}:F${found.rowIndex1}`,
            values
          });
        } else {
          locksWrites.push({ range: `${this.locksName}!A:F`, values, append: true });
        }
      }
    }

    const updateData = [];
    const appendRows = [];
    for (const w of locksWrites) {
      if (w.append) appendRows.push(w.values[0]);
      else updateData.push({ range: w.range, values: w.values });
    }

    if (updateData.length) {
      for (const b of chunk(updateData, 200)) {
        await withRetry(() =>
          sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: this.sheetId,
            requestBody: { valueInputOption: "RAW", data: b }
          })
        );
      }
    }

    if (appendRows.length) {
      const range = isV2 ? `${this.locksName}!A:G` : `${this.locksName}!A:F`;
      for (const b of chunk(appendRows, 200)) {
        await withRetry(() =>
          sheets.spreadsheets.values.append({
            spreadsheetId: this.sheetId,
            range,
            valueInputOption: "RAW",
            insertDataOption: "INSERT_ROWS",
            requestBody: { values: b }
          })
        );
      }
    }

    if (hideRequests.length) {
      await withRetry(() =>
        sheets.spreadsheets.batchUpdate({
          spreadsheetId: this.sheetId,
          requestBody: { requests: hideRequests }
        })
      );
    }
  }

  async unlockExpiredAndUnhide() {
    const sheets = this.sheets();
    if (!state.leadsCache.loadedAt) await this.refreshLeadsIndex();

    const locks = await this.getLocksAll();
    const header = locks[0] || [];
    const rows = locks.slice(1);
    if (!rows.length) return;

    const { isV2 } = this._detectLocksSchema(header);

    const now = Date.now();
    const unhideRequests = [];
    const lockUpdates = [];

    for (let i = 0; i < rows.length; i++) {
      const lockRowIndex1 = i + 2;
      const phone = normalizePhone(rows[i]?.[0]);
      if (!phone) continue;

      const leadSheet = isV2 ? String(rows[i]?.[1] || "").trim() : this.leadsNames[0];
      const storedLeadRow = safeNumber(isV2 ? rows[i]?.[2] : rows[i]?.[1], 0);
      const lockedUntil = String(isV2 ? rows[i]?.[4] : rows[i]?.[3] || "").trim();
      if (!leadSheet || !storedLeadRow || !lockedUntil) continue;

      const t = Date.parse(lockedUntil);
      if (!Number.isFinite(t)) continue;
      if (t > now) continue;

      // prefer current location from index (handles inserted/deleted rows)
      const loc = state.leadsCache.phoneToLoc.get(phone);
      const rowToUnhide = (loc && loc.sheetName === leadSheet) ? loc.rowIndex1 : storedLeadRow;

      const leadsSheetId = await this.getSheetIdByTitle(leadSheet);
      unhideRequests.push({
        updateDimensionProperties: {
          range: {
            sheetId: leadsSheetId,
            dimension: "ROWS",
            startIndex: rowToUnhide - 1,
            endIndex: rowToUnhide
          },
          properties: { hiddenByUser: false },
          fields: "hiddenByUser"
        }
      });

      // clear LockedUntil but keep CallCount and everything else
      if (isV2) {
        lockUpdates.push({
          range: `${this.locksName}!E${lockRowIndex1}:G${lockRowIndex1}`,
          values: [["", rows[i]?.[5] || "", nowIso()]]
        });
      } else {
        lockUpdates.push({
          range: `${this.locksName}!D${lockRowIndex1}:F${lockRowIndex1}`,
          values: [["", rows[i]?.[4] || "", nowIso()]]
        });
      }
    }

    if (unhideRequests.length) {
      await withRetry(() =>
        sheets.spreadsheets.batchUpdate({
          spreadsheetId: this.sheetId,
          requestBody: { requests: unhideRequests }
        })
      );
    }

    if (lockUpdates.length) {
      for (const b of chunk(lockUpdates, 200)) {
        await withRetry(() =>
          sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: this.sheetId,
            requestBody: { valueInputOption: "RAW", data: b }
          })
        );
      }
    }
  }
}
