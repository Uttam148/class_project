// server.js — CivicConnect backend using Supabase

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const supabase = require('./db');
const {
  DEPTS,
  classify,
  detectSeverity,
  computeScore,
  daysBetween
} = require('./logic');

const PORT = process.env.PORT || 4000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const STORAGE_BUCKET = 'issue-photos';

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
};


/* ------------------------- Response helpers ------------------------- */

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    ...headers
  });

  res.end(body);
}

function sendJSON(res, status, obj) {
  send(res, status, JSON.stringify(obj), {
    'Content-Type': 'application/json'
  });
}


/* ------------------------- Request helpers ------------------------- */

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;

      if (size > 15 * 1024 * 1024) {
        req.destroy();
        reject(new Error('Payload too large'));
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    req.on('error', reject);
  });
}

async function readJSON(req) {
  const buf = await readBody(req);

  if (!buf.length) return {};

  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return {};
  }
}


/* ------------------------- Database helpers ------------------------- */

function rowToIssue(r) {
  let photoUrl = null;

  if (r.photo_path) {
    const { data } = supabase
      .storage
      .from(STORAGE_BUCKET)
      .getPublicUrl(r.photo_path);

    photoUrl = data.publicUrl;
  }

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
    photoUrl,
    aiConfidence: r.ai_confidence,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}


/* ------------------------- Issue code ------------------------- */

async function nextIssueCode() {
  const { data, error } = await supabase
    .from('issues')
    .select('issue_code')
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;

  if (!data) return 'CC-1001';

  const n = parseInt(data.issue_code.split('-')[1], 10) || 1000;

  return `CC-${n + 1}`;
}


/* ------------------------- Photo upload ------------------------- */

async function saveBase64Photo(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') {
    return null;
  }

  const match = dataUrl.match(
    /^data:image\/(png|jpeg|jpg|webp|gif);base64,(.+)$/
  );

  if (!match) {
    return null;
  }

  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];

  const contentType =
    ext === 'jpg'
      ? 'image/jpeg'
      : `image/${ext}`;

  const buf = Buffer.from(match[2], 'base64');

  // 8 MB limit
  if (buf.length > 8 * 1024 * 1024) {
    return null;
  }

  const filename =
    `${Date.now()}-${crypto.randomBytes(5).toString('hex')}.${ext}`;

  const storagePath = `issues/${filename}`;

  const { error } = await supabase
    .storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, buf, {
      contentType,
      upsert: false
    });

  if (error) {
    throw error;
  }

  return storagePath;
}


/* ------------------------- API handlers ------------------------- */

async function listIssues(query) {
  let request = supabase
    .from('issues')
    .select('*');

  if (query.department) {
    request = request.eq('department', query.department);
  }

  if (query.status) {
    request = request.eq('status', query.status);
  }

  if (query.ward) {
    request = request.eq('ward', query.ward);
  }

  request = request
    .order('priority', { ascending: false })
    .order('id', { ascending: false });

  const { data, error } = await request;

  if (error) throw error;

  return data.map(rowToIssue);
}


async function createIssue(body) {
  const description = (body.description || '').trim();

  if (!description) {
    throw {
      status: 400,
      message: 'Description is required.'
    };
  }

  const ward = body.ward || 'Ward 14 — Central Zone';

  const cls = classify(
    description,
    body.category || null
  );

  const severity = detectSeverity(description);

  const department = DEPTS[cls.category];


  /* ---------- Duplicate detection ---------- */

  const {
    data: dup,
    error: duplicateError
  } = await supabase
    .from('issues')
    .select('*')
    .eq('category', cls.category)
    .eq('ward', ward)
    .neq('status', 'resolved')
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (duplicateError) {
    throw duplicateError;
  }


  /* ---------- Photo ---------- */

  const photoPath = await saveBase64Photo(body.photo);

  const now = new Date().toISOString();


  /* ---------- Duplicate issue ---------- */

  if (dup) {
    const voterId =
      body.voterId || crypto.randomUUID();

    let confirmed = false;

    const { error } = await supabase
      .from('confirmations')
      .insert({
        issue_id: dup.id,
        voter_id: voterId,
        created_at: now
      });

    if (!error) {
      confirmed = true;
    } else if (error.code !== '23505') {
      throw error;
    }

    if (confirmed) {
      const newConfirms = dup.confirms + 1;

      const newPriority = computeScore(
        dup.severity,
        newConfirms,
        daysBetween(dup.created_at)
      );

      const { error: updateError } = await supabase
        .from('issues')
        .update({
          confirms: newConfirms,
          priority: newPriority,
          updated_at: now
        })
        .eq('id', dup.id);

      if (updateError) {
        throw updateError;
      }
    }

    const {
      data: updated,
      error: updatedError
    } = await supabase
      .from('issues')
      .select('*')
      .eq('id', dup.id)
      .single();

    if (updatedError) {
      throw updatedError;
    }

    return {
      issue: rowToIssue(updated),
      merged: true,
      pipeline: pipelineTrace(
        cls,
        severity,
        dup,
        department
      )
    };
  }


  /* ---------- New issue ---------- */

  const issueCode = await nextIssueCode();

  const priority = computeScore(
    severity,
    1,
    0
  );

  const { data: created, error: insertError } =
    await supabase
      .from('issues')
      .insert({
        issue_code: issueCode,
        category: cls.category,
        description,
        ward,
        severity,
        confirms: 1,
        priority,
        status: 'ai_verified',
        department,
        photo_path: photoPath,
        ai_confidence: cls.confidence,
        created_at: now,
        updated_at: now
      })
      .select('*')
      .single();

  if (insertError) {
    throw insertError;
  }

  return {
    issue: rowToIssue(created),
    merged: false,
    pipeline: pipelineTrace(
      cls,
      severity,
      null,
      department
    )
  };
}


/* ------------------------- Pipeline ------------------------- */

function pipelineTrace(
  cls,
  severity,
  dup,
  department
) {
  return {
    classification:
      `Detected "${cls.category}" · confidence ${(cls.confidence * 100).toFixed(0)}% · severity: ${severity.toUpperCase()}`,

    duplicate:
      dup
        ? `Matched existing report ${dup.issue_code} — merged as confirmation`
        : 'No matching open reports found — new issue created',

    routing:
      `Routed to ${department}`
  };
}


/* ------------------------- Confirm issue ------------------------- */

async function confirmIssue(issueCode, body) {
  const {
    data: row,
    error: findError
  } = await supabase
    .from('issues')
    .select('*')
    .eq('issue_code', issueCode)
    .maybeSingle();

  if (findError) {
    throw findError;
  }

  if (!row) {
    throw {
      status: 404,
      message: 'Issue not found.'
    };
  }

  const voterId =
    body.voterId || crypto.randomUUID();

  const now = new Date().toISOString();

  const { error } = await supabase
    .from('confirmations')
    .insert({
      issue_id: row.id,
      voter_id: voterId,
      created_at: now
    });

  if (error) {
    if (error.code === '23505') {
      throw {
        status: 409,
        message: 'You have already confirmed this issue.'
      };
    }

    throw error;
  }

  const newConfirms = row.confirms + 1;

  const newPriority = computeScore(
    row.severity,
    newConfirms,
    daysBetween(row.created_at)
  );

  const {
    data: updated,
    error: updateError
  } = await supabase
    .from('issues')
    .update({
      confirms: newConfirms,
      priority: newPriority,
      updated_at: now
    })
    .eq('id', row.id)
    .select('*')
    .single();

  if (updateError) {
    throw updateError;
  }

  return rowToIssue(updated);
}


/* ------------------------- Status ------------------------- */

const VALID_STATUSES = [
  'reported',
  'ai_verified',
  'assigned',
  'in_progress',
  'resolved'
];


async function updateStatus(issueCode, body) {
  if (!VALID_STATUSES.includes(body.status)) {
    throw {
      status: 400,
      message: 'Invalid status.'
    };
  }

  const {
    data: row,
    error: findError
  } = await supabase
    .from('issues')
    .select('*')
    .eq('issue_code', issueCode)
    .maybeSingle();

  if (findError) {
    throw findError;
  }

  if (!row) {
    throw {
      status: 404,
      message: 'Issue not found.'
    };
  }

  const now = new Date().toISOString();

  const {
    data: updated,
    error: updateError
  } = await supabase
    .from('issues')
    .update({
      status: body.status,
      updated_at: now
    })
    .eq('id', row.id)
    .select('*')
    .single();

  if (updateError) {
    throw updateError;
  }

  return rowToIssue(updated);
}


/* ------------------------- Analytics ------------------------- */

async function analytics() {
  const {
    data: all,
    error
  } = await supabase
    .from('issues')
    .select('*');

  if (error) {
    throw error;
  }

  const total = all.length;

  const resolved =
    all.filter(
      (i) => i.status === 'resolved'
    ).length;

  const resolvedPct =
    total
      ? Math.round((resolved / total) * 100)
      : 0;

  const avgPriority =
    total
      ? Math.round(
          all.reduce(
            (sum, i) => sum + i.priority,
            0
          ) / total
        )
      : 0;

  const highSeverityOpen =
    all.filter(
      (i) =>
        i.severity === 'high' &&
        i.status !== 'resolved'
    ).length;


  /* ---------- Category ---------- */

  const byCategory = {};

  Object.keys(DEPTS).forEach(
    (category) => {
      byCategory[category] = 0;
    }
  );

  all.forEach((i) => {
    byCategory[i.category] =
      (byCategory[i.category] || 0) + 1;
  });


  /* ---------- Ward ---------- */

  const byWard = {};

  all.forEach((i) => {
    byWard[i.ward] =
      (byWard[i.ward] || 0) + 1;
  });

  const wards =
    Object.entries(byWard)
      .sort((a, b) => b[1] - a[1])
      .map(([ward, count]) => ({
        ward,
        count
      }));


  /* ---------- Department ---------- */

  const byDept = {};

  all.forEach((i) => {
    byDept[i.department] =
      byDept[i.department] || {
        total: 0,
        resolved: 0
      };

    byDept[i.department].total += 1;

    if (i.status === 'resolved') {
      byDept[i.department].resolved += 1;
    }
  });


  return {
    total,
    resolved,
    resolvedPct,
    avgPriority,
    highSeverityOpen,
    byCategory,
    wards,
    byDept
  };
}


/* ------------------------- Demo seed data ------------------------- */

async function seedDemo() {
  const {
    count,
    error
  } = await supabase
    .from('issues')
    .select('id', {
      count: 'exact',
      head: true
    });

  if (error) {
    throw error;
  }

  if (count > 0) {
    return;
  }

  const now = Date.now();

  const daysAgo = (n) =>
    new Date(
      now - n * 86400000
    ).toISOString();

  const rows = [
    {
      issue_code: 'CC-1001',
      category: 'Pothole',
      description:
        'Deep pothole outside Ward 14 market, causing two-wheeler skids during rain.',
      ward: 'Ward 14 — Central Zone',
      severity: 'high',
      confirms: 6,
      priority: 87,
      status: 'in_progress',
      department: 'Roads & Infrastructure',
      photo_path: null,
      ai_confidence: 0.94,
      created_at: daysAgo(4),
      updated_at: daysAgo(1)
    },

    {
      issue_code: 'CC-1002',
      category: 'Garbage / Waste',
      description:
        'Garbage not collected for 5 days near Riverside community park.',
      ward: 'Ward 7 — Riverside',
      severity: 'medium',
      confirms: 3,
      priority: 58,
      status: 'assigned',
      department: 'Sanitation',
      photo_path: null,
      ai_confidence: 0.88,
      created_at: daysAgo(2),
      updated_at: daysAgo(1)
    },

    {
      issue_code: 'CC-1003',
      category: 'Streetlight',
      description:
        'Streetlight pole flickering and dark for the last week, unsafe at night.',
      ward: 'Ward 22 — Sector Hills',
      severity: 'medium',
      confirms: 2,
      priority: 41,
      status: 'reported',
      department: 'Electrical / Streetlighting',
      photo_path: null,
      ai_confidence: 0.81,
      created_at: daysAgo(1),
      updated_at: daysAgo(1)
    },

    {
      issue_code: 'CC-1004',
      category: 'Water Leakage',
      description:
        'Constant water leakage from a broken pipe joint, wasting water and flooding the lane.',
      ward: 'Ward 3 — Old Town',
      severity: 'high',
      confirms: 9,
      priority: 92,
      status: 'resolved',
      department: 'Water Supply & Sewage',
      photo_path: null,
      ai_confidence: 0.91,
      created_at: daysAgo(9),
      updated_at: daysAgo(2)
    }
  ];

  const { error: insertError } =
    await supabase
      .from('issues')
      .insert(rows);

  if (insertError) {
    throw insertError;
  }

  console.log('Seeded demo issues into Supabase.');
}


/* ------------------------- Static file serving ------------------------- */

function serveStatic(req, res, pathname) {
  const filePath = path.join(
    PUBLIC_DIR,
    pathname === '/'
      ? 'index.html'
      : pathname
  );

  const resolved = path.resolve(filePath);

  if (
    !resolved.startsWith(
      path.resolve(PUBLIC_DIR)
    )
  ) {
    send(res, 403, 'Forbidden');
    return;
  }

  fs.readFile(
    resolved,
    (err, data) => {
      if (err) {
        send(res, 404, 'Not found');
        return;
      }

      const ext =
        path.extname(resolved)
          .toLowerCase();

      send(
        res,
        200,
        data,
        {
          'Content-Type':
            MIME[ext] ||
            'application/octet-stream'
        }
      );
    }
  );
}


/* ------------------------- Router ------------------------- */

const server = http.createServer(
  async (req, res) => {

    const url = new URL(
      req.url,
      `http://${req.headers.host}`
    );

    const { pathname } = url;


    /* ---------- CORS ---------- */

    if (req.method === 'OPTIONS') {
      return send(
        res,
        204,
        '',
        {
          'Access-Control-Allow-Methods':
            'GET,POST,PATCH,OPTIONS',

          'Access-Control-Allow-Headers':
            'Content-Type'
        }
      );
    }


    try {

      /* ---------- Get issues ---------- */

      if (
        pathname === '/api/issues' &&
        req.method === 'GET'
      ) {
        const query =
          Object.fromEntries(
            url.searchParams
          );

        return sendJSON(
          res,
          200,
          await listIssues(query)
        );
      }


      /* ---------- Create issue ---------- */

      if (
        pathname === '/api/issues' &&
        req.method === 'POST'
      ) {
        const body =
          await readJSON(req);

        const result =
          await createIssue(body);

        return sendJSON(
          res,
          201,
          result
        );
      }


      /* ---------- Confirm issue ---------- */

      const confirmMatch =
        pathname.match(
          /^\/api\/issues\/([^/]+)\/confirm$/
        );

      if (
        confirmMatch &&
        req.method === 'POST'
      ) {
        const body =
          await readJSON(req);

        return sendJSON(
          res,
          200,
          await confirmIssue(
            decodeURIComponent(
              confirmMatch[1]
            ),
            body
          )
        );
      }


      /* ---------- Update status ---------- */

      const statusMatch =
        pathname.match(
          /^\/api\/issues\/([^/]+)\/status$/
        );

      if (
        statusMatch &&
        req.method === 'PATCH'
      ) {
        const body =
          await readJSON(req);

        return sendJSON(
          res,
          200,
          await updateStatus(
            decodeURIComponent(
              statusMatch[1]
            ),
            body
          )
        );
      }


      /* ---------- Analytics ---------- */

      if (
        pathname === '/api/analytics' &&
        req.method === 'GET'
      ) {
        return sendJSON(
          res,
          200,
          await analytics()
        );
      }


      /* ---------- Metadata ---------- */

      if (
        pathname === '/api/meta' &&
        req.method === 'GET'
      ) {
        return sendJSON(
          res,
          200,
          {
            departments: [
              ...new Set(
                Object.values(DEPTS)
              )
            ],

            categories:
              Object.keys(DEPTS),

            wards: [
              'Ward 14 — Central Zone',
              'Ward 7 — Riverside',
              'Ward 22 — Sector Hills',
              'Ward 3 — Old Town'
            ],

            statuses:
              VALID_STATUSES
          }
        );
      }


      /* ---------- Frontend ---------- */

      if (req.method === 'GET') {
        return serveStatic(
          req,
          res,
          pathname
        );
      }


      return sendJSON(
        res,
        404,
        {
          error: 'Not found'
        }
      );

    } catch (err) {

      console.error(
        'Server error:',
        err
      );

      const status =
        err.status || 500;

      return sendJSON(
        res,
        status,
        {
          error:
            err.message ||
            'Internal server error'
        }
      );
    }
  }
);


/* ------------------------- Start server ------------------------- */

async function startServer() {
  try {
    await seedDemo();

    server.listen(
      PORT,
      () => {
        console.log(
          `\n  CivicConnect running → http://localhost:${PORT}\n`
        );
      }
    );

  } catch (error) {
    console.error(
      'Failed to start CivicConnect:',
      error
    );

    process.exit(1);
  }
}

startServer();