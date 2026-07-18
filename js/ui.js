'use strict';

import { waterFillAllocate, updateUtcClock } from './constants.js';
import { DataLayer } from './data-layer.js';
import { StorageLayer } from './storage-layer.js';
import { ExamLogic } from './exam-logic.js';

// ============================================================
// CUSTOM DIALOG MODAL
// ============================================================
export const DialogLogic = {
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
// FEATURE REQUESTS
// ============================================================
export const FeatureRequestLogic = {
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
// UI LAYER
// ============================================================
export const UILayer = {
  currentQualification: null,
  selectedDocuments: new Set(),
  selectedChapters: new Set(),
  distributionMode: 'equal',
  distributionItems: [],
  distributionGranularity: 'document',
  _questionFontSize: 16,

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
    this.selectedDocuments.clear();
    this.selectedChapters.clear();
    for (const doc of qual.documents) {
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
    for (const db of allDbDocs) {
      if (!orderedDocs.includes(db)) orderedDocs.push(db);
    }

    for (const docName of orderedDocs) {
      const chaptersInDoc = DataLayer.getChaptersForDocument(docName);
      if (chaptersInDoc.length === 0) continue;

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

      for (const ch of chaptersInDoc) {
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
    const inputs = document.querySelectorAll('.dist-input');
    const total = Array.from(inputs).reduce((sum, inp) => sum + (parseInt(inp.value) || 0), 0);
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
        const assigned = Object.values(distribution).reduce((a,b)=>a+b, 0);
        if (assigned !== questionCount && Object.keys(distribution).length > 0) {
          const firstKey = Object.keys(distribution)[0];
          distribution[firstKey] += (questionCount - assigned);
        }
      }
    }

    return {
      examinerName, questionCount, timerMinutes, passThreshold, filters,
      distribution, distributionLevel, difficultyDistribution: diffConfig,
    };
  },

  onCreateExam() {
    const config = this.getExamConfig();
    if (!config) return;
    ExamLogic.examinerConfig = config;
    this.initExaminee();
  },

  initExaminee() {
    this.showScreen('screen-examinee');
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
    document.getElementById('btn-submit-exam').onclick = () => this.confirmFinalSubmit();
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

  renderResults(results) {
    this.showScreen('screen-results');
    document.getElementById('results-exam-id').textContent = `Exam ID: ${results.exam_id || ''}`;

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