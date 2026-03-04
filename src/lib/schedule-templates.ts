export interface ScheduleTemplate {
  id: string
  name: string
  description: string
  icon: string
  category: 'monitoring' | 'reporting' | 'maintenance' | 'content'
  defaults: {
    taskPrompt: string
    scheduleType: 'cron' | 'interval'
    cron?: string
    intervalMs?: number
  }
}

export const SCHEDULE_TEMPLATES: ScheduleTemplate[] = [
  {
    id: 'daily-digest',
    name: 'Daily Digest',
    description: 'Summarize activity from the past 24 hours each morning',
    icon: 'Newspaper',
    category: 'reporting',
    defaults: {
      taskPrompt: 'Summarize all notable activity, events, and updates from the past 24 hours. Highlight key metrics, completed tasks, and anything that needs attention.',
      scheduleType: 'cron',
      cron: '0 9 * * *',
    },
  },
  {
    id: 'weekly-report',
    name: 'Weekly Report',
    description: 'Generate a weekly metrics and progress report every Monday',
    icon: 'BarChart3',
    category: 'reporting',
    defaults: {
      taskPrompt: 'Generate a comprehensive weekly report covering key metrics, completed tasks, ongoing work, blockers, and recommendations for the coming week.',
      scheduleType: 'cron',
      cron: '0 10 * * 1',
    },
  },
  {
    id: 'health-monitor',
    name: 'Health Monitor',
    description: 'Check system health and service status every 5 minutes',
    icon: 'HeartPulse',
    category: 'monitoring',
    defaults: {
      taskPrompt: 'Perform a system health check. Verify all services are running, check resource usage (CPU, memory, disk), and report any anomalies or degraded performance.',
      scheduleType: 'interval',
      intervalMs: 300000,
    },
  },
  {
    id: 'content-generation',
    name: 'Content Generation',
    description: 'Generate daily content such as posts, summaries, or briefs',
    icon: 'PenLine',
    category: 'content',
    defaults: {
      taskPrompt: 'Generate fresh content based on current trends and recent activity. Create a well-structured draft ready for review and publishing.',
      scheduleType: 'cron',
      cron: '0 8 * * *',
    },
  },
  {
    id: 'data-cleanup',
    name: 'Data Cleanup',
    description: 'Run weekly cleanup of stale data and temporary files',
    icon: 'Trash2',
    category: 'maintenance',
    defaults: {
      taskPrompt: 'Identify and clean up stale data, expired records, orphaned files, and temporary resources. Log what was removed and any issues encountered.',
      scheduleType: 'cron',
      cron: '0 2 * * 0',
    },
  },
  {
    id: 'metric-snapshot',
    name: 'Metric Snapshot',
    description: 'Capture an hourly snapshot of key metrics and KPIs',
    icon: 'Activity',
    category: 'monitoring',
    defaults: {
      taskPrompt: 'Capture a snapshot of all key metrics and KPIs. Record current values, compare against previous snapshots, and flag any significant changes or threshold breaches.',
      scheduleType: 'interval',
      intervalMs: 3600000,
    },
  },
  {
    id: 'security-audit',
    name: 'Security Audit',
    description: 'Run a daily security scan and vulnerability check',
    icon: 'ShieldCheck',
    category: 'monitoring',
    defaults: {
      taskPrompt: 'Perform a security audit. Check for unusual access patterns, review authentication logs, scan for known vulnerabilities, and report any security concerns.',
      scheduleType: 'cron',
      cron: '0 0 * * *',
    },
  },
  {
    id: 'backup-check',
    name: 'Backup Check',
    description: 'Verify backup integrity and completeness daily',
    icon: 'DatabaseBackup',
    category: 'maintenance',
    defaults: {
      taskPrompt: 'Verify that all scheduled backups completed successfully. Check backup integrity, storage usage, and retention policy compliance. Alert on any failures.',
      scheduleType: 'cron',
      cron: '0 3 * * *',
    },
  },
]

/** Subset of templates to feature in the empty state */
export const FEATURED_TEMPLATE_IDS = ['daily-digest', 'health-monitor', 'content-generation'] as const
