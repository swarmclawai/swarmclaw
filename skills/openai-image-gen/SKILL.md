---
name: openai-image-gen
description: Generate images via OpenAI Images API (GPT Image, DALL-E 3, DALL-E 2). Supports batch generation with random prompt sampler and HTML gallery output. Use when asked to generate images with OpenAI and an OPENAI_API_KEY is available.
metadata:
  {
    "openclaw":
      {
        "emoji": "🎨",
        "requires": { "bins": ["python3"], "env": ["OPENAI_API_KEY"] },
        "primaryEnv": "OPENAI_API_KEY",
        "install":
          [
            {
              "id": "python-brew",
              "kind": "brew",
              "formula": "python",
              "bins": ["python3"],
              "label": "Install Python (brew)",
            },
          ],
      },
  }
---

# OpenAI Image Gen

Generate images via the OpenAI Images API with an HTML gallery viewer.

## Run

Note: Image generation can take longer than typical timeouts. Set a higher timeout when running via shell (e.g., 300 seconds).

```bash
python3 {baseDir}/scripts/gen.py
```

## Useful Flags

```bash
# GPT image models with various options
python3 {baseDir}/scripts/gen.py --count 16 --model gpt-image-1
python3 {baseDir}/scripts/gen.py --prompt "ultra-detailed studio photo of a lobster astronaut" --count 4
python3 {baseDir}/scripts/gen.py --size 1536x1024 --quality high --out-dir ./out/images
python3 {baseDir}/scripts/gen.py --model gpt-image-1.5 --background transparent --output-format webp

# DALL-E 3 (note: count is automatically limited to 1)
python3 {baseDir}/scripts/gen.py --model dall-e-3 --quality hd --size 1792x1024 --style vivid
python3 {baseDir}/scripts/gen.py --model dall-e-3 --style natural --prompt "serene mountain landscape"

# DALL-E 2
python3 {baseDir}/scripts/gen.py --model dall-e-2 --size 512x512 --count 4
```

## Model-Specific Parameters

### Size

- **GPT image models** (`gpt-image-1`, `gpt-image-1-mini`, `gpt-image-1.5`): `1024x1024`, `1536x1024` (landscape), `1024x1536` (portrait), or `auto`. Default: `1024x1024`
- **dall-e-3**: `1024x1024`, `1792x1024`, or `1024x1792`. Default: `1024x1024`
- **dall-e-2**: `256x256`, `512x512`, or `1024x1024`. Default: `1024x1024`

### Quality

- **GPT image models**: `auto`, `high`, `medium`, or `low`. Default: `high`
- **dall-e-3**: `hd` or `standard`. Default: `standard`
- **dall-e-2**: `standard` only

### Other Parameters

- **GPT image models** support `--background` (`transparent`, `opaque`, `auto`) and `--output-format` (`png`, `jpeg`, `webp`)
- **dall-e-3** supports `--style` (`vivid` for hyper-real, `natural` for more natural looking)
- **dall-e-3** only supports `n=1`; the script automatically limits count to 1

## Output

- Image files (`*.png`, `*.jpeg`, or `*.webp` depending on model and format)
- `prompts.json` (prompt-to-file mapping)
- `index.html` (thumbnail gallery — open in browser to review)
