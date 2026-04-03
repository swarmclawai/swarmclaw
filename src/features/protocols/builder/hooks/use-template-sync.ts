import { useEffect, useRef } from 'react'
import { useProtocolBuilderStore } from '../protocol-builder-store'
import { useUpsertProtocolTemplateMutation, type ProtocolTemplatePayload } from '@/features/protocols/queries'
import { nodesToTemplate } from '../utils/nodes-to-template'

export function useTemplateSync(autoSaveDelayMs = 2000) {
  const nodes = useProtocolBuilderStore((s) => s.nodes)
  const edges = useProtocolBuilderStore((s) => s.edges)
  const isDirty = useProtocolBuilderStore((s) => s.isDirty)
  const currentTemplate = useProtocolBuilderStore((s) => s.currentTemplate)
  const setDirty = useProtocolBuilderStore((s) => s.setDirty)
  const validationErrors = useProtocolBuilderStore((s) => s.validationErrors)
  const mutation = useUpsertProtocolTemplateMutation()
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!isDirty || !currentTemplate || validationErrors.length > 0) return

    if (debounceRef.current) clearTimeout(debounceRef.current)

    debounceRef.current = setTimeout(async () => {
      const updated = nodesToTemplate(nodes, edges, currentTemplate)
      const payload: ProtocolTemplatePayload = {
        name: updated.name,
        description: updated.description,
        tags: updated.tags || [],
        recommendedOutputs: updated.recommendedOutputs || [],
        singleAgentAllowed: updated.singleAgentAllowed || false,
        steps: updated.steps || [],
        entryStepId: updated.entryStepId,
      }

      try {
        await mutation.mutateAsync({ templateId: currentTemplate.id, payload })
        setDirty(false)
      } catch {
        // Save failed silently — user sees "Unsaved changes" indicator
      }
    }, autoSaveDelayMs)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [isDirty, nodes, edges, currentTemplate, validationErrors.length, autoSaveDelayMs, mutation, setDirty])
}
