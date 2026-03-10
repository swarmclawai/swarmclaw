import { execSync } from 'child_process'
import type { Skill, SkillRequirements } from '@/types'

export interface SkillEligibilityResult {
  eligible: boolean
  missingBins: string[]
  missingAnyBins: string[][]
  missingEnv: string[]
  unsupportedOs: boolean
  reasons: string[]
}

const binaryCache = new Map<string, boolean>()

function hasBinary(name: string): boolean {
  const cached = binaryCache.get(name)
  if (cached !== undefined) return cached
  try {
    execSync(`which ${name}`, { stdio: 'ignore', timeout: 2000 })
    binaryCache.set(name, true)
    return true
  } catch {
    binaryCache.set(name, false)
    return false
  }
}

/** Clear the binary cache (useful for tests or after installs). */
export function clearBinaryCache(): void {
  binaryCache.clear()
}

export function evaluateSkillEligibility(skill: Skill): SkillEligibilityResult {
  const req = skill.skillRequirements
  if (!req) return { eligible: true, missingBins: [], missingAnyBins: [], missingEnv: [], unsupportedOs: false, reasons: [] }

  return evaluateRequirements(req)
}

export function evaluateRequirements(req: SkillRequirements): SkillEligibilityResult {
  const reasons: string[] = []
  const missingBins: string[] = []
  const missingAnyBins: string[][] = []
  const missingEnv: string[] = []
  let unsupportedOs = false

  // Check required binaries
  if (req.bins?.length) {
    for (const bin of req.bins) {
      if (!hasBinary(bin)) {
        missingBins.push(bin)
      }
    }
    if (missingBins.length) {
      reasons.push(`Missing binaries: ${missingBins.join(', ')}`)
    }
  }

  // Check anyBins groups (at least one from each group must exist)
  if (req.anyBins?.length) {
    for (const group of req.anyBins) {
      if (!group.some(hasBinary)) {
        missingAnyBins.push(group)
        reasons.push(`None of [${group.join(', ')}] found`)
      }
    }
  }

  // Check required environment variables
  if (req.env?.length) {
    for (const envVar of req.env) {
      if (!process.env[envVar]) {
        missingEnv.push(envVar)
      }
    }
    if (missingEnv.length) {
      reasons.push(`Missing env vars: ${missingEnv.join(', ')}`)
    }
  }

  // Check OS compatibility
  if (req.os?.length) {
    if (!req.os.includes(process.platform)) {
      unsupportedOs = true
      reasons.push(`OS ${process.platform} not in [${req.os.join(', ')}]`)
    }
  }

  const eligible = missingBins.length === 0
    && missingAnyBins.length === 0
    && missingEnv.length === 0
    && !unsupportedOs

  return { eligible, missingBins, missingAnyBins, missingEnv, unsupportedOs, reasons }
}
