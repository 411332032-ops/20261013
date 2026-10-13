import { useCallback, useState } from 'react'
import { ConnectionBanner } from '../components/ConnectionBanner'
import { LeaveIcon, UsersIcon } from '../components/Icons'
import { MemberList } from '../components/MemberList'
import { MemberSheet } from '../components/MemberSheet'
import { MessageInput } from '../components/MessageInput'
import { MessageList } from '../components/MessageList'
import { useMediaQuery } from '../hooks/useMediaQuery'
import type { ChatItem, ConnectionStatus, Member, Message, Result, SendError } from '../types'

export function ChatScreen({
  items,
  members,
  status,
  myClientId,
  onSend,
  onLeave,
}: {
  items: ChatItem[]
  members: Member[]
  status: ConnectionStatus
  myClientId: string
  onSend: (content: string, replyToId?: string) => Promise<Result<void, SendError>>
  onLeave: () => void
}) {
  const [sheetOpen, setSheetOpen] = useState(false)
  const [reply, setReply] = useState<Message | null>(null)
  const isWide = useMediaQuery('(min-width: 768px)')
  const closeSheet = useCallback(() => setSheetOpen(false), [])
  const offline = status === 'reconnecting'

  return (
    <div className="chat">
      {offline && <ConnectionBanner />}

      <div className="chat-body">
        <div className="chat-main">
          <header className="hdr">
            <div className="title">
              <h2>匿名聊天室</h2>
              <div className="count">
                <span className={offline ? 'dot dot-off' : 'dot'} />
                {members.length} 人在線
              </div>
            </div>
            {!isWide && (
              <button
                className="ghost"
                type="button"
                aria-label="在線名單"
                aria-haspopup="dialog"
                onClick={() => setSheetOpen(true)}
              >
                <UsersIcon />
                名單
              </button>
            )}
            <button className="ghost" type="button" aria-label="離開聊天室" onClick={onLeave}>
              <LeaveIcon />
              {isWide && '離開'}
            </button>
          </header>

          <MessageList items={items} myClientId={myClientId} onReply={setReply} />
          <MessageInput
            offline={offline}
            reply={reply}
            onCancelReply={() => setReply(null)}
            onSend={onSend}
          />
        </div>

        {isWide && (
          <aside className="side" aria-label="在線名單">
            <div className="panel-h">
              <h3>在線名單({members.length})</h3>
            </div>
            <MemberList members={members} myClientId={myClientId} />
          </aside>
        )}
      </div>

      {!isWide && sheetOpen && (
        <MemberSheet members={members} myClientId={myClientId} onClose={closeSheet} />
      )}
    </div>
  )
}
