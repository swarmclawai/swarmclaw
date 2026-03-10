'use client'

import { useEffect, useRef, useState } from 'react'
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

export function MemoryGraphView() {
  const [data, setData] = useState<{ nodes: Node[]; links: Link[] }>({ nodes: [], links: [] })
  const [loading, setLoading] = useState(true)
  const [hoveredNode, setHoveredNode] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const requestRef = useRef<number>(null)
  
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
        
        setData({ nodes, links: res.links })
      } catch (err) {
        console.error('Failed to load memory graph', err)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [memoryAgentFilter])

  // Simple Force-Directed Simulation
  useEffect(() => {
    if (data.nodes.length === 0) return

    const animate = () => {
      setData(prev => {
        const nodes = [...prev.nodes]
        const links = prev.links
        
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
        }

        return { nodes, links }
      })
      requestRef.current = requestAnimationFrame(animate)
    }

    requestRef.current = requestAnimationFrame(animate)
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current)
    }
  }, [data.nodes.length])

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-bright"></div>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="flex-1 relative overflow-hidden bg-black/20 rounded-[16px] border border-white/[0.06]">
      <svg width="100%" height="100%" viewBox="0 0 800 600" preserveAspectRatio="xMidYMid meet">
        {/* Links */}
        {data.links.map((link, i) => {
          const s = data.nodes.find(n => n.id === link.source)
          const t = data.nodes.find(n => n.id === link.target)
          if (!s || !t) return null
          return (
            <line
              key={i}
              x1={s.x} y1={s.y}
              x2={t.x} y2={t.y}
              stroke="white"
              strokeOpacity="0.1"
              strokeWidth="1"
            />
          )
        })}

        {/* Nodes */}
        {data.nodes.map(node => (
          <g 
            key={node.id} 
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
