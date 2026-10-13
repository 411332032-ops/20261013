import { useEffect, useRef } from 'react'
import type { Member } from '../types'
import { CloseIcon } from './Icons'
import { MemberList } from './MemberList'

/** 手機版:從底部升起的在線名單面板 */
export function MemberSheet({
  members,
  myClientId,
  onClose,
}: {
  members: Member[]
  myClientId: string
  onClose: () => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      opener?.focus?.()
    }
  }, [onClose])

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <section className="sheet" role="dialog" aria-modal="true" aria-label="在線名單">
        <div className="grab" />
        <div className="panel-h">
          <h3>在線名單({members.length})</h3>
          <button ref={closeRef} className="ghost" type="button" aria-label="關閉名單" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <MemberList members={members} myClientId={myClientId} />
      </section>
    </>
  )
}
