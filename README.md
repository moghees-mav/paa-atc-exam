# PAA ATC Exam Simulator

Browser-based exam simulator for Pakistan Airports Authority (PAA) Air Traffic Controller (ATC) qualification exams. Used in a trusted-room setting for training and assessment.

## Features

- **Qualification-based exams** — Aerodrome, Area Procedure, Area Radar, Approach Procedure, Approach Radar
- **Flexible question selection** — Choose by document/chapter with equal or percentage-based distribution
- **Difficulty distribution** — Set Easy/Medium/Hard ratios per exam
- **Timer** — Visual SVG ring countdown with pause/resume, auto-submit on expiry
- **Flag & remark** — Mark questions for review, add remarks for the examiner
- **Auto-grading** — Pass/fail with performance breakdown by document and chapter
- **Weakness alerts** — Highlights chapters/documents scoring below 60%
- **Exam replay** — Enter a 5-character Exam ID to retake or review any past exam
- **Admin dashboard** — Stats history, question bank CRUD, flagged question review, feature requests, qualifications editor, password management

## Stack

Vanilla HTML, CSS, JavaScript (ES modules) — no frameworks, no build step.

| Directory | Contents |
|-----------|----------|
| `css/` | 5 partial stylesheets (theme, layout, components, admin, print) |
| `js/` | 6 ES modules (constants, data-layer, storage-layer, exam-logic, ui, admin-ui) |
| `config/` | App configuration and qualification definitions |
| `data/` | Question bank (JSON) |
| `server.js` | Static file server (Node.js) |

## Quick Start

```bash
node server.js
# Opens http://localhost:8000 (falls back to 8001, 8002, 8080)
```

## Persistence

All exam data is stored in `localStorage` with an async wrapper ready for future server-side migration. Retention policies:

- Full question snapshots trimmed after 6 months
- Detailed records purged after 5 years

## Note

Admin authentication is a placeholder (prompt + `localStorage` password). Not hardened for internet exposure — intended for LAN / trusted-room use only.