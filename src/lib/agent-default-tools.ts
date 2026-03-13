import { ALL_TOOLS } from '@/lib/tool-definitions'
import { normalizeCapabilitySelection } from '@/lib/capability-selection'

const DEFAULT_AGENT_TOOL_IDS = Array.from(new Set(ALL_TOOLS.map((tool) => tool.id)))

const KNOWN_TOOL_IDS = new Set(ALL_TOOLS.map((tool) => tool.id))

export function getDefaultAgentToolIds(): string[] {
  return DEFAULT_AGENT_TOOL_IDS.filter((toolId) => KNOWN_TOOL_IDS.has(toolId))
}

export function resolveAgentToolSelection(options: {
  hasExplicitTools: boolean
  hasExplicitExtensions: boolean
  tools?: string[] | null
  extensions?: string[] | null
}): {
  tools: string[]
  extensions: string[]
} {
  const { hasExplicitTools, hasExplicitExtensions, tools, extensions } = options

  if (!hasExplicitTools && !hasExplicitExtensions && !Array.isArray(tools) && !Array.isArray(extensions)) {
    const defaultTools = getDefaultAgentToolIds()
    return {
      tools: defaultTools,
      extensions: [],
    }
  }

  const normalized = normalizeCapabilitySelection({ tools, extensions })
  return {
    tools: hasExplicitTools ? normalized.tools : (Array.isArray(tools) ? normalized.tools : getDefaultAgentToolIds()),
    extensions: hasExplicitExtensions ? normalized.extensions : normalized.extensions,
  }
}
