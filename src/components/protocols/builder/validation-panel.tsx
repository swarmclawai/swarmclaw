import { useProtocolBuilderStore } from '@/features/protocols/builder/protocol-builder-store'

export function ValidationPanel() {
  const errors = useProtocolBuilderStore((s) => s.validationErrors)
  const warnings = useProtocolBuilderStore((s) => s.validationWarnings)
  const selectNode = useProtocolBuilderStore((s) => s.selectNode)

  if (errors.length === 0 && warnings.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-3">
        <div className="text-sm font-semibold text-emerald-500">All checks passed</div>
      </div>
    )
  }

  return (
    <div className="max-h-48 overflow-y-auto rounded-lg border bg-card p-3 shadow-sm">
      <h3 className="mb-2 text-sm font-bold">Validation</h3>

      {errors.length > 0 && (
        <div className="mb-2">
          <h4 className="mb-1 text-xs font-semibold text-red-500">Errors</h4>
          <ul className="space-y-1">
            {errors.map((err, i) => (
              <li key={i} className="text-xs text-red-400">
                <button
                  onClick={() => err.nodeId && selectNode(err.nodeId)}
                  className="text-left hover:underline"
                >
                  {err.message}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {warnings.length > 0 && (
        <div>
          <h4 className="mb-1 text-xs font-semibold text-yellow-500">Warnings</h4>
          <ul className="space-y-1">
            {warnings.map((warn, i) => (
              <li key={i} className="text-xs text-yellow-400">
                <button
                  onClick={() => warn.nodeId && selectNode(warn.nodeId)}
                  className="text-left hover:underline"
                >
                  {warn.message}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
