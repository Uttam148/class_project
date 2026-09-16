# CivicConnect

> Crowdsourced Civic Issue Reporting & Resolution System

## 🚀 Live Demo click the below link

👉 **[Open CivicConnect](https://class-project-vi2a.onrender.com)**


# CivicConnect — Crowdsourced Civic Issue Reporting & Resolution System

SIH 2026 MVP. A real full-stack app: Node.js HTTP backend + SQLite database +
a citizen/authority/analytics frontend. **Zero npm dependencies** — everything
uses Node's built-in modules, including its built-in SQLite driver.

## Requirements

- **Node.js v22.5 or later** (needed for the built-in `node:sqlite` module).
  Check your version with `node -v`. If you're on an older Node, upgrade from
  [nodejs.org](https://nodejs.org).

## Run it

```bash
cd civicconnect-app
node server.js
```

Then open **http://localhost:4000** in your browser. That's it — no `npm install`,
no build step. The database file (`civicconnect.db`) is created automatically
in this folder on first run, seeded with 4 demo issues.

To use a different port: `PORT=5000 node server.js`

## What's real here

- **SQLite database** (`civicconnect.db`) — issues, confirmations, all persisted
  to disk. Stop the server, restart it, your data is still there.
- **REST API** (`/api/*`) — issue creation, listing/filtering, confirm/upvote,
  status updates, analytics — all backed by real SQL queries.
- **Photo uploads** — images are saved to `/uploads` on the server and served
  back to the browser.
- **Duplicate detection** — a new report in the same category + ward as an
  existing open issue is automatically merged as a confirmation instead of
  creating a duplicate row.
- **Priority scoring** — recomputed server-side from severity, confirmation
  count, issue age, and a small randomized impact factor, every time an issue
  is confirmed or created.

## What's simulated (by design, for the MVP)

- **AI classification / severity detection** — keyword-based rules in
  `logic.js` (`classify()`, `detectSeverity()`), standing in for a trained
  CV/NLP model. Swap these two functions for real model calls (e.g. a
  Python microservice or a hosted vision/NLP API) without touching anything
  else — the rest of the app only depends on their output shape
  (`{category, confidence}` and a severity string).
- **GPS** — uses the browser's real Geolocation API when permitted, falls
  back to a fixed demo coordinate otherwise.

## Project structure

```
civicconnect-app/
├── server.js       Backend: HTTP server + REST API routes
├── db.js           SQLite schema, connection, demo seed data
├── logic.js        Classification / severity / duplicate / priority logic
├── package.json
├── uploads/         Uploaded photos land here (created automatically)
└── public/          Frontend
    ├── index.html
    ├── styles.css
    └── app.js        Talks to the API via fetch()
```

## API reference

| Method | Path                          | Description                          |
|--------|-------------------------------|---------------------------------------|
| GET    | `/api/meta`                   | Categories, departments, wards, statuses |
| GET    | `/api/issues`                 | List issues (filter: `?department=&status=&ward=`) |
| POST   | `/api/issues`                 | Create a report — runs the full pipeline |
| POST   | `/api/issues/:id/confirm`     | Confirm/upvote an issue (dedup by `voterId`) |
| PATCH  | `/api/issues/:id/status`      | Authority updates status |
| GET    | `/api/analytics`              | Aggregate stats for the dashboard |

## Resetting demo data

Delete `civicconnect.db` and restart the server — it will re-seed automatically.

## Taking this further

- Swap `logic.js`'s classify/severity functions for a real model (image CV +
  text NLP) — this is the one place the "AI" lives.
- Add authentication (citizen login, authority roles) — there is none in
  this MVP; anyone can act as either citizen or authority.
- Move SQLite to Postgres + PostGIS for production-scale geospatial queries
  (the schema is deliberately simple to make this migration easy).
- Deploy: any host that runs Node 22+ works (Render, Railway, a VPS). Since
  there are no native npm modules, there's nothing to compile on deploy.
