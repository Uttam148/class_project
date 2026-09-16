// server.js — CivicConnect backend. Pure Node.js (http + node:sqlite), no npm deps.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { DEPTS, classify, detectSeverity, computeScore, daysBetween } = require('./logic');

const PORT = process.env.PORT || 4000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Access-Control-Allow-Origin': '*', ...headers });
  res.end(body);
}
function sendJSON(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json' });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 15 * 1024 * 1024) { req.destroy(); reject(new Error('Payload too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJSON(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { return {}; }
}

function rowToIssue(r) {
  return {
    id: r.issue_code,
    dbId: r.id,
    category: r.category,
    description: r.description,
    ward: r.ward,
    severity: r.severity,
    confirms: r.confirms,
    priority: r.priority,
    status: r.status,
    department: r.department,
    photoUrl: r.photo_path ? `/uploads/${r.photo_path}` : null,
    aiConfidence: r.ai_confidence,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function nextIssueCode() {
  const row = db.prepare(`SELECT issue_code FROM issues ORDER BY id DESC LIMIT 1`).get();
  if (!row) return 'CC-1001';
  const n = parseInt(row.issue_code.split('-')[1], 10) || 1000;
  return `CC-${n + 1}`;
}

function saveBase64Photo(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,(.+)$/);
  if (!match) return null;
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  const buf = Buffer.from(match[2], 'base64');
  if (buf.length > 8 * 1024 * 1024) return null; // 8MB cap
  const filename = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buf);
  return filename;
}

/* ------------------------- API handlers ------------------------- */

function listIssues(query) {
  let sql = 'SELECT * FROM issues WHERE 1=1';
  const params = [];
  if (query.department) { sql += ' AND department = ?'; params.push(query.department); }
  if (query.status) { sql += ' AND status = ?'; params.push(query.status); }
  if (query.ward) { sql += ' AND ward = ?'; params.push(query.ward); }
  sql += ' ORDER BY priority DESC, id DESC';
  return db.prepare(sql).all(...params).map(rowToIssue);
}

function createIssue(body) {
  const description = (body.description || '').trim();
  if (!description) throw { status: 400, message: 'Description is required.' };
  const ward = body.ward || 'Ward 14 — Central Zone';

  const cls = classify(description, body.category || null);
  const severity = detectSeverity(description);
  const department = DEPTS[cls.category];

  // Duplicate detection: same open category+ward issue already exists
  const dup = db.prepare(
    `SELECT * FROM issues WHERE category = ? AND ward = ? AND status != 'resolved' ORDER BY id DESC LIMIT 1`
  ).get(cls.category, ward);

  const photoFilename = saveBase64Photo(body.photo);
  const now = new Date().toISOString();

  if (dup) {
    const voterId = body.voterId || crypto.randomUUID();
    try {
      db.prepare(`INSERT INTO confirmations (issue_id, voter_id, created_at) VALUES (?,?,?)`)
        .run(dup.id, voterId, now);
      const newConfirms = dup.confirms + 1;
      const newPriority = computeScore(dup.severity, newConfirms, daysBetween(dup.created_at));
      db.prepare(`UPDATE issues SET confirms = ?, priority = ?, updated_at = ? WHERE id = ?`)
        .run(newConfirms, newPriority, now, dup.id);
    } catch (e) {
      // voter already confirmed this issue — ignore, just return current state
    }
    const updated = db.prepare('SELECT * FROM issues WHERE id = ?').get(dup.id);
    return { issue: rowToIssue(updated), merged: true, pipeline: pipelineTrace(cls, severity, dup, department) };
  }

  const issueCode = nextIssueCode();
  const priority = computeScore(severity, 1, 0);
  db.prepare(`
    INSERT INTO issues (issue_code, category, description, ward, severity, confirms, priority, status, department, photo_path, ai_confidence, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(issueCode, cls.category, description, ward, severity, 1, priority, 'ai_verified', department, photoFilename, cls.confidence, now, now);

  const created = db.prepare('SELECT * FROM issues WHERE issue_code = ?').get(issueCode);
  return { issue: rowToIssue(created), merged: false, pipeline: pipelineTrace(cls, severity, null, department) };
}

function pipelineTrace(cls, severity, dup, department) {
  return {
    classification: `Detected "${cls.category}" · confidence ${(cls.confidence * 100).toFixed(0)}% · severity: ${severity.toUpperCase()}`,
    duplicate: dup ? `Matched existing report ${dup.issue_code} — merged as confirmation` : 'No matching open reports found — new issue created',
    routing: `Routed to ${department}`,
  };
}

function confirmIssue(issueCode, body) {
  const row = db.prepare('SELECT * FROM issues WHERE issue_code = ?').get(issueCode);
  if (!row) throw { status: 404, message: 'Issue not found.' };
  const voterId = body.voterId || crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    db.prepare(`INSERT INTO confirmations (issue_id, voter_id, created_at) VALUES (?,?,?)`).run(row.id, voterId, now);
  } catch (e) {
    throw { status: 409, message: 'You have already confirmed this issue.' };
  }
  const newConfirms = row.confirms + 1;
  const newPriority = computeScore(row.severity, newConfirms, daysBetween(row.created_at));
  db.prepare(`UPDATE issues SET confirms = ?, priority = ?, updated_at = ? WHERE id = ?`)
    .run(newConfirms, newPriority, now, row.id);
  return rowToIssue(db.prepare('SELECT * FROM issues WHERE id = ?').get(row.id));
}

const VALID_STATUSES = ['reported', 'ai_verified', 'assigned', 'in_progress', 'resolved'];
function updateStatus(issueCode, body) {
  if (!VALID_STATUSES.includes(body.status)) throw { status: 400, message: 'Invalid status.' };
  const row = db.prepare('SELECT * FROM issues WHERE issue_code = ?').get(issueCode);
  if (!row) throw { status: 404, message: 'Issue not found.' };
  const now = new Date().toISOString();
  db.prepare(`UPDATE issues SET status = ?, updated_at = ? WHERE id = ?`).run(body.status, now, row.id);
  return rowToIssue(db.prepare('SELECT * FROM issues WHERE id = ?').get(row.id));
}

function analytics() {
  const all = db.prepare('SELECT * FROM issues').all();
  const total = all.length;
  const resolved = all.filter((i) => i.status === 'resolved').length;
  const resolvedPct = total ? Math.round((resolved / total) * 100) : 0;
  const avgPriority = total ? Math.round(all.reduce((s, i) => s + i.priority, 0) / total) : 0;
  const highSeverityOpen = all.filter((i) => i.severity === 'high' && i.status !== 'resolved').length;

  const byCategory = {};
  Object.keys(DEPTS).forEach((c) => (byCategory[c] = 0));
  all.forEach((i) => { byCategory[i.category] = (byCategory[i.category] || 0) + 1; });

  const byWard = {};
  all.forEach((i) => { byWard[i.ward] = (byWard[i.ward] || 0) + 1; });
  const wards = Object.entries(byWard).sort((a, b) => b[1] - a[1]).map(([ward, count]) => ({ ward, count }));

  const byDept = {};
  all.forEach((i) => {
    byDept[i.department] = byDept[i.department] || { total: 0, resolved: 0 };
    byDept[i.department].total += 1;
    if (i.status === 'resolved') byDept[i.department].resolved += 1;
  });

  return { total, resolved, resolvedPct, avgPriority, highSeverityOpen, byCategory, wards, byDept };
}

/* ------------------------- Static file serving ------------------------- */

function serveStatic(req, res, pathname) {
  let filePath;
  if (pathname.startsWith('/uploads/')) {
    filePath = path.join(UPLOADS_DIR, pathname.replace('/uploads/', ''));
  } else {
    filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  }
  const resolved = path.resolve(filePath);
  const base = pathname.startsWith('/uploads/') ? UPLOADS_DIR : PUBLIC_DIR;
  if (!resolved.startsWith(path.resolve(base))) { send(res, 403, 'Forbidden'); return; }

  fs.readFile(resolved, (err, data) => {
    if (err) { send(res, 404, 'Not found'); return; }
    const ext = path.extname(resolved).toLowerCase();
    send(res, 200, data, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  });
}

/* ------------------------- Router ------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  if (req.method === 'OPTIONS') {
    return send(res, 204, '', {
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
  }

  try {
    if (pathname === '/api/issues' && req.method === 'GET') {
      const query = Object.fromEntries(url.searchParams);
      return sendJSON(res, 200, listIssues(query));
    }

    if (pathname === '/api/issues' && req.method === 'POST') {
      const body = await readJSON(req);
      const result = createIssue(body);
      return sendJSON(res, 201, result);
    }

    const confirmMatch = pathname.match(/^\/api\/issues\/([^/]+)\/confirm$/);
    if (confirmMatch && req.method === 'POST') {
      const body = await readJSON(req);
      return sendJSON(res, 200, confirmIssue(decodeURIComponent(confirmMatch[1]), body));
    }

    const statusMatch = pathname.match(/^\/api\/issues\/([^/]+)\/status$/);
    if (statusMatch && req.method === 'PATCH') {
      const body = await readJSON(req);
      return sendJSON(res, 200, updateStatus(decodeURIComponent(statusMatch[1]), body));
    }

    if (pathname === '/api/analytics' && req.method === 'GET') {
      return sendJSON(res, 200, analytics());
    }

    if (pathname === '/api/meta' && req.method === 'GET') {
      return sendJSON(res, 200, {
        departments: [...new Set(Object.values(DEPTS))],
        categories: Object.keys(DEPTS),
        wards: ['Ward 14 — Central Zone', 'Ward 7 — Riverside', 'Ward 22 — Sector Hills', 'Ward 3 — Old Town'],
        statuses: VALID_STATUSES,
      });
    }

    if (req.method === 'GET') return serveStatic(req, res, pathname);

    return sendJSON(res, 404, { error: 'Not found' });
  } catch (err) {
    const status = err.status || 500;
    return sendJSON(res, status, { error: err.message || 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`\n  CivicConnect running → http://localhost:${PORT}\n`);
});
