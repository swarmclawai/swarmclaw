export type ThemeMode = 'light' | 'dark' | 'system'

export function normalizeThemeMode(value: unknown): ThemeMode {
  return value === 'light' || value === 'system' ? value : 'dark'
}
