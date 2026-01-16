// src/config.js
//
// Configuration values for the lead locking system. Fill in the
// LABEL_PHONE constant with the exact header text of your phone
// column in the leads sheet.  All other values may be customised
// according to your needs.

// ===== YOU FILL THESE IN LATER =====

// Leads sheet: header labels
// Set this to the exact header text for the phone number column in
// your leads sheet. For example, "Phone" or "Phone Number (US)". This
// program will normalise phone numbers so minor formatting differences
// don’t matter.
export const LABEL_PHONE = "Phone Number (US)";

// Optional: if you prefer LeadID matching instead of Phone
// export const LABEL_LEAD_ID = "";

// Status/callcount columns are NOT used on Leads anymore (we keep Leads unchanged)

// Lock rule: number of calls before hiding a lead row
export const LOCK_AFTER_CALLS = 2;

// Phone normalization fallback (US default).  If a number is 10
// digits and doesn’t include a country code, this code will be
// prepended. Change to your country as needed.
export const DEFAULT_COUNTRY_CODE = "1";

// RingCentral: count directions. These flags determine whether
// inbound or outbound calls increment the call count. Outbound is
// usually counted; inbound is typically ignored.
export const COUNT_OUTBOUND = true;
export const COUNT_INBOUND = false;