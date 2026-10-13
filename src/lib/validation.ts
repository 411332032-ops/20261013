// 代號與訊息內容的檢查規則(docs/architecture.md 9.2)。
// 階段二時,資料庫的 CHECK 規則要和這裡維持相同標準。

export const NICKNAME_MAX = 12
export const CONTENT_MAX = 500
export const MESSAGE_HISTORY_LIMIT = 50

const RESERVED_NICKNAMES = ['系統', '管理員', '管理者', 'admin', 'administrator', 'system']

// 控制字元、零寬字元、雙向文字(RTL/LTR)控制字元。保留換行 \n。
const INVISIBLE =
  /[\u0000-\u0009\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/g

/** 以「字」計算長度,一個 emoji 算一個字 */
export function charLength(text: string): number {
  return Array.from(text).length
}

/** 超過上限時,從尾端截掉多的字 */
export function clampChars(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : chars.slice(0, max).join('')
}

export type NicknameCheck =
  | { ok: true; value: string }
  | { ok: false; reason: 'EMPTY' | 'TOO_LONG' | 'RESERVED' }

export function validateNickname(raw: string): NicknameCheck {
  // 去掉不可見字元,連續空白合併成一個,頭尾去空白
  const value = raw.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim()
  if (value.length === 0) return { ok: false, reason: 'EMPTY' }
  if (charLength(value) > NICKNAME_MAX) return { ok: false, reason: 'TOO_LONG' }
  if (RESERVED_NICKNAMES.includes(value.toLowerCase())) return { ok: false, reason: 'RESERVED' }
  return { ok: true, value }
}

export type ContentCheck =
  | { ok: true; value: string }
  | { ok: false; reason: 'EMPTY' | 'TOO_LONG' }

export function validateContent(raw: string): ContentCheck {
  const value = raw.replace(/\r\n?/g, '\n').replace(INVISIBLE, '').trim()
  if (value.length === 0) return { ok: false, reason: 'EMPTY' }
  if (charLength(value) > CONTENT_MAX) return { ok: false, reason: 'TOO_LONG' }
  return { ok: true, value }
}
