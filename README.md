# 進銷存 ERP 系統

這是一套獨立於原 iSM 資料庫的新進銷存系統骨架，資料庫使用 MySQL，前端只透過後端 API 存取資料。

## 目前範圍

- 主檔：公司、客戶、供應商、商品、倉庫、部門、員工
- 採購：採購單、進貨入庫
- 銷售：銷售訂單、出貨扣庫
- 庫存：即時庫存、庫存異動、安全庫存預警
- 報表：Dashboard、低庫存清單
- 公司切換：以 `erp_data_sources` 維護來源資料庫，以 `erp_companies` 顯示公司主檔；公司別與來源資料庫綁定，避免不同公司的資料混用。

## iSM 文件參照方向

已參考工作區內的 iSM PDF 與 `SH_mysql_schema.sql`，第一版流程依照：

- 訂單管理：客戶、訂單、出貨，並銜接庫存與應收
- 採購管理：供應商、採購、進貨，並銜接庫存與應付
- 庫存管理：品號、倉庫、庫存異動、批號/儲位擴充
- 應收/應付：第二階段接帳款，不先卡住進銷存 MVP

詳見 [docs/ism-mapping.md](docs/ism-mapping.md)。

## `.env` 怎麼用

不要把 MySQL 密碼貼在聊天裡。請在專案根目錄建立一個 `.env` 檔，內容參考 `.env.example`：

```env
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=你的MySQL密碼
DB_NAME=inventory_erp
PORT=3000
```

`.env` 是本機設定檔，已被 `.gitignore` 排除，不應提交到 Git。
可直接複製 `.env.example` 為 `.env`，再填入本機密碼。

## 建立資料庫

先在 MySQL 執行：

```sql
CREATE DATABASE IF NOT EXISTS inventory_erp CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

再匯入：

```powershell
mysql -u root -p inventory_erp < sql/schema.sql
```

## 啟動

```powershell
npm install
npm start
```

打開：

```text
http://127.0.0.1:3000
```

健康檢查：

```text
http://127.0.0.1:3000/health
```

流程驗證（會建立並清理測試流程資料）：

```powershell
npm run verify:flow
npm run cleanup:flow-test
```
