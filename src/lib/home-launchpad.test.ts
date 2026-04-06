import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deriveHomeMode, isSparseWorkspace } from './home-launchpad'

test('isSparseWorkspace detects a fresh workspace', () => {
  assert.equal(isSparseWorkspace({
    agentCount: 1,
    sessionCount: 0,
    taskCount: 0,
    scheduleCount: 0,
    connectorCount: 0,
    todayCost: 0,
  }), true)
})

test('isSparseWorkspace returns false once work exists', () => {
  assert.equal(isSparseWorkspace({
    agentCount: 2,
    sessionCount: 1,
    taskCount: 0,
    scheduleCount: 0,
    connectorCount: 0,
    todayCost: 0,
  }), false)
})

test('deriveHomeMode prioritizes the post-setup launchpad flag', () => {
  assert.equal(deriveHomeMode({
    hasLaunchpadFlag: true,
    agentCount: 5,
    sessionCount: 8,
    taskCount: 3,
    scheduleCount: 2,
    connectorCount: 1,
    todayCost: 12.4,
  }), 'launchpad')
})

test('deriveHomeMode falls back to ops for active workspaces', () => {
  assert.equal(deriveHomeMode({
    hasLaunchpadFlag: false,
    agentCount: 3,
    sessionCount: 1,
    taskCount: 0,
    scheduleCount: 0,
    connectorCount: 0,
    todayCost: 0,
  }), 'ops')
})
