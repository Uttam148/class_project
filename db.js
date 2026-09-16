// db.js — persistence layer using Node's built-in SQLite (node:sqlite, Node 22+)
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, 'civicconnect.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_code TEXT UNIQUE NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    ward TEXT NOT NULL,
    severity TEXT NOT NULL,
    confirms INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'ai_verified',
    department TEXT NOT NULL,
    photo_path TEXT,
    ai_confidence REAL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS confirmations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id INTEGER NOT NULL,
    voter_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(issue_id, voter_id)
  );

  CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
  CREATE INDEX IF NOT EXISTS idx_issues_dept ON issues(department);
  CREATE INDEX IF NOT EXISTS idx_issues_ward ON issues(ward);
`);

// Seed demo data on first run only
const countRow = db.prepare('SELECT COUNT(*) AS n FROM issues').get();
if (countRow.n === 0) {
  const seed = db.prepare(`
    INSERT INTO issues (issue_code, category, description, ward, severity, confirms, priority, status, department, photo_path, ai_confidence, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const now = Date.now();
  const daysAgo = (n) => new Date(now - n * 86400000).toISOString();
  const rows = [
    ['CC-1001', 'Pothole', 'Deep pothole outside Ward 14 market, causing two-wheeler skids during rain.', 'Ward 14 — Central Zone', 'high', 6, 87, 'in_progress', 'Roads & Infrastructure', null, 0.94, daysAgo(4), daysAgo(1)],
    ['CC-1002', 'Garbage / Waste', 'Garbage not collected for 5 days near Riverside community park.', 'Ward 7 — Riverside', 'medium', 3, 58, 'assigned', 'Sanitation', null, 0.88, daysAgo(2), daysAgo(1)],
    ['CC-1003', 'Streetlight', 'Streetlight pole flickering and dark for the last week, unsafe at night.', 'Ward 22 — Sector Hills', 'medium', 2, 41, 'reported', 'Electrical / Streetlighting', null, 0.81, daysAgo(1), daysAgo(1)],
    ['CC-1004', 'Water Leakage', 'Constant water leakage from a broken pipe joint, wasting water and flooding the lane.', 'Ward 3 — Old Town', 'high', 9, 92, 'resolved', 'Water Supply & Sewage', null, 0.91, daysAgo(9), daysAgo(2)],
  ];
  for (const r of rows) seed.run(...r);
  console.log('Seeded demo issues.');
}

module.exports = db;
