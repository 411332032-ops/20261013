/** 發言速率限制:每 windowMs 毫秒內最多 max 則(預設每 5 秒 3 則) */
export class RateLimiter {
  private stamps: number[] = []

  constructor(
    private readonly max = 3,
    private readonly windowMs = 5000,
  ) {}

  /** 還能送就記一筆並回傳 true;已超速則回傳 false 且不記錄 */
  tryConsume(now = Date.now()): boolean {
    this.stamps = this.stamps.filter((t) => now - t < this.windowMs)
    if (this.stamps.length >= this.max) return false
    this.stamps.push(now)
    return true
  }
}
