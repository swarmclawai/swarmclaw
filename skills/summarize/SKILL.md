---
name: summarize
description: Summarize or extract text/transcripts from URLs, podcasts, YouTube videos, and local files using the summarize CLI. Use when asked to summarize a link, article, video, or file, or to transcribe a YouTube video.
metadata:
  {
    "openclaw":
      {
        "emoji": "🧾",
        "requires": { "bins": ["summarize"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "steipete/tap/summarize",
              "bins": ["summarize"],
              "label": "Install summarize (brew)",
            },
          ],
      },
  }
---

# Summarize

Fast CLI to summarize URLs, local files, and YouTube links.

## Quick Start

```bash
summarize "https://example.com" --model google/gemini-3-flash-preview
summarize "/path/to/file.pdf" --model google/gemini-3-flash-preview
summarize "https://youtu.be/dQw4w9WgXcQ" --youtube auto
```

## YouTube: Summary vs Transcript

Best-effort transcript extraction (URLs only):

```bash
summarize "https://youtu.be/dQw4w9WgXcQ" --youtube auto --extract-only
```

If the user asked for a transcript but it's very long, return a tight summary first, then ask which section or time range to expand.

## Model + Keys

Set the API key for your chosen provider:

- OpenAI: `OPENAI_API_KEY`
- Anthropic: `ANTHROPIC_API_KEY`
- xAI: `XAI_API_KEY`
- Google: `GEMINI_API_KEY` (aliases: `GOOGLE_GENERATIVE_AI_API_KEY`, `GOOGLE_API_KEY`)

Default model is `google/gemini-3-flash-preview` if none is set.

## Useful Flags

- `--length short|medium|long|xl|xxl|<chars>` — control summary length
- `--max-output-tokens <count>` — hard token limit
- `--extract-only` — extract raw text without summarizing (URLs only)
- `--json` — machine-readable output
- `--firecrawl auto|off|always` — fallback extraction for blocked sites
- `--youtube auto` — Apify fallback if `APIFY_API_TOKEN` is set

## Config

Optional config file: `~/.summarize/config.json`

```json
{ "model": "openai/gpt-5.2" }
```

Optional services:

- `FIRECRAWL_API_KEY` for blocked sites
- `APIFY_API_TOKEN` for YouTube fallback
