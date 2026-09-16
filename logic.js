// logic.js — classification, severity detection, duplicate detection, priority scoring
// These are rule/keyword-based simulations standing in for trained ML models —
// swap classify()/detectSeverity() for real CV/NLP model calls in production.

const DEPTS = {
  'Pothole': 'Roads & Infrastructure',
  'Road Damage': 'Roads & Infrastructure',
  'Garbage / Waste': 'Sanitation',
  'Streetlight': 'Electrical / Streetlighting',
  'Water Leakage': 'Water Supply & Sewage',
};

const KEYWORDS = {
  'Pothole': ['pothole', 'pot hole', 'crater', 'hole in road', 'skid'],
  'Road Damage': ['road damage', 'cracked road', 'broken road', 'uneven road', 'damaged road'],
  'Garbage / Waste': ['garbage', 'waste', 'trash', 'dump', 'litter', 'not collected'],
  'Streetlight': ['streetlight', 'street light', 'pole', 'dark at night', 'lamp'],
  'Water Leakage': ['water leak', 'leakage', 'pipe', 'flooding', 'sewage', 'water logging'],
};

function classify(desc, manualCategory) {
  if (manualCategory && DEPTS[manualCategory]) {
    return { category: manualCategory, confidence: 0.99 };
  }
  const text = desc.toLowerCase();
  let best = null, bestScore = 0;
  for (const cat in KEYWORDS) {
    let score = 0;
    KEYWORDS[cat].forEach((k) => { if (text.includes(k)) score += 1; });
    if (score > bestScore) { bestScore = score; best = cat; }
  }
  if (!best) {
    const cats = Object.keys(KEYWORDS);
    best = cats[Math.floor(Math.random() * cats.length)];
    return { category: best, confidence: 0.52 };
  }
  return { category: best, confidence: Math.min(0.97, 0.68 + bestScore * 0.11) };
}

function detectSeverity(desc) {
  const text = desc.toLowerCase();
  const highWords = ['danger', 'unsafe', 'accident', 'flood', 'severe', 'major', 'urgent', 'skid'];
  const medWords = ['days', 'week', 'not collected', 'flickering', 'leak'];
  if (highWords.some((w) => text.includes(w))) return 'high';
  if (medWords.some((w) => text.includes(w))) return 'medium';
  return Math.random() < 0.4 ? 'medium' : 'low';
}

function computeScore(severity, confirms, ageDays) {
  const sevScore = severity === 'high' ? 40 : severity === 'medium' ? 24 : 10;
  const confirmScore = Math.min(30, confirms * 5);
  const ageScore = Math.min(20, ageDays * 2);
  const impactScore = Math.floor(Math.random() * 10);
  return Math.min(99, sevScore + confirmScore + ageScore + impactScore);
}

function daysBetween(isoDate, now = new Date()) {
  const then = new Date(isoDate);
  return Math.max(0, Math.floor((now - then) / 86400000));
}

module.exports = { DEPTS, classify, detectSeverity, computeScore, daysBetween };
