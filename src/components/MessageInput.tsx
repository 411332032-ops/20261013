import { useEffect, useRef, useState } from 'react'
import { RateLimiter } from '../lib/rateLimit'
import { CONTENT_MAX, charLength, clampChars, validateContent } from '../lib/validation'
import type { Result, SendError } from '../types'
import { SendIcon } from './Icons'

const HINT_MS = 3000
const MAX_HEIGHT_PX = 120

/** 電腦(有滑鼠)按 Enter 送出;手機按 Enter 是換行 */
const ENTER_SENDS = '(hover: hover) and (pointer: fine)'

export function MessageInput({
  offline,
  onSend,
}: {
  offline: boolean
  onSend: (content: string) => Promise<Result<void, SendError>>
}) {
  const [draft, setDraft] = useState('')
  const [warning, setWarning] = useState('')
  const [sending, setSending] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)
  const limiter = useRef(new RateLimiter())
  const warnTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(warnTimer.current), [])

  // 輸入框隨內容長高,最高 120px
  useEffect(() => {
    const el = field.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`
  }, [draft])

  const warn = (text: string) => {
    setWarning(text)
    clearTimeout(warnTimer.current)
    warnTimer.current = setTimeout(() => setWarning(''), HINT_MS)
  }

  const canSend = !offline && !sending && validateContent(draft).ok

  const submit = async () => {
    if (!canSend) return
    // 前端先擋一次(資料庫端也會再擋)
    if (!limiter.current.tryConsume()) {
      warn('請稍等一下再送')
      return
    }
    setSending(true)
    const result = await onSend(draft)
    setSending(false)
    if (result.ok) {
      setDraft('')
      field.current?.focus()
      return
    }
    if (result.error === 'RATE_LIMITED') warn('請稍等一下再送')
    else if (result.error === 'OFFLINE') warn('目前離線,連線恢復後再送')
    else warn('訊息內容不能送出,請檢查後再試')
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return
    // 中文輸入法選字時按的 Enter 不算送出
    if (e.nativeEvent.isComposing) return
    if (!window.matchMedia(ENTER_SENDS).matches) return
    e.preventDefault()
    void submit()
  }

  const length = charLength(draft)

  let hintText: React.ReactNode = <span className="only-keyboard">Enter 送出・Shift + Enter 換行</span>
  let hintWarn = false
  if (offline) hintText = '連線恢復後就能送出,內容會保留'
  else if (warning) {
    hintText = <span role="status">{warning}</span>
    hintWarn = true
  }

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="composer-row">
        <textarea
          ref={field}
          className="field"
          rows={1}
          placeholder="輸入訊息…"
          aria-label="訊息內容"
          value={draft}
          disabled={offline}
          onChange={(e) => setDraft(clampChars(e.target.value, CONTENT_MAX))}
          onKeyDown={onKeyDown}
        />
        <button
          className="send"
          type="submit"
          aria-label={offline ? '送出(目前無法送出)' : '送出'}
          disabled={!canSend}
        >
          <SendIcon size={22} />
        </button>
      </div>
      <div className={hintWarn ? 'hint warn' : 'hint'}>
        <span>{hintText}</span>
        <span>
          {length} / {CONTENT_MAX}
        </span>
      </div>
    </form>
  )
}
