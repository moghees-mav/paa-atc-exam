# Changelog — ATC Exam Simulator

## Task 11 — Distribution panel: default to document-level, add granularity toggle
- **11a**: Added `<select id="dist-granularity">` with "By Document" / "By Chapter" options to `index.html` distribution panel.
- **11b**: Added `distributionGranularity: 'document'` property to `UILayer` in `app.js`.
- **11c**: Added `dist-granularity` change handler in `bindExaminerEvents()`.
- **11d**: Updated `updateDistributionPanel()` to read granularity from new select, use water-fill-allocate-style logic for document-level poolSize scoped to selected chapters.

## Task 12 — Smart distribution algorithm (water-fill allocator)
- **12a**: Added `waterFillAllocate()` function between constants and DataLayer — a capped water-filling allocator that redistributes leftover capacity across remaining items.
- **12b**: Updated equal-mode rendering in `updateDistributionPanel()` to use `waterFillAllocate`.
- **12c**: Updated `resetDistributionToEqual()` to use `waterFillAllocate`.
- **12d**: Updated `ExamLogic.selectWithDistribution()` to sub-allocate document shares across chapters using `waterFillAllocate` (weighted by chapter pool size).

## Task 13 — Move remark entry from exam screen to results screen
- **13a**: Removed `#flag-remark-input` block from `index.html` exam topbar.
- **13b**: Simplified `btn-flag` handler to just toggle flag state; removed `btn-save-remark` handler.
- **13c**: Added `StorageLayer.updateFlaggedRemarks()` method for persisting remarks added after grading.
- **13d**: Updated `renderResults()` flagged section to show textareas for each flagged question with a "Save Remarks" button.

## Task 14 — Fix flagged questions with no remark not appearing in admin panel
- **14a**: Changed `flagged_count` in `saveExam()` to count from `question_results[i].flagged` instead of `flagged_remarks` keys.
- **14b**: Updated `AdminLayer.renderFlaggedTab()` to iterate over flagged questions via `q.flagged` flag, displaying "No remark provided" for questions without remarks.

## Task 15 — Admin button: restrict to Examiner/Results screens, reposition, enlarge
- **15a**: Updated `showScreen()` to show the admin button only on `screen-examiner` and `screen-results` screens.
- **15b**: Enlarged admin button CSS (top: 16px, opacity: 0.85, padding: 10px 18px, font-size: 14px, border-radius: 6px).

## Task 16 — UTC clock, same position on every screen
- **16a**: Added `<div id="utc-clock" class="utc-clock">` after the admin button in `index.html`.
- **16b**: Added `updateUtcClock()` function before Layer 2 in `app.js`.
- **16c**: Called `updateUtcClock()` and `setInterval(updateUtcClock, 1000)` in `bootstrap()`.
- **16d**: Added `.utc-clock` CSS styles (fixed position centered at top, monospace, semi-transparent background).

## QA Pass — v2 Fresh Review (2026-07-21)
- **QA-1**: Confirmed Mode 2 review_status gate logic is correct (blocks `reviewed`, requires `approved`). Operational review pass needed — not a code bug.
- **QA-2**: Confirmed `correct_answer` is letter-based end-to-end across all code paths. No inconsistency found. Added deviation note to `interfaces/question-service.js`.
- **QA-3**: Confirmed export route uses path param (`/export/:document`). No query-param callers exist. Left as-is, noted as deviation.
- **QA-4 (FIXED)**: `GET /api/sessions/:sessionId/result` leaked `decision`/`remarks` before finalization. Added `showResolutionDetails` guard — examinees now only see these fields after `is_final = 1`; examiners always see them.
- **QA-5**: Confirmed retake endpoint (`POST /api/sessions/:sessionId/retake`) rejects server-side if `retake_offered` not set by examiner.
- **QA-6**: Confirmed Task 02 complexity override reason validation and role gating are both server-side, not UI-only.
- **QA-7 (FIXED)**: `PUT /api/users/:serviceNo/active` audit severity upgraded from `'info'` to `'warning'` to match role-change logging pattern.
- **QA-8**: Confirmed `exam_question_timings` table exists but is never written to — schema-only, zero cost. Marked as minor gap.
- **QA-9**: Confirmed Task 03 flag endpoint rejects Mode 1 sessions and non-in-progress sessions server-side.
- **QA-10**: Confirmed `buildSession()` returns clear "not enough eligible questions" message — does not silently under-fill.
- **QA-11**: Re-ran Task 05 acceptance criteria — all 5 pass.
- **QA-12**: Confirmed Task 07 eligibility resolver documents applicability fallback, transition-window rationale, and frontend wiring not yet connected.
