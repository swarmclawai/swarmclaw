import type { Chatroom } from '@/types'

import {
  loadChatroom as loadStoredChatroom,
  loadChatrooms as loadStoredChatrooms,
  saveChatrooms as saveStoredChatrooms,
  upsertChatroom as upsertStoredChatroom,
} from '@/lib/server/storage'
import { createRecordRepository } from '@/lib/server/persistence/repository-utils'

export const chatroomRepository = createRecordRepository<Chatroom>(
  'chatrooms',
  {
    get(id) {
      return loadStoredChatroom(id) as Chatroom | null
    },
    list() {
      return loadStoredChatrooms() as Record<string, Chatroom>
    },
    upsert(id, value) {
      upsertStoredChatroom(id, value as Chatroom)
    },
    replace(data) {
      saveStoredChatrooms(data)
    },
  },
)

export const loadChatrooms = () => chatroomRepository.list()
export const loadChatroom = (id: string) => chatroomRepository.get(id)
export const saveChatrooms = (items: Record<string, Chatroom | Record<string, unknown>>) => chatroomRepository.replace(items as Record<string, Chatroom>)
export const upsertChatroom = (id: string, value: Chatroom | Record<string, unknown>) => chatroomRepository.upsert(id, value as Chatroom)
