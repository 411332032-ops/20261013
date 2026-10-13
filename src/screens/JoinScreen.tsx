import { useEffect, useState } from 'react'
import { AlertIcon, ChatBubblesIcon } from '../components/Icons'
import { getSavedNickname } from '../lib/storage'
import { NICKNAME_MAX, charLength, clampChars, validateNickname } from '../lib/validation'
import type { ChatService, JoinError, Result } from '../types'

const ERROR_TEXT: Record<JoinError, string> = {
  NICKNAME_TAKEN: '這個代號已有人使用,請換一個',
  INVALID_NICKNAME: '這個名稱不能使用,請換一個',
  UNAVAILABLE: '連線失敗,請稍後再試',
}

export function JoinScreen({
  service,
  onJoin,
}: {
  service: ChatService
  onJoin: (nickname: string) => Promise<Result<void, JoinError>>
}) {
  const [nickname, setNickname] = useState(getSavedNickname)
  const [error, setError] = useState<JoinError | null>(null)
  const [busy, setBusy] = useState(false)
  const [online, setOnline] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    const refresh = () =>
      service
        .getOnlineCount()
        .then((n) => alive && setOnline(n))
        .catch(() => alive && setOnline(null))
    void refresh()
    const timer = setInterval(refresh, 10_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [service])

  const canSubmit = !busy && nickname.trim().length > 0

  const submit = async () => {
    if (!canSubmit) return
    const check = validateNickname(nickname)
    if (!check.ok) {
      setError('INVALID_NICKNAME')
      return
    }
    setError(null)
    setBusy(true)
    const result = await onJoin(check.value)
    // 成功時這個畫面會被換掉,只有失敗才需要還原按鈕
    if (!result.ok) {
      setError(result.error)
      setBusy(false)
    }
  }

  return (
    <main className="join">
      <div className="brand">
        <div className="logo">
          <ChatBubblesIcon size={30} />
        </div>
        <h1>匿名聊天室</h1>
        <p className="lede">不用註冊、不用登入。取個代號,就能加入大家的聊天。</p>
        {online !== null && (
          <div className="online-pill">
            <span className="dot" />
            目前 {online} 人在線
          </div>
        )}
      </div>

      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <label htmlFor="nickname">你的代號</label>
        <div className="input-wrap">
          <input
            id="nickname"
            className={error ? 'text-in err' : 'text-in'}
            type="text"
            value={nickname}
            autoComplete="off"
            autoCapitalize="off"
            enterKeyHint="go"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'nickname-error' : 'nickname-hint'}
            onChange={(e) => {
              setNickname(clampChars(e.target.value, NICKNAME_MAX))
              setError(null)
            }}
          />
          <span className="counter">
            {charLength(nickname)} / {NICKNAME_MAX}
          </span>
        </div>

        {error ? (
          <p id="nickname-error" className="error" role="alert">
            <AlertIcon size={18} className="error-icon" />
            {ERROR_TEXT[error]}
          </p>
        ) : (
          <p id="nickname-hint" className="field-hint">
            1 到 {NICKNAME_MAX} 個字,中文、英文、emoji 都可以
          </p>
        )}

        <div className="spacer" />
        <button className="primary" type="submit" disabled={!canSubmit}>
          {busy ? '進入中…' : '進入聊天室'}
        </button>
        {getSavedNickname() !== '' && getSavedNickname() === nickname && (
          <p className="fine">上次用的代號已幫你填好,按一下就能進入</p>
        )}
      </form>
    </main>
  )
}
