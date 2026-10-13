export type Segment = { type: 'text'; text: string } | { type: 'link'; text: string; href: string }

const URL_PATTERN = /https?:\/\/[^\s<>"']+/g
// 網址尾端常黏著的標點,不算在連結裡
const TRAILING = /[.,!?;:)\]}。,!?;:)」』】]+$/

/**
 * 把文字拆成「純文字」與「連結」片段。
 * 只有 http:// 與 https:// 會變連結;畫面以元件渲染,不拼 HTML 字串。
 */
export function linkify(content: string): Segment[] {
  const segments: Segment[] = []
  let last = 0

  for (const match of content.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0
    const raw = match[0]
    const trimmed = raw.replace(TRAILING, '')
    if (!isSafeUrl(trimmed)) continue

    if (start > last) segments.push({ type: 'text', text: content.slice(last, start) })
    segments.push({ type: 'link', text: trimmed, href: trimmed })
    last = start + trimmed.length
  }

  if (last < content.length) segments.push({ type: 'text', text: content.slice(last) })
  return segments
}

function isSafeUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
