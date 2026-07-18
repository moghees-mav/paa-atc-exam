# ATC Exam Simulator — Fixes from Testing (continues after Task 10)

Read this whole file first. Work through tasks **in strict numeric order** — Task 12 depends on a
helper function added in Task 11... actually Task 12 depends on nothing from 11, but Task 13
depends on nothing from 12 either; still, do them in order since later tasks assume earlier ones
are already applied, and skipping around risks editing code that's already been changed. Show a
diff before writing anything and wait for confirmation before moving to the next task.

---

## TASK 11 — Distribution panel: default to document-level, add a toggle for chapter-level

**Problem:** `updateDistributionPanel()` currently decides between showing per-document or
per-chapter rows using `const useChapters = this.selectedChapters.size > 0;`. Since choosing a
qualification (`onQualificationChange`) always populates `selectedChapters` with every matching
chapter, this condition is essentially always true — so the Distribution panel always shows one
row per chapter (often dozens of rows), never the cleaner per-document view.

**Fix:** add an explicit granularity toggle, defaulting to "By Document." This is a simpler design
than a per-document expand/collapse control — one global toggle rather than mixed granularity per
row — chosen because the underlying distribution engine (`config.distributionLevel`) only supports
one level at a time. If you actually want per-document expand/collapse later, that requires a
larger rework of `getExamConfig()`/`selectWithDistribution()` — flag it to me rather than
attempting it here.

**11a.** In index.html, find:

```
      <section id="distribution-panel" class="hidden">
        <h3>Question Distribution</h3>
        <div class="setting-row">
                    <label for="dist-mode">Distribution Mode</label>
          <select id="dist-mode">
```

Replace with exactly:

```
      <section id="distribution-panel" class="hidden">
        <h3>Question Distribution</h3>
        <div class="setting-row">
          <label for="dist-granularity">Distribution Granularity</label>
          <select id="dist-granularity">
            <option value="document">By Document</option>
            <option value="chapter">By Chapter</option>
          </select>
        </div>
        <div class="setting-row">
                    <label for="dist-mode">Distribution Mode</label>
          <select id="dist-mode">
```

**11b.** In app.js, find this exact line near the top of `UILayer`:

```
  distributionMode: 'equal',
  distributionItems: [],
```

Replace with:

```
  distributionMode: 'equal',
  distributionItems: [],
  distributionGranularity: 'document',
```

**11c.** In app.js, inside `bindExaminerEvents()`, find:

```
    document.getElementById('dist-mode').onchange = () => this.onDistributionModeChange();
```

Replace with:

```
    document.getElementById('dist-mode').onchange = () => this.onDistributionModeChange();
    document.getElementById('dist-granularity').onchange = () => this.updateDistributionPanel();
```

**11d.** In app.js, inside `updateDistributionPanel()`, find this exact block:

```
    const useChapters = this.selectedChapters.size > 0;
    let items = [];
    if (useChapters) {
      items = Array.from(this.selectedChapters).map(ch => ({
        key: ch,
        type: 'chapter',
        label: ch,
        poolSize: DataLayer.query({ chapters: [ch] }).length
      }));
    } else {
      items = Array.from(this.selectedDocuments).map(doc => ({
        key: doc,
        type: 'document',
        label: doc,
        poolSize: DataLayer.query({ documents: [doc] }).length
      }));
    }
```

Replace with exactly:

```
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
```

Note: document-level `poolSize` is now scoped to only the chapters actually selected within that
document (falling back to all of the document's chapters if none are individually selected), so
the displayed "max" stays accurate to what's really available under the current selection.

---

## TASK 12 — Smart distribution algorithm (fixes "Reset to Equal" and adds proportional chapter balance)

**Problem 1:** `resetDistributionToEqual()` and the initial equal-mode row calculation in
`updateDistributionPanel()` both compute a naive `Math.floor(target / items.length)` per item, cap
it at that item's pool size, and stop — any amount lost to capping (e.g. a small document that
can't take its full equal share) is never redistributed to the other items, so the total can fall
short of the target with no attempt to make up the difference. This is very likely why it looked
like the button "wasn't distributing" — the visible result frequently lands well under the target
without anything obviously happening.

**Problem 2 (your requested enhancement):** even when a document gets N questions assigned, the
actual question-picking logic (`DataLayer.selectWithDistribution`) currently grabs N random
questions from anywhere in that document, with no attempt to spread them across the document's
chapters. You asked for chapters within a document to get representation proportional to how many
questions they actually have.

Both are fixed by one shared allocation helper using a capped water-filling algorithm: give out
allocations in rounds, skipping (capping) any item once it hits its pool-size ceiling, and keep
redistributing what's left among items that still have room, until either the target is fully
allocated or every item is capped.

**12a.** In app.js, find this exact anchor (end of the constants block, start of the Data Layer
comment):

```
const RETENTION_ARCHIVE_AFTER_MONTHS = 6;
const RETENTION_PURGE_AFTER_YEARS = 5;

// ============================================================
// LAYER 2: DATA LAYER
// ============================================================
```

Replace it with exactly:

```
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

// ============================================================
// LAYER 2: DATA LAYER
// ============================================================
```

**12b.** In app.js, inside `updateDistributionPanel()`, find this exact block:

```
    if (mode === 'equal') {
      const perItem = Math.floor(target / items.length);
      rowsDiv.innerHTML = items.map((item, idx) => {
        let value = idx === 0 ? target - perItem * (items.length - 1) : perItem;
        value = Math.min(value, item.poolSize);
        return `
          <div class="dist-row">
            <label>${item.label}</label>
            <input type="number" class="dist-input" data-key="${item.key}" data-type="${item.type}" min="0" max="${item.poolSize}" value="${value}">
            <span class="dist-pool-size">(max: ${item.poolSize})</span>
          </div>
        `;
      }).join('');
    } else {
```

Replace with exactly:

```
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
```

**12c.** In app.js, find this exact function:

```
    resetDistributionToEqual() {
    const target = parseInt(document.getElementById('question-count').value) || 50;
    const mode = this.distributionMode;
    const inputs = document.querySelectorAll('.dist-input');
    if (mode === 'equal') {
      const perItem = Math.floor(target / inputs.length);
      inputs.forEach((inp, idx) => {
        let val = idx === 0 ? target - perItem * (inputs.length - 1) : perItem;
        val = Math.min(val, parseInt(inp.max) || 9999);
        inp.value = val;
      });
    } else {
      const perItem = Math.floor(100 / inputs.length);
      inputs.forEach((inp, idx) => {
        inp.value = idx === 0 ? 100 - perItem * (inputs.length - 1) : perItem;
      });
    }
    this.updateDistributionTotal();
  },
```

Replace with exactly:

```
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
```

**12d.** In app.js, find this exact function:

```
    selectWithDistribution(pool, config) {
    if (!config.distribution || Object.keys(config.distribution).length === 0) {
      return DataLayer.selectWithDifficultyDistribution(pool, config.questionCount, config.difficultyDistribution);
    }
    const selected = [];
    for (const [key, count] of Object.entries(config.distribution)) {
      let subset;
      if (config.distributionLevel === 'document') {
        subset = pool.filter(q => q.document === key);
      } else {
        subset = pool.filter(q => q.chapter === key);
      }
      selected.push(...this.shuffle(subset).slice(0, count));
    }
    return this.shuffle(selected);
  },
```

Replace with exactly:

```
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
```

---

## TASK 13 — Move remark entry from the exam screen to the results screen

**Problem:** Flagging a question mid-exam immediately pops open a remark text box and steals
focus, which interrupts the exam-taking flow. Remarks should only be collected after the exam is
graded, on the results screen, alongside the list of flagged questions.

**13a.** In index.html, find this exact block (inside `#exam-topbar`):

```
      <div id="flag-remark-input" style="display:none;margin-top:8px">
        <input type="text" id="flag-remark-text" placeholder="Add remark (optional)" maxlength="200">
        <button id="btn-save-remark">Save</button>
      </div>
```

Delete this block entirely (replace with nothing).

**13b.** In app.js, find this exact block:

```
        document.getElementById('btn-flag').onclick = () => {
      const s = ExamLogic.session;
      const q = s.questions[s.current_index];
      const wasFlagged = s.flags.has(q.id);
      ExamLogic.toggleFlag(q.id);
      this.syncPaletteStates(s);
      // Toggle remark input visibility
      const remarkInput = document.getElementById('flag-remark-input');
      if (!wasFlagged) {
        remarkInput.style.display = 'flex';
        document.getElementById('flag-remark-text').value = s.flagged_remarks?.[q.id] || '';
        document.getElementById('flag-remark-text').focus();
      } else {
        remarkInput.style.display = 'none';
        document.getElementById('flag-remark-text').value = '';
        // Clear remark when unflagging
        if (s.flagged_remarks) delete s.flagged_remarks[q.id];
        ExamLogic.saveSession();
      }
    };

    document.getElementById('btn-save-remark').onclick = () => {
      const s = ExamLogic.session;
      const q = s.questions[s.current_index];
      const remark = document.getElementById('flag-remark-text').value.trim();
      ExamLogic.addFlaggedRemark(q.id, remark);
      document.getElementById('flag-remark-input').style.display = 'none';
    };
```

Replace with exactly:

```
        document.getElementById('btn-flag').onclick = () => {
      const s = ExamLogic.session;
      const q = s.questions[s.current_index];
      ExamLogic.toggleFlag(q.id);
      this.syncPaletteStates(s);
    };
```

**13c.** In app.js, add a new `StorageLayer` method to persist remarks added after grading. Find
this exact block (end of `saveExam`):

```
    localStorage.setItem(EXAM_DETAIL_PREFIX + examId, JSON.stringify(results));
    await this.runRetentionSweep();
    return examId;
  },
```

Replace with exactly:

```
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
```

**13d.** In app.js, find this exact block inside `renderResults(results)`:

```
        // Flagged Questions & Remarks section
    const flaggedSection = document.getElementById('flagged-remarks-section');
    const flaggedContent = document.getElementById('flagged-remarks-content');
    const flaggedItems = results.flagged_remarks || {};
    const flaggedKeys = Object.keys(flaggedItems);
    if (flaggedKeys.length > 0) {
      flaggedSection.style.display = 'block';
      flaggedContent.innerHTML = flaggedKeys.map(qId => {
        const q = results.question_results.find(qr => qr.id === qId);
        if (!q) return '';
        return `<div class="review-item flagged">
          <p><strong>Q:</strong> ${q.question}</p>
          <p><strong>Remark:</strong> ${flaggedItems[qId]}</p>
          <p class="review-source">${q.document} › ${q.chapter}</p>
        </div>`;
      }).join('');
    } else {
      flaggedSection.style.display = 'none';
    }
```

Replace with exactly:

```
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
```

Do not touch `addFlaggedRemark()` in `ExamLogic` — it's no longer called anywhere after this task,
but leaving the unused method in place is harmless and safer than trying to remove it precisely.

---

## TASK 14 — Fix flagged questions with no remark not appearing in the admin panel

**Problem:** A question's flagged status (`question_results[i].flagged`) and its optional remark
(`flagged_remarks[questionId]`) are two separate pieces of data. `flagged_count` on the index entry
and the admin Flagged Remarks tab both currently only look at `flagged_remarks` — so a question
flagged with no remark (which, after Task 13, is now the common case until someone fills one in)
is invisible everywhere in the admin panel, even though it was genuinely flagged.

**14a.** In app.js, inside `StorageLayer.saveExam()`, find this exact line:

```
      flagged_count: Object.keys(results.flagged_remarks || {}).length,
```

Replace with exactly:

```
      flagged_count: (results.question_results || []).filter(q => q.flagged).length,
```

**14b.** In app.js, inside `AdminLayer.renderFlaggedTab()`, find this exact block:

```
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
```

Replace with exactly:

```
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
```

---

## TASK 15 — Admin button: restrict to Examiner/Results screens, reposition, enlarge

**15a.** In app.js, find this exact function:

```
  showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => {
      s.classList.add('hidden');
      s.classList.remove('active');
    });
    document.getElementById(id).classList.remove('hidden');
    document.getElementById(id).classList.add('active');
  },
```

Replace with exactly:

```
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
```

**15b.** In style.css, find this exact line:

```
.admin-access-btn { position: fixed; top: 10px; right: 10px; z-index: 400; opacity: 0.6; }
```

Replace with exactly:

```
.admin-access-btn { position: fixed; top: 16px; right: 16px; z-index: 400; opacity: 0.85; padding: 10px 18px; font-size: 14px; border-radius: 6px; }
```

Leave the `.admin-access-btn:hover` rule directly below it unchanged.

---

## TASK 16 — UTC clock, same position on every screen

**Design note:** rather than inserting a clock element into each screen's individual header (which
would mean four separate insertions, and risks reintroducing the kind of per-screen duplicate-ID
issue fixed earlier), this uses one fixed-position element outside all `.screen` divs — the same
pattern already used for the admin button. This guarantees identical positioning on literally every
screen with a single implementation, and it's unaffected by which screen is currently active.

**16a.** In index.html, find:

```
  <button id="btn-admin-access" class="admin-access-btn" type="button">⚙ Admin</button>
```

Replace with exactly:

```
  <button id="btn-admin-access" class="admin-access-btn" type="button">⚙ Admin</button>
  <div id="utc-clock" class="utc-clock"></div>
```

**16b.** In app.js, find this exact anchor (the same one from Task 12a — if the `waterFillAllocate`
function from Task 12 is already in place, this constant block will look different; find the
`LAYER 2: DATA LAYER` comment specifically, wherever it now sits, and insert directly above it):

```
// ============================================================
// LAYER 2: DATA LAYER
// ============================================================
```

Insert directly above that comment:

```
function updateUtcClock() {
  const el = document.getElementById('utc-clock');
  if (!el) return;
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  el.textContent = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} UTC`;
}

```

**16c.** In app.js, inside `bootstrap()`, find:

```
  AdminLayer.bindGlobalEvents();
```

Replace with exactly:

```
  AdminLayer.bindGlobalEvents();
  updateUtcClock();
  setInterval(updateUtcClock, 1000);
```

**16d.** In style.css, add:

```
.utc-clock {
  position: fixed;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 400;
  font-family: monospace;
  font-size: 13px;
  color: var(--text-muted);
  background: rgba(255,255,255,0.85);
  padding: 4px 12px;
  border-radius: 6px;
}
```

---

## General guardrails (same as before)

```
Rules for this session:
1. Only edit the file(s) named in each task. Never touch other files unless told to.
2. Make one change per task. Do not "also fix" anything else you notice — flag it to me instead and wait.
3. Always show a diff/preview before writing to disk.
4. If a search string doesn't match exactly (including whitespace), stop and tell me instead of guessing or applying a similar-looking change.
5. Never regenerate or rewrite a whole file from scratch — only apply the specific edit requested.
6. Complete tasks strictly in numeric order. Do not start Task N+1 until Task N is confirmed.
```
