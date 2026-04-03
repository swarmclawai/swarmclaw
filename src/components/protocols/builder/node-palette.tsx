import { useState, type DragEvent } from 'react'
import { cn } from '@/lib/utils'
import type { ProtocolStepKind } from '@/types'

interface PaletteCategory {
  label: string
  items: Array<{ kind: ProtocolStepKind; label: string; description: string }>
}

const CATEGORIES: PaletteCategory[] = [
  {
    label: 'Phases',
    items: [
      { kind: 'present', label: 'Present', description: 'Show info to participants' },
      { kind: 'collect_independent_inputs', label: 'Collect Inputs', description: 'Gather independent responses' },
      { kind: 'round_robin', label: 'Round Robin', description: 'Turn-based discussion' },
      { kind: 'compare', label: 'Compare', description: 'Compare agent outputs' },
      { kind: 'decide', label: 'Decide', description: 'Make a decision' },
      { kind: 'summarize', label: 'Summarize', description: 'Synthesize results' },
    ],
  },
  {
    label: 'Actions',
    items: [
      { kind: 'emit_tasks', label: 'Emit Tasks', description: 'Create tasks from context' },
      { kind: 'dispatch_task', label: 'Dispatch Task', description: 'Assign a specific task' },
      { kind: 'dispatch_delegation', label: 'Delegate', description: 'Delegate to an agent' },
    ],
  },
  {
    label: 'Control Flow',
    items: [
      { kind: 'branch', label: 'Branch', description: 'Conditional path' },
      { kind: 'repeat', label: 'Repeat', description: 'Loop with exit condition' },
      { kind: 'parallel', label: 'Parallel', description: 'Fork into parallel branches' },
      { kind: 'join', label: 'Join', description: 'Merge parallel branches' },
      { kind: 'for_each', label: 'For Each', description: 'Iterate over items' },
    ],
  },
  {
    label: 'Advanced',
    items: [
      { kind: 'subflow', label: 'Subflow', description: 'Nested protocol template' },
      { kind: 'swarm_claim', label: 'Swarm Claim', description: 'Competitive task claiming' },
      { kind: 'wait', label: 'Wait', description: 'Pause until external input' },
      { kind: 'complete', label: 'Complete', description: 'End the protocol' },
    ],
  },
]

export function NodePalette() {
  const [expandedCategory, setExpandedCategory] = useState<string | null>('Phases')

  const onDragStart = (e: DragEvent, kind: ProtocolStepKind, label: string) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/x-protocol-node-kind', kind)
    e.dataTransfer.setData('application/x-protocol-node-label', label)
  }

  return (
    <div className="flex w-52 flex-col overflow-y-auto rounded-lg border bg-card p-3 shadow-sm">
      <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">
        Drag to canvas
      </h3>

      {CATEGORIES.map((cat) => (
        <div key={cat.label} className="mb-2">
          <button
            onClick={() => setExpandedCategory(expandedCategory === cat.label ? null : cat.label)}
            className="mb-1 flex w-full items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-foreground"
          >
            <span className="text-[10px]">{expandedCategory === cat.label ? '\u25BC' : '\u25B6'}</span>
            {cat.label}
          </button>
          {expandedCategory === cat.label && (
            <div className="space-y-1">
              {cat.items.map(({ kind, label, description }) => (
                <div
                  key={kind}
                  draggable
                  onDragStart={(e) => onDragStart(e, kind, label)}
                  className={cn(
                    'cursor-grab rounded-md border bg-background px-3 py-2 text-sm',
                    'transition-shadow hover:shadow-md active:cursor-grabbing',
                  )}
                  title={description}
                >
                  {label}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
