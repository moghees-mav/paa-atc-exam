## Brief overview
Rules for efficient, silent, and targeted development collaboration with minimal context waste.

## Communication style
- Never apologize, never say "I will do X", never explain thought process unless asked.
- Use bullet points with max 15 words per bullet for summaries.
- Be direct and technical — no conversational filler.

## Development workflow
- Execute tasks strictly in numeric order, one at a time.
- Wait for explicit user confirmation before proceeding to next task.
- Use targeted diffs (replace_in_file) over full file dumps.
- Never rewrite entire files — apply precise SEARCH/REPLACE blocks.
- Use write_to_file only for new file creation or complete restructures.

## Coding best practices
- Prefer flat targeted edits with replace_in_file tool.
- Keep SEARCH blocks exact — match character-for-character including whitespace.
- Use multiple SEARCH/REPLACE blocks in one call for multiple changes to same file.
- Maintain the existing code style of the project (indentation, naming conventions, etc.).

## Tool usage
- Read files before editing to understand exact content.
- Use a single replace_in_file call with multiple SEARCH/REPLACE blocks for a file.
- Limit to <5 SEARCH/REPLACE blocks per call to avoid errors.
- After each tool use, wait for confirmation of success before proceeding.

## Project context
- ATC Exam Simulator with Pakistan Airports Authority theme.
- Stack: HTML, CSS, JavaScript (vanilla, no frameworks).
- Design: Professional aviation-grade (deep blues, clean whites, sans-serif typography).
- All data persisted via localStorage with async wrapper for future API migration.