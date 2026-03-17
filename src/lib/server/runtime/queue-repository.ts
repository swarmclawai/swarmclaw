import { loadQueue as loadStoredQueue, saveQueue as saveStoredQueue } from '@/lib/server/storage'
import { createSingletonRepository } from '@/lib/server/persistence/repository-utils'

export const queueRepository = createSingletonRepository<string[], string[]>(
  'queue',
  {
    get() {
      return loadStoredQueue()
    },
    save(value) {
      saveStoredQueue(value)
    },
  },
)

export const loadQueue = () => queueRepository.get()
export const saveQueue = (queue: string[]) => queueRepository.save(queue)
