import { useEffect } from 'react'
import { useProtocolBuilderStore } from '../protocol-builder-store'
import { validateDAG } from '../validators/dag-validator'

export function useCanvasValidation() {
  const nodes = useProtocolBuilderStore((s) => s.nodes)
  const edges = useProtocolBuilderStore((s) => s.edges)
  const setValidation = useProtocolBuilderStore((s) => s.setValidation)

  useEffect(() => {
    const { errors, warnings } = validateDAG(nodes, edges)
    setValidation(errors, warnings)
  }, [nodes, edges, setValidation])
}
