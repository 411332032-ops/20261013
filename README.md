# 匿名聊天室

不用登入的匿名聊天室。詳細設計見 `docs/architecture.md`(架構)與 `docs/design.md`(畫面)。

目前在**階段二**:前端已接上 Supabase。`.env.local`(參考 `.env.example`)有網址和公開金鑰時用真實版,沒有就用模擬版。

## 新增功能

除了基本的聊天、在線名單、進出提示、最近 50 則歷史、7 天自動清除之外,另外做了這些:

- **資料庫端限制發言頻率**:`supabase/schema.sql` 的 `BEFORE INSERT` 觸發器,同一個 `client_id` 在 5 秒內已有 3 則就拒絕(`RATE_LIMITED`),前端轉成「請稍等一下再送」。繞過網頁直接打 API 也擋得住。
- **資料庫端過濾代號與內容**:資料表 `CHECK` 規則拒絕保留代號(系統、管理員、admin 等)、頭尾或連續空白、零寬與方向控制字元、空白訊息和超長內容。前端用同一套標準先擋一次。
- **回覆/引用某則訊息**(和所有人即時同步):每則訊息旁有「回覆」,送出後所有人都在該訊息上方看到被引用的代號與摘要,點引用會跳到原訊息。引用的代號與摘要由資料庫觸發器依原訊息填入(`supabase/schema.sql`),無法偽造。
- **分頁標題未讀數**:分頁在背景時,別人每來一則訊息就累計,標題顯示「(3) 匿名聊天室」,切回來歸零。
- **網址轉成可點連結**:訊息中 `http://`、`https://` 開頭的網址變成連結(新分頁開啟,加 `rel="noopener noreferrer"`);`javascript:` 等其他格式不會轉。顯示時以元件渲染,不使用 `dangerouslySetInnerHTML`。

## 在自己的電腦上執行

```
npm install
npm run dev      # 開發預覽,網址 http://localhost:5173/20261013/
npm run build    # 檢查型別並打包到 dist/
npm run preview  # 預覽打包後的成品
```

## 部署

推到 `main` 後,GitHub Actions 會自動打包並發布到 GitHub Pages。
第一次要到 Settings → Pages → Source 選 **GitHub Actions**。
