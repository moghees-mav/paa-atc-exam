import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import session from 'express-session';
import rateLimit from 'express-rate-limit';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as rtlDb from './interfaces/rtl-db-client.js';
import * as rbac from './interfaces/rbac-service.js';
import * as eligibility from './interfaces/eligibility-resolver.js';
import initSqlJs from 'sql.js';

// ── Paths ──────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, 'database', 'atc-exam.db');
const MIGRATIONS_DIR = join(__dirname, 'database', 'migrations');

// ── Database (lazy init via promise) ─────────────────────────
// ═══════════════════════════════════════════════════════════════
// PERSISTENCE WARNING — sql.js
// ──────────────────────────────────────────────────────────────
// sql.js is a WebAssembly build of SQLite that runs entirely in
// memory. There is no background writer, no WAL, no auto-checkpoint.
// Data is only persisted when saveDb() is called explicitly.
//
// CRITICAL: Every function that performs a write MUST call saveDb()
// before returning. The current pattern:
//   db.run(writeSql, params);
//   saveDb();
//
// This includes audit_log inserts, exam_results writes, user table
// changes, session state mutations — any DML that must survive a
// process crash or restart.
//
// saveDb() uses writeFileSync (synchronous, blocking) so the Node
// event loop does not proceed until the full 2MB+ buffer is flushed
// to disk. This is acceptable for a single-user/dev scenario but will
// become a throughput bottleneck under concurrent writes (multiple
// simultaneous exam submissions). The SQLite→Postgres migration
// (flagged in memory-bank.md as a planned step before multi-location
// deployment) resolves this.
//
// ═══════════════════════════════════════════════════════════════

let db = null;

async function getDb() {
  if (db) return db;
  const SQL = await initSqlJs();

  if (existsSync(DB_PATH)) {
    const buf = readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    if (!existsSync(dirname(DB_PATH))) mkdirSync(dirname(DB_PATH), { recursive: true });
    db = new SQL.Database();
  }

  // Run migrations (sequential, tracked via _migrations table)
  const migrationFiles = ['001_initial_schema.sql', '002_question_bank_v2.sql', '003_rtldb_integration.sql', '004_mode2_schema.sql'];
  for (const file of migrationFiles) {
    // Check if already applied
    const checkStmt = db.prepare('SELECT COUNT(*) as cnt FROM sqlite_master WHERE type=\'table\' AND name=\'_migrations\'');
    if (allRows(checkStmt)[0]?.cnt > 0) {
      const exists = db.prepare('SELECT COUNT(*) as cnt FROM _migrations WHERE file_name = ?');
      exists.bind([file]);
      const row = allRows(exists);
      if (row[0]?.cnt > 0) continue;
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
    db.run(sql);
  }

  // Set DB reference for RTL-db client cache
  rtlDb.setDb(db);

  saveDb();
  return db;
}

function saveDb() {
  if (!db) return;
  // Synchronous — blocks until full buffer is flushed.
  // Required: sql.js has no background writer; if this is skipped,
  //       all writes since the last saveDb() are lost on crash.
  const data = db.export();
  writeFileSync(DB_PATH, Buffer.from(data));
}

// ── Express app ─────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3099;

// Security headers
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:3099',
  credentials: true
}));

app.use(express.json({ limit: '5mb' }));

// Session (cookie-based)
app.use(session({
  secret: process.env.SESSION_SECRET || 'atc-exam-dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  name: 'atc.sid',
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000
  }
}));

// Rate limiting
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts', code: 'LOGIN_LOCKED' }
});

// ── Helpers ─────────────────────────────────────────────────
function auditLog(actor, action, severity = 'info', context = {}, tenantId = null) {
  if (!db) return;
  const stmt = db.prepare(
    'INSERT INTO audit_log (tenant_id, actor, action, severity, context) VALUES (?, ?, ?, ?, ?)'
  );
  stmt.bind([tenantId, actor, action, severity, JSON.stringify(context)]);
  stmt.step();
  stmt.free();
  saveDb();
}

function allRows(stmt) {
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function firstRow(stmt) {
  const has = stmt.step();
  const row = has ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function requireSession(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Not authenticated', code: 'AUTH_REQUIRED' });
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
    const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
    stmt.bind([req.session.userId]);
    const user = firstRow(stmt);
    if (!user) return res.status(401).json({ error: 'User not found' });
    const hasRole = roles.some(r => {
      if (r === 'examiner') return user.role_examiner;
      if (r === 'qb_editor') return user.role_qb_editor;
      if (r === 'sys_admin') return user.role_sys_admin;
      if (r === 'tech_admin') return user.role_tech_admin;
      if (r === 'supervisor') return user.role_supervisor;
      return false;
    });
    if (!hasRole) return res.status(403).json({ error: 'Insufficient permissions' });
    req.currentUser = user;
    next();
  };
}

// ── Health ──────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  await getDb();
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ── Auth routes ─────────────────────────────────────────────
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  await getDb();
  const { serviceNo } = req.body;
  if (!serviceNo) {
    return res.status(400).json({ error: 'Service number required', code: 'MISSING_FIELD' });
  }

  // ── Login lockout check ─────────────────────────────
  const lockoutStmt = db.prepare(
    `SELECT COUNT(*) as cnt FROM login_lockouts
     WHERE service_no = ? AND resolved = 0
     AND attempt_time > datetime('now', '-15 minutes')`
  );
  lockoutStmt.bind([serviceNo]);
  const lockoutRow = firstRow(lockoutStmt);
  if (lockoutRow && lockoutRow.cnt >= 5) {
    auditLog(serviceNo, 'login_blocked_lockout', 'warning', { serviceNo, failedCount: lockoutRow.cnt });
    return res.status(429).json({
      error: 'Too many failed attempts. Contact supervisor.',
      code: 'LOGIN_LOCKED',
      overridePath: true
    });
  }

  // ── RTL-db personnel lookup ────────────────────────
  const lookup = await rtlDb.lookupPersonnel(serviceNo);
  if (!lookup.ok) {
    // Log the failed attempt
    const ip = req.ip || req.connection?.remoteAddress || '';
    const ua = req.get('User-Agent') || '';
    db.run(
      'INSERT INTO login_lockouts (service_no, ip_address, user_agent) VALUES (?, ?, ?)',
      [serviceNo, ip, ua]
    );
    saveDb();

    auditLog(serviceNo, lookup.code === 'AUTH_FAILED' ? 'rtldb_auth_failed' : 'rtldb_unreachable', 'error', {
      serviceNo, code: lookup.code
    });

    if (lookup.overridePath) {
      return res.status(503).json({
        error: lookup.code === 'AUTH_FAILED' || lookup.code === 'FORBIDDEN'
          ? 'System authentication unavailable. Notify invigilator.'
          : 'Personnel database unreachable. Notify invigilator.',
        code: lookup.code,
        overridePath: true
      });
    }

    return res.status(404).json({
      error: 'Service number not found.',
      code: 'NOT_FOUND',
      overridePath: true
    });
  }

  // ── Status check ───────────────────────────────────
  const statusCheck = await rtlDb.checkStatus(serviceNo);
  if (!statusCheck.ok || !statusCheck.active) {
    auditLog(serviceNo, 'login_blocked_inactive', 'warning', { serviceNo, rtlStatus: lookup.data?.current_status });
    return res.status(403).json({
      error: 'Account not active/eligible. Contact supervisor.',
      code: 'ACCOUNT_INACTIVE',
      overridePath: true
    });
  }

  // ── License validation ─────────────────────────────
  const { licenseNumber } = req.body;
  if (licenseNumber) {
    if (licenseNumber !== lookup.data.license_number) {
      auditLog(serviceNo, 'login_license_mismatch', 'warning', { serviceNo });
      return res.status(403).json({
        error: 'License number does not match records.',
        code: 'LICENSE_MISMATCH',
        overridePath: true
      });
    }
  }

  // ── Get ratings/qualifications ─────────────────────
  const tenantId = lookup.data.tenant_id;
  let radarQualified = false;
  let nonRadarQualified = false;
  if (tenantId) {
    const ratings = await rtlDb.getValidRatings(serviceNo, tenantId);
    if (ratings.ok && ratings.data) {
      radarQualified = ratings.data.radar_qualified;
      nonRadarQualified = ratings.data.non_radar_qualified;
    }
  }

  // ── Upsert local user record ───────────────────────
  const existingUser = db.prepare('SELECT * FROM users WHERE service_no = ?');
  existingUser.bind([serviceNo]);
  let user = firstRow(existingUser);

  if (!user) {
    db.run(
      'INSERT INTO users (service_no, display_name, tenant_id, is_active) VALUES (?, ?, ?, 1)',
      [serviceNo, lookup.data.full_name || serviceNo, tenantId]
    );
    saveDb();
    existingUser.bind([serviceNo]);
    user = firstRow(existingUser);
    auditLog('system', 'user_auto_created', 'info', { serviceNo, fromRtlDb: true });
  } else {
    // Update display name and tenant from RTL-db
    db.run(
      'UPDATE users SET display_name = ?, tenant_id = ?, updated_at = datetime(\'now\') WHERE service_no = ?',
      [lookup.data.full_name || user.display_name, tenantId || user.tenant_id, serviceNo]
    );
    saveDb();
    existingUser.bind([serviceNo]);
    user = firstRow(existingUser);
  }

  if (!user.is_active) {
    auditLog(serviceNo, 'login_blocked_inactive', 'warning', { serviceNo });
    return res.status(403).json({ error: 'Account inactive', code: 'ACCOUNT_INACTIVE' });
  }

  req.session.userId = user.id;
  req.session.serviceNo = user.service_no;
  req.session.tenantId = tenantId;
  req.session.radarQualified = radarQualified;
  req.session.nonRadarQualified = nonRadarQualified;
  req.session.role = {
    examiner: user.role_examiner,
    qbEditor: user.role_qb_editor,
    sysAdmin: user.role_sys_admin,
    techAdmin: user.role_tech_admin,
    supervisor: user.role_supervisor
  };

  auditLog(serviceNo, 'login_success', 'info', { serviceNo, tenantId, fromRtlDb: true });

  res.json({
    ok: true,
    user: {
      serviceNo: user.service_no,
      displayName: user.display_name,
      tenantId: user.tenant_id,
      role: req.session.role,
      radarQualified,
      nonRadarQualified
    }
  });
});

app.post('/api/auth/logout', (req, res) => {
  if (req.session?.serviceNo) {
    auditLog(req.session.serviceNo, 'logout', 'info', {});
  }
  req.session.destroy(() => {
    res.clearCookie('atc.sid');
    res.json({ ok: true });
  });
});

app.get('/api/auth/session', requireSession, (req, res) => {
  const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
  stmt.bind([req.session.userId]);
  const user = firstRow(stmt);
  if (!user) return res.status(401).json({ error: 'User not found' });
  res.json({
    serviceNo: user.service_no,
    displayName: user.display_name,
    tenantId: user.tenant_id,
    role: {
      examiner: user.role_examiner,
      qbEditor: user.role_qb_editor,
      sysAdmin: user.role_sys_admin,
      techAdmin: user.role_tech_admin,
      supervisor: user.role_supervisor
    }
  });
});

app.post('/api/auth/override', requireSession, requireRole('supervisor'), (req, res) => {
  const { targetServiceNo, reason, overrideType } = req.body;
  if (!targetServiceNo || !reason) {
    return res.status(400).json({ error: 'targetServiceNo and reason required' });
  }

  const overrideTypeFinal = overrideType || 'generic';

  // Unlock login lockout if overrideType is login_lockout
  if (overrideTypeFinal === 'login_lockout') {
    db.run(
      'UPDATE login_lockouts SET resolved = 1, resolved_at = datetime(\'now\'), resolved_by = ? WHERE service_no = ? AND resolved = 0',
      [req.session.serviceNo, targetServiceNo]
    );
    saveDb();
  }

  auditLog(
    req.session.serviceNo,
    `override_${overrideTypeFinal}`,
    'warning',
    { targetServiceNo, reason, overrideType: overrideTypeFinal },
    null
  );
  res.json({ ok: true, overridden: targetServiceNo, reason, overrideType: overrideTypeFinal });
});

app.post('/api/auth/tab-close', (req, res) => {
  if (req.session) req.session.destroy(() => {});
  res.clearCookie('atc.sid');
  res.json({ ok: true });
});

// ── Complexity mapping ──────────────────────────────────────
const COMPLEXITY_MAPPING_PATH = join(__dirname, 'config', 'complexity-mapping.json');

function loadComplexityMapping() {
  try {
    const raw = readFileSync(COMPLEXITY_MAPPING_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { mappings: [] };
  }
}

/**
 * Resolve complexity value to [easy%, medium%, hard%] ratios.
 * Returns the exact match if found, otherwise interpolates between closest entries.
 */
function resolveComplexity(value) {
  const mapping = loadComplexityMapping();
  const entries = mapping.mappings || [];
  if (entries.length === 0) return [40, 40, 20]; // fallback balanced

  const exact = entries.find(e => e.complexity === value);
  if (exact) return exact.ratios;

  // Sort by complexity value
  const sorted = [...entries].sort((a, b) => a.complexity - b.complexity);
  
  // Clamp to min/max
  if (value <= sorted[0].complexity) return sorted[0].ratios;
  if (value >= sorted[sorted.length - 1].complexity) return sorted[sorted.length - 1].ratios;

  // Interpolate between two nearest entries
  for (let i = 0; i < sorted.length - 1; i++) {
    const low = sorted[i];
    const high = sorted[i + 1];
    if (value >= low.complexity && value <= high.complexity) {
      const t = (value - low.complexity) / (high.complexity - low.complexity);
      return [
        Math.round(low.ratios[0] + (high.ratios[0] - low.ratios[0]) * t),
        Math.round(low.ratios[1] + (high.ratios[1] - low.ratios[1]) * t),
        Math.round(low.ratios[2] + (high.ratios[2] - low.ratios[2]) * t)
      ];
    }
  }
  return sorted[sorted.length - 1].ratios;
}

app.get('/api/complexity/mapping', (req, res) => {
  res.json(loadComplexityMapping());
});

app.get('/api/complexity/resolve', (req, res) => {
  const value = parseInt(req.query.value);
  if (isNaN(value) || value < 0 || value > 100) {
    return res.status(400).json({ error: 'value must be 0-100' });
  }
  const ratios = resolveComplexity(value);
  res.json({ complexity: value, easy: ratios[0], medium: ratios[1], hard: ratios[2] });
});

// ── Complexity override (HQ supervisor) ─────────────────────
app.post('/api/complexity/override', requireSession, requireRole('sys_admin', 'supervisor'), (req, res) => {
  const { serviceNo, reason, newValue } = req.body;
  if (!serviceNo || !reason || newValue === undefined) {
    return res.status(400).json({ error: 'serviceNo, reason, and newValue required' });
  }
  if (isNaN(newValue) || newValue < 0 || newValue > 100) {
    return res.status(400).json({ error: 'newValue must be 0-100' });
  }

  // Get current complexity from session or default 50
  const prevStmt = db.prepare('SELECT complexity FROM exam_sessions WHERE examinee_service_no = ? AND status = \'in_progress\' ORDER BY started_at DESC LIMIT 1');
  prevStmt.bind([serviceNo]);
  const prev = firstRow(prevStmt);
  const previousValue = prev ? prev.complexity : 50;

  db.run(
    'INSERT INTO complexity_overrides (service_no, previous_value, new_value, reason, overridden_by) VALUES (?, ?, ?, ?, ?)',
    [serviceNo, previousValue, newValue, reason, req.session.serviceNo]
  );
  saveDb();

  auditLog(req.session.serviceNo, 'complexity_override', 'info', {
    targetServiceNo: serviceNo,
    previousValue,
    newValue,
    reason
  });

  res.json({ ok: true, previousValue, newValue });
});

// ── Mode 2: License re-validation at exam start ─────────────
// Separate from login-time validation. Called before exam commences.
app.post('/api/auth/mode2-validate-license', requireSession, async (req, res) => {
  const { licenseNumber } = req.body;
  const serviceNo = req.session.serviceNo;
  if (!licenseNumber) {
    return res.status(400).json({ error: 'License number required' });
  }

  // Look up the user's license from RTL-db cache or live
  const lookup = await rtlDb.lookupPersonnel(serviceNo);
  if (!lookup.ok || !lookup.data) {
    return res.status(502).json({ error: 'Cannot verify license — personnel lookup failed', code: 'LOOKUP_FAILED' });
  }

  if (licenseNumber !== lookup.data.license_number) {
    auditLog(serviceNo, 'mode2_license_mismatch', 'warning', { serviceNo, reason: 'License number mismatch at exam start' });
    return res.status(403).json({
      error: 'License number does not match records.',
      code: 'LICENSE_MISMATCH',
      overridePath: true
    });
  }

  auditLog(serviceNo, 'mode2_license_validated', 'info', {
    serviceNo,
    authMethod: 'manual license-number validation, v1'
  });

  res.json({ ok: true, authMethod: 'manual license-number validation, v1' });
});

// ── Question Flagging (Task 03) ──────────────────────────────

// POST /api/sessions/:sessionId/flag — Examinee flags a question during active Mode 2 session
app.post('/api/sessions/:sessionId/flag', requireSession, async (req, res) => {
  await getDb();
  const { sessionId } = req.params;
  const { questionId, reason } = req.body;
  if (!questionId) return res.status(400).json({ error: 'questionId required' });

  const sessionStmt = db.prepare('SELECT * FROM exam_sessions WHERE session_id = ? AND examinee_service_no = ?');
  sessionStmt.bind([sessionId, req.session.serviceNo]);
  const session = firstRow(sessionStmt);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.mode !== 'official') return res.status(400).json({ error: 'Flagging only available for Mode 2 (official) exams' });
  if (session.status !== 'in_progress') return res.status(400).json({ error: 'Session is not in progress' });

  // Check duplicate flag
  const dupStmt = db.prepare('SELECT id FROM question_flags WHERE session_id = ? AND question_id = ? AND resolved_by IS NULL');
  dupStmt.bind([sessionId, questionId]);
  const dup = firstRow(dupStmt);
  if (dup) return res.status(409).json({ error: 'Question already flagged in this session', flagId: dup.id });

  db.run(
    'INSERT INTO question_flags (session_id, question_id, examinee_service_no, reason, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))',
    [sessionId, questionId, req.session.serviceNo, reason || '']
  );
  saveDb();

  const flagId = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];

  auditLog(req.session.serviceNo, 'question_flagged', 'info', {
    sessionId, questionId, flagId, reason: reason || ''
  });

  res.status(201).json({ flagId, questionId, sessionId });
});

// GET /api/sessions/:sessionId/flags — Get flags for examiner review
app.get('/api/sessions/:sessionId/flags', requireSession, (req, res) => {
  const { sessionId } = req.params;

  const sessionStmt = db.prepare('SELECT * FROM exam_sessions WHERE session_id = ?');
  sessionStmt.bind([sessionId]);
  const session = firstRow(sessionStmt);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const stmt = db.prepare(
    `SELECT f.*, q.question, q.document, q.chapter, q.difficulty, q.options, q.correct_answer
     FROM question_flags f
     LEFT JOIN questions q ON f.question_id = q.id
     WHERE f.session_id = ?
     ORDER BY f.created_at`
  );
  stmt.bind([sessionId]);
  const flags = [];
  while (stmt.step()) flags.push(stmt.getAsObject());
  stmt.free();

  res.json({
    sessionId,
    examineeServiceNo: session.examinee_service_no,
    mode: session.mode,
    status: session.status,
    flags: flags.map(f => ({
      id: f.id,
      questionId: f.question_id,
      question: f.question || '',
      document: f.document || '',
      chapter: f.chapter || '',
      difficulty: f.difficulty || '',
      reason: f.reason || '',
      createdAt: f.created_at,
      resolvedBy: f.resolved_by,
      resolvedAt: f.resolved_at,
      decision: f.decision,
      remarks: f.remarks || '',
      retakeAllowed: !!f.retake_allowed
    }))
  });
});

// POST /api/sessions/:sessionId/flags/:flagId/resolve — Examiner resolves a flag
app.post('/api/sessions/:sessionId/flags/:flagId/resolve', requireSession, requireRole('examiner', 'supervisor'), (req, res) => {
  const { sessionId, flagId } = req.params;
  const { decision, remarks, retakeAllowed } = req.body;

  if (!decision || !['upheld', 'invalidated'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be "upheld" or "invalidated"' });
  }

  const flagStmt = db.prepare('SELECT * FROM question_flags WHERE id = ? AND session_id = ?');
  flagStmt.bind([flagId, sessionId]);
  const flag = firstRow(flagStmt);
  if (!flag) return res.status(404).json({ error: 'Flag not found' });
  if (flag.resolved_by) return res.status(409).json({ error: 'Flag already resolved' });

  db.run(
    `UPDATE question_flags SET resolved_by = ?, resolved_at = datetime('now'), decision = ?, remarks = ?, retake_allowed = ?
     WHERE id = ?`,
    [req.session.serviceNo, decision, remarks || '', retakeAllowed ? 1 : 0, flagId]
  );
  saveDb();

  // If examiner allows retake, update session
  if (retakeAllowed) {
    db.run('UPDATE exam_sessions SET retake_offered = 1 WHERE session_id = ?', [sessionId]);
    saveDb();
  }

  auditLog(req.session.serviceNo, 'flag_resolved', 'info', {
    flagId, sessionId, decision, retakeAllowed: !!retakeAllowed, remarks: remarks || ''
  });

  res.json({ ok: true, flagId, decision, retakeAllowed: !!retakeAllowed });
});

// POST /api/sessions/:sessionId/submit — Submit exam, grade with flag exclusion, create provisional result
app.post('/api/sessions/:sessionId/submit', requireSession, (req, res) => {
  const { sessionId } = req.params;
  const { answers, timeTakenSeconds } = req.body;
  if (!answers || typeof answers !== 'object') {
    return res.status(400).json({ error: 'answers object required' });
  }

  const sessionStmt = db.prepare('SELECT * FROM exam_sessions WHERE session_id = ? AND examinee_service_no = ?');
  sessionStmt.bind([sessionId, req.session.serviceNo]);
  const session = firstRow(sessionStmt);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status !== 'in_progress') return res.status(400).json({ error: 'Session is not in progress' });

  // Get flagged question IDs for this session
  const flagStmt = db.prepare('SELECT question_id, decision FROM question_flags WHERE session_id = ?');
  flagStmt.bind([sessionId]);
  const flaggedRows = [];
  while (flagStmt.step()) flaggedRows.push(flagStmt.getAsObject());
  flagStmt.free();

  // Separate unresolved on-the-fly (excluded from scoring) vs resolved invalidated
  const excludedIds = new Set(
    flaggedRows.filter(f => !f.decision || f.decision === 'invalidated').map(f => f.question_id)
  );

  // Load questions from result_data (the stored question IDs)
  const storedQuestions = JSON.parse(session.result_data || '[]');
  const questionIds = storedQuestions.map(q => q.id);

  // Fetch questions from DB for correct answers
  const placeholders = questionIds.map(() => '?').join(',');
  const qStmt = db.prepare(`SELECT id, correct_answer FROM questions WHERE id IN (${placeholders})`);
  qStmt.bind(questionIds);
  const questionRows = [];
  while (qStmt.step()) questionRows.push(qStmt.getAsObject());
  qStmt.free();

  const correctMap = {};
  questionRows.forEach(q => { correctMap[q.id] = q.correct_answer; });

  // Grade
  let correctCount = 0;
  let totalScored = 0;
  const perQuestionResults = [];

  for (const qId of questionIds) {
    if (excludedIds.has(qId)) {
      perQuestionResults.push({ questionId: qId, excluded: true });
      continue;
    }
    totalScored++;
    const given = answers[String(qId)] || null;
    const correct = correctMap[qId] || '';
    const isCorrect = given === correct;
    if (isCorrect) correctCount++;
    perQuestionResults.push({ questionId: qId, given, correct, isCorrect });
  }

  const totalQuestions = questionIds.length;
  const scorePct = totalScored > 0 ? Math.round((correctCount / totalScored) * 100) : 0;
  const flaggedCount = flaggedRows.length;

  // Store result data as JSON
  const resultData = JSON.stringify({
    answers,
    scorePct,
    correctCount,
    totalScored,
    totalQuestions,
    flaggedCount,
    perQuestionResults,
    excludedIds: [...excludedIds],
    timeTakenSeconds: timeTakenSeconds || 0
  });

  // Create provisional exam_result
  const resultStmt = db.prepare(
    `INSERT INTO exam_results (session_id, score_pct, total_questions, correct_count, flagged_count, is_provisional, is_final, created_at)
     VALUES (?, ?, ?, ?, ?, 1, 0, datetime('now'))`
  );
  resultStmt.bind([sessionId, scorePct, totalQuestions, correctCount, flaggedCount]);
  resultStmt.step();
  resultStmt.free();

  // Update session status to submitted (with provisional result)
  db.run(
    "UPDATE exam_sessions SET status = 'provisional', submitted_at = datetime('now'), result_data = ? WHERE session_id = ?",
    [resultData, sessionId]
  );
  saveDb();

  const resultId = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];

  auditLog(req.session.serviceNo, 'exam_submitted_provisional', 'info', {
    sessionId, scorePct, correctCount, totalScored, totalQuestions, flaggedCount
  });

  res.status(200).json({
    sessionId,
    resultId,
    scorePct,
    correctCount,
    totalScored,
    totalQuestions,
    flaggedCount,
    isProvisional: true,
    hasFlags: flaggedCount > 0
  });
});

// POST /api/sessions/:sessionId/finalize — Finalize provisional result
app.post('/api/sessions/:sessionId/finalize', requireSession, requireRole('examiner', 'supervisor'), (req, res) => {
  const { sessionId } = req.params;

  const sessionStmt = db.prepare('SELECT * FROM exam_sessions WHERE session_id = ?');
  sessionStmt.bind([sessionId]);
  const session = firstRow(sessionStmt);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status !== 'provisional') return res.status(400).json({ error: 'Session is not in provisional state' });

  // Check all flags are resolved
  const unresolvedStmt = db.prepare('SELECT COUNT(*) as cnt FROM question_flags WHERE session_id = ? AND resolved_by IS NULL');
  unresolvedStmt.bind([sessionId]);
  const unresolved = firstRow(unresolvedStmt);
  if (unresolved.cnt > 0) {
    return res.status(400).json({ error: `${unresolved.cnt} unresolved flag(s) remain. Resolve all flags before finalizing.` });
  }

  // Update exam_results
  db.run(
    "UPDATE exam_results SET is_provisional = 0, is_final = 1, finalized_at = datetime('now') WHERE session_id = ?",
    [sessionId]
  );
  saveDb();

  // Update session status
  db.run("UPDATE exam_sessions SET status = 'final' WHERE session_id = ?", [sessionId]);
  saveDb();

  auditLog(req.session.serviceNo, 'exam_finalized', 'info', { sessionId, finalizedBy: req.session.serviceNo });

  // Fetch the updated result
  const resultStmt = db.prepare('SELECT * FROM exam_results WHERE session_id = ?');
  resultStmt.bind([sessionId]);
  const result = firstRow(resultStmt);

  res.json({ ok: true, sessionId, isFinal: true, scorePct: result.score_pct, finalizedAt: result.finalized_at });
});

// GET /api/sessions/:sessionId/result — Get exam result (provisional or final)
app.get('/api/sessions/:sessionId/result', requireSession, (req, res) => {
  const { sessionId } = req.params;

  const sessionStmt = db.prepare('SELECT * FROM exam_sessions WHERE session_id = ?');
  sessionStmt.bind([sessionId]);
  const session = firstRow(sessionStmt);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  // Only allow examinee or examiner/supervisor to view
  if (session.examinee_service_no !== req.session.serviceNo) {
    const userStmt = db.prepare('SELECT * FROM users WHERE id = ?');
    userStmt.bind([req.session.userId]);
    const user = firstRow(userStmt);
    if (!user || (!user.role_examiner && !user.role_supervisor)) {
      return res.status(403).json({ error: 'Access denied' });
    }
  }

  const resultStmt = db.prepare('SELECT * FROM exam_results WHERE session_id = ?');
  resultStmt.bind([sessionId]);
  const result = firstRow(resultStmt);

  // Get flags with resolution details
  const flagStmt = db.prepare('SELECT * FROM question_flags WHERE session_id = ? ORDER BY created_at');
  flagStmt.bind([sessionId]);
  const flags = [];
  while (flagStmt.step()) flags.push(flagStmt.getAsObject());
  flagStmt.free();

  const isExaminerView = req.session.serviceNo !== session.examinee_service_no;
  const showResolutionDetails = isExaminerView || (result && result.is_final);

  const sessionResultData = session.result_data ? JSON.parse(session.result_data) : null;

  res.json({
    sessionId,
    status: session.status,
    mode: session.mode,
    examineeServiceNo: session.examinee_service_no,
    result: result ? {
      scorePct: result.score_pct,
      totalQuestions: result.total_questions,
      correctCount: result.correct_count,
      flaggedCount: result.flagged_count,
      isProvisional: !!result.is_provisional,
      isFinal: !!result.is_final,
      finalizedAt: result.finalized_at
    } : null,
    flags: flags.map(f => ({
      id: f.id,
      questionId: f.question_id,
      reason: f.reason,
      createdAt: f.created_at,
      resolvedBy: f.resolved_by,
      resolvedAt: f.resolved_at,
      ...(showResolutionDetails ? { decision: f.decision, remarks: f.remarks } : {}),
      retakeAllowed: !!f.retake_allowed
    })),
    retakeOffered: !!session.retake_offered,
    retakeTaken: !!session.retake_taken,
    retakeOutcome: session.retake_outcome,
    sessionResultData
  });
});

// POST /api/sessions/:sessionId/retake — Start a retake (only if offered)
app.post('/api/sessions/:sessionId/retake', requireSession, (req, res) => {
  const { sessionId } = req.params;

  const sessionStmt = db.prepare('SELECT * FROM exam_sessions WHERE session_id = ? AND examinee_service_no = ?');
  sessionStmt.bind([sessionId, req.session.serviceNo]);
  const session = firstRow(sessionStmt);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!session.retake_offered) return res.status(400).json({ error: 'Retake was not offered for this session' });
  if (session.retake_taken) return res.status(400).json({ error: 'Retake already taken' });

  db.run('UPDATE exam_sessions SET retake_taken = 1 WHERE session_id = ?', [sessionId]);
  saveDb();

  auditLog(req.session.serviceNo, 'retake_taken', 'info', { sessionId, originalSessionId: sessionId });

  // Create a new retake session (frontend will build session from new config)
  res.json({ ok: true, retakeStarted: true });
});

// ── Session management ──────────────────────────────────────
function generateSessionId() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/1/O/I/L
  let id = '';
  for (let i = 0; i < 5; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// Create a new exam session (called from frontend when exam starts)
app.post('/api/sessions', requireSession, (req, res) => {
  const { mode, complexity = 50, questions, examinerName } = req.body;
  if (!mode || !['practice', 'official'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be "practice" or "official"' });
  }
  if (!questions || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'questions array required' });
  }
  if (mode === 'official') {
    const sessionUser = db.prepare('SELECT * FROM users WHERE id = ?');
    sessionUser.bind([req.session.userId]);
    const user = firstRow(sessionUser);
    if (!user) return res.status(401).json({ error: 'User not found' });

    // Mode 2 gating — reject any question that is not servable:
    // 1. status must be 'active' (not retired/superseded)
    // 2. source='bank' questions are always approved (curated)
    // 3. source='generated' questions require review_status='approved'
    const qIds = questions.map(q => q.id);
    const placeholders = qIds.map(() => '?').join(',');
    const gateStmt = db.prepare(
      `SELECT id, source, review_status, status FROM questions
       WHERE id IN (${placeholders})
       AND NOT (status = 'active' AND (source = 'bank' OR (source = 'generated' AND review_status = 'approved')))`
    );
    gateStmt.bind(qIds);
    const blocked = [];
    while (gateStmt.step()) blocked.push(gateStmt.getAsObject());
    gateStmt.free();
    if (blocked.length > 0) {
      auditLog(req.session.serviceNo, 'session_blocked_question_gate', 'warning', {
        blockedCount: blocked.length,
        blockedIds: blocked.map(r => r.id)
      });
      return res.status(403).json({
        error: `${blocked.length} question(s) are not eligible for official exams (retired, superseded, or not approved).`,
        code: 'QUESTION_GATE_BLOCKED',
        blockedIds: blocked.map(r => r.id)
      });
    }
  }

  const sessionId = generateSessionId();
  const now = new Date().toISOString();

  // Store question IDs as JSON for the session (snapshot)
  const questionIds = JSON.stringify(questions.map((q, i) => ({ index: i, id: q.id })));

  db.run(
    'INSERT INTO exam_sessions (session_id, examinee_service_no, mode, complexity, status, started_at, result_data) VALUES (?, ?, ?, ?, \'in_progress\', datetime(\'now\'), ?)',
    [sessionId, req.session.serviceNo, mode, complexity, questionIds]
  );
  saveDb();

  auditLog(req.session.serviceNo, 'session_created', 'info', {
    sessionId,
    mode,
    complexity,
    questionCount: questions.length
  });

  res.status(201).json({
    sessionId,
    mode,
    complexity,
    startedAt: now,
    questionCount: questions.length
  });
});

// Record tab-switch (Mode 2 only)
app.post('/api/sessions/:sessionId/tab-switch', requireSession, (req, res) => {
  const { sessionId } = req.params;
  
  const sessionStmt = db.prepare('SELECT * FROM exam_sessions WHERE session_id = ? AND examinee_service_no = ?');
  sessionStmt.bind([sessionId, req.session.serviceNo]);
  const session = firstRow(sessionStmt);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.mode !== 'official') {
    return res.status(400).json({ error: 'Tab-switch tracking only applies to Mode 2 (official) exams' });
  }
  if (session.status !== 'in_progress') {
    return res.status(400).json({ error: 'Session is not in progress' });
  }

  db.run('UPDATE exam_sessions SET tab_switches = tab_switches + 1 WHERE session_id = ?', [sessionId]);
  saveDb();

  auditLog(req.session.serviceNo, 'tab_switch', 'warning', {
    sessionId,
    tabSwitches: (session.tab_switches || 0) + 1
  });

  res.json({ ok: true, tabSwitches: (session.tab_switches || 0) + 1 });
});

// Get active session for current user
app.get('/api/sessions/active', requireSession, (req, res) => {
  const stmt = db.prepare(
    "SELECT * FROM exam_sessions WHERE examinee_service_no = ? AND status = 'in_progress' ORDER BY started_at DESC LIMIT 1"
  );
  stmt.bind([req.session.serviceNo]);
  const session = firstRow(stmt);
  if (!session) return res.json({ session: null });
  res.json({
    session: {
      sessionId: session.session_id,
      mode: session.mode,
      complexity: session.complexity,
      status: session.status,
      startedAt: session.started_at,
      tabSwitches: session.tab_switches,
      mode2LicenseVerified: session.mode2_license_verified,
      mode2SupervisorWitnessed: session.mode2_supervisor_witnessed
    }
  });
});

// ── Questions API ───────────────────────────────────────────

// Validators
function validateQuestionData(data, partial = false) {
  const errors = [];
  if (!partial) {
    if (!data.document) errors.push('document is required');
    if (!data.question) errors.push('question text is required');
    if (!data.q_type) errors.push('q_type is required (mcq, true_false, fib)');
    if (!['mcq', 'true_false', 'fib'].includes(data.q_type)) errors.push('q_type must be mcq, true_false, or fib');
    if (data.q_type !== 'fib') {
      if (!data.options) errors.push('options are required for mcq/true_false');
      if (!data.correct_answer) errors.push('correct_answer is required');
    }
  }
  if (data.options !== undefined) {
    const opts = data.options;
    const count = Array.isArray(opts) ? opts.length : Object.keys(opts).length;
    if (count < 2 || count > 6) errors.push('options must have 2-6 items');
  }
  if (data.q_type === 'true_false') {
    // true_false options must be exactly 2: True/False
    if (data.options && Array.isArray(data.options) && data.options.length !== 2) {
      errors.push('true_false must have exactly 2 options');
    }
  }
  if (data.difficulty && !['easy', 'medium', 'hard'].includes(data.difficulty)) {
    errors.push('difficulty must be easy, medium, or hard');
  }
  if (data.status && !['active', 'under_review', 'retired', 'superseded'].includes(data.status)) {
    errors.push('invalid status');
  }
  if (data.review_status && !['pending', 'reviewed', 'approved', 'rejected'].includes(data.review_status)) {
    errors.push('invalid review_status');
  }
  return errors;
}

function parseOptionsForDb(options) {
  // Normalize to JSON string for storage.
  // Store as array internally; legacy {A:...,B:...} objects are converted.
  if (Array.isArray(options)) return JSON.stringify(options);
  if (options && typeof options === 'object') {
    // Convert legacy object {A:"text",B:"text"} to array ["text","text"]
    return JSON.stringify(Object.values(options));
  }
  return '[]';
}

function parseOptionsFromDb(optionsStr) {
  if (!optionsStr) return [];
  try {
    const parsed = JSON.parse(optionsStr);
    return parsed;
  } catch {
    return [];
  }
}

// GET /api/questions — list with v2 filters
app.get('/api/questions', requireSession, (req, res) => {
  const {
    document, topic, difficulty, status, q_type, source,
    review_status, limit = 50, offset = 0
  } = req.query;
  let sql = 'SELECT * FROM questions WHERE 1=1';
  const params = [];

  if (document) { sql += ' AND document = ?'; params.push(document); }
  if (topic) { sql += ' AND topic = ?'; params.push(topic); }
  if (difficulty) { sql += ' AND difficulty = ?'; params.push(difficulty); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (q_type) { sql += ' AND q_type = ?'; params.push(q_type); }
  if (source) { sql += ' AND source = ?'; params.push(source); }
  if (review_status) { sql += ' AND review_status = ?'; params.push(review_status); }
  sql += ' ORDER BY id LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));

  const stmt = db.prepare(sql);
  stmt.bind(params);
  const questions = allRows(stmt);

  const countStmt = db.prepare('SELECT COUNT(*) as total FROM questions');
  const count = firstRow(countStmt);

  res.json({ questions, total: count.total });
});

app.get('/api/questions/documents', requireSession, (req, res) => {
  const stmt = db.prepare('SELECT DISTINCT document FROM questions ORDER BY document');
  const rows = allRows(stmt);
  res.json(rows.map(r => r.document));
});

app.get('/api/questions/topics', requireSession, (req, res) => {
  const { document } = req.query;
  let sql = 'SELECT DISTINCT topic FROM questions';
  const params = [];
  if (document) { sql += ' WHERE document = ?'; params.push(document); }
  sql += ' ORDER BY topic';
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = allRows(stmt);
  res.json(rows.map(r => r.topic));
});

app.get('/api/questions/:id', requireSession, (req, res) => {
  const stmt = db.prepare('SELECT * FROM questions WHERE id = ?');
  stmt.bind([req.params.id]);
  const q = firstRow(stmt);
  if (!q) return res.status(404).json({ error: 'Question not found' });
  res.json(q);
});

// POST /api/questions — create new question
app.post('/api/questions', requireSession, requireRole('qb_editor'), (req, res) => {
  const data = req.body;
  const errors = validateQuestionData(data);
  if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });

  const now = new Date().toISOString();
  const options = parseOptionsForDb(data.options || {});
  const applicability = typeof data.applicability === 'string' ? data.applicability : JSON.stringify(data.applicability || { qualification_groups: [], locations: [] });
  const tags = JSON.stringify(data.tags || []);

  const stmt = db.prepare(
    `INSERT INTO questions (source, document, chapter, topic, difficulty, question, options, correct_answer, explanation, tags, q_type, source_section, source_paragraph, effective_date, airac_cycle, status, applicability, version, superseded_by, review_status, reviewed_by, validated, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, 0, ?, ?)`
  );
  stmt.bind([
    data.source || 'bank',
    data.document,
    data.chapter || '',
    data.topic || '',
    data.difficulty || 'medium',
    data.question,
    options,
    data.correct_answer || '',
    data.explanation || '',
    tags,
    data.q_type || 'mcq',
    data.source_section || '',
    data.source_paragraph || '',
    data.effective_date || null,
    data.airac_cycle || '',
    data.status || 'active',
    applicability,
    data.review_status || 'pending',
    data.reviewed_by || null,
    now, now
  ]);
  stmt.step();
  stmt.free();
  saveDb();

  const newId = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
  // Seed analytics row
  db.run('INSERT OR IGNORE INTO question_analytics (question_id) VALUES (?)', [newId]);
  saveDb();

  auditLog(req.session.serviceNo, 'question_created', 'info', {
    questionId: newId, document: data.document, q_type: data.q_type
  });

  const getStmt = db.prepare('SELECT * FROM questions WHERE id = ?');
  getStmt.bind([newId]);
  const created = firstRow(getStmt);
  res.status(201).json(created);
});

// PUT /api/questions/:id — update question (creates new version)
app.put('/api/questions/:id', requireSession, requireRole('qb_editor'), (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  const existing = db.prepare('SELECT * FROM questions WHERE id = ?');
  existing.bind([id]);
  const old = firstRow(existing);
  if (!old) return res.status(404).json({ error: 'Question not found' });

  const data = req.body;
  const errors = validateQuestionData(data, true);
  if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });

  const now = new Date().toISOString();

  // Supersede old row
  db.run('UPDATE questions SET superseded_by = ?, status = ?, updated_at = ? WHERE id = ?', [
    -1, 'superseded', now, id
  ]);

  // Build new version row (inherit from old + merge updates)
  const options = data.options !== undefined ? parseOptionsForDb(data.options) : old.options;
  const applicability = data.applicability !== undefined
    ? (typeof data.applicability === 'string' ? data.applicability : JSON.stringify(data.applicability))
    : old.applicability;
  const tags = data.tags !== undefined ? JSON.stringify(data.tags) : old.tags;

  const stmt = db.prepare(
    `INSERT INTO questions (source, document, chapter, topic, difficulty, question, options, correct_answer, explanation, tags, q_type, source_section, source_paragraph, effective_date, airac_cycle, status, applicability, version, superseded_by, review_status, reviewed_by, validated, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, ?, ?)`
  );
  stmt.bind([
    data.source || old.source,
    data.document || old.document,
    data.chapter !== undefined ? data.chapter : old.chapter,
    data.topic !== undefined ? data.topic : old.topic,
    data.difficulty || old.difficulty,
    data.question || old.question,
    options,
    data.correct_answer !== undefined ? data.correct_answer : old.correct_answer,
    data.explanation !== undefined ? data.explanation : old.explanation,
    tags,
    data.q_type || old.q_type,
    data.source_section !== undefined ? data.source_section : (old.source_section || ''),
    data.source_paragraph !== undefined ? data.source_paragraph : (old.source_paragraph || ''),
    data.effective_date !== undefined ? data.effective_date : (old.effective_date || null),
    data.airac_cycle !== undefined ? data.airac_cycle : (old.airac_cycle || ''),
    data.status || old.status,
    applicability,
    (old.version || 1) + 1,
    data.review_status || old.review_status,
    data.reviewed_by !== undefined ? data.reviewed_by : (old.reviewed_by || null),
    now, now
  ]);
  stmt.step();
  stmt.free();
  saveDb();

  const newId = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];

  // Link old row to new
  db.run('UPDATE questions SET superseded_by = ? WHERE id = ?', [newId, id]);
  saveDb();

  // Seed analytics for new version
  db.run('INSERT OR IGNORE INTO question_analytics (question_id) VALUES (?)', [newId]);
  saveDb();

  auditLog(req.session.serviceNo, 'question_updated', 'info', {
    oldId: id,
    newId,
    version: (old.version || 1) + 1,
    document: data.document || old.document,
    oldStatus: old.status,
    newStatus: data.status || old.status,
    oldReviewStatus: old.review_status,
    newReviewStatus: data.review_status || old.review_status
  });

  const getStmt = db.prepare('SELECT * FROM questions WHERE id = ?');
  getStmt.bind([newId]);
  const created = firstRow(getStmt);
  res.json(created);
});

// DELETE /api/questions/:id — soft retire (only if not superseded already)
app.delete('/api/questions/:id', requireSession, requireRole('qb_editor'), (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  const existing = db.prepare('SELECT * FROM questions WHERE id = ?');
  existing.bind([id]);
  const q = firstRow(existing);
  if (!q) return res.status(404).json({ error: 'Question not found' });
  if (q.status === 'superseded') return res.status(400).json({ error: 'Cannot retire a superseded question' });
  if (q.status === 'retired') return res.status(400).json({ error: 'Question already retired' });

  const now = new Date().toISOString();
  db.run('UPDATE questions SET status = ?, updated_at = ?, reviewed_by = ? WHERE id = ?', [
    'retired', now, req.session.serviceNo, id
  ]);
  saveDb();

  auditLog(req.session.serviceNo, 'question_retired', 'info', { questionId: id, document: q.document });
  res.json({ ok: true, id, status: 'retired' });
});

// POST /api/questions/import — bulk import from per-document JSON format
app.post('/api/questions/import', requireSession, requireRole('qb_editor'), (req, res) => {
  const data = req.body;
  if (!data || !data.questions || !Array.isArray(data.questions)) {
    return res.status(400).json({ error: 'Request body must have a "questions" array' });
  }

  const document = data._document || data.document || '';
  const results = { imported: 0, updated: 0, errors: [] };
  const now = new Date().toISOString();

  for (let i = 0; i < data.questions.length; i++) {
    const q = data.questions[i];
    try {
      const options = parseOptionsForDb(q.options || {});
      const applicability = JSON.stringify(q.applicability || { qualification_groups: [], locations: [] });
      const tags = JSON.stringify(q.tags || []);

      if (q.id) {
        // Check if exists
        const check = db.prepare('SELECT id FROM questions WHERE id = ?');
        check.bind([q.id]);
        const exists = firstRow(check);
        if (exists) {
          // Update existing
          db.run(
            `UPDATE questions SET source=?, document=?, chapter=?, topic=?, difficulty=?, question=?, options=?, correct_answer=?, explanation=?, tags=?, q_type=?, source_section=?, source_paragraph=?, effective_date=?, airac_cycle=?, status=?, applicability=?, review_status=?, reviewed_by=?, updated_at=?
             WHERE id=?`,
            [
              q.source || 'bank', q.document || document, q.chapter || '', q.topic || '',
              q.difficulty || 'medium', q.question || '', options,
              q.correct_answer || 'A', q.explanation || '', tags,
              q.q_type || 'mcq', q.source_section || '', q.source_paragraph || '',
              q.effective_date || null, q.airac_cycle || '',
              q.status || 'active', applicability,
              q.review_status || 'reviewed', q.reviewed_by || null, now, q.id
            ]
          );
          saveDb();
          results.updated++;
          continue;
        }
      }

      // Insert new
      const newId = q.id || null;
      if (newId) {
        db.run(
          `INSERT INTO questions (id, source, document, chapter, topic, difficulty, question, options, correct_answer, explanation, tags, q_type, source_section, source_paragraph, effective_date, airac_cycle, status, applicability, version, superseded_by, review_status, reviewed_by, validated, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, 0, ?, ?)`,
          [
            newId, q.source || 'bank', q.document || document, q.chapter || '', q.topic || '',
            q.difficulty || 'medium', q.question || '', options,
            q.correct_answer || 'A', q.explanation || '', tags,
            q.q_type || 'mcq', q.source_section || '', q.source_paragraph || '',
            q.effective_date || null, q.airac_cycle || '',
            q.status || 'active', applicability,
            q.review_status || 'reviewed', q.reviewed_by || null, now, now
          ]
        );
      } else {
        db.run(
          `INSERT INTO questions (source, document, chapter, topic, difficulty, question, options, correct_answer, explanation, tags, q_type, source_section, source_paragraph, effective_date, airac_cycle, status, applicability, version, superseded_by, review_status, reviewed_by, validated, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, 0, ?, ?)`,
          [
            q.source || 'bank', q.document || document, q.chapter || '', q.topic || '',
            q.difficulty || 'medium', q.question || '', options,
            q.correct_answer || 'A', q.explanation || '', tags,
            q.q_type || 'mcq', q.source_section || '', q.source_paragraph || '',
            q.effective_date || null, q.airac_cycle || '',
            q.status || 'active', applicability,
            q.review_status || 'reviewed', q.reviewed_by || null, now, now
          ]
        );
      }
      saveDb();

      const insertedId = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
      db.run('INSERT OR IGNORE INTO question_analytics (question_id) VALUES (?)', [insertedId]);
      saveDb();

      results.imported++;
    } catch (err) {
      results.errors.push(`Row ${i} (id=${q.id || 'new'}): ${err.message}`);
    }
  }

  auditLog(req.session.serviceNo, 'questions_imported', 'info', {
    document, imported: results.imported, updated: results.updated, errors: results.errors.length
  });

  res.json(results);
});

// GET /api/questions/export/:document — export to per-document JSON format
app.get('/api/questions/export/:document', requireSession, requireRole('qb_editor'), (req, res) => {
  const document = req.params.document;
  const stmt = db.prepare('SELECT * FROM questions WHERE document = ? AND status != \'superseded\' ORDER BY id');
  stmt.bind([document]);
  const rows = allRows(stmt);

  const questions = rows.map(q => ({
    id: q.id,
    source: q.source,
    q_type: q.q_type,
    document: q.document,
    chapter: q.chapter,
    topic: q.topic,
    difficulty: q.difficulty,
    question: q.question,
    options: parseOptionsFromDb(q.options),
    correct_answer: q.correct_answer,
    explanation: q.explanation,
    tags: JSON.parse(q.tags || '[]'),
    source_section: q.source_section,
    source_paragraph: q.source_paragraph,
    effective_date: q.effective_date,
    airac_cycle: q.airac_cycle,
    status: q.status,
    applicability: JSON.parse(q.applicability || '{}'),
    version: q.version,
    superseded_by: q.superseded_by,
    review_status: q.review_status,
    reviewed_by: q.reviewed_by
  }));

  res.json({
    _schema_version: '2.1',
    _last_updated: new Date().toISOString(),
    _document: document,
    _total_questions: questions.length,
    questions
  });
});

// ── Eligibility resolver (Task 07) ──────────────────────────
// POST /api/eligibility/resolve — resolve exam eligibility for an examinee
// Writes an audit entry (info) when transition_window is true.
app.post('/api/eligibility/resolve', requireSession, async (req, res) => {
  const { serviceNo, examType } = req.body;
  if (!serviceNo) return res.status(400).json({ error: 'serviceNo required' });

  let qualificationsConfig, complexityConfig;
  try {
    qualificationsConfig = JSON.parse(readFileSync(join(__dirname, 'config', 'qualifications.json'), 'utf-8'));
    complexityConfig = JSON.parse(readFileSync(join(__dirname, 'config', 'complexity-mapping.json'), 'utf-8'));
  } catch {
    return res.status(500).json({ error: 'Failed to load config files' });
  }

  const result = await eligibility.resolveEligibility(serviceNo, examType || 'unit_test', {
    db,
    getValidRatings: rtlDb.getValidRatings,
    qualificationsConfig,
    complexityConfig
  });

  if (!result.ok) {
    return res.status(400).json({ error: result.code });
  }

  // Audit log if transition_window is true (so HQ can track stub hits)
  if (result.eligibility.transition_window) {
    auditLog(req.session.serviceNo, 'eligibility_transition_window', 'info', {
      targetServiceNo: serviceNo,
      qualificationGroup: result.eligibility.qualification_group,
      transitionNote: result.eligibility.transition_note,
      tenantId: result.eligibility.tenant_id
    }, result.eligibility.tenant_id);
  }

  res.json(result.eligibility);
});

// ── RBAC / role assignment (Task 05/06) ──────────────────────
// PUT /api/users/:serviceNo/role — grant or revoke a local role (sys_admin only)
// Writes an audit entry with before/after state. Severity: warning (role changes are sensitive).
app.put('/api/users/:serviceNo/role', requireSession, requireRole('sys_admin'), (req, res) => {
  const { serviceNo } = req.params;
  const { role, action } = req.body;
  if (!role || !['examiner', 'qb_editor', 'sys_admin', 'tech_admin', 'supervisor'].includes(role)) {
    return res.status(400).json({ error: 'Valid role required (examiner, qb_editor, sys_admin, tech_admin, supervisor)' });
  }
  if (!action || !['grant', 'revoke'].includes(action)) {
    return res.status(400).json({ error: 'action must be "grant" or "revoke"' });
  }
  // Read current role state for before/after context
  const beforeStmt = db.prepare('SELECT * FROM users WHERE service_no = ?');
  beforeStmt.bind([serviceNo]);
  const before = firstRow(beforeStmt);
  if (!before) return res.status(404).json({ error: 'User not found' });
  const colMap = { examiner: 'role_examiner', qb_editor: 'role_qb_editor', sys_admin: 'role_sys_admin', tech_admin: 'role_tech_admin', supervisor: 'role_supervisor' };
  const col = colMap[role];
  const oldVal = !!before[col];
  const grantVal = action === 'grant';
  if (oldVal === grantVal) {
    return res.status(409).json({ error: `Role '${role}' is already ${grantVal ? 'granted' : 'revoked'} for this user` });
  }
  db.run(`UPDATE users SET ${col} = ?, updated_at = datetime('now') WHERE service_no = ?`, [grantVal ? 1 : 0, serviceNo]);
  saveDb();
  const afterStmt = db.prepare('SELECT * FROM users WHERE service_no = ?');
  afterStmt.bind([serviceNo]);
  const after = firstRow(afterStmt);
  const auditAction = grantVal ? 'role_granted' : 'role_revoked';
  auditLog(req.session.serviceNo, auditAction, 'warning', {
    targetServiceNo: serviceNo, role, action,
    oldState: oldVal, newState: grantVal,
    tenantId: after.tenant_id || null
  }, after.tenant_id || null);
  // If sys_admin revoked from self, destroy session
  if (serviceNo === req.session.serviceNo && role === 'sys_admin' && !grantVal) {
    auditLog(req.session.serviceNo, 'self_role_revoked', 'warning', { serviceNo, role });
    req.session.destroy(() => {});
    return res.json({ user: after, sessionDestroyed: true });
  }
  res.json({ user: after });
});

// PUT /api/users/:serviceNo/active — activate/deactivate user (sys_admin only)
app.put('/api/users/:serviceNo/active', requireSession, requireRole('sys_admin'), (req, res) => {
  const { serviceNo } = req.params;
  const { active } = req.body;
  if (active === undefined) return res.status(400).json({ error: 'active field required' });
  db.run('UPDATE users SET is_active = ?, updated_at = datetime(\'now\') WHERE service_no = ?', [active ? 1 : 0, serviceNo]);
  saveDb();
  auditLog(req.session.serviceNo, active ? 'user_activated' : 'user_deactivated', 'warning', { targetServiceNo: serviceNo });
  const stmt = db.prepare('SELECT * FROM users WHERE service_no = ?');
  stmt.bind([serviceNo]);
  const row = firstRow(stmt);
  res.json({ user: row });
});

// GET /api/users — list users (sys_admin or examiner)
app.get('/api/users', requireSession, requireRole('sys_admin', 'examiner'), (req, res) => {
  const { role, tenantId, activeOnly } = req.query;
  const filters = {};
  if (role) filters.role = role;
  if (tenantId) filters.tenantId = tenantId;
  if (activeOnly === 'false') filters.activeOnly = false;
  const users = rbac.listUsers(filters, db);
  res.json({ users });
});

// GET /api/users/:serviceNo — get single user (authenticated)
app.get('/api/users/:serviceNo', requireSession, (req, res) => {
  const { serviceNo } = req.params;
  const stmt = db.prepare('SELECT * FROM users WHERE service_no = ?');
  stmt.bind([serviceNo]);
  const row = firstRow(stmt);
  if (!row) return res.status(404).json({ error: 'User not found' });
  res.json({ user: row });
});

// ── Audit log query ─────────────────────────────────────────
app.get('/api/audit', requireSession, requireRole('sys_admin', 'supervisor'), (req, res) => {
  const { limit = 100, offset = 0 } = req.query;
  const stmt = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?');
  stmt.bind([Number(limit), Number(offset)]);
  const logs = allRows(stmt);
  const countStmt = db.prepare('SELECT COUNT(*) as total FROM audit_log');
  const count = firstRow(countStmt);
  res.json({ logs, total: count.total });
});

// ── RTL-db result push (supervisor-initiated) ─────────────
app.post('/api/results/push', requireSession, requireRole('supervisor'), async (req, res) => {
  const { sessionIds } = req.body;
  if (!sessionIds || !Array.isArray(sessionIds) || sessionIds.length === 0) {
    return res.status(400).json({ error: 'sessionIds array required' });
  }

  // Fetch finalized results for the requested sessions
  const placeholders = sessionIds.map(() => '?').join(',');
  const stmt = db.prepare(
    `SELECT er.*, es.examinee_service_no AS service_no
     FROM exam_results er
     JOIN exam_sessions es ON er.session_id = es.session_id
     WHERE er.session_id IN (${placeholders})
     AND er.is_final = 1
     AND er.pushed_to_rtldb = 0`
  );
  stmt.bind(sessionIds);
  const results = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();

  if (results.length === 0) {
    return res.status(400).json({ error: 'No finalized unpushed results found for given sessions' });
  }

  let pushed = 0;
  let queued = 0;
  const errors = [];

  for (const row of results) {
    const pushResult = await rtlDb.pushResult({
      session_id: row.session_id,
      service_no: row.service_no,
      score_pct: row.score_pct,
      total_questions: row.total_questions,
      correct_count: row.correct_count,
      completed_at: row.completed_at || row.finalized_at || row.created_at
    });

    if (pushResult.pushed) {
      db.run('UPDATE exam_results SET pushed_to_rtldb = 1, pushed_at = datetime(\'now\') WHERE session_id = ?', [row.session_id]);
      saveDb();
      pushed++;
    } else {
      queued++;
      errors.push(row.session_id);
    }
  }

  auditLog(req.session.serviceNo, 'results_push_batch', 'info', {
    requestedCount: sessionIds.length, pushed, queued, errors: errors.length
  });

  res.json({ ok: true, pushed, queued, errors: errors.length > 0 ? errors : undefined });
});

// Get push queue status (supervisor)
app.get('/api/results/push-queue', requireSession, requireRole('supervisor'), (req, res) => {
  const stmt = db.prepare("SELECT * FROM result_push_queue ORDER BY queued_at DESC LIMIT 100");
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  res.json({ queue: rows });
});

// Retry queued pushes (supervisor-initiated batch)
app.post('/api/results/retry-push', requireSession, requireRole('supervisor'), async (req, res) => {
  const { queueIds } = req.body;
  const result = await rtlDb.retryPushQueue(queueIds || null);
  auditLog(req.session.serviceNo, 'results_retry_batch', 'info', {
    pushed: result.pushed, failed: result.failed
  });
  res.json(result);
});

// ── Cache refresh endpoint (admin only) ──────────────────────
app.post('/api/cache/refresh', requireSession, requireRole('sys_admin', 'tech_admin'), async (req, res) => {
  const { serviceNo } = req.body;
  if (!serviceNo) {
    return res.status(400).json({ error: 'serviceNo required' });
  }
  const result = await rtlDb.lookupPersonnel(serviceNo);
  if (!result.ok) {
    return res.status(502).json({ error: 'RTL-db lookup failed', code: result.code });
  }
  auditLog(req.session.serviceNo, 'cache_refresh_manual', 'info', { serviceNo });
  res.json({ ok: true, serviceNo, data: result.data });
});

// ── Static files ────────────────────────────────────────────
app.use(express.static(join(__dirname)));

// ── SPA fallback ────────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(join(__dirname, 'index.html'));
});

// ── Start ───────────────────────────────────────────────────
async function start() {
  await getDb();
  app.listen(PORT, () => {
    console.log(`ATC Exam System v2 — http://localhost:${PORT}`);
    console.log(`  Mode: ${process.env.NODE_ENV || 'development'}`);
    console.log(`  DB: ${DB_PATH}`);
  });
}

start();