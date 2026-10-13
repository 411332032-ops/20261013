import { SpinnerIcon } from './Icons'

/** 只在斷線時顯示在畫面最上方 */
export function ConnectionBanner() {
  return (
    <div className="banner" role="status">
      <SpinnerIcon size={18} className="spin" />
      連線中斷,重新連線中…
    </div>
  )
}
