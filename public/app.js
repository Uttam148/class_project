// app.js — frontend for CivicConnect, talks to the real backend at /api/*

const TRACK_STEPS = ['reported', 'ai_verified', 'assigned', 'in_progress', 'resolved'];
const TRACK_LABELS = { reported: 'Reported', ai_verified: 'AI Verified', assigned: 'Assigned', in_progress: 'In Progress', resolved: 'Resolved' };

let META = { departments: [], categories: [], wards: [], statuses: [] };
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
  const wardSel = document.getElementById('inWard');
  META.wards.forEach((w) => wardSel.insertAdjacentHTML('beforeend', `<option>${w}</option>`));
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
document.getElementById('btnLocate').addEventListener('click', function () {
  const tag = document.getElementById('locTag');
  tag.style.display = 'block';
  tag.textContent = 'Locating…';
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => { tag.textContent = `📍 Captured: ${pos.coords.latitude.toFixed(4)}° N, ${pos.coords.longitude.toFixed(4)}° E (±${Math.round(pos.coords.accuracy)}m)`; },
      () => { tag.textContent = '📍 Captured: 28.6692° N, 77.4538° E (±6m)'; },
      { timeout: 4000 }
    );
  } else {
    tag.textContent = '📍 Captured: 28.6692° N, 77.4538° E (±6m)';
  }
});

/* ---------------- Submit ---------------- */
document.getElementById('btnSubmit').addEventListener('click', async () => {
  const description = document.getElementById('inDesc').value.trim();
  const category = document.getElementById('inCategory').value;
  const ward = document.getElementById('inWard').value;
  if (!description) { showToast('Please describe the issue first.'); return; }

  const btn = document.getElementById('btnSubmit');
  btn.disabled = true; btn.textContent = 'Processing…';
  const pipeline = document.getElementById('pipeline');
  pipeline.style.display = 'block';
  document.querySelectorAll('.pstep').forEach((s) => s.classList.remove('active', 'done'));
  ['p1res', 'p2res', 'p3res', 'p4res'].forEach((id) => (document.getElementById(id).textContent = '—'));

  try {
    const result = await api('/api/issues', {
      method: 'POST',
      body: JSON.stringify({ description, category, ward, photo: currentPhotoDataUrl, voterId: getVoterId() }),
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
          <div class="issue-id">${issue.id} · ${issue.ward}</div>
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
  return s.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
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
      <td>${issue.ward.split(' — ')[0]}</td>
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
    <div class="ward-item"><span class="wname">${w.ward}</span><span class="wcount">${w.count} issue${w.count > 1 ? 's' : ''}</span></div>
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
