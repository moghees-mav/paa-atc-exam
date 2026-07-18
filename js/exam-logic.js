'use strict';

import { SESSION_KEY, waterFillAllocate } from './constants.js';
import { DataLayer } from './data-layer.js';
import { StorageLayer } from './storage-layer.js';

// ============================================================
// EXAM LOGIC LAYER
// ============================================================
export const ExamLogic = {
  session: null,
  _timerInterval: null,
  examinerConfig: null,
  _replaySnapshot: null,
  _replayUseUpdated: false,
  _replaySourceId: null,

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

  async startTimer() {
    if (!this.session) return;
    const { UILayer } = await import('./ui.js');
    const limit = this.session.timer.limit_seconds;
    UILayer.updateTimer(limit, limit);
    this.session.timer.started_at = performance.now();
    if (this._timerInterval) clearInterval(this._timerInterval);
    this._timerInterval = setInterval(() => this.tickTimer(), 1000);
  },

  async tickTimer() {
    if (!this.session) return;
    if (!this.session.timer.started_at) {
      this.session.timer.started_at = performance.now();
    }
    const elapsed = Math.floor((performance.now() - this.session.timer.started_at) / 1000);
    this.session.timer.elapsed_seconds = elapsed;
    const remaining = Math.max(0, this.session.timer.limit_seconds - elapsed);
    if (remaining <= 0) {
      clearInterval(this._timerInterval);
      this._timerInterval = null;
      const { UILayer } = await import('./ui.js');
      UILayer.updateTimer(0, this.session.timer.limit_seconds);
      UILayer.handleTimeUp();
    } else {
      const { UILayer } = await import('./ui.js');
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