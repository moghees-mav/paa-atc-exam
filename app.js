'use strict';

// ============================================================
// LAYER 1: CONSTANTS
// ============================================================
const CONFIG_PATH = 'config/app.config.json';
const QUALIFICATIONS_PATH = 'config/qualifications.json';
const DATA_PATH = 'data/questions.json';
const SESSION_KEY = 'atc_exam_session';

// Legacy key, no longer written to as of this build — left here only so any existing
// browsers with old data don't throw on read. Safe to remove entirely in a future cleanup pass.
const HISTORY_KEY = 'atc_exam_history';
const MAX_HISTORY = 10;

// New storage keys (v1: localStorage: v2: these become API endpoints via StorageLayer)
const EXAM_INDEX_KEY = 'atc_exam_index';
const EXAM_DETAIL_PREFIX = 'atc_exam_detail_';
const FEATURE_REQUEST_KEY = 'atc_feature_requests';
const CUSTOM_QUESTIONS_KEY = 'atc_custom_questions';
const ADMIN_PASSWORD_KEY = 'atc_admin_password';
const ADMIN_PASSWORD_LAST_CHANGED_KEY = 'atc_password_last_changed';
const PASSWORD_EXPIRY_DAYS = 30;
const PASSWORD_WARN_DAYS = 5;

// Placeholder auth only — NOT real security. Anyone with browser devtools can bypass this
// entirely. Replace with real authentication before this is ever exposed beyond a trusted room.
const ADMIN_PASSWORD = 'Admin123';

// Exam ID: 5 chars, excludes 0/1/O/I/L to avoid confusion when read aloud or handwritten.
const EXAM_ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const EXAM_ID_LENGTH = 5;

// Retention policy (tune later based on observed localStorage usage):
// - Detail records older than ARCHIVE_AFTER_MONTHS get their per-question snapshot trimmed
//   to correct/incorrect status only (drops verbatim question text/options/explanations).
// - Detail records older than PURGE_AFTER_YEARS get deleted outright; their index entry remains
//   for historical stats but Replay/full-detail view will no longer work for them.
const RETENTION_ARCHIVE_AFTER_MONTHS = 6;
const RETENTION_PURGE_AFTER_YEARS = 5;

/**
 * Capped water-filling allocator, shared by the distribution UI and the actual question
 * selection logic. Hands out `target` units across `items` ([{key, poolSize}]), never
 * exceeding any single item's poolSize, redistributing whatever a capped item couldn't
 * take to the remaining items, round by round, until the target is met or everything is
 * capped. If `weighted` is true, each round's shares are proportional to poolSize
 * (bigger pools get more); otherwise shares are equal.
 */
function waterFillAllocate(target, items, weighted) {
  const state = items.map(it => ({ key: it.key, cap: Math.max(0, it.poolSize), alloc: 0, capped: it.poolSize <= 0 }));
  const totalWeight = weighted ? items.reduce((sum, it) => sum + it.poolSize, 0) : items.length;
  let remaining = Math.max(0, target);
  let guard = 0;
  while (remaining > 0 && guard < 1000) {
    guard++;
    const active = state.filter(s => !s.capped);
    if (active.length === 0) break;
    let allocatedThisRound = 0;
    for (const s of active) {
      if (remaining <= 0) break;
      const weight = weighted
        ? (items.find(it => it.key === s.key).poolSize / (totalWeight || 1))
        : (1 / active.length);
      let give = Math.max(1, Math.round(weight * remaining));
      give = Math.min(give, s.cap - s.alloc, remaining);
      if (give <= 0) { s.capped = true; continue; }
      s.alloc += give;
      remaining -= give;
      allocatedThisRound += give;
      if (s.alloc >= s.cap) s.capped = true;
    }
    if (allocatedThisRound === 0) break;
  }
  const result = {};
  state.forEach(s => { result[s.key] = s.alloc; });
  return result;
}

function updateUtcClock() {
  const el = document.getElementById('utc-clock');
  if (!el) return;
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  el.textContent = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} UTC`;
}

// ============================================================
// LAYER 2: DATA LAYER
// ============================================================
const DataLayer = {
  questions: [],
  config: {},
  qualifications: { qualifications: [] },
  meta: {},

  async init() {
    this.config = await fetch(CONFIG_PATH).then(r => r.json());
    this.qualifications = await fetch(QUALIFICATIONS_PATH).then(r => r.json());
    const db = await fetch(DATA_PATH).then(r => r.json());
    this.questions = db.questions;

    // Merge custom question edits from localStorage (admin CRUD)
    const custom = await StorageLayer.getCustomQuestionEdits();
    if (custom) {
      // Deleted: remove any question whose id is in the deleted array
      if (Array.isArray(custom.deleted) && custom.deleted.length > 0) {
        const deleteSet = new Set(custom.deleted);
        this.questions = this.questions.filter(q => !deleteSet.has(q.id));
      }
      // Edited: replace matching questions with the custom version
      if (custom.edited && typeof custom.edited === 'object') {
        this.questions = this.questions.map(q => {
          return custom.edited[q.id] ? { ...custom.edited[q.id] } : q;
        });
      }
      // Added: append all custom-added questions
      if (Array.isArray(custom.added) && custom.added.length > 0) {
        this.questions = this.questions.concat(custom.added.map(a => ({ ...a })));
      }
    }

    this.meta = {
      total: this.questions.length,
      documents: [...new Set(this.questions.map(q => q.document))].sort(),
      chapters: [...new Set(this.questions.map(q => q.chapter))].sort(),
    };
  },

    query(filters = {}) {
    return this.questions.filter(q => {
      if (filters.documents?.length && !filters.documents.includes(q.document)) return false;
      if (filters.chapters?.length && !filters.chapters.includes(q.chapter)) return false;
      if (filters.difficulty?.length && !filters.difficulty.includes(q.difficulty)) return false;
      return true;
    });
  },

  getChaptersForDocument(docName) {
    return [...new Set(this.questions.filter(q => q.document === docName).map(q => q.chapter))].sort();
  },

  /**
   * Select questions from a pool with difficulty distribution.
   * @param {Array} pool - The question pool
   * @param {number} targetCount - Number of questions to select
   * @param {Object} difficultyDist - e.g. { easy: 0.5, medium: 0.3, hard: 0.2 }
   */
  selectWithDifficultyDistribution(pool, targetCount, difficultyDist) {
    if (!difficultyDist || Object.keys(difficultyDist).length === 0) {
      // No distribution specified, just shuffle and slice
      const shuffled = [...pool];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      return shuffled.slice(0, targetCount);
    }

    const selected = [];
    let remaining = targetCount;
    const difficulties = ['easy', 'medium', 'hard'];

    for (const diff of difficulties) {
      const proportion = difficultyDist[diff] || 0;
      if (proportion <= 0) continue;
      let count = Math.round(proportion * targetCount);
      if (count < 1 && proportion > 0) count = 1;
      if (count > remaining) count = remaining;

      const subset = pool.filter(q => q.difficulty === diff);
      const shuffled = [...subset];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      selected.push(...shuffled.slice(0, count));
      remaining -= count;
    }

    // Fill any remaining slots from remaining pool
    if (remaining > 0) {
      const usedIds = new Set(selected.map(q => q.id));
      const rest = pool.filter(q => !usedIds.has(q.id));
      const shuffled = [...rest];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      selected.push(...shuffled.slice(0, remaining));
    }

    // Final shuffle
    for (let i = selected.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [selected[i], selected[j]] = [selected[j], selected[i]];
    }
        return selected;
  }
};

// ============================================================
// LAYER 2.5: STORAGE LAYER
// All persistence goes through here. Every method returns a Promise even though v1's
// implementation is synchronous localStorage — this is deliberate, so v2 can swap the
// internals for real fetch() calls without any caller needing to change.
// ============================================================
const StorageLayer = {

  generateExamId(existingIds) {
    const makeId = () => {
      let id = '';
      for (let i = 0; i < EXAM_ID_LENGTH; i++) {
        id += EXAM_ID_ALPHABET[Math.floor(Math.random() * EXAM_ID_ALPHABET.length)];
      }
      return id;
    };
    let id = makeId();
    let attempts = 0;
    while (existingIds.has(id) && attempts < 20) {
      id = makeId();
      attempts++;
    }
    return id;
  },

  async getExamIndex() {
    const raw = localStorage.getItem(EXAM_INDEX_KEY);
    return raw ? JSON.parse(raw) : [];
  },

  async _writeExamIndex(index) {
    localStorage.setItem(EXAM_INDEX_KEY, JSON.stringify(index));
  },

  async getExamDetail(examId) {
    const raw = localStorage.getItem(EXAM_DETAIL_PREFIX + examId);
    return raw ? JSON.parse(raw) : null;
  },

  async saveExam(results) {
    const index = await this.getExamIndex();
    const existingIds = new Set(index.map(e => e.exam_id));
    const examId = this.generateExamId(existingIds);

    const indexEntry = {
      exam_id: examId,
      created_at: results.created_at,
      graded_at: results.graded_at,
      examinee_name: results.examinee?.name || '',
      examinee_designation: results.examinee?.designation || '',
      examinee_serviceno: results.examinee?.serviceNo || '',
      examiner_name: results.examiner || '',
      qualification: results.config?.filters ? (results.config.filters.chapters?.[0] || results.config.filters.documents?.[0] || '') : '',
      score_percent: results.score.percent,
      passed: results.passed,
      time_taken_seconds: results.time_taken_seconds,
      flagged_count: (results.question_results || []).filter(q => q.flagged).length,
      archived: false,
      purged: false
    };
    index.unshift(indexEntry);
    await this._writeExamIndex(index);

    localStorage.setItem(EXAM_DETAIL_PREFIX + examId, JSON.stringify(results));
    await this.runRetentionSweep();
    return examId;
  },

  async updateFlaggedRemarks(examId, remarksMap) {
    const raw = localStorage.getItem(EXAM_DETAIL_PREFIX + examId);
    if (!raw) return false;
    const detail = JSON.parse(raw);
    detail.flagged_remarks = remarksMap;
    localStorage.setItem(EXAM_DETAIL_PREFIX + examId, JSON.stringify(detail));
    return true;
  },

  async runRetentionSweep() {
    const index = await this.getExamIndex();
    const now = new Date();
    let indexChanged = false;

    for (const entry of index) {
      if (entry.purged) continue;
      const created = new Date(entry.created_at);
      const ageMonths = (now - created) / (1000 * 60 * 60 * 24 * 30);
      const ageYears = ageMonths / 12;

      if (ageYears >= RETENTION_PURGE_AFTER_YEARS) {
        localStorage.removeItem(EXAM_DETAIL_PREFIX + entry.exam_id);
        entry.purged = true;
        entry.archived = true;
        indexChanged = true;
      } else if (ageMonths >= RETENTION_ARCHIVE_AFTER_MONTHS && !entry.archived) {
        const raw = localStorage.getItem(EXAM_DETAIL_PREFIX + entry.exam_id);
        if (raw) {
          const detail = JSON.parse(raw);
          // Trim the heavy parts: drop question text/options/explanations, keep only
          // correctness status per question so weakness stats still work.
          detail.question_results = (detail.question_results || []).map(q => ({
            id: q.id, document: q.document, chapter: q.chapter, status: q.status, flagged: q.flagged
          }));
          delete detail.original_questions;
          localStorage.setItem(EXAM_DETAIL_PREFIX + entry.exam_id, JSON.stringify(detail));
        }
        entry.archived = true;
        indexChanged = true;
      }
    }
    if (indexChanged) await this._writeExamIndex(index);
  },

  async saveFeatureRequest(text) {
    const list = await this.getFeatureRequests();
    const examinee = ExamLogic.session?.examinee || {};
    const examinerName = ExamLogic.session?.examiner || document.getElementById('examiner-name')?.value?.trim() || '';
    list.unshift({
      text,
      submitted_at: new Date().toISOString(),
      examinee_name: examinee.name || '',
      examinee_designation: examinee.designation || '',
      examiner_name: examinerName,
      addressed: false,
      admin_remark: '',
      resolved_at: null
    });
    localStorage.setItem(FEATURE_REQUEST_KEY, JSON.stringify(list));
  },

  async getFeatureRequests() {
    const raw = localStorage.getItem(FEATURE_REQUEST_KEY);
    return raw ? JSON.parse(raw) : [];
  },

  async getCustomQuestionEdits() {
    const raw = localStorage.getItem(CUSTOM_QUESTIONS_KEY);
    return raw ? JSON.parse(raw) : { added: [], edited: {}, deleted: [] };
  },

  async saveCustomQuestionEdits(edits) {
    localStorage.setItem(CUSTOM_QUESTIONS_KEY, JSON.stringify(edits));
  }
};

// ============================================================
// LAYER 3: LOGIC LAYER
// ============================================================
const ExamLogic = {
  session: null,
  _timerInterval: null,
  examinerConfig: null,

    buildSession(config) {
    let pool = DataLayer.query({ documents: config.filters.documents, chapters: config.filters.chapters });
    if (pool.length < config.questionCount) {
      return { error: `Only ${pool.length} questions match. Reduce count or broaden filters.` };
    }
    const selected = this.selectWithDistribution(pool, config);
    return {
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      mode: 'qualification',
      config: config,
      questions: selected,
      answers: {},
      flags: new Set(),
      flagged_remarks: {},
      status: 'active',
      timer: { limit_seconds: config.timerMinutes * 60, started_at: null, paused_at: null, elapsed_seconds: 0 },
      current_index: 0,
      examinee: config.examinee,
      examiner: config.examinerName,
            marks_per_question: 2
    };
  },

  /**
   * Build a session from a frozen list of questions (used by Exam Replay), instead of
   * re-selecting from the live pool. If useUpdated is true, each question ID is re-resolved
   * against the current DataLayer pool; any question no longer found falls back to its
   * original snapshot version.
   */
  buildSessionFromSnapshot(config, snapshotQuestions, useUpdated) {
    let questions = snapshotQuestions;
    if (useUpdated) {
      questions = snapshotQuestions.map(orig => {
        const live = DataLayer.questions.find(q => q.id === orig.id);
        return live || orig;
      });
    }
    return {
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      mode: 'replay',
      config: config,
      questions: questions,
      answers: {},
      flags: new Set(),
      flagged_remarks: {},
      status: 'active',
      timer: { limit_seconds: config.timerMinutes * 60, started_at: null, paused_at: null, elapsed_seconds: 0 },
      current_index: 0,
      examinee: config.examinee,
      examiner: config.examinerName,
      marks_per_question: 2
    };
  },

  shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  },

    selectWithDistribution(pool, config) {
    if (!config.distribution || Object.keys(config.distribution).length === 0) {
      return DataLayer.selectWithDifficultyDistribution(pool, config.questionCount, config.difficultyDistribution);
    }
    const selected = [];
    for (const [key, count] of Object.entries(config.distribution)) {
      if (config.distributionLevel === 'document') {
        // Sub-allocate this document's share across its chapters, proportional to how many
        // questions each chapter actually has, so no single chapter dominates the picks.
        const docPool = pool.filter(q => q.document === key);
        const chapters = [...new Set(docPool.map(q => q.chapter))];
        const chapterItems = chapters.map(ch => ({ key: ch, poolSize: docPool.filter(q => q.chapter === ch).length }));
        const chapterAlloc = waterFillAllocate(count, chapterItems, true);
        for (const ch of chapters) {
          const chapterPool = docPool.filter(q => q.chapter === ch);
          selected.push(...this.shuffle(chapterPool).slice(0, chapterAlloc[ch] || 0));
        }
      } else {
        const subset = pool.filter(q => q.chapter === key);
        selected.push(...this.shuffle(subset).slice(0, count));
      }
    }
    return this.shuffle(selected);
  },

  recordAnswer(questionId, answer) {
    if (!this.session) return;
    this.session.answers[questionId] = answer;
    this.saveSession();
  },

  toggleFlag(questionId) {
    if (!this.session) return;
    if (this.session.flags.has(questionId)) this.session.flags.delete(questionId);
    else this.session.flags.add(questionId);
    this.saveSession();
  },

    grade() {
    const s = this.session;
    const marks = s.marks_per_question || 2;
    const results = {
      session_id: s.id,
      config: s.config,
      examinee: s.examinee,
      examiner: s.examiner || s.config.examinerName,
      created_at: s.created_at,
      graded_at: new Date().toISOString(),
      time_taken_seconds: s.timer.elapsed_seconds,
      time_limit_seconds: s.timer.limit_seconds,
      score: { correct: 0, incorrect: 0, unanswered: 0, total: s.questions.length, percent: 0, marks_obtained: 0, marks_total: s.questions.length * marks },
      passed: false,
      by_document: {},
      by_chapter: {},
      weakness_alerts: [],
            question_results: [],
      flagged_remarks: s.flagged_remarks || {},
      original_questions: s.questions
    };

    s.questions.forEach(q => {
      const given = s.answers[q.id] || null;
      const correct = q.correct_answer;
      const status = !given ? 'unanswered' : given === correct ? 'correct' : 'incorrect';
      results.score[status]++;
      if (status === 'correct') results.score.marks_obtained += marks;

      results.question_results.push({
        id: q.id, document: q.document, chapter: q.chapter, topic: q.topic,
        question: q.question, options: q.options, correct_answer: correct,
        given_answer: given, explanation: q.explanation, status, flagged: s.flags.has(q.id)
      });

      if (!results.by_chapter[q.chapter]) results.by_chapter[q.chapter] = { document: q.document, correct: 0, total: 0 };
      results.by_chapter[q.chapter].total++;
      if (status === 'correct') results.by_chapter[q.chapter].correct++;

      if (!results.by_document[q.document]) results.by_document[q.document] = { correct: 0, total: 0 };
      results.by_document[q.document].total++;
      if (status === 'correct') results.by_document[q.document].correct++;
    });

    results.score.percent = Math.round((results.score.correct / results.score.total) * 100);
    results.passed = results.score.percent >= s.config.passThreshold;

    const WEAKNESS_THRESHOLD = 60, MIN_QS = 3;
    for (const [chapter, data] of Object.entries(results.by_chapter)) {
      data.percent = Math.round((data.correct / data.total) * 100);
      if (data.total >= MIN_QS && data.percent < WEAKNESS_THRESHOLD)
        results.weakness_alerts.push({ type: 'chapter', name: chapter, percent: data.percent });
    }
    for (const [doc, data] of Object.entries(results.by_document)) {
      data.percent = Math.round((data.correct / data.total) * 100);
      if (data.total >= MIN_QS && data.percent < WEAKNESS_THRESHOLD)
        results.weakness_alerts.push({ type: 'document', name: doc, percent: data.percent });
    }
    results.weakness_alerts.sort((a,b) => a.percent - b.percent);
    return results;
  },

    startTimer() {
    if (!this.session) return;
    const limit = this.session.timer.limit_seconds;
    // Show initial time right away
    UILayer.updateTimer(limit, limit);
    this.session.timer.started_at = performance.now();
    if (this._timerInterval) clearInterval(this._timerInterval);
    this._timerInterval = setInterval(() => this.tickTimer(), 1000);
  },

  tickTimer() {
    if (!this.session) return;
    if (!this.session.timer.started_at) {
      // Safety: if started_at is null, reinitialize
      this.session.timer.started_at = performance.now();
    }
    const elapsed = Math.floor((performance.now() - this.session.timer.started_at) / 1000);
    this.session.timer.elapsed_seconds = elapsed;
    const remaining = Math.max(0, this.session.timer.limit_seconds - elapsed);
    if (remaining <= 0) {
      clearInterval(this._timerInterval);
      this._timerInterval = null;
      UILayer.updateTimer(0, this.session.timer.limit_seconds);
      UILayer.handleTimeUp();
    } else {
      UILayer.updateTimer(remaining, this.session.timer.limit_seconds);
    }
    this.saveSession();
  },

  pauseTimer() {
    if (this._timerInterval) clearInterval(this._timerInterval);
    this._timerInterval = null;
    if (this.session) this.session.timer.paused_at = performance.now();
  },

  resumeTimer() {
    if (!this.session) return;
    if (this.session.timer.paused_at) {
      const pausedDuration = performance.now() - this.session.timer.paused_at;
      this.session.timer.started_at += pausedDuration;
      this.session.timer.paused_at = null;
    }
    if (this._timerInterval) clearInterval(this._timerInterval);
    this._timerInterval = setInterval(() => this.tickTimer(), 1000);
  },

    addFlaggedRemark(questionId, remark) {
    if (!this.session) return;
    if (!this.session.flagged_remarks) this.session.flagged_remarks = {};
    this.session.flagged_remarks[questionId] = remark;
    this.saveSession();
  },

  saveSession() {
    if (!this.session) return;
    const toSave = { ...this.session, flags: [...this.session.flags] };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(toSave));
  },

  loadSession() {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    parsed.flags = new Set(parsed.flags);
    return parsed;
  },

  clearSession() {
    sessionStorage.removeItem(SESSION_KEY);
    if (this._timerInterval) clearInterval(this._timerInterval);
    this.session = null;
  },

    async saveResult(results) {
    const examId = await StorageLayer.saveExam(results);
    results.exam_id = examId;
    return examId;
  }
};

// ============================================================
// LAYER 3.5: CUSTOM DIALOG MODAL
// ============================================================
const DialogLogic = {
  _resolve: null,

  show(title, bodyHtml, buttons) {
    return new Promise((resolve) => {
      this._resolve = resolve;
      const modal = document.getElementById('modal-custom-dialog');
      document.getElementById('dialog-title').textContent = title;
      document.getElementById('dialog-body').innerHTML = bodyHtml;
      const actions = document.getElementById('dialog-actions');
      actions.innerHTML = '';
      const closeX = document.getElementById('dialog-close-x');
      const doClose = () => { modal.classList.add('hidden'); resolve(null); };
      closeX.onclick = doClose;
      buttons.forEach((b, i) => {
        const btn = document.createElement('button');
        btn.textContent = b.label;
        btn.className = b.primary ? 'btn-primary' : '';
        btn.style.cssText = b.primary ? '' : 'padding:8px 18px;border:1px solid var(--border);background:white;border-radius:4px;cursor:pointer;font-size:13px;font-family:var(--font)';
        btn.onclick = () => {
          modal.classList.add('hidden');
          resolve(b.value);
        };
        if (i === 0) actions.prepend(btn);
        else actions.appendChild(btn);
      });
      modal.classList.remove('hidden');
    });
  },

  async startExamDialog(config, examinee) {
    const diffHtml = config.difficultyDistribution
      ? `<div class="dialog-detail-row"><strong>Difficulty:</strong><span>E:${Math.round(config.difficultyDistribution.easy*100)}% M:${Math.round(config.difficultyDistribution.medium*100)}% H:${Math.round(config.difficultyDistribution.hard*100)}%</span></div>`
      : '';
    const body = `
      <p style="margin-bottom:12px">Please review the exam details before commencing:</p>
      <div class="dialog-detail-row"><strong>Examinee:</strong><span>${examinee.name} (${examinee.serviceNo})</span></div>
      <div class="dialog-detail-row"><strong>Designation:</strong><span>${examinee.designation}</span></div>
      <div class="dialog-detail-row"><strong>Examiner:</strong><span>${config.examinerName}</span></div>
      <div class="dialog-detail-row"><strong>Questions:</strong><span>${config.questionCount}</span></div>
      <div class="dialog-detail-row"><strong>Time:</strong><span>${config.timerMinutes} minutes</span></div>
      ${diffHtml}
      <div class="dialog-detail-row"><strong>Filters:</strong><span>${config.filters.chapters.length || config.filters.documents.length} items selected</span></div>
      <hr style="margin:12px 0;border:none;border-top:1px solid var(--border)">
      <p style="font-size:13px;color:var(--text-muted)">Once you commence, the timer will start. You cannot pause during an active exam.</p>
    `;
    return this.show('Commence Exam', body, [
      { label: 'Cancel', value: false, primary: false },
      { label: 'Commence Exam', value: true, primary: true }
    ]);
  },

  async completeExamDialog(unanswered) {
    let body = '<p>Review your exam if needed, or proceed to results.</p>';
    if (unanswered > 0) {
      body += `<p style="color:var(--warn);margin-top:8px">⚠ You have <strong>${unanswered}</strong> unanswered question(s).</p>`;
    }
    return this.show('Complete Exam', body, [
      { label: 'Go to First Question', value: 'first', primary: false },
      { label: 'Submit & View Results', value: 'submit', primary: true }
    ]);
  }
};

// ============================================================
// LAYER 3.6: FEATURE REQUESTS
// ============================================================
const FeatureRequestLogic = {
  openModal() {
    document.getElementById('modal-feature-request').classList.remove('hidden');
    document.getElementById('feature-request-text').value = '';
  },
  closeModal() {
    document.getElementById('modal-feature-request').classList.add('hidden');
  },
  async submit() {
    const text = document.getElementById('feature-request-text').value.trim();
    if (!text) return;
    await StorageLayer.saveFeatureRequest(text);
    this.closeModal();
    alert('Thanks — your feature request has been submitted.');
  },
  bindGlobalEvents() {
    document.getElementById('btn-feature-request-cancel').onclick = () => this.closeModal();
    document.getElementById('btn-feature-request-submit').onclick = () => this.submit();
  }
};

// ============================================================
// LAYER 4: UI LAYER
// ============================================================
const UILayer = {
  currentQualification: null,
  selectedDocuments: new Set(),
  selectedChapters: new Set(),
  distributionMode: 'equal',
  distributionItems: [],
  distributionGranularity: 'document',

  showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => {
      s.classList.add('hidden');
      s.classList.remove('active');
    });
    document.getElementById(id).classList.remove('hidden');
    document.getElementById(id).classList.add('active');

    const adminBtn = document.getElementById('btn-admin-access');
    if (adminBtn) {
      const showAdminBtnOn = ['screen-examiner', 'screen-results'];
      adminBtn.style.display = showAdminBtnOn.includes(id) ? '' : 'none';
    }
  },

    applyBranding() {
    const cfg = DataLayer.config.app;
    // Update headers: examiner, examinee, and admin screens
    ['-examiner', '-examinee', '-admin'].forEach(suffix => {
      const titleEl = document.getElementById('app-title' + suffix);
      if (titleEl) titleEl.textContent = cfg.title || 'ATC Exam Simulator';
      const subEl = document.getElementById('app-subtitle' + suffix);
      if (subEl) subEl.textContent = cfg.subtitle || '';
      const logoArea = document.getElementById('logo-area' + suffix);
      if (logoArea) {
        logoArea.innerHTML = '';
        if (cfg.logo_path) {
          const img = document.createElement('img');
          img.src = cfg.logo_path;
          img.alt = 'Logo';
          img.id = 'app-logo';
          logoArea.appendChild(img);
        }
      }
    });
    document.title = cfg.title || 'ATC Exam Simulator';
  },

    async initExaminer() {
    this.applyBranding();
    const defaults = DataLayer.config.exam_defaults || {};
    document.getElementById('question-count').value = defaults.question_count || 50;
    document.getElementById('timer-minutes').value = defaults.timer_minutes || 60;
    // Set difficulty defaults
    if (defaults.difficulty_distribution) {
      document.getElementById('dist-easy').value = Math.round((defaults.difficulty_distribution.easy || 0.5) * 100);
      document.getElementById('dist-medium').value = Math.round((defaults.difficulty_distribution.medium || 0.3) * 100);
      document.getElementById('dist-hard').value = Math.round((defaults.difficulty_distribution.hard || 0.2) * 100);
    }
    await this.loadQualificationData();
    this.bindExaminerEvents();
    this.bindDifficultyEvents();
    this.showScreen('screen-examiner');
  },

  async loadQualificationData() {
    const select = document.getElementById('qualification-select');
    select.innerHTML = '<option value="">-- Select a qualification --</option>';
    for (const q of DataLayer.qualifications.qualifications) {
      const option = document.createElement('option');
      option.value = q.name;
      option.textContent = q.name;
      select.appendChild(option);
    }
  },

        bindDifficultyEvents() {
    const inputs = document.querySelectorAll('.diff-input');
    inputs.forEach(inp => {
      inp.oninput = () => this.updateDifficultyTotal();
    });
  },

  updateDifficultyTotal() {
    const easy = parseInt(document.getElementById('dist-easy').value) || 0;
    const med = parseInt(document.getElementById('dist-medium').value) || 0;
    const hard = parseInt(document.getElementById('dist-hard').value) || 0;
    const total = easy + med + hard;
    const span = document.getElementById('diff-total');
    span.textContent = total + '%';
    span.style.color = total === 100 ? 'var(--pass)' : 'var(--fail)';
  },

  getDifficultyConfig() {
    const easy = parseInt(document.getElementById('dist-easy').value) || 50;
    const med = parseInt(document.getElementById('dist-medium').value) || 30;
    const hard = parseInt(document.getElementById('dist-hard').value) || 20;
    const total = easy + med + hard;
    if (total === 0) return null;
    return { easy: easy / total, medium: med / total, hard: hard / total };
  },

  bindExaminerEvents() {
    document.getElementById('btn-create-exam').onclick = () => this.onCreateExam();
    document.getElementById('qualification-select').onchange = () => this.onQualificationChange();
    document.getElementById('btn-customize').onclick = () => this.toggleCustomizePanel();
    document.getElementById('btn-select-all-docs').onclick = () => this.selectAllDocuments();
    document.getElementById('btn-clear-all-docs').onclick = () => this.clearAllSelections();
    document.getElementById('dist-mode').onchange = () => this.onDistributionModeChange();
    document.getElementById('dist-granularity').onchange = () => this.updateDistributionPanel();
    document.getElementById('question-count').oninput = () => {
      const val = parseInt(document.getElementById('question-count').value) || 50;
      document.getElementById('distribution-target').textContent = val;
      UILayer.updateDistributionTotal();
    };
    document.getElementById('btn-auto-distribute').onclick = () => this.resetDistributionToEqual();
    document.getElementById('btn-load-replay').onclick = () => this.onLoadReplay();
    document.getElementById('btn-feature-request-examiner').onclick = () => FeatureRequestLogic.openModal();
  },

  async onLoadReplay() {
    const idInput = document.getElementById('replay-id-input');
    const statusEl = document.getElementById('replay-status-msg');
    const examId = idInput.value.trim().toUpperCase();
    statusEl.classList.remove('hidden');

    if (examId.length !== 5) {
      statusEl.textContent = 'Enter a 5-character Exam ID.';
      return;
    }
    const detail = await StorageLayer.getExamDetail(examId);
    if (!detail) {
      statusEl.textContent = `No exam found for ID "${examId}", or its record has aged out.`;
      return;
    }
    if (!detail.original_questions) {
      statusEl.textContent = `This exam's question snapshot is no longer available (it may have been archived).`;
      return;
    }

    const useUpdated = document.getElementById('replay-use-updated').checked;
    ExamLogic.examinerConfig = detail.config;
    ExamLogic._replaySnapshot = detail.original_questions;
    ExamLogic._replayUseUpdated = useUpdated;
    ExamLogic._replaySourceId = examId;
    this.initExaminee();
  },

  onQualificationChange() {
    const qualName = document.getElementById('qualification-select').value;
    if (!qualName) return;
    const qual = DataLayer.qualifications.qualifications.find(q => q.name === qualName);
    if (!qual) return;
    this.currentQualification = qual;
    this.buildHierarchicalSelector(qual.documents);
    // Auto-select all documents/chapters from the qualification that exist in DB
    this.selectedDocuments.clear();
    this.selectedChapters.clear();
    for (const doc of qual.documents) {
      // Try to match with DB document names (handle case differences, partial matches)
      const dbDoc = DataLayer.meta.documents.find(d =>
        d.toLowerCase() === doc.name.toLowerCase() ||
        d.includes(doc.name) ||
        doc.name.includes(d)
      );
      const docName = dbDoc || doc.name;
      this.selectedDocuments.add(docName);
      const chapters = DataLayer.getChaptersForDocument(docName);
      const relevant = doc.chapters.length ? doc.chapters : chapters;
      relevant.forEach(ch => {
        if (chapters.includes(ch)) this.selectedChapters.add(ch);
      });
    }
    this.refreshSelectionUI();
    this.updateDistributionPanel();
    document.getElementById('filter-panel').classList.remove('hidden');
  },

  buildHierarchicalSelector(qualDocuments) {
    const container = document.getElementById('hierarchical-selector');
    container.innerHTML = '';
    const allDbDocs = DataLayer.meta.documents;

    // Build a set of document names referenced in the qualification
    const qualDocNames = new Set();
    for (const d of qualDocuments) {
      const dbDoc = allDbDocs.find(db =>
        db.toLowerCase() === d.name.toLowerCase() ||
        db.includes(d.name) ||
        d.name.includes(db)
      );
      qualDocNames.add(dbDoc || d.name);
    }

    // Show all DB documents: first those matching qualification, then extras
    const orderedDocs = [];
    for (const d of qualDocuments) {
      const dbDoc = allDbDocs.find(db =>
        db.toLowerCase() === d.name.toLowerCase() ||
        db.includes(d.name) ||
        d.name.includes(db)
      );
      const docName = dbDoc || d.name;
      if (!orderedDocs.includes(docName)) orderedDocs.push(docName);
    }
    // Add remaining DB docs not in qualification
    for (const db of allDbDocs) {
      if (!orderedDocs.includes(db)) orderedDocs.push(db);
    }

    for (const docName of orderedDocs) {
      const chaptersInDoc = DataLayer.getChaptersForDocument(docName);
      if (chaptersInDoc.length === 0) continue; // skip docs with no chapters in DB

      const qualDoc = qualDocuments.find(d =>
        d.name.toLowerCase() === docName.toLowerCase() ||
        docName.includes(d.name) ||
        d.name.includes(docName)
      );

      const docDiv = document.createElement('div');
      docDiv.className = 'doc-group';
      const docCheck = document.createElement('input');
      docCheck.type = 'checkbox';
      docCheck.className = 'doc-check';
      docCheck.value = docName;
      docCheck.addEventListener('change', (e) => this.onDocumentCheck(docName, e.target.checked));
      const docLabel = document.createElement('label');
      docLabel.appendChild(docCheck);
      docLabel.appendChild(document.createTextNode(` ${docName} (${DataLayer.query({documents:[docName]}).length} q)`));
      docDiv.appendChild(docLabel);

      const chapterList = document.createElement('div');
      chapterList.className = 'chapter-list';

      // Determine which chapters to show
      let relevantChapters = qualDoc && qualDoc.chapters.length ? qualDoc.chapters : chaptersInDoc;
      // Filter to only those actually in DB
      relevantChapters = relevantChapters.filter(ch => chaptersInDoc.includes(ch));

      for (const ch of relevantChapters) {
        const chDiv = document.createElement('div');
        chDiv.className = 'chapter-item';
        const chCheck = document.createElement('input');
        chCheck.type = 'checkbox';
        chCheck.className = 'chapter-check';
        chCheck.value = ch;
        chCheck.dataset.doc = docName;
        chCheck.addEventListener('change', (e) => this.onChapterCheck(docName, ch, e.target.checked));
        const chLabel = document.createElement('label');
        chLabel.appendChild(chCheck);
        chLabel.appendChild(document.createTextNode(` ${ch}`));
        chDiv.appendChild(chLabel);
        chapterList.appendChild(chDiv);
      }
      docDiv.appendChild(chapterList);
      container.appendChild(docDiv);
    }
  },

  onDocumentCheck(docName, checked) {
    if (checked) {
      this.selectedDocuments.add(docName);
      const chapterChecks = document.querySelectorAll(`.chapter-check[data-doc="${docName}"]`);
      chapterChecks.forEach(cb => {
        cb.checked = true;
        this.selectedChapters.add(cb.value);
      });
    } else {
      this.selectedDocuments.delete(docName);
      const chapterChecks = document.querySelectorAll(`.chapter-check[data-doc="${docName}"]`);
      chapterChecks.forEach(cb => {
        cb.checked = false;
        this.selectedChapters.delete(cb.value);
      });
    }
    this.updateDistributionPanel();
  },

  onChapterCheck(docName, chapter, checked) {
    if (checked) {
      this.selectedChapters.add(chapter);
      if (!this.selectedDocuments.has(docName)) {
        const docCheck = document.querySelector(`.doc-check[value="${docName}"]`);
        if (docCheck && !docCheck.checked) {
          docCheck.checked = true;
          this.selectedDocuments.add(docName);
        }
      }
    } else {
      this.selectedChapters.delete(chapter);
      const remainingChapters = Array.from(document.querySelectorAll(`.chapter-check[data-doc="${docName}"]:checked`)).map(cb => cb.value);
      if (remainingChapters.length === 0) {
        const docCheck = document.querySelector(`.doc-check[value="${docName}"]`);
        if (docCheck) {
          docCheck.checked = false;
          this.selectedDocuments.delete(docName);
        }
      }
    }
    this.updateDistributionPanel();
  },

  selectAllDocuments() {
    document.querySelectorAll('.doc-check').forEach(cb => {
      cb.checked = true;
      const docName = cb.value;
      this.selectedDocuments.add(docName);
      const chapterChecks = document.querySelectorAll(`.chapter-check[data-doc="${docName}"]`);
      chapterChecks.forEach(cc => {
        cc.checked = true;
        this.selectedChapters.add(cc.value);
      });
    });
    this.updateDistributionPanel();
  },

  clearAllSelections() {
    document.querySelectorAll('.doc-check').forEach(cb => cb.checked = false);
    document.querySelectorAll('.chapter-check').forEach(cb => cb.checked = false);
    this.selectedDocuments.clear();
    this.selectedChapters.clear();
    this.updateDistributionPanel();
  },

  refreshSelectionUI() {
    document.querySelectorAll('.doc-check').forEach(cb => {
      cb.checked = this.selectedDocuments.has(cb.value);
    });
    document.querySelectorAll('.chapter-check').forEach(cb => {
      cb.checked = this.selectedChapters.has(cb.value);
    });
  },

    updateDistributionPanel() {
    const target = parseInt(document.getElementById('question-count').value) || 50;
    document.getElementById('distribution-target').textContent = target;

    const granularityEl = document.getElementById('dist-granularity');
    const granularity = granularityEl ? granularityEl.value : 'document';
    this.distributionGranularity = granularity;
    const useChapters = granularity === 'chapter' && this.selectedChapters.size > 0;
    let items = [];
    if (useChapters) {
      items = Array.from(this.selectedChapters).map(ch => ({
        key: ch,
        type: 'chapter',
        label: ch,
        poolSize: DataLayer.query({ chapters: [ch] }).length
      }));
    } else {
      items = Array.from(this.selectedDocuments).map(doc => {
        const chaptersInDoc = DataLayer.getChaptersForDocument(doc).filter(ch => this.selectedChapters.has(ch));
        const relevantChapters = chaptersInDoc.length ? chaptersInDoc : DataLayer.getChaptersForDocument(doc);
        return {
          key: doc,
          type: 'document',
          label: doc,
          poolSize: DataLayer.query({ chapters: relevantChapters }).length
        };
      });
    }
    this.distributionItems = items;
    const panel = document.getElementById('distribution-panel');
    if (items.length === 0) {
      panel.classList.add('hidden');
      return;
    }
    panel.classList.remove('hidden');

    const rowsDiv = document.getElementById('distribution-rows');
    const mode = document.getElementById('dist-mode').value;
    this.distributionMode = mode;

    if (mode === 'equal') {
      const allocation = waterFillAllocate(target, items.map(it => ({ key: it.key, poolSize: it.poolSize })), false);
      rowsDiv.innerHTML = items.map(item => {
        const value = allocation[item.key] || 0;
        return `
          <div class="dist-row">
            <label>${item.label}</label>
            <input type="number" class="dist-input" data-key="${item.key}" data-type="${item.type}" min="0" max="${item.poolSize}" value="${value}">
            <span class="dist-pool-size">(max: ${item.poolSize})</span>
          </div>
        `;
      }).join('');
    } else {
      rowsDiv.innerHTML = items.map(item => `
        <div class="dist-row">
          <label>${item.label}</label>
          <input type="number" class="dist-input" data-key="${item.key}" data-type="${item.type}" min="0" max="100" value="0" step="1">
          <span>%</span>
          <span class="dist-pool-size">(max: ${item.poolSize})</span>
        </div>
      `).join('');
    }

    document.querySelectorAll('.dist-input').forEach(inp => {
      inp.addEventListener('input', () => this.updateDistributionTotal());
    });
    this.updateDistributionTotal();
  },

    updateDistributionTotal() {
    const target = parseInt(document.getElementById('question-count').value) || 50;
    const mode = this.distributionMode;
    let total = 0;
    const inputs = document.querySelectorAll('.dist-input');
    total = Array.from(inputs).reduce((sum, inp) => sum + (parseInt(inp.value) || 0), 0);
    document.getElementById('distribution-total').textContent = total;
    document.getElementById('distribution-target').textContent = target;
    const footer = document.getElementById('distribution-footer');
    if (total > target) {
      footer.style.color = 'var(--fail)';
    } else if (total < target && mode === 'equal') {
      footer.style.color = 'var(--warn)';
    } else {
      footer.style.color = '';
    }
  },

    resetDistributionToEqual() {
    const target = parseInt(document.getElementById('question-count').value) || 50;
    const mode = this.distributionMode;
    const inputs = document.querySelectorAll('.dist-input');
    if (mode === 'equal') {
      const items = this.distributionItems.map(it => ({ key: it.key, poolSize: it.poolSize }));
      const allocation = waterFillAllocate(target, items, false);
      inputs.forEach(inp => {
        inp.value = allocation[inp.dataset.key] || 0;
      });
    } else {
      const perItem = Math.floor(100 / inputs.length);
      inputs.forEach((inp, idx) => {
        inp.value = idx === 0 ? 100 - perItem * (inputs.length - 1) : perItem;
      });
    }
    this.updateDistributionTotal();
  },

  onDistributionModeChange() {
    this.updateDistributionPanel();
  },

  toggleCustomizePanel() {
    const panel = document.getElementById('filter-panel');
    panel.classList.toggle('hidden');
  },

    getExamConfig() {
    const examinerName = document.getElementById('examiner-name').value.trim();
    if (!examinerName) { alert('Please enter examiner name'); return null; }
    const questionCount = parseInt(document.getElementById('question-count').value) || 50;
    const timerMinutes = parseInt(document.getElementById('timer-minutes').value) || 60;
    const passThreshold = DataLayer.config.exam_defaults.pass_threshold_percent || 70;
    const diffConfig = this.getDifficultyConfig();
    // Validate difficulty totals
    if (!diffConfig) { alert('Difficulty distribution must total 100%.'); return null; }

    const filters = { documents: [], chapters: [] };
    if (this.selectedChapters.size > 0) {
      filters.chapters = Array.from(this.selectedChapters);
    } else {
      filters.documents = Array.from(this.selectedDocuments);
    }
    if (filters.documents.length === 0 && filters.chapters.length === 0) {
      alert('Please select at least one document or chapter.');
      return null;
    }

    const distribution = {};
    let distributionLevel = null;
    const inputs = document.querySelectorAll('.dist-input');
    const mode = this.distributionMode;
    if (inputs.length > 0) {
      distributionLevel = inputs[0].dataset.type;
      if (mode === 'equal') {
        for (const inp of inputs) {
          const val = parseInt(inp.value);
          if (val > 0) distribution[inp.dataset.key] = val;
        }
      } else {
        let totalPercent = 0;
        for (const inp of inputs) {
          totalPercent += parseInt(inp.value) || 0;
        }
        if (totalPercent !== 100) {
          alert('Percentages must sum to 100%.');
          return null;
        }
        for (const inp of inputs) {
          const percent = parseInt(inp.value);
          if (percent > 0) {
            let count = Math.floor((percent / 100) * questionCount);
            if (count === 0 && percent > 0) count = 1;
            distribution[inp.dataset.key] = count;
          }
        }
        const assigned = Object.values(distribution).reduce((a,b)=>a+b,0);
        if (assigned !== questionCount && Object.keys(distribution).length > 0) {
          const firstKey = Object.keys(distribution)[0];
          distribution[firstKey] += (questionCount - assigned);
        }
      }
    }

        return {
      examinerName,
      questionCount,
      timerMinutes,
      passThreshold,
      filters,
      distribution,
      distributionLevel,
      difficultyDistribution: diffConfig,
    };
  },

  onCreateExam() {
    const config = this.getExamConfig();
    if (!config) return;
    ExamLogic.examinerConfig = config;
    this.initExaminee();
  },

    // Examinee Screen
  initExaminee() {
    this.showScreen('screen-examinee');
    // Set up service number input: auto-format to OF-####
        const servNo = document.getElementById('examinee-serviceno');
    servNo.oninput = function() {
      this.value = this.value.replace(/[^0-9]/g, '').slice(0, 4);
    };
    servNo.onkeydown = function(e) {
      const allowed = [8, 9, 46, 37, 39, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 110, 190];
      if (!allowed.includes(e.keyCode) && !e.ctrlKey && !e.metaKey && e.key !== 'Tab') {
        e.preventDefault();
      }
    };

    document.getElementById('btn-back-examiner').onclick = () => this.initExaminer();
    document.getElementById('btn-start-exam').onclick = async () => {
      const name = document.getElementById('examinee-name').value.trim();
      const designation = document.getElementById('examinee-designation').value.trim();
      const serviceNoRaw = document.getElementById('examinee-serviceno').value.trim();
      if (!name || !designation || !serviceNoRaw) { alert('Please fill all examinee fields'); return; }
      if (serviceNoRaw.length !== 4 || !/^[0-9]{4}$/.test(serviceNoRaw)) {
        alert('Please enter a 4-digit service number (e.g., 1234)'); return;
      }
            const serviceNo = 'OF-' + serviceNoRaw;
      const fullConfig = { ...ExamLogic.examinerConfig, examinee: { name, designation, serviceNo } };
      const session = ExamLogic._replaySnapshot
        ? ExamLogic.buildSessionFromSnapshot(fullConfig, ExamLogic._replaySnapshot, ExamLogic._replayUseUpdated)
        : ExamLogic.buildSession(fullConfig);
      if (session.error) { alert(session.error); return; }
      const confirmed = await DialogLogic.startExamDialog(fullConfig, { name, designation, serviceNo });
      if (!confirmed) return;
            ExamLogic.session = session;
      ExamLogic.startTimer();
      ExamLogic._replaySnapshot = null;
      ExamLogic._replayUseUpdated = false;
      ExamLogic._replaySourceId = null;
      this.initExam(session);
    };
  },

  // Exam Screen
  _questionFontSize: 16,

  initExam(session) {
    this.showScreen('screen-exam');
    this._questionFontSize = 16;
    document.getElementById('question-text').style.fontSize = this._questionFontSize + 'px';
    this.renderQuestion(session.current_index);
    this.renderPalette(session);
    this.bindExamControls();
  },

  renderQuestion(index) {
    const s = ExamLogic.session;
    if (!s || !s.questions[index]) return;
    const q = s.questions[index];
    const total = s.questions.length;

    document.getElementById('q-counter').textContent = `Question ${index+1} / ${total}`;
    document.getElementById('progress-fill').style.width = `${((index+1)/total)*100}%`;
    document.getElementById('tag-document').textContent = q.document;
    document.getElementById('tag-chapter').textContent = q.chapter;
    document.getElementById('tag-difficulty').textContent = q.difficulty || '';
    document.getElementById('question-text').textContent = q.question;

        // Support variable-length options (A-F for MCQ, True/False for T/F)
    const optionKeys = q.q_type === 'true_false' ? ['True', 'False'] : Object.keys(q.options).sort();
    document.querySelectorAll('.option-btn').forEach(btn => btn.style.display = 'none');
    optionKeys.forEach(key => {
      const btn = document.querySelector(`.option-btn[data-key="${key}"]`);
      if (btn) {
        btn.style.display = '';
        btn.querySelector('.option-text').textContent = q.q_type === 'true_false'
          ? q.options[key]
          : `${key}. ${q.options[key]}`;
        btn.classList.remove('selected');
        if (s.answers[q.id] === key) btn.classList.add('selected');
      }
    });

        document.getElementById('btn-prev').disabled = index === 0;
    const isLast = index === total-1;
    document.getElementById('btn-next').classList.toggle('hidden', isLast);
    const submitBtn = document.getElementById('btn-submit-exam');
    if (isLast) {
      submitBtn.classList.remove('hidden');
      submitBtn.textContent = '✅ Complete Exam';
      submitBtn.style.color = 'white';
      submitBtn.style.background = 'var(--pass)';
    } else {
      submitBtn.classList.add('hidden');
    }
    this.updatePaletteHighlight(index);
  },

  renderPalette(session) {
    const grid = document.getElementById('palette-grid');
    grid.innerHTML = session.questions.map((_,i) => `<button class="palette-btn" data-index="${i}">${i+1}</button>`).join('');
    document.querySelectorAll('.palette-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        ExamLogic.session.current_index = parseInt(btn.dataset.index);
        this.renderQuestion(ExamLogic.session.current_index);
      });
    });
    this.syncPaletteStates(session);
  },

  syncPaletteStates(session) {
    session.questions.forEach((q,i) => {
      const btn = document.querySelector(`.palette-btn[data-index="${i}"]`);
      if (!btn) return;
      btn.className = 'palette-btn';
      if (session.flags.has(q.id)) btn.classList.add('flagged');
      else if (session.answers[q.id]) btn.classList.add('answered');
    });
  },

  updatePaletteHighlight(index) {
    document.querySelectorAll('.palette-btn').forEach(b => b.classList.remove('current'));
    document.querySelector(`.palette-btn[data-index="${index}"]`)?.classList.add('current');
  },

  bindExamControls() {
    document.querySelectorAll('.option-btn').forEach(btn => {
      btn.onclick = () => {
        const s = ExamLogic.session;
        const q = s.questions[s.current_index];
        ExamLogic.recordAnswer(q.id, btn.dataset.key);
        document.querySelectorAll('.option-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        this.syncPaletteStates(s);
      };
    });

    document.getElementById('btn-prev').onclick = () => {
      ExamLogic.session.current_index--;
      this.renderQuestion(ExamLogic.session.current_index);
    };

    document.getElementById('btn-next').onclick = () => {
      ExamLogic.session.current_index++;
      this.renderQuestion(ExamLogic.session.current_index);
    };

    document.getElementById('btn-font-down').onclick = () => {
      this._questionFontSize = Math.max(14, this._questionFontSize - 2);
      document.getElementById('question-text').style.fontSize = this._questionFontSize + 'px';
    };
    document.getElementById('btn-font-up').onclick = () => {
      this._questionFontSize = Math.min(32, this._questionFontSize + 2);
      document.getElementById('question-text').style.fontSize = this._questionFontSize + 'px';
    };

    document.getElementById('btn-flag').onclick = () => {
      const s = ExamLogic.session;
      const q = s.questions[s.current_index];
      ExamLogic.toggleFlag(q.id);
      this.syncPaletteStates(s);
    };

    document.getElementById('btn-pause').onclick = () => this.pauseExam();
    document.getElementById('btn-resume').onclick = () => this.resumeExam();
    document.getElementById('btn-end-early').onclick = () => this.confirmEndEarly();

    document.getElementById('btn-submit-exam').onclick = () => {
      this.confirmFinalSubmit();
    };
  },

  async confirmFinalSubmit() {
    const s = ExamLogic.session;
    const unanswered = s.questions.length - Object.keys(s.answers).length;
    const choice = await DialogLogic.completeExamDialog(unanswered);
    if (choice === 'first') {
      ExamLogic.session.current_index = 0;
      this.renderQuestion(0);
      return;
    }
    if (choice === 'submit') {
      this.submitExam();
    }
  },

  confirmEndEarly() {
    const s = ExamLogic.session;
    const answered = Object.keys(s.answers).length;
    const unanswered = s.questions.length - answered;
    if (confirm(`End exam early?\n\nAnswered: ${answered}\nUnanswered: ${unanswered}\n\nThis will submit your current answers.`)) {
      this.submitExam();
    }
  },

    async submitExam() {
    ExamLogic.pauseTimer();
    const results = ExamLogic.grade();
    await ExamLogic.saveResult(results);
    ExamLogic.clearSession();
    this.renderResults(results);
  },

  handleTimeUp() {
    alert('Time is up! Your exam has been submitted automatically.');
    this.submitExam();
  },

    updateTimer(remaining, total) {
    if (typeof remaining !== 'number' || isNaN(remaining) || typeof total !== 'number' || isNaN(total)) {
      // Guard against NaN
      document.getElementById('timer-display').textContent = '00:00';
      return;
    }
    const h = Math.floor(remaining / 3600);
    const m = Math.floor((remaining % 3600) / 60);
    const s = remaining % 60;
    if (h > 0) {
      document.getElementById('timer-display').textContent = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    } else {
      document.getElementById('timer-display').textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    }
    const pct = total > 0 ? remaining / total : 0;
    const circumference = 2 * Math.PI * 26;
    const arc = document.getElementById('timer-arc');
    if (arc) {
      arc.style.strokeDasharray = circumference;
      arc.style.strokeDashoffset = circumference * (1 - Math.max(0, Math.min(1, pct)));
      arc.style.stroke = pct > 0.25 ? '#2980b9' : pct > 0.1 ? '#e67e22' : '#c0392b';
    }
  },

  pauseExam() {
    ExamLogic.pauseTimer();
    document.getElementById('pause-overlay').classList.remove('hidden');
    document.getElementById('question-area').style.visibility = 'hidden';
  },

  resumeExam() {
    ExamLogic.resumeTimer();
    document.getElementById('pause-overlay').classList.add('hidden');
    document.getElementById('question-area').style.visibility = 'visible';
  },

    // Results Screen
  renderResults(results) {
        this.showScreen('screen-results');
    document.getElementById('results-exam-id').textContent = `Exam ID: ${results.exam_id || ''}`;

    // Session details: examiner, examinee, date/time
    const detailsSection = document.getElementById('results-examiner-details');
    detailsSection.style.display = 'block';
    const content = document.getElementById('session-details-content');
    const examDate = results.graded_at ? new Date(results.graded_at) : new Date();
    content.innerHTML = `
      <table style="width:auto;border:none;font-size:14px">
        <tr><td style="padding:4px 16px 4px 0;border:none;font-weight:bold">Examiner:</td><td style="padding:4px 0;border:none">${results.examiner || 'N/A'}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;border:none;font-weight:bold">Examinee:</td><td style="padding:4px 0;border:none">${results.examinee?.name || 'N/A'} (${results.examinee?.serviceNo || 'N/A'})</td></tr>
        <tr><td style="padding:4px 16px 4px 0;border:none;font-weight:bold">Designation:</td><td style="padding:4px 0;border:none">${results.examinee?.designation || 'N/A'}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;border:none;font-weight:bold">Date:</td><td style="padding:4px 0;border:none">${examDate.toLocaleDateString('en-GB', {day:'numeric',month:'long',year:'numeric'})}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;border:none;font-weight:bold">Time:</td><td style="padding:4px 0;border:none">${examDate.toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'})}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;border:none;font-weight:bold">Exam ID:</td><td style="padding:4px 0;border:none;font-family:monospace;font-size:12px">${results.session_id || ''}</td></tr>
      </table>
    `;

    document.getElementById('score-number').textContent = `${results.score.correct} / ${results.score.total}`;
    document.getElementById('score-label').textContent = `${results.score.percent}%`;
    const badge = document.getElementById('pass-fail-badge');
    badge.textContent = results.passed ? 'PASS' : 'FAIL';
    badge.className = results.passed ? 'badge-pass' : 'badge-fail';
        document.getElementById('stat-incorrect').textContent = `✗ Incorrect: ${results.score.incorrect}`;
    document.getElementById('stat-unanswered').textContent = `— Unanswered: ${results.score.unanswered}`;
    const marksText = results.score.marks_total ? `${results.score.marks_obtained} / ${results.score.marks_total} marks` : '';
    document.getElementById('stat-correct').textContent = `✓ Correct: ${results.score.correct} ${marksText}`;
    document.getElementById('stat-time').textContent = `Time: ${Math.floor(results.time_taken_seconds/60)}m ${results.time_taken_seconds%60}s / ${Math.floor(results.time_limit_seconds/60)}m`;

    const weaknessDiv = document.getElementById('weakness-alerts');
    if (results.weakness_alerts.length === 0) weaknessDiv.innerHTML = '<div class="alert-pass">✓ No critical weaknesses detected.</div>';
    else weaknessDiv.innerHTML = `<h2>⚠ Weakness Alerts</h2>` + results.weakness_alerts.map(w => `<div class="weakness-alert"><strong>${w.name}</strong><span class="weakness-score">${w.percent}%</span><span class="weakness-action">Review recommended</span></div>`).join('');

    const chapterRows = Object.entries(results.by_chapter).sort((a,b)=>a[1].percent-b[1].percent).map(([ch,data])=>`<tr class="${data.percent>=80?'row-good':data.percent>=60?'row-warn':'row-fail'}"><td>${ch}</td><td>${data.document}</td><td>${data.total}</td><td>${data.correct}</td><td>${data.percent}%</td><td>${data.percent>=80?'✓':data.percent>=60?'△':'✗'}</td></tr>`).join('');
    document.querySelector('#chapter-table tbody').innerHTML = chapterRows;

    const docRows = Object.entries(results.by_document).sort((a,b)=>a[1].percent-b[1].percent).map(([doc,data])=>`<tr class="${data.percent>=80?'row-good':data.percent>=60?'row-warn':'row-fail'}"><td>${doc}</td><td>${data.total}</td><td>${data.correct}</td><td>${data.percent}%</td><td>${data.percent>=80?'✓':data.percent>=60?'△':'✗'}</td></tr>`).join('');
    document.querySelector('#document-table tbody').innerHTML = docRows;

    const reviewDiv = document.getElementById('review-list');
    const renderReview = (filter) => {
      let items = results.question_results;
      if (filter==='incorrect') items = items.filter(q=>q.status==='incorrect');
      if (filter==='flagged') items = items.filter(q=>q.flagged);
      if (filter==='unanswered') items = items.filter(q=>q.status==='unanswered');
      reviewDiv.innerHTML = items.map((q,i)=>`
        <details class="review-item ${q.status}">
          <summary>
            <span class="review-num">${i+1}.</span>
            <span class="review-status-icon">${q.status==='correct'?'✓':q.status==='incorrect'?'✗':'—'}</span>
            <span class="review-q-text">${q.question}</span>
            <span class="review-tag">${q.chapter}</span>
          </summary>
          <div class="review-detail">
            <p>Your answer: <strong>${q.given_answer||'Not answered'}</strong> — Correct: <strong>${q.correct_answer}</strong></p>
            ${q.explanation?`<p class="review-explanation">${q.explanation}</p>`:''}
            <p class="review-source">${q.document} › ${q.chapter}</p>
          </div>
        </details>
      `).join('');
    };
    renderReview('all');
    document.querySelectorAll('.review-filter-btn').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.review-filter-btn').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');
        renderReview(btn.dataset.filter);
      };
    });

        // Flagged Questions & Remarks section — remarks are entered here, after grading
    const flaggedSection = document.getElementById('flagged-remarks-section');
    const flaggedContent = document.getElementById('flagged-remarks-content');
    const flaggedQuestions = (results.question_results || []).filter(q => q.flagged);
    if (flaggedQuestions.length > 0) {
      flaggedSection.style.display = 'block';
      const existingRemarks = results.flagged_remarks || {};
      flaggedContent.innerHTML = flaggedQuestions.map(q => `
        <div class="review-item flagged">
          <p><strong>Q:</strong> ${q.question}</p>
          <p class="review-source">${q.document} › ${q.chapter}</p>
          <textarea class="flag-remark-textarea" data-qid="${q.id}" rows="2" maxlength="500" placeholder="Add a remark for the examiner/admin (optional)">${existingRemarks[q.id] || ''}</textarea>
        </div>
      `).join('') + `
        <button id="btn-save-flag-remarks" class="btn-primary" type="button">Save Remarks</button>
        <p id="flag-remarks-status" class="hidden" style="font-size:13px"></p>`;

      document.getElementById('btn-save-flag-remarks').onclick = async () => {
        const remarksMap = {};
        document.querySelectorAll('.flag-remark-textarea').forEach(ta => {
          const text = ta.value.trim();
          if (text) remarksMap[ta.dataset.qid] = text;
        });
        await StorageLayer.updateFlaggedRemarks(results.exam_id, remarksMap);
        results.flagged_remarks = remarksMap;
        const status = document.getElementById('flag-remarks-status');
        status.textContent = 'Remarks saved.';
        status.classList.remove('hidden');
      };
    } else {
      flaggedSection.style.display = 'none';
    }

    document.getElementById('btn-retake').onclick = () => {
      const newConfig = { ...results.config, examinee: results.examinee };
      const newSession = ExamLogic.buildSession(newConfig);
      if (newSession.error) alert(newSession.error);
      else { ExamLogic.session = newSession; ExamLogic.startTimer(); this.initExam(newSession); }
    };
        document.getElementById('btn-new-exam').onclick = () => this.initExaminer();
        document.getElementById('btn-print').addEventListener('click', () => window.print());
        document.getElementById('btn-feature-request-results').onclick = () => FeatureRequestLogic.openModal();
  }
};

// ============================================================
// LAYER 5: ADMIN LAYER
// ============================================================
const AdminLayer = {
  authenticated: false,

  bindGlobalEvents() {
    document.getElementById('btn-admin-access').onclick = () => this.tryLogin();
    document.getElementById('btn-admin-logout').onclick = () => this.logout();
    document.querySelectorAll('.admin-tab-btn[data-tab]').forEach(btn => {
      btn.onclick = () => this.switchTab(btn.dataset.tab);
    });
    // Question editor modal events
    document.getElementById('btn-qeditor-cancel').onclick = () => this.closeQuestionEditor();
    document.getElementById('btn-qeditor-save').onclick = () => this.saveQuestionEditor();
    document.getElementById('qedit-type').onchange = () => this._syncCorrectOptions();
  },

  _getStoredPassword() {
    return localStorage.getItem(ADMIN_PASSWORD_KEY) || ADMIN_PASSWORD;
  },

  tryLogin() {
    const attempt = prompt('Admin password:');
    if (attempt === null) return;
    const stored = this._getStoredPassword();
    if (attempt === stored) {
      this.authenticated = true;
      this.enterDashboard();
      const lastChanged = localStorage.getItem(ADMIN_PASSWORD_LAST_CHANGED_KEY);
      if (lastChanged) {
        const daysSince = (Date.now() - new Date(lastChanged).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSince > PASSWORD_EXPIRY_DAYS) {
          alert('Your password has expired. Please change it now.');
          this.switchTab('security');
        }
      } else {
        localStorage.setItem(ADMIN_PASSWORD_LAST_CHANGED_KEY, new Date().toISOString());
      }
    } else {
      alert('Incorrect password.');
    }
  },

  logout() {
    this.authenticated = false;
    UILayer.initExaminer();
  },

  enterDashboard() {
    UILayer.showScreen('screen-admin');
    this.switchTab('stats');
  },

  switchTab(tab) {
    document.querySelectorAll('.admin-tab-btn[data-tab]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.querySelectorAll('.admin-tab-panel').forEach(panel => panel.classList.add('hidden'));
    document.getElementById('admin-tab-' + tab).classList.remove('hidden');
    if (tab === 'stats') this.renderStatsTab();
    if (tab === 'questions') this.renderQuestionsTab();
    if (tab === 'flagged') this.renderFlaggedTab();
    if (tab === 'requests') this.renderRequestsTab();
    if (tab === 'security') this.renderSecurityTab();
  },

  renderSecurityTab() {
    const panel = document.getElementById('admin-tab-security');
    const lastChanged = localStorage.getItem(ADMIN_PASSWORD_LAST_CHANGED_KEY);
    const banner = document.getElementById('security-warning-banner');
    if (lastChanged) {
      const daysSince = (Date.now() - new Date(lastChanged).getTime()) / (1000 * 60 * 60 * 24);
      const daysLeft = PASSWORD_EXPIRY_DAYS - daysSince;
      if (daysLeft <= PASSWORD_WARN_DAYS && daysLeft > 0) {
        banner.classList.remove('hidden');
        banner.textContent = `⚠ Password expires in ${Math.ceil(daysLeft)} day(s). Change it now.`;
      } else if (daysLeft <= 0) {
        banner.classList.remove('hidden');
        banner.textContent = '⚠ Password has expired. Change it now.';
      } else {
        banner.classList.add('hidden');
      }
    } else {
      banner.classList.add('hidden');
    }
    document.getElementById('sec-status-msg').textContent = '';
    document.getElementById('btn-change-password').onclick = () => {
      const current = document.getElementById('sec-current-password').value;
      const newPw = document.getElementById('sec-new-password').value;
      const confirm = document.getElementById('sec-confirm-password').value;
      const statusEl = document.getElementById('sec-status-msg');
      if (current !== this._getStoredPassword()) {
        statusEl.textContent = 'Current password is incorrect.';
        statusEl.style.color = 'var(--fail)';
        return;
      }
      if (newPw.length < 5 || newPw.length > 10) {
        statusEl.textContent = 'Password must be 5–10 characters.';
        statusEl.style.color = 'var(--fail)';
        return;
      }
      if (!/^[a-zA-Z0-9]+$/.test(newPw)) {
        statusEl.textContent = 'Alphanumeric characters only.';
        statusEl.style.color = 'var(--fail)';
        return;
      }
      if (newPw !== confirm) {
        statusEl.textContent = 'Passwords do not match.';
        statusEl.style.color = 'var(--fail)';
        return;
      }
      localStorage.setItem(ADMIN_PASSWORD_KEY, newPw);
      localStorage.setItem(ADMIN_PASSWORD_LAST_CHANGED_KEY, new Date().toISOString());
      document.getElementById('sec-current-password').value = '';
      document.getElementById('sec-new-password').value = '';
      document.getElementById('sec-confirm-password').value = '';
      statusEl.textContent = 'Password updated successfully.';
      statusEl.style.color = 'var(--pass)';
      this.renderSecurityTab();
    };
  },

  async renderStatsTab() {
    const index = await StorageLayer.getExamIndex();
    const panel = document.getElementById('admin-tab-stats');
    if (index.length === 0) {
      panel.innerHTML = '<p>No exam history yet.</p>';
      return;
    }
    const rows = index.map(e => `
      <tr>
        <td>${new Date(e.created_at).toLocaleString()}</td>
        <td style="font-family:monospace">${e.exam_id}</td>
        <td>${e.examinee_name} (${e.examinee_serviceno})</td>
        <td>${e.score_percent}%</td>
        <td>${e.passed ? 'Pass' : 'Fail'}</td>
        <td>${Math.round(e.time_taken_seconds / 60)} min</td>
      </tr>`).join('');
    panel.innerHTML = `
      <h2>Exam History (${index.length})</h2>
      <table>
        <thead><tr><th>Date</th><th>Exam ID</th><th>Examinee</th><th>Score</th><th>Result</th><th>Time</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  },

  async renderRequestsTab() {
    const requests = await StorageLayer.getFeatureRequests();
    const panel = document.getElementById('admin-tab-requests');
    if (requests.length === 0) {
      panel.innerHTML = '<p>No feature requests yet.</p>';
      return;
    }
    const active = requests.filter(r => !r.addressed);
    const archived = requests.filter(r => r.addressed);
    let html = `<h2>Active Requests (${active.length})</h2>`;
    active.forEach((r, i) => {
      const idx = requests.indexOf(r);
      html += `
        <div class="admin-request-item" data-idx="${idx}">
          <p>${r.text}</p>
          <small>${new Date(r.submitted_at).toLocaleString()}</small>
          ${r.examinee_name ? `<small> — Examinee: ${r.examinee_name}${r.examinee_designation ? ` (${r.examinee_designation})` : ''}</small>` : ''}
          ${r.examiner_name ? `<small> — Examiner: ${r.examiner_name}</small>` : ''}
          <div style="margin-top:6px;display:flex;gap:8px;align-items:center">
            <input type="text" id="admin-remark-${idx}" class="admin-remark-input" placeholder="Admin remark..." value="${r.admin_remark || ''}" style="flex:1;padding:6px 8px;border:1px solid var(--border);border-radius:4px;font-size:13px;font-family:var(--font)">
            <button class="btn-save-remark" data-idx="${idx}" style="padding:6px 12px;border:1px solid var(--accent);background:var(--accent);color:white;border-radius:4px;cursor:pointer;font-size:12px;font-family:var(--font)">Save Remark</button>
            <button class="btn-mark-addressed" data-idx="${idx}" style="padding:6px 12px;border:1px solid var(--pass);background:var(--pass);color:white;border-radius:4px;cursor:pointer;font-size:12px;font-family:var(--font)">✓ Mark Addressed</button>
          </div>
        </div>`;
    });
    html += `<h3 style="margin-top:20px">Archived Requests (${archived.length})</h3>`;
    if (archived.length === 0) {
      html += '<p style="color:var(--text-muted);font-size:13px">No addressed requests yet.</p>';
    } else {
      archived.forEach(r => {
        html += `
          <div class="admin-request-item" style="opacity:0.7">
            <p>${r.text}</p>
            <small>Submitted: ${new Date(r.submitted_at).toLocaleString()}</small>
            ${r.admin_remark ? `<small> — Remark: ${r.admin_remark}</small>` : ''}
            <small>Resolved: ${r.resolved_at ? new Date(r.resolved_at).toLocaleString() : 'N/A'}</small>
          </div>`;
      });
    }
    panel.innerHTML = html;

    panel.querySelectorAll('.btn-save-remark').forEach(btn => {
      btn.onclick = async () => {
        const idx = parseInt(btn.dataset.idx);
        const remark = document.getElementById(`admin-remark-${idx}`).value.trim();
        requests[idx].admin_remark = remark;
        localStorage.setItem(FEATURE_REQUEST_KEY, JSON.stringify(requests));
        btn.textContent = 'Saved';
        setTimeout(() => { btn.textContent = 'Save Remark'; }, 1500);
      };
    });
    panel.querySelectorAll('.btn-mark-addressed').forEach(btn => {
      btn.onclick = async () => {
        const idx = parseInt(btn.dataset.idx);
        requests[idx].addressed = true;
        requests[idx].resolved_at = new Date().toISOString();
        const remark = document.getElementById(`admin-remark-${idx}`).value.trim();
        if (remark) requests[idx].admin_remark = remark;
        localStorage.setItem(FEATURE_REQUEST_KEY, JSON.stringify(requests));
        this.renderRequestsTab();
      };
    });
  },

  async renderFlaggedTab() {
    const index = await StorageLayer.getExamIndex();
    const panel = document.getElementById('admin-tab-flagged');
    const flaggedExams = index.filter(e => e.flagged_count > 0 && !e.purged);

    if (flaggedExams.length === 0) {
      panel.innerHTML = '<p>No flagged questions found.</p>';
      return;
    }

    const sections = [];
    for (const entry of flaggedExams) {
      const detail = await StorageLayer.getExamDetail(entry.exam_id);
      if (!detail) continue;
      const flaggedQs = (detail.question_results || []).filter(q => q.flagged);
      const remarks = detail.flagged_remarks || {};
      if (flaggedQs.length === 0) {
        sections.push(`
          <div class="admin-flag-item">
            <p><strong>Exam ${entry.exam_id}</strong> — ${entry.examinee_name}</p>
            <p>Question detail unavailable (archived).</p>
          </div>`);
        continue;
      }
      for (const q of flaggedQs) {
        sections.push(`
          <div class="admin-flag-item">
            <p><strong>Exam ${entry.exam_id}</strong> — ${entry.examinee_name}</p>
            <p>${q.document} › ${q.chapter}</p>
            <p>${q.question}</p>
            <p><em>Remark:</em> ${remarks[q.id] || '<span style="color:var(--text-muted)">No remark provided</span>'}</p>
          </div>`);
      }
    }
    panel.innerHTML = `<h2>Flagged Questions (${sections.length})</h2>${sections.join('')}`;
  },

  // ================================================================
  // TASK 18-21: Question Bank Manager (CRUD)
  // ================================================================

  renderQuestionsTab() {
    const docSelect = document.getElementById('admin-qbank-doc');
    const chSelect = document.getElementById('admin-qbank-chapter');
    const addBtn = document.getElementById('btn-admin-add-question');
    const exportBtn = document.getElementById('btn-admin-export-json');

    // Populate document dropdown
    const currentDoc = docSelect.value;
    docSelect.innerHTML = '<option value="">-- All Documents --</option>';
    DataLayer.meta.documents.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d;
      opt.textContent = d;
      if (d === currentDoc) opt.selected = true;
      docSelect.appendChild(opt);
    });

    // Populate chapter dropdown based on selected document
    const currentCh = chSelect.value;
    chSelect.innerHTML = '<option value="">-- All Chapters --</option>';
    let chapters = [];
    if (currentDoc) {
      chapters = DataLayer.getChaptersForDocument(currentDoc);
    } else {
      chapters = DataLayer.meta.chapters;
    }
    chapters.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      if (c === currentCh) opt.selected = true;
      chSelect.appendChild(opt);
    });

    // Re-bind change handlers (clobber previous to avoid duplicates)
    docSelect.onchange = () => this.renderQuestionsTab();
    chSelect.onchange = () => this.renderQbankList();
    addBtn.onclick = () => this.openQuestionEditor(null);
    exportBtn.onclick = () => this.exportDatabase();

    // Populate datalists for the editor modal
    this._populateEditorDatalists();

    // Render the list
    this.renderQbankList();
  },

  _populateEditorDatalists() {
    const docList = document.getElementById('qedit-doc-list');
    if (docList) {
      docList.innerHTML = DataLayer.meta.documents.map(d => `<option value="${d}">`).join('');
    }
    const chList = document.getElementById('qedit-chapter-list');
    if (chList) {
      chList.innerHTML = DataLayer.meta.chapters.map(c => `<option value="${c}">`).join('');
    }
    // Topic datalist from unique topics in the pool
    const topics = [...new Set(DataLayer.questions.map(q => q.topic).filter(Boolean))].sort();
    const topicList = document.getElementById('qedit-topic-list');
    if (topicList) {
      topicList.innerHTML = topics.map(t => `<option value="${t}">`).join('');
    }
  },

  renderQbankList() {
    const docVal = document.getElementById('admin-qbank-doc').value;
    const chVal = document.getElementById('admin-qbank-chapter').value;
    const container = document.getElementById('admin-qbank-list');

    const filters = {};
    if (docVal) filters.documents = [docVal];
    if (chVal) filters.chapters = [chVal];

    let results = DataLayer.query(filters);
    const totalCount = results.length;

    // Pagination ceiling: 200 items
    if (results.length > 200) {
      results = results.slice(0, 200);
    }

    if (results.length === 0) {
      container.innerHTML = `<p class="admin-qbank-empty">No questions match the selected filters. (${totalCount} total in pool)</p>`;
      return;
    }

    container.innerHTML = `<p class="admin-qbank-count">Showing ${results.length} of ${totalCount} questions</p>` +
      results.map((q, idx) => {
        const typeLabel = q.q_type === 'true_false' ? 'T/F' : 'MCQ';
        const optsHtml = q.q_type === 'true_false'
          ? `<span class="qbank-opt">True / False</span>`
          : Object.entries(q.options || {}).map(([k, v]) =>
              `<span class="qbank-opt">${k}: ${v || ''}</span>`
            ).join('');
        return `
          <div class="qbank-item" data-id="${q.id}">
            <div class="qbank-item-header">
              <span class="qbank-index">${idx + 1}.</span>
              <span class="qbank-question">${q.question}</span>
              <span class="qbank-type-tag tag-${q.q_type === 'true_false' ? 'tf' : 'mcq'}">${typeLabel}</span>
            </div>
            <div class="qbank-item-body">
              <div class="qbank-opts">${optsHtml}</div>
              <div class="qbank-tags">
                <span class="qbank-tag">${q.document}</span>
                <span class="qbank-tag">${q.chapter}</span>
                <span class="qbank-tag tag-diff-${q.difficulty || 'medium'}">${q.difficulty || 'medium'}</span>
              </div>
            </div>
            <div class="qbank-item-actions">
              <button class="btn-qbank-edit" data-id="${q.id}" type="button">Edit</button>
              <button class="btn-qbank-delete" data-id="${q.id}" type="button">Delete</button>
            </div>
          </div>
        `;
      }).join('');

    // Bind Edit buttons
    container.querySelectorAll('.btn-qbank-edit').forEach(btn => {
      btn.onclick = () => this.openQuestionEditor(btn.dataset.id);
    });
    // Bind Delete buttons
    container.querySelectorAll('.btn-qbank-delete').forEach(btn => {
      btn.onclick = () => this.deleteQuestion(btn.dataset.id);
    });
  },

  // ----------------------------------------------------------------
  // Question Editor Modal (Create / Update)
  // ----------------------------------------------------------------
  openQuestionEditor(questionId) {
    const modal = document.getElementById('modal-question-editor');
    const titleEl = document.getElementById('modal-qeditor-title');
    const saveBtn = document.getElementById('btn-qeditor-save');

    // Clear all inputs
    document.getElementById('qedit-text').value = '';
    document.getElementById('qedit-explanation').value = '';
    document.getElementById('qedit-document').value = '';
    document.getElementById('qedit-chapter').value = '';
    document.getElementById('qedit-topic').value = '';
    document.getElementById('qedit-difficulty').value = 'medium';
    document.getElementById('qedit-type').value = 'mcq';
    ['A','B','C','D','E','F'].forEach(k => {
      document.getElementById('qedit-opt-' + k).value = '';
    });
    document.getElementById('qedit-correct').value = 'A';

    if (questionId) {
      // Editing an existing question
      const q = DataLayer.questions.find(item => String(item.id) === String(questionId));
      if (!q) { alert('Question not found in pool.'); return; }
      titleEl.textContent = 'Edit Question';
      saveBtn.dataset.editingId = questionId;
      document.getElementById('qedit-text').value = q.question || '';
      document.getElementById('qedit-explanation').value = q.explanation || '';
      document.getElementById('qedit-document').value = q.document || '';
      document.getElementById('qedit-chapter').value = q.chapter || '';
      document.getElementById('qedit-topic').value = q.topic || '';
      document.getElementById('qedit-difficulty').value = q.difficulty || 'medium';
      document.getElementById('qedit-type').value = q.q_type || 'mcq';
      if (q.options) {
        Object.entries(q.options).forEach(([k, v]) => {
          const inp = document.getElementById('qedit-opt-' + k);
          if (inp) inp.value = v || '';
        });
      }
      document.getElementById('qedit-correct').value = q.correct_answer || 'A';
    } else {
      // Adding a new question
      titleEl.textContent = 'Add New Question';
      saveBtn.dataset.editingId = '';
    }

    // Adjust correct answer options based on type
    this._syncCorrectOptions();

    modal.classList.remove('hidden');
  },

  _syncCorrectOptions() {
    const type = document.getElementById('qedit-type').value;
    const correctSelect = document.getElementById('qedit-correct');
    const optionsArea = document.getElementById('qedit-options-area');

    if (type === 'true_false') {
      // Hide/freeze MCQ options, show True/False in correct select
      optionsArea.style.display = 'none';
      correctSelect.innerHTML = '<option value="True">True</option><option value="False">False</option>';
    } else {
      optionsArea.style.display = 'block';
      correctSelect.innerHTML = '<option value="A">A</option><option value="B">B</option><option value="C">C</option><option value="D">D</option><option value="E">E</option><option value="F">F</option>';
    }
  },

  closeQuestionEditor() {
    document.getElementById('modal-question-editor').classList.add('hidden');
  },

  async saveQuestionEditor() {
    const saveBtn = document.getElementById('btn-qeditor-save');
    const editingId = saveBtn.dataset.editingId || '';

    // Collect form data
    const question = document.getElementById('qedit-text').value.trim();
    const explanation = document.getElementById('qedit-explanation').value.trim();
    const document_name = document.getElementById('qedit-document').value.trim();
    const chapter = document.getElementById('qedit-chapter').value.trim();
    const topic = document.getElementById('qedit-topic').value.trim();
    const difficulty = document.getElementById('qedit-difficulty').value;
    const q_type = document.getElementById('qedit-type').value;
    const correct_answer = document.getElementById('qedit-correct').value;

    if (!question || !document_name || !chapter) {
      alert('Please fill in Question Text, Document, and Chapter.');
      return;
    }

    // Build options object
    let options = {};
    if (q_type === 'true_false') {
      options = { True: 'True', False: 'False' };
    } else {
      ['A','B','C','D','E','F'].forEach(k => {
        const val = document.getElementById('qedit-opt-' + k).value.trim();
        if (val) options[k] = val;
      });
      if (Object.keys(options).length < 2) {
        alert('Please provide at least 2 options for MCQ questions.');
        return;
      }
      if (!options[correct_answer]) {
        alert('The correct answer must have a non-empty option value.');
        return;
      }
    }

    const questionObj = {
      id: editingId || crypto.randomUUID(),
      question,
      explanation,
      document: document_name,
      chapter,
      topic,
      difficulty,
      q_type,
      options,
      correct_answer
    };

    // Get current edits
    const edits = await StorageLayer.getCustomQuestionEdits();

    if (editingId) {
      // Determine if this question is from the original DB or a custom-added one
      const isCustomAdded = edits.added && edits.added.some(a => String(a.id) === String(editingId));
      if (isCustomAdded) {
        // Update in the "added" array
        edits.added = edits.added.map(a => String(a.id) === String(editingId) ? questionObj : a);
      } else {
        // It's from the original DB — put in edited map
        edits.edited[editingId] = questionObj;
      }
    } else {
      // New question — add to added array
      if (!edits.added) edits.added = [];
      edits.added.push(questionObj);
    }

    await StorageLayer.saveCustomQuestionEdits(edits);
    alert('Question saved successfully.');
    this.closeQuestionEditor();
    await DataLayer.init();
    this.renderQuestionsTab();
  },

  // ----------------------------------------------------------------
  // Delete Question
  // ----------------------------------------------------------------
  async deleteQuestion(questionId) {
    if (!confirm('Delete this question from the active pool?\n\nThis action can be undone by clearing localStorage or re-importing questions.json.')) return;

    const edits = await StorageLayer.getCustomQuestionEdits();

    // If the question is in the "added" array, remove it from there
    if (edits.added && edits.added.some(a => String(a.id) === String(questionId))) {
      edits.added = edits.added.filter(a => String(a.id) !== String(questionId));
    } else {
      // Otherwise add to deleted array
      if (!edits.deleted) edits.deleted = [];
      if (!edits.deleted.includes(questionId)) {
        edits.deleted.push(questionId);
      }
      // Also remove from edited map if present
      if (edits.edited && edits.edited[questionId]) {
        delete edits.edited[questionId];
      }
    }

    await StorageLayer.saveCustomQuestionEdits(edits);
    await DataLayer.init();
    this.renderQuestionsTab();
  },

  // ----------------------------------------------------------------
  // Database Export Engine
  // ----------------------------------------------------------------
  exportDatabase() {
    const payload = { questions: DataLayer.questions };
    const jsonStr = JSON.stringify(payload, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'questions.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
};

// ============================================================
// BOOTSTRAP
// ============================================================
async function bootstrap() {
    UILayer.showScreen('screen-loading');
  FeatureRequestLogic.bindGlobalEvents();
  AdminLayer.bindGlobalEvents();
  updateUtcClock();
  setInterval(updateUtcClock, 1000);
  try {
    await DataLayer.init();
    const saved = ExamLogic.loadSession();
    if (saved && saved.status === 'active' && confirm('Resume previous exam?')) {
      ExamLogic.session = saved;
      ExamLogic.resumeTimer();
      UILayer.initExam(saved);
    } else {
      ExamLogic.clearSession();
      UILayer.initExaminer();
    }
  } catch (err) {
    document.getElementById('loading-status').innerHTML = `Error loading data: ${err.message}<br>Check that config/qualifications.json and data/questions.json exist.`;
    console.error(err);
  }
}

bootstrap();