import type { AppSettings } from '@/types'

export interface SettingsSectionProps {
  appSettings: AppSettings
  patchSettings: (patch: Partial<AppSettings>) => void
  inputClass: string
}
