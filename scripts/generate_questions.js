#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { extractText } = require('./utils/word_reader');
const Anthropic = require('@anthropic-ai/sdk');

const REF_DOC_PATH = path.join(__dirname, '..', 'config', 'ref_doc.md');
const SOURCE_DOCS_DIR = path.join(__dirname, '..', 'source_docs');
const QUESTIONS_PATH = path.join(__dirname, '..', 'data', 'questions.json');
const LOG_PATH = path.join(__dirname, 'output', 'generation_log.json');

// Ensure output directory exists
if (!fs.existsSync(path.join(__dirname, 'output'))) {
  fs.mkdirSync(path.join(__dirname, 'output'), { recursive: true });
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function loadLog() {
  if (fs.existsSync(LOG_PATH)) {
    return JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
  }
  return { processedDocuments: [] };
}

function saveLog(log) {
  fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
}

function loadQuestions() {
  const data = JSON.parse(fs.readFileSync(QUESTIONS_PATH, 'utf8'));
  return data.questions;
}

function appendQuestions(newQuestions) {
  const data = JSON.parse(fs.readFileSync(QUESTIONS_PATH, 'utf8'));
  const maxId = Math.max(...data.questions.map(q => q.id), 0);
  newQuestions.forEach((q, idx) => {
    q.id = maxId + idx + 1;
    q.source = 'generated';
  });
  data.questions.push(...newQuestions);
  data._total_questions = data.questions.length;
  data._last_updated = new Date().toISOString();
  fs.writeFileSync(QUESTIONS_PATH, JSON.stringify(data, null, 2));
  console.log(`  → Appended ${newQuestions.length} questions. New total: ${data.questions.length}`);
}

function parseDocumentList() {
  const content = fs.readFileSync(REF_DOC_PATH, 'utf8');
  const lines = content.split('\n');
  const docs = [];
  for (const line of lines) {
    const match = line.match(/^- (.+?) -/);
    if (match) docs.push(match[1].trim());
  }
  return docs;
}

function chunkByHeadings(text) {
  const sections = [];
  const lines = text.split('\n');
  let currentHeading = 'General';
  let currentContent = [];
  for (const line of lines) {
    if (line.match(/^[A-Z][A-Z\s]{3,}$/) || line.match(/^\d+\.\s+[A-Z]/)) {
      if (currentContent.length > 0) {
        sections.push({ heading: currentHeading, content: currentContent.join('\n').trim() });
      }
      currentHeading = line.trim();
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }
  if (currentContent.length > 0) {
    sections.push({ heading: currentHeading, content: currentContent.join('\n').trim() });
  }
  return sections;
}

async function generateQuestionsForSection(docName, section, numQuestions = 3) {
  const systemPrompt = `You are a technical question writer for an Air Traffic Control exam.
Your questions must be derived STRICTLY from the provided document text.
Use the exact wording from the document wherever possible.
Vary difficulty: 50% easy (direct recall), 20% medium (application), 30% hard (synthesis or situation-based).
For situation-based questions, base the scenario on patterns found in the document — never invent novel situations.
Return ONLY a valid JSON array. No preamble, no markdown.`;

  const userPrompt = `Document: ${docName}
Chapter/Section: ${section.heading}
Source text:
---
${section.content.substring(0, 3000)}
---
Generate ${numQuestions} multiple-choice questions following this exact schema:
{
  'question': '...',
  'options': {'A':'...','B':'...','C':'...','D':'...'},
  'correct_answer': 'B',
  'difficulty': 'easy|medium|hard',
  'explanation': 'Cite the specific clause or paragraph from the document.'
}`;

  const response = await client.messages.create({
    model: 'claude-3-haiku-20240307',
    max_tokens: 2000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });
  const content = response.content[0].text;
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('No JSON array found in response');
  let questions = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(questions)) questions = [questions];
  return questions.map(q => ({
    ...q,
    document: docName,
    chapter: section.heading,
    source: 'generated',
    tags: [docName.toLowerCase().replace(/\s/g, '-'), section.heading.toLowerCase().replace(/\s/g, '-')]
  }));
}

function isDuplicate(question, existingQuestions) {
  for (const eq of existingQuestions) {
    const sim = similarity(question.question.toLowerCase(), eq.question.toLowerCase());
    if (sim > 0.8) return true;
  }
  return false;
}

function similarity(a, b) {
  const setA = new Set(a.split(/\s+/));
  const setB = new Set(b.split(/\s+/));
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const specificDoc = args.includes('--doc') ? args[args.indexOf('--doc')+1] : null;

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ERROR: ANTHROPIC_API_KEY environment variable not set.');
    process.exit(1);
  }

  const log = loadLog();
  const docs = parseDocumentList();
  const existingQuestions = loadQuestions();

  for (const docName of docs) {
    if (specificDoc && docName !== specificDoc) continue;
    if (!force && log.processedDocuments.includes(docName)) {
      console.log(`Skipping ${docName} (already processed). Use --force to reprocess.`);
      continue;
    }

    const filePath = path.join(SOURCE_DOCS_DIR, `${docName}.docx`);
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      continue;
    }

    console.log(`Processing ${docName}...`);
    const fullText = await extractText(filePath);
    const sections = chunkByHeadings(fullText);
    let totalGenerated = 0;
    let totalSkipped = 0;

    for (const section of sections) {
      if (section.content.length < 200) continue; // skip short sections
      let attempts = 0;
      while (attempts < 2) {
        try {
          const qs = await generateQuestionsForSection(docName, section);
          const newQs = [];
          for (const q of qs) {
            if (isDuplicate(q, existingQuestions)) {
              totalSkipped++;
            } else {
              newQs.push(q);
              existingQuestions.push(q); // for future dup checks in same run
            }
          }
          if (newQs.length) appendQuestions(newQs);
          totalGenerated += newQs.length;
          break;
        } catch (err) {
          console.error(`  Error on section "${section.heading}": ${err.message}`);
          attempts++;
          if (attempts === 2) console.error(`  Skipping section after 2 failures.`);
        }
      }
    }
    console.log(`  → Generated ${totalGenerated} questions, skipped ${totalSkipped} duplicates.`);
    log.processedDocuments.push(docName);
    saveLog(log);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});