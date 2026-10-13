import type { ChatService } from '../types'
import { MockChatService } from './MockChatService'
import { SupabaseChatService } from './SupabaseChatService'

/**
 * 決定使用哪一版聊天服務(docs/architecture.md 第 8 章)。
 * 有填 VITE_SUPABASE_URL 與 VITE_SUPABASE_PUBLISHABLE_KEY:使用 Supabase 真實版。
 * 沒填:使用模擬版。
 */
export function createChatService(clientId: string): ChatService {
  const url = import.meta.env.VITE_SUPABASE_URL
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
  if (url && key) return new SupabaseChatService(clientId, url, key)
  if (url || key) {
    console.warn('Supabase 設定不完整(網址與公開金鑰都要填),暫時使用模擬版。')
  }
  return new MockChatService(clientId)
}
