# Data Pipeline — How to Use

## First-Time Setup
npm install mammoth xlsx @anthropic-ai/sdk

## Workflow Order (always run in this sequence)

1. PARSE QUESTION BANK (script skipped for now, will develop later)
   node scripts/parse_word_questions.js
   → Reads all .docx files in question_bank_raw/ (except answer_key.docx)
   → Output: scripts/output/parsed_questions_raw.json

2. PARSE ANSWER KEY (script skipped for now, will develop later)
   node scripts/parse_answer_key.js
   → Reads question_bank_raw/answer_key.docx
   → Output: scripts/output/answer_key_map.json

3. MERGE INTO DATABASE (script skipped for now, will develop later)
   node scripts/merge_answers.js
   → Combines questions + answers, writes to data/questions.json

4. VALIDATE DATABASE
   node scripts/validate_database.js
   → Must pass before running the app

5. GENERATE AI QUESTIONS (run once per document)
   export ANTHROPIC_API_KEY=your_key_here
   node scripts/generate_questions.js
   → Reads ref_doc.md, processes source_docs/, appends to questions.json
   → Re-validate after: node scripts/validate_database.js

## Adding New Questions Later
- Drop new Word files into question_bank_raw/
- Repeat steps 1-4
- Script will append only — existing questions are never modified

## Adding New Source Documents
- Add document entry to config/ref_doc.md
- Place .docx file in source_docs/
- Run: node scripts/generate_questions.js --doc "Document Name"
- Re-validate