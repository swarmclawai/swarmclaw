import { useEffect, useRef } from 'react'
import { useProtocolBuilderStore, type BuilderNode } from '../protocol-builder-store'
import { useProtocolRunDetailQuery } from '@/features/protocols/queries'

export function useRunOverlay(runId: string | null) {
  const setActiveRun = useProtocolBuilderStore((s) => s.setActiveRun)
  const nodes = useProtocolBuilderStore((s) => s.nodes)
  const setNodes = useProtocolBuilderStore((s) => s.setNodes)
  const { data: runDetail } = useProtocolRunDetailQuery(runId)

  const prevStepStateRef = useRef<string | null>(null)

  useEffect(() => {
    setActiveRun(runId)
    return () => setActiveRun(null)
  }, [runId, setActiveRun])

  useEffect(() => {
    if (!runDetail?.run?.stepState) return

    const stepStateKey = JSON.stringify(runDetail.run.stepState)
    if (stepStateKey === prevStepStateRef.current) return
    prevStepStateRef.current = stepStateKey

    const updated: BuilderNode[] = nodes.map((node) => {
      const stepState = runDetail.run.stepState?.[node.id]
      if (!stepState) {
        if (node.data.runtimeStatus) {
          return { ...node, data: { ...node.data, runtimeStatus: null } }
        }
        return node
      }
      if (node.data.runtimeStatus === stepState.status) return node
      return { ...node, data: { ...node.data, runtimeStatus: stepState.status } }
    })

    setNodes(updated)
  }, [runDetail?.run?.stepState, nodes, setNodes])
}
