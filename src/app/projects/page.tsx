'use client'

import { ProjectList } from '@/components/projects/project-list'
import { ProjectDetail } from '@/components/projects/project-detail'
import { MainContent } from '@/components/layout/main-content'

export default function ProjectsPage() {
  return (
    <MainContent>
      <div className="flex-1 flex h-full min-w-0">
        <div className="w-[280px] shrink-0 border-r border-white/[0.06] flex flex-col">
          <ProjectList />
        </div>
        <ProjectDetail />
      </div>
    </MainContent>
  )
}
