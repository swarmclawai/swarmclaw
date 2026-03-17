export function createAssistantRenderId(): string {
  return `assistant-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
