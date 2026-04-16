import type {
  MissionBudget,
  MissionReportSchedule,
  MissionTemplate,
  MissionTemplateCategory,
} from '@/types'
import { DEFAULT_MISSION_WARN_FRACTIONS } from '@/types'

const HOUR = 3600
const DAY = 86_400

function budget(overrides: Partial<MissionBudget>): MissionBudget {
  return {
    maxUsd: null,
    maxTokens: null,
    maxToolCalls: null,
    maxWallclockSec: null,
    maxTurns: null,
    warnAtFractions: DEFAULT_MISSION_WARN_FRACTIONS,
    ...overrides,
  }
}

function report(intervalSec: number, format: MissionReportSchedule['format'] = 'markdown'): MissionReportSchedule {
  return { intervalSec, format, enabled: true, lastReportAt: null }
}

export const BUILT_IN_MISSION_TEMPLATES: MissionTemplate[] = [
  {
    id: 'daily-news-digest',
    name: 'Daily News Digest',
    description:
      'Scan news sources, pick the 5 most relevant stories for your interests, and write a short digest once a day.',
    icon: '📰',
    category: 'research',
    tags: ['daily', 'news', 'summary'],
    setupNote:
      'Edit the goal to list your interests and sources before starting (e.g., "AI infrastructure, open-source agents, Bloomberg / Hacker News").',
    defaults: {
      title: 'Daily News Digest',
      goal:
        'Every day, scan the latest news from my sources of interest, pick the 5 most relevant stories, and write a short markdown digest with title, 2-sentence summary, and link for each.',
      successCriteria: [
        'Exactly 5 stories per digest',
        'Each story has a title, summary, and source link',
        'Digest is less than 500 words',
      ],
      budget: budget({ maxUsd: 1, maxTokens: 40_000, maxTurns: 80, maxWallclockSec: 2 * HOUR }),
      reportSchedule: report(DAY),
    },
  },
  {
    id: 'inbox-triage',
    name: 'Inbox Triage',
    description:
      'Classify new emails, draft replies to routine threads, and flag anything that needs your attention.',
    icon: '📬',
    category: 'communication',
    tags: ['email', 'triage', 'automation'],
    setupNote:
      'Connect your email connector and confirm send/reply permissions before starting this mission.',
    defaults: {
      title: 'Inbox Triage',
      goal:
        'Every hour, pull new emails, classify each as routine / needs-reply / urgent, draft replies to routine threads for my approval, and surface urgent items to me immediately.',
      successCriteria: [
        'Every new email is classified',
        'Routine replies are drafted, not sent without approval',
        'Urgent items are flagged within the same hour they arrive',
      ],
      budget: budget({ maxUsd: 3, maxTokens: 120_000, maxTurns: 200, maxWallclockSec: 12 * HOUR }),
      reportSchedule: report(6 * HOUR),
    },
  },
  {
    id: 'competitor-watch',
    name: 'Competitor Watch',
    description:
      'Track competitor websites, blogs, and releases; flag anything new and write a weekly summary.',
    icon: '🔭',
    category: 'monitoring',
    tags: ['competitive', 'weekly', 'monitoring'],
    setupNote:
      'List the competitors and specific URLs to watch in the goal field before starting.',
    defaults: {
      title: 'Competitor Watch',
      goal:
        'Check the listed competitors every 6 hours for product releases, pricing changes, blog posts, and notable social activity. Write a short summary of new signals and compile a weekly roll-up.',
      successCriteria: [
        'All listed competitors are checked every cycle',
        'New signals are captured with source links and timestamps',
        'A weekly roll-up is produced on Monday mornings',
      ],
      budget: budget({ maxUsd: 5, maxTokens: 200_000, maxTurns: 300, maxWallclockSec: 7 * DAY }),
      reportSchedule: report(DAY),
    },
  },
  {
    id: 'weekly-research-report',
    name: 'Weekly Research Report',
    description:
      'Pick a research topic each Monday, dig into it across the week, and deliver a polished report by Friday.',
    icon: '🧠',
    category: 'research',
    tags: ['weekly', 'research', 'report'],
    setupNote:
      'Set the topic in the goal (or let the agent pick from a rotating list).',
    defaults: {
      title: 'Weekly Research Report',
      goal:
        'Produce a 1000-2000 word research report on the assigned topic. Gather at least 8 sources, compare viewpoints, surface open questions, and deliver a polished markdown document by end of week.',
      successCriteria: [
        'Report is between 1000 and 2000 words',
        'At least 8 distinct sources are cited with links',
        'Conclusion explicitly lists open questions or areas for follow-up',
      ],
      budget: budget({ maxUsd: 4, maxTokens: 250_000, maxTurns: 250, maxWallclockSec: 7 * DAY }),
      reportSchedule: report(2 * DAY),
    },
  },
  {
    id: 'social-listener',
    name: 'Social Listener',
    description:
      'Watch configured channels for mentions of your brand, keywords, or topics and surface notable threads.',
    icon: '👂',
    category: 'monitoring',
    tags: ['social', 'listening', 'realtime'],
    setupNote:
      'Connect Discord or Slack (or both) and list the keywords to watch for in the goal.',
    defaults: {
      title: 'Social Listener',
      goal:
        'Watch the connected channels for the configured keywords. When a match appears, capture the message, author, timestamp, and a 1-sentence context note. Summarize daily.',
      successCriteria: [
        'Every keyword match is captured with context',
        'No duplicate alerts for the same message',
        'A daily recap is produced listing the top 10 mentions',
      ],
      budget: budget({ maxUsd: 2, maxTokens: 100_000, maxTurns: 400, maxWallclockSec: 7 * DAY }),
      reportSchedule: report(DAY),
    },
  },
  {
    id: 'customer-support-triage',
    name: 'Customer Support Triage',
    description:
      'Classify incoming support tickets, draft first responses, and route complex issues to a human.',
    icon: '🛟',
    category: 'support',
    tags: ['support', 'triage', 'drafts'],
    setupNote:
      'Connect your helpdesk or email connector and confirm draft-only permissions before starting.',
    defaults: {
      title: 'Customer Support Triage',
      goal:
        'For each new support ticket, classify priority and category, draft a first response for human review, and flag tickets that require engineering or account-level escalation.',
      successCriteria: [
        'Every ticket receives a draft within one hour',
        'Priority and category are labeled consistently',
        'Escalations are clearly flagged with a reason',
      ],
      budget: budget({ maxUsd: 3, maxTokens: 150_000, maxTurns: 300, maxWallclockSec: 3 * DAY }),
      reportSchedule: report(12 * HOUR),
    },
  },
  {
    id: 'hello-world-demo',
    name: 'Hello World Demo',
    description:
      'A zero-cost first-run mission that summarizes the current working directory into a short markdown report. Great for first-time users to watch an agent complete a bounded task end-to-end.',
    icon: '👋',
    category: 'research',
    tags: ['demo', 'first-run', 'short'],
    setupNote:
      'No setup required. This demo mission runs in your workspace, reads a few files, and produces a short markdown summary. Best paired with a local Ollama model or any configured provider.',
    defaults: {
      title: 'Hello World Demo',
      goal:
        'List the files in the current working directory, pick the 3 that look most interesting, read a short excerpt from each, and write a markdown file `hello-world-report.md` with a one-paragraph summary of what this project appears to do. Do not modify any existing files.',
      successCriteria: [
        'Reads at least 3 files',
        'Writes hello-world-report.md with a clear one-paragraph summary',
        'Does not modify any pre-existing files',
      ],
      budget: budget({ maxUsd: 0.25, maxTokens: 20_000, maxTurns: 30, maxWallclockSec: 15 * 60 }),
      reportSchedule: report(HOUR),
    },
  },
]

const TEMPLATE_INDEX: Map<string, MissionTemplate> = new Map(
  BUILT_IN_MISSION_TEMPLATES.map((template) => [template.id, template]),
)

export function listMissionTemplates(): MissionTemplate[] {
  return BUILT_IN_MISSION_TEMPLATES.slice()
}

export function getMissionTemplate(id: string | null | undefined): MissionTemplate | null {
  if (!id || typeof id !== 'string') return null
  return TEMPLATE_INDEX.get(id.trim()) ?? null
}

export function listMissionTemplateCategories(): MissionTemplateCategory[] {
  const seen = new Set<MissionTemplateCategory>()
  for (const template of BUILT_IN_MISSION_TEMPLATES) seen.add(template.category)
  return Array.from(seen)
}
