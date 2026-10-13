import { Fragment, useLayoutEffect, useRef, useState } from 'react'
import type { ChatItem } from '../types'
import { ArrowDownIcon, ChatBubblesIcon } from './Icons'
import { MessageItem } from './MessageItem'

function itemTime(item: ChatItem): number {
  return item.kind === 'message' ? item.message.createdAt : item.at
}

function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function dayLabel(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

const NEAR_BOTTOM_PX = 48

export function MessageList({ items, myClientId }: { items: ChatItem[]; myClientId: string }) {
  const scroller = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const previousCount = useRef(0)
  const [hasNew, setHasNew] = useState(false)

  const scrollToBottom = () => {
    const el = scroller.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    stickToBottom.current = true
    setHasNew(false)
  }

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
    stickToBottom.current = near
    if (near) setHasNew(false)
  }

  // 新項目進來時決定要不要捲動:
  // 本來就停在最底、或是自己剛送出訊息 → 自動捲到底;
  // 正在翻舊訊息 → 畫面不動,改顯示「有新訊息」按鈕。
  useLayoutEffect(() => {
    const added = items.length > previousCount.current
    const firstLoad = previousCount.current === 0
    previousCount.current = items.length
    if (!added) return

    const last = items[items.length - 1]
    const sentByMe = last.kind === 'message' && last.message.clientId === myClientId
    if (firstLoad || stickToBottom.current || sentByMe) scrollToBottom()
    else setHasNew(true)
  }, [items, myClientId])

  // 輸入區變高、手機鍵盤跳出時,如果本來在最底,就維持在最底
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  let lastDay = ''

  return (
    <div className="msgs-wrap">
      <div
        ref={scroller}
        className="msgs"
        role="log"
        aria-live="polite"
        aria-label="聊天訊息"
        onScroll={onScroll}
      >
        {items.length === 0 && (
          <div className="state">
            <ChatBubblesIcon size={40} />
            <h4>還沒有人說話</h4>
            <p>來說第一句吧</p>
          </div>
        )}

        {items.map((item) => {
          const time = itemTime(item)
          const key = dayKey(time)
          const showDay = key !== lastDay
          lastDay = key
          return (
            <Fragment key={item.key}>
              {showDay && <div className="datesep">{dayLabel(time)}</div>}
              {item.kind === 'system' ? (
                <div className="sys">{item.text}</div>
              ) : (
                <MessageItem message={item.message} own={item.message.clientId === myClientId} />
              )}
            </Fragment>
          )
        })}
      </div>

      {hasNew && (
        <button className="newbtn" type="button" onClick={scrollToBottom}>
          <ArrowDownIcon size={18} />
          有新訊息
        </button>
      )}
    </div>
  )
}
