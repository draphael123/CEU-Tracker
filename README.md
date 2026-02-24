# CE Broker CEU Tracker

Automates logging into CE Broker for each provider, scrapes CEU completion data, and exports a colour-coded Excel report.

---

## Prerequisites

- **Node.js 18+** — [nodejs.org](https://nodejs.org)
- Internet access to reach `cebroker.com`

---

## Setup

```bash
# 1. Install npm dependencies
npm install

# 2. Install the Playwright browser (Chromium)
npx playwright install chromium
```

---

## Running the Script

```bash
node index.js
```

A browser window will open (non-headless). You can watch each login happen in real time.

**Output files created in the project folder:**

| File | Description |
|---|---|
| `ceu_status_report.xlsx` | Excel report with Summary + Detail sheets |
| `screenshots/` | Error screenshots (only created when a login/scrape fails) |

---

## Updating Provider Credentials

Edit `providers.json`. Each entry supports:

```json
{
  "name":           "Display name in the report",
  "type":           "NP | MD | RN | DO | etc.",
  "username":       "email or username used on CE Broker",
  "password":       "password",
  "usernameFormat": "email | username"
}
```

---

## Report Structure

### Sheet 1 — Summary

One row per tracked license. The **Status** column is colour-coded:

| Colour | Meaning |
|---|---|
| Green  | Complete — 0 hours remaining |
| Yellow | In Progress — hours remaining, >60 days to deadline |
| Red    | At Risk — hours remaining, ≤60 days to deadline |

The **Course Search Link** column links to CE Broker's course search filtered for that provider's state and license type.

### Sheet 2 — Detail

One row per subject-area requirement (e.g. Pharmacology, Opioid Training, Ethics) showing how many topic-specific hours are complete vs. required.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Login fails for a provider | Check the screenshot in `/screenshots/ProviderName_login_error.png`. Verify credentials in `providers.json`. |
| No data scraped | CE Broker may have updated its UI. See the *Selector Tuning* section below. |
| Script crashes on launch | Run `npx playwright install chromium` to ensure the browser binary is present. |

### Selector Tuning

All CSS selectors are centralised in the `SELECTORS` object at the top of `scraper.js`. If CE Broker updates its UI:

1. Open DevTools on the relevant page
2. Identify the new class/attribute for the field that broke
3. Update the matching entry in `SELECTORS`

---

## File Structure

```
ce-broker-automation/
  ├── index.js              Main entry point
  ├── providers.json        Provider credentials (edit this)
  ├── scraper.js            Playwright login + scrape logic
  ├── exporter.js           ExcelJS spreadsheet builder
  ├── utils.js              Helpers: delays, logging, status logic
  ├── screenshots/          Auto-created; error screenshots land here
  ├── ceu_status_report.xlsx  Generated report (overwritten each run)
  └── package.json
```
