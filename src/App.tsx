import { useMemo } from 'react'
import { useChatSession } from './hooks/useChatSession'
import { useUnreadTitle } from './hooks/useUnreadTitle'
import { getClientId } from './lib/storage'
import { ChatScreen } from './screens/ChatScreen'
import { JoinScreen } from './screens/JoinScreen'
import { createChatService } from './services/createChatService'

export default function App() {
  const clientId = useMemo(getClientId, [])
  const service = useMemo(() => createChatService(clientId), [clientId])
  const session = useChatSession(service)

  useUnreadTitle(session.items, clientId, session.phase === 'chat')

  return (
    <div className="app">
      {session.phase === 'join' ? (
        <JoinScreen service={service} onJoin={session.join} />
      ) : (
        <ChatScreen
          items={session.items}
          members={session.members}
          status={session.status}
          myClientId={clientId}
          onSend={session.send}
          onLeave={session.leave}
        />
      )}
    </div>
  )
}
