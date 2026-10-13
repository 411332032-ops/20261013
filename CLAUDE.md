# 匿名聊天室

一個不用登入的匿名聊天室,前端放在 GitHub Pages,即時傳訊(階段二)用 Supabase。

- 開始任何工作前,先讀 `docs/architecture.md`。
- 目前在「階段二」:前端已接上 Supabase(`SupabaseChatService`)。`.env.local` 有網址和公開金鑰時用真實版,沒有就退回模擬版(`MockChatService`)。
- 不可以把金鑰檔案(`.env`、`.env.local`、`.env.*.local` 等)commit 進 git。只有 `.env.example` 可以 commit。
