---
name: nano-pdf
description: Edit or create PDFs with natural-language instructions using the nano-pdf CLI. Use when asked to make a PDF, edit a PDF, add pages, change text in a PDF, or convert content to PDF format.
metadata:
  {
    "openclaw":
      {
        "emoji": "📄",
        "requires": { "bins": ["nano-pdf"] },
        "install":
          [
            {
              "id": "uv",
              "kind": "uv",
              "package": "nano-pdf",
              "bins": ["nano-pdf"],
              "label": "Install nano-pdf (uv)",
            },
          ],
      },
  }
---

# nano-pdf

Use `nano-pdf` to apply edits to a specific page in a PDF using a natural-language instruction.

## Quick Start

```bash
nano-pdf edit deck.pdf 1 "Change the title to 'Q3 Results' and fix the typo in the subtitle"
```

## Creating a New PDF

```bash
nano-pdf create output.pdf "Create a one-page summary of quarterly results with a header, bullet points, and a footer"
```

## Usage in SwarmClaw

When a user asks to create or edit a PDF:

1. Check if `nano-pdf` is installed: `which nano-pdf`
2. If not installed, install via `uv tool install nano-pdf` or `pip install nano-pdf`
3. Run the appropriate command
4. Report the output file path to the user

## Notes

- Page numbers are 0-based or 1-based depending on the tool's version; if the result looks off by one, retry with the other.
- Always sanity-check the output PDF before reporting success.
- For multi-page edits, run separate commands per page.
