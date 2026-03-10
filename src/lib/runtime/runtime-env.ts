function normalizedNodeEnv(): string {
  return typeof process.env.NODE_ENV === 'string'
    ? process.env.NODE_ENV.trim().toLowerCase()
    : ''
}

export function isProductionRuntime(): boolean {
  return normalizedNodeEnv() === 'production'
}

export function isDevelopmentLikeRuntime(): boolean {
  return !isProductionRuntime()
}
