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
   LOCATION NAME (coordinates → place name)
========================================================= */

// The citizen's GPS fix is turned into a human-readable place name
// ("Locality, City") that is stored in the existing `ward` column. Reusing the
// column means duplicate detection, the ?ward= filter and the Hotspot analytics
// all keep working with no database migration.

// Public OpenStreetMap Nominatim by default. Its usage policy asks for an
// identifying User-Agent, at most 1 request per second, and caching of results;
// all three are handled below. The URL and User-Agent can be overridden from the
// environment (e.g. to point at another Nominatim-compatible provider).
const GEOCODER_URL =
  process.env.GEOCODER_URL || 'https://nominatim.openstreetmap.org/reverse';

const GEOCODER_USER_AGENT =
  process.env.GEOCODER_USER_AGENT ||
  'CivicConnect/1.0 (https://class-project-vi2a.onrender.com)';

const GEOCODER_TIMEOUT_MS = 5000;        // give up on a slow lookup; the citizen can type the name instead
const GEOCODER_MIN_INTERVAL_MS = 1100;   // just over 1 s between outbound calls keeps us inside the 1 req/s policy
const GEOCODER_MAX_WAIT_MS = 4000;       // if the queue is longer than this, fail fast instead of piling up
const GEOCODE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const GEOCODE_CACHE_MAX_ENTRIES = 500;   // bounds memory use
const LOCATION_NAME_MAX_LENGTH = 80;     // also protects us if the `ward` column is a short varchar

// "lat,lng" (rounded) -> { name, expires }. A Map iterates in insertion order,
// which gives cheap oldest-first eviction.
const geocodeCache = new Map();

// Epoch ms at which the next outbound geocoder request may be sent.
let nextGeocoderSlot = 0;


// Cleans a place name that came from the browser or from the geocoder.
// It is later rendered into HTML, so control characters and angle brackets are
// dropped here as a second line of defence (the frontend escapes it as well).
function sanitizeLocationName(value) {
  if (typeof value !== 'string') return '';

  return value
    .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LOCATION_NAME_MAX_LENGTH);
}


// Parses and range-checks a latitude/longitude pair (strings from a query
// string, or numbers). Returns { lat, lng }, or null if either value is
// missing, non-numeric or out of range.
function parseCoordinates(latRaw, lngRaw) {
  const isBlank = (v) => v === null || v === undefined || v === '';

  // Number(null) and Number('') are both 0, which would silently turn a missing
  // value into the real coordinate 0,0 - so reject blanks explicitly first.
  if (isBlank(latRaw) || isBlank(lngRaw)) return null;

  const lat = Number(latRaw);
  const lng = Number(lngRaw);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

  return { lat, lng };
}


// Builds "Locality, City" from a Nominatim result. Address fields differ a lot
// between places, so take the most local name that exists, then the settlement
// it belongs to, and skip whatever is missing.
function pickPlaceName(result) {
  const address = (result && result.address) || {};

  const locality =
    address.neighbourhood || address.suburb || address.city_district ||
    address.quarter || address.hamlet || address.village;

  const settlement =
    address.city || address.town || address.municipality ||
    address.county || address.state_district;

  // De-duplicate so a place that is both locality and city doesn't read "Delhi, Delhi".
  const parts = [locality, settlement].filter(
    (part, i, all) => part && all.indexOf(part) === i
  );

  if (parts.length) return parts.join(', ');

  // Last resort: the first two segments of the formatted address.
  if (result && typeof result.display_name === 'string') {
    return result.display_name
      .split(',')
      .slice(0, 2)
      .map((segment) => segment.trim())
      .filter(Boolean)
      .join(', ');
  }

  return null;
}


// Reserves the next outbound slot so calls are spaced by GEOCODER_MIN_INTERVAL_MS.
// Returns false (without reserving) when the wait would exceed GEOCODER_MAX_WAIT_MS.
// Node runs this synchronously, so two callers can never claim the same slot.
async function waitForGeocoderSlot() {
  const now = Date.now();
  const slot = Math.max(now, nextGeocoderSlot);

  if (slot - now > GEOCODER_MAX_WAIT_MS) return false;

  nextGeocoderSlot = slot + GEOCODER_MIN_INTERVAL_MS;

  if (slot > now) {
    await new Promise((resolve) => setTimeout(resolve, slot - now));
  }

  return true;
}


// Looks up the place name for a coordinate. Never throws: returns null when the
// lookup fails, times out, is rate-limited or finds nothing, so the caller can
// let the citizen type the area instead of blocking the report.
async function reverseGeocode(lat, lng) {
  // ~3 decimals is roughly 100 m, plenty for a locality-level name, and it lets
  // nearby reports share one cached lookup (which the usage policy asks for).
  const cacheKey = `${lat.toFixed(3)},${lng.toFixed(3)}`;

  const cached = geocodeCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.name;

  try {
    if (!(await waitForGeocoderSlot())) return null;

    const url = new URL(GEOCODER_URL);
    url.search = new URLSearchParams({
      format: 'jsonv2',
      lat: String(lat),
      lon: String(lng),
      zoom: '14',              // neighbourhood level: avoids street/building names, which would make the same area look different on every report
      addressdetails: '1',
      'accept-language': 'en'
    }).toString();

    const response = await fetch(url, {
      headers: { 'User-Agent': GEOCODER_USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(GEOCODER_TIMEOUT_MS)
    });

    if (!response.ok) {
      throw new Error(`Geocoder responded with HTTP ${response.status}`);
    }

    const name = sanitizeLocationName(pickPlaceName(await response.json()));
    if (!name) return null;

    // Evict the oldest entry once full, then remember this result.
    if (geocodeCache.size >= GEOCODE_CACHE_MAX_ENTRIES) {
      geocodeCache.delete(geocodeCache.keys().next().value);
    }
    geocodeCache.set(cacheKey, { name, expires: Date.now() + GEOCODE_CACHE_TTL_MS });

    return name;

  } catch (error) {
    console.error('Reverse geocoding failed:', error.message);
    return null;
  }
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

async function createIssue(body, user) {

  const description =
    (body.description || '').trim();


  if (!description) {

    throw {
      status: 400,
      message:
        'Description is required.'
    };
  }


  // Location: the place name shown in the form. It is auto-filled from the
  // citizen's coordinates via GET /api/geocode and can be edited or typed by
  // hand. It is stored in the existing `ward` column so duplicate detection,
  // filtering and analytics keep working unchanged. `body.ward` is still
  // accepted so older clients don't break. Checked here, before the photo and
  // Gemini work, so a missing location doesn't cost an AI call.
  const ward = sanitizeLocationName(
    body.location !== undefined ? body.location : body.ward
  );

  if (!ward) {
    throw {
      status: 400,
      message:
        'Location is required: use "Use current location" or type the area name.'
    };
  }


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

    // The voter is the signed-in account, never a client-supplied id, so nobody can
    // confirm the same issue repeatedly by inventing new ids.
    const voterId = user.id;


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

      // Who filed the report (accountability and spam tracing). Never returned by the API.
      reporter_id:
        user.id,

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
  user
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


  // The voter is the signed-in account, never a client-supplied id, so nobody can
  // confirm the same issue repeatedly by inventing new ids.
  const voterId = user.id;


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
   AUTHENTICATION (Supabase Auth)
========================================================= */

// Accounts live in Supabase Auth. The browser signs people in directly using the
// *publishable* key (designed to be public; it can only do what Row Level
// Security allows) and then sends the resulting access token with each API call:
//     Authorization: Bearer <access token>
// This server never trusts anything the browser claims about the user. It asks
// Supabase Auth to validate the token and reads identity, email verification and
// role from Supabase's answer.

const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || '';

if (!SUPABASE_PUBLISHABLE_KEY) {
  console.warn(
    'SUPABASE_PUBLISHABLE_KEY is not set, so nobody can sign in yet. ' +
    'See README, "Accounts and sign-in".'
  );
}

// The browser build of the Supabase client. It is served from node_modules (the
// package is already installed for this server) so the browser and the server use
// the same version and there is no third-party CDN to depend on.
const SUPABASE_BROWSER_BUNDLE = path.join(
  __dirname, 'node_modules', '@supabase', 'supabase-js', 'dist', 'umd', 'supabase.js'
);

function serveSupabaseBundle(res) {
  fs.readFile(SUPABASE_BROWSER_BUNDLE, (error, data) => {
    if (error) {
      return sendJSON(res, 404, { error: 'Supabase browser bundle not found. Run "npm install".' });
    }

    send(res, 200, data, {
      'Content-Type': 'application/javascript',
      'Cache-Control': 'public, max-age=86400'
    });
  });
}


// Validates the request's bearer token and returns who is calling:
//   { id, email, role: 'citizen' | 'authority', emailVerified: true }
// Throws 401 (no/invalid/expired token), 403 (email not verified) or 503
// (Supabase Auth unreachable). What the caller may DO is decided by the route.
async function authenticate(req) {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(req.headers['authorization'] || '');

  if (!match) {
    throw { status: 401, message: 'Sign in to continue.' };
  }

  const { data, error } = await supabase.auth.getUser(match[1]);

  if (error || !data || !data.user) {
    // 4xx from Supabase means the token itself is bad. Anything else (network
    // failure, 5xx) is not the caller's fault; answering 503 instead of 401 keeps
    // the browser from signing someone out just because Supabase had a bad moment.
    const tokenRejected = error && error.status >= 400 && error.status < 500;

    throw tokenRejected || !error
      ? { status: 401, message: 'Your session has expired. Please sign in again.' }
      : { status: 503, message: 'The sign-in service is unavailable right now. Please try again in a moment.' };
  }

  const user = data.user;

  // Supabase sets email_confirmed_at only after the person opened the link that
  // was emailed to them, which is what proves they control the address. It is
  // checked here as well as in the Supabase dashboard so "verified" cannot be
  // skipped by calling the API directly.
  if (!user.email_confirmed_at) {
    throw {
      status: 403,
      code: 'EMAIL_NOT_VERIFIED',
      message: 'Verify your email address first: open the link we emailed you, then sign in again.'
    };
  }

  // Roles live in app_metadata, which only the project owner can edit. (Do NOT
  // use user_metadata for this: signed-in users can change their own.)
  const role = user.app_metadata && user.app_metadata.role === 'authority'
    ? 'authority'
    : 'citizen';

  return { id: user.id, email: user.email, role, emailVerified: true };
}


// Guards actions that only city staff may perform.
function requireAuthority(user) {
  if (user.role !== 'authority') {
    throw {
      status: 403,
      message: "Only authority accounts can change an issue's status."
    };
  }
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
              'Content-Type, Authorization'
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

          // Signed-in, email-verified accounts only (401/403 otherwise).
          const user = await authenticate(req);

          const body = await readJSON(req);

          const result = await createIssue(body, user);


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

          const user = await authenticate(req);

          const result = await confirmIssue(
            decodeURIComponent(confirmMatch[1]),
            user
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

          // Only authority accounts may move an issue through the workflow.
          const user = await authenticate(req);
          requireAuthority(user);

          const body = await readJSON(req);

          const result = await updateStatus(
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

              statuses:
                VALID_STATUSES

            }
          );
        }


        /* ---------- GEOCODE (coordinates → place name) ---------- */

        // The form calls this right after the browser captures a GPS fix, so the
        // citizen sees (and can correct) the area name before submitting.
        // Responds { name } - name is null when nothing could be resolved.
        if (
          pathname === '/api/geocode' &&
          req.method === 'GET'
        ) {

          // Sign-in required: every lookup costs an outbound geocoder call, so anonymous
          // visitors must not be able to trigger them.
          await authenticate(req);

          const coords = parseCoordinates(
            url.searchParams.get('lat'),
            url.searchParams.get('lng')
          );

          if (!coords) {
            throw {
              status: 400,
              message: 'Valid "lat" and "lng" query parameters are required.'
            };
          }

          const name = await reverseGeocode(coords.lat, coords.lng);

          return sendJSON(res, 200, { name });
        }


        /* ---------- CONFIG (public, browser-safe values only) ---------- */

        // The browser needs the project URL and the publishable key to sign
        // people in. Both are meant to be public; the SECRET key never leaves the server.
        if (
          pathname === '/api/config' &&
          req.method === 'GET'
        ) {

          return send(
            res,
            200,
            JSON.stringify({
              supabaseUrl: process.env.SUPABASE_URL || null,
              supabasePublishableKey: SUPABASE_PUBLISHABLE_KEY || null
            }),
            {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store'
            }
          );
        }


        /* ---------- SUPABASE BROWSER BUNDLE ---------- */

        if (
          pathname === '/vendor/supabase.js' &&
          req.method === 'GET'
        ) {
          return serveSupabaseBundle(res);
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

            // Only errors we threw ourselves (they carry a status) expose a code; raw
            // database errors have their own codes that should stay server-side.
            ...(error.status && typeof error.code === 'string'
              ? { code: error.code }
              : {}),

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