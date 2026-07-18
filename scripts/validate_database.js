#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const QUESTIONS_PATH = path.join(__dirname, '..', 'data', 'questions.json');

function validate() {
  const data = JSON.parse(fs.readFileSync(QUESTIONS_PATH, 'utf8'));
  const questions = data.questions;
  const errors = [];

  // Check total matches array length
  if (data._total_questions !== questions.length) {
    errors.push(`_total_questions (${data._total_questions}) does not match actual length (${questions.length})`);
  }

  const ids = new Set();
  const requiredFields = ['id', 'source', 'q_type', 'document', 'chapter', 'topic', 'difficulty', 'question', 'options', 'correct_answer'];

  for (const q of questions) {
    // Duplicate ID check
    if (ids.has(q.id)) errors.push(`Duplicate ID: ${q.id}`);
    ids.add(q.id);

    // Required fields
    for (const field of requiredFields) {
      if (q[field] === undefined) errors.push(`Question ID ${q.id} missing field: ${field}`);
    }

        // Options validation: support variable-length (2-6 keys)
    if (q.options) {
      const keys = Object.keys(q.options);
      const validKeys = ['A','B','C','D','E','F','True','False'];
      const invalidKeys = keys.filter(k => !validKeys.includes(k));
      if (invalidKeys.length > 0) {
        errors.push(`Question ID ${q.id} has invalid option key(s): ${invalidKeys.join(',')}. Valid: ${validKeys.join(',')}`);
      }
      if (keys.length < 2 || keys.length > 6) {
        errors.push(`Question ID ${q.id} options has ${keys.length} keys (expected 2-6)`);
      }
    }

    // correct_answer must be a valid option key
    if (q.correct_answer && q.options) {
      const validAnswers = Object.keys(q.options);
      if (!validAnswers.includes(q.correct_answer)) {
        errors.push(`Question ID ${q.id} correct_answer "${q.correct_answer}" not in options keys [${validAnswers.join(',')}]`);
      }
    }

    // difficulty
    if (q.difficulty && !['easy','medium','hard'].includes(q.difficulty)) {
      errors.push(`Question ID ${q.id} difficulty "${q.difficulty}" invalid`);
    }

    // source
    if (q.source && !['bank','generated'].includes(q.source)) {
      errors.push(`Question ID ${q.id} source "${q.source}" invalid`);
    }

    // No "PENDING" correct_answer
    if (q.correct_answer === 'PENDING') {
      errors.push(`Question ID ${q.id} has PENDING correct_answer`);
    }
  }

  if (errors.length === 0) {
    console.log(`✓ VALID: ${questions.length} questions, no errors.`);
    process.exit(0);
  } else {
    console.error(`✗ INVALID: ${errors.length} error(s)`);
    errors.forEach(e => console.error(`  - ${e}`));
    process.exit(1);
  }
}

validate();