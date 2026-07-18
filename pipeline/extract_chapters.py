#!/usr/bin/env python3
"""
extract_document_chapters.py – Extract chapters and sub-chapters from PDF/DOCX
files and output structured JSON.

Usage:
    python extract_document_chapters.py input_folder output_folder

The script processes all .pdf and .docx files in input_folder, generates one
JSON file per document in output_folder, and cleans headers, footers and
page numbers.
"""

import argparse
import json
import logging
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pdfplumber
from docx import Document as DocxDocument

# ---------------------------------------------------------------------------
# Logging configuration
# ---------------------------------------------------------------------------
logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Cleaning utilities
# ---------------------------------------------------------------------------
# Common boilerplate lines that appear in headers/footers (case‑insensitive)
FOOTER_PATTERNS = [
    r"icao\s*doc\s*\d+",  # e.g. "ICAO Doc 4444"
    r"annex\s*\d+",
    r"chapter\s*\d+",
    r"page\s*\d+",
    r"^\s*\d+\s*$",       # page number only
    r"^\s*$",             # empty lines
]

def is_boilerplate(line: str) -> bool:
    """Return True if the line matches any known boilerplate pattern."""
    line_lower = line.strip().lower()
    if not line_lower:
        return True
    for pat in FOOTER_PATTERNS:
        if re.search(pat, line_lower):
            return True
    return False

def clean_text(text: str) -> str:
    """
    Remove headers, footers, page numbers and repetitive boilerplate.
    Keeps paragraph structure intact.
    """
    lines = text.splitlines()
    cleaned = []
    for line in lines:
        if not is_boilerplate(line):
            cleaned.append(line)
    return "\n".join(cleaned).strip()

# ---------------------------------------------------------------------------
# Heading detection helpers
# ---------------------------------------------------------------------------
CHAPTER_PATTERN = re.compile(
    r"^(?:chapter\s+)?(\d{1,3})(?:[\.:\-\)]\s+)?(.*)", re.IGNORECASE
)
SUB_CHAPTER_PATTERN = re.compile(r"^(\d{1,3}\.\d{1,3})(?:\s+)?(.*)")
ALL_CAPS_PATTERN = re.compile(r"^[A-Z][A-Z\s]{5,}$")  # all‑caps title

def is_heading(line: str) -> bool:
    """Heuristic to detect a possible heading."""
    if not line.strip():
        return False
    # Explicit chapter/sub‑chapter number
    if CHAPTER_PATTERN.match(line) or SUB_CHAPTER_PATTERN.match(line):
        return True
    # All‑caps line of reasonable length (not too short, not extremely long)
    if ALL_CAPS_PATTERN.match(line) and 10 < len(line) < 120:
        return True
    return False

def parse_heading(line: str) -> Tuple[Optional[int], Optional[str]]:
    """
    Try to extract a (level, title) from a heading line.
    Returns (None, None) if not recognised.
    """
    m = CHAPTER_PATTERN.match(line)
    if m:
        # Chapter like "1", "Chapter 1:", "1. Title"
        return 1, m.group(2).strip()
    m = SUB_CHAPTER_PATTERN.match(line)
    if m:
        return 2, m.group(2).strip()
    # All‑caps title: treat as chapter if no other detected
    if ALL_CAPS_PATTERN.match(line):
        return 1, line.strip()
    return None, None

# ---------------------------------------------------------------------------
# PDF extraction
# ---------------------------------------------------------------------------
def extract_pdf(pdf_path: Path) -> str:
    """Extract text from a PDF using pdfplumber, preserving layout."""
    text_parts = []
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            page_text = page.extract_text()
            if page_text:
                text_parts.append(page_text)
    return "\n".join(text_parts)

# ---------------------------------------------------------------------------
# DOCX extraction
# ---------------------------------------------------------------------------
def extract_docx(docx_path: Path) -> List[Dict[str, Any]]:
    """
    Extract paragraphs from a DOCX file, tagging style information.
    Returns list of dicts: {'text': str, 'style': str}
    """
    doc = DocxDocument(docx_path)
    paragraphs = []
    for para in doc.paragraphs:
        text = para.text.strip()
        if text:
            paragraphs.append({"text": text, "style": para.style.name if para.style else ""})
    return paragraphs

# ---------------------------------------------------------------------------
# Chapter segmentation
# ---------------------------------------------------------------------------
def segment_pdf_text(full_text: str, doc_name: str) -> List[Dict]:
    """Build chapter/sub‑chapter hierarchy from cleaned PDF text."""
    lines = full_text.splitlines()
    # Remove empty lines but keep structure
    lines = [l.strip() for l in lines if l.strip()]
    chapters = []
    current_chapter = None
    current_sub = None
    buffer = []  # text belonging to current sub‑chapter

    def flush_sub():
        nonlocal buffer, current_sub, current_chapter
        if current_sub and buffer:
            current_sub["text"] = "\n".join(buffer).strip()
            if current_chapter is not None:
                current_chapter["sub_chapters"].append(current_sub)
        buffer = []
        current_sub = None

    def flush_chapter():
        nonlocal current_chapter, chapters
        flush_sub()
        if current_chapter:
            # Build full_text for chapter
            full = " ".join(
                [sc["text"] for sc in current_chapter["sub_chapters"]]
            )
            current_chapter["full_text"] = full
            chapters.append(current_chapter)
        current_chapter = None

    for line in lines:
        level, title = parse_heading(line)
        if level == 1:  # new chapter
            flush_chapter()
            current_chapter = {
                "chapter_title": line.strip(),
                "sub_chapters": [],
            }
            # The heading itself might contain text that should not be repeated,
            # but we'll include it in the sub‑chapter title if no sub‑chapter.
            current_sub = {"title": line.strip(), "text": ""}
            buffer = []
        elif level == 2 and current_chapter is not None:  # sub‑chapter
            flush_sub()
            current_sub = {"title": line.strip(), "text": ""}
            buffer = []
        else:
            # Regular text line
            if current_chapter is None:
                # Text before any heading – treat as a preamble chapter
                current_chapter = {
                    "chapter_title": f"{doc_name} (preamble)",
                    "sub_chapters": [],
                }
                current_sub = {"title": "preamble", "text": ""}
            buffer.append(line)
    flush_chapter()
    # If some text remained without a chapter heading, catch it
    if buffer and current_chapter is None:
        current_chapter = {
            "chapter_title": f"{doc_name} (preamble)",
            "sub_chapters": [],
        }
        current_sub = {"title": "preamble", "text": "\n".join(buffer).strip()}
        current_chapter["sub_chapters"].append(current_sub)
        current_chapter["full_text"] = current_sub["text"]
        chapters.append(current_chapter)
    elif buffer and current_chapter is not None:
        flush_sub()
        flush_chapter()

    return chapters

def segment_docx(paragraphs: List[Dict], doc_name: str) -> List[Dict]:
    """Build chapter/sub‑chapter hierarchy from DOCX paragraphs."""
    chapters = []
    current_chapter = None
    current_sub = None
    buffer = []

    def flush_sub():
        nonlocal buffer, current_sub, current_chapter
        if current_sub and buffer:
            current_sub["text"] = "\n".join(buffer).strip()
            if current_chapter:
                current_chapter["sub_chapters"].append(current_sub)
        buffer = []
        current_sub = None

    def flush_chapter():
        nonlocal current_chapter, chapters
        flush_sub()
        if current_chapter:
            full = " ".join(
                sc["text"] for sc in current_chapter["sub_chapters"]
            )
            current_chapter["full_text"] = full
            chapters.append(current_chapter)
        current_chapter = None

    for para in paragraphs:
        text = para["text"]
        style = para["style"].lower()
        # Heuristic: styles containing "heading", "chapter", or matching our patterns
        is_heading_style = (
            "heading" in style or "chapter" in style or "title" in style
        )
        level, title = parse_heading(text)
        if is_heading_style or level is not None:
            if level == 1 or (is_heading_style and level is None):
                flush_chapter()
                current_chapter = {
                    "chapter_title": text,
                    "sub_chapters": [],
                }
                current_sub = {"title": text, "text": ""}
                buffer = []
            elif level == 2:
                flush_sub()
                current_sub = {"title": text, "text": ""}
                buffer = []
            else:
                # treat as chapter
                flush_chapter()
                current_chapter = {
                    "chapter_title": text,
                    "sub_chapters": [],
                }
                current_sub = {"title": text, "text": ""}
                buffer = []
        else:
            if current_chapter is None:
                current_chapter = {
                    "chapter_title": f"{doc_name} (preamble)",
                    "sub_chapters": [],
                }
                current_sub = {"title": "preamble", "text": ""}
            buffer.append(text)
    flush_chapter()
    # Catch preamble if needed
    if buffer and current_chapter is None:
        current_chapter = {
            "chapter_title": f"{doc_name} (preamble)",
            "sub_chapters": [],
        }
        current_sub = {"title": "preamble", "text": "\n".join(buffer).strip()}
        current_chapter["sub_chapters"].append(current_sub)
        current_chapter["full_text"] = current_sub["text"]
        chapters.append(current_chapter)
    elif buffer and current_chapter:
        flush_sub()
        flush_chapter()
    return chapters

# ---------------------------------------------------------------------------
# Main processing
# ---------------------------------------------------------------------------
def process_document(file_path: Path) -> Optional[Dict]:
    """Process a single document and return structured JSON or None on error."""
    doc_name = file_path.stem
    log.info("Processing: %s", file_path.name)

    try:
        if file_path.suffix.lower() == ".pdf":
            raw_text = extract_pdf(file_path)
            cleaned = clean_text(raw_text)
            chapters = segment_pdf_text(cleaned, doc_name)
        elif file_path.suffix.lower() == ".docx":
            paragraphs = extract_docx(file_path)
            # DOCX text already clean, but we still apply cleaning to paragraph texts
            cleaned_paragraphs = [
                {"text": clean_text(p["text"]), "style": p["style"]}
                for p in paragraphs
            ]
            chapters = segment_docx(cleaned_paragraphs, doc_name)
        else:
            log.warning("Unsupported file format: %s", file_path.suffix)
            return None

        # Build final document structure
        doc_json = {
            "document_name": doc_name,
            "chapters": chapters,
        }
        return doc_json

    except Exception as e:
        log.error("Failed to process %s: %s", file_path.name, e)
        return None

def main():
    parser = argparse.ArgumentParser(
        description="Extract chapters from PDF/DOCX into JSON."
    )
    parser.add_argument("input_folder", help="Folder containing source documents")
    parser.add_argument("output_folder", help="Folder where JSON files will be written")
    args = parser.parse_args()

    input_dir = Path(args.input_folder)
    output_dir = Path(args.output_folder)
    output_dir.mkdir(parents=True, exist_ok=True)

    if not input_dir.is_dir():
        log.error("Input folder does not exist: %s", input_dir)
        sys.exit(1)

    supported_extensions = {".pdf", ".docx"}
    files = [
        f for f in input_dir.iterdir()
        if f.is_file() and f.suffix.lower() in supported_extensions
    ]
    if not files:
        log.warning("No PDF or DOCX files found in %s", input_dir)
        return

    for file_path in files:
        doc_json = process_document(file_path)
        if doc_json is None:
            continue
        out_name = file_path.stem + ".json"
        out_path = output_dir / out_name
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(doc_json, f, ensure_ascii=False, indent=2)
        log.info("Saved: %s", out_path)

if __name__ == "__main__":
    main()