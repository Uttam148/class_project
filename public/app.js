// app.js — frontend for CivicConnect, talks to the real backend at /api/*

const TRACK_STEPS = ['reported', 'ai_verified', 'assigned', 'in_progress', 'resolved'];
const TRACK_LABELS = { reported: 'Reported', ai_verified: 'AI Verified', assigned: 'Assigned', in_progress: 'In Progress', resolved: 'Resolved' };

let META = { departments: [], categories: [], statuses: [] };
let currentPhotoDataUrl = null;

// Persistent per-browser voter id so a citizen can't confirm the same issue twice
function getVoterId() {
  let id = localStorage.getItem('civicconnect_voter_id');
  if (!id) {
    id = 'voter-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('civicconnect_voter_id', id);
  }
  return id;
}
function getConfirmedSet() {
  try { return new Set(JSON.parse(localStorage.getItem('civicconnect_confirmed') || '[]')); }
  catch { return new Set(); }
}
function addConfirmed(issueId) {
  const s = getConfirmedSet(); s.add(issueId);
  localStorage.setItem('civicconnect_confirmed', JSON.stringify([...s]));
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

/* ---------------- Init / view switching ---------------- */
document.querySelectorAll('nav.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav.tabs button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    document.getElementById('view-' + btn.dataset.view).classList.add('active');
    if (btn.dataset.view === 'authority') renderAuthority();
    if (btn.dataset.view === 'analytics') renderAnalytics();
  });
});

async function loadMeta() {
  META = await api('/api/meta');
  const catSel = document.getElementById('inCategory');
  META.categories.forEach((c) => catSel.insertAdjacentHTML('beforeend', `<option>${c}</option>`));
  const filterDept = document.getElementById('filterDept');
  META.departments.forEach((d) => filterDept.insertAdjacentHTML('beforeend', `<option>${d}</option>`));
  const filterStatus = document.getElementById('filterStatus');
  META.statuses.forEach((s) => filterStatus.insertAdjacentHTML('beforeend', `<option value="${s}">${TRACK_LABELS[s]}</option>`));
}

/* ---------------- Photo attach ---------------- */
document.getElementById('fileDrop').addEventListener('click', () => document.getElementById('fileInput').click());
document.getElementById('fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    currentPhotoDataUrl = reader.result;
    const drop = document.getElementById('fileDrop');
    drop.classList.add('has-file');
    drop.innerHTML = `<img src="${currentPhotoDataUrl}" alt="attached"><div style="margin-top:6px;">✅ ${file.name}</div>`;
  };
  reader.readAsDataURL(file);
});

/* ---------------- Locate ---------------- */

// Formats a signed decimal-degree value with the correct compass letter.
// Why: the old code hard-coded "N" and "E", which mislabels every position in
// the southern or western hemisphere. The sign of the number already says which
// side of the equator / prime meridian we are on, so derive the letter from it.
// 5 decimals is roughly 1 m, about the finest detail a GPS fix can resolve.
function formatCoord(value, positiveLetter, negativeLetter) {
  const letter = value >= 0 ? positiveLetter : negativeLetter;
  return `${Math.abs(value).toFixed(5)}° ${letter}`;
}

// Turns a GeolocationPositionError into a message the citizen can act on.
// Why: previously every failure silently displayed a made-up "captured"
// coordinate, so a report could look located when it was not. Telling the truth
// about why the fix failed lets the user remove the cause (permission, GPS off,
// weak signal) instead of submitting with a fake location.
function describeLocationError(err) {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return 'Location access is blocked. Allow it for this site in your browser settings, then try again.';
    case err.POSITION_UNAVAILABLE:
      return 'Your device could not work out its position. Turn on GPS / location services and try again.';
    case err.TIMEOUT:
      return 'Getting your location took too long. Try again, ideally with a clear view of the sky.';
    default:
      return 'Could not get your location. Please try again.';
  }
}

// Shows a failure in the location tag.
// Why: the tag's stylesheet colour (green) means "success" in this UI, so a
// failure is switched to the theme's error colour (--clay); otherwise an error
// message would look like a successful capture.
function showLocationError(tag, message) {
  tag.style.color = 'var(--clay)';
  tag.textContent = `⚠️ ${message}`;
}

// Default hint shown in the empty location field; restored after each report.
const LOCATION_PLACEHOLDER = 'Filled from your location, or type it';

// Identifies the newest lookup. A slow answer for an older fix must not
// overwrite the result of a newer one, so every response checks it is still current.
let areaLookupId = 0;

// Asks the server which place the coordinates point to and puts the answer in
// the editable location field. The server does the lookup (not the browser) so
// the geocoder's rate limit, caching and User-Agent policy are enforced in one place.
async function lookUpAreaName(latitude, longitude) {
  const input = document.getElementById('inLocation');
  const lookupId = ++areaLookupId;

  // Drop the previous name: it belongs to an earlier position and would be wrong
  // if this lookup fails. (This only runs after a successful GPS fix, so a denied
  // permission never wipes what the citizen typed.)
  input.value = '';
  input.placeholder = 'Looking up area name…';

  try {
    const { name } = await api(`/api/geocode?lat=${latitude}&lng=${longitude}`);
    if (lookupId !== areaLookupId) return; // superseded by a newer click

    if (name) {
      input.value = name;
      input.placeholder = LOCATION_PLACEHOLDER;
      return;
    }
  } catch (err) {
    if (lookupId !== areaLookupId) return;
  }

  // No name (nothing found, geocoder down, or the request failed): say so and let
  // the citizen type it rather than blocking the report.
  input.placeholder = 'Type the area name';
  showToast('Could not find the area name for your location. Please type it.');
}

// Clears the location UI after a report is sent so the next report cannot
// accidentally reuse a place the citizen has since left.
function resetLocationFields() {
  areaLookupId++; // cancel any lookup still in flight

  const input = document.getElementById('inLocation');
  input.value = '';
  input.placeholder = LOCATION_PLACEHOLDER;

  const tag = document.getElementById('locTag');
  tag.style.display = 'none';
  tag.style.color = '';
  tag.textContent = '';
}

document.getElementById('btnLocate').addEventListener('click', function () {
  const tag = document.getElementById('locTag');
  tag.style.display = 'block';
  tag.style.color = ''; // clear the error colour left behind by a previous failed attempt
  areaLookupId++;       // a new attempt makes any lookup still running for the old fix obsolete
  // If that abandoned lookup was mid-flight the field may still say "Looking up…" and nobody
  // will update it any more, so put the normal hint back (a successful new fix replaces it again).
  document.getElementById('inLocation').placeholder = LOCATION_PLACEHOLDER;
  tag.textContent = 'Locating…';

  // Browsers only expose geolocation on secure origins (HTTPS or localhost).
  // On plain http:// (for example, testing from a phone via the PC's LAN
  // address) the request is refused with a misleading "permission denied", so
  // detect it up front and give the real reason.
  if (!window.isSecureContext) {
    showLocationError(tag, 'Location needs a secure connection (HTTPS or localhost). Open the site over HTTPS.');
    return;
  }

  // Very old browsers have no Geolocation API at all.
  if (!navigator.geolocation) {
    showLocationError(tag, 'This browser does not support location access.');
    return;
  }

  navigator.geolocation.getCurrentPosition(
    // Success: display the fix exactly as the device reported it.
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      tag.textContent = `📍 Captured: ${formatCoord(latitude, 'N', 'S')}, ${formatCoord(longitude, 'E', 'W')} (±${Math.round(accuracy)}m)`;
      lookUpAreaName(latitude, longitude); // fills the editable area-name field
    },
    // Failure: report why it failed; never substitute a stored coordinate.
    (err) => showLocationError(tag, describeLocationError(err)),
    {
      enableHighAccuracy: true, // ask for GPS rather than a coarse Wi-Fi/IP-based guess
      timeout: 15000,           // a GPS cold start can exceed the old 4 s limit, which used to trigger the fake fallback
      maximumAge: 0             // never reuse a cached position; we want where the user is right now
    }
  );
});

/* ---------------- Submit ---------------- */
document.getElementById('btnSubmit').addEventListener('click', async () => {
  const description = document.getElementById('inDesc').value.trim();
  const category = document.getElementById('inCategory').value;
  const locationName = document.getElementById('inLocation').value.trim();
  if (!description) { showToast('Please describe the issue first.'); return; }
  // A report without a place cannot be acted on, so require one (auto-filled from the GPS fix, or typed).
  if (!locationName) {
    showToast('Please tap "Use current location" or type the area name.');
    document.getElementById('inLocation').focus();
    return;
  }

  const btn = document.getElementById('btnSubmit');
  btn.disabled = true; btn.textContent = 'Processing…';
  const pipeline = document.getElementById('pipeline');
  pipeline.style.display = 'block';
  document.querySelectorAll('.pstep').forEach((s) => s.classList.remove('active', 'done'));
  ['p1res', 'p2res', 'p3res', 'p4res'].forEach((id) => (document.getElementById(id).textContent = '—'));

  try {
    const result = await api('/api/issues', {
      method: 'POST',
      body: JSON.stringify({ description, category, location: locationName, photo: currentPhotoDataUrl, voterId: getVoterId() }),
    });

    await animateStep(1, result.pipeline.classification);
    await animateStep(2, result.pipeline.duplicate);
    await animateStep(3, `Score: ${result.issue.priority}/99 — factors: severity, confirmations, duration, impact`);
    await animateStep(4, result.pipeline.routing);

    if (result.merged) addConfirmed(result.issue.id);
    showToast(result.merged ? `Report merged into ${result.issue.id} — priority updated.` : `Report ${result.issue.id} submitted and saved to database.`);

    document.getElementById('inDesc').value = '';
    currentPhotoDataUrl = null;
    const drop = document.getElementById('fileDrop');
    drop.classList.remove('has-file');
    drop.innerHTML = '📷 Tap to attach photo';
    document.getElementById('fileInput').value = '';
    resetLocationFields();

    await renderFeed();
  } catch (err) {
    showToast('Error: ' + err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Submit Report';
  }
});

function animateStep(n, text) {
  return new Promise((resolve) => {
    const step = document.querySelector(`.pstep[data-step="${n}"]`);
    step.classList.add('active');
    document.getElementById('p' + n + 'res').textContent = text;
    setTimeout(() => { step.classList.remove('active'); step.classList.add('done'); resolve(); }, 550);
  });
}

/* ---------------- Citizen feed ---------------- */
async function renderFeed() {
  const el = document.getElementById('issueFeed');
  const issues = await api('/api/issues');
  if (issues.length === 0) { el.innerHTML = '<div class="empty">No reports yet — submit the first one.</div>'; return; }
  const confirmed = getConfirmedSet();
  el.innerHTML = issues.map((issue) => {
    const stepIdx = TRACK_STEPS.indexOf(issue.status);
    const track = TRACK_STEPS.map((s, i) => `
      <div class="tstep ${i <= stepIdx ? 'on' : ''}">
        <div class="tline"></div>
        <div class="tdot"></div>
        <div class="tlabel">${TRACK_LABELS[s]}</div>
      </div>`).join('');
    const voted = confirmed.has(issue.id);
    return `
    <div class="issue">
      <div class="issue-top">
        <div>
          <div class="issue-cat">${issue.category}</div>
          <div class="issue-id">${issue.id} · ${escapeHtml(issue.ward)}</div>
        </div>
        <span class="stamp ${issue.status}">${TRACK_LABELS[issue.status]}</span>
      </div>
      <div class="issue-desc">${escapeHtml(issue.description)}</div>
      ${issue.photoUrl ? `<img class="issue-photo" src="${issue.photoUrl}" alt="evidence">` : ''}
      <div class="issue-meta">
        <span class="sev ${issue.severity}"><span class="bar"></span><span class="bar"></span><span class="bar"></span>${issue.severity}</span>
        <span class="mono">Priority ${issue.priority}</span>
        <span class="dept-pill">${issue.department}</span>
        <button class="upvote ${voted ? 'voted' : ''}" data-id="${issue.id}" ${voted ? 'disabled' : ''}>
          ${voted ? '✓ Confirmed' : '👍 Confirm (' + issue.confirms + ')'}
        </button>
      </div>
      <div class="track">${track}</div>
    </div>`;
  }).join('');

  el.querySelectorAll('.upvote:not(.voted)').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const updated = await api(`/api/issues/${encodeURIComponent(btn.dataset.id)}/confirm`, {
          method: 'POST', body: JSON.stringify({ voterId: getVoterId() }),
        });
        addConfirmed(updated.id);
        showToast(`Confirmed ${updated.id} — priority recalculated to ${updated.priority}.`);
        renderFeed();
      } catch (err) { showToast(err.message); }
    });
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

/* ---------------- Authority table ---------------- */
async function renderAuthority() {
  const dept = document.getElementById('filterDept').value;
  const status = document.getElementById('filterStatus').value;
  const params = new URLSearchParams();
  if (dept) params.set('department', dept);
  if (status) params.set('status', status);
  const list = await api('/api/issues?' + params.toString());
  const el = document.getElementById('authTable');

  if (list.length === 0) { el.innerHTML = `<tr><td colspan="7" class="empty">No matching issues.</td></tr>`; return; }

  el.innerHTML = list.map((issue) => `
    <tr>
      <td>
        <div style="font-weight:600;color:var(--ink);">${issue.category}</div>
        <div class="mono" style="font-size:11px;color:var(--text-dim);">${issue.id}</div>
      </td>
      <td>${escapeHtml(issue.ward)}</td>
      <td><span class="mono" style="font-weight:600;color:${issue.priority >= 75 ? 'var(--clay)' : issue.priority >= 45 ? 'var(--amber)' : 'var(--green)'}">${issue.priority}</span></td>
      <td><span class="dept-pill">${issue.department}</span></td>
      <td class="mono">${issue.confirms}</td>
      <td><span class="stamp ${issue.status}">${TRACK_LABELS[issue.status]}</span></td>
      <td>
        <select class="status-select" data-id="${issue.id}">
          ${TRACK_STEPS.map((s) => `<option value="${s}" ${s === issue.status ? 'selected' : ''}>${TRACK_LABELS[s]}</option>`).join('')}
        </select>
      </td>
    </tr>
  `).join('');

  el.querySelectorAll('.status-select').forEach((sel) => {
    sel.addEventListener('change', async () => {
      try {
        const updated = await api(`/api/issues/${encodeURIComponent(sel.dataset.id)}/status`, {
          method: 'PATCH', body: JSON.stringify({ status: sel.value }),
        });
        showToast(`${updated.id} marked as "${TRACK_LABELS[updated.status]}"${updated.status === 'resolved' ? ' — awaiting citizen verification.' : ''}`);
        renderAuthority();
      } catch (err) { showToast(err.message); }
    });
  });
}
document.getElementById('filterDept').addEventListener('change', renderAuthority);
document.getElementById('filterStatus').addEventListener('change', renderAuthority);

/* ---------------- Analytics ---------------- */
async function renderAnalytics() {
  const a = await api('/api/analytics');
  document.getElementById('statRow').innerHTML = `
    <div class="stat"><div class="n">${a.total}</div><div class="l">Total Reports</div></div>
    <div class="stat"><div class="n">${a.resolvedPct}%</div><div class="l">Resolved Rate</div></div>
    <div class="stat"><div class="n">${a.avgPriority}</div><div class="l">Avg Priority Score</div></div>
    <div class="stat"><div class="n">${a.highSeverityOpen}</div><div class="l">High Severity Open</div></div>
  `;

  const maxCat = Math.max(1, ...Object.values(a.byCategory));
  document.getElementById('catChart').innerHTML = Object.entries(a.byCategory).map(([cat, c]) => `
    <div class="bar-row">
      <div class="bl">${cat}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(c / maxCat) * 100 || 0}%"></div></div>
      <div class="bv">${c}</div>
    </div>`).join('');

  document.getElementById('wardList').innerHTML = a.wards.length ? a.wards.map((w) => `
    <div class="ward-item"><span class="wname">${escapeHtml(w.ward)}</span><span class="wcount">${w.count} issue${w.count > 1 ? 's' : ''}</span></div>
  `).join('') : '<div class="empty">No data yet.</div>';

  const deptEntries = Object.entries(a.byDept);
  document.getElementById('deptPerf').innerHTML = deptEntries.length ? deptEntries.map(([dept, s]) => {
    const pct = s.total ? Math.round((s.resolved / s.total) * 100) : 0;
    return `<div class="dept-perf-row">
      <div>${dept}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:var(--green);"></div></div>
      <div class="mono" style="text-align:right;">${s.resolved}/${s.total}</div>
    </div>`;
  }).join('') : '<div class="empty">No data yet.</div>';
}

/* ---------------- Toast ---------------- */
let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

/* ---------------- Boot ---------------- */
(async function init() {
  await loadMeta();
  await renderFeed();
})();
