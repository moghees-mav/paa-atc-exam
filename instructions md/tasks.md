# ATC Exam Simulator — Question Bank: Re-issued Task 10 + Task 17 (CRUD/Export)

Read this whole file first. **Task 10 below was reported complete in an earlier session but is
verifiably absent from the current files** — `AdminLayer.renderQuestionsTab`, `onQbankDocFilter`,
and `renderQbankList` do not exist in app.js, and `.qbank-item` does not exist in style.css. Only
the stub call site (`if (tab === 'questions') this.renderQuestionsTab();`) is present. So: apply
Task 10 first, confirm it actually renders (open the Question Bank tab and check the browser
console for errors — don't just report the edit was made), then proceed to Task 17.

Work through tasks **in strict numeric order**. Show a diff before writing anything and wait for
confirmation before moving to the next task or sub-task. Do not report a task as complete without
having actually applied the edit — if a find/replace anchor doesn't match exactly, stop and say so
instead of skipping to the next task silently.

---

## TASK 10 (re-issued) — Question Bank tab: view + filters only

In app.js, inside `AdminLayer`, find this exact block:

```
    panel.innerHTML = `<h2>Flagged Questions (${sections.length})</h2>${sections.join('')}`;
  }
};
```

Replace it with exactly:

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

Stop here. Open the app, log into the admin dashboard, click "Question Bank," and confirm the list
renders with real questions and the filters work, with no console errors. Report back with what
you actually observed (not just "code added") before I approve moving to Task 17.

---

## TASK 17 — Question Bank: Add / Edit / Delete / Export

This is the highest-risk task so far — it changes what questions examinees actually see. Everything
here writes to `atc_custom_questions` in the shape already defined by `StorageLayer` (from the
earlier build plan): `{ added: [...], edited: { questionId: {...partial} }, deleted: [id, id] }`.
`DataLayer.questions` is the pool everything else in the app reads from (Distribution, exam
building, Replay) — so this task also makes `DataLayer` apply those edits on top of the base
`data/questions.json` every time it loads.

The edit form supports MCQ options A–F (E and F optional — leave blank if unused) or True/False,
plus Difficulty and Explanation fields, matching the full question schema used elsewhere in the app
(`explanation` is what the exam review screen displays; `difficulty` is what difficulty-distribution
exam building filters on — a custom question without one would never get picked into a
difficulty-weighted exam).

---

**17a.** In app.js, inside `DataLayer`, find this exact block:

```
  async init() {
    this.config = await fetch(CONFIG_PATH).then(r => r.json());
    this.qualifications = await fetch(QUALIFICATIONS_PATH).then(r => r.json());
    const db = await fetch(DATA_PATH).then(r => r.json());
    this.questions = db.questions;
    this.meta = {
      total: this.questions.length,
      documents: [...new Set(this.questions.map(q => q.document))].sort(),
      chapters: [...new Set(this.questions.map(q => q.chapter))].sort(),
    };
  },
```

Replace it with exactly:

```
  async init() {
    this.config = await fetch(CONFIG_PATH).then(r => r.json());
    this.qualifications = await fetch(QUALIFICATIONS_PATH).then(r => r.json());
    const db = await fetch(DATA_PATH).then(r => r.json());
    this._rawQuestions = db.questions;
    await this.applyCustomEdits();
  },

  /**
   * Rebuilds `this.questions` from the original fetched pool plus whatever admin edits are
   * stored in atc_custom_questions. Always rebuilds from `_rawQuestions` rather than mutating
   * `this.questions` in place, so this is safe to call repeatedly (e.g. right after an admin
   * saves an edit) without ever double-applying or losing track of the original data.
   */
  async applyCustomEdits() {
    const edits = await StorageLayer.getCustomQuestionEdits();
    let merged = this._rawQuestions.filter(q => !edits.deleted.includes(q.id));
    merged = merged.map(q => edits.edited[q.id] ? { ...q, ...edits.edited[q.id] } : q);
    merged = merged.concat(edits.added || []);
    this.questions = merged;
    this.meta = {
      total: this.questions.length,
      documents: [...new Set(this.questions.map(q => q.document))].sort(),
      chapters: [...new Set(this.questions.map(q => q.chapter))].sort(),
    };
  },
```

---

**17b.** In index.html, add the shared question-edit modal markup right before the feature-request
modal (find `<div id="modal-feature-request"` and insert this directly above it):

```
  <div id="modal-question-edit" class="modal-overlay hidden">
    <div class="modal-box" style="max-width:560px">
      <h3 id="modal-question-title">Edit Question</h3>
      <input type="hidden" id="qmodal-id">
      <div class="setting-row">
        <label for="qmodal-document">Document</label>
        <input type="text" id="qmodal-document" required>
      </div>
      <div class="setting-row">
        <label for="qmodal-chapter">Chapter</label>
        <input type="text" id="qmodal-chapter" required>
      </div>
      <div class="setting-row">
        <label for="qmodal-type">Type</label>
        <select id="qmodal-type">
          <option value="mcq">Multiple choice</option>
          <option value="true_false">True / False</option>
        </select>
      </div>
      <div class="setting-row">
        <label for="qmodal-difficulty">Difficulty</label>
        <select id="qmodal-difficulty">
          <option value="easy">Easy</option>
          <option value="medium">Medium</option>
          <option value="hard">Hard</option>
        </select>
      </div>
      <div class="setting-row">
        <label for="qmodal-question">Question</label>
        <textarea id="qmodal-question" rows="3" required></textarea>
      </div>
      <div class="setting-row">
        <label for="qmodal-explanation">Explanation (shown in exam review)</label>
        <textarea id="qmodal-explanation" rows="2"></textarea>
      </div>
      <div id="qmodal-mcq-options">
        <div class="setting-row"><label>Option A</label><input type="text" id="qmodal-opt-A"></div>
        <div class="setting-row"><label>Option B</label><input type="text" id="qmodal-opt-B"></div>
        <div class="setting-row"><label>Option C</label><input type="text" id="qmodal-opt-C"></div>
        <div class="setting-row"><label>Option D</label><input type="text" id="qmodal-opt-D"></div>
        <div class="setting-row"><label>Option E (optional)</label><input type="text" id="qmodal-opt-E"></div>
        <div class="setting-row"><label>Option F (optional)</label><input type="text" id="qmodal-opt-F"></div>
        <div class="setting-row">
          <label for="qmodal-correct-mcq">Correct option</label>
          <select id="qmodal-correct-mcq">
            <option value="A">A</option><option value="B">B</option>
            <option value="C">C</option><option value="D">D</option>
            <option value="E">E</option><option value="F">F</option>
          </select>
        </div>
      </div>
      <div id="qmodal-tf-options" class="hidden">
        <div class="setting-row">
          <label for="qmodal-correct-tf">Correct answer</label>
          <select id="qmodal-correct-tf">
            <option value="True">True</option>
            <option value="False">False</option>
          </select>
        </div>
      </div>
      <div class="modal-actions">
        <button id="btn-qmodal-cancel" type="button">Cancel</button>
        <button id="btn-qmodal-save" class="btn-primary" type="button">Save Question</button>
      </div>
    </div>
  </div>
```

---

**17c.** In app.js, inside `AdminLayer`, find this exact block (the `renderQuestionsTab` you just
confirmed in Task 10):

```
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
```

Replace it with exactly:

```
  async renderQuestionsTab() {
    const panel = document.getElementById('admin-tab-questions');
    const docs = [...new Set(DataLayer.questions.map(q => q.document))].sort();
    const docOptions = docs.map(d => `<option value="${d}">${d}</option>`).join('');

    panel.innerHTML = `
      <h2>Question Bank (${DataLayer.questions.length})</h2>
      <div class="setting-row">
        <button id="btn-qbank-add" class="btn-primary" type="button">+ Add New Question</button>
        <button id="btn-qbank-export" type="button">Export Database (.json)</button>
      </div>
      <div class="setting-row">
        <label for="qbank-doc-filter">Document</label>
        <select id="qbank-doc-filter"><option value="">All documents</option>${docOptions}</select>
        <label for="qbank-chapter-filter">Chapter</label>
        <select id="qbank-chapter-filter"><option value="">All chapters</option></select>
      </div>
      <div id="qbank-list"></div>`;

    document.getElementById('qbank-doc-filter').onchange = (e) => this.onQbankDocFilter(e.target.value);
    document.getElementById('qbank-chapter-filter').onchange = () => this.renderQbankList();
    document.getElementById('btn-qbank-add').onclick = () => this.openQuestionModal(null);
    document.getElementById('btn-qbank-export').onclick = () => this.exportDatabase();
    this.renderQbankList();
  },
```

---

**17d.** In app.js, inside `AdminLayer`, find this exact block (`renderQbankList`, also confirmed
in Task 10):

```
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

Replace it with exactly:

```
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
        <div class="qbank-item-actions">
          <button class="qbank-edit-btn" data-id="${q.id}" type="button">Edit</button>
          <button class="qbank-delete-btn" data-id="${q.id}" type="button">Delete</button>
        </div>
      </div>`).join('');
    const truncNote = list.length > 200 ? `<p><em>Showing first 200 of ${list.length} matches.</em></p>` : '';
    document.getElementById('qbank-list').innerHTML = truncNote + rows;

    document.querySelectorAll('.qbank-edit-btn').forEach(btn => {
      btn.onclick = () => {
        const q = DataLayer.questions.find(qq => qq.id === btn.dataset.id);
        if (q) this.openQuestionModal(q);
      };
    });
    document.querySelectorAll('.qbank-delete-btn').forEach(btn => {
      btn.onclick = () => this.deleteQuestion(btn.dataset.id);
    });
  },

  openQuestionModal(question) {
    document.getElementById('modal-question-title').textContent = question ? 'Edit Question' : 'Add New Question';
    document.getElementById('qmodal-id').value = question ? question.id : '';
    document.getElementById('qmodal-document').value = question ? question.document : '';
    document.getElementById('qmodal-chapter').value = question ? question.chapter : '';
    document.getElementById('qmodal-question').value = question ? question.question : '';
    document.getElementById('qmodal-difficulty').value = question?.difficulty || 'medium';
    document.getElementById('qmodal-explanation').value = question?.explanation || '';

    const isTf = question && question.q_type === 'true_false';
    document.getElementById('qmodal-type').value = isTf ? 'true_false' : 'mcq';
    this.onQmodalTypeChange();

    if (isTf) {
      document.getElementById('qmodal-correct-tf').value = question.correct_answer || 'True';
    } else {
      ['A', 'B', 'C', 'D', 'E', 'F'].forEach(letter => {
        document.getElementById('qmodal-opt-' + letter).value = question?.options?.[letter] || '';
      });
      document.getElementById('qmodal-correct-mcq').value = question?.correct_answer || 'A';
    }
    document.getElementById('modal-question-edit').classList.remove('hidden');
  },

  closeQuestionModal() {
    document.getElementById('modal-question-edit').classList.add('hidden');
  },

  onQmodalTypeChange() {
    const isTf = document.getElementById('qmodal-type').value === 'true_false';
    document.getElementById('qmodal-mcq-options').classList.toggle('hidden', isTf);
    document.getElementById('qmodal-tf-options').classList.toggle('hidden', !isTf);
  },

  async saveQuestionFromModal() {
    const id = document.getElementById('qmodal-id').value;
    const isNew = !id;
    const document_ = document.getElementById('qmodal-document').value.trim();
    const chapter = document.getElementById('qmodal-chapter').value.trim();
    const questionText = document.getElementById('qmodal-question').value.trim();
    const qType = document.getElementById('qmodal-type').value;

    if (!document_ || !chapter || !questionText) {
      alert('Document, Chapter, and Question text are required.');
      return;
    }

    const difficulty = document.getElementById('qmodal-difficulty').value;
    const explanation = document.getElementById('qmodal-explanation').value.trim();

    let payload;
    if (qType === 'true_false') {
      payload = {
        document: document_, chapter, question: questionText, q_type: 'true_false',
        difficulty, explanation,
        options: { True: 'True', False: 'False' },
        correct_answer: document.getElementById('qmodal-correct-tf').value
      };
    } else {
      const options = {};
      ['A', 'B', 'C', 'D', 'E', 'F'].forEach(letter => {
        const val = document.getElementById('qmodal-opt-' + letter).value.trim();
        if (val) options[letter] = val;
      });
      payload = {
        document: document_, chapter, question: questionText, q_type: 'mcq',
        difficulty, explanation,
        options, correct_answer: document.getElementById('qmodal-correct-mcq').value
      };
    }

    const edits = await StorageLayer.getCustomQuestionEdits();
    if (isNew) {
      payload.id = 'custom_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      edits.added.push(payload);
    } else {
      const wasCustomAdded = edits.added.some(q => q.id === id);
      if (wasCustomAdded) {
        const idx = edits.added.findIndex(q => q.id === id);
        edits.added[idx] = { ...edits.added[idx], ...payload };
      } else {
        edits.edited[id] = payload;
      }
    }
    await StorageLayer.saveCustomQuestionEdits(edits);
    await DataLayer.applyCustomEdits();
    this.closeQuestionModal();
    this.renderQuestionsTab();
  },

  async deleteQuestion(id) {
    if (!confirm('Delete this question? This cannot be undone from the UI (though Export lets you keep a backup first).')) return;
    const edits = await StorageLayer.getCustomQuestionEdits();
    const wasCustomAdded = edits.added.some(q => q.id === id);
    if (wasCustomAdded) {
      edits.added = edits.added.filter(q => q.id !== id);
    } else {
      if (!edits.deleted.includes(id)) edits.deleted.push(id);
      delete edits.edited[id];
    }
    await StorageLayer.saveCustomQuestionEdits(edits);
    await DataLayer.applyCustomEdits();
    this.renderQuestionsTab();
  },

  exportDatabase() {
    const blob = new Blob([JSON.stringify({ questions: DataLayer.questions }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `questions-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
};
```

---

**17e.** In app.js, find the `AdminLayer.bindGlobalEvents()` method (the one that currently binds
`btn-admin-access`, `btn-admin-logout`, and the tab buttons). Find this exact line inside it:

```
    document.querySelectorAll('.admin-tab-btn[data-tab]').forEach(btn => {
      btn.onclick = () => this.switchTab(btn.dataset.tab);
    });
```

Add directly after it, still inside `bindGlobalEvents()`:

```
    document.getElementById('btn-qmodal-cancel').onclick = () => this.closeQuestionModal();
    document.getElementById('btn-qmodal-save').onclick = () => this.saveQuestionFromModal();
    document.getElementById('qmodal-type').onchange = () => this.onQmodalTypeChange();
```

---

**17f.** In style.css, add:

```
.qbank-item-actions { margin-top: 4px; display: flex; gap: 8px; }
.qbank-item-actions button { font-size: 12px; padding: 4px 10px; }
```

---

Stop here and confirm: adding a question, editing an existing one, deleting one, and exporting all
work correctly, and that a freshly created exam actually pulls in an admin-added question (i.e.
`DataLayer.applyCustomEdits()` is genuinely wired into the live pool, not just the admin view).
Report back with what you actually tested — this is the task where "I made the edit" and "it
actually works end to end" are most likely to diverge.

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
7. Before reporting any task as complete, actually verify the change is present and functional — don't just report that an edit was written.
```
