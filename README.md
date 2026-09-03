# 進銷存 ERP 系統

這是一套獨立於原 iSM 資料庫的新進銷存系統骨架，資料庫使用 MySQL，前端只透過後端 API 存取資料。

## 目前範圍

- 主檔：公司、客戶、供應商、商品、倉庫、部門、員工
- 採購：採購單、進貨入庫
- 銷售：銷售訂單、出貨扣庫
- 庫存：即時庫存、庫存異動、安全庫存預警
- 報表：Dashboard、低庫存清單，以及公司別／日期區間的廠商預計進料、品號／庫別預計進料、製令預計進料、未交／未結案、應收／應付帳齡、資金預估與票據票況
- 財務：應收／應付、收付款、票據、銀行存提款、逐筆對帳、未對帳／未兌現查詢、會計期間、會計分錄底稿（多筆來源彙總、立沖、來源鎖定、核准、拋轉與還原）
- 公司切換：以 `erp_data_sources` 維護來源資料庫，以 `erp_companies` 顯示公司主檔；公司別與來源資料庫綁定，避免不同公司的資料混用。

## iSM 文件參照方向

已參考工作區內的 iSM PDF 與 `SH_mysql_schema.sql`，第一版流程依照：

- 訂單管理：客戶、訂單、出貨，並銜接庫存與應收
- 採購管理：供應商、採購、進貨，並銜接庫存與應付
- 庫存管理：品號、倉庫、庫存異動、批號/儲位擴充
- 應收/應付：依單據性質與公司別接續結帳、收付款、票據、銀行資金與會計傳票；原始 iSM 資料庫維持唯讀

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
npm run verify:accounting-drafts
npm run verify:bank-note-reconciliation
npm run verify:accounting-period-rollforward
npm run verify:import-quality
npm run verify:company-regression
```

`verify:accounting-drafts` 會驗證多筆來源彙總、目前餘額、立沖必填、來源鎖定、只能維護既有行次、核准、正式傳票拋轉與還原，測試結束會清理測試資料。

`verify:bank-note-reconciliation` 會驗證 SH／SC 公司隔離、管帳／管錢／逐筆對帳權限分離、存提款過帳與銀行餘額回寫、票據託收／兌現／退票、銀行交易沖回限制、票據狀態歷程、平衡分錄底稿及未對帳／未兌現查詢，測試結束會清理測試資料。

`verify:accounting-period-rollforward` 會驗證銀行、應收、應付、應收票據、應付票據與總帳期初批次導入，試算表／科目餘額／總帳明細／子帳核對，未完成資料阻擋關帳、12 個月月底快照、年度損益結轉及下一年度重新開帳限制，測試結束會清理測試資料。

`verify:import-quality` 會以目標 ERP 的暫時資料驗證指定單號品質掃描、完成單據剩餘量警示、目標端更正案件與事件歷程；最後清理測試資料，並確認 SH 原始資料未被修改。歷史匯入資料預設採「保留警示」策略，不會自動改寫 SH／SC；要修正只能在目標 ERP 走更正案件與沖回／重開／重作流程。匯入銷售訂單時，來源 `TA019` 會標準化為作廢／完成／核准狀態，並保留原始狀態碼。

`verify:company-regression` 會對每一個啟用中的公司來源，使用相同的日期條件重新執行七類配銷／財務報表、銷售／採購／健康度流程稽核、資料品質查詢，並檢查目標資料表的租戶、公司、來源系統與來源資料庫範圍。預設只讀取與查詢，不新增測試單據；可用 `npm run verify:company-regression -- --source=SC` 只檢查指定公司，或用 `--from-date=YYYY-MM-DD --to-date=YYYY-MM-DD` 指定期間。製令報表在尚未完成標準欄位對照時會回傳「待對照」，不會猜測原始 MO 欄位。

報表 API 為 `GET /api/reports/operations?report=<報表代碼>&source_database=<公司來源>&from_date=YYYY-MM-DD&to_date=YYYY-MM-DD&as_of_date=YYYY-MM-DD&limit=500`；報表代碼可由 `GET /api/reports/definitions` 取得。前端位於「流程稽核／配銷／財務報表」，每次新增公司資料庫並完成來源設定後，應先執行 `verify:company-regression` 再開放切換。

## GitHub 固定備份

GitHub 儲存程式碼與說明，不儲存 `.env`、`openai_key.txt`、資料庫備份、匯入 CSV 或 `n8n-data`。完成一個開發階段後，在專案根目錄執行：

```powershell
npm run backup:github
```

指令會確認 `origin` 是 `JacksonLiu119/erpcontinue`，只加入程式、資料庫結構、腳本與說明文件，檢查暫存內容後建立提交並推送目前分支；若偵測到敏感檔案或遠端不符會停止，不會強制覆蓋遠端歷史。資料庫內容仍應依 BAK／MySQL 備份流程另行保存。

## n8n 每日主管報表

ERP 提供獨立、唯讀且以 API 金鑰保護的每日報表端點，n8n 不需要持有資料庫帳密：

```text
GET /api/integrations/n8n/daily-report?source_database=SH&period=year
X-N8N-API-Key: 你的 N8N_API_KEY
```

期間可用 `period=year|weekly|daily|custom` 切換；每日未傳 `date` 時會以 `Asia/Taipei` 的前一天為報表日。請將 `n8n/erp-daily-manager-report.json`
匯入 n8n，設定 `ERP_BASE_URL`、`ERP_N8N_API_KEY`、`ERP_MANAGER_EMAILS`，並在寄信節點選擇 SMTP 帳號。
