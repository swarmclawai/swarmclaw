import { ALL_TOOLS } from '@/lib/tool-definitions'

const DEFAULT_AGENT_PLUGIN_IDS = Array.from(new Set(ALL_TOOLS.map((tool) => tool.id)))

const KNOWN_TOOL_IDS = new Set(ALL_TOOLS.map((tool) => tool.id))

export function getDefaultAgentPluginIds(): string[] {
  return DEFAULT_AGENT_PLUGIN_IDS.filter((toolId) => KNOWN_TOOL_IDS.has(toolId))
}

export function resolveAgentPluginSelection(options: {
  hasExplicitPlugins: boolean
  hasExplicitTools: boolean
  plugins?: string[] | null
  tools?: string[] | null
}): string[] {
  const { hasExplicitPlugins, hasExplicitTools, plugins, tools } = options

  if (hasExplicitPlugins) return Array.isArray(plugins) ? plugins : []
  if (hasExplicitTools) return Array.isArray(tools) ? tools : []

  if (Array.isArray(plugins) && plugins.length) return plugins
  if (Array.isArray(tools) && tools.length) return tools

  return getDefaultAgentPluginIds()
}
