# ATC Exam Simulator — Memory Bank

## Architecture Summary

### File Layout
```
js/constants.js     — All constants, waterFillAllocate(), updateUtcClock(), shuffle()
js/data-layer.js    — DataLayer: fetch/query questions, meta, difficulty distribution
js/storage-layer.js — StorageLayer: localStorage CRUD, exam save/retention, feature requests
js/exam-logic.js    — ExamLogic: session build, grade, timer, answer/flag recording
js/ui.js            — UILayer + DialogLogic + FeatureRequestLogic: screen nav, rendering, events
js/admin-ui.js      — AdminLayer: dashboard, question CRUD, qualifications editor, security
app.js              — Entry: imports all modules, bootstrap() init
css/theme.css       — :root variables, reset, base typography
css/layout.css      — Screen containers, headers, sidebars, fixed elements
css/components.css  — Buttons, forms, cards, tables, modals, palette, timer, review items
css/admin.css       — Question bank manager, qualifications editor, editor modal
css/print.css       — @media print rules
index.html          — All screens in one file, loads CSS + module script
server.js           — Static file server (no changes needed)
```

### Data Flow
```
fetch(config + qualifications + questions) → DataLayer.init()
                                                ↓
StorageLayer (localStorage wrapper) ←→ DataLayer (merge custom edits)
                                                ↓
                                         ExamLogic (session)
                                                ↓
                                        UILayer (render)
                                                ↓
                                   AdminLayer (dashboard/settings)
```

### Key Objects & Function Names
- `DataLayer.init()` — fetches & merges all data
- `StorageLayer.saveExam()` — persists exam results + retention sweep
- `ExamLogic.startTimer()` / `tickTimer()` / `grade()` — main exam loop
- `UILayer.showScreen(id)` — screen navigation
- `UILayer.initExaminer()` / `initExaminee()` / `initExam()` / `renderResults()` — screen lifecycle
- `AdminLayer.switchTab(tab)` — admin panel routing
- `waterFillAllocate(target, items, weighted)` — distribution allocator (shared)

### Screen Lifecycle
```
loading → examiner (config) → examinee (details) → exam → results → (admin loop)
```
- `screen-loading` → `screen-examiner` → `screen-examinee` → `screen-exam` → `screen-results`
- Admin is always accessible from examiner/results screens

### Naming Conventions
- Screens: `screen-{name}` (e.g. `screen-exam`)
- Headers: `app-header-{role}` (examiner/examinee/admin)
- Buttons: `btn-{action}` (e.g. `btn-start-exam`)
- Storage keys: prefixed `atc_` (e.g. `atc_exam_index`)
- All IDs use kebab-case, all JS variables use camelCase

### Key Constants
- `EXAM_ID_LENGTH = 5` — short exam IDs, alphabet excludes 0/1/O/I/L
- `RETENTION_ARCHIVE_AFTER_MONTHS = 6` — trim question snapshots after 6 months
- `RETENTION_PURGE_AFTER_YEARS = 5` — delete detail records after 5 years
- `SESSION_KEY = 'atc_exam_session'` — active exam in sessionStorage