'use strict';

// ============================================================
// CONSTANTS
// ============================================================
export const CONFIG_PATH = 'config/app.config.json';
export const QUALIFICATIONS_PATH = 'config/qualifications.json';
export const DATA_PATH = 'data/questions.json';
export const SESSION_KEY = 'atc_exam_session';

// Legacy key, no longer written to — left for backward compat
export const HISTORY_KEY = 'atc_exam_history';
export const MAX_HISTORY = 10;

// Storage keys
export const EXAM_INDEX_KEY = 'atc_exam_index';
export const EXAM_DETAIL_PREFIX = 'atc_exam_detail_';
export const FEATURE_REQUEST_KEY = 'atc_feature_requests';
export const CUSTOM_QUESTIONS_KEY = 'atc_custom_questions';
export const CUSTOM_QUALIFICATIONS_KEY = 'atc_custom_qualifications';
export const ADMIN_PASSWORD_KEY = 'atc_admin_password';
export const ADMIN_PASSWORD_LAST_CHANGED_KEY = 'atc_password_last_changed';
export const PASSWORD_EXPIRY_DAYS = 30;
export const PASSWORD_WARN_DAYS = 5;

// Placeholder auth
export const ADMIN_PASSWORD = 'Admin123';

// Exam ID: 5 chars, excludes confusing chars
export const EXAM_ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const EXAM_ID_LENGTH = 5;

// Retention
export const RETENTION_ARCHIVE_AFTER_MONTHS = 6;
export const RETENTION_PURGE_AFTER_YEARS = 5;

/**
 * Capped water-filling allocator. Shared by distribution UI and question selection logic.
 */
export function waterFillAllocate(target, items, weighted) {
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

export function updateUtcClock() {
  const el = document.getElementById('utc-clock');
  if (!el) return;
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  el.textContent = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} UTC`;
}

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}