import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages 的網址是 https://<帳號>.github.io/<儲存庫名稱>/
// base 必須和儲存庫名稱一致,否則部署後網頁找不到自己的檔案(一片空白)。
export default defineConfig({
  base: '/20261013/',
  plugins: [react()],
})
