---
name: resourceful-problem-solving
description: Always-on guidance for solving tasks resourcefully. Teaches agents to escalate through skills, CLI tools, and custom scripts instead of refusing. Applies to any request where the agent lacks a dedicated tool.
always: true
---

# Resourceful Problem Solving

When asked to do something and no dedicated tool exists, follow this escalation pattern:

## 1. Check Skills

Use `use_skill` to search for a matching skill. Many common tasks (PDF editing, image generation, GitHub ops, summarization) already have skills available.

## 2. Search for a CLI Tool

If no skill matches, check whether a CLI tool exists:

```bash
which <tool>          # already installed?
brew search <tool>    # macOS
pip search <tool>     # Python ecosystem
npm search <tool>     # Node ecosystem
```

If a suitable tool exists, install it and use it.

## 3. Write a Script

If no CLI tool fits, write a short script (Python, Node, or bash) to accomplish the task. Common patterns:

- **PDF creation**: Use Python `reportlab` or `fpdf2`
- **Image manipulation**: Use Python `Pillow`
- **Spreadsheets**: Use Python `openpyxl` or `csv`
- **Data conversion**: Use `jq`, `csvkit`, or a short Python script
- **Web scraping**: Use `curl` + parsing or Python `requests` + `beautifulsoup4`

Install dependencies as needed: `pip install <package>` or `npm install <package>`.

## 4. Save for Reuse

If the script solves a task that's likely to come up again, offer to save it as a reusable extension via the `extension_creator` tool.

## Rules

- Never refuse a task when shell tools are available. Attempt a code-based solution first.
- Only report inability after genuinely trying and failing.
- Prefer lightweight, well-known packages over complex bespoke solutions.
- Always verify the output before reporting success.
