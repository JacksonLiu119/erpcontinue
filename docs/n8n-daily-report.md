# ERP 每日報表：ERP DB → n8n → 主管信箱

## 流程

1. n8n 於台北時間每天 08:00 啟動；目前測試範本查詢今年 1 月 1 日至今天。
2. HTTP Request 節點以 `X-N8N-API-Key` 呼叫 ERP 唯讀 API。
3. ERP 查詢前一天的銷售出貨、採購入庫、庫存異動、負庫存、未結應收與未結應付。
4. n8n 使用 ERP 回傳的 `subject` 與 `html` 寄給主管。

## 設定

ERP `.env`：

```env
N8N_API_KEY=至少32碼的隨機字串
```

n8n 環境變數：

```env
ERP_BASE_URL=http://你的ERP主機:3000
ERP_N8N_API_KEY=與ERP相同的金鑰
ERP_MANAGER_EMAILS=jackson.liu@createfuture.com.tw
```

匯入 `n8n/erp-daily-manager-report.json` 後，在「寄送主管信箱」節點指定 SMTP Credential，再啟用工作流程。
若 ERP 與 n8n 不在同一台機器，請使用 HTTPS 或限制防火牆只允許 n8n 主機連線。

SMTP Credential 建議使用：主機 `ms.mailcloud.com.tw`、SSL、連接埠 `465`，帳號使用完整寄件信箱。
寄件帳號及密碼只存放於 n8n Credential，不要寫入工作流程 JSON 或 Git。

目前測試寄件帳號與主管收件信箱皆為 `jackson.liu@createfuture.com.tw`。

## 查詢期間切換

- 今年至今：`period=year`（目前測試設定）
- 每日：`period=daily`，預設前一天；也可加 `date=2026-08-18`
- 每週：`period=weekly`，預設本週一至昨天
- 自訂：`period=custom&date_from=2026-01-01&date_to=2026-06-30`

只需修改 n8n「取得 ERP 每日報表」節點 URL 的 `period`，寄信內容不需修改。

## 資料口徑

- 銷售：`sales_documents` + `sales_document_items`，單據種類 `shipment`，排除草稿與作廢。
- 採購：`procurement_receipts` + `procurement_receipt_items`，排除草稿、作廢與全數拒收。
- 庫存：`inventory_movement_ledger` 的當日異動；`erp_inventory_balances` 的目前負庫存。
- 財務：`finance_open_items` 中狀態為 approved/open/partial 的應收與應付餘額。

以上是新 ERP 標準表的 `schema-confirmed` 口徑；若主管要直接讀鼎新 SH 原始表，需另行確認出貨、進貨與過帳單別後再切換。
