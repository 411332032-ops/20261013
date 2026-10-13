import { useCallback, useEffect, useState } from 'react'
import { saveNickname } from '../lib/storage'
import { validateNickname } from '../lib/validation'
import type {
  ChatItem,
  ChatService,
  ConnectionStatus,
  JoinError,
  Member,
  Message,
  Result,
  SendError,
} from '../types'

function messageItem(message: Message): ChatItem {
  return { kind: 'message', key: message.id, message }
}

let systemCounter = 0
function systemItem(text: string): ChatItem {
  return { kind: 'system', key: `sys-${++systemCounter}`, text, at: Date.now() }
}

/** 把新訊息加進去,已經有的(同一個 id)就略過 */
function appendMessage(items: ChatItem[], message: Message): ChatItem[] {
  if (items.some((i) => i.kind === 'message' && i.message.id === message.id)) return items
  return [...items, messageItem(message)]
}

/**
 * 聊天室的畫面狀態:目前在哪個畫面、訊息、在線名單、連線狀態。
 * 只透過 ChatService 介面溝通,不知道背後是模擬版還是 Supabase。
 */
export function useChatSession(service: ChatService) {
  const [phase, setPhase] = useState<'join' | 'chat'>('join')
  const [nickname, setNickname] = useState('')
  const [items, setItems] = useState<ChatItem[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [status, setStatus] = useState<ConnectionStatus>('connecting')

  useEffect(() => {
    const offs = [
      service.on('message', (m) => setItems((prev) => appendMessage(prev, m))),
      service.on('members', setMembers),
      service.on('member_joined', (m) =>
        setItems((prev) => [...prev, systemItem(`${m.nickname} 加入了聊天室`)]),
      ),
      service.on('member_left', (m) =>
        setItems((prev) => [...prev, systemItem(`${m.nickname} 離開了聊天室`)]),
      ),
      service.on('status', setStatus),
    ]
    return () => offs.forEach((off) => off())
  }, [service])

  const join = useCallback(
    async (raw: string): Promise<Result<void, JoinError>> => {
      const result = await service.join(raw)
      if (!result.ok) return result

      const { history, members: current } = result.value
      const checked = validateNickname(raw)
      const me = checked.ok ? checked.value : raw.trim()
      setNickname(me)
      saveNickname(me)
      // 進入的瞬間若已有新事件進來,保留它們,只補上歷史訊息
      setItems((prev) => {
        const known = new Set(history.map((m) => m.id))
        const extra = prev.filter((i) => i.kind !== 'message' || !known.has(i.message.id))
        return [...history.map(messageItem), ...extra]
      })
      setMembers(current)
      setStatus((s) => (s === 'reconnecting' ? s : 'online'))
      setPhase('chat')
      return { ok: true, value: undefined }
    },
    [service],
  )

  const send = useCallback(
    (content: string, replyToId?: string): Promise<Result<void, SendError>> =>
      service.send(content, replyToId),
    [service],
  )

  const leave = useCallback(() => {
    service.leave()
    setPhase('join')
    setItems([])
    setMembers([])
    setStatus('connecting')
  }, [service])

  return { phase, nickname, items, members, status, join, send, leave }
}
