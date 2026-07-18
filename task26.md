## TASK 26 — Bug fix: "Question not found in pool" when editing certain questions

**Root cause:** `openQuestionEditor()` (and related edit/delete helpers) compare a question's `id`
against `questionId`/`editingId` using strict equality (`===`). `questionId`/`editingId` come from
`btn.dataset.id`, and HTML `data-*` attributes are always strings. If the original questions in
`data/questions.json` have numeric IDs, `1042 === "1042"` is `false`, so the lookup fails — while
custom-added questions (whose IDs are string UUIDs) work fine. This matches what you saw: some
questions fail to open for editing, not all of them.

Before changing anything, open `data/questions.json` and check the actual `id` type on a few
entries (number vs string), and tell me which it is. The fix below works either way (it's a
defensive `String()` coercion on both sides), but confirming the real cause first means we're not
just guessing.

**26a.** In app.js, find this exact line:

 const q = DataLayer.questions.find(item => item.id === questionId);

Replace with exactly:
  const q = DataLayer.questions.find(item => String(item.id) === String(questionId));

**26b.** In app.js, find this exact line:
  const isCustomAdded = edits.added && edits.added.some(a => a.id === editingId);

Replace with exactly:
  const isCustomAdded = edits.added && edits.added.some(a => String(a.id) === String(editingId));

**26c.** In app.js, find this exact line:
    edits.added = edits.added.map(a => a.id === editingId ? questionObj : a);

Replace with exactly:
    edits.added = edits.added.map(a => String(a.id) === String(editingId) ? questionObj : a);

**26d.** In app.js, find this exact line:
if (edits.added && edits.added.some(a => a.id === questionId)) {

Replace with exactly:
if (edits.added && edits.added.some(a => String(a.id) === String(questionId))) {

Directly below it, find:
  edits.added = edits.added.filter(a => a.id !== questionId);

Replace with exactly:
  edits.added = edits.added.filter(a => String(a.id) !== String(questionId));

**26e.** Check `DataLayer.init()`'s custom-edits merge block (the part that filters against
`custom.deleted` and maps `custom.edited`) for the same pattern — if it compares `q.id` against
values from `custom.deleted`/`custom.edited` keys without string coercion, show me that exact block
before editing it, and apply the same `String()` fix there.

**26f.** Verify the fix by: editing an original (non-custom) question that previously failed with
"Question not found in pool," confirming it now opens correctly, saving a change, and confirming
the change actually persists after closing and reopening it. Report what you actually tested, not
just that the code was changed.