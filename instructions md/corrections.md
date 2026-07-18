# ATC Exam Simulator — Corrections for DeepSeek

Read this whole file first. Then work through the tasks **in order, one at a time**.
After each task, show a diff of the change before writing it to disk, and wait for confirmation
before moving to the next task. Do not fix anything not explicitly described in a task, even if
you notice it — flag it to me instead and move on.

Priority key: {C} CRITICAL (breaks the app) · {B} BUG (wrong behavior, no crash) · {M} MINOR (polish/cleanup)

---

## {C} TASK 1 — Fix timer config key mismatch (app.js)

**Problem:** `UILayer.getExamConfig()` returns an object with the key `timerMinutes`, but
`ExamLogic.buildSession()` reads `config.timer_minutes` (snake_case, doesn't exist). This makes
`limit_seconds` evaluate to `NaN`, which breaks the countdown timer for every exam.

In app.js, find this exact line inside `buildSession(config)`:

```
timer: { limit_seconds: config.timer_minutes * 60, started_at: null, paused_at: null, elapsed_seconds: 0 },
```

Replace it with exactly:

```
timer: { limit_seconds: config.timerMinutes * 60, started_at: null, paused_at: null, elapsed_seconds: 0 },
```

Change only `config.timer_minutes` to `config.timerMinutes`. Do not touch any other part of `buildSession`.

---

## {C} TASK 2 — Fix pass-threshold config key mismatch (app.js)

**Problem:** `getExamConfig()` returns `passThreshold`, but `ExamLogic.grade()` reads
`s.config.pass_threshold` (doesn't exist, evaluates to `undefined`). Any comparison
`percent >= undefined` is always `false`, so `results.passed` is always `false` — nobody can ever
pass an exam, regardless of score.

In app.js, find this exact line inside `grade()`:

```
results.passed = results.score.percent >= s.config.pass_threshold;
```

Replace it with exactly:

```
results.passed = results.score.percent >= s.config.passThreshold;
```

Change only `pass_threshold` to `passThreshold`. Do not touch any other line in `grade()`.

---

## {C} TASK 3 — Fix `this` binding bug in question-count input handler (app.js)

**Problem:** Inside `bindExaminerEvents()`, this handler is an arrow function, so `this` refers to
`UILayer` (the enclosing object), not the `<input>` element that fired the event. `this.value` is
therefore always `undefined`, and `val` always falls back to the hardcoded default of 50 — typing
a custom question count never updates the live distribution target/total.

In app.js, find this exact block inside `bindExaminerEvents()`:

```
    document.getElementById('question-count').oninput = () => {
      const val = parseInt(this.value) || 50;
      document.getElementById('distribution-target').textContent = val;
      UILayer.updateDistributionTotal();
    };
```

Replace it with exactly:

```
    document.getElementById('question-count').oninput = () => {
      const val = parseInt(document.getElementById('question-count').value) || 50;
      document.getElementById('distribution-target').textContent = val;
      UILayer.updateDistributionTotal();
    };
```

Only change how `val` is computed. Do not touch the rest of `bindExaminerEvents()`.

---

## {C} TASK 4 — Add missing `#review-list` container and filter buttons (index.html)

**Problem:** `UILayer.renderResults()` in app.js calls:
```
const reviewDiv = document.getElementById('review-list');
...
reviewDiv.innerHTML = items.map(...)
```
and also queries `document.querySelectorAll('.review-filter-btn')`. Neither `#review-list` nor any
`.review-filter-btn` element exists anywhere in index.html. `document.getElementById('review-list')`
returns `null`, so `reviewDiv.innerHTML = ...` throws a TypeError. Because this happens partway
through `renderResults()`, everything **after** that point in the same function also fails to run —
including the flagged-remarks section and the click handlers for Retake/New Exam/Print. In its
current state, **the results screen is broken and the exam cannot be completed successfully.**

style.css already has working styles for `#review-filters` and `.review-filter-btn` (see the
"Question Review" section of style.css, roughly lines 253–267), they're just never used because the
HTML markup for them was never added.

In index.html, find this exact block:

```
    <section class="results-section" id="question-review">
      <h2>Question Review</h2>
    </section>
```

Replace it with exactly:

```
    <section class="results-section" id="question-review">
      <h2>Question Review</h2>
      <div id="review-filters">
        <button class="review-filter-btn active" data-filter="all" type="button">All</button>
        <button class="review-filter-btn" data-filter="incorrect" type="button">Incorrect</button>
        <button class="review-filter-btn" data-filter="flagged" type="button">Flagged</button>
        <button class="review-filter-btn" data-filter="unanswered" type="button">Unanswered</button>
      </div>
      <div id="review-list"></div>
    </section>
```

Do not modify any other section in index.html.

---

## {C} TASK 5 — Revert True/False option `data-key` collision (index.html)

**Problem:** A previous edit changed the True/False option buttons' `data-key` from `"True"`/`"False"`
to `"T"`/`"F"`. This created two problems:

1. `data-key="F"` is now used by **two different buttons** — the MCQ option F button and the
   False button. `document.querySelector('.option-btn[data-key="F"]')` will only ever match the
   first one in the DOM (the MCQ "F" button), so the actual False button can never be selected by
   that selector.
2. app.js's `renderQuestion()` function was never updated to match — it still does:
   `const optionKeys = q.q_type === 'true_false' ? ['True', 'False'] : ...`
   and looks up buttons using `data-key="True"` / `data-key="False"`. Since no button currently
   has those exact data-key values, **True/False questions render with zero visible answer options.**

The simplest, safest fix is to revert the True/False buttons back to their original `data-key`
values, which do not collide with the single-letter A–F values and already match what app.js expects.

In index.html, find this exact block:

```
          <button class="option-btn" data-key="T"><span class="option-key">True</span><span class="option-text"></span></button>
          <button class="option-btn" data-key="F"><span class="option-key">False</span><span class="option-text"></span></button>
```

Replace it with exactly:

```
          <button class="option-btn" data-key="True"><span class="option-key">True</span><span class="option-text"></span></button>
          <button class="option-btn" data-key="False"><span class="option-key">False</span><span class="option-text"></span></button>
```

Do not change the A/B/C/D/E/F buttons above this block. Do not change anything in app.js as part of
this task — Task 5 only touches index.html.

---

## {B} TASK 6 — Fix `#home-main` id mismatch between index.html and style.css (index.html)

**Problem:** style.css defines layout styling (max-width, padding, centering) only for
`#home-main-examiner` and `#home-main-examinee`. The examiner screen's `<main>` element in
index.html still uses the old unsuffixed id `home-main`, so it matches neither CSS rule. Result:
the examiner (step 1) screen renders with no max-width constraint and no padding, while the
examinee (step 2) screen is styled correctly. This is a visible layout inconsistency between the
two screens.

In index.html, find this exact line (it is the `<main>` tag that immediately follows the
`app-header-examiner` header, containing the "Examiner Details" section):

```
    <main id="home-main">
```

Replace it with exactly:

```
    <main id="home-main-examiner">
```

Do not change `id="home-main-examinee"` on the examinee screen — that one is already correct.
Do not change any other line.

---

## {B} TASK 7 — Fix `#home-actions` id mismatch on examinee screen (index.html AND style.css)

**Problem:** style.css only has a rule for `#home-actions` (unsuffixed), which correctly matches
the examiner screen's button wrapper div (`<div id="home-actions">`, containing "Create Exam →").
The examinee screen's equivalent wrapper is `id="home-actions-examinee"`, which has no matching
CSS rule at all, so the Back/Start Exam buttons on step 2 don't get the same centered spacing as
step 1.

Step 7a — In style.css, find this exact rule:

```
/* Start Button */
#home-actions { text-align: center; margin: 20px 0; }
```

Replace it with exactly:

```
/* Start Button */
#home-actions,
#home-actions-examinee { text-align: center; margin: 20px 0; }
```

Do not change the `.btn-primary` or `#start-validation-msg` rules directly below it.

Step 7b — Do not rename anything in index.html for this task; `id="home-actions-examinee"` there
is already correct and just needs the matching CSS rule from step 7a.

---

## {B} TASK 8 — Stop event listeners from stacking on repeat navigation (app.js)

**Problem:** Two places in app.js use `addEventListener` (not an `.onclick =` / `.oninput =`
assignment) on DOM elements that are **not recreated** between screen visits. Every time the user
navigates back to a screen and forward again, another duplicate listener is attached on top of the
old ones, so the same handler logic runs multiple times per single user action. This gets worse
the more times someone goes back and forth (e.g., Back → Create Exam → Back → Create Exam...).

Affected spots:
1. `bindDifficultyEvents()` — attaches an `input` listener to each `.diff-input` element. This
   function runs every time `initExaminer()` runs, but the difficulty inputs themselves are static
   HTML that's never recreated.
2. `initExaminee()` — attaches `input` and `keydown` listeners directly to the `#examinee-serviceno`
   input every time this function runs (i.e., every time the user reaches step 2).

Fix by removing any previously-attached listener before adding a new one, using a named function
reference instead of an inline one so it can be removed.

**8a.** In app.js, find this exact block:

```
    bindDifficultyEvents() {
    const inputs = document.querySelectorAll('.diff-input');
    inputs.forEach(inp => {
      inp.addEventListener('input', () => this.updateDifficultyTotal());
    });
  },
```

Replace it with exactly:

```
    bindDifficultyEvents() {
    const inputs = document.querySelectorAll('.diff-input');
    inputs.forEach(inp => {
      inp.oninput = () => this.updateDifficultyTotal();
    });
  },
```

(Switching from `addEventListener` to an `oninput =` assignment means each call replaces the
previous handler instead of stacking a new one alongside it.)

**8b.** In app.js, find this exact block inside `initExaminee()`:

```
    const servNo = document.getElementById('examinee-serviceno');
    servNo.addEventListener('input', function() {
      this.value = this.value.replace(/[^0-9]/g, '').slice(0, 4);
    });
    servNo.addEventListener('keydown', function(e) {
      const allowed = [8, 9, 46, 37, 39, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 110, 190];
      if (!allowed.includes(e.keyCode) && !e.ctrlKey && !e.metaKey && e.key !== 'Tab') {
        e.preventDefault();
      }
    });
```

Replace it with exactly:

```
    const servNo = document.getElementById('examinee-serviceno');
    servNo.oninput = function() {
      this.value = this.value.replace(/[^0-9]/g, '').slice(0, 4);
    };
    servNo.onkeydown = function(e) {
      const allowed = [8, 9, 46, 37, 39, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 110, 190];
      if (!allowed.includes(e.keyCode) && !e.ctrlKey && !e.metaKey && e.key !== 'Tab') {
        e.preventDefault();
      }
    };
```

Only change `addEventListener('input', ...)` → `oninput = ...` and `addEventListener('keydown', ...)`
→ `onkeydown = ...`. Keep the function bodies identical. Do not touch anything else in `initExaminee()`.

---

## {M} TASK 9 — Remove redundant duplicate DOM write (app.js)

**Problem:** In `renderResults()`, `#stat-correct`'s `textContent` is set twice in a row — the
first assignment is immediately overwritten by the second. Not a functional bug, just dead code
that could confuse future edits.

In app.js, find this exact block:

```
    document.getElementById('stat-correct').textContent = `✓ Correct: ${results.score.correct}`;
    document.getElementById('stat-incorrect').textContent = `✗ Incorrect: ${results.score.incorrect}`;
    document.getElementById('stat-unanswered').textContent = `— Unanswered: ${results.score.unanswered}`;
    const marksText = results.score.marks_total ? `${results.score.marks_obtained} / ${results.score.marks_total} marks` : '';
    document.getElementById('stat-correct').textContent = `✓ Correct: ${results.score.correct} ${marksText}`;
```

Replace it with exactly:

```
    document.getElementById('stat-incorrect').textContent = `✗ Incorrect: ${results.score.incorrect}`;
    document.getElementById('stat-unanswered').textContent = `— Unanswered: ${results.score.unanswered}`;
    const marksText = results.score.marks_total ? `${results.score.marks_obtained} / ${results.score.marks_total} marks` : '';
    document.getElementById('stat-correct').textContent = `✓ Correct: ${results.score.correct} ${marksText}`;
```

This just removes the first, immediately-overwritten line. Do not change anything else in
`renderResults()`.

---

## {M} TASK 10 — Consolidate duplicate CSS rules for `.dist-row` / `.dist-input` (style.css)

**Problem:** style.css defines `.dist-row`, `.dist-row label`, `.dist-input`, `.dist-pool-size`,
and `#distribution-footer` **twice** — once near the top (around "Distribution Panel", roughly
lines 96–100) and again near the bottom (around "Hierarchical Document/Chapter Selector", roughly
lines 316–342), with slightly different values (e.g. `.dist-row label` min-width 200px vs 180px,
`.dist-input` width 70px vs 80px). Because both blocks have equal CSS specificity, the second
(lower) block silently wins for every property it redefines, making the first block partly dead
code. This isn't currently breaking anything, but it's confusing and risks someone editing the
"wrong" copy later and seeing no effect.

Report both blocks to me with their exact line numbers and current values. Do not delete or merge
them yet — wait for me to confirm which values to keep before making any edit.

---

## {M} TASK 11 — Add missing `for` attributes on remaining unlabeled fields (index.html)

**Problem:** Two labels still aren't associated with their inputs via `for`/`id`: "Service Number"
in the examinee screen, and "Distribution Mode" in the examiner screen. Clicking these labels won't
focus their associated field, and screen readers won't announce the association.

**11a.** In index.html, find:

```
        <div class="setting-row">
          <label>Service Number</label>
          <div style="display:flex;align-items:center;gap:2px">
```

Replace with:

```
        <div class="setting-row">
          <label for="examinee-serviceno">Service Number</label>
          <div style="display:flex;align-items:center;gap:2px">
```

**11b.** In index.html, find:

```
        <div class="setting-row">
          <label>Distribution Mode</label>
          <select id="dist-mode">
```

Replace with:

```
        <div class="setting-row">
          <label for="dist-mode">Distribution Mode</label>
          <select id="dist-mode">
```

Make only these two changes. Do not touch the "Qualification" label/select pair or any other row.

---

## {M} TASK 12 — Report unused/dead CSS selectors (no edit yet)

**Problem (informational only):** style.css defines styles for several selectors that don't appear
anywhere in the current index.html: `#mode-buttons`, `.mode-btn`, `.mode-btn.active`, `.filter-checklist`,
`.filter-item`, `.filter-count`, `#db-info-bar`. These look like leftovers from an earlier version
of the UI (possibly a mode-selection step that was replaced by the current qualification dropdown).

Search style.css for each of these selectors and list the line numbers where they appear. Do not
delete anything — just report the list back to me so I can decide whether they're needed for a
future feature or safe to remove.

---

## {M} TASK 13 — Fix missing visual updates for the timer ring (app.js)

**Problem:** The `UILayer.updateTimer()` function correctly updates the text for the countdown (`#timer-display`), but it lacks the logic to update the SVG stroke offset for `#timer-arc`. As a result, the visual progress ring remains static rather than draining as the time elapses.

In app.js, find the end of `updateTimer(remaining, total)`:

"    } else {
      document.getElementById('timer-display').textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    }
  }"

Replace it with exactly:

"} else {
      document.getElementById('timer-display').textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    }
    const arc = document.getElementById('timer-arc');
    if (arc) {
      const radius = 26;
      const circumference = 2 * Math.PI * radius;
      const offset = circumference - (remaining / total) * circumference;
      arc.style.strokeDasharray = `${circumference} ${circumference}`;
      arc.style.strokeDashoffset = offset;
    }
  }"

Change applies only to the bottom of the updateTimer function.

---

## {M} TASK 14 — Fix question distribution overflow (app.js)
Problem: Inside getExamConfig(), when calculating percentage distributions based on user input, standard rounding can result in an assigned total that is greater than the requested questionCount. (For example: three documents set to 34% of 50 questions = 17 * 3 = 51). The current logic only corrects remainders if assigned < questionCount, ignoring overflow. This causes the simulator to occasionally build an exam with more questions than targeted.

In app.js, find this exact block inside getExamConfig():

"if (assigned < questionCount && Object.keys(distribution).length > 0) {
        const firstKey = Object.keys(distribution)[0];
        distribution[firstKey] += (questionCount - assigned);
      }"

Replace it with exactly:

"if (assigned !== questionCount && Object.keys(distribution).length > 0) {
        const firstKey = Object.keys(distribution)[0];
        distribution[firstKey] += (questionCount - assigned);
      }"

(By changing < to !==, overflow is caught. If assigned is 51 and questionCount is 50, (50 - 51) evaluates to -1, successfully trimming the excess question off the first category).

---


## Notes (no action needed, informational)

- `ExamLogic.buildSession()` calls `crypto.randomUUID()`. This API only works in a "secure context"
  — `https://` or `localhost`. If this app is ever opened directly from a `file://` path or served
  over plain `http://` on a non-localhost domain, session creation will throw an error. Worth
  keeping in mind when deploying, but no code change is being requested for this right now.
- app.js appears to use Windows-style CRLF line endings throughout. Not a functional problem, but
  if your VS Code default is set to LF, saving a file may trigger a large line-ending-only diff.
  Check your `.editorconfig` / VS Code line-ending setting before making edits so diffs stay clean.

---

## General guardrails (paste at top of DeepSeek session)

```
Rules for this session:
1. Only edit the file(s) named in each task. Never touch other files unless told to.
2. Make one change per task. Do not "also fix" anything else you notice — flag it to me instead and wait.
3. Always show a diff/preview before writing to disk.
4. If a search string doesn't match exactly (including whitespace), stop and tell me instead of guessing or applying a similar-looking change.
5. Never regenerate or rewrite a whole file from scratch — only apply the specific edit requested.
6. Complete tasks strictly in numeric order. Do not start Task N+1 until Task N is confirmed.
```
