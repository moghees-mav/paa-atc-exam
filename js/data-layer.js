'use strict';

import { CONFIG_PATH, QUALIFICATIONS_PATH, DATA_PATH, shuffle } from './constants.js';
import { StorageLayer } from './storage-layer.js';

// ============================================================
// DATA LAYER
// ============================================================
export const DataLayer = {
  questions: [],
  config: {},
  qualifications: { qualifications: [] },
  meta: {},

  async init() {
    this.config = await fetch(CONFIG_PATH).then(r => r.json());
    this.qualifications = await fetch(QUALIFICATIONS_PATH).then(r => r.json());

    const qualOverride = await StorageLayer.getQualificationOverride();
    if (qualOverride && Array.isArray(qualOverride)) {
      this.qualifications = { ...this.qualifications, qualifications: qualOverride };
    }

    const db = await fetch(DATA_PATH).then(r => r.json());
    this.questions = db.questions;

    const custom = await StorageLayer.getCustomQuestionEdits();
    if (custom) {
      if (Array.isArray(custom.deleted) && custom.deleted.length > 0) {
        const deleteSet = new Set(custom.deleted);
        this.questions = this.questions.filter(q => !deleteSet.has(q.id));
      }
      if (custom.edited && typeof custom.edited === 'object') {
        this.questions = this.questions.map(q => {
          return custom.edited[q.id] ? { ...custom.edited[q.id] } : q;
        });
      }
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

  selectWithDifficultyDistribution(pool, targetCount, difficultyDist) {
    if (!difficultyDist || Object.keys(difficultyDist).length === 0) {
      return shuffle(pool).slice(0, targetCount);
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
      selected.push(...shuffle(subset).slice(0, count));
      remaining -= count;
    }

    if (remaining > 0) {
      const usedIds = new Set(selected.map(q => q.id));
      const rest = pool.filter(q => !usedIds.has(q.id));
      selected.push(...shuffle(rest).slice(0, remaining));
    }

    return shuffle(selected);
  }
};