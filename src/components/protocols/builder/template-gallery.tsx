import { useProtocolTemplatesQuery } from '@/features/protocols/queries'
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'
import type { ProtocolTemplate } from '@/types'

export function TemplateGallery() {
  const { data: templates } = useProtocolTemplatesQuery()
  const router = useRouter()

  const builtInTemplates = templates?.filter((t) => t.builtIn) || []
  const customTemplates = templates?.filter((t) => !t.builtIn) || []

  const renderCard = (template: ProtocolTemplate) => (
    <button
      key={template.id}
      onClick={() => router.push(`/protocols/builder/${template.id}`)}
      className={cn(
        'rounded-lg border bg-card p-4 text-left transition-shadow hover:shadow-md',
      )}
    >
      <div className="text-sm font-semibold">{template.name}</div>
      <div className="mt-1 text-xs text-muted-foreground line-clamp-2">
        {template.description}
      </div>
      {template.tags && template.tags.length > 0 && (
        <div className="mt-2 flex gap-1">
          {template.tags.slice(0, 2).map((tag) => (
            <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
              {tag}
            </span>
          ))}
        </div>
      )}
    </button>
  )

  return (
    <div className="space-y-4">
      {builtInTemplates.length > 0 && (
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Built-in</h4>
          <div className="grid grid-cols-2 gap-3">{builtInTemplates.map(renderCard)}</div>
        </div>
      )}
      {customTemplates.length > 0 && (
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Custom</h4>
          <div className="grid grid-cols-2 gap-3">{customTemplates.map(renderCard)}</div>
        </div>
      )}
    </div>
  )
}
