import type { Member } from '../types'

/**
 * 加入/離開提示的「10 秒寬限」(docs/architecture.md 6.3)。
 * 有人離開後,若同一個 clientId 在寬限時間內又回來(重新整理、手機切換 App),
 * 就不顯示任何提示。階段一的模擬版與階段二的 Supabase 版共用這個邏輯。
 */
export class PresenceGrace {
  private pending = new Map<string, ReturnType<typeof setTimeout>>()
  private known = new Set<string>()

  constructor(
    private readonly emit: { joined: (m: Member) => void; left: (m: Member) => void },
    private readonly graceMs = 10_000,
  ) {}

  /** 進入聊天室時,把已經在線的人記下來(不為他們顯示「加入」) */
  seed(members: Member[]): void {
    for (const m of members) this.known.add(m.clientId)
  }

  joined(member: Member): void {
    const timer = this.pending.get(member.clientId)
    if (timer !== undefined) {
      // 寬限時間內回來:安靜地接回去
      clearTimeout(timer)
      this.pending.delete(member.clientId)
      return
    }
    if (this.known.has(member.clientId)) return
    this.known.add(member.clientId)
    this.emit.joined(member)
  }

  left(member: Member): void {
    if (!this.known.has(member.clientId) || this.pending.has(member.clientId)) return
    const timer = setTimeout(() => {
      this.pending.delete(member.clientId)
      this.known.delete(member.clientId)
      this.emit.left(member)
    }, this.graceMs)
    this.pending.set(member.clientId, timer)
  }

  dispose(): void {
    for (const timer of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
    this.known.clear()
  }
}
