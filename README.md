# 匿名聊天室

不用登入的匿名聊天室。詳細設計見 `docs/architecture.md`(架構)與 `docs/design.md`(畫面)。

目前在**階段二**:前端已接上 Supabase。`.env.local`(參考 `.env.example`)有網址和公開金鑰時用真實版,沒有就用模擬版。

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
