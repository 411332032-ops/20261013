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
// - 訊息:public.messages 資料表。新訊息靠 Realtime 的 INSERT 通知即時收到,
//   另外每 6 秒輪詢一次當保險,Realtime 暫時有狀況時訊息也不會漏。
// - 在線名單:public.presence 資料表 + 心跳。每 3 秒呼叫一次 chat_tick,
//   同時更新自己的「最後在線時間」並取回名單;15 秒沒更新就算離開。
//   不使用 Realtime Presence(多人同時進入時,伺服器端的頻道偶爾會崩潰)。
// 遵守和 MockChatService 完全相同的 ChatService 介面。

const CHANNEL_NAME = 'lobby'
const TABLE = 'messages'
const TICK_MS = 3000
const POLL_MESSAGES_EVERY_TICKS = 2
/** 連續失敗幾次才當作斷線,避免偶爾一次失敗就跳出斷線提示 */
const FAILURE_LIMIT = 2

interface MessageRow {
  id: string
  created_at: string
  client_id: string
  nickname: string
  content: string
  reply_to: string | null
  reply_nickname: string | null
  reply_excerpt: string | null
}

const MESSAGE_COLUMNS =
  'id, created_at, client_id, nickname, content, reply_to, reply_nickname, reply_excerpt'

interface MemberRow {
  cid: string
  nick: string
  joined_ms: number
}

type Listeners = { [K in keyof ChatEvents]: Set<ChatEvents[K]> }

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    createdAt: Date.parse(row.created_at),
    clientId: row.client_id,
    nickname: row.nickname,
    content: row.content,
    // 引用的代號與摘要是資料庫依原訊息填的;原訊息被清除後 reply_to 會是 null,但摘要還在
    replyTo:
      row.reply_nickname !== null
        ? { id: row.reply_to, nickname: row.reply_nickname, excerpt: row.reply_excerpt ?? '' }
        : undefined,
  }
}

export class SupabaseChatService implements ChatService {
  private readonly supabase: SupabaseClient
  private channel: RealtimeChannel | null = null
  private channelWasDown = false
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
  private browserOnline = true
  private failures = 0
  private ticking = false
  private tickCount = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly grace = new PresenceGrace({
    joined: (m) => this.emit('member_joined', m),
    left: (m) => this.emit('member_left', m),
  })

  constructor(
    private readonly clientId: string,
    private readonly url: string,
    private readonly publishableKey: string,
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
    // 空的 clientId:只讀名單,不會登記任何人
    return (await this.fetchMembers('')).length
  }

  async join(rawNickname: string): Promise<Result<JoinSuccess, JoinError>> {
    const check = validateNickname(rawNickname)
    if (!check.ok) return { ok: false, error: 'INVALID_NICKNAME' }
    const nickname = check.value

    // 代號是否重複,由資料庫判斷(同一瞬間同名進入也會排隊,只有一個成功)
    const { error } = await this.supabase.rpc('join_chat', {
      p_client_id: this.clientId,
      p_nickname: nickname,
    })
    if (error) {
      if (error.message.includes('NICKNAME_TAKEN')) return { ok: false, error: 'NICKNAME_TAKEN' }
      // 23514 = CHECK 規則不通過(保留字、隱形字元等)
      if (error.code === '23514') return { ok: false, error: 'INVALID_NICKNAME' }
      console.error('[chat] 登記代號失敗:', error.message, error.code ?? '')
      return { ok: false, error: 'UNAVAILABLE' }
    }

    let members: Member[]
    try {
      members = await this.fetchMembers(this.clientId)
    } catch (e) {
      console.error('[chat] 取得在線名單失敗:', e instanceof Error ? e.message : e)
      this.dropMe()
      return { ok: false, error: 'UNAVAILABLE' }
    }

    const mine = members.find((m) => m.clientId === this.clientId)
    const me: Member = { clientId: this.clientId, nickname, joinedAt: mine?.joinedAt ?? Date.now() }
    this.others = new Map(
      members.filter((m) => m.clientId !== this.clientId).map((m) => [m.clientId, m]),
    )
    this.grace.seed([...this.others.values()])
    this.me = me

    this.startChannel()
    const history = await this.fetchHistory()
    if (!history) {
      this.dropMe()
      return { ok: false, error: 'UNAVAILABLE' }
    }
    history.forEach((m) => this.remember(m))

    this.failures = 0
    this.tickCount = 0
    this.startTimer()
    this.setStatus(this.browserOnline ? 'online' : 'reconnecting')
    return { ok: true, value: { history, members: this.memberList() } }
  }

  async send(rawContent: string, replyToId?: string): Promise<Result<void, SendError>> {
    if (!this.me) return { ok: false, error: 'INVALID_CONTENT' }
    if (this.status !== 'online') return { ok: false, error: 'OFFLINE' }
    const check = validateContent(rawContent)
    if (!check.ok) return { ok: false, error: 'INVALID_CONTENT' }

    // 資料庫寫入成功才顯示(6.2:畫面上看到 = 確定已存進去)。
    // 直接用寫入的回傳結果顯示,不必等 Realtime 通知;之後收到通知時以 id 去重。
    const { data, error } = await this.supabase
      .from(TABLE)
      .insert({
        client_id: this.clientId,
        nickname: this.me.nickname,
        content: check.value,
        reply_to: replyToId ?? null,
      })
      .select(MESSAGE_COLUMNS)
      .single()
    if (!error && data) {
      this.deliver(toMessage(data as MessageRow))
      return { ok: true, value: undefined }
    }
    const message = error?.message ?? ''
    console.error('[chat] 送出訊息失敗:', message, error?.code ?? '')
    if (message.includes('RATE_LIMITED')) return { ok: false, error: 'RATE_LIMITED' }
    // 23514 = CHECK 規則不通過
    if (error?.code === '23514') return { ok: false, error: 'INVALID_CONTENT' }
    return { ok: false, error: 'OFFLINE' }
  }

  leave(): void {
    if (!this.me) return
    // supabase-js 的請求要有人 await 或 then 才會真的送出,所以不能只寫 void
    this.supabase
      .rpc('leave_chat', { p_client_id: this.clientId })
      .then(undefined, (e: unknown) => console.warn('[chat] 離開通知失敗:', e))
    this.dropMe()
    this.setStatus('connecting')
  }

  // ---------- 心跳與名單 ----------

  private startTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    if (!this.listening) {
      this.listening = true
      window.addEventListener('pagehide', this.handlePageHide)
      window.addEventListener('offline', this.handleBrowserOffline)
      window.addEventListener('online', this.handleBrowserOnline)
      document.addEventListener('visibilitychange', this.handleVisible)
    }
  }

  /** 停止心跳、關掉訊息頻道、清掉自己的狀態 */
  private dropMe(): void {
    this.me = null
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.grace.dispose()
    this.others.clear()
    if (this.channel) void this.supabase.removeChannel(this.channel)
    this.channel = null
  }

  private async tick(): Promise<void> {
    if (!this.me || this.ticking) return
    this.ticking = true
    try {
      const members = await this.fetchMembers(this.clientId)
      const recovering = this.failures > 0
      this.failures = 0
      if (!members.some((m) => m.clientId === this.clientId)) await this.reregister()
      this.applyRoster(members)
      this.tickCount++
      if (recovering || this.tickCount % POLL_MESSAGES_EVERY_TICKS === 0) await this.backfill()
    } catch (e) {
      this.failures++
      console.warn('[chat] 心跳失敗:', e instanceof Error ? e.message : e)
    } finally {
      this.ticking = false
      this.refreshStatus()
    }
  }

  /**
   * 名單裡找不到自己(例如手機切到背景時 pagehide 通知過離開):重新登記一次。
   * 代號剛好被別人佔走的話只記錄,不打斷使用中的畫面。
   */
  private async reregister(): Promise<void> {
    if (!this.me) return
    const { error } = await this.supabase.rpc('join_chat', {
      p_client_id: this.clientId,
      p_nickname: this.me.nickname,
    })
    if (error) console.warn('[chat] 重新登記失敗:', error.message)
  }

  private async fetchMembers(clientId: string): Promise<Member[]> {
    const { data, error } = await this.supabase.rpc('chat_tick', { p_client_id: clientId })
    if (error) throw new Error(error.message)
    return ((data ?? []) as MemberRow[]).map((r) => ({
      clientId: r.cid,
      nickname: r.nick,
      joinedAt: Number(r.joined_ms),
    }))
  }

  private applyRoster(members: Member[]): void {
    const next = new Map<string, Member>()
    for (const m of members) if (m.clientId !== this.clientId) next.set(m.clientId, m)

    const previous = this.others
    this.others = next
    if (!this.me) return

    for (const m of next.values()) if (!previous.has(m.clientId)) this.grace.joined(m)
    for (const m of previous.values()) if (!next.has(m.clientId)) this.grace.left(m)
    if (next.size !== previous.size || [...next.keys()].some((k) => !previous.has(k))) {
      this.emit('members', this.memberList())
    }
  }

  private memberList(): Member[] {
    const all = [...this.others.values()]
    if (this.me) all.push(this.me)
    return all.sort((a, b) => a.joinedAt - b.joinedAt)
  }

  private refreshStatus(): void {
    if (!this.me) return
    const healthy = this.failures < FAILURE_LIMIT && this.browserOnline
    this.setStatus(healthy ? 'online' : 'reconnecting')
  }

  // ---------- 瀏覽器事件 ----------

  private handlePageHide = () => {
    if (!this.me) return
    // 頁面正在關閉:用 keepalive 的 fetch 通知伺服器,關掉後請求仍會送出。
    // 來不及也沒關係,15 秒沒心跳名單就會自動移除。
    void fetch(`${this.url}/rest/v1/rpc/leave_chat`, {
      method: 'POST',
      keepalive: true,
      headers: { apikey: this.publishableKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_client_id: this.clientId }),
    }).catch(() => undefined)
  }

  private handleBrowserOffline = () => {
    this.browserOnline = false
    this.refreshStatus()
  }

  private handleBrowserOnline = () => {
    this.browserOnline = true
    void this.tick()
  }

  /** 手機切回 App、分頁切回前景:立刻心跳一次,不要等下一個 3 秒 */
  private handleVisible = () => {
    if (!document.hidden) void this.tick()
  }

  // ---------- 訊息 ----------

  private startChannel(): void {
    if (this.channel) return
    const channel = this.supabase
      .channel(CHANNEL_NAME)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: TABLE }, (payload) =>
        this.deliver(toMessage(payload.new as MessageRow)),
      )
    channel.subscribe((state) => {
      if (this.channel !== channel) return
      if (state === 'SUBSCRIBED' && this.channelWasDown) {
        this.channelWasDown = false
        void this.backfill()
      } else if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT' || state === 'CLOSED') {
        // 不影響狀態條:送訊息和輪詢都不靠這條頻道,只是新訊息可能晚幾秒
        this.channelWasDown = true
      }
    })
    this.channel = channel
  }

  /** 補上「畫面上最後一則」之後的訊息(重複的以 id 去掉) */
  private async backfill(): Promise<void> {
    const missed = await this.fetchHistory(this.lastCreatedAt)
    missed?.forEach((m) => this.deliver(m))
  }

  /** 查歷史:不帶 since 時取最近 50 則;帶 since 時取該時間之後的全部 */
  private async fetchHistory(since?: number): Promise<Message[] | null> {
    let query = this.supabase.from(TABLE).select(MESSAGE_COLUMNS)
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
