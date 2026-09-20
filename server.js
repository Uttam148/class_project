// server.js — CivicConnect backend
// Node.js HTTP server + Supabase + Gemini AI

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

const { analyzeIssueImage } = require('./ai');

const PORT = process.env.PORT || 4000;

const PUBLIC_DIR = path.join(__dirname, 'public');

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


/* =========================================================
   RESPONSE HELPERS
========================================================= */

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    ...headers
  });

  res.end(body);
}


function sendJSON(res, status, obj) {
  send(
    res,
    status,
    JSON.stringify(obj),
    {
      'Content-Type': 'application/json'
    }
  );
}


/* =========================================================
   REQUEST BODY
========================================================= */

function readBody(req) {
  return new Promise((resolve, reject) => {

    const chunks = [];

    let size = 0;

    req.on('data', (chunk) => {

      size += chunk.length;

      if (size > 15 * 1024 * 1024) {
        req.destroy();

        reject(
          new Error('Payload too large')
        );

        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => {

      resolve(
        Buffer.concat(chunks)
      );

    });

    req.on('error', reject);
  });
}


async function readJSON(req) {

  const buffer = await readBody(req);

  if (!buffer.length) {
    return {};
  }

  try {

    return JSON.parse(
      buffer.toString('utf8')
    );

  } catch {

    return {};
  }
}


/* =========================================================
   ISSUE → API FORMAT
========================================================= */

function rowToIssue(row) {

  let photoUrl = null;

  if (row.photo_path) {

    const {
      data
    } = supabase
      .storage
      .from('issue-photos')
      .getPublicUrl(row.photo_path);

    photoUrl = data.publicUrl;
  }

  return {

    id: row.issue_code,

    dbId: row.id,

    category: row.category,

    description: row.description,

    ward: row.ward,

    severity: row.severity,

    confirms: row.confirms,

    priority: row.priority,

    status: row.status,

    department: row.department,

    photoUrl,

    aiConfidence: row.ai_confidence,

    createdAt: row.created_at,

    updatedAt: row.updated_at

  };
}


/* =========================================================
   ISSUE CODE
========================================================= */

async function nextIssueCode() {

  const {
    data,
    error
  } = await supabase
    .from('issues')
    .select('issue_code')
    .order('id', {
      ascending: false
    })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return 'CC-1001';
  }

  const number =
    parseInt(
      data.issue_code.split('-')[1],
      10
    ) || 1000;

  return `CC-${number + 1}`;
}


/* =========================================================
   PHOTO → SUPABASE STORAGE
========================================================= */

async function saveBase64Photo(dataUrl) {

  if (
    !dataUrl ||
    typeof dataUrl !== 'string'
  ) {
    return null;
  }

  const match = dataUrl.match(
    /^data:image\/(png|jpeg|jpg|webp|gif);base64,(.+)$/
  );

  if (!match) {
    return null;
  }

  const extension =
    match[1] === 'jpeg'
      ? 'jpg'
      : match[1];

  const buffer =
    Buffer.from(
      match[2],
      'base64'
    );

  if (
    buffer.length >
    8 * 1024 * 1024
  ) {
    return null;
  }

  const filename =
    `issues/${Date.now()}-${crypto
      .randomBytes(5)
      .toString('hex')}.${extension}`;

  const {
    error
  } = await supabase
    .storage
    .from('issue-photos')
    .upload(
      filename,
      buffer,
      {
        contentType:
          match[1] === 'jpg'
            ? 'image/jpeg'
            : `image/${match[1]}`,

        upsert: false
      }
    );

  if (error) {
    throw error;
  }

  return filename;
}


/* =========================================================
   LIST ISSUES
========================================================= */

async function listIssues(query) {

  let request =
    supabase
      .from('issues')
      .select('*');

  if (query.department) {

    request =
      request.eq(
        'department',
        query.department
      );
  }

  if (query.status) {

    request =
      request.eq(
        'status',
        query.status
      );
  }

  if (query.ward) {

    request =
      request.eq(
        'ward',
        query.ward
      );
  }

  const {
    data,
    error
  } = await request
    .order('priority', {
      ascending: false
    })
    .order('id', {
      ascending: false
    });

  if (error) {
    throw error;
  }

  return data.map(rowToIssue);
}


/* =========================================================
   CREATE ISSUE + GEMINI AI
========================================================= */

async function createIssue(body) {

  const description =
    (body.description || '').trim();


  if (!description) {

    throw {
      status: 400,
      message:
        'Description is required.'
    };
  }


  const ward =
    body.ward ||
    'Ward 14 — Central Zone';


  /* -------------------------------------------------------
     IMAGE REQUIRED
  ------------------------------------------------------- */

  if (
    !body.photo ||
    typeof body.photo !== 'string'
  ) {

    throw {
      status: 400,
      message:
        'A photo is required for AI verification.'
    };
  }


  /* -------------------------------------------------------
     EXTRACT IMAGE
  ------------------------------------------------------- */

  const imageMatch =
    body.photo.match(
      /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,(.+)$/
    );


  if (!imageMatch) {

    throw {
      status: 400,
      message:
        'Invalid image format.'
    };
  }


  const mimeType =
    imageMatch[1];


  const imageBuffer =
    Buffer.from(
      imageMatch[2],
      'base64'
    );


  if (
    imageBuffer.length >
    8 * 1024 * 1024
  ) {

    throw {
      status: 400,
      message:
        'Image must be smaller than 8MB.'
    };
  }


  /* -------------------------------------------------------
     GEMINI AI
  ------------------------------------------------------- */

  console.log(
    'Analyzing submitted image with Gemini...'
  );


  const aiResult =
    await analyzeIssueImage(
      imageBuffer,
      mimeType
    );


  console.log(
    'Gemini result:',
    aiResult
  );


  /* -------------------------------------------------------
     REJECT NON-CIVIC IMAGE
  ------------------------------------------------------- */

  if (
    aiResult.is_civic_issue !== true
  ) {

    throw {
      status: 422,

      message:
        'This image does not appear to show a genuine civic issue.',

      aiResult
    };
  }


  /* -------------------------------------------------------
     VALIDATE AI RESULT
  ------------------------------------------------------- */

  const validSeverities = [
    'Low',
    'Medium',
    'High',
    'Critical'
  ];


  const validConfidences = [
    'Low',
    'Medium',
    'High'
  ];


  if (
    !aiResult.category ||
    typeof aiResult.category !== 'string'
  ) {

    throw {
      status: 422,
      message:
        'AI could not determine a civic issue category.'
    };
  }


  if (
    !validSeverities.includes(
      aiResult.severity
    )
  ) {

    throw {
      status: 422,
      message:
        'AI returned an invalid severity.'
    };
  }


  if (
    !validConfidences.includes(
      aiResult.confidence
    )
  ) {

    throw {
      status: 422,
      message:
        'AI returned an invalid confidence level.'
    };
  }


  /* -------------------------------------------------------
     AI CATEGORY
  ------------------------------------------------------- */

  const category =
    aiResult.category;


  const severity =
    aiResult.severity.toLowerCase();


  /* -------------------------------------------------------
     AI CONFIDENCE → DATABASE NUMBER
  ------------------------------------------------------- */

  const confidenceMap = {

    Low: 0.50,

    Medium: 0.75,

    High: 0.95

  };


  const confidence =
    confidenceMap[
      aiResult.confidence
    ];


  /* -------------------------------------------------------
     DEPARTMENT
  ------------------------------------------------------- */

  let department =
    DEPTS[category];


  /*
   * If Gemini creates a new category such as:
   *
   * Open Manhole
   * Fallen Tree
   * Broken Traffic Signal
   *
   * try the existing classification system.
   */

  if (!department) {

    const fallbackClass =
      classify(
        aiResult.description ||
          description,
        category
      );


    department =
      DEPTS[
        fallbackClass.category
      ] ||
      'Municipal Services';
  }


  /* -------------------------------------------------------
     DUPLICATE DETECTION
  ------------------------------------------------------- */

  const {
    data: duplicate,
    error: duplicateError
  } = await supabase
    .from('issues')
    .select('*')
    .eq(
      'category',
      category
    )
    .eq(
      'ward',
      ward
    )
    .neq(
      'status',
      'resolved'
    )
    .order('id', {
      ascending: false
    })
    .limit(1)
    .maybeSingle();


  if (duplicateError) {
    throw duplicateError;
  }


  /* -------------------------------------------------------
     SAVE PHOTO
  ------------------------------------------------------- */

  const photoPath =
    await saveBase64Photo(
      body.photo
    );


  const now =
    new Date().toISOString();


  /* =======================================================
     DUPLICATE ISSUE
  ======================================================= */

  if (duplicate) {

    const voterId =
      body.voterId ||
      crypto.randomUUID();


    let confirmed = false;


    const {
      error
    } = await supabase
      .from('confirmations')
      .insert({

        issue_id:
          duplicate.id,

        voter_id:
          voterId,

        created_at:
          now

      });


    if (!error) {

      confirmed = true;

    } else if (
      error.code !== '23505'
    ) {

      throw error;
    }


    if (confirmed) {

      const newConfirms =
        duplicate.confirms + 1;


      const newPriority =
        computeScore(
          duplicate.severity,
          newConfirms,
          daysBetween(
            duplicate.created_at
          )
        );


      const {
        error: updateError
      } = await supabase
        .from('issues')
        .update({

          confirms:
            newConfirms,

          priority:
            newPriority,

          updated_at:
            now

        })
        .eq(
          'id',
          duplicate.id
        );


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
      .eq(
        'id',
        duplicate.id
      )
      .single();


    if (updatedError) {
      throw updatedError;
    }


    return {

      issue:
        rowToIssue(updated),

      merged:
        true,

      pipeline: {

        classification:
          `AI detected "${category}" · confidence ${aiResult.confidence} · severity: ${aiResult.severity.toUpperCase()}`,

        duplicate:
          `Matched existing report ${duplicate.issue_code} — merged as confirmation`,

        routing:
          `Routed to ${department}`

      }

    };
  }


  /* =======================================================
     NEW ISSUE
  ======================================================= */

  const issueCode =
    await nextIssueCode();


  const priority =
    computeScore(
      severity,
      1,
      0
    );


  const {
    data: created,
    error: insertError
  } = await supabase
    .from('issues')
    .insert({

      issue_code:
        issueCode,

      category:
        category,

      description:
        aiResult.description ||
        description,

      ward:
        ward,

      severity:
        severity,

      confirms:
        1,

      priority:
        priority,

      status:
        'ai_verified',

      department:
        department,

      photo_path:
        photoPath,

      ai_confidence:
        confidence,

      created_at:
        now,

      updated_at:
        now

    })
    .select('*')
    .single();


  if (insertError) {
    throw insertError;
  }


  return {

    issue:
      rowToIssue(created),

    merged:
      false,

    pipeline: {

      classification:
        `AI detected "${category}" · confidence ${aiResult.confidence} · severity: ${aiResult.severity.toUpperCase()}`,

      duplicate:
        'No matching open reports found — new issue created',

      routing:
        `Routed to ${department}`

    }

  };
}


/* =========================================================
   CONFIRM ISSUE
========================================================= */

async function confirmIssue(
  issueCode,
  body
) {

  const {
    data: row,
    error
  } = await supabase
    .from('issues')
    .select('*')
    .eq(
      'issue_code',
      issueCode
    )
    .single();


  if (error || !row) {

    throw {
      status: 404,
      message:
        'Issue not found.'
    };
  }


  const voterId =
    body.voterId ||
    crypto.randomUUID();


  const now =
    new Date().toISOString();


  const {
    error: confirmationError
  } = await supabase
    .from('confirmations')
    .insert({

      issue_id:
        row.id,

      voter_id:
        voterId,

      created_at:
        now

    });


  if (confirmationError) {

    if (
      confirmationError.code ===
      '23505'
    ) {

      throw {
        status: 409,
        message:
          'You have already confirmed this issue.'
      };
    }

    throw confirmationError;
  }


  const newConfirms =
    row.confirms + 1;


  const newPriority =
    computeScore(
      row.severity,
      newConfirms,
      daysBetween(
        row.created_at
      )
    );


  const {
    error: updateError
  } = await supabase
    .from('issues')
    .update({

      confirms:
        newConfirms,

      priority:
        newPriority,

      updated_at:
        now

    })
    .eq(
      'id',
      row.id
    );


  if (updateError) {
    throw updateError;
  }


  const {
    data: updated,
    error: updatedError
  } = await supabase
    .from('issues')
    .select('*')
    .eq(
      'id',
      row.id
    )
    .single();


  if (updatedError) {
    throw updatedError;
  }


  return rowToIssue(updated);
}


/* =========================================================
   STATUS
========================================================= */

const VALID_STATUSES = [
  'reported',
  'ai_verified',
  'assigned',
  'in_progress',
  'resolved'
];


async function updateStatus(
  issueCode,
  body
) {

  if (
    !VALID_STATUSES.includes(
      body.status
    )
  ) {

    throw {
      status: 400,
      message:
        'Invalid status.'
    };
  }


  const {
    data: row,
    error
  } = await supabase
    .from('issues')
    .select('*')
    .eq(
      'issue_code',
      issueCode
    )
    .single();


  if (error || !row) {

    throw {
      status: 404,
      message:
        'Issue not found.'
    };
  }


  const now =
    new Date().toISOString();


  const {
    error: updateError
  } = await supabase
    .from('issues')
    .update({

      status:
        body.status,

      updated_at:
        now

    })
    .eq(
      'id',
      row.id
    );


  if (updateError) {
    throw updateError;
  }


  const {
    data: updated,
    error: updatedError
  } = await supabase
    .from('issues')
    .select('*')
    .eq(
      'id',
      row.id
    )
    .single();


  if (updatedError) {
    throw updatedError;
  }


  return rowToIssue(updated);
}


/* =========================================================
   ANALYTICS
========================================================= */

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


  const total =
    all.length;


  const resolved =
    all.filter(
      issue =>
        issue.status ===
        'resolved'
    ).length;


  const resolvedPct =
    total
      ? Math.round(
          (resolved / total) * 100
        )
      : 0;


  const avgPriority =
    total
      ? Math.round(
          all.reduce(
            (sum, issue) =>
              sum + issue.priority,
            0
          ) / total
        )
      : 0;


  const highSeverityOpen =
    all.filter(
      issue =>
        issue.severity === 'high' &&
        issue.status !== 'resolved'
    ).length;


  const byCategory = {};


  all.forEach(issue => {

    byCategory[
      issue.category
    ] =
      (
        byCategory[
          issue.category
        ] || 0
      ) + 1;

  });


  const byWard = {};


  all.forEach(issue => {

    byWard[
      issue.ward
    ] =
      (
        byWard[
          issue.ward
        ] || 0
      ) + 1;

  });


  const wards =
    Object.entries(
      byWard
    )
      .sort(
        (a, b) =>
          b[1] - a[1]
      )
      .map(
        ([ward, count]) => ({
          ward,
          count
        })
      );


  const byDept = {};


  all.forEach(issue => {

    if (
      !byDept[
        issue.department
      ]
    ) {

      byDept[
        issue.department
      ] = {
        total: 0,
        resolved: 0
      };
    }


    byDept[
      issue.department
    ].total += 1;


    if (
      issue.status ===
      'resolved'
    ) {

      byDept[
        issue.department
      ].resolved += 1;

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


/* =========================================================
   STATIC FILE SERVING
========================================================= */

function serveStatic(
  req,
  res,
  pathname
) {

  let filePath;


  if (
    pathname.startsWith('/uploads/')
  ) {

    return send(
      res,
      404,
      'Not found'
    );
  }


  filePath =
    path.join(
      PUBLIC_DIR,
      pathname === '/'
        ? 'index.html'
        : pathname
    );


  const resolved =
    path.resolve(filePath);


  if (
    !resolved.startsWith(
      path.resolve(
        PUBLIC_DIR
      )
    )
  ) {

    return send(
      res,
      403,
      'Forbidden'
    );
  }


  fs.readFile(
    resolved,
    (error, data) => {

      if (error) {

        return send(
          res,
          404,
          'Not found'
        );
      }


      const extension =
        path
          .extname(resolved)
          .toLowerCase();


      send(
        res,
        200,
        data,
        {
          'Content-Type':
            MIME[
              extension
            ] ||
            'application/octet-stream'
        }
      );

    }
  );
}


/* =========================================================
   ROUTER
========================================================= */

const server =
  http.createServer(
    async (req, res) => {

      const url =
        new URL(
          req.url,
          `http://${req.headers.host}`
        );


      const {
        pathname
      } = url;


      /* ---------- CORS ---------- */

      if (
        req.method ===
        'OPTIONS'
      ) {

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

        /* ---------- GET ISSUES ---------- */

        if (
          pathname ===
            '/api/issues' &&
          req.method ===
            'GET'
        ) {

          const query =
            Object.fromEntries(
              url.searchParams
            );


          const result =
            await listIssues(
              query
            );


          return sendJSON(
            res,
            200,
            result
          );
        }


        /* ---------- CREATE ISSUE ---------- */

        if (
          pathname ===
            '/api/issues' &&
          req.method ===
            'POST'
        ) {

          const body =
            await readJSON(req);


          const result =
            await createIssue(
              body
            );


          return sendJSON(
            res,
            201,
            result
          );
        }


        /* ---------- CONFIRM ---------- */

        const confirmMatch =
          pathname.match(
            /^\/api\/issues\/([^/]+)\/confirm$/
          );


        if (
          confirmMatch &&
          req.method ===
            'POST'
        ) {

          const body =
            await readJSON(req);


          const result =
            await confirmIssue(
              decodeURIComponent(
                confirmMatch[1]
              ),
              body
            );


          return sendJSON(
            res,
            200,
            result
          );
        }


        /* ---------- STATUS ---------- */

        const statusMatch =
          pathname.match(
            /^\/api\/issues\/([^/]+)\/status$/
          );


        if (
          statusMatch &&
          req.method ===
            'PATCH'
        ) {

          const body =
            await readJSON(req);


          const result =
            await updateStatus(
              decodeURIComponent(
                statusMatch[1]
              ),
              body
            );


          return sendJSON(
            res,
            200,
            result
          );
        }


        /* ---------- ANALYTICS ---------- */

        if (
          pathname ===
            '/api/analytics' &&
          req.method ===
            'GET'
        ) {

          const result =
            await analytics();


          return sendJSON(
            res,
            200,
            result
          );
        }


        /* ---------- META ---------- */

        if (
          pathname ===
            '/api/meta' &&
          req.method ===
            'GET'
        ) {

          return sendJSON(
            res,
            200,
            {

              departments:
                [
                  ...new Set(
                    Object.values(
                      DEPTS
                    )
                  )
                ],

              categories:
                Object.keys(
                  DEPTS
                ),

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


        /* ---------- STATIC ---------- */

        if (
          req.method ===
          'GET'
        ) {

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
            error:
              'Not found'
          }
        );

      } catch (error) {

        console.error(
          'Request error:',
          error
        );


        const status =
          error.status || 500;


        return sendJSON(
          res,
          status,
          {

            error:
              error.message ||
              'Internal server error',

            ...(error.aiResult
              ? {
                  aiResult:
                    error.aiResult
                }
              : {})

          }
        );
      }

    }
  );


/* =========================================================
   START SERVER
========================================================= */

server.listen(
  PORT,
  () => {

    console.log(
      `\nCivicConnect running → http://localhost:${PORT}\n`
    );

  }
);