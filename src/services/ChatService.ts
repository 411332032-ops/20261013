// 聊天服務介面的定義放在 src/types.ts(通訊約定),這裡重新匯出,讓使用端有一個固定的入口。
export type {
  ChatService,
  ChatEvents,
  JoinError,
  JoinSuccess,
  SendError,
  Result,
} from '../types'
