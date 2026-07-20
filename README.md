# ATC Exam Simulator v2 — Pakistan Airports Authority

Server-based exam simulation system for PAA Air Traffic Controllers.

## Current State

### Mode 2 (Official Exams) — Content Readiness

⚠️ **Mode 2 has zero approved generated content.** All 2080 generated questions are at `review_status = 'reviewed'`, but the serving gate requires `'approved'`. An operational review/approval pass is required before any official exam can use generated questions. Bank-sourced questions (2048 questions) are always pre-approved and currently work in both modes.

### Documented Deviations from Spec

1. **`correct_answer` format**: Letter-based (A–F) everywhere, not index-based for array-format questions. This is a deliberate simplification — one grading path instead of two. See `interfaces/question-service.js` header comment for details.
2. **Export route shape**: `GET /api/questions/export/:document` (path param) instead of `GET /api/questions/export?document=X` (query param). No callers use the query-param form.
3. **Eligibility resolver document resolution**: Uses `qualifications.json` (static config), not question-level `applicability` metadata (which is empty for all seed data). See `interfaces/eligibility-resolver.js` header comment.

### Known Gaps

- `exam_question_timings` table exists in schema but is never written to.
- Tab-switch recording is unconditional (no config flag to disable per spec's "storage/cost toggleable" requirement).
- Exam-setup UI does not call `POST /api/eligibility/resolve` yet — server route exists, frontend wiring pending.
- No analytics write path from grading to `question_analytics` table.
- No un-retire/restore endpoint for questions.
- `question_flags` `decision`/`remarks` filtering on the result endpoint was added in QA pass (2026-07-21) — was leaking mid-review.

## Stack

- **Backend**: Express.js + SQLite (sql.js — WebAssembly, synchronous writes)
- **Frontend**: Vanilla HTML/CSS/JS (no frameworks)
- **Identity**: RTL-db personnel lookup (HTTP API)
- **Auth**: Session-cookie (express-session)

## Quick Start

```bash
npm install
npm start
# → http://localhost:3099
```

## API Endpoints

See `server.js` for full route list. Key routes:
- `POST /api/auth/login` — RTL-db backed login
- `POST /api/sessions` — Create exam session
- `GET /api/sessions/:sessionId/result` — Exam result (decision/remarks hidden until final)
- `POST /api/sessions/:sessionId/flag` — Flag question (Mode 2 only)
- `POST /api/sessions/:sessionId/flags/:flagId/resolve` — Examiner flag resolution
- `POST /api/sessions/:sessionId/finalize` — Finalize result
- `POST /api/sessions/:sessionId/retake` — Retake (if offered)
- `GET /api/questions` — List questions with v2 filters
- `POST /api/questions` — Create question (QB Editor role)
- `GET /api/questions/export/:document` — Export document JSON
- `POST /api/eligibility/resolve` — Eligibility resolver (route exists, frontend wiring pending)
- `PUT /api/users/:serviceNo/role` — Grant/revoke role (Sys Admin only)
- `PUT /api/users/:serviceNo/active` — Activate/deactivate user
- `GET /api/audit` — Query audit log (Sys Admin or Supervisor)