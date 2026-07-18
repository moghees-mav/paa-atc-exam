#!/usr/bin/env python3
"""
merge_questions.py -- Merge generated questions into data/questions.json

Reads LIST-type JSON question files from question_bank_raw/output/,
transforms them (question_text -> question, temp_id -> id, etc.),
allocates stable numeric IDs, and merges into data/questions.json
with timestamped backups.

Usage:
    python scripts/merge_questions.py [--dry-run]

Options:
    --dry-run   Preview changes without writing anything.
    --backup    Force a backup even in dry-run (to test backup logic).
"""

import json
import os
import sys
from datetime import datetime
from collections import defaultdict

# --------------- Paths ---------------
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_PATH = os.path.join(PROJECT_ROOT, "data", "questions.json")
OUTPUT_DIR = os.path.join(PROJECT_ROOT, "question_bank_raw", "output")
BACKUP_DIR = os.path.join(PROJECT_ROOT, "data", "backups")

# --------------- ID Allocation Strategy ---------------
# Reserved IDs:
#   1-10:  Existing manual placeholder questions (keep unchanged)
#   11+:   Generated questions from all sources
#
# Each (document, chapter) combination gets a stable ID range,
# allocated in order of document importance.
#
# ID blocks (starting from 11):
#   ICAO DOC 4444:    11-400
#   ICAO ANNEX 14:    401-800
#   ICAO ANNEX 10:    801-1100
#   ICAO ANNEX 12:    1101-1300
#   ICAO ANNEX 15:    1301-1500
#   ICAO DOC 9859:    1501-1800
#   MNL-003-OPAT-10:  1801-3500
#   Future / new docs: 3501+

ID_START = 11
ID_BLOCKS = {
    # (document_name_prefix_or_exact, start_id, end_id)
    # Order matters -- first match wins.
}

# We'll use a dynamic approach: allocate IDs sequentially from ID_START,
# but reserve blocks for each (document, chapter) so IDs remain stable
# across re-runs.

ID_MAP_PATH = os.path.join(PROJECT_ROOT, "data", ".id_map.json")


def load_id_map():
    """Load or create the persistent ID map that ensures stable IDs across merges."""
    if os.path.exists(ID_MAP_PATH):
        with open(ID_MAP_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_id_map(id_map):
    """Save the ID map for future merges."""
    os.makedirs(os.path.dirname(ID_MAP_PATH), exist_ok=True)
    with open(ID_MAP_PATH, "w", encoding="utf-8") as f:
        json.dump(id_map, f, indent=2)


def load_generated_files():
    """Load all LIST-type JSON files from the output directory."""
    if not os.path.isdir(OUTPUT_DIR):
        print(f"[ERROR] Output directory not found: {OUTPUT_DIR}")
        return []

    files = []
    for fname in sorted(os.listdir(OUTPUT_DIR)):
        if not fname.endswith(".json"):
            continue
        fpath = os.path.join(OUTPUT_DIR, fname)
        try:
            with open(fpath, "r", encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, list) or len(data) == 0:
                print(f"  [SKIP] {fname}: not a non-empty JSON array")
                continue
            files.append((fname, data))
        except Exception as e:
            print(f"  [SKIP] {fname}: error reading -- {e}")

    return files


def load_existing_questions():
    """Load the existing questions.json database."""
    if not os.path.exists(DATA_PATH):
        print(f"[INFO] No existing database at {DATA_PATH}, starting fresh.")
        return {
            "_schema_version": "2.0",
            "_last_updated": "",
            "_total_questions": 0,
            "questions": [],
        }

    with open(DATA_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)

        # Ensure it has the right structure
    if "questions" not in data:
        data["questions"] = []
    if "_schema_version" not in data:
        data["_schema_version"] = "2.0"
    if "_total_questions" not in data:
        data["_total_questions"] = len(data["questions"])

    # Backfill q_type on existing questions (schema v1 -> v2 migration)
    for q in data["questions"]:
        if "q_type" not in q or q["q_type"] is None:
            opts = q.get("options", {})
            if set(opts.keys()) == {"True", "False"}:
                q["q_type"] = "true_false"
            else:
                q["q_type"] = "mcq"

    return data


def normalise_document_name(name):
    """Normalise document names to consistent canonical form."""
    name_upper = name.strip().upper()
    mapping = {
        "ICAO DOC 4444 16TH EDITION - 11TH AMENDMENT": "ICAO Doc 4444",
        "ICAO DOC 4444 16TH EDITION": "ICAO Doc 4444",
        "DOC 4444": "ICAO Doc 4444",
        "ICAO DOC 4444": "ICAO Doc 4444",
        "ICAO DOC 9859": "ICAO Doc 9859",
        "DOC 9859": "ICAO Doc 9859",
        "ICAO ANNEX 10": "ICAO Annex 10",
        "ANNEX 10": "ICAO Annex 10",
        "ICAO ANNEX 12": "ICAO Annex 12",
        "ANNEX 12": "ICAO Annex 12",
        "ICAO ANNEX 14 VOL 1": "ICAO Annex 14 Volume I",
        "ICAO ANNEX 14 VOLUME I": "ICAO Annex 14 Volume I",
        "ANNEX 14 VOL 1": "ICAO Annex 14 Volume I",
        "ICAO ANNEX 15": "ICAO Annex 15",
        "ANNEX 15": "ICAO Annex 15",
        "MNL-003-OPAT-10": "MNL-003-OPAT-10",
        "PAA AIP": "PAA AIP",
        "ICAO ANNEX 11": "ICAO Annex 11",
        "ANNEX 11": "ICAO Annex 11",
        "ICAO ANNEX 2": "ICAO Annex 2",
        "ANNEX 2": "ICAO Annex 2",
    }
    if name_upper in mapping:
        return mapping[name_upper]
    for key, canonical in mapping.items():
        if key in name_upper or name_upper in key:
            return canonical
    return name.strip()


def is_true_false(options):
    """Detect if this is a True/False question based on options keys."""
    keys = set(options.keys())
    return keys == {"True", "False"}


def determine_question_type(options):
    """Return 'true_false' or 'mcq' based on options."""
    return "true_false" if is_true_false(options) else "mcq"


def harmonise_correct_answer(correct_answer, options):
    """Ensure correct_answer is consistent with option keys.

    Generated files sometimes store True/False answers as 'True'/'False'
    (string) -- these match the option keys in T/F questions.
    For MCQ, they should be A, B, C, D, E, F.
    """
    if correct_answer is None:
        return None

    correct_str = str(correct_answer).strip()

    # If options have a matching key, use it
    if correct_str in options:
        return correct_str

    # Try case-insensitive match
    for k in options:
        if k.lower() == correct_str.lower():
            return k

    # If correct_answer is a letter (A-F) but options use different keys,
    # try to find by value match
    for k, v in options.items():
        if str(v).strip().lower() == correct_str.lower():
            return k

    # Fallback: return as-is
    return correct_str


def transform_question(raw_q, q_id):
    """Transform a raw generated question into the database schema.

    Mapping:
        temp_id        -> id (we assign numeric q_id)
        question_text  -> question
        (keep options as-is, support variable lengths)
        (keep correct_answer, explanation, difficulty, document, chapter)
        Add: source="generated", tags=[], q_type
    """
    q_type = determine_question_type(raw_q.get("options", {}))
    correct = harmonise_correct_answer(
        raw_q.get("correct_answer"), raw_q.get("options", {})
    )

    # Clean up 'from question bank' suffix from manual bank questions
    question_text = raw_q.get("question_text", "")
    suffix = "from question bank"
    if question_text.endswith(suffix):
        question_text = question_text[: -len(suffix)].strip()
    if question_text.endswith(suffix + "."):
        question_text = question_text[: -(len(suffix) + 1)].strip()

    # Handle sub_chapter: normalise "None" strings
    chapter = raw_q.get("chapter", "")
    sub_chapter = raw_q.get("sub_chapter")
    if sub_chapter == "None" or not sub_chapter:
        sub_chapter = None

    # Normalise document name for consistency
    doc = normalise_document_name(raw_q.get("document", "Unknown"))

    transformed = {
        "id": q_id,
        "source": "generated",
        "q_type": q_type,
        "document": doc,
        "chapter": chapter,
        "sub_chapter": sub_chapter,
        "topic": raw_q.get("topic", ""),
        "difficulty": raw_q.get("difficulty", "medium"),
        "question": question_text,
        "options": raw_q.get("options", {}),
        "correct_answer": correct,
        "explanation": raw_q.get("explanation", ""),
        "tags": [],
        "image_description": raw_q.get("image_description"),
        "temp_id_original": raw_q.get("temp_id", ""),
    }
    return transformed


def generate_id_map_key(doc, chapter):
    """Generate a stable key for the ID map."""
    return doc + "||" + chapter


def allocate_ids(all_new_questions, existing_count):
    """
    Allocate stable numeric IDs to new questions.

    Uses a persistent ID map so re-running the merge doesn't change IDs
    for questions that were already merged.

    Strategy:
        - For each (document, chapter) group, check if we have existing IDs
          from the map.
        - New groups get sequential IDs starting from ID_START + existing_count
          (or the next available ID after all mapped IDs).
    """
    id_map = load_id_map()
    next_id = ID_START

    # Find the highest already-mapped ID
    mapped_ids = set()
    for key, info in id_map.items():
        for qid in info.get("ids", []):
            mapped_ids.add(qid)
            if qid >= next_id:
                next_id = qid + 1

    # Also account for existing questions in the database
    # (existing placeholders use IDs 1-10)
    # We start from ID_START (11) for generated questions

    # Group new questions by (document, chapter)
    groups = defaultdict(list)
    for raw_q in all_new_questions:
        doc = raw_q.get("document", "Unknown")
        chapter = raw_q.get("chapter", "")
        key = generate_id_map_key(doc, chapter)
        groups[key].append(raw_q)

    results = []
    new_id_map_entries = {}

    for group_key, group_qs in groups.items():
        doc, chapter = group_key.split("||", 1)

        if group_key in id_map:
            # This group already has mapped IDs
            existing_ids = id_map[group_key].get("ids", [])
            existing_ids_set = set(existing_ids)

            if len(existing_ids) >= len(group_qs):
                # Same or fewer questions than before -- reuse existing IDs
                for i, raw_q in enumerate(group_qs):
                    q_id = existing_ids[i]
                    results.append(transform_question(raw_q, q_id))
            else:
                # More questions now -- reuse existing IDs + allocate new ones
                for i, raw_q in enumerate(group_qs):
                    if i < len(existing_ids):
                        q_id = existing_ids[i]
                    else:
                        # Allocate new ID
                        while next_id in mapped_ids:
                            next_id += 1
                        q_id = next_id
                        mapped_ids.add(q_id)
                        existing_ids.append(q_id)
                        next_id += 1
                    results.append(transform_question(raw_q, q_id))
                new_id_map_entries[group_key] = {"doc": doc, "chapter": chapter, "ids": existing_ids}
        else:
            # New group -- allocate fresh IDs
            allocated_ids = []
            for raw_q in group_qs:
                while next_id in mapped_ids:
                    next_id += 1
                q_id = next_id
                mapped_ids.add(q_id)
                allocated_ids.append(q_id)
                next_id += 1
                results.append(transform_question(raw_q, q_id))
            new_id_map_entries[group_key] = {"doc": doc, "chapter": chapter, "ids": allocated_ids}

    # Update the persistent ID map
    id_map.update(new_id_map_entries)
    save_id_map(id_map)

    return results


def create_backup(db_data):
    """Create a timestamped backup of the current questions.json."""
    os.makedirs(BACKUP_DIR, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = os.path.join(BACKUP_DIR, "questions_backup_" + timestamp + ".json")
    with open(backup_path, "w", encoding="utf-8") as f:
        json.dump(db_data, f, indent=2)
    print("  -> Backup created: " + backup_path)
    return backup_path


def build_document_index(questions):
    """Build a summary of documents, chapters, and question counts."""
    doc_index = {}
    for q in questions:
        doc = q.get("document", "Unknown")
        chapter = q.get("chapter", "")
        if doc not in doc_index:
            doc_index[doc] = {"chapters": set(), "count": 0}
        doc_index[doc]["chapters"].add(chapter)
        doc_index[doc]["count"] += 1

    # Convert sets to sorted lists
    for doc in doc_index:
        doc_index[doc]["chapters"] = sorted(doc_index[doc]["chapters"])

    return doc_index


def main():
    dry_run = "--dry-run" in sys.argv
    force_backup = "--backup" in sys.argv

    print("=" * 60)
    print("  ATC Question Bank -- Merge Script")
    print("=" * 60)

    # Step 1: Load existing database
    print("\n[1] Loading existing database...")
    db_data = load_existing_questions()
    existing_questions = db_data["questions"]
    existing_count = len(existing_questions)
    print(f"  -> {existing_count} existing questions (IDs: 1-{existing_count if existing_count > 0 else '0'})")
    print(f"  -> Schema version: {db_data.get('_schema_version', 'unknown')}")

    # Step 2: Load generated question files
    print("\n[2] Loading generated question files...")
    generated_files = load_generated_files()
    if not generated_files:
        print("  No generated files found. Nothing to merge.")
        return

    all_raw_questions = []
    total_raw = 0
    for fname, data in generated_files:
        all_raw_questions.extend(data)
        total_raw += len(data)
        print(f"  -> {fname}: {len(data)} questions")

    print(f"\n  Total raw questions loaded: {total_raw}")

    # Step 3: Allocate IDs
    print("\n[3] Allocating stable IDs...")
    new_questions = allocate_ids(all_raw_questions, existing_count)
    print(f"  -> {len(new_questions)} questions transformed and ID-allocated")

    # Step 4: Check for duplicates by question_text (within new set)
    print("\n[4] Checking for duplicates...")
    seen_texts = set()
    duplicates = 0
    unique_new = []
    for q in new_questions:
        text_key = q["question"].strip().lower()
        if text_key in seen_texts:
            duplicates += 1
            continue
        seen_texts.add(text_key)
        unique_new.append(q)
    if duplicates:
        print(f"  -> Removed {duplicates} duplicate questions (same question_text)")
    else:
        print(f"  -> No duplicates found")
    new_questions = unique_new

    # Step 5: Check for conflicts with existing questions
    print("\n[5] Checking for ID conflicts with existing questions...")
    existing_ids = {q["id"] for q in existing_questions}
    conflicts = [q for q in new_questions if q["id"] in existing_ids]
    if conflicts:
        print(f"  ! Found {len(conflicts)} ID conflicts! Resolving...")
        # Fix by assigning new IDs
        next_free = max(existing_ids) + 1 if existing_ids else 1
        for q in new_questions:
            if q["id"] in existing_ids:
                q["id"] = next_free
                next_free += 1
        print(f"  -> Resolved conflicts")

    # Step 6: Merge
    print("\n[6] Merging...")
    old_count = len(existing_questions)
    merged_questions = existing_questions + new_questions
    new_total = len(merged_questions)

    # Step 7: Build document index
    doc_index = build_document_index(merged_questions)
    print(f"\n  Document summary:")
    for doc, info in sorted(doc_index.items()):
        print(f"    {doc}: {info['count']} questions, {len(info['chapters'])} chapters")

    # Step 8: Update metadata
    now_iso = datetime.now().isoformat()
    db_data["_schema_version"] = "2.0"
    db_data["_last_updated"] = now_iso
    db_data["_total_questions"] = new_total
    db_data["_document_index"] = {
        doc: {"count": info["count"], "chapters": info["chapters"]}
        for doc, info in doc_index.items()
    }

    # Step 9: Create backup
    print(f"\n[7] Creating backup...")
    if dry_run and not force_backup:
        print("  [DRY-RUN] Skipping backup")
    else:
        backup_path = create_backup(db_data)
        print(f"  -> Backup at: {backup_path}")

    # Step 10: Write
    if dry_run:
        print(f"\n[8] DRY-RUN -- No changes written.")
        print(f"  Would write {new_total} questions (was {old_count})")
        print(f"  Would add {len(new_questions)} new questions")
        print(f"  Would update schema to v2.0")
    else:
        print(f"\n[8] Writing merged database...")
        # Write the merged questions back
        db_data["questions"] = merged_questions
        with open(DATA_PATH, "w", encoding="utf-8") as f:
            json.dump(db_data, f, indent=2)
        print(f"  -> Wrote {new_total} questions to {DATA_PATH}")
        print(f"  -> Added {len(new_questions)} new questions (was {old_count})")

    print("\n" + "=" * 60)
    print("  Merge complete!")
    print(f"  Previous: {old_count} questions")
    print(f"  Added:    {len(new_questions)} questions")
    print(f"  Total:    {new_total} questions")
    print("=" * 60)


if __name__ == "__main__":
    main()
