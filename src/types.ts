// 通訊約定,對應 docs/architecture.md 第 5 章。
// 階段一的模擬版與階段二的 Supabase 版都必須遵守這份約定。

export interface Message {
  id: string
  /** 送出時間(毫秒)。階段二由資料庫以伺服器時間填入 */
  createdAt: number
  /** 這個分頁的隨機識別碼,不是登入身分 */
  clientId: string
  nickname: string
  content: string
  /** 回覆/引用:被回覆那則的資訊。代號與摘要在階段二由資料庫依原訊息填入 */
  replyTo?: ReplyRef
}

export interface ReplyRef {
  /** 原訊息的 id。原訊息已被清除時為 null,但代號與摘要仍保留 */
  id: string | null
  nickname: string
  excerpt: string
}

export interface Member {
  clientId: string
  nickname: string
  joinedAt: number
}

export type ConnectionStatus = 'connecting' | 'online' | 'reconnecting'

export type JoinError = 'NICKNAME_TAKEN' | 'INVALID_NICKNAME' | 'UNAVAILABLE'
export type SendError = 'INVALID_CONTENT' | 'RATE_LIMITED' | 'OFFLINE'

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }

export interface JoinSuccess {
  /** 最近 50 則,舊的在前 */
  history: Message[]
  members: Member[]
}

/** 聊天服務會發出的事件 */
export interface ChatEvents {
  message: (message: Message) => void
  members: (members: Member[]) => void
  member_joined: (member: Member) => void
  member_left: (member: Member) => void
  status: (status: ConnectionStatus) => void
}

/**
 * 聊天服務介面。畫面只認這份介面,不知道背後是模擬版還是 Supabase。
 */
export interface ChatService {
  /** 進入畫面顯示的「目前 N 人在線」 */
  getOnlineCount(): Promise<number>
  join(nickname: string): Promise<Result<JoinSuccess, JoinError>>
  /** replyToId:要回覆的那則訊息的 id(可省略) */
  send(content: string, replyToId?: string): Promise<Result<void, SendError>>
  leave(): void
  /** 訂閱事件,回傳取消訂閱的函式 */
  on<K extends keyof ChatEvents>(event: K, handler: ChatEvents[K]): () => void
}

/** 聊天室裡的一列:一則訊息,或一行系統提示 */
export type ChatItem =
  | { kind: 'message'; key: string; message: Message }
  | { kind: 'system'; key: string; text: string; at: number }
