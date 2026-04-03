import { hmrSingleton, errorMessage } from '@/lib/shared-utils'
import type { A2AMethod, A2AMethodHandler, A2AContext, JsonRpcRequest, JsonRpcResponse } from './types'
import { JSON_RPC_ERRORS } from './types'

export class JsonRpcRouter {
  private handlers = new Map<string, A2AMethodHandler>()

  register(method: A2AMethod | string, handler: A2AMethodHandler): void {
    this.handlers.set(method, handler)
  }

  async route(request: JsonRpcRequest, context: A2AContext): Promise<JsonRpcResponse> {
    const handler = this.handlers.get(request.method)
    if (!handler) {
      return {
        jsonrpc: '2.0',
        error: { code: JSON_RPC_ERRORS.METHOD_NOT_FOUND, message: 'Method not found', data: { method: request.method } },
        id: request.id,
      }
    }
    try {
      const result = await handler(request.params ?? {}, context)
      return { jsonrpc: '2.0', result, id: request.id }
    } catch (err) {
      return {
        jsonrpc: '2.0',
        error: { code: JSON_RPC_ERRORS.INTERNAL_ERROR, message: errorMessage(err) },
        id: request.id,
      }
    }
  }

  listMethods(): string[] {
    return [...this.handlers.keys()]
  }
}

export const a2aRouter = hmrSingleton('a2a_jsonrpc_router', () => new JsonRpcRouter())
