import type { ChatService } from '../types'
import { MockChatService } from './MockChatService'

/**
 * 決定使用哪一版聊天服務。
 * 階段一:一律使用模擬版。
 * 階段二:有填 VITE_SUPABASE_URL 時改用 SupabaseChatService(尚未實作)。
 */
export function createChatService(clientId: string): ChatService {
  if (import.meta.env.VITE_SUPABASE_URL) {
    console.warn('已設定 Supabase,但階段二尚未實作,暫時使用模擬版。')
  }
  return new MockChatService(clientId)
}
