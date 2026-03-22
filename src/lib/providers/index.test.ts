import assert from 'node:assert/strict'
import test from 'node:test'

import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

test('custom providers resolve from saved provider configs', () => {
  const output = runWithTempDataDir<{
    providerIds: string[]
    supportsModelDiscovery: boolean | null
    resolvedProviderName: string | null
    hasHandler: boolean
  }>(`
    const storageModule = await import('@/lib/server/storage')
    const storage = storageModule.default || storageModule
    storage.saveProviderConfigs({
      'custom-llama': {
        id: 'custom-llama',
        name: 'Llama.cpp',
        type: 'custom',
        baseUrl: 'http://127.0.0.1:8080/v1',
        models: ['llama-3.1-8b'],
        requiresApiKey: false,
        credentialId: null,
        isEnabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    })

    const providersModule = await import('@/lib/providers/index')
    const providers = providersModule.default || providersModule
    const providerList = providers.getProviderList()
    const resolvedProvider = providers.getProvider('custom-llama')

    console.log(JSON.stringify({
      providerIds: providerList.map((provider) => provider.id),
      supportsModelDiscovery: providerList.find((provider) => provider.id === 'custom-llama')?.supportsModelDiscovery ?? null,
      resolvedProviderName: resolvedProvider?.name ?? null,
      hasHandler: typeof resolvedProvider?.handler?.streamChat === 'function',
    }))
  `)

  assert.equal(output.providerIds.includes('custom-llama'), true)
  assert.equal(output.supportsModelDiscovery, false)
  assert.equal(output.resolvedProviderName, 'Llama.cpp')
  assert.equal(output.hasHandler, true)
})

test('builtin provider override records do not surface as custom providers', () => {
  const output = runWithTempDataDir<{ openAiCount: number }>(`
    const storageModule = await import('@/lib/server/storage')
    const storage = storageModule.default || storageModule
    storage.saveProviderConfigs({
      openai: {
        id: 'openai',
        name: 'OpenAI',
        type: 'builtin',
        baseUrl: '',
        models: [],
        requiresApiKey: true,
        credentialId: null,
        isEnabled: false,
        createdAt: 1,
        updatedAt: 1,
      },
    })

    const providersModule = await import('@/lib/providers/index')
    const providers = providersModule.default || providersModule
    const providerList = providers.getProviderList()

    console.log(JSON.stringify({
      openAiCount: providerList.filter((provider) => provider.id === 'openai').length,
    }))
  `)

  assert.equal(output.openAiCount, 1)
})

test('custom provider resolution includes defaultEndpoint and optionalApiKey', () => {
  const output = runWithTempDataDir<{
    defaultEndpoint: string | null
    optionalApiKey: boolean | null
    requiresApiKey: boolean | null
  }>(`
    const storageModule = await import('@/lib/server/storage')
    const storage = storageModule.default || storageModule
    storage.saveProviderConfigs({
      'custom-llama-server': {
        id: 'custom-llama-server',
        name: 'llama-server',
        type: 'custom',
        baseUrl: 'http://127.0.0.1:8080/v1',
        models: ['my-model'],
        requiresApiKey: false,
        credentialId: null,
        isEnabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    })

    const providersModule = await import('@/lib/providers/index')
    const providers = providersModule.default || providersModule
    const resolved = providers.getProvider('custom-llama-server')

    console.log(JSON.stringify({
      defaultEndpoint: resolved?.defaultEndpoint ?? null,
      optionalApiKey: resolved?.optionalApiKey ?? null,
      requiresApiKey: resolved?.requiresApiKey ?? null,
    }))
  `)

  assert.equal(output.defaultEndpoint, 'http://127.0.0.1:8080/v1')
  assert.equal(output.optionalApiKey, true)
  assert.equal(output.requiresApiKey, false)
})

test('custom provider with uuid-style ID resolves correctly', () => {
  const output = runWithTempDataDir<{
    resolvedName: string | null
    hasHandler: boolean
  }>(`
    const storageModule = await import('@/lib/server/storage')
    const storage = storageModule.default || storageModule
    storage.saveProviderConfigs({
      'custom-d20b934e': {
        id: 'custom-d20b934e',
        name: 'My llama-server',
        type: 'custom',
        baseUrl: 'http://127.0.0.1:8080/v1',
        models: ['llama-3.1-8b'],
        requiresApiKey: false,
        credentialId: null,
        isEnabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    })

    const providersModule = await import('@/lib/providers/index')
    const providers = providersModule.default || providersModule
    const resolved = providers.getProvider('custom-d20b934e')

    console.log(JSON.stringify({
      resolvedName: resolved?.name ?? null,
      hasHandler: typeof resolved?.handler?.streamChat === 'function',
    }))
  `)

  assert.equal(output.resolvedName, 'My llama-server')
  assert.equal(output.hasHandler, true)
})

test('disabled custom providers are not resolved by getProvider', () => {
  const output = runWithTempDataDir<{
    resolved: boolean
  }>(`
    const storageModule = await import('@/lib/server/storage')
    const storage = storageModule.default || storageModule
    storage.saveProviderConfigs({
      'custom-disabled': {
        id: 'custom-disabled',
        name: 'Disabled Provider',
        type: 'custom',
        baseUrl: 'http://127.0.0.1:8080/v1',
        models: ['test'],
        requiresApiKey: false,
        credentialId: null,
        isEnabled: false,
        createdAt: 1,
        updatedAt: 1,
      },
    })

    const providersModule = await import('@/lib/providers/index')
    const providers = providersModule.default || providersModule
    const resolved = providers.getProvider('custom-disabled')

    console.log(JSON.stringify({
      resolved: resolved !== null,
    }))
  `)

  assert.equal(output.resolved, false)
})
