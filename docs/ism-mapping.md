# iSM 到新進銷存系統對照

## 參照來源

- `iSM-訂單管理系統.pdf`
- `iSM-採購管理系統.pdf`
- `iSM-庫存管理系統.pdf`
- `iSM-應收管理系統.pdf`
- `iSM-應付管理系統.pdf`
- `iSM-自動分錄系統.pdf`
- `SH_mysql_schema.sql`

## iSM 表群判讀

依既有 schema 命名慣例，第一版先抓進銷存核心：

| iSM 表群 | 作用 | 新系統對應 |
| --- | --- | --- |
| `COP*` | 訂單/出貨/客戶交易 | `customers`, `sales_orders`, `sales_shipments` |
| `PUR*` | 採購/進貨/供應商交易 | `suppliers`, `purchase_orders`, `purchase_receipts` |
| `INV*` | 品號、庫存異動、庫存資料 | `products`, `warehouses`, `inventory_stock`, `inventory_moves` |
| `CMS*` | 共用基本資料，例如倉庫、幣別、部門等 | `warehouses` 與後續共用主檔 |
| `ACR*` | 應收 | 第二階段 `ar_invoices`, `receipts` |
| `ACP*` | 應付 | 第二階段 `ap_invoices`, `payments` |
| `AJS*` / `ACT*` | 自動分錄/總帳 | 第三階段後續整合，不阻塞進銷存 MVP |

## 第一版流程

### 採購到入庫

1. 建立供應商與商品。
2. 建立採購單 `purchase_orders` / `purchase_order_items`。
3. 進貨時建立 `purchase_receipts` / `purchase_receipt_items`。
4. API 過帳時寫入 `inventory_moves`，同步增加 `inventory_stock.qty_on_hand`。
5. 後續第二階段可從進貨單產生應付帳款。

### 訂單到出貨

1. 建立客戶與商品。
2. 建立銷售訂單 `sales_orders` / `sales_order_items`。
3. 出貨時建立 `sales_shipments` / `sales_shipment_items`。
4. API 過帳時檢查庫存，寫入 `inventory_moves`，同步扣減 `inventory_stock.qty_on_hand`。
5. 後續第二階段可從出貨/銷貨單產生應收帳款。

### 庫存管理

1. `inventory_stock` 保存即時庫存。
2. `inventory_moves` 保存每筆異動，可追溯單據來源。
3. `products.safety_stock` 用於低庫存預警。
4. `lot_no` 已保留批號欄位；若後續需要效期，可新增批號主檔。

## 待取得真實資料後需補強

- iSM 欄位碼如 `TA001`, `TA002`, `TB004` 的中文欄名需由 PDF 頁面或 iSM 資料字典確認。
- 匯入腳本需依你的實際公司資料決定欄位對應。
- 應收/應付與總帳分錄先不納入 MVP，避免進銷存流程被會計細節卡住。
# SH 庫存查詢來源

庫存報表目前讀取既有 SH 資料庫，不複製資料到 `inventory_erp`：

- `SH.invtb`：庫存異動明細，提供品號、品名、數量、單位、類別與明細日期。
- `SH.invta`：庫存異動單頭，提供單據日期、單據類別與單據號碼；`TA004` 是異動相關代碼，不是畫面上的倉別。
- `SH.invmb`：品號主檔，作為品名與單位的補充資料。
- `SH.cmsmc`：倉別主檔；`MC001` 是倉別代號、`MC002` 是倉別名稱。

畫面上的倉別欄位使用 `SH.invtb.TB012 = SH.cmsmc.MC001`。例如目前畫面資料中的 `TB012=101` 對應 `二廠倉`；不可使用 `SH.invta.TA004=140` 當作倉別。

API：`GET /api/sh/inventory?limit=10&keyword=關鍵字`

預設依庫存日期、單據號碼與明細序號倒序，回傳最近 10 筆；`limit` 上限為 100。關鍵字會對品號、品名、單據類別、單據號碼、倉別代號與倉別名稱進行模糊比對。
