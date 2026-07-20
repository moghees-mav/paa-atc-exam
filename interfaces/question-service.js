/**
 * Question Service — Interface contract
 *
 * Task 04 (Window 1) owns the full CRUD implementation.
 * Phase 0 provides the DB schema + read-only GET endpoints in server.js.
 *
 * Key v2 contract:
 * - options is variable-length array (2-6), NOT fixed 4-key object
 * - true_false is a constrained MCQ (same code path)
 * - fib is reserved but not implemented
 * - review_status gates Mode 2 serving for source:generated questions
 * - analytics lives in separate question_analytics table
 *
 * ── Documented Deviations from Task 04 Spec ─────────────
 * 1. correct_answer is letter-based (A–F) everywhere, NOT index-based
 *    for array-format questions. The original spec said new array-format
 *    questions should use index-based correct_answer. This was unified
 *    to letter-based for both legacy and new formats — one grading path
 *    instead of two. All consumers (grading, admin UI, session build,
 *    eligibility resolver) consistently use letter format. Do not "fix"
 *    this back to index-based without retesting every downstream path.
 * 2. Export route uses path param (GET /api/questions/export/:document)
 *    rather than query param (GET /api/questions/export?document=X).
 *    No callers use the query-param form. Left as-is since path param
 *    avoids conflicts with other query parameters.
 * ────────────────────────────────────────────────────────
 */

/**
 * @typedef {'mcq'|'true_false'|'fib'} QuestionType
 * @typedef {'easy'|'medium'|'hard'} Difficulty
 * @typedef {'active'|'under_review'|'retired'|'superseded'} QuestionStatus
 * @typedef {'pending'|'reviewed'|'approved'|'rejected'} ReviewStatus
 */

/**
 * @typedef {Object} Question
 * @property {number} id
 * @property {QuestionType} q_type
 * @property {string} document
 * @property {string} chapter
 * @property {string} topic
 * @property {Difficulty} difficulty
 * @property {string} question
 * @property {string[]} options - variable-length (2-6)
 * @property {string} correct_answer
 * @property {string} explanation
 * @property {string[]} tags
 * @property {string} [source_section]
 * @property {string} [source_paragraph]
 * @property {string} [effective_date]
 * @property {string} [airac_cycle]
 * @property {QuestionStatus} status
 * @property {Object} applicability - {qualification_groups: string[], locations: string[]}
 * @property {number} version
 * @property {number|null} superseded_by
 * @property {ReviewStatus} review_status
 * @property {string|null} reviewed_by
 */

/**
 * List questions with filters.
 *
 * @param {Object} filters
 * @param {string} [filters.document]
 * @param {string} [filters.topic]
 * @param {Difficulty} [filters.difficulty]
 * @param {QuestionStatus} [filters.status]
 * @param {ReviewStatus} [filters.review_status]
 * @param {string} [filters.q_type]
 * @param {number} [filters.limit=50]
 * @param {number} [filters.offset=0]
 * @returns {Promise<{questions:Question[], total:number}>}
 */
export async function listQuestions(filters = {}) {
  throw new Error('Not implemented — Phase 0 GET stub in server.js');
}

/**
 * Create a new question.
 *
 * @param {Omit<Question, 'id'|'version'|'created_at'|'updated_at'>} data
 * @returns {Promise<Question>}
 */
export async function createQuestion(data) {
  throw new Error('Not implemented — Task 04');
}

/**
 * Update an existing question (creates new version).
 *
 * @param {number} id
 * @param {Partial<Question>} data
 * @returns {Promise<Question>}
 */
export async function updateQuestion(id, data) {
  throw new Error('Not implemented — Task 04');
}

/**
 * Import questions from a per-document JSON file.
 *
 * @param {string} filePath - path to data/questions/<slug>.json
 * @returns {Promise<{imported: number, errors: string[]}>}
 */
export async function importFromFile(filePath) {
  throw new Error('Not implemented — Task 04');
}

/**
 * Export questions for a document to JSON file.
 *
 * @param {string} document
 * @returns {Promise<Object>} - the per-document JSON structure
 */
export async function exportToFile(document) {
  throw new Error('Not implemented — Task 04');
}