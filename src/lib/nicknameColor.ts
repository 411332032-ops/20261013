const PALETTE_SIZE = 8

/** 依代號決定固定顏色。同一個代號永遠對應同一個 CSS 變數(--c1 到 --c8) */
export function nicknameColor(nickname: string): string {
  let hash = 5381
  for (let i = 0; i < nickname.length; i++) {
    hash = ((hash << 5) + hash + nickname.charCodeAt(i)) | 0
  }
  return `var(--c${(Math.abs(hash) % PALETTE_SIZE) + 1})`
}

/** 頭像圓圈裡顯示的字:代號的第一個字(emoji 也算一個) */
export function nicknameInitial(nickname: string): string {
  return Array.from(nickname)[0] ?? '?'
}
