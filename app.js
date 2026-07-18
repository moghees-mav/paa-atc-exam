'use strict';

import { updateUtcClock } from './js/constants.js';
import { DataLayer } from './js/data-layer.js';
import { ExamLogic } from './js/exam-logic.js';
import { UILayer } from './js/ui.js';
import { FeatureRequestLogic } from './js/ui.js';
import { AdminLayer } from './js/admin-ui.js';

// ============================================================
// BOOTSTRAP — ES module entry point
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
      ExamLogic.startTimer();
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