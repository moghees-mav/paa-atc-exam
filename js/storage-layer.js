'use strict';

import {
  EXAM_ID_LENGTH, EXAM_ID_ALPHABET,
  EXAM_INDEX_KEY, EXAM_DETAIL_PREFIX,
  FEATURE_REQUEST_KEY, CUSTOM_QUESTIONS_KEY,
  CUSTOM_QUALIFICATIONS_KEY,
  RETENTION_ARCHIVE_AFTER_MONTHS, RETENTION_PURGE_AFTER_YEARS
} from './constants.js';

// ============================================================
// STORAGE LAYER
// All persistence goes through here. Every method returns a Promise even though v1's
// implementation is synchronous localStorage — this is deliberate, so v2 can swap the
// internals for real fetch() calls without any caller needing to change.
// ============================================================
export const StorageLayer = {

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
    const { ExamLogic } = await import('./exam-logic.js');
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
  },

  async getQualificationOverride() {
    const raw = localStorage.getItem(CUSTOM_QUALIFICATIONS_KEY);
    return raw ? JSON.parse(raw) : null;
  },

  async saveQualificationOverride(qualsArray) {
    localStorage.setItem(CUSTOM_QUALIFICATIONS_KEY, JSON.stringify(qualsArray));
  },

  async clearQualificationOverride() {
    localStorage.removeItem(CUSTOM_QUALIFICATIONS_KEY);
  }
};