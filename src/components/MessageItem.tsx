import { linkify } from '../lib/linkify'
import { nicknameColor } from '../lib/nicknameColor'
import type { Message } from '../types'

export function formatTime(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function MessageItem({ message, own }: { message: Message; own: boolean }) {
  return (
    <div
      className={own ? 'row own' : 'row'}
      style={own ? undefined : ({ '--nc': nicknameColor(message.nickname) } as React.CSSProperties)}
    >
      <div className="meta">
        {!own && <span className="nick">{message.nickname}</span>}
        <span>{formatTime(message.createdAt)}</span>
      </div>
      <div className="bubble">
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
