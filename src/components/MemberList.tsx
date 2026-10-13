import { nicknameColor, nicknameInitial } from '../lib/nicknameColor'
import type { Member } from '../types'

/** 在線名單。自己排第一,後面標「(你)」 */
export function MemberList({ members, myClientId }: { members: Member[]; myClientId: string }) {
  const sorted = [...members].sort((a, b) => {
    if (a.clientId === myClientId) return -1
    if (b.clientId === myClientId) return 1
    return a.joinedAt - b.joinedAt
  })

  return (
    <ul className="member-list">
      {sorted.map((m) => (
        <li
          key={m.clientId}
          className="member"
          style={{ '--nc': nicknameColor(m.nickname) } as React.CSSProperties}
        >
          <span className="avatar" aria-hidden="true">
            {nicknameInitial(m.nickname)}
          </span>
          <span className="name">
            {m.nickname}
            {m.clientId === myClientId && <span className="you">(你)</span>}
          </span>
        </li>
      ))}
    </ul>
  )
}
