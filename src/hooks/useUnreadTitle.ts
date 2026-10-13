import { useEffect, useRef } from 'react'
import type { ChatItem } from '../types'

export const BASE_TITLE = '匿名聊天室'

/**
 * 分頁在背景時,累計別人送來的訊息數,顯示在分頁標題:「(3) 匿名聊天室」。
 * 切回這個分頁就歸零。
 */
export function useUnreadTitle(items: ChatItem[], myClientId: string, active: boolean): void {
  const unread = useRef(0)
  const lastCount = useRef(items.length)

  useEffect(() => {
    if (!active) {
      unread.current = 0
      document.title = BASE_TITLE
      return
    }
    const sync = () => {
      document.title = unread.current > 0 ? `(${unread.current}) ${BASE_TITLE}` : BASE_TITLE
    }
    const onVisibility = () => {
      if (!document.hidden) unread.current = 0
      sync()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onVisibility)
      document.title = BASE_TITLE
    }
  }, [active])

  useEffect(() => {
    const added = items.slice(lastCount.current)
    lastCount.current = items.length
    if (!active || !document.hidden) return
    const fromOthers = added.filter(
      (i) => i.kind === 'message' && i.message.clientId !== myClientId,
    ).length
    if (fromOthers === 0) return
    unread.current += fromOthers
    document.title = `(${unread.current}) ${BASE_TITLE}`
  }, [items, myClientId, active])
}
