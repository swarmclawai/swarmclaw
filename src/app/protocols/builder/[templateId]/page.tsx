'use client'

import { useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useProtocolTemplatesQuery } from '@/features/protocols/queries'
import { useProtocolBuilderStore } from '@/features/protocols/builder/protocol-builder-store'
import { templateToNodes } from '@/features/protocols/builder/utils/template-to-nodes'
import { getNodeLayout } from '@/features/protocols/builder/utils/node-position-layout'
import { ProtocolBuilderCanvas } from '@/components/protocols/builder/protocol-builder-canvas'
import { useTemplateSync } from '@/features/protocols/builder/hooks/use-template-sync'
import { useCanvasValidation } from '@/features/protocols/builder/hooks/use-canvas-validation'

export default function ProtocolBuilderPage() {
  const params = useParams()
  const router = useRouter()
  const templateId = params.templateId as string

  const { data: templates, isLoading } = useProtocolTemplatesQuery()
  const loadTemplate = useProtocolBuilderStore((s) => s.loadTemplate)
  const reset = useProtocolBuilderStore((s) => s.reset)

  // Auto-sync to server
  useTemplateSync(2000)

  // Validate on changes
  useCanvasValidation()

  // Load template on mount
  useEffect(() => {
    if (!templates) return
    const template = templates.find((t) => t.id === templateId)
    if (!template) return

    const { nodes, edges } = templateToNodes(template)
    const positioned = getNodeLayout(nodes, edges)
    loadTemplate(template, positioned, edges)
  }, [templateId, templates, loadTemplate])

  // Cleanup on unmount
  useEffect(() => {
    return () => reset()
  }, [reset])

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-sm text-muted-foreground">Loading builder...</div>
      </div>
    )
  }

  const template = templates?.find((t) => t.id === templateId)
  if (!template) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3">
        <div className="text-sm text-muted-foreground">Template not found</div>
        <button
          onClick={() => router.push('/protocols')}
          className="text-sm text-blue-500 hover:underline"
        >
          Back to protocols
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push('/protocols')}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            &larr; Protocols
          </button>
          <span className="text-sm font-semibold">{template.name}</span>
          {template.builtIn && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              Built-in
            </span>
          )}
        </div>
      </div>

      {/* Canvas */}
      <div className="flex-1 p-3">
        <ProtocolBuilderCanvas />
      </div>
    </div>
  )
}
