// fill in the LABEL_PHONE constant with the exact header text of your phone
// column in the lead sheet.  All other values may be customised according to your needs.
// ===== YOU FILL THESE IN LATER =====
// lead sheet: header labels
// Set this to the exact header text for the phone number column in
// your leads sheet. For example, "Phone" or "Phone Number (US)". This
// program will normalise phone numbers so formatting differences
// don’t matter.
export const LABEL_PHONE = "Phone Number (US)";

// optional: if you prefer LeadID matching instead of Phone
// export const LABEL_LEAD_ID = "";

// status/callcount columns are NOT used on Leads anymore (we keep Leads unchanged)

// lock rule: number of calls before hiding a lead row
export const LOCK_AFTER_CALLS = 2;

// phone normalization fallback (US default).  If a number is 10
// digits and doesn’t include a country code, this code will be
// prepended. Change to your country as needed.
export const DEFAULT_COUNTRY_CODE = "1";

// ringcentral: count directions. This determines if
// inbound or outbound calls increment the call count. Outbound is
// all thats counted ; inbound is ignored but can be toggled
export const COUNT_OUTBOUND = true;
export const COUNT_INBOUND = false;