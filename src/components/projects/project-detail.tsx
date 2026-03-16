'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { api } from '@/lib/app/api-client'
import { ProjectDetailHeader } from './project-detail-header'
import { OverviewTab } from './tabs/overview-tab'
import { WorkTab } from './tabs/work-tab'
import { OperationsTab } from './tabs/operations-tab'
import { ActivityTab } from './tabs/activity-tab'
import type { BoardTask, Mission } from '@/types'

export function ProjectDetail() {
  const activeProjectFilter = useAppStore((s) => s.activeProjectFilter)
  const projects = useAppStore((s) => s.projects)
  const tasks = useAppStore((s) => s.tasks) as Record<string, BoardTask>
  const activeTab = useAppStore((s) => s.projectDetailTab)
  const loadSecrets = useAppStore((s) => s.loadSecrets)

  const [projectMissionSnapshot, setProjectMissionSnapshot] = useState<{ projectId: string | null; missions: Mission[] }>({
    projectId: null,
    missions: [],
  })

  useEffect(() => {
    if (!activeProjectFilter) return
    void loadSecrets()
  }, [activeProjectFilter, loadSecrets])

  useEffect(() => {
    let cancelled = false
    if (!activeProjectFilter) return
    void api<Mission[]>('GET', `/missions?projectId=${encodeURIComponent(activeProjectFilter)}&status=non_terminal&limit=8`)
      .then((missions) => {
        if (!cancelled) {
          setProjectMissionSnapshot({
            projectId: activeProjectFilter,
            missions: Array.isArray(missions) ? missions : [],
          })
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProjectMissionSnapshot({
            projectId: activeProjectFilter,
            missions: [],
          })
        }
      })
    return () => { cancelled = true }
  }, [activeProjectFilter])

  const projectMissions = projectMissionSnapshot.projectId === activeProjectFilter
    ? projectMissionSnapshot.missions
    : []

  const project = activeProjectFilter ? projects[activeProjectFilter] : null

  const projectTasks = useMemo(
    () => Object.values(tasks).filter((t) => t.projectId === activeProjectFilter),
    [tasks, activeProjectFilter],
  )

  const failedCount = useMemo(
    () => projectTasks.filter((t) => t.status === 'failed').length,
    [projectTasks],
  )

  const blockedCount = useMemo(
    () => projectTasks.filter((t) => (t.blockedBy?.length || 0) > 0).length,
    [projectTasks],
  )

  const credentialReqCount = useMemo(
    () => (Array.isArray(project?.credentialRequirements) ? project.credentialRequirements.length : 0),
    [project],
  )

  if (!project) {
    return (
      <div className="flex-1 flex items-center justify-center px-8">
        <div className="text-center max-w-[420px]">
          <div className="w-14 h-14 rounded-[16px] bg-white/[0.04] flex items-center justify-center mx-auto mb-4">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-text-3/40">
              <path d="M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7-7H4a2 2 0 0 0-2 2v17Z" />
              <path d="M14 2v7h7" />
            </svg>
          </div>
          <h2 className="font-display text-[20px] font-700 text-text mb-2 tracking-[-0.02em]">
            Select a Project
          </h2>
          <p className="text-[14px] text-text-3/60">
            Choose a project from the list to see its agents, tasks, and activity.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col h-full min-w-0">
      <ProjectDetailHeader
        project={project}
        failedCount={failedCount}
        blockedCount={blockedCount}
        credentialReqCount={credentialReqCount}
      />
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'overview' && (
          <OverviewTab project={project} missions={projectMissions} />
        )}
        {activeTab === 'work' && (
          <WorkTab project={project} missions={projectMissions} />
        )}
        {activeTab === 'operations' && (
          <OperationsTab project={project} />
        )}
        {activeTab === 'activity' && (
          <ActivityTab />
        )}
      </div>
    </div>
  )
}
