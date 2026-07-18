# ATC Exam Simulator — Admin Dashboard & Exam Replay: Build Plan (v1, single-machine POC)

Read this entire file before starting. Work through tasks **in strict numeric order** — later
tasks depend on function names, constants, and data shapes defined in earlier ones. Show a
diff/preview before writing any file, and wait for confirmation before moving to the next task.
Do not "also fix" anything you notice outside the current task — flag it and move on.

This is v1: a single-machine proof of concept using `localStorage`. Every piece of storage access
goes through one new module, `StorageLayer`, specifically so that v2 (server-hosted, multi-device)
can later replace `StorageLayer`'s internals with real HTTP calls **without changing any other
file**. Do not call `localStorage` directly from `ExamLogic`, `UILayer`, or the new `AdminLayer` —
always go through `StorageLayer`.

## Confirmed design decisions (do not re-derive these — just implement them)

1. **Replay question set:** defaults to the exact frozen snapshot of questions from the original
   exam. A separate, explicit "Use updated questions" checkbox/option re-resolves each question ID
   against the live question pool instead (falling back to the snapshot version for any question
   that no longer exists).
2. **Exam ID alphabet:** 5 characters, uppercase, drawn only from
   `23456789ABCDEFGHJKMNPQRSTUVWXYZ` — this deliberately excludes `0`, `1`, `O`, `I`, `L` since IDs
   may be read aloud or handwritten between examinee/examiner/admin.
3. **Storage schema:** each exam is split into a small, permanent **index** record (used for
   admin stats listings and Replay ID lookups) and a separate, larger **detail** record (full
   question snapshot, per-question results, flagged remarks) that can later be archived/shrunk
   independently without touching the index.

---

## TASK 0 — New constants

In app.js, find this exact block near the top of the file:

```
const CONFIG_PATH = 'config/app.config.json';
const QUALIFICATIONS_PATH = 'config/qualifications.json';
const DATA_PATH = 'data/questions.json';
const SESSION_KEY = 'atc_exam_session';
const HISTORY_KEY = 'atc_exam_history';
const MAX_HISTORY = 10;
```

Replace it with exactly:

```
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
```

Do not touch anything else in the file for this task.

---

## TASK 1 — Add the `StorageLayer` module

In app.js, find this exact block (the end of `DataLayer` and the start of the `ExamLogic` comment
header):

```
    return selected;
  }
};

// ============================================================
// LAYER 3: LOGIC LAYER
// ============================================================
```

Replace it with exactly:

```
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
      flagged_count: Object.keys(results.flagged_remarks || {}).length,
      archived: false,
      purged: false
    };
    index.unshift(indexEntry);
    await this._writeExamIndex(index);

    localStorage.setItem(EXAM_DETAIL_PREFIX + examId, JSON.stringify(results));
    await this.runRetentionSweep();
    return examId;
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
    list.unshift({ text, submitted_at: new Date().toISOString() });
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
```

Do not modify `DataLayer` itself in this task — only insert the new `StorageLayer` block between
it and the `LAYER 3` comment.

---

## TASK 2 — Wire `grade()` and `saveResult()` into `StorageLayer`

**2a.** In app.js, inside `grade()`, find this exact line:

```
      question_results: [],
      flagged_remarks: s.flagged_remarks || {}
    };
```

Replace it with exactly:

```
      question_results: [],
      flagged_remarks: s.flagged_remarks || {},
      original_questions: s.questions
    };
```

This preserves the exact, unmodified question objects as they were originally selected, separate
from `question_results` (which gets annotated with each answer's correctness below). This is what
Replay's default "snapshot" mode will load from.

**2b.** In app.js, find this exact line (still inside `grade()`, the pass_threshold fix from the
earlier corrections pass should already be in place — if it isn't, stop and flag that to me before
continuing, since this task assumes it):

```
    results.passed = results.score.percent >= s.config.passThreshold;
```

Leave that line as-is. Directly below the full `grade()` function (after its closing `},`), the
function should already return `results`. Confirm this is still the case and do not change it.

**2c.** In app.js, find this exact function:

```
  saveResult(results) {
    const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    history.unshift(results);
    if (history.length > MAX_HISTORY) history.pop();
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  }
```

Replace it with exactly:

```
  async saveResult(results) {
    const examId = await StorageLayer.saveExam(results);
    results.exam_id = examId;
    return examId;
  }
```

**2d.** In app.js, find this exact function:

```
  submitExam() {
    ExamLogic.pauseTimer();
    const results = ExamLogic.grade();
    ExamLogic.saveResult(results);
    ExamLogic.clearSession();
    this.renderResults(results);
  },
```

Replace it with exactly:

```
  async submitExam() {
    ExamLogic.pauseTimer();
    const results = ExamLogic.grade();
    await ExamLogic.saveResult(results);
    ExamLogic.clearSession();
    this.renderResults(results);
  },
```

`submitExam` is now `async` and awaits the save so `results.exam_id` is populated before
`renderResults` displays it. Check every place `submitExam` is called (`confirmFinalSubmit`,
`confirmEndEarly`, `handleTimeUp`) — they call it as `this.submitExam()` without awaiting, which is
fine (fire-and-forget is acceptable here since nothing after those calls depends on completion),
but do not change those three call sites in this task.

---

## TASK 3 — Show the exam ID on the results screen

In app.js, inside `renderResults(results)`, find where the header/score card starts rendering
(the exact line will contain `showScreen('screen-results')` near the top of the function). Do not
guess further — view the function, locate the first place `results.score` or `results.passed` is
used to populate the DOM, and insert a line that sets a new element's text to
`` `Exam ID: ${results.exam_id}` ``. Show me the surrounding 10 lines of context and the exact
insertion point you'll use before making this edit — this one has some flexibility in exactly
where it goes, so confirm placement with me first rather than guessing.

In index.html, find:

```
    <header id="results-header">
      <h1>Exam Complete</h1>
```

Replace with:

```
    <header id="results-header">
      <h1>Exam Complete</h1>
      <p id="results-exam-id" style="font-family:monospace;font-size:14px;color:var(--text-muted)"></p>
```

The `#results-exam-id` element is what Task 3's app.js code should populate.

---

## TASK 4 — Exam Replay UI (index.html)

In index.html, find this exact block (inside `#screen-examiner`, at the very end of `#home-main`):

```
      <div id="home-actions">
        <p id="start-validation-msg" class="hidden"></p>
        <button id="btn-create-exam" class="btn-primary">Create Exam →</button>
      </div>
```

Replace it with exactly:

```
      <section id="replay-panel">
        <h3>Exam Replay</h3>
        <p style="font-size:13px;color:var(--text-muted);margin:4px 0 10px">
          Enter a 5-character Exam ID to retake that exact exam, review it, or flag it for the examiner/admin.
        </p>
        <div class="setting-row">
          <label for="replay-id-input">Exam ID</label>
          <input type="text" id="replay-id-input" maxlength="5" placeholder="e.g. 7K9MQ" style="width:120px;text-transform:uppercase;font-family:monospace;letter-spacing:2px">
          <button id="btn-load-replay" type="button">Load Exam</button>
        </div>
        <div class="setting-row">
          <label style="min-width:auto;font-size:13px"><input type="checkbox" id="replay-use-updated"> Use updated questions instead of the original snapshot</label>
        </div>
        <p id="replay-status-msg" class="hidden" style="font-size:13px"></p>
      </section>

      <div id="home-actions">
        <p id="start-validation-msg" class="hidden"></p>
        <button id="btn-create-exam" class="btn-primary">Create Exam →</button>
      </div>
```

Do not change anything else in this file for this task.

---

## TASK 5 — Exam Replay logic (app.js)

**5a.** In app.js, add a new function to `ExamLogic` that builds a session from a frozen question
list instead of re-selecting from the pool. Find this exact block (the end of `buildSession`):

```
      examinee: config.examinee,
      examiner: config.examinerName,
      marks_per_question: 2
    };
  },
```

Replace it with exactly:

```
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
```

**5b.** In app.js, inside `bindExaminerEvents()`, find this exact line:

```
    document.getElementById('btn-auto-distribute').onclick = () => this.resetDistributionToEqual();
  },
```

Replace it with exactly:

```
    document.getElementById('btn-auto-distribute').onclick = () => this.resetDistributionToEqual();
    document.getElementById('btn-load-replay').onclick = () => this.onLoadReplay();
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
```

**5c.** In app.js, inside `initExaminee()`, find this exact line:

```
      const serviceNo = 'OF-' + serviceNoRaw;
      const fullConfig = { ...ExamLogic.examinerConfig, examinee: { name, designation, serviceNo } };
      const session = ExamLogic.buildSession(fullConfig);
```

Replace it with exactly:

```
      const serviceNo = 'OF-' + serviceNoRaw;
      const fullConfig = { ...ExamLogic.examinerConfig, examinee: { name, designation, serviceNo } };
      const session = ExamLogic._replaySnapshot
        ? ExamLogic.buildSessionFromSnapshot(fullConfig, ExamLogic._replaySnapshot, ExamLogic._replayUseUpdated)
        : ExamLogic.buildSession(fullConfig);
```

Immediately after that block (still inside the same `btn-start-exam` click handler, after
`this.initExam(session);`), the replay-specific one-time state needs clearing so a later, normal
"Create Exam" flow doesn't accidentally reuse a stale snapshot. Find:

```
      ExamLogic.session = session;
      ExamLogic.startTimer();
      this.initExam(session);
    };
  },
```

Replace with:

```
      ExamLogic.session = session;
      ExamLogic.startTimer();
      ExamLogic._replaySnapshot = null;
      ExamLogic._replayUseUpdated = false;
      ExamLogic._replaySourceId = null;
      this.initExam(session);
    };
  },
```

This intentionally reuses the existing Examinee Details screen rather than fully bypassing setup
as the original request phrased it — the person taking the replayed exam still needs their own
name/designation/service number recorded against this new attempt. Flag it to me if you think the
Examinee Details step should be skipped entirely instead; I'm assuming it should stay for now.

---

## TASK 6 — Feature Request system

**6a.** In index.html, find:

```
      <div id="home-actions">
```

(the one still reading `id="home-actions"`, i.e. the examiner screen's actions div) and insert
directly **above** it:

```
      <div style="text-align:right;margin:10px 0">
        <button id="btn-feature-request-examiner" type="button">💡 Submit Feature Request</button>
      </div>
```

**6b.** In index.html, find:

```
    <header id="results-header">
      <h1>Exam Complete</h1>
      <p id="results-exam-id" style="font-family:monospace;font-size:14px;color:var(--text-muted)"></p>
      <div id="results-actions">
```

Replace with:

```
    <header id="results-header">
      <h1>Exam Complete</h1>
      <p id="results-exam-id" style="font-family:monospace;font-size:14px;color:var(--text-muted)"></p>
      <div id="results-actions">
        <button id="btn-feature-request-results" type="button">💡 Submit Feature Request</button>
```

**6c.** In index.html, add this shared modal markup just before the closing `</body>` tag (i.e.
directly above `<script src="app.js"></script>`):

```
  <div id="modal-feature-request" class="modal-overlay hidden">
    <div class="modal-box">
      <h3>Submit a Feature Request</h3>
      <textarea id="feature-request-text" rows="5" placeholder="Describe what you'd like to see..." maxlength="1000"></textarea>
      <div class="modal-actions">
        <button id="btn-feature-request-cancel" type="button">Cancel</button>
        <button id="btn-feature-request-submit" class="btn-primary" type="button">Submit</button>
      </div>
    </div>
  </div>
```

**6d.** In app.js, add a small logic object. Find this exact anchor (the closing brace of
`ExamLogic` followed by the `LAYER 4: UI LAYER` comment):

```
    localStorage.setItem(EXAM_DETAIL_PREFIX + examId, JSON.stringify(results));
```

That line is inside `StorageLayer`, not `ExamLogic` — ignore it, it was only there to help you
locate the file; do not edit it. Instead, find the actual anchor:

```
// ============================================================
// LAYER 4: UI LAYER
// ============================================================
const UILayer = {
```

Replace it with exactly:

```
// ============================================================
// LAYER 3.5: FEATURE REQUESTS
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
```

**6e.** In app.js, inside `bindExaminerEvents()`, find:

```
    document.getElementById('btn-load-replay').onclick = () => this.onLoadReplay();
  },
```

Replace with:

```
    document.getElementById('btn-load-replay').onclick = () => this.onLoadReplay();
    document.getElementById('btn-feature-request-examiner').onclick = () => FeatureRequestLogic.openModal();
  },
```

**6f.** In app.js, inside `renderResults(results)`, find:

```
    document.getElementById('btn-print').addEventListener('click', () => window.print());
  }
};
```

Replace with:

```
    document.getElementById('btn-print').addEventListener('click', () => window.print());
    document.getElementById('btn-feature-request-results').onclick = () => FeatureRequestLogic.openModal();
  }
};
```

**6g.** In app.js, find the `bootstrap()` function and, inside it, find:

```
  UILayer.showScreen('screen-loading');
```

Add this line directly after it:

```
  FeatureRequestLogic.bindGlobalEvents();
```

**6h.** In style.css, add (anywhere near the end of the file is fine):

```
/* Feature request modal (shared, reused across screens) */
.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 500; }
.modal-overlay.hidden { display: none; }
.modal-box { background: var(--bg, #fff); border-radius: 8px; padding: 20px; width: 90%; max-width: 420px; }
.modal-box textarea { width: 100%; margin: 10px 0; padding: 8px; font-family: inherit; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; }
```

If `.hidden { display: none; }` is already defined elsewhere in style.css as a generic utility
class, tell me instead of adding `.modal-overlay.hidden` — we don't want two conflicting rules
for the same purpose.

---

## TASK 7 — Admin authentication and screen shell

**7a.** In index.html, find:

```
<body>

  <!-- Screen: Loading -->
```

Replace with:

```
<body>

  <button id="btn-admin-access" class="admin-access-btn" type="button">⚙ Admin</button>

  <!-- Screen: Loading -->
```

Placing this directly in `<body>`, outside every `.screen` div, means it's present regardless of
which screen is active — this avoids re-introducing the per-screen duplicate-ID pattern from the
earlier corrections pass.

**7b.** In index.html, find the closing of `#screen-results` (the last `</div>` before the
`<!-- ... -->` comment that precedes `<script src="app.js">`... actually, locate this exact anchor):

```
    <section class="results-section" id="flagged-remarks-section" style="display:none">
      <h2>Flagged Questions & Remarks</h2>
      <div id="flagged-remarks-content"></div>
    </section>
  </div>
```

Insert directly after that closing `</div>` (i.e. after `#screen-results` ends, before the
feature-request modal from Task 6c):

```

  <!-- Screen: Admin Dashboard -->
  <div id="screen-admin" class="screen hidden">
    <div id="admin-layout">
      <nav id="admin-sidebar">
        <h2>Admin</h2>
        <button class="admin-tab-btn active" data-tab="stats" type="button">Dashboard / Stats</button>
        <button class="admin-tab-btn" data-tab="questions" type="button">Question Bank</button>
        <button class="admin-tab-btn" data-tab="flagged" type="button">Flagged Remarks</button>
        <button class="admin-tab-btn" data-tab="requests" type="button">Feature Requests</button>
        <button id="btn-admin-logout" type="button">Log Out</button>
      </nav>
      <main id="admin-content">
        <section id="admin-tab-stats" class="admin-tab-panel"></section>
        <section id="admin-tab-questions" class="admin-tab-panel hidden"></section>
        <section id="admin-tab-flagged" class="admin-tab-panel hidden"></section>
        <section id="admin-tab-requests" class="admin-tab-panel hidden"></section>
      </main>
    </div>
  </div>
```

**7c.** In app.js, add the `AdminLayer` module. Find this exact anchor (end of `UILayer`, start of
`BOOTSTRAP`):

```
    document.getElementById('btn-feature-request-results').onclick = () => FeatureRequestLogic.openModal();
  }
};

// ============================================================
// BOOTSTRAP
// ============================================================
```

Replace it with exactly:

```
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
  },

  tryLogin() {
    const attempt = prompt('Admin password:');
    if (attempt === null) return;
    if (attempt === ADMIN_PASSWORD) {
      this.authenticated = true;
      this.enterDashboard();
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
  }
};

// ============================================================
// BOOTSTRAP
// ============================================================
```

Note: `renderStatsTab()`, `renderQuestionsTab()`, `renderFlaggedTab()`, and `renderRequestsTab()`
are only stubbed by being called here — they don't exist yet. Do not add empty placeholder
versions of them in this task; Tasks 8–10 will add the real implementations. If you run this task
in isolation and click into a tab before those exist, you'll get a "not a function" error in the
console — that's expected and fine until those tasks land.

**7d.** In app.js, inside `bootstrap()`, find the line you added in Task 6g:

```
  FeatureRequestLogic.bindGlobalEvents();
```

Add directly after it:

```
  AdminLayer.bindGlobalEvents();
```

**7e.** In style.css, add:

```
/* Admin access button — fixed, present on every screen */
.admin-access-btn { position: fixed; top: 10px; right: 10px; z-index: 400; opacity: 0.6; }
.admin-access-btn:hover { opacity: 1; }

/* Admin dashboard shell */
#admin-layout { display: flex; min-height: 100vh; }
#admin-sidebar { width: 220px; flex-shrink: 0; padding: 20px; border-right: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; }
#admin-sidebar button { text-align: left; padding: 10px 12px; border-radius: 6px; }
#admin-sidebar button.active { background: var(--pass, #2ecc71); color: #fff; }
#btn-admin-logout { margin-top: auto; }
#admin-content { flex: 1; padding: 24px; overflow-y: auto; }
.admin-tab-panel.hidden { display: none; }
```

---

## TASK 8 — Admin Stats tab and Feature Requests tab

**8a.** In app.js, inside `AdminLayer`, find:

```
    if (tab === 'requests') this.renderRequestsTab();
  }
};
```

Replace with:

```
    if (tab === 'requests') this.renderRequestsTab();
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
    const items = requests.map(r => `
      <div class="admin-request-item">
        <p>${r.text}</p>
        <small>${new Date(r.submitted_at).toLocaleString()}</small>
      </div>`).join('');
    panel.innerHTML = `<h2>Feature Requests (${requests.length})</h2>${items}`;
  }
};
```

**8b.** In style.css, add:

```
.admin-request-item { border-bottom: 1px solid var(--border); padding: 10px 0; }
.admin-request-item small { color: var(--text-muted); }
```

---

## TASK 9 — Admin Flagged Remarks tab

In app.js, inside `AdminLayer`, find:

```
    panel.innerHTML = `<h2>Feature Requests (${requests.length})</h2>${items}`;
  }
};
```

Replace with:

```
    panel.innerHTML = `<h2>Feature Requests (${requests.length})</h2>${items}`;
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
      if (!detail || !detail.flagged_remarks) continue;
      for (const [qId, remark] of Object.entries(detail.flagged_remarks)) {
        const q = (detail.question_results || []).find(qr => qr.id === qId);
        sections.push(`
          <div class="admin-flag-item">
            <p><strong>Exam ${entry.exam_id}</strong> — ${entry.examinee_name}</p>
            <p>${q ? `${q.document} › ${q.chapter}` : 'Question detail unavailable (archived)'}</p>
            <p>${q?.question || ''}</p>
            <p><em>Remark:</em> ${remark}</p>
          </div>`);
      }
    }
    panel.innerHTML = `<h2>Flagged Questions (${sections.length})</h2>${sections.join('')}`;
  }
};
```

In style.css, add:

```
.admin-flag-item { border-bottom: 1px solid var(--border); padding: 12px 0; }
```

---

## TASK 10 — Question Bank Manager (view + filters only, no editing yet)

This task deliberately stops at read-only viewing with filters. Editing/adding/deleting/exporting
is Task 11, kept separate since it's the highest-risk part of this whole feature (it changes what
questions examinees actually see).

In app.js, inside `AdminLayer`, find:

```
    panel.innerHTML = `<h2>Flagged Questions (${sections.length})</h2>${sections.join('')}`;
  }
};
```

Replace with:

```
    panel.innerHTML = `<h2>Flagged Questions (${sections.length})</h2>${sections.join('')}`;
  },

  async renderQuestionsTab() {
    const panel = document.getElementById('admin-tab-questions');
    const docs = [...new Set(DataLayer.questions.map(q => q.document))].sort();
    const docOptions = docs.map(d => `<option value="${d}">${d}</option>`).join('');

    panel.innerHTML = `
      <h2>Question Bank (${DataLayer.questions.length})</h2>
      <div class="setting-row">
        <label for="qbank-doc-filter">Document</label>
        <select id="qbank-doc-filter"><option value="">All documents</option>${docOptions}</select>
        <label for="qbank-chapter-filter">Chapter</label>
        <select id="qbank-chapter-filter"><option value="">All chapters</option></select>
      </div>
      <div id="qbank-list"></div>`;

    document.getElementById('qbank-doc-filter').onchange = (e) => this.onQbankDocFilter(e.target.value);
    document.getElementById('qbank-chapter-filter').onchange = () => this.renderQbankList();
    this.renderQbankList();
  },

  onQbankDocFilter(docName) {
    const chapterSelect = document.getElementById('qbank-chapter-filter');
    chapterSelect.innerHTML = '<option value="">All chapters</option>';
    if (docName) {
      DataLayer.getChaptersForDocument(docName).forEach(ch => {
        const opt = document.createElement('option');
        opt.value = ch; opt.textContent = ch;
        chapterSelect.appendChild(opt);
      });
    }
    this.renderQbankList();
  },

  renderQbankList() {
    const docFilter = document.getElementById('qbank-doc-filter').value;
    const chapterFilter = document.getElementById('qbank-chapter-filter').value;
    let list = DataLayer.questions;
    if (docFilter) list = list.filter(q => q.document === docFilter);
    if (chapterFilter) list = list.filter(q => q.chapter === chapterFilter);

    const rows = list.slice(0, 200).map(q => `
      <div class="qbank-item">
        <p><strong>${q.id}</strong> — ${q.document} › ${q.chapter}</p>
        <p>${q.question}</p>
      </div>`).join('');
    const truncNote = list.length > 200 ? `<p><em>Showing first 200 of ${list.length} matches.</em></p>` : '';
    document.getElementById('qbank-list').innerHTML = truncNote + rows;
  }
};
```

In style.css, add:

```
.qbank-item { border-bottom: 1px solid var(--border); padding: 10px 0; }
```

Stop here and confirm this renders correctly with real data before moving to Task 11 (Add/Edit/
Delete/Export). That task touches the actual question pool examinees will see, so it's worth
getting the read-only view verified first.
