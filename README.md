# Smart Mess (local)

Run: `npm start` -> http://localhost:3000 (or `python -m http.server 3000`, or open `index.html`).

Student portal: demo only - login, QR scan and student data are simulated and stored in this browser.

**Mess manager dashboard (Member 4)** - Dashboard, Meal Demand Prediction and Reports use a real-API client
(`web/`). Until the backend/ML services exist, try it with synthetic data:

```
npm run demo        # app :3000 + synthetic mock API :4000
# open http://localhost:3000/?demo=1  ->  Mess Chief
npm run test:all    # syntax check + unit tests + browser E2E
```

- ML adapter (interim, key stays server-side): `npm run ml-proxy`, open `/?demo=1&mlproxy=1`
- API contract and blockers: `docs/API_CONTRACT.md`
- Demo checklist, formulas, limits: `docs/DEMO_AND_STATUS.md`
- Settings (API base URL, ML base URL, refresh interval): `web/config.js`; env vars: `.env.example`
