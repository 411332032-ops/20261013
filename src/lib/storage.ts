// localStorage / sessionStorage 在無痕視窗等情況可能丟出錯誤,所以每次讀寫都包 try/catch。

const NICKNAME_KEY = 'chat.nickname'
const CLIENT_ID_KEY = 'chat.clientId'

function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function newId(): string {
  return makeId()
}

/**
 * 這個分頁的隨機識別碼。存在 sessionStorage:
 * 重新整理後保持不變(所以不會被自己的殘影擋住),但每個分頁都是不同的「人」。
 */
export function getClientId(): string {
  try {
    const existing = sessionStorage.getItem(CLIENT_ID_KEY)
    if (existing) return existing
    const created = makeId()
    sessionStorage.setItem(CLIENT_ID_KEY, created)
    return created
  } catch {
    return makeId()
  }
}

export function getSavedNickname(): string {
  try {
    return localStorage.getItem(NICKNAME_KEY) ?? ''
  } catch {
    return ''
  }
}

export function saveNickname(nickname: string): void {
  try {
    localStorage.setItem(NICKNAME_KEY, nickname)
  } catch {
    // 存不了就算了,下次重新輸入
  }
}
