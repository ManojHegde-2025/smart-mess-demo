# Manager dashboard - API contract (PROPOSED, not yet implemented by the real services)

Status: **Member 3's ML service was received and read (section 2); Member 2's backend has not been delivered.** The paths below follow the
PRD's core API list (`/api/v1/dashboard/summary`, `/api/v1/forecasts`, `/api/v1/reports/daily`) and add two endpoints the PRD
implies but does not list (`/api/v1/forecasts/evaluations`, `/api/v1/exceptions`). The dashboard client is
`web/api.js`; if the real paths differ, change the `ENDPOINTS` object there and nothing else.
`mock/mock-api.js` implements this contract with **synthetic** numbers so the UI and tests can run.

General rules for every endpoint

- Method `GET`, JSON response, `Accept: application/json`. Dates are `YYYY-MM-DD` (mess-local day).
- `mess` = the id the backend uses. The UI sends the display name ("South Mess") unless `messIds` in `web/config.js` maps it.
- Auth: the browser sends the session cookie (`credentials: 'include'`). Missing session -> **401**, not a manager -> **403**.
  Manager-only data must be enforced **server-side**; the role picker on the login screen is only a demo.
- Errors: non-2xx with optional `{ "error": "message" }` (shown to the user, truncated to 200 chars).
- A missing number is `null` (or omitted). Never send `0` for "unknown": the dashboard shows real zeros as zeros.
- Test/demo data must carry `"synthetic": true` at the top level so the UI shows a SYNTHETIC DATA banner.
- Do not return student names/emails in manager endpoints (exceptions use an anonymised `subjectRef`).
- CORS (if the API is on another origin): `Access-Control-Allow-Origin: <exact app origin>` and
  `Access-Control-Allow-Credentials: true`. Never `*` with credentials.

## 1. `GET /api/v1/dashboard/summary?mess=&date=`  (owner: Member 2)

```json
{ "mess": "South Mess", "date": "2026-10-14", "generatedAt": "2026-10-14T07:36:00Z", "exceptionCount": 3,
  "meals": [ { "mealType": "Lunch", "expected": 720, "served": 501, "prepared": 734 } ] }
```
`served` = successful meal records so far (from `meal_logs`, result = success). `prepared` comes from `mess_usage.prepared_count`.
Periods returned are the periods the mess runs (the PRD lists Breakfast/Lunch/Dinner; the old UI also had Snacks).
**Open question for Member 2:** the exact definition of `expected` (registered students minus approved leave? a forecast?).

## 2. Forecasts  (owner: Member 3's ML service + Member 2's route)

**What Member 3's service really is** (read from `ml/api/app.py`, `ml/src/predict.py`; *not run here*, see below):
`POST /predict` with `{mess_id, date, meal_type, active_students?, approved_leave?, is_holiday?, is_event?}` for **one** meal, header
`X-API-Key` (when `ML_API_KEY` is set). Response:
```json
{ "mess_id": "south", "date": "2026-10-15", "meal_type": "lunch", "predicted_meals": 704, "recommended_preparation": 718,
  "safety_buffer": 0.02, "model_version": "xgb_v1", "method": "xgboost", "warnings": ["model was trained on SYNTHETIC data"],
  "prediction_range": { "low": 680, "high": 731, "coverage": "~80% (validation residuals)" } }
```
`prediction_range` exists only for the xgboost method. HTTP 422 = no history for that mess/meal; 400 = bad input; 401 = bad key.
There is no generated-at time and no endpoint that lists past forecasts.

**Consequences**
1. The key must stay server-side, so the browser must **not** call the ML service. The dashboard calls `GET /api/v1/forecasts?mess=&date=`
   on the backend (Member 2), which calls `/predict` once per meal. Until that route exists, `adapters/ml-proxy.js` does exactly this
   locally (open the app with `?demo=1&mlproxy=1`, run `npm run ml-proxy`). Delete it once Member 2's route exists.
2. Dashboard-facing response (the client also accepts the ML's own snake_case fields, so passing ML objects through works):
```json
{ "forecasts": [ { "mess_id": "south", "date": "2026-10-15", "meal_type": "lunch", "predicted_meals": 704, "recommended_preparation": 718,
   "prediction_range": { "low": 680, "high": 731 }, "model_version": "xgb_v1", "method": "xgboost", "warnings": [] } ],
  "unavailable": [ { "meal_type": "breakfast", "reason": "No history for mess='south' meal='breakfast' before 2026-10-15" } ] }
```
   (camelCase equivalents `predictedCount`, `range`, `modelVersion`, `recommendedPrep`, `generatedAt`, `targetDate` also work.)
3. `recommended_preparation` comes from the ML service's `SAFETY_BUFFER` (default 2 %), so the dashboard shows it as the service's
   recommendation and applies no buffer of its own. Whether 2 % is the *agreed* business rule is still a team decision.
4. `warnings` and `method` are shown on every forecast card; a warning containing "SYNTHETIC" turns on the SYNTHETIC DATA banner.
5. Mess ids: the ML service lowercases ids and uses e.g. `south`. The adapter maps "South Mess" -> `south`, "North Mess" -> `north`
   (**assumption**, override with `MESS_ID_MAP`); Member 2 must confirm the real ids.

## 3. `GET /api/v1/forecasts/evaluations?mess=&from=&to=&meal=`  (NEW - owner: Member 2, DB-backed)

```json
{ "records": [ { "targetDate": "2026-10-10", "mealType": "Lunch", "predictedCount": 700, "actualCount": 690, "modelVersion": "v1.2" } ] }
```
Backed by the PRD's `forecast_evaluations` table joined to `forecasts` in the backend database. The ML service cannot provide this: its `POST /evaluate-forecasts` only scores pairs it is sent, and nothing in it stores forecasts. Until Member 2 builds it, the predicted-vs-actual chart shows an honest error (the adapter answers 501). The dashboard computes absolute error, MAE and RMSE
itself and shows them only when at least 5 valid pairs exist (`MIN_EVAL_RECORDS` in `web/calc.js`).

## 4. `GET /api/v1/exceptions?mess=&from=&to=`  (NEW - owner: Member 2)

```json
{ "exceptions": [ { "id": "e1", "timestamp": "2026-10-14T12:31:00", "type": "duplicate_scan",
   "description": "Second scan attempt for the same meal", "subjectRef": "S-7A3F", "status": "rejected" } ] }
```
Suggested `type` values: `duplicate_scan`, `leave_rejection`, `invalid_scan`, `sync_failure`, other values are displayed too.
Derive from `meal_logs` where `result != success` (+ sync/offline events). Only `id`/`type` are important; all other fields optional.
Unknown extra fields are ignored by the client (so personal data is never rendered).

## 5. `GET /api/v1/reports/daily?mess=&from=&to=`  (owner: Member 2)

One row per date and meal period (also used for monthly reports by passing the month's first and last day):
```json
{ "rows": [ { "date": "2026-10-13", "mealType": "Lunch", "expected": 720, "served": 708, "prepared": 734, "predictedCount": 720 } ] }
```
A monthly report is simply 28-31 days of rows; the endpoint must accept ranges of at least 31 days. `predictedCount` is the
forecast that was made for that date/meal (so forecast error can be shown per row).

## 6. Write endpoints (not called by the dashboard yet)

`POST /api/mess-usage/prepared` and `POST /api/mess-usage/actual` are in the PRD. **Someone needs a way to enter the prepared
count** (otherwise "prepared vs served" stays "Unavailable"). Candidate: a small form on the manager dashboard. Not built,
because the request/response shape and who may call it are undecided.

## Blockers summary

| # | Needs | From |
|---|-------|------|
| 1 | Real implementations of endpoints 1, 4, 5 (and agreed paths) | Member 2 |
| 2 | Definition of `expected` meals | Member 2 |
| 3 | Backend route `/api/v1/forecasts` that calls the ML `/predict` per meal and **stores** each forecast; `/api/v1/forecasts/evaluations` from stored forecasts vs actuals | Member 2 (ML side received) |
| 3b | Run Member 3's service on real history (none supplied; only a synthetic example report) and confirm the contract above | Member 3 |
| 4 | Real authentication + manager role enforcement (current login is a demo) | Member 2 |
| 5 | CORS config (or same-origin proxy) for the app origin | Member 2 |
| 6 | Way to record prepared counts | Member 2 + manager decision |
| 7 | Confirm the preparation buffer (ML default 2 %, PRD example 2 %) is the agreed rule | Mess manager / team |
