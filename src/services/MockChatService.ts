import { PresenceGrace } from '../lib/presenceGrace'
import { RateLimiter } from '../lib/rateLimit'
import { makeExcerpt } from '../lib/reply'
import { newId } from '../lib/storage'
import {
  MESSAGE_HISTORY_LIMIT,
  validateContent,
  validateNickname,
} from '../lib/validation'
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

// 階段一的模擬版聊天服務。
// - 同一個瀏覽器的不同分頁,用 BroadcastChannel 互相傳訊,所以開兩個分頁就能自己扮演兩個人。
// - 另外有幾個「機器人使用者」會進出、說話。機器人只由其中一個分頁(leader)負責,
//   再廣播給其他分頁,這樣每個分頁看到的是同一個聊天室。
// - 訊息存在 localStorage,保留 7 天、載入最近 50 則。

const CHANNEL_NAME = 'anon-chat-mock-v1'
const LEADER_KEY = 'anon-chat-mock-leader'
const HISTORY_KEY = 'anon-chat-mock-history'
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const LEADER_TTL_MS = 5000

const BOT_NAMES = [
  'Momo',
  '星星🌟',
  '夜貓',
  '小周',
  '小花',
  'Ray',
  'Bella',
  '咖啡不加糖',
  'Andy',
  '🐱🐱',
  '路人甲',
]

const BOT_LINES = [
  '早安!今天第一個到 ☀️',
  '有人要一起討論下週的活動嗎?',
  '我週六可以 👍',
  '先看看這個 https://example.com/map',
  '哈哈哈這個太好笑了',
  '午餐大家都吃什麼?',
  '我剛剛看到一隻超肥的貓 🐱',
  '地點還沒決定,大家有什麼想法都可以說\n我這邊可以訂位',
  '下午兩點 OK',
  '好像要下雨了,記得帶傘 ☔',
  '有人看過這部嗎?最近好多人在推薦',
  '收到!',
  '推薦一個工具給大家 https://example.com/tools',
  '剛下班,終於可以放鬆了',
  '晚點再說,我先去忙一下',
]

type Wire =
  | { t: 'msg'; m: Message }
  | { t: 'hello'; member: Member }
  | { t: 'bye'; clientId: string }
  | { t: 'whois' }
  | { t: 'bots'; members: Member[] }

type Listeners = { [K in keyof ChatEvents]: Set<ChatEvents[K]> }

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const rand = (min: number, max: number) => min + Math.random() * (max - min)
const pick = <T,>(list: T[]): T => list[Math.floor(Math.random() * list.length)]

export class MockChatService implements ChatService {
  private readonly tabId = newId()
  private channel: BroadcastChannel | null = null
  private starting: Promise<void> | null = null

  private listeners: Listeners = {
    message: new Set(),
    members: new Set(),
    member_joined: new Set(),
    member_left: new Set(),
    status: new Set(),
  }

  /** 其他人(真人分頁 + 機器人) */
  private roster = new Map<string, Member>()
  private me: Member | null = null
  private seen = new Set<string>()
  private status: ConnectionStatus = 'connecting'
  private offline = false
  private offlineBuffer: Message[] = []
  private readonly limiter = new RateLimiter()
  private readonly grace = new PresenceGrace({
    joined: (m) => this.emit('member_joined', m),
    left: (m) => this.emit('member_left', m),
  })

  private isLeader = false
  private bots = new Map<string, Member>()
  private timers: ReturnType<typeof setTimeout>[] = []

  constructor(private readonly clientId: string) {}

  // ---------- ChatService ----------

  on<K extends keyof ChatEvents>(event: K, handler: ChatEvents[K]): () => void {
    const set = this.listeners[event] as Set<ChatEvents[K]>
    set.add(handler)
    return () => set.delete(handler)
  }

  async getOnlineCount(): Promise<number> {
    await this.ensureStarted()
    return this.roster.size + (this.me ? 1 : 0)
  }

  async join(rawNickname: string): Promise<Result<JoinSuccess, JoinError>> {
    const check = validateNickname(rawNickname)
    if (!check.ok) return { ok: false, error: 'INVALID_NICKNAME' }

    await this.ensureStarted()
    // 再問一次現在有誰在線,避免用到剛進來的人的代號
    this.post({ t: 'whois' })
    await sleep(250)

    for (const member of this.roster.values()) {
      if (member.nickname === check.value && member.clientId !== this.clientId) {
        return { ok: false, error: 'NICKNAME_TAKEN' }
      }
    }

    this.me = { clientId: this.clientId, nickname: check.value, joinedAt: Date.now() }
    this.grace.seed([...this.roster.values()])
    this.post({ t: 'hello', member: this.me })

    if (this.isLeader && this.loadHistory().length === 0) this.seedHistory()

    const history = this.loadHistory().slice(-MESSAGE_HISTORY_LIMIT)
    history.forEach((m) => this.seen.add(m.id))

    this.setStatus(this.offline ? 'reconnecting' : 'online')
    this.maybeSimulateOutage()

    return { ok: true, value: { history, members: this.memberList() } }
  }

  async send(rawContent: string, replyToId?: string): Promise<Result<void, SendError>> {
    if (this.offline) return { ok: false, error: 'OFFLINE' }
    const check = validateContent(rawContent)
    if (!check.ok || !this.me) return { ok: false, error: 'INVALID_CONTENT' }
    // 模擬資料庫端的速率限制
    if (!this.limiter.tryConsume()) return { ok: false, error: 'RATE_LIMITED' }

    const message: Message = {
      id: newId(),
      createdAt: Date.now(),
      clientId: this.clientId,
      nickname: this.me.nickname,
      content: check.value,
    }
    // 回覆:摘要由「原訊息」決定,不採用使用者給的文字(和資料庫觸發器的做法一致)
    const original = replyToId ? this.loadHistory().find((m) => m.id === replyToId) : undefined
    if (original) {
      message.replyTo = {
        id: original.id,
        nickname: original.nickname,
        excerpt: makeExcerpt(original.content),
      }
    }
    this.saveMessage(message)
    this.post({ t: 'msg', m: message })
    this.deliver(message)
    return { ok: true, value: undefined }
  }

  leave(): void {
    if (!this.me) return
    this.post({ t: 'bye', clientId: this.clientId })
    this.me = null
    this.grace.dispose()
    this.offlineBuffer = []
    this.setStatus('connecting')
  }

  // ---------- 啟動 ----------

  private ensureStarted(): Promise<void> {
    if (!this.starting) this.starting = this.start()
    return this.starting
  }

  private async start(): Promise<void> {
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(CHANNEL_NAME)
      this.channel.onmessage = (e: MessageEvent<Wire>) => this.handleWire(e.data)
    }

    window.addEventListener('pagehide', this.handlePageHide)
    window.addEventListener('offline', this.goOffline)
    window.addEventListener('online', this.goOnline)
    if (!navigator.onLine) this.goOffline()

    this.tryBecomeLeader()
    setInterval(() => this.tryBecomeLeader(), 2000)

    this.post({ t: 'whois' })
    await sleep(350)
  }

  private handlePageHide = () => {
    if (this.me) this.post({ t: 'bye', clientId: this.clientId })
    if (this.isLeader) {
      try {
        localStorage.removeItem(LEADER_KEY)
      } catch {
        // 忽略
      }
    }
  }

  // ---------- 領頭分頁與機器人 ----------

  private tryBecomeLeader(): void {
    try {
      const now = Date.now()
      const raw = localStorage.getItem(LEADER_KEY)
      const current = raw ? (JSON.parse(raw) as { id: string; at: number }) : null
      const mine = current?.id === this.tabId
      const stale = !current || now - current.at > LEADER_TTL_MS
      if (mine || stale) {
        localStorage.setItem(LEADER_KEY, JSON.stringify({ id: this.tabId, at: now }))
        if (!this.isLeader) {
          this.isLeader = true
          this.startBots()
        }
      } else if (this.isLeader) {
        this.isLeader = false
        this.stopBots()
      }
    } catch {
      // localStorage 不能用:當作自己是唯一的分頁
      if (!this.isLeader) {
        this.isLeader = true
        this.startBots()
      }
    }
  }

  private startBots(): void {
    // 接手前一位領頭分頁留下的機器人,沒有的話重新挑幾個
    for (const member of this.roster.values()) {
      if (member.clientId.startsWith('bot-')) this.bots.set(member.clientId, member)
    }
    if (this.bots.size === 0) {
      const names = [...BOT_NAMES].sort(() => Math.random() - 0.5).slice(0, 7)
      names.forEach((name, i) => {
        const bot = this.makeBot(name, Date.now() - (i + 1) * 120_000)
        this.bots.set(bot.clientId, bot)
        this.roster.set(bot.clientId, bot)
      })
      this.emitMembers()
    }
    this.scheduleTalk()
    this.scheduleChurn()
  }

  private stopBots(): void {
    this.timers.forEach(clearTimeout)
    this.timers = []
    this.bots.clear()
  }

  private makeBot(name: string, joinedAt: number): Member {
    return { clientId: `bot-${name}`, nickname: name, joinedAt }
  }

  private later(fn: () => void, ms: number): void {
    const timer = setTimeout(() => {
      this.timers = this.timers.filter((t) => t !== timer)
      if (this.isLeader) fn()
    }, ms)
    this.timers.push(timer)
  }

  private scheduleTalk(): void {
    this.later(() => {
      const speaker = pick([...this.bots.values()])
      if (speaker) {
        const message: Message = {
          id: newId(),
          createdAt: Date.now(),
          clientId: speaker.clientId,
          nickname: speaker.nickname,
          content: pick(BOT_LINES),
        }
        this.saveMessage(message)
        this.post({ t: 'msg', m: message })
        this.deliver(message)
      }
      this.scheduleTalk()
    }, rand(6000, 14000))
  }

  private scheduleChurn(): void {
    this.later(() => {
      const offlineNames = BOT_NAMES.filter((n) => !this.bots.has(`bot-${n}`))
      const shouldLeave = this.bots.size > 5 && (offlineNames.length === 0 || Math.random() < 0.5)
      if (shouldLeave) {
        const leaving = pick([...this.bots.values()])
        this.bots.delete(leaving.clientId)
        this.removeMember(leaving.clientId)
        this.post({ t: 'bye', clientId: leaving.clientId })
      } else if (offlineNames.length > 0) {
        const bot = this.makeBot(pick(offlineNames), Date.now())
        this.bots.set(bot.clientId, bot)
        this.addMember(bot)
        this.post({ t: 'hello', member: bot })
      }
      this.scheduleChurn()
    }, rand(25000, 45000))
  }

  // ---------- 收發 ----------

  private post(wire: Wire): void {
    this.channel?.postMessage(wire)
  }

  private handleWire(wire: Wire): void {
    switch (wire.t) {
      case 'msg':
        this.deliver(wire.m)
        break
      case 'hello':
        if (wire.member.clientId !== this.clientId) this.addMember(wire.member)
        break
      case 'bye':
        this.removeMember(wire.clientId)
        break
      case 'bots':
        wire.members.forEach((m) => this.addMember(m))
        break
      case 'whois':
        if (this.me) this.post({ t: 'hello', member: this.me })
        if (this.isLeader && this.bots.size > 0) {
          this.post({ t: 'bots', members: [...this.bots.values()] })
        }
        break
    }
  }

  private addMember(member: Member): void {
    if (member.clientId === this.clientId) return
    const existed = this.roster.has(member.clientId)
    this.roster.set(member.clientId, member)
    if (this.me) this.grace.joined(member)
    if (!existed || this.me) this.emitMembers()
  }

  private removeMember(clientId: string): void {
    const member = this.roster.get(clientId)
    if (!member) return
    this.roster.delete(clientId)
    if (this.me) this.grace.left(member)
    this.emitMembers()
  }

  /** 收到一則訊息(自己送的、別人的、機器人的都走這裡) */
  private deliver(message: Message): void {
    if (this.seen.has(message.id)) return
    if (!this.me) return
    if (this.offline) {
      this.offlineBuffer.push(message)
      return
    }
    this.seen.add(message.id)
    this.emit('message', message)
  }

  // ---------- 斷線模擬 ----------
  // 真的把瀏覽器切到離線(開發人員工具 → Network → Offline),或在網址加 ?simulate=offline

  private goOffline = () => {
    if (this.offline) return
    this.offline = true
    if (this.me) this.setStatus('reconnecting')
  }

  private goOnline = () => {
    if (!this.offline) return
    setTimeout(() => {
      this.offline = false
      // 補上斷線期間錯過的訊息
      const missed = this.offlineBuffer
      this.offlineBuffer = []
      for (const m of missed) {
        if (this.seen.has(m.id)) continue
        this.seen.add(m.id)
        this.emit('message', m)
      }
      if (this.me) this.setStatus('online')
    }, 1200)
  }

  private maybeSimulateOutage(): void {
    if (new URLSearchParams(window.location.search).get('simulate') !== 'offline') return
    setTimeout(() => this.goOffline(), 3000)
    setTimeout(() => this.goOnline(), 15000)
  }

  // ---------- 儲存 ----------

  private loadHistory(): Message[] {
    try {
      const raw = localStorage.getItem(HISTORY_KEY)
      const all = raw ? (JSON.parse(raw) as Message[]) : []
      const cutoff = Date.now() - RETENTION_MS
      return all.filter((m) => m.createdAt >= cutoff).sort((a, b) => a.createdAt - b.createdAt)
    } catch {
      return []
    }
  }

  private saveMessage(message: Message): void {
    try {
      const next = [...this.loadHistory(), message].slice(-200)
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
    } catch {
      // 存不了就只留在記憶體裡
    }
  }

  /** 第一次使用時放幾則較早的訊息,讓畫面有內容、也看得到日期分隔線 */
  private seedHistory(): void {
    const now = Date.now()
    const day = 24 * 60 * 60 * 1000
    const lines: [string, number, string][] = [
      ['阿傑', now - day - 3 * 3600_000, '有人還沒睡嗎?'],
      ['夜貓', now - day - 3 * 3600_000 + 120_000, '我在,剛看完一部電影 🎬'],
      ['阿傑', now - day - 3 * 3600_000 + 300_000, '哪一部?推薦一下'],
      ['Momo', now - 2 * 3600_000, '早安!今天第一個到 ☀️'],
      ['星星🌟', now - 2 * 3600_000 + 60_000, '我也剛到,昨天推薦的那個網站在這裡 https://example.com/tools'],
      ['小周', now - 3600_000, '有人要一起討論下週的活動嗎?'],
    ]
    for (const [nickname, createdAt, content] of lines) {
      this.saveMessage({
        id: newId(),
        createdAt,
        clientId: `bot-${nickname}`,
        nickname,
        content,
      })
    }
  }

  // ---------- 事件 ----------

  private memberList(): Member[] {
    const all = [...this.roster.values()]
    if (this.me) all.push(this.me)
    return all.sort((a, b) => a.joinedAt - b.joinedAt)
  }

  private emitMembers(): void {
    if (this.me) this.emit('members', this.memberList())
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return
    this.status = status
    this.emit('status', status)
  }

  private emit<K extends keyof ChatEvents>(event: K, ...args: Parameters<ChatEvents[K]>): void {
    const set = this.listeners[event] as Set<(...a: Parameters<ChatEvents[K]>) => void>
    for (const handler of [...set]) handler(...args)
  }
}
