'use strict';

import {
  ADMIN_PASSWORD_KEY, ADMIN_PASSWORD, ADMIN_PASSWORD_LAST_CHANGED_KEY,
  PASSWORD_EXPIRY_DAYS, PASSWORD_WARN_DAYS, FEATURE_REQUEST_KEY
} from './constants.js';
import { DataLayer } from './data-layer.js';
import { StorageLayer } from './storage-layer.js';
import { UILayer } from './ui.js';

// ============================================================
// ADMIN LAYER
// ============================================================
export const AdminLayer = {
  authenticated: false,

  bindGlobalEvents() {
    document.getElementById('btn-admin-access').onclick = () => this.tryLogin();
    document.getElementById('btn-admin-logout').onclick = () => this.logout();
    document.querySelectorAll('.admin-tab-btn[data-tab]').forEach(btn => {
      btn.onclick = () => this.switchTab(btn.dataset.tab);
    });
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
    if (tab === 'qualifications') this.renderQualificationsTab();
    if (tab === 'security') this.renderSecurityTab();
  },

  // ---- Stats Tab ----
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

  // ---- Requests Tab ----
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

  // ---- Flagged Tab ----
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

  // ---- Question Bank Manager (CRUD) ----
  renderQuestionsTab() {
    const docSelect = document.getElementById('admin-qbank-doc');
    const chSelect = document.getElementById('admin-qbank-chapter');
    const addBtn = document.getElementById('btn-admin-add-question');
    const exportBtn = document.getElementById('btn-admin-export-json');

    const currentDoc = docSelect.value;
    docSelect.innerHTML = '<option value="">-- All Documents --</option>';
    DataLayer.meta.documents.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d;
      opt.textContent = d;
      if (d === currentDoc) opt.selected = true;
      docSelect.appendChild(opt);
    });

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

    docSelect.onchange = () => this.renderQuestionsTab();
    chSelect.onchange = () => this.renderQbankList();
    addBtn.onclick = () => this.openQuestionEditor(null);
    exportBtn.onclick = () => this.exportDatabase();

    this._populateEditorDatalists();
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

    container.querySelectorAll('.btn-qbank-edit').forEach(btn => {
      btn.onclick = () => this.openQuestionEditor(btn.dataset.id);
    });
    container.querySelectorAll('.btn-qbank-delete').forEach(btn => {
      btn.onclick = () => this.deleteQuestion(btn.dataset.id);
    });
  },

  // ---- Question Editor Modal ----
  openQuestionEditor(questionId) {
    const modal = document.getElementById('modal-question-editor');
    const titleEl = document.getElementById('modal-qeditor-title');
    const saveBtn = document.getElementById('btn-qeditor-save');

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
      titleEl.textContent = 'Add New Question';
      saveBtn.dataset.editingId = '';
    }

    this._syncCorrectOptions();
    modal.classList.remove('hidden');
  },

  _syncCorrectOptions() {
    const type = document.getElementById('qedit-type').value;
    const correctSelect = document.getElementById('qedit-correct');
    const optionsArea = document.getElementById('qedit-options-area');

    if (type === 'true_false') {
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
      question, explanation,
      document: document_name, chapter, topic,
      difficulty, q_type, options, correct_answer
    };

    const edits = await StorageLayer.getCustomQuestionEdits();

    if (editingId) {
      const isCustomAdded = edits.added && edits.added.some(a => String(a.id) === String(editingId));
      if (isCustomAdded) {
        edits.added = edits.added.map(a => String(a.id) === String(editingId) ? questionObj : a);
      } else {
        edits.edited[editingId] = questionObj;
      }
    } else {
      if (!edits.added) edits.added = [];
      edits.added.push(questionObj);
    }

    await StorageLayer.saveCustomQuestionEdits(edits);
    alert('Question saved successfully.');
    this.closeQuestionEditor();
    await DataLayer.init();
    this.renderQuestionsTab();
  },

  async deleteQuestion(questionId) {
    if (!confirm('Delete this question from the active pool?\n\nThis action can be undone by clearing localStorage or re-importing questions.json.')) return;

    const edits = await StorageLayer.getCustomQuestionEdits();

    if (edits.added && edits.added.some(a => String(a.id) === String(questionId))) {
      edits.added = edits.added.filter(a => String(a.id) !== String(questionId));
    } else {
      if (!edits.deleted) edits.deleted = [];
      if (!edits.deleted.includes(questionId)) {
        edits.deleted.push(questionId);
      }
      if (edits.edited && edits.edited[questionId]) {
        delete edits.edited[questionId];
      }
    }

    await StorageLayer.saveCustomQuestionEdits(edits);
    await DataLayer.init();
    this.renderQuestionsTab();
  },

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
  },

  // ---- Qualifications Tab ----
  async renderQualificationsTab() {
    const panel = document.getElementById('admin-tab-qualifications');
    const allDocs = DataLayer.meta.documents;
    const quals = DataLayer.qualifications.qualifications;

    const qualCards = quals.map((qual, qIdx) => {
      const docBlocks = qual.documents.map((doc, dIdx) => {
        const allChaptersForDoc = DataLayer.getChaptersForDocument(doc.name);
        const chapterCheckboxes = allChaptersForDoc.map(ch => `
          <label class="qual-chapter-checkbox">
            <input type="checkbox" data-qual="${qIdx}" data-doc="${dIdx}" data-chapter="${ch}" ${doc.chapters.includes(ch) ? 'checked' : ''}>
            ${ch}
          </label>`).join('');
        return `
          <div class="qual-doc-block">
            <div class="qual-doc-header">
              <strong>${doc.name}</strong>
              ${doc._status ? `<span class="qual-status-badge">${doc._status}</span>` : ''}
              <button class="btn-qual-remove-doc" data-qual="${qIdx}" data-doc="${dIdx}" type="button">Remove Document</button>
            </div>
            ${doc._todo ? `<p class="qual-todo-note">TODO: ${doc._todo}</p>` : ''}
            <div class="qual-chapter-grid">${chapterCheckboxes || '<em>No chapters found in the question bank for this document.</em>'}</div>
          </div>`;
      }).join('');

      const usedDocNames = qual.documents.map(d => d.name);
      const availableDocs = allDocs.filter(d => !usedDocNames.includes(d));
      const addDocOptions = availableDocs.map(d => `<option value="${d}">${d}</option>`).join('');

      return `
        <details class="qual-card" open>
          <summary>${qual.name}</summary>
          <div class="qual-card-body">
            <div class="setting-row">
              <label>Name</label>
              <input type="text" class="qual-name-input" data-qual="${qIdx}" value="${qual.name}">
            </div>
            <div class="setting-row">
              <label>Description</label>
              <input type="text" class="qual-desc-input" data-qual="${qIdx}" value="${qual.description || ''}">
            </div>
            ${docBlocks}
            <div class="setting-row">
              <select class="qual-add-doc-select" data-qual="${qIdx}">
                <option value="">-- add a document --</option>
                ${addDocOptions}
              </select>
              <button class="btn-qual-add-doc" data-qual="${qIdx}" type="button">Add Document</button>
            </div>
            <button class="btn-qual-delete" data-qual="${qIdx}" type="button">Delete Qualification</button>
          </div>
        </details>`;
    }).join('');

    panel.innerHTML = `
      <div class="setting-row">
        <button id="btn-qual-add-new" class="btn-primary" type="button">+ Add New Qualification</button>
        <button id="btn-qual-export" type="button">Export qualifications.json</button>
        <button id="btn-qual-reset" type="button">Reset to Shipped Config</button>
      </div>
      <div id="qual-list">${qualCards}</div>
      <button id="btn-qual-save" class="btn-primary" type="button">Save All Changes</button>
      <p id="qual-save-status" style="font-size:13px;margin-top:8px"></p>`;

    this._bindQualificationEvents();
  },

  _bindQualificationEvents() {
    const quals = DataLayer.qualifications.qualifications;

    document.querySelectorAll('.qual-name-input').forEach(inp => {
      inp.onchange = () => { quals[inp.dataset.qual].name = inp.value.trim(); };
    });
    document.querySelectorAll('.qual-desc-input').forEach(inp => {
      inp.onchange = () => { quals[inp.dataset.qual].description = inp.value.trim(); };
    });
    document.querySelectorAll('.qual-chapter-checkbox input').forEach(cb => {
      cb.onchange = () => {
        const doc = quals[cb.dataset.qual].documents[cb.dataset.doc];
        const ch = cb.dataset.chapter;
        if (cb.checked) {
          if (!doc.chapters.includes(ch)) doc.chapters.push(ch);
        } else {
          doc.chapters = doc.chapters.filter(c => c !== ch);
        }
      };
    });
    document.querySelectorAll('.btn-qual-remove-doc').forEach(btn => {
      btn.onclick = () => {
        quals[btn.dataset.qual].documents.splice(btn.dataset.doc, 1);
        this.renderQualificationsTab();
      };
    });
    document.querySelectorAll('.btn-qual-add-doc').forEach(btn => {
      btn.onclick = () => {
        const select = document.querySelector(`.qual-add-doc-select[data-qual="${btn.dataset.qual}"]`);
        const docName = select.value;
        if (!docName) return;
        quals[btn.dataset.qual].documents.push({ name: docName, chapters: [] });
        this.renderQualificationsTab();
      };
    });
    document.querySelectorAll('.btn-qual-delete').forEach(btn => {
      btn.onclick = () => {
        if (!confirm(`Delete qualification "${quals[btn.dataset.qual].name}"?`)) return;
        quals.splice(btn.dataset.qual, 1);
        this.renderQualificationsTab();
      };
    });
    document.getElementById('btn-qual-add-new').onclick = () => {
      const name = prompt('New qualification name:');
      if (!name) return;
      quals.push({ name: name.trim(), description: '', documents: [] });
      this.renderQualificationsTab();
    };
    document.getElementById('btn-qual-save').onclick = async () => {
      await StorageLayer.saveQualificationOverride(quals);
      await DataLayer.init();
      this.renderQualificationsTab();
    };
    document.getElementById('btn-qual-export').onclick = () => {
      const payload = { _description: DataLayer.qualifications._description, qualifications: quals };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'qualifications-export.json'; a.click();
      URL.revokeObjectURL(url);
    };
    document.getElementById('btn-qual-reset').onclick = async () => {
      if (!confirm('Discard all local edits and revert to the shipped qualifications.json?')) return;
      await StorageLayer.clearQualificationOverride();
      await DataLayer.init();
      this.renderQualificationsTab();
    };
  },

  // ---- Security Tab ----
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
  }
};