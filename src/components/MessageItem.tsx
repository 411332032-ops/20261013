import { linkify } from '../lib/linkify'
import { nicknameColor } from '../lib/nicknameColor'
import type { Message } from '../types'
import { ReplyIcon } from './Icons'

export function formatTime(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function MessageItem({
  message,
  own,
  onReply,
  onJump,
}: {
  message: Message
  own: boolean
  onReply: (message: Message) => void
  /** 點引用區塊:捲到原訊息(原訊息不在畫面上就什麼都不做) */
  onJump: (id: string) => void
}) {
  const quote = message.replyTo
  return (
    <div
      id={`m-${message.id}`}
      className={own ? 'row own' : 'row'}
      style={own ? undefined : ({ '--nc': nicknameColor(message.nickname) } as React.CSSProperties)}
    >
      <div className="meta">
        {!own && <span className="nick">{message.nickname}</span>}
        <span>{formatTime(message.createdAt)}</span>
        <button
          className="reply-btn"
          type="button"
          aria-label={`回覆 ${message.nickname} 的訊息`}
          onClick={() => onReply(message)}
        >
          <ReplyIcon size={14} />
          回覆
        </button>
      </div>
      <div className="bubble">
        {quote && (
          <button
            className="quote"
            type="button"
            style={{ '--qc': nicknameColor(quote.nickname) } as React.CSSProperties}
            aria-label={`引用 ${quote.nickname}:${quote.excerpt}`}
            disabled={quote.id === null}
            onClick={() => quote.id && onJump(quote.id)}
          >
            <span className="q-nick">{quote.nickname}</span>
            <span className="q-text">{quote.excerpt}</span>
          </button>
        )}
        {linkify(message.content).map((part, i) =>
          part.type === 'link' ? (
            <a key={i} href={part.href} target="_blank" rel="noopener noreferrer">
              {part.text}
            </a>
          ) : (
            <span key={i}>{part.text}</span>
          ),
        )}
      </div>
    </div>
  )
}
