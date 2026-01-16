# Lead Cooldown for Google Sheets (RingCentral)

I built this after overhearing a real problem at work: the same lead getting called by multiple reps in a short window, which burns the lead and annoys people.

This service listens for **RingCentral “call ended”** events and then **hides the matching row** in Google Sheets for a cooldown period. After the timer expires, it **unhides the row**.

**Important promise:** it never edits your lead data (no status columns, no rewrites, no moving rows). The Leads tabs stay pristine — all state lives in a separate `Locks` tab.

---

## How it works (quick)

- RingCentral webhook → server
- Server finds the lead by phone number (`Phone Number (US)`) and updates **Locks**
- If the call count reaches the threshold (default: 2), the lead row is hidden
- A background sweep unhides rows when their cooldown expires

---

## UI (what it’s for)

The UI is intentionally small:

- Pick a **lead sheet tab** from a dropdown
- Set a **cooldown minutes** value for that specific tab
- Click **Refresh index** for that tab (useful after big lead imports)
- View **read-only metrics** (webhooks received, flush count, last error, etc.)

Nothing in the UI can modify lead data.

---

## Will leads come back in the same spot?

Yes — this app does **not** move rows. It only toggles the Google Sheets “row hidden” property.

- If marketing **adds new rows**, your cooled-down row simply shifts down like normal spreadsheet rows do.
- When the cooldown expires, the app unhides that same row (it prefers the latest phone→row mapping so it doesn’t unhide the wrong row after inserts/deletes).

Two things that *can* change where a row appears (this is just how Sheets works):
- Someone **sorts/filters** the sheet (sorting reorders rows)
- You have **duplicate phone numbers** in the same tab (the first match wins)

---

## One-time Google Sheets setup

### 1) Leads tabs
Leave your Leads tabs exactly as they are.

Your phone column header must be exactly:

- `Phone Number (US)`

### 2) Create a `Locks` tab
Create a tab named **Locks** with this header row in row 1:

`Phone | LeadSheet | LeadRow | CallCount | LockedUntil | LastEventId | UpdatedAt`

### 3) (Recommended) Create a `Settings` tab
Create a tab named **Settings**.

This app supports per-sheet cooldowns using a simple table:

Row 1:
- A1 = `LeadSheet`
- B1 = `HoldMinutes`

Rows 2+:
- A2 = the exact sheet tab name
- B2 = minutes (1 to 1440)

The app will create the header row for you if it’s missing.

---

## Google Service Account

1. Create a Google Cloud **Service Account**
2. Create a **JSON key**
3. Share your spreadsheet to the service account email as **Editor**

---

## Configure `.env`

Copy the example file:

```bash
cp .env.example .env
```

Fill in:

- `ADMIN_KEY` (long random string)
- `WEBHOOK_SHARED_SECRET` (long random string)
- `SHEET_ID` (from the Sheets URL)
- `LEADS_SHEET_NAMES` (comma-separated tab names) or `LEADS_SHEET_NAME` for a single tab
- `GOOGLE_SERVICE_ACCOUNT_JSON` (paste the full JSON on one line)

---

## Run locally

```bash
npm install
npm start
```

Open the UI:

- http://localhost:3000/

Health check:

- http://localhost:3000/health

---

## Docker (recommended for production)

```bash
docker build -t lead-cooldown .
docker run --env-file .env -p 3000:3000 lead-cooldown
```

---

## RingCentral webhook

Point RingCentral at:

- `https://YOUR-DOMAIN/ringcentral/webhook`

Send the secret header:

- `x-webhook-secret: <WEBHOOK_SHARED_SECRET>`

RingCentral’s Validation-Token handshake is supported automatically.
