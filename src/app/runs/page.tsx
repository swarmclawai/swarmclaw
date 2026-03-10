'use client'

import { RunList } from '@/components/runs/run-list'

export default function RunsPage() {
  return (
    <div className="flex-1 flex flex-col h-full">
      <div className="flex items-center px-6 pt-5 pb-3 shrink-0">
        <h2 className="font-display text-[14px] font-600 text-text-2 tracking-[-0.01em] capitalize flex-1">
          Runs
        </h2>
      </div>
      <RunList />
    </div>
  )
}
