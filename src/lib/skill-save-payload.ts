import type { Skill } from '@/types'

export type SkillScope = 'global' | 'agent'

export interface SkillDraftInput {
  name: string
  filename: string
  description: string
  content: string
  scope: SkillScope
  agentIds: string[]
}

export function buildSkillSavePayload(draft: SkillDraftInput, metadataPreview?: Partial<Skill> | null) {
  return {
    name: draft.name.trim() || 'Unnamed Skill',
    filename: draft.filename.trim() || `${draft.name.trim().toLowerCase().replace(/\s+/g, '-')}.md`,
    description: draft.description,
    content: draft.content,
    scope: draft.scope,
    agentIds: draft.scope === 'agent' ? draft.agentIds : [],
    sourceUrl: metadataPreview?.sourceUrl,
    sourceFormat: metadataPreview?.sourceFormat,
    author: metadataPreview?.author,
    tags: metadataPreview?.tags,
    version: metadataPreview?.version,
    homepage: metadataPreview?.homepage,
    primaryEnv: metadataPreview?.primaryEnv,
    skillKey: metadataPreview?.skillKey,
    always: metadataPreview?.always,
    installOptions: metadataPreview?.installOptions,
    skillRequirements: metadataPreview?.skillRequirements,
    detectedEnvVars: metadataPreview?.detectedEnvVars,
    security: metadataPreview?.security,
    frontmatter: metadataPreview?.frontmatter,
  }
}
