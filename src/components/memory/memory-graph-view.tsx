'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { api } from '@/lib/app/api-client'
import { useAppStore } from '@/stores/use-app-store'

interface Node {
  id: string
  title: string
  category: string
  agentId?: string | null
  x: number
  y: number
  vx: number
  vy: number
}

interface Link {
  source: string
  target: string
  type: string
}

/** Kinetic energy threshold — stop simulation when total energy drops below this. */
const SETTLE_THRESHOLD = 0.5

export function MemoryGraphView() {
  const [initialData, setInitialData] = useState<{ nodes: Node[]; links: Link[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [hoveredNode, setHoveredNode] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const requestRef = useRef<number>(null)
  const nodesRef = useRef<Node[]>([])
  const linksRef = useRef<Link[]>([])

  const selectedMemoryId = useAppStore((s) => s.selectedMemoryId)
  const setSelectedMemoryId = useAppStore((s) => s.setSelectedMemoryId)
  const memoryAgentFilter = useAppStore((s) => s.memoryAgentFilter)

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const url = `/memory/graph${memoryAgentFilter ? `?agentId=${memoryAgentFilter}` : ''}`
        const res = await api<{ nodes: Node[]; links: Link[] }>('GET', url)

        // Initialize positions
        const nodes = res.nodes.map(n => ({
          ...n,
          x: Math.random() * 800,
          y: Math.random() * 600,
          vx: 0,
          vy: 0
        }))

        nodesRef.current = nodes
        linksRef.current = res.links
        setInitialData({ nodes, links: res.links })
      } catch (err) {
        console.error('Failed to load memory graph', err)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [memoryAgentFilter])

  // Write positions directly to SVG DOM — no React state updates per frame
  const updateDOM = useCallback(() => {
    const svg = svgRef.current
    if (!svg) return
    const nodes = nodesRef.current

    // Update link positions
    const lineElements = svg.querySelectorAll<SVGLineElement>('[data-link]')
    lineElements.forEach((el) => {
      const srcId = el.getAttribute('data-src')
      const tgtId = el.getAttribute('data-tgt')
      const s = nodes.find(n => n.id === srcId)
      const t = nodes.find(n => n.id === tgtId)
      if (s && t) {
        el.setAttribute('x1', String(s.x))
        el.setAttribute('y1', String(s.y))
        el.setAttribute('x2', String(t.x))
        el.setAttribute('y2', String(t.y))
      }
    })

    // Update node positions
    const gElements = svg.querySelectorAll<SVGGElement>('[data-node-id]')
    gElements.forEach((el) => {
      const id = el.getAttribute('data-node-id')
      const node = nodes.find(n => n.id === id)
      if (node) {
        el.setAttribute('transform', `translate(${node.x},${node.y})`)
      }
    })
  }, [])

  // Force-directed simulation running in refs, writing to DOM imperatively
  useEffect(() => {
    const nodes = nodesRef.current
    const links = linksRef.current
    if (nodes.length === 0) return

    const animate = () => {
      let totalEnergy = 0

      // 1. Repulsion between all nodes
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[i].x - nodes[j].x
          const dy = nodes[i].y - nodes[j].y
          const distSq = dx * dx + dy * dy + 0.1
          const force = 400 / distSq
          const fx = dx * force
          const fy = dy * force
          nodes[i].vx += fx
          nodes[i].vy += fy
          nodes[j].vx -= fx
          nodes[j].vy -= fy
        }
      }

      // 2. Attraction along links
      for (const link of links) {
        const source = nodes.find(n => n.id === link.source)
        const target = nodes.find(n => n.id === link.target)
        if (source && target) {
          const dx = target.x - source.x
          const dy = target.y - source.y
          const dist = Math.sqrt(dx * dx + dy * dy) + 0.1
          const force = (dist - 100) * 0.02
          const fx = (dx / dist) * force
          const fy = (dy / dist) * force
          source.vx += fx
          source.vy += fy
          target.vx -= fx
          target.vy -= fy
        }
      }

      // 3. Centering force
      const cx = 400
      const cy = 300
      for (const node of nodes) {
        node.vx += (cx - node.x) * 0.01
        node.vy += (cy - node.y) * 0.01
      }

      // 4. Update positions with damping
      for (const node of nodes) {
        node.x += node.vx
        node.y += node.vy
        node.vx *= 0.8
        node.vy *= 0.8
        totalEnergy += node.vx * node.vx + node.vy * node.vy
      }

      // Write positions to DOM imperatively
      updateDOM()

      // Stop when settled
      if (totalEnergy > SETTLE_THRESHOLD) {
        requestRef.current = requestAnimationFrame(animate)
      }
    }

    requestRef.current = requestAnimationFrame(animate)
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current)
    }
  }, [initialData, updateDOM])

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-bright"></div>
      </div>
    )
  }

  const nodes = nodesRef.current
  const links = linksRef.current

  return (
    <div ref={containerRef} className="flex-1 relative overflow-hidden bg-black/20 rounded-[16px] border border-white/[0.06]">
      <svg ref={svgRef} width="100%" height="100%" viewBox="0 0 800 600" preserveAspectRatio="xMidYMid meet">
        {/* Links */}
        {links.map((link, i) => {
          const s = nodes.find(n => n.id === link.source)
          const t = nodes.find(n => n.id === link.target)
          if (!s || !t) return null
          return (
            <line
              key={i}
              data-link=""
              data-src={link.source}
              data-tgt={link.target}
              x1={s.x} y1={s.y}
              x2={t.x} y2={t.y}
              stroke="white"
              strokeOpacity="0.1"
              strokeWidth="1"
            />
          )
        })}

        {/* Nodes */}
        {nodes.map(node => (
          <g
            key={node.id}
            data-node-id={node.id}
            transform={`translate(${node.x},${node.y})`}
            onMouseEnter={() => setHoveredNode(node.id)}
            onMouseLeave={() => setHoveredNode(null)}
            onClick={() => setSelectedMemoryId(node.id)}
            className="cursor-pointer"
          >
            <circle
              r={selectedMemoryId === node.id ? 8 : 5}
              fill={node.category === 'knowledge' ? '#10B981' : '#6366F1'}
              stroke="white"
              strokeWidth={selectedMemoryId === node.id ? 2 : 0}
              className="transition-all"
            />
            {(hoveredNode === node.id || selectedMemoryId === node.id) && (
              <text
                y="-12"
                textAnchor="middle"
                className="text-[10px] fill-text font-600 pointer-events-none"
                style={{ filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.5))' }}
              >
                {node.title}
              </text>
            )}
          </g>
        ))}
      </svg>

      {/* Legend */}
      <div className="absolute bottom-4 left-4 p-3 bg-surface/80 backdrop-blur rounded-[12px] border border-white/[0.06] flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-[#10B981]" />
          <span className="text-[11px] text-text-3">Knowledge</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-[#6366F1]" />
          <span className="text-[11px] text-text-3">Note / Working</span>
        </div>
      </div>
    </div>
  )
}
