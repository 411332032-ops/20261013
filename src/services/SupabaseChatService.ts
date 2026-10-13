import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js'
import { PresenceGrace } from '../lib/presenceGrace'
import { MESSAGE_HISTORY_LIMIT, validateContent, validateNickname } from '../lib/validation'
import type {
  ChatEvents,
  ChatService,
  ConnectionStatus,
  JoinError,
  JoinSuccess,
  Member,
  Message,
  Result,
  SendError,
} from '../types'

// 階段二的真實版聊天服務(docs/architecture.md 5.3)。
// - 聊天室 = Realtime 頻道 `lobby`
// - 在線名單 = 該頻道的 Presence(key 是 clientId)
// - 訊息 = public.messages 資料表,靠 postgres_changes 的 INSERT 通知即時收到
// 遵守和 MockChatService 完全相同的 ChatService 介面。

const CHANNEL_NAME = 'lobby'
const TABLE = 'messages'
const START_TIMEOUT_MS = 10_000
const SETTLE_MS = 300
const TRACK_TIMEOUT_MS = 3000

interface PresenceMeta {
  nickname: string
  joinedAt: number
}

interface MessageRow {
  id: string
  created_at: string
  client_id: string
  nickname: string
  content: string
}

type Listeners = { [K in keyof ChatEvents]: Set<ChatEvents[K]> }

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    createdAt: Date.parse(row.created_at),
    clientId: row.client_id,
    nickname: row.nickname,
    content: row.content,
  }
}

export class SupabaseChatService implements ChatService {
  private readonly supabase: SupabaseClient
  private channel: RealtimeChannel | null = null
  private starting: Promise<void> | null = null
  private listening = false

  private listeners: Listeners = {
    message: new Set(),
    members: new Set(),
    member_joined: new Set(),
    member_left: new Set(),
    status: new Set(),
  }

  /** 其他人(不含自己) */
  private others = new Map<string, Member>()
  private me: Member | null = null
  private seen = new Set<string>()
  private lastCreatedAt = 0
  private status: ConnectionStatus = 'connecting'
  private connected = false
  private browserOnline = true
  private readonly grace = new PresenceGrace({
    joined: (m) => this.emit('member_joined', m),
    left: (m) => this.emit('member_left', m),
  })

  constructor(
    private readonly clientId: string,
    url: string,
    publishableKey: string,
  ) {
    this.supabase = createClient(url, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }

  // ---------- ChatService ----------

  on<K extends keyof ChatEvents>(event: K, handler: ChatEvents[K]): () => void {
    const set = this.listeners[event] as Set<ChatEvents[K]>
    set.add(handler)
    return () => set.delete(handler)
  }

  async getOnlineCount(): Promise<number> {
    await this.ensureStarted()
    return this.others.size + (this.me ? 1 : 0)
  }

  async join(rawNickname: string): Promise<Result<JoinSuccess, JoinError>> {
    const check = validateNickname(rawNickname)
    if (!check.ok) return { ok: false, error: 'INVALID_NICKNAME' }

    try {
      await this.ensureStarted()
    } catch (e) {
      console.error('[chat] 連不上 Supabase Realtime:', e instanceof Error ? e.message : e)
      return { ok: false, error: 'UNAVAILABLE' }
    }
    const nickname = check.value

    if (this.isNicknameTaken(nickname)) return { ok: false, error: 'NICKNAME_TAKEN' }

    const me: Member = { clientId: this.clientId, nickname, joinedAt: Date.now() }
    this.grace.seed([...this.others.values()])
    this.me = me
    // 不等登記完成:Supabase Realtime 在多人幾乎同時登記時,偶爾會讓伺服器端的頻道崩潰,
    // 要卡 10 秒。所以登記放在背景做,卡住就自己重建頻道(見 trackWithRecovery),
    // 使用者不必等。真正連不上時,下面查歷史訊息會失敗而回報 UNAVAILABLE。
    void this.trackWithRecovery(me)

    // 同一瞬間有人用同名進來:等名單同步後再檢查一次,joinedAt 較晚的退出(6.1)
    await sleep(SETTLE_MS)
    if (this.isNicknameTaken(nickname, me)) return this.abortJoin('NICKNAME_TAKEN')

    const history = await this.fetchHistory()
    if (!history) return this.abortJoin('UNAVAILABLE')
    history.forEach((m) => this.remember(m))

    this.setStatus(this.connected ? 'online' : 'reconnecting')
    return { ok: true, value: { history, members: this.memberList() } }
  }

  async send(rawContent: string): Promise<Result<void, SendError>> {
    if (!this.me) return { ok: false, error: 'INVALID_CONTENT' }
    if (!this.connected || !this.browserOnline) return { ok: false, error: 'OFFLINE' }
    const check = validateContent(rawContent)
    if (!check.ok) return { ok: false, error: 'INVALID_CONTENT' }

    // 自己的訊息也等資料庫通知後才顯示(6.2),所以這裡只負責新增
    const { error } = await this.supabase.from(TABLE).insert({
      client_id: this.clientId,
      nickname: this.me.nickname,
      content: check.value,
    })
    if (!error) return { ok: true, value: undefined }
    console.error('[chat] 送出訊息失敗:', error.message, error.code ?? '')
    if (error.message.includes('RATE_LIMITED')) return { ok: false, error: 'RATE_LIMITED' }
    // 23514 = CHECK 規則不通過
    if (error.code === '23514') return { ok: false, error: 'INVALID_CONTENT' }
    return { ok: false, error: 'OFFLINE' }
  }

  leave(): void {
    if (!this.me) return
    this.me = null
    void this.channel?.untrack()
    this.grace.dispose()
    this.setStatus('connecting')
  }

  // ---------- 啟動 ----------

  private ensureStarted(): Promise<void> {
    if (!this.starting) {
      this.starting = this.start().catch((e) => {
        this.starting = null // 失敗了,下次再試
        throw e
      })
    }
    return this.starting
  }

  private start(): Promise<void> {
    this.browserOnline = typeof navigator === 'undefined' ? true : navigator.onLine
    if (!this.listening) {
      this.listening = true
      window.addEventListener('pagehide', this.handlePageHide)
      window.addEventListener('offline', this.handleBrowserOffline)
      window.addEventListener('online', this.handleBrowserOnline)
    }

    const channel = this.supabase.channel(CHANNEL_NAME, {
      config: { presence: { key: this.clientId } },
    })
    this.channel = channel

    return new Promise<void>((resolve, reject) => {
      let subscribed = false
      let synced = false
      const settle = () => {
        if (subscribed && synced) {
          clearTimeout(timer)
          resolve()
        }
      }
      const timer = setTimeout(() => {
        void this.supabase.removeChannel(channel)
        this.channel = null
        reject(new Error('Supabase 連線逾時'))
      }, START_TIMEOUT_MS)

      channel
        .on('presence', { event: 'sync' }, () => {
          this.syncPresence()
          synced = true
          settle()
        })
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: TABLE },
          (payload) => this.deliver(toMessage(payload.new as MessageRow)),
        )
        .subscribe((state) => {
          // 重建頻道時,舊頻道的事件(例如 CLOSED)不能影響新的
          if (this.channel !== channel) return
          if (state === 'SUBSCRIBED') {
            const wasConnected = this.connected
            this.connected = true
            if (!subscribed) {
              subscribed = true
              if (this.me && this.browserOnline) this.setStatus('online')
              settle()
            } else if (!wasConnected) {
              void this.recover()
            }
          } else if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT' || state === 'CLOSED') {
            this.connected = false
            if (this.me) this.setStatus('reconnecting')
          }
        })
    })
  }

  private handlePageHide = () => {
    if (this.me) void this.channel?.untrack()
  }

  private handleBrowserOffline = () => {
    this.browserOnline = false
    if (this.me) this.setStatus('reconnecting')
  }

  private handleBrowserOnline = () => {
    this.browserOnline = true
    if (this.me && this.connected) this.setStatus('online')
  }

  /**
   * 登記在線。3 秒沒有回應就當作頻道卡住:拆掉重建、補上這段期間錯過的訊息,再登記一次。
   * 最多重試 3 次,用掉的時間遠比等伺服器自己恢復(約 10 秒)短。
   */
  private async trackWithRecovery(me: Member): Promise<void> {
    const payload = { nickname: me.nickname, joinedAt: me.joinedAt } satisfies PresenceMeta
    for (let attempt = 0; attempt < 4; attempt++) {
      if (this.me !== me || !this.channel) return
      const result = await this.channel.track(payload, { timeout: TRACK_TIMEOUT_MS })
      if (result === 'ok') return
      if (this.me !== me) return
      console.warn(`[chat] 登記在線沒有回應(${result}),重建頻道,第 ${attempt + 1} 次`)
      try {
        await this.restartChannel()
      } catch (e) {
        console.error('[chat] 重建頻道失敗:', e instanceof Error ? e.message : e)
        return
      }
      const missed = await this.fetchHistory(this.lastCreatedAt)
      missed?.forEach((m) => this.deliver(m))
    }
  }

  private async restartChannel(): Promise<void> {
    const old = this.channel
    this.channel = null
    this.starting = null
    this.connected = false
    if (old) await this.supabase.removeChannel(old)
    await this.ensureStarted()
  }

  /** 斷線後重新連上:重新登記在線、補上錯過的訊息(6.4) */
  private async recover(): Promise<void> {
    const me = this.me
    if (!me || !this.channel) return
    await this.channel.track({ nickname: me.nickname, joinedAt: me.joinedAt } satisfies PresenceMeta)
    const missed = await this.fetchHistory(this.lastCreatedAt)
    missed?.forEach((m) => this.deliver(m))
    if (this.me) this.setStatus(this.browserOnline ? 'online' : 'reconnecting')
  }

  // ---------- 在線名單 ----------

  private syncPresence(): void {
    const state = this.channel?.presenceState<PresenceMeta>() ?? {}
    const next = new Map<string, Member>()
    for (const [key, metas] of Object.entries(state)) {
      const meta = metas[0]
      if (key === this.clientId || !meta) continue
      next.set(key, { clientId: key, nickname: meta.nickname, joinedAt: meta.joinedAt })
    }

    const previous = this.others
    this.others = next
    if (!this.me) return

    for (const member of next.values()) if (!previous.has(member.clientId)) this.grace.joined(member)
    for (const member of previous.values()) if (!next.has(member.clientId)) this.grace.left(member)
    this.emit('members', this.memberList())
  }

  /** 名單裡有「別的 clientId」用同一個代號。傳入 me 時,只有比自己早到的才算佔用 */
  private isNicknameTaken(nickname: string, me?: Member): boolean {
    for (const m of this.others.values()) {
      if (m.nickname !== nickname) continue
      if (!me) return true
      if (m.joinedAt < me.joinedAt || (m.joinedAt === me.joinedAt && m.clientId < me.clientId)) {
        return true
      }
    }
    return false
  }

  private abortJoin(error: JoinError): Result<JoinSuccess, JoinError> {
    this.me = null
    this.grace.dispose()
    void this.channel?.untrack()
    return { ok: false, error }
  }

  private memberList(): Member[] {
    const all = [...this.others.values()]
    if (this.me) all.push(this.me)
    return all.sort((a, b) => a.joinedAt - b.joinedAt)
  }

  // ---------- 訊息 ----------

  /** 查歷史:不帶 since 時取最近 50 則;帶 since 時取該時間之後的全部(補斷線錯過的) */
  private async fetchHistory(since?: number): Promise<Message[] | null> {
    let query = this.supabase.from(TABLE).select('id, created_at, client_id, nickname, content')
    query =
      since === undefined
        ? query.order('created_at', { ascending: false }).limit(MESSAGE_HISTORY_LIMIT)
        : query.gte('created_at', new Date(since).toISOString()).order('created_at', { ascending: true })
    const { data, error } = await query
    if (error || !data) {
      console.error('[chat] 查詢 messages 失敗:', error?.message ?? '沒有資料', error?.code ?? '')
      return null
    }
    const messages = (data as MessageRow[]).map(toMessage)
    return since === undefined ? messages.reverse() : messages
  }

  private remember(message: Message): void {
    this.seen.add(message.id)
    this.lastCreatedAt = Math.max(this.lastCreatedAt, message.createdAt)
  }

  private deliver(message: Message): void {
    if (!this.me || this.seen.has(message.id)) return
    this.remember(message)
    this.emit('message', message)
  }

  // ---------- 事件 ----------

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return
    this.status = status
    this.emit('status', status)
  }

  private emit<K extends keyof ChatEvents>(event: K, ...args: Parameters<ChatEvents[K]>): void {
    for (const handler of this.listeners[event] as Set<(...a: Parameters<ChatEvents[K]>) => void>) {
      handler(...args)
    }
  }
}
