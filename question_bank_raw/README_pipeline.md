# ATC Exam Question Bank Pipeline

This pipeline extracts chapters from ATC documents, generates multiple‑choice
questions using an LLM, suggests qualification groups, and merges the results
into the existing `data/questions.json` database.

## Workflow

1. **Extract chapters** – `extract_document_chapters.py`
2. **Generate questions** – feed the chapter JSON to an LLM with the
   *Question Generation Agent* prompt.
3. **Classify groups** – use the *Grouping Agent* prompt to get initial
   assignments; review and finalise them manually in a CSV.
4. **Merge** – run `merge_questions.py` to integrate new questions and
   group assignments.

## Detailed Steps

### 1. Extract Chapters

python extract_document_chapters.py ./source_docs ./chapters_json
Processes all .pdf and .docx files in source_docs.

Creates one JSON per document in chapters_json with the structure:

json
{
  "document_name": "ICAO Annex 11",
  "chapters": [ … ]
}

### 2. Generate Questions (LLM)
Use any compatible LLM (Claude, GPT, DeepSeek) with the prompt from
Component 2. The prompt expects:

A chapter JSON (copy the content of one chapter file).

The desired number of questions (N per 1000 words).

The LLM outputs a JSON array of question objects, each with a temp_id.
Save the result to a file, e.g., generated_questions.json.

### 3. Assign Qualification Groups (LLM + Human review)
Feed the generated questions to the LLM with the Grouping Agent prompt
(Component 3). The LLM will output a JSON array of group suggestions.

Convert that JSON to a CSV with columns: temp_id, groups (as a JSON
array string). Example:

csv
temp_id,groups
f47ac10b-58cc-4372-a567-0e02b2c3d479,"[""Area Procedure"",""Approach Procedure""]"
Review and correct the CSV manually. The final CSV is the source of
truth for group assignments.

### 4. Merge into Database

python merge_questions.py \
  --existing data/questions.json \
  --new generated_questions.json \
  --assignments final_groups.csv
Creates a timestamped backup of the existing questions.json.

Assigns consecutive integer IDs to new questions, sets source="generated".

Adds groups from the CSV; questions without an assignment receive "groups": [].

Updates the metadata (_total_questions, _last_updated).

Overwrites data/questions.json (use --output to write elsewhere).

### Validation
The merge script validates each new question for required fields. A more
thorough check can be done with the existing validate_database.js (if
available) or by running the built‑in validation in the ATC Exam Simulator.

### Future Extensions
Images: Currently image_description is a placeholder. To extract
images, extend extract_document_chapters.py using pdfplumber’s image
methods and python‑docx’s inline shapes.

Better heading detection: For unusually formatted documents,
customise the CHAPTER_PATTERN and ALL_CAPS_PATTERN regexes.