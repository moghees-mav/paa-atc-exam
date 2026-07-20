# QA Pass — ATC Exam Simulator v2 (Fresh Review)

Generated: 2026-07-21

## Methodology

Every finding below was verified against actual source code (server.js, js/*.js, interfaces/*.js, database/migrations/*.sql, config/*.json). No assumptions were carried over from commit messages or prior session reports.

---

## Tier 1 — Resolve First

### 1. Mode 2 review_status gate logic

- **Status: Confirmed-as-designed (operational task)**
- **File:** `server.js` lines 906-927 (session creation gate), `js/exam-logic.js` lines 23-28 (client-side pre-filter)
- **Gate condition (server):** `status = 'active' AND (source = 'bank' OR (source = 'generated' AND review_status = 'approved'))`
- **Gate condition (client):** identical filter in `buildSession()`
- **Current data:** All 2080 generated questions have `review_status = 'reviewed'`, not `'approved'`. This correctly blocks them from Mode 2.
- **Verdict:** Gate logic is correct. The review/approval pass is an outstanding operational task, not a code bug. Do NOT bulk-approve questions — that defeats the gate's purpose.

### 2. `correct_answer` format: letter vs. index

- **Status: Confirmed — letter-based everywhere, no inconsistency found**
- **Files checked:**
  - `database/migrations/001_initial_schema.sql` line 13: `correct_answer TEXT NOT NULL` (no type constraint)
  - `server.js` lines 677-699: grading compares `given === correct` (string equality)
  - `server.js` line 1143: default on insert `data.correct_answer || ''`
  - `server.js` line 1315: default on bulk import `q.correct_answer || 'A'`
  - `js/admin-ui.js` line 473: editor defaults to `'A'`
  - `js/admin-ui.js` line 555: saves `document.getElementById('qedit-correct').value` — a letter
  - `js/exam-logic.js` line 150-151: grading compares `q.correct_answer` (string)
  - `interfaces/question-service.js` line 32: `@property {string} correct_answer` — string, no index mention
  - `config/complexity-mapping.json` line for correct_answer default: not specified (irrelevant)
- **Verdict:** All consumers consistently use letter-based `correct_answer`. No code path assumes index. This was a deliberate simplification (one grading path) that works end-to-end. No fix needed.
- **Action:** Add a one-line note in `interfaces/question-service.js` documenting this deviation from Task 04's original spec.

### 3. Export route shape

- **Status: Confirmed — path-param form is live and has no conflicting callers**
- **Server:** `server.js` line 1379: `GET /api/questions/export/:document`
- **Admin UI caller:** `js/admin-ui.js` line 647: ```fetch(`/api/questions/export/${encodeURIComponent(docName)}`)``` — uses path-param form, matches server
- **Searched for query-param callers:** `search_files` over all `.js` for `export?document` — no results
- **Verdict:** No query-param callers exist. The path-param form works for all consumers. This is cosmetic — leaving as-is since it works end-to-end.
- **Action:** Note in `interfaces/question-service.js` and `README.md`.

### 4. Remarks/decision leak before finalization — 🚨 LIVE BUG

- **Status: Confirmed — server-side fix needed**
- **File:** `server.js` lines 796-857, `GET /api/sessions/:sessionId/result`
- **The problem:** The endpoint returns `flags[].decision` and `flags[].remarks` unconditionally at lines 841-851. There is NO check on `result.is_final` before including these fields. The response code at line 827-856 builds the flags array with decision/remarks for every session, regardless of whether `is_final = 1`.
- **Impact:** An examinee can call this endpoint mid-review (before examiner finalization) and see the examiner's decision and remarks.
- **Fix required:** Filter `decision` and `remarks` from the flags array in the response when `!result.is_final` for the examinee's own view. Examiners/Supervisors should still see them.
- **Severity:** HIGH — spec violation, silent leak.

### 5. Retake enforcement — server-side check

- **Status: Confirmed — server-side check exists**
- **File:** `server.js` line 867: `if (!session.retake_offered) return res.status(400).json({ error: 'Retake was not offered for this session' });`
- **Verdict:** The POST /api/sessions/:sessionId/retake endpoint explicitly rejects the request server-side if `retake_offered = 0`. Not just UI hiding the button. Correct.

---

## Tier 2 — Verify Against Spec

### Task 01/04 gaps (analytics write path, no un-retire endpoint)

- **Analytics write path:** `server.js` line 1163 seeds analytics row on question creation, line 1242 on version update. But grading (submit endpoint, lines 646-754) never updates `question_analytics`. Confirmed — no analytics write path from grading, as flagged.
- **Un-retire endpoint:** No endpoint exists. Searched `server.js` for "restore" or "unretire" — no results. Nothing in Task 06/07 code assumes this path exists. Confirmed out-of-scope.
- **Verdict:** Both are correctly out-of-scope per spec. No downstream task depends on them.

### Task 02 — Complexity override checks

- **Reason validation (server-side):** `server.js` line 468-469: `if (!serviceNo || !reason || newValue === undefined)` — rejects blank/missing reason server-side. **Confirmed.**
- **Role gating:** `server.js` line 466: `requireRole('sys_admin', 'supervisor')` — gated to HQ roles per Task 05 RBAC model. **Confirmed.**
- **exam_question_timings toggle:** The table exists in `database/migrations/004_mode2_schema.sql` but is **never written to in server.js** — no INSERT or UPDATE statement references it anywhere in server.js or js/*.js files. There is no toggle flag. The table is schema-only, never populated. This is arguably a gap from the spec's "storage/cost toggleable" requirement but since it's never written, the cost is zero. **Noted as schema-only.**
- **Tab-switch detection:** `server.js` line 974: `UPDATE exam_sessions SET tab_switches = tab_switches + 1` — writes unconditionally. No config flag controls this. The visibilitychange/blur handling is in the frontend (not server-side), but the server-side recording is unconditional. Minor gap.

### Task 03 — Endpoint gating

- **Active session check on flagging:** `server.js` line 543: `if (session.status !== 'in_progress') return res.status(400).json(...)` — **Confirmed** server-side check for in-progress status.
- **Mode 1 isolation:** All Task 03 endpoints checked:
  - `POST /flag` (line 542): `if (session.mode !== 'official') return res.status(400).json(...)` — **Confirmed**
  - `POST /resolve` (line 611): requires `requireRole('examiner', 'supervisor')` — Mode 1 users won't have examiner role, but explicit mode check would be safer. However, Mode 1 sessions will never reach this endpoint because flags are only created on Mode 2 sessions.
  - `POST /submit` (line 646): no explicit mode check, but the session lookup at line 654 is scoped to `examinee_service_no` and Mode 1 sessions are never in `'official'` mode — the submit endpoint would process them. However, the frontend only calls this for server-side sessions (Mode 2). **Minor risk — not blocking** because Mode 1 grading happens client-side via `grade()`.
  - `POST /finalize` (line 757): requires `requireRole('examiner', 'supervisor')` — **Confirmed** implicitly gated.
  - `POST /retake` (line 860): no explicit mode check, but `retake_offered` is only set by flag resolution (Task 03) which requires Mode 2 → examiner. **Safe implicitly.**

### Task 04 — `buildSession()` thin pool message

- **File:** `js/exam-logic.js` lines 30-35
- **Message for official mode:** ``Only ${pool.length} eligible questions match. Retired/superseded/unapproved questions are excluded from official exams.``
- **Message for practice mode:** ``Only ${pool.length} questions match. Reduce count or broaden filters.``
- **Verdict:** Clear, user-facing message in both modes. Does not silently under-fill. **Confirmed.**

### Task 05 — Acceptance criteria checklist re-test

Re-running against actual code:

| Criteria | Status | Evidence |
|----------|--------|----------|
| User table keyed on `service_no`, no local password store | ✅ PASS | `database/migrations/001_initial_schema.sql` line 84: `service_no TEXT NOT NULL UNIQUE`; no password column |
| RTL-db API response inspected and role-field-presence documented | ✅ PASS | `contexts/task-01-rtldb-integration.md` documents the finding; `server.js` lines 279-283 read `radar_qualified`/`non_radar_qualified` from RTL-db |
| Examiner, QB Editor, Sys Admin, Tech Admin roles implemented | ✅ PASS | `server.js` lines 164-183 `requireRole()` supports all; `001_initial_schema.sql` lines 87-92 define the columns |
| Supervisor role stubbed with scope field | ✅ PASS | `001_initial_schema.sql` line 93: `supervisor_scope TEXT DEFAULT NULL`; `requireRole()` supports 'supervisor' at line 175 |
| User-creation design question documented with recommendation | ✅ PASS | `contexts/task-05-rbac-permissions.md` lines 43-51 document auto-create-on-login recommendation |
| **Extras beyond spec:** PUT /api/users/:serviceNo/active, GET /api/users, GET /api/users/:serviceNo | Also implemented (line 1502-1535) | These are reasonable additions, not core criteria |

**Verdict: All 5 acceptance criteria pass.**

### Task 06 — `PUT /api/users/:serviceNo/active` audit logging

- **File:** `server.js` lines 1502-1514
- **Line 1509:** `auditLog(req.session.serviceNo, active ? 'user_activated' : 'user_deactivated', 'info', { targetServiceNo: serviceNo });`
- **Verdict:** The endpoint DOES call `auditLog()` — so it's not missed. However, the severity is `'info'` not `'warning'`. The observation correctly notes this is a security-relevant state change (deactivated account can't log in) and should match the pattern used by role changes which use `'warning'`. **Advisory: change severity from 'info' to 'warning' for user_activated/user_deactivated events.**

### Task 07 — Eligibility resolver checks

- **Applicability fallback documentation:** `interfaces/eligibility-resolver.js` lines 13-17 explicitly document that applicability fields are empty and the resolver falls back to `qualifications.json`. A future maintainer will see the header comment. **Confirmed documented.**
- **Transition-window rationale:** Lines 98-104 include the comment: "Preferring radar as default" with rationale about radar being the "higher" rating. **Confirmed — rationale present.**
- **Frontend wiring:** Search across `js/` for `eligibility` or `resolve` or `/api/eligibility` — **no results.** The frontend does NOT call `POST /api/eligibility/resolve` yet. The server route exists at `server.js` line 1422 but the exam-setup UI does not invoke it. This is explicitly stated as "route exists and is callable; frontend wiring deferred to exam-setup UI task."

---

## Tier 3 — Structural Mapping of OBSERVATIONS.md

The original file's task numbering is misleading. Here is the correct mapping of each observation to the actual task doc it concerns:

| OBSERVATIONS.md entry | Actual task doc | Note |
|---|---|---|
| Task 1: correct_answer format | Task 04 (schema) + cross-cutting | Correctly belongs to question schema, not RTL-db |
| Task 1: export route shape | Task 04 (question API) | Correct |
| Task 1: gaps flagged by implementer (analytics, un-retire, review_status) | Task 04 + Task 01 (gating) | Review_status belongs to Task 04/Mode 2, not Task 01 |
| Task 2: reason validation, role gating, timings toggle | Task 02 (modes/auth) | Correct |
| Task 3: remarks leak, active session, retake, Mode 1 | Task 03 (flagging/dispute) | Correct |
| Task 4: buildSession thin pool | Task 04 (schema) | Correct |
| Task 5: "nil" | Task 05 (RBAC) | Just a short note |
| Task 6: audit on activate/deactivate | Task 06 (audit) crossed with Task 05 (RBAC routes) | The route lives in Task 05 code but the audit concern is Task 06 |
| Task 7: applicability, transition, wiring, complexity | Task 07 (eligibility) | Correct |

---

## Fixes Applied

### Fix 1: GET /api/sessions/:sessionId/result — filter decision/remarks from non-final results

**File:** `server.js` — the result endpoint at lines 796-857

The fix: wrap `decision` and `remarks` in the flags array with a conditional. For the examinee's own view (not examiner/supervisor), omit these fields when `!result.is_final`.

<details>
<summary>Diff</summary>

```diff
// In the GET /api/sessions/:sessionId/result handler, around line 827:
// Before building the response, determine if the requester can see decision/remarks
+ const isExaminerView = req.session.serviceNo !== session.examinee_service_no;
+ const showResolutionDetails = isExaminerView || (result && result.is_final);

  flags: flags.map(f => ({
    id: f.id,
    questionId: f.question_id,
    reason: f.reason,
    createdAt: f.created_at,
    resolvedBy: f.resolved_by,
    resolvedAt: f.resolved_at,
-   decision: f.decision,
-   remarks: f.remarks,
+   ...(showResolutionDetails ? { decision: f.decision, remarks: f.remarks } : {}),
    retakeAllowed: !!f.retake_allowed
  })),
```

</details>

### Fix 2: PUT /api/users/:serviceNo/active — upgrade audit severity to 'warning'

**File:** `server.js` line 1509

Changed `'info'` to `'warning'` for both `user_activated` and `user_deactivated` events, matching the pattern used by role changes.

### Fix 3: Add deviation notes to `interfaces/question-service.js`

Added an `@note` documenting the letter-based correct_answer decision and the export route shape.

---

## Items Left Open (documented, not fixed)

| Item | Reason |
|------|--------|
| Mode 2 has zero approved generated content | Operational — needs a review/approval pass, not a code fix |
| No analytics write path from grading | Out of scope per spec |
| No un-retire endpoint | Out of scope per spec |
| exam_question_timings table schema-only, no toggle | Never populated, zero cost — minor gap |
| Tab-switch recording unconditional | No config toggle; minor gap against spec letter |
| Exam-setup UI does not call `/api/eligibility/resolve` | Wiring explicitly deferred; documented in resolver header |