# Demo guide, status and known limits (Member 4)

## Honest status

- **Real integration: none verified yet.** Member 3's ML code was received and the dashboard/adapter match its documented contract, but I could not run it (the sandbox blocks pypi.org, so pandas/xgboost could not be installed) and no history data or trained model came with it. There is no backend from Member 2. The dashboard is wired to a documented
  contract (`docs/API_CONTRACT.md`) and verified against a **synthetic mock** (`mock/mock-api.js`). Pointing it at the real
  services is a config change (`web/config.js`) once Members 2 and 3 deliver, followed by running the integration checks below.
- Everything the mock returns is flagged `"synthetic": true`, so the UI shows a yellow **SYNTHETIC DATA** banner. Never present
  the demo numbers as real mess data or as ML accuracy.
- Still demo-only (Member 1 / not mine): login (any ID + 4 characters), student scan simulation, student data, feedback,
  inventory, menu management, attendance and student records (all in browser `localStorage`). These are labelled "Demo".

## Run it

```
npm run demo          # static app :3000 + synthetic mock API :4000
# open http://localhost:3000/?demo=1  -> choose "Mess Chief", any ID, password of 4+ characters
npm start             # app only (same-origin API; without a backend the dashboard shows honest error states)
npm run ml-proxy      # optional: forecasts through the ML adapter (needs the ML service running); open /?demo=1&mlproxy=1
npm run test:all      # check + unit tests + browser E2E (needs: npm i -D playwright; Chromium)
```
Env vars (see `.env.example`): `PORT` (app), `MOCK_PORT`, `MOCK_ALLOWED_ORIGIN`, `MOCK_SCENARIO` (mock only).

## Hackathon demo checklist (about 4 minutes)

1. `npm run demo`, open `http://localhost:3000/?demo=1`, sign in as Mess Chief, pick **South Mess** (the pilot).
2. **Dashboard**: point at LIVE + last-updated time, KPI cards with their badges (Actual / Model prediction / Estimate),
   per-meal expected / served / remaining and progress bars. Say out loud: "synthetic data, flagged on screen".
3. "Estimated surplus" label: prepared minus served, **not measured waste**; surplus is overstated while a meal is still in service.
4. **Tomorrow's forecast**: range, model version and generated time appear only because the service sent them.
5. **Exceptions**: duplicate scans, leave rejections, sync failures (anonymised references).
6. **Meal Demand Prediction**: predicted-vs-actual chart, change the meal/date filters, MAE/RMSE with the number of forecasts behind them.
7. **Reports**: daily, then monthly; **Download CSV** and open it - the TOTAL row equals the table.
8. Failure handling (terminal): `curl -X POST localhost:4000/__mock/scenario -d '{"name":"fail-forecast"}'` then reload the dashboard:
   forecast shows an error with Retry while live counts keep working. Other scenarios: `over`, `missing`, `empty`, `fail-summary`, `auth`.
   Reset with `{"name":"normal"}`. Stop the mock to show the "Could not reach the service" state - no fake numbers appear.
9. Toggle dark mode; open on a phone-sized window.

## Formulas used (all in `web/calc.js`, unit tested)

- remaining = max(expected − served, 0); expected and served are shown exactly as received, over-service is flagged.
- estimated surplus = max(prepared − served, 0); surplus % = surplus / prepared × 100, "n/a" when prepared is 0 or missing.
- absolute error = |predicted − actual|; MAE and RMSE only with at least 5 valid forecast/actual pairs. Today (meals still in service) is excluded from forecast error.
- Totals add only values that exist and say "Partial: n of m meals" when some are missing.

## Known limits / bugs

- Auto-refresh is 30 s (`refreshMs`), live counts and exceptions only; the forecast refreshes on page open or "Refresh now".
- Surplus for today is naturally overstated until meals finish; there is no "meal closed" signal in the contract.
- No UI to enter prepared counts yet (see API_CONTRACT section 6).
- `Snacks` exists in the old student UI but not in the PRD; the dashboard shows whatever periods the backend returns, filters offer Breakfast/Lunch/Dinner.
- The CSV exports the report table; exceptions are on screen only.
- ML tests use a **fake** of Member 3's contract (`test/fake-ml.js`), not their service. Please run `python -m pytest` and `uvicorn` on a machine with internet, then `npm run ml-proxy`.
- Browser-only mock/E2E coverage: real-service integration tests are **blocked** (nothing to integrate with).
- Security (needs Member 2 before production): the Mess Chief role is chosen on the client; real server-side auth and RBAC are required.
  The dashboard stores no credentials (it relies on the backend session cookie).

## Changes that affect Member 1's file (`index.html`)

- Mess Chief pages **Dashboard, Meal Demand Prediction, Reports** are now rendered by `web/dashboard.js` (installed at the end of the inline script).
- Removed the simulated `pred()` / `trend()` functions and the invented "×1.04 recommended preparation".
- The old browser-only low-stock/feedback summary and "verified meals" table stay on those pages, labelled "Demo data".
- Added `<link>` for `web/dashboard.css` and five `<script src>` tags (`config, calc, api, charts, dashboard`). Student portal code is unchanged.
- `index.original.html` was shown as a staged deletion in git when this work started; it was not touched by this work.
