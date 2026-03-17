import type { AppSettings } from '@/types'

import {
  loadPublicSettings as loadStoredPublicSettings,
  loadSettings as loadStoredSettings,
  saveSettings as saveStoredSettings,
} from '@/lib/server/storage'
import { createSingletonRepository } from '@/lib/server/persistence/repository-utils'

export const settingsRepository = createSingletonRepository<AppSettings>(
  'settings',
  {
    get() {
      return loadStoredSettings()
    },
    save(value) {
      saveStoredSettings(value)
    },
  },
)

export const loadSettings = () => settingsRepository.get()
export const saveSettings = (value: AppSettings | Record<string, unknown>) => settingsRepository.save(value as AppSettings)
export const patchSettings = (updater: (current: AppSettings) => AppSettings | Record<string, unknown>) => settingsRepository.patch(updater as (current: AppSettings) => AppSettings)
export const loadPublicSettings = () => loadStoredPublicSettings()
