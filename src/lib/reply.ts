// 回覆/引用用的小工具。資料庫觸發器產生摘要的規則和這裡一致(空白合併、取前 80 字)。

export const EXCERPT_MAX = 80

/** 引用時顯示的摘要:連續空白或換行合併成一個空白,最多 80 字 */
export function makeExcerpt(content: string): string {
  return Array.from(content.replace(/\s+/g, ' ').trim())
    .slice(0, EXCERPT_MAX)
    .join('')
}
