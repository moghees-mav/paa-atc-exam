# UI Overhaul & Admin Polish: Pakistan Airports Authority Theme

Please review `index.html`, `app.js`, and `style.css`. We are executing a comprehensive UI overhaul to match a professional, aviation-grade design language (deep blues, clean whites, and crisp sans-serif typography), preparing the app for a management presentation.

Please execute these tasks **strictly in numeric order, one at a time**. Apply the targeted changes, show a diff, and wait for my explicit confirmation before proceeding to the next task. Do not rewrite entire files—use targeted edits to conserve context tokens.

---

## TASK 22 — Global PAA Branding, Header & UTC Clock (style.css & index.html)
**Goal:** Establish the professional design baseline and fix immediate overlapping issues.

1. **Header Updates:** Make the main organization header (`header`) wider, slightly taller, and ensure it is universally visible, including at the top of the Admin Panel (which currently lacks it).
2. **UTC Clock:** Update `.utc-clock` in `style.css`. Increase the font size, change the text color to a bright terminal green (`#00ff00` or similar), and change the background to dark grey/black.
3. **Admin Button Overlap:** Move `.admin-access-btn` so it no longer overlaps the "Export / Print" button on the Results screen. Consider anchoring it to the bottom-left or adjusting the top offset.

---

## TASK 23 — Examinee Setup & Exam Screen UX (index.html & app.js)
**Goal:** Improve navigation flow and readability during the exam.

1. **Button Formatting:** On `#screen-examinee`, target the "Back" and "Start Exam" buttons. Give them equal sizing, matching styles (e.g., flex-1 or fixed width), and space them evenly apart.
2. **Hide Metadata:** On `#screen-exam`, completely hide or remove the `tag-document`, `tag-chapter`, and `tag-difficulty` elements. The examinee should not see these during the test.
3. **Dynamic Font Sizing:** On `#exam-topbar`, add two small buttons: `[A-]` and `[A+]`. In `app.js`, wire these to increase or decrease the `font-size` of `#question-text` in increments of 2px, bounding it between 14px and 32px.

---

## TASK 24 — Custom Dialog Modals (app.js & style.css)
**Goal:** Replace native browser popups (`alert()`, `confirm()`) with styled HTML/CSS modal dialogs featuring drop-shadows and professional typography.

1. **Start Exam Dialog:** Intercept the "Start Exam" click. Render a custom modal displaying all relevant details (Examinee info, Question count, Time) and helpful instructions. Include "Cancel" and "Commence Exam" buttons.
2. **Complete Exam Dialog:** Intercept the final "Complete Exam" click. The custom modal must display:
   * "Review your exam if needed, or proceed to results."
   * A top-right `[X]` to close the modal and return to the current question.
   * A "Go to First Question" button (navigates back to index 0).
   * A "Submit & View Results" button (fires the grading logic).

---

## TASK 25 — Results Screen Condensation (Print Optimization)
**Goal:** Condense the whitespace so the Session Details, Score Card, and Weakness/Performance metrics fit cleanly onto a single A4 printed page.

1. **Top Row Merge:** Combine the "Session Details" and "Exam Result / Score Card" into a single, horizontally aligned flex container at the top of the screen without shrinking the text.
2. **Performance Tab/Tree Merge:** Combine "Weakness Alerts", "Performance by Document", and "Performance by Chapter" into a single, compact section. 
   * Implement a collapsible/expandable UI (e.g., `<details>` tags or an accordion) where the user sees the Document performance first, and can click to drop down the tree to see the specific Chapter analysis beneath it.

---

## TASK 26 — Admin Bug Fix: Question Bank Edit [to be done later, will discuss later, skip to task 27]
**------** ---------------------------[redacted]-------

1. ---------------------[redacted]------------
2. -------------------[redacted]-----------
---

## TASK 27 — Feature Requests Workflow Upgrade
**Goal:** Turn feature requests into an actionable, auditable system.

1. **Submission:** Modify the Feature Request submission to capture the Examinee Name and Examiner Name if an active session or config exists.
2. **Admin Management:** In the Admin "Feature Requests" tab, add UI controls to:
   * Add an "Admin Remark" to a request.
   * A button to "Mark as Addressed".
3. **Archival:** Create an "Archived Requests" subsection below the active ones. Addressed requests should move here, displaying the original submission timestamp, the admin's remarks, and the resolution timestamp.

---

## TASK 28 — Admin Password Security Engine
**Goal:** Implement local password management and lifecycle rules.

1. **Security Tab:** Add a new "Security" tab to the Admin Dashboard sidebar.
2. **Rules:** Allow the admin to change the default password. Enforce a minimum length of 5, maximum length of 10, alphanumeric characters only. Save this to `localStorage`.
3. **Expiry System:** Store a `password_last_changed` timestamp. Enforce a 30-day expiry. If the password is within 5 days of expiry, display a persistent warning banner inside the Admin Panel. If it expires, force a password change upon next login.
4. **V2 Roadmap Prep:** Add a commented-out section in the UI markup (or a disabled input block) for "Examiner Email" and "Examinee Email" to lay the groundwork for server-side email integrations in V2.