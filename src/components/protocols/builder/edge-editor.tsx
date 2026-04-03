import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useProtocolBuilderStore } from '@/features/protocols/builder/protocol-builder-store'

interface EdgeEditorProps {
  edgeId: string | null
  isOpen: boolean
  onClose: () => void
}

export function EdgeEditor({ edgeId, isOpen, onClose }: EdgeEditorProps) {
  const edges = useProtocolBuilderStore((s) => s.edges)
  const updateEdgeData = useProtocolBuilderStore((s) => s.updateEdgeData)

  if (!edgeId) return null
  const edge = edges.find((e) => e.id === edgeId)
  if (!edge) return null

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent>
        <DialogTitle>Edit Edge</DialogTitle>
        <div className="space-y-4">
          <div>
            <label className="text-sm font-semibold">Label</label>
            <input
              type="text"
              value={edge.data?.label || ''}
              onChange={(e) => updateEdgeData(edgeId, { label: e.target.value || null })}
              className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
              placeholder="e.g., 'Yes', 'If unanimous'"
            />
          </div>
          <div>
            <label className="text-sm font-semibold">Type</label>
            <div className="mt-1 rounded-md bg-muted px-2 py-1 text-sm capitalize">
              {edge.data?.edgeType || 'default'}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
