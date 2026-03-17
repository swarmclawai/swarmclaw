---
name: skill-creator
description: Create, edit, improve, or audit skills for SwarmClaw agents. Use when creating a new skill from scratch or when asked to improve, review, audit, tidy up, or clean up an existing skill or SKILL.md file. Also use when editing or restructuring a skill directory. Triggers on phrases like "create a skill", "author a skill", "tidy up a skill", "improve this skill", "review the skill", "clean up the skill", "audit the skill".
---

# Skill Creator

Guidance for creating effective skills that extend SwarmClaw agent capabilities.

## About Skills

Skills are modular, self-contained packages that provide specialized knowledge, workflows, and tools. They transform a general-purpose agent into a specialized one equipped with procedural knowledge that no model can fully possess.

### What Skills Provide

1. Specialized workflows — multi-step procedures for specific domains
2. Tool integrations — instructions for working with specific file formats or APIs
3. Domain expertise — company-specific knowledge, schemas, business logic
4. Bundled resources — scripts, references, and assets for complex and repetitive tasks

## Core Principles

### Concise is Key

The context window is a shared resource. Only add context the agent doesn't already have. Challenge each piece of information: "Does the agent really need this explanation?" Prefer concise examples over verbose explanations.

### Set Appropriate Degrees of Freedom

- **High freedom** (text instructions): Multiple valid approaches, context-dependent decisions
- **Medium freedom** (pseudocode/parameterized scripts): Preferred pattern exists, some variation OK
- **Low freedom** (specific scripts): Fragile operations, consistency critical, exact sequence required

### Anatomy of a Skill

```
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter (name + description, required)
│   └── Markdown instructions (required)
└── Bundled Resources (optional)
    ├── scripts/      — Executable code (Python/Bash/etc.)
    ├── references/   — Documentation loaded into context as needed
    └── assets/       — Files used in output (templates, icons, fonts)
```

#### Frontmatter

- `name`: Skill name (hyphen-case, lowercase)
- `description`: Primary triggering mechanism. Include what the skill does AND when to use it. All "when to use" info goes here — not in the body.

#### Scripts (`scripts/`)

Executable code for tasks that require deterministic reliability or are repeatedly rewritten. Token efficient and may be executed without loading into context.

#### References (`references/`)

Documentation loaded as needed to inform the agent's process. Keep only essential instructions in SKILL.md; move detailed reference material here.

#### Assets (`assets/`)

Files not loaded into context but used in output (templates, images, fonts). Separates output resources from documentation.

### What NOT to Include

- README.md, CHANGELOG.md, INSTALLATION_GUIDE.md, or other auxiliary docs
- Setup/testing procedures or user-facing documentation
- Information the agent already knows from general training

## Skill Creation Process

1. Understand the skill with concrete examples
2. Plan reusable contents (scripts, references, assets)
3. Initialize the skill
4. Edit the skill (implement resources, write SKILL.md)
5. Validate the skill
6. Iterate based on real usage

### Skill Naming

- Lowercase letters, digits, and hyphens only (hyphen-case)
- Under 64 characters
- Prefer short, verb-led phrases describing the action
- Name the skill folder exactly after the skill name

### Step 1: Understanding with Concrete Examples

Ask the user clarifying questions:

- What functionality should the skill support?
- Can you give examples of how it would be used?
- What would a user say that should trigger this skill?

### Step 2: Planning Reusable Contents

Analyze each example to identify what scripts, references, and assets would be helpful:

- **Repeated code** → `scripts/` (e.g., `scripts/rotate_pdf.py`)
- **Boilerplate** → `assets/` (e.g., `assets/hello-world/` template)
- **Domain knowledge** → `references/` (e.g., `references/schema.md`)

### Step 3: Initializing the Skill

Use the bundled init script to create the directory structure:

```bash
python3 {baseDir}/scripts/init_skill.py <skill-name> --path <output-directory> [--resources scripts,references,assets] [--examples]
```

Examples:

```bash
python3 {baseDir}/scripts/init_skill.py my-skill --path skills
python3 {baseDir}/scripts/init_skill.py my-skill --path skills --resources scripts,references
```

### Step 4: Edit the Skill

Write instructions that would help another agent instance execute tasks effectively. Include information that is beneficial and non-obvious.

**Writing guidelines:** Use imperative/infinitive form. Keep SKILL.md body under 500 lines.

**Frontmatter description:** Include both what the skill does and specific triggers for when to use it. This is the primary mechanism for skill selection.

### Step 5: Validate the Skill

Run the validator to check structure and frontmatter:

```bash
python3 {baseDir}/scripts/quick_validate.py <path/to/skill-folder>
```

### Step 6: Iterate

1. Use the skill on real tasks
2. Notice struggles or inefficiencies
3. Update SKILL.md or bundled resources
4. Test again

## Progressive Disclosure

Skills use a three-level loading system:

1. **Metadata** (name + description) — always in context (~100 words)
2. **SKILL.md body** — when skill triggers (<5k words)
3. **Bundled resources** — as needed (unlimited, since scripts can be executed without reading)

Keep SKILL.md lean. Move detailed information to reference files and describe clearly when to read them.
