'use client'

import { LogList } from '@/components/logs/log-list'

export default function LogsPage() {
  return (
    <div className="flex-1 flex flex-col h-full">
      <div className="flex items-center px-6 pt-5 pb-3 shrink-0">
        <h2 className="font-display text-[14px] font-600 text-text-2 tracking-[-0.01em] capitalize flex-1">
          Logs
        </h2>
      </div>
      <LogList />
    </div>
  )
}
