import {
  pool,
  sourceDatabases,
  ensureTargetSalesWorkflowSchema,
  ensureTargetFinanceWorkflowSchema,
  ensureTargetSalesPricingSchema
} from './db.js';

const EPSILON = 0.000001;
const SALES_DOCUMENT_KINDS = new Set(['quotation', 'sales_order', 'shipment', 'sales_return']);
const ACTIVE_SALES_STATUSES = ['approved', 'partial', 'completed', 'posted', 'closed'];
const ACTIVE_AR_STATUSES = ['approved', 'open', 'partial', 'settled'];

function trim(value) {
  return String(value ?? '').trim();
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function validDate(value) {
  const text = trim(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw badRequest('請輸入有效日期');
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) throw badRequest('請輸入有效日期');
  return text;
}

function optionalDate(value) {
  const text = trim(value);
  return text ? validDate(text) : null;
}

function sourceDbFromRequest(req) {
  const source = String(
    req.erpContext?.source_database || req.query.source_database || req.query.db ||
    req.headers['x-source-database'] || 'SH'
  ).toUpperCase();
  if (!sourceDatabases[source]) throw badRequest(`不允許的資料庫來源：${source}`);
  return source;
}

function contextFor(sourceDatabase) {
  const source = sourceDatabases[sourceDatabase];
  if (!source) throw badRequest(`找不到資料來源：${sourceDatabase}`);
  return {
    tenant_id: source.tenant_id || 'default',
    company_id: source.company_id || sourceDatabase,
    source_system: source.source_system || source.adapter_code || 'iSM',
    source_database: sourceDatabase
  };
}

function numeric(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function rate(numerator, denominator) {
  const base = numeric(denominator);
  return base > EPSILON ? Number(((numeric(numerator) / base) * 100).toFixed(4)) : 0;
}

function clampLimit(value) {
  return Math.min(Math.max(Number(value) || 500, 1), 2000);
}

function addEqual(where, params, value, expression) {
  const text = trim(value);
  if (text) {
    where.push(`${expression}=?`);
    params.push(text);
  }
}

function addRange(where, params, from, to, expression) {
  const start = trim(from);
  const end = trim(to);
  if (start) {
    where.push(`${expression}>=?`);
    params.push(start);
  }
  if (end) {
    where.push(`${expression}<=?`);
    params.push(end);
  }
}

const periodExpression = "DATE_FORMAT(d.document_date,'%Y-%m')";
const categoryExpression = "NULLIF(CONCAT_WS('／',NULLIF(im.category_1,''),NULLIF(im.category_2,''),NULLIF(im.category_3,''),NULLIF(im.category_4,'')),'')";
const warehouseExpression = "COALESCE(NULLIF(i.warehouse_code,''),d.warehouse_code)";
const itemNameExpression = "COALESCE(NULLIF(i.item_name,''),im.item_name)";

const salesFieldExpressions = {
  period_code: periodExpression,
  customer_code: 'd.customer_code',
  customer_name: 'cm.customer_name',
  item_code: 'i.item_code',
  item_name: itemNameExpression,
  category_code: categoryExpression,
  department_code: 'em.department_code',
  department_name: 'dp.department_name',
  salesperson_code: 'd.salesperson_code',
  salesperson_name: 'em.employee_name',
  warehouse_code: warehouseExpression,
  currency_code: 'd.currency_code',
  document_kind: 'd.document_kind',
  document_type: 'd.document_type',
  document_no: 'd.document_no',
  document_date: 'd.document_date',
  line_no: 'i.line_no',
  source_item_id: 'i.source_item_id'
};

const salesOutputFields = Object.keys(salesFieldExpressions);

function groupDefinition(label, fields, group, order = group) {
  const selected = new Set(fields);
  // 幣別永遠保留在輸出與分組中，避免跨幣別金額被合併。
  selected.add('currency_code');
  return {
    label,
    select: salesOutputFields.map(field => selected.has(field)
      ? `${salesFieldExpressions[field]} AS ${field}`
      : `NULL AS ${field}`),
    group: [...new Set(group)],
    order: [...order]
  };
}

const groupDefinitions = {
  customer: groupDefinition('依客戶', ['customer_code', 'customer_name'], ['d.customer_code', 'cm.customer_name'], ['d.customer_code']),
  item: groupDefinition('依品號', ['item_code', 'item_name'], ['i.item_code', itemNameExpression], ['i.item_code']),
  category: groupDefinition('依品號類別', ['category_code'], [categoryExpression], [categoryExpression]),
  department: groupDefinition('依部門', ['department_code', 'department_name'], ['em.department_code', 'dp.department_name'], ['em.department_code']),
  salesperson: groupDefinition('依業務員', ['salesperson_code', 'salesperson_name'], ['d.salesperson_code', 'em.employee_name'], ['d.salesperson_code']),
  warehouse: groupDefinition('依庫別', ['warehouse_code'], [warehouseExpression], [warehouseExpression]),
  currency: groupDefinition('依幣別', ['currency_code'], ['d.currency_code'], ['d.currency_code']),
  document_kind: groupDefinition('依單據流程種類', ['document_kind'], ['d.document_kind'], ['d.document_kind']),
  period: groupDefinition('依期間（月）', ['period_code'], [periodExpression], [periodExpression]),
  customer_item: groupDefinition('依客戶／品號', ['customer_code', 'customer_name', 'item_code', 'item_name'], ['d.customer_code', 'cm.customer_name', 'i.item_code', itemNameExpression], ['d.customer_code', 'i.item_code']),
  customer_department: groupDefinition('依客戶／部門', ['customer_code', 'customer_name', 'department_code', 'department_name'], ['d.customer_code', 'cm.customer_name', 'em.department_code', 'dp.department_name'], ['d.customer_code', 'em.department_code']),
  customer_salesperson: groupDefinition('依客戶／業務員', ['customer_code', 'customer_name', 'salesperson_code', 'salesperson_name'], ['d.customer_code', 'cm.customer_name', 'd.salesperson_code', 'em.employee_name'], ['d.customer_code', 'd.salesperson_code']),
  item_category: groupDefinition('依品號／類別', ['item_code', 'item_name', 'category_code'], ['i.item_code', itemNameExpression, categoryExpression], ['i.item_code']),
  item_warehouse: groupDefinition('依品號／庫別', ['item_code', 'item_name', 'warehouse_code'], ['i.item_code', itemNameExpression, warehouseExpression], ['i.item_code', warehouseExpression]),
  period_customer: groupDefinition('依期間／客戶', ['period_code', 'customer_code', 'customer_name'], [periodExpression, 'd.customer_code', 'cm.customer_name'], [periodExpression, 'd.customer_code']),
  period_item: groupDefinition('依期間／品號', ['period_code', 'item_code', 'item_name'], [periodExpression, 'i.item_code', itemNameExpression], [periodExpression, 'i.item_code']),
  period_category: groupDefinition('依期間／品號類別', ['period_code', 'category_code'], [periodExpression, categoryExpression], [periodExpression, categoryExpression]),
  period_department: groupDefinition('依期間／部門', ['period_code', 'department_code', 'department_name'], [periodExpression, 'em.department_code', 'dp.department_name'], [periodExpression, 'em.department_code']),
  period_salesperson: groupDefinition('依期間／業務員', ['period_code', 'salesperson_code', 'salesperson_name'], [periodExpression, 'd.salesperson_code', 'em.employee_name'], [periodExpression, 'd.salesperson_code']),
  period_warehouse: groupDefinition('依期間／庫別', ['period_code', 'warehouse_code'], [periodExpression, warehouseExpression], [periodExpression, warehouseExpression]),
  period_customer_item: groupDefinition('依期間／客戶／品號', ['period_code', 'customer_code', 'customer_name', 'item_code', 'item_name'], [periodExpression, 'd.customer_code', 'cm.customer_name', 'i.item_code', itemNameExpression], [periodExpression, 'd.customer_code', 'i.item_code']),
  detail: {
    label: '明細（逐筆可追溯）',
    select: salesOutputFields.map(field => `${salesFieldExpressions[field]} AS ${field}`),
    group: ['d.id', 'i.id', ...Object.values(salesFieldExpressions)],
    order: ['d.document_date DESC', 'd.document_no', 'i.line_no']
  }
};

const salesFromSql = `
  FROM sales_documents d
  JOIN sales_document_items i ON i.document_id=d.id
  LEFT JOIN erp_customers cm
    ON cm.tenant_id=d.tenant_id AND cm.company_id=d.company_id AND cm.source_system=d.source_system
    AND cm.source_database=d.source_database AND cm.customer_code=d.customer_code
  LEFT JOIN erp_items im
    ON im.tenant_id=d.tenant_id AND im.company_id=d.company_id AND im.source_system=d.source_system
    AND im.source_database=d.source_database AND im.item_code=i.item_code
  LEFT JOIN erp_employees em
    ON em.tenant_id=d.tenant_id AND em.company_id=d.company_id AND em.source_system=d.source_system
    AND em.source_database=d.source_database AND em.employee_code=d.salesperson_code
  LEFT JOIN erp_departments dp
    ON dp.tenant_id=d.tenant_id AND dp.company_id=d.company_id AND dp.source_system=d.source_system
    AND dp.source_database=d.source_database AND dp.department_code=em.department_code
  LEFT JOIN sales_document_items src_i ON src_i.id=i.source_item_id
  LEFT JOIN sales_documents src_d
    ON src_d.id=src_i.document_id AND src_d.tenant_id=d.tenant_id AND src_d.company_id=d.company_id
    AND src_d.source_system=d.source_system AND src_d.source_database=d.source_database
  LEFT JOIN sales_documents src_h
    ON src_h.id=d.source_document_id AND src_h.tenant_id=d.tenant_id AND src_h.company_id=d.company_id
    AND src_h.source_system=d.source_system AND src_h.source_database=d.source_database
`;

const sourceKindExpression = 'COALESCE(src_d.document_kind,src_h.document_kind)';
const sourceNoExpression = 'COALESCE(src_d.document_no,src_h.document_no)';
const sourceExistsExpression = '(src_d.id IS NOT NULL OR src_h.id IS NOT NULL)';
const sourceReferenceExpression = '(i.source_item_id IS NOT NULL OR d.source_document_id IS NOT NULL)';
const quantityExpression = 'GREATEST(COALESCE(i.quantity,0),0)';
const lineAmountExpression = `GREATEST((${quantityExpression}*COALESCE(i.unit_price,0))-COALESCE(i.allowance_amount,0),0)`;
const quoteQuantityExpression = `CASE WHEN d.document_kind='quotation' THEN ${quantityExpression} ELSE 0 END`;
const quoteAmountExpression = `CASE WHEN d.document_kind='quotation' THEN ${lineAmountExpression} ELSE 0 END`;
const orderQuantityExpression = `CASE WHEN d.document_kind='sales_order' THEN ${quantityExpression} ELSE 0 END`;
const deliveredQuantityExpression = `CASE WHEN d.document_kind='sales_order' THEN LEAST(GREATEST(COALESCE(i.related_quantity,0),0),${quantityExpression}) ELSE 0 END`;
const remainingQuantityExpression = `GREATEST(${orderQuantityExpression}-${deliveredQuantityExpression},0)`;
const orderAmountExpression = `CASE WHEN d.document_kind='sales_order' THEN ${lineAmountExpression} ELSE 0 END`;
const deliveredAmountExpression = `CASE WHEN d.document_kind='sales_order' THEN (${deliveredQuantityExpression}*COALESCE(i.unit_price,0)) ELSE 0 END`;
const remainingAmountExpression = `GREATEST(${orderAmountExpression}-${deliveredAmountExpression},0)`;
const shipmentQuantityExpression = `CASE WHEN d.document_kind='shipment' THEN ${quantityExpression} ELSE 0 END`;
const shipmentAmountExpression = `CASE WHEN d.document_kind='shipment' THEN ${lineAmountExpression} ELSE 0 END`;
const returnQuantityExpression = `CASE WHEN d.document_kind='sales_return' AND d.return_type='return' THEN ${quantityExpression} ELSE 0 END`;
const allowanceAmountExpression = `CASE WHEN d.document_kind='sales_return' AND d.return_type='allowance' THEN GREATEST(COALESCE(i.allowance_amount,0),${quantityExpression}*COALESCE(i.unit_price,0)) ELSE 0 END`;
const returnAmountExpression = `CASE WHEN d.document_kind='sales_return' AND d.return_type='allowance' THEN ${allowanceAmountExpression} WHEN d.document_kind='sales_return' THEN GREATEST((${quantityExpression}*COALESCE(i.unit_price,0))-COALESCE(i.allowance_amount,0),0) ELSE 0 END`;

const salesMetricExpressions = [
  'COUNT(DISTINCT d.id) AS sales_document_count',
  'COUNT(*) AS sales_line_count',
  "COUNT(DISTINCT CASE WHEN d.document_kind='quotation' THEN d.id END) AS quote_count",
  "COUNT(DISTINCT CASE WHEN d.document_kind='sales_order' THEN d.id END) AS order_count",
  "COUNT(DISTINCT CASE WHEN d.document_kind='shipment' THEN d.id END) AS shipment_count",
  "COUNT(DISTINCT CASE WHEN d.document_kind='sales_return' THEN d.id END) AS return_count",
  "COUNT(DISTINCT CASE WHEN d.document_kind='sales_return' AND d.return_type='allowance' THEN d.id END) AS allowance_count",
  `SUM(${quoteQuantityExpression}) AS quote_quantity`,
  `SUM(${orderQuantityExpression}) AS order_quantity`,
  `SUM(${deliveredQuantityExpression}) AS delivered_quantity`,
  `SUM(${remainingQuantityExpression}) AS remaining_quantity`,
  `SUM(${shipmentQuantityExpression}) AS shipment_quantity`,
  `SUM(${returnQuantityExpression}) AS return_quantity`,
  `SUM(${quoteAmountExpression}) AS quote_amount`,
  `SUM(${orderAmountExpression}) AS order_amount`,
  `SUM(${deliveredAmountExpression}) AS delivered_amount`,
  `SUM(${remainingAmountExpression}) AS remaining_amount`,
  `SUM(${shipmentAmountExpression}) AS shipment_amount`,
  `SUM(${returnAmountExpression}) AS return_amount`,
  `SUM(${allowanceAmountExpression}) AS allowance_amount`,
  `SUM(${shipmentAmountExpression}-${returnAmountExpression}) AS net_sales_amount`,
  "COUNT(DISTINCT CASE WHEN cm.id IS NULL THEN d.customer_code END) AS unmapped_customer_count",
  "COUNT(DISTINCT CASE WHEN im.id IS NULL THEN i.item_code END) AS unmapped_item_count",
  "COUNT(DISTINCT CASE WHEN COALESCE(d.salesperson_code,'')<>'' AND COALESCE(em.department_code,'')='' THEN d.salesperson_code END) AS unmapped_department_count",
  "COUNT(DISTINCT CASE WHEN COALESCE(d.salesperson_code,'')<>'' AND em.id IS NULL THEN d.salesperson_code END) AS unmapped_salesperson_count",
  "COUNT(DISTINCT CASE WHEN d.document_kind='sales_order' AND " + sourceKindExpression + "='quotation' THEN d.id END) AS linked_quote_order_count",
  "COUNT(DISTINCT CASE WHEN d.document_kind='sales_order' AND " + sourceReferenceExpression + "=0 THEN d.id END) AS independent_order_count",
  "COUNT(DISTINCT CASE WHEN d.document_kind='shipment' AND " + sourceKindExpression + "='sales_order' THEN d.id END) AS linked_shipment_count",
  "COUNT(DISTINCT CASE WHEN d.document_kind='shipment' AND " + sourceReferenceExpression + "=1 AND " + sourceKindExpression + " IS NULL THEN d.id END) AS unlinked_shipment_count",
  `COUNT(DISTINCT CASE WHEN ${sourceReferenceExpression}=1 AND ${sourceExistsExpression} THEN i.id END) AS source_linked_line_count`,
  `COUNT(DISTINCT CASE WHEN ${sourceReferenceExpression}=1 AND NOT ${sourceExistsExpression} THEN i.id END) AS orphan_source_line_count`,
  "MIN(CONCAT(d.document_kind,'｜',d.document_no)) AS source_document_sample",
  "MIN(CONCAT(d.document_kind,'｜',d.document_no,'→',COALESCE(" + sourceNoExpression + ",'無前置單據'))) AS source_trace_sample",
  "GROUP_CONCAT(DISTINCT CONCAT(d.document_kind,':',d.status) ORDER BY d.document_kind,d.status SEPARATOR '、') AS status_codes",
  `CASE WHEN SUM(${orderQuantityExpression})>${EPSILON} THEN CASE WHEN SUM(${remainingQuantityExpression})>${EPSILON} THEN 'open' ELSE 'completed' END ELSE 'no_order' END AS progress_status`
];

// 摘要不需要文字樣本／狀態串；移除排序與字串聚合，避免完整期間查詢
// 在大量歷史明細上重複做昂貴的 GROUP_CONCAT。
const salesSummaryMetricExpressions = salesMetricExpressions.filter(expression =>
  !expression.includes('GROUP_CONCAT') && !expression.includes(' AS progress_status')
);

const salesNumericFields = [
  'sales_document_count', 'sales_line_count', 'quote_count', 'order_count', 'shipment_count', 'return_count', 'allowance_count',
  'quote_quantity', 'order_quantity', 'delivered_quantity', 'remaining_quantity', 'shipment_quantity', 'return_quantity',
  'quote_amount', 'order_amount', 'delivered_amount', 'remaining_amount', 'shipment_amount', 'return_amount', 'allowance_amount',
  'net_sales_amount', 'linked_quote_order_count', 'independent_order_count', 'linked_shipment_count', 'unlinked_shipment_count',
  'source_linked_line_count', 'orphan_source_line_count', 'unmapped_customer_count', 'unmapped_item_count',
  'unmapped_department_count', 'unmapped_salesperson_count'
];

// 《iSM-訂單管理系統》報表名稱基準。這裡的 key 是程式內部識別碼，
// 對外顯示的 report_name 一律沿用手冊名稱；同名項目先集中在報表中心，
// 不因目前由既有頁面合併承接就偽裝成另一個作業名稱。
const salesReportCatalog = Object.freeze([
  { key: 'customer-order-statistics', report_name: '客戶接單統計表', section: '接單統計/跟催報表', mode: 'customer_order_summary', kinds: ['sales_order'], status: 'done', note: '由 COPR20 銷售統計承接；依客戶、幣別彙總訂單量、已交量、未交量與金額。' },
  { key: 'order-profit-analysis', report_name: '訂單利潤分析狀況表', section: '接單統計/跟催報表', mode: 'order_profit', kinds: ['sales_order'], status: 'partial', note: '訂單收入與明細成本可列出；製造／成本模組尚未納入，毛利完整性保留落差。' },
  { key: 'expected-shipment-detail', report_name: '訂單/商品/客戶/業務員預計出貨明細表', section: '接單統計/跟催報表', mode: 'expected_shipment_detail', kinds: ['sales_order'], status: 'partial', note: '目前以訂單明細預交日與交期排程合併承接，尚待完整 iSM 預計出貨欄位。' },
  { key: 'order-shipment-status', report_name: '訂單銷貨狀況表', section: '接單統計/跟催報表', mode: 'order_shipment_status', kinds: ['sales_order'], status: 'done', note: '沿用訂單已交量與銷貨關聯量，呈現未交量與未交金額。' },
  { key: 'customer-sales-detail', report_name: '客戶銷貨明細表', section: '銷售統計/管理報表', mode: 'detail', kinds: ['shipment'], status: 'partial', note: '已可查已過帳銷貨明細；iSM 正式欄位版與列印格式仍由中心承接。' },
  { key: 'customer-sales-summary', report_name: '客戶銷貨彙總表', section: '銷售統計/管理報表', mode: 'customer_sales_summary', kinds: ['shipment'], status: 'partial', note: '依客戶／幣別彙總已過帳銷貨量與金額，尚待正式報表版面與更多維度。' },
  { key: 'historical-transactions', report_name: '歷史交易記錄表', section: '銷售統計/管理報表', mode: 'detail', kinds: ['quotation', 'sales_order', 'shipment', 'sales_return'], status: 'partial', note: '以目標 ERP 銷售文件與來源鍵承接；來源 ERP 歷史資料仍維持唯讀。' },
  { key: 'product-sales-detail', report_name: '產品銷貨明細表', section: '銷售統計/管理報表', mode: 'detail', kinds: ['shipment'], status: 'partial', note: '已可按品號查已過帳銷貨明細，正式 iSM 報表欄位仍需補齊。' },
  { key: 'department-sales-period', report_name: '商品部門銷貨期報表', section: '銷售統計/管理報表', mode: 'department_sales_period', kinds: ['shipment'], status: 'partial', note: '以業務員所屬部門與月份彙總；部門未對照的資料會保留在異常提示。' },
  { key: 'shipped-not-invoiced', report_name: '已出貨未開發票明細表', section: '銷售統計/管理報表', mode: 'shipped_not_invoiced', kinds: ['shipment'], status: 'partial', note: '已串接應收憑單來源；僅已核准／已過帳且有有效發票的金額視為已開票。' },
  { key: 'sales-price-exception', report_name: '銷售價格異常表', section: '銷售統計/管理報表', mode: 'price_exception', kinds: ['quotation', 'sales_order', 'shipment'], status: 'partial', note: '檢出零單價或缺少計價來源；完整 iSM 價格異常規則仍需補齊。' },
  { key: 'quotation-detail', report_name: '報價單明細表', section: '各類明細表', mode: 'detail', kinds: ['quotation'], status: 'partial', note: '以報價單明細承接，保留客戶、品號、幣別、來源鍵與狀態。' },
  { key: 'customer-order-detail', report_name: '客戶訂單明細表', section: '各類明細表', mode: 'detail', kinds: ['sales_order'], status: 'partial', note: '以訂單明細承接，保留已交量、未交量與來源鍵。' },
  { key: 'order-change-detail', report_name: '訂單變更明細表', section: '各類明細表', mode: 'order_change_detail', status: 'partial', note: '以訂單變更草稿／核准紀錄承接，版本與受控解結歷程可追溯。' },
  { key: 'shipment-detail', report_name: '銷貨單明細表', section: '各類明細表', mode: 'detail', kinds: ['shipment'], status: 'partial', note: '以已過帳銷貨明細承接，庫存過帳狀態與來源鍵一併呈現。' },
  { key: 'sales-return-detail', report_name: '銷退單明細表', section: '各類明細表', mode: 'detail', kinds: ['sales_return'], status: 'partial', note: '銷退／折讓共用銷售來源；回庫與應收減項狀態一併呈現。' },
  { key: 'contract-detail', report_name: '合約訂單明細表', section: '各類明細表', mode: 'contract_detail', status: 'partial', note: '以目標 ERP 合約及合約明細承接，尚待完整 iSM 欄位對照。' },
  { key: 'contract-shipment-detail', report_name: '合約訂單銷貨明細表', section: '各類明細表', mode: 'contract_shipment_detail', kinds: ['shipment'], status: 'partial', note: '以銷貨來源合約／訂單關聯承接；無來源關聯的獨立銷貨仍保留為獨立起點。' },
  { key: 'customer-order-fo-detail', report_name: '客戶訂單 F/O 明細表', section: '各類明細表', mode: 'unavailable', status: 'planned', note: '目前目標結構尚無獨立 F/O 欄位，先列出文件落差，不自行新增資料表。' },
  { key: 'customer-shipment-schedule', report_name: '客戶別商品出貨排程表', section: '其他表單', mode: 'schedule', status: 'partial', note: '以交期排程表與訂單明細承接，排程不直接扣庫存。' },
  { key: 'return-reason-analysis', report_name: '銷退原因分析表', section: '其他表單', mode: 'return_reason', kinds: ['sales_return'], status: 'partial', note: '目前以銷退／折讓備註作為原因來源，正式原因代碼與統計維度仍待補齊。' },
  { key: 'deposit-settlement-status', report_name: '訂金結帳狀況表(訂單)', section: '其他表單', mode: 'unavailable', status: 'planned', note: '目前尚無獨立訂金來源欄位，先保留文件落差，不以一般應收金額冒充訂金。' },
  { key: 'pick-list-print', report_name: '揀貨單列印作業', section: '管理維護作業', mode: 'pick_list', status: 'partial', note: '以揀貨單與訂單明細承接，可追蹤揀貨量與已揀量；正式列印版仍由中心承接。' },
  { key: 'pricing-detail', report_name: '計價資料明細表', section: '商品價格管理', mode: 'pricing_detail', status: 'partial', note: '已可查目標 ERP 計價版本、分量級距、有效日、來源鍵與事件；原始 COPMB／COPMC 對照、特價產生與正式列印格式仍由價格維護頁承接。' }
]);
const salesReportByKey = new Map(salesReportCatalog.map(report => [report.key, report]));

function reportStatusLabel(status) {
  return ({ done: '已完成', partial: '部分完成', planned: '尚未完成' }[status] || status || '—');
}

function normalizeRow(row, numericFields) {
  const output = { ...row };
  for (const field of numericFields) output[field] = numeric(row[field]);
  if (output.document_date instanceof Date) output.document_date = output.document_date.toISOString().slice(0, 10);
  if (output.last_movement_date instanceof Date) output.last_movement_date = output.last_movement_date.toISOString().slice(0, 10);
  return output;
}

function buildSalesWhere(req, context, fromDate, toDate) {
  const where = [
    'd.tenant_id=?', 'd.company_id=?', 'd.source_system=?', 'd.source_database=?',
    `((d.document_kind IN ('quotation','sales_order') AND d.status IN (${ACTIVE_SALES_STATUSES.map(() => '?').join(',')}))
      OR (d.document_kind IN ('shipment','sales_return') AND d.status='posted'))`
  ];
  const params = [context.tenant_id, context.company_id, context.source_system, context.source_database, ...ACTIVE_SALES_STATUSES];
  if (fromDate) {
    where.push('d.document_date>=?');
    params.push(fromDate);
  }
  if (toDate) {
    where.push('d.document_date<=?');
    params.push(toDate);
  }
  const requestedKinds = trim(req.query.document_kind || req.query.kinds);
  if (requestedKinds) {
    const kinds = [...new Set(requestedKinds.split(',').map(value => trim(value).toLowerCase()).filter(Boolean))];
    if (!kinds.length || kinds.some(kind => !SALES_DOCUMENT_KINDS.has(kind))) throw badRequest('不支援的銷售分析單據種類');
    where.push(`d.document_kind IN (${kinds.map(() => '?').join(',')})`);
    params.push(...kinds);
  }
  addEqual(where, params, req.query.document_type, 'd.document_type');
  addEqual(where, params, req.query.customer_code, 'd.customer_code');
  addRange(where, params, req.query.customer_from, req.query.customer_to, 'd.customer_code');
  addEqual(where, params, req.query.item_code, 'i.item_code');
  addRange(where, params, req.query.item_from, req.query.item_to, 'i.item_code');
  addEqual(where, params, req.query.department_code, 'em.department_code');
  addRange(where, params, req.query.department_from, req.query.department_to, 'em.department_code');
  addEqual(where, params, req.query.salesperson_code, 'd.salesperson_code');
  addRange(where, params, req.query.salesperson_from, req.query.salesperson_to, 'd.salesperson_code');
  addEqual(where, params, req.query.warehouse_code, warehouseExpression);
  addEqual(where, params, req.query.currency_code, 'd.currency_code');
  const category = trim(req.query.category_code);
  if (category) {
    where.push(`${categoryExpression} LIKE ?`);
    params.push(`%${category}%`);
  }
  return { where, params };
}

function reportColumns(report) {
  const common = [
    ['document_no', '單號'], ['document_date', '日期'], ['document_kind', '單據種類'],
    ['customer_code', '客戶'], ['customer_name', '客戶名稱'], ['item_code', '品號'],
    ['item_name', '品名'], ['currency_code', '幣別'], ['quantity', '數量'],
    ['related_quantity', '已交／關聯量'], ['remaining_quantity', '剩餘量'],
    ['unit_price', '單價'], ['amount', '金額'], ['status', '狀態'],
    ['inventory_status', '庫存狀態'], ['source_kind', '來源種類'],
    ['source_document_no', '來源單號'], ['source_key', '來源鍵']
  ];
  const summary = {
    customer_order_summary: [
      ['customer_code', '客戶'], ['customer_name', '客戶名稱'], ['currency_code', '幣別'],
      ['document_count', '訂單張數'], ['line_count', '明細數'], ['order_quantity', '訂單量'],
      ['delivered_quantity', '已交量'], ['remaining_quantity', '未交量'],
      ['order_amount', '訂單金額'], ['delivered_amount', '已交金額'],
      ['remaining_amount', '未交金額'], ['source_key_sample', '來源鍵（樣本）']
    ],
    customer_sales_summary: [
      ['customer_code', '客戶'], ['customer_name', '客戶名稱'], ['currency_code', '幣別'],
      ['document_count', '銷貨張數'], ['line_count', '明細數'], ['sales_quantity', '銷貨量'],
      ['sales_amount', '銷貨金額'], ['return_quantity', '銷退量'], ['return_amount', '銷退金額'],
      ['net_sales_amount', '銷貨淨額'], ['source_key_sample', '來源鍵（樣本）']
    ],
    order_profit: [
      ['document_no', '訂單'], ['document_date', '日期'], ['customer_code', '客戶'],
      ['customer_name', '客戶名稱'], ['currency_code', '幣別'], ['document_count', '訂單張數'],
      ['line_count', '明細數'], ['order_quantity', '訂單量'], ['delivered_quantity', '已交量'],
      ['remaining_quantity', '未交量'], ['order_amount', '訂單金額'], ['cost_amount', '明細成本'],
      ['profit_amount', '預估利潤'], ['cost_coverage_rate', '成本覆蓋率'], ['source_key_sample', '來源鍵（樣本）']
    ],
    department_sales_period: [
      ['period_code', '期間'], ['department_code', '部門'], ['department_name', '部門名稱'],
      ['currency_code', '幣別'], ['document_count', '銷貨張數'], ['line_count', '明細數'],
      ['sales_quantity', '銷貨量'], ['sales_amount', '銷貨金額'], ['return_quantity', '銷退量'],
      ['return_amount', '銷退金額'], ['net_sales_amount', '銷貨淨額'], ['source_key_sample', '來源鍵（樣本）']
    ]
  };
  if (summary[report.mode]) return summary[report.mode];
  if (report.mode === 'pricing_detail') return [
    ['customer_code', '客戶'], ['customer_name', '客戶名稱'], ['item_code', '品號'], ['item_name', '品名'],
    ['pricing_unit', '計價單位'], ['currency_code', '幣別'], ['unit_price', '單價'],
    ['discount_rate_percent', '折扣率(%)'], ['tax_included', '含稅'], ['quantity_pricing_flag', '分量計價'],
    ['tier_count', '分量級距'], ['effective_from', '生效日'], ['effective_to', '失效日'],
    ['effective_status', '生效狀態'], ['status', '核准狀態'], ['is_active', '啟用'],
    ['source_kind', '來源種類'], ['source_document_no', '來源單號'], ['source_table', '來源表'],
    ['event_count', '事件數'], ['source_key', '來源鍵']
  ];
  if (report.mode === 'shipped_not_invoiced') return [
    ['document_no', '銷貨單'], ['document_date', '銷貨日期'], ['customer_code', '客戶'],
    ['customer_name', '客戶名稱'], ['item_code', '品號'], ['item_name', '品名'], ['currency_code', '幣別'],
    ['quantity', '銷貨量'], ['amount', '銷貨金額'], ['invoiced_amount', '已開票金額'],
    ['uninvoiced_amount', '未開票金額'], ['invoice_status', '發票狀態'], ['invoice_numbers', '發票號碼'],
    ['source_key', '來源鍵']
  ];
  if (report.mode === 'price_exception') return [
    ['document_no', '單號'], ['document_date', '日期'], ['document_kind', '單據種類'],
    ['customer_code', '客戶'], ['item_code', '品號'], ['currency_code', '幣別'],
    ['quantity', '數量'], ['unit_price', '單價'], ['amount', '金額'], ['exception_reason', '異常原因'],
    ['status', '狀態'], ['price_source_kind', '計價來源'], ['price_source_no', '計價來源單號'], ['source_key', '來源鍵']
  ];
  if (report.mode === 'pick_list') return [
    ['pick_no', '揀貨單'], ['pick_date', '揀貨日'], ['order_no', '訂單'], ['customer_code', '客戶'],
    ['warehouse_code', '庫別'], ['item_code', '品號'], ['quantity', '揀貨量'],
    ['picked_quantity', '已揀量'], ['remaining_pick_quantity', '待揀量'], ['status', '狀態'], ['source_key', '來源鍵']
  ];
  if (report.mode === 'schedule') return [
    ['schedule_no', '排程單號'], ['scheduled_date', '預計出貨日'], ['order_no', '訂單'],
    ['customer_code', '客戶'], ['item_code', '品號'], ['warehouse_code', '庫別'],
    ['quantity', '排程量'], ['fulfilled_quantity', '已履約量'], ['remaining_schedule_quantity', '剩餘排程量'],
    ['status', '狀態'], ['source_key', '來源鍵']
  ];
  if (report.mode === 'order_change_detail') return [
    ['change_no', '變更單'], ['change_date', '變更日期'], ['document_no', '訂單'],
    ['customer_code', '客戶'], ['item_code', '品號'], ['old_quantity', '原數量'],
    ['new_quantity', '新數量'], ['new_unit_price', '新單價'], ['status', '狀態'],
    ['reason', '變更原因'], ['source_key', '來源鍵']
  ];
  if (report.mode === 'contract_detail') return [
    ['contract_no', '合約'], ['contract_date', '合約日期'], ['customer_code', '客戶'],
    ['item_code', '品號'], ['quantity', '合約量'], ['converted_quantity', '已轉訂單量'],
    ['remaining_quantity', '剩餘量'], ['unit_price', '單價'], ['amount', '金額'],
    ['status', '狀態'], ['source_key', '來源鍵']
  ];
  if (report.mode === 'return_reason') return [
    ['reason', '銷退／折讓原因'], ['currency_code', '幣別'], ['document_count', '單據張數'],
    ['quantity', '數量'], ['amount', '金額'], ['source_key_sample', '來源鍵（樣本）']
  ];
  return common;
}

function normalizeDateValue(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function normalizeSalesReportRow(raw, context) {
  const documentKind = trim(raw.document_kind);
  const quantity = Math.max(numeric(raw.quantity), 0);
  const relatedQuantity = Math.min(Math.max(numeric(raw.related_quantity), 0), quantity);
  const unitPrice = numeric(raw.unit_price);
  const unitCost = numeric(raw.unit_cost);
  const allowance = Math.max(numeric(raw.allowance_amount), 0);
  const amount = Math.max(quantity * unitPrice - allowance, 0);
  const orderAmount = documentKind === 'sales_order' ? amount : 0;
  const deliveredQuantity = documentKind === 'sales_order' ? relatedQuantity : 0;
  const deliveredAmount = documentKind === 'sales_order' ? deliveredQuantity * unitPrice : 0;
  const remainingQuantity = documentKind === 'sales_order' ? Math.max(quantity - deliveredQuantity, 0) : 0;
  const remainingAmount = documentKind === 'sales_order' ? Math.max(orderAmount - deliveredAmount, 0) : 0;
  const shipmentQuantity = documentKind === 'shipment' ? quantity : 0;
  const shipmentAmount = documentKind === 'shipment' ? amount : 0;
  const returnQuantity = documentKind === 'sales_return' && trim(raw.return_type) === 'return' ? quantity : 0;
  const returnAmount = documentKind === 'sales_return'
    ? (trim(raw.return_type) === 'allowance' ? Math.max(allowance, quantity * unitPrice) : amount)
    : 0;
  const sourceKey = `${context.source_database}|${documentKind || 'unknown'}|${raw.document_id || ''}|${raw.item_id || ''}`;
  const output = {
    ...raw,
    document_date: normalizeDateValue(raw.document_date),
    expected_date: normalizeDateValue(raw.expected_date),
    quantity,
    related_quantity: relatedQuantity,
    unit_price: unitPrice,
    unit_cost: unitCost,
    allowance_amount: allowance,
    amount,
    order_quantity: documentKind === 'sales_order' ? quantity : 0,
    order_amount: orderAmount,
    delivered_quantity: deliveredQuantity,
    delivered_amount: deliveredAmount,
    remaining_quantity: remainingQuantity,
    remaining_amount: remainingAmount,
    shipment_quantity: shipmentQuantity,
    shipment_amount: shipmentAmount,
    sales_quantity: shipmentQuantity,
    sales_amount: shipmentAmount,
    return_quantity: returnQuantity,
    return_amount: returnAmount,
    cost_amount: quantity * unitCost,
    cost_covered_line: unitCost > EPSILON ? 1 : 0,
    source_database: context.source_database,
    company_id: context.company_id,
    tenant_id: context.tenant_id,
    source_system: context.source_system,
    source_key: sourceKey
  };
  if (raw.invoiced_amount !== undefined) {
    output.invoiced_amount = numeric(raw.invoiced_amount);
    output.uninvoiced_amount = Math.max(shipmentAmount - output.invoiced_amount, 0);
  }
  return output;
}

function addReportFilter(where, params, value, expression) {
  const text = trim(value);
  if (text) {
    where.push(`${expression}=?`);
    params.push(text);
  }
}

async function loadSalesReportBaseRows(req, context, report, fromDate, toDate, limit) {
  const { where, params } = buildSalesWhere(req, context, fromDate, toDate);
  if (Array.isArray(report.kinds) && report.kinds.length) {
    where.push(`d.document_kind IN (${report.kinds.map(() => '?').join(',')})`);
    params.push(...report.kinds);
  }
  const invoiceJoin = report.mode === 'shipped_not_invoiced' ? `
    LEFT JOIN (
      SELECT vs.source_document_id,vs.source_document_item_id,
        COALESCE(SUM(CASE WHEN fv.status IN ('approved','posted') AND fv.invoice_status IN ('issued','received') THEN vs.allocated_amount ELSE 0 END),0) AS invoiced_amount,
        GROUP_CONCAT(DISTINCT CASE WHEN fv.status IN ('approved','posted') AND fv.invoice_status IN ('issued','received') THEN fv.invoice_status END ORDER BY fv.invoice_status SEPARATOR '、') AS invoice_status,
        GROUP_CONCAT(DISTINCT CASE WHEN fv.status IN ('approved','posted') AND fv.invoice_status IN ('issued','received') THEN COALESCE(fv.invoice_no,'待補發票') END ORDER BY fv.invoice_no SEPARATOR '、') AS invoice_numbers
      FROM finance_voucher_sources vs
      JOIN finance_vouchers fv ON fv.id=vs.voucher_id
      WHERE vs.source_kind='shipment' AND fv.account_type='AR'
        AND fv.tenant_id=? AND fv.company_id=? AND fv.source_system=? AND fv.source_database=?
        AND fv.status<>'voided'
      GROUP BY vs.source_document_id,vs.source_document_item_id
    ) invoice_sources ON invoice_sources.source_document_id=d.id AND invoice_sources.source_document_item_id=i.id` : '';
  const invoiceParams = report.mode === 'shipped_not_invoiced'
    ? [context.tenant_id, context.company_id, context.source_system, context.source_database]
    : [];
  const invoiceSelect = report.mode === 'shipped_not_invoiced'
    ? 'invoice_sources.invoiced_amount,invoice_sources.invoice_status,invoice_sources.invoice_numbers'
    : '0 AS invoiced_amount,NULL AS invoice_status,NULL AS invoice_numbers';
  const [rows] = await pool.query(`
    SELECT d.id AS document_id,d.document_kind,d.document_type,d.document_no,d.document_date,d.status,d.inventory_status,
      d.return_type,d.contract_id,d.customer_code,cm.customer_name,d.salesperson_code,em.employee_name,
      em.department_code,dp.department_name,COALESCE(i.warehouse_code,d.warehouse_code) AS warehouse_code,
      d.currency_code,i.id AS item_id,i.line_no,i.source_item_id,i.contract_item_id,i.item_code,
      COALESCE(NULLIF(i.item_name,''),im.item_name) AS item_name,im.specification,im.category_1,im.category_2,im.category_3,im.category_4,
      i.quantity,i.related_quantity,i.unit_price,i.unit_cost,i.expected_date,i.allowance_amount,
      i.price_source_kind,i.price_source_id,i.price_source_no,
      COALESCE(src_d.document_kind,src_h.document_kind) AS source_kind,
      COALESCE(src_d.document_no,src_h.document_no) AS source_document_no,
      COALESCE(src_d.id,src_h.id) AS source_document_id,
      src_i.id AS source_document_item_id,
      ${invoiceSelect}
    ${salesFromSql}
    ${invoiceJoin}
    WHERE ${where.join(' AND ')}
    ORDER BY d.document_date DESC,d.document_no,i.line_no
    LIMIT ?`, [...invoiceParams, ...params, limit]);
  return rows.map(row => normalizeSalesReportRow(row, context));
}

function reportGroup(rows, keys, metricFields) {
  const groups = new Map();
  for (const row of rows) {
    const key = keys.map(field => String(row[field] ?? '')).join('\u0000');
    let group = groups.get(key);
    if (!group) {
      group = { report_row_kind: 'summary', ...Object.fromEntries(keys.map(field => [field, row[field] ?? null])), document_count: 0, line_count: 0, source_key_sample: '', source_document_sample: '', _documents: new Set(), _sources: new Set(), _sourceDocuments: new Set(), _statuses: new Set() };
      for (const field of metricFields) group[field] = 0;
      groups.set(key, group);
    }
    group._documents.add(String(row.document_id || ''));
    group._sources.add(String(row.source_key || ''));
    group._sourceDocuments.add(String(row.document_no || ''));
    if (row.status) group._statuses.add(String(row.status));
    group.line_count += 1;
    for (const field of metricFields) group[field] += numeric(row[field]);
  }
  return [...groups.values()].map(group => {
    group.document_count = group._documents.size;
    group.source_key_sample = [...group._sources].filter(Boolean).slice(0, 5).join('、');
    group.source_document_sample = [...group._sourceDocuments].filter(Boolean).slice(0, 5).join('、');
    group.status_codes = [...group._statuses].join('、');
    delete group._documents;
    delete group._sources;
    delete group._sourceDocuments;
    delete group._statuses;
    return group;
  });
}

function summarizeSalesReportRows(rows) {
  const grouped = rows.some(row => row.report_row_kind === 'summary');
  const summary = {
    row_count: rows.length,
    document_count: grouped ? rows.reduce((sum, row) => sum + numeric(row.document_count), 0) : new Set(rows.map(row => String(row.document_id || row.document_no || row.pick_no || row.contract_no || ''))).size,
    line_count: grouped ? rows.reduce((sum, row) => sum + numeric(row.line_count), 0) : rows.length,
    quantity: 0,
    order_quantity: 0,
    sales_quantity: 0,
    delivered_quantity: 0,
    remaining_quantity: 0,
    amount: 0,
    order_amount: 0,
    sales_amount: 0,
    return_amount: 0,
    net_sales_amount: 0,
    cost_amount: 0,
    profit_amount: 0,
    invoiced_amount: 0,
    uninvoiced_amount: 0,
    exception_count: 0
  };
  for (const row of rows) {
    for (const field of ['quantity', 'order_quantity', 'sales_quantity', 'delivered_quantity', 'remaining_quantity', 'amount', 'order_amount', 'sales_amount', 'return_amount', 'net_sales_amount', 'cost_amount', 'profit_amount', 'invoiced_amount', 'uninvoiced_amount']) summary[field] += numeric(row[field]);
    if (row.exception_reason) summary.exception_count += 1;
  }
  if (!summary.quantity) summary.quantity = summary.order_quantity || summary.sales_quantity;
  if (!summary.sales_amount) summary.sales_amount = rows.reduce((sum, row) => sum + numeric(row.shipment_amount), 0);
  if (!summary.return_amount) summary.return_amount = rows.reduce((sum, row) => sum + numeric(row.return_amount), 0);
  if (!summary.net_sales_amount) summary.net_sales_amount = summary.sales_amount - summary.return_amount;
  return summary;
}

async function loadSalesScheduleReport(req, context, fromDate, toDate, limit) {
  const where = ['p.tenant_id=?', 'p.company_id=?', 'p.source_system=?', 'p.source_database=?'];
  const params = [context.tenant_id, context.company_id, context.source_system, context.source_database];
  if (fromDate) { where.push('p.scheduled_date>=?'); params.push(fromDate); }
  if (toDate) { where.push('p.scheduled_date<=?'); params.push(toDate); }
  addReportFilter(where, params, req.query.customer_code, 'p.customer_code');
  addReportFilter(where, params, req.query.item_code, 'p.item_code');
  // iSM 排程結構只保存訂單／品號／日期／數量，庫別沿用來源訂單的庫別，
  // 不假設排程表存在未定義的 warehouse_code 欄位。
  addReportFilter(where, params, req.query.warehouse_code, 'd.warehouse_code');
  if (trim(req.query.order_id)) { where.push('p.order_id=?'); params.push(Number(req.query.order_id)); }
  const [rows] = await pool.query(`
    SELECT p.id AS schedule_id,p.schedule_no,p.scheduled_date,p.quantity,p.fulfilled_quantity,p.status,
      p.order_id,d.document_no AS order_no,p.customer_code,p.item_code,d.warehouse_code,
      p.order_item_id AS item_id
    FROM erp_sales_delivery_schedules p
    JOIN sales_documents d ON d.id=p.order_id AND d.tenant_id=p.tenant_id AND d.company_id=p.company_id
      AND d.source_system=p.source_system AND d.source_database=p.source_database
    WHERE ${where.join(' AND ')}
    ORDER BY p.scheduled_date DESC,p.schedule_no
    LIMIT ?`, [...params, limit]);
  return rows.map(row => ({ ...row, scheduled_date: normalizeDateValue(row.scheduled_date), remaining_schedule_quantity: Math.max(numeric(row.quantity) - numeric(row.fulfilled_quantity), 0), source_database: context.source_database, company_id: context.company_id, tenant_id: context.tenant_id, source_system: context.source_system, source_key: `${context.source_database}|sales_order|${row.order_id}|${row.item_id}` }));
}

async function loadSalesPickReport(req, context, fromDate, toDate, limit) {
  const where = ['p.tenant_id=?', 'p.company_id=?', 'p.source_system=?', 'p.source_database=?'];
  const params = [context.tenant_id, context.company_id, context.source_system, context.source_database];
  if (fromDate) { where.push('p.pick_date>=?'); params.push(fromDate); }
  if (toDate) { where.push('p.pick_date<=?'); params.push(toDate); }
  addReportFilter(where, params, req.query.customer_code, 'd.customer_code');
  addReportFilter(where, params, req.query.item_code, 'pi.item_code');
  addReportFilter(where, params, req.query.warehouse_code, 'p.warehouse_code');
  if (trim(req.query.order_id)) { where.push('p.order_id=?'); params.push(Number(req.query.order_id)); }
  const [rows] = await pool.query(`
    SELECT p.id AS pick_list_id,p.pick_no,p.pick_date,p.status,p.order_id,d.document_no AS order_no,d.customer_code,
      p.warehouse_code,pi.order_item_id AS item_id,pi.item_code,pi.quantity,pi.picked_quantity
    FROM erp_sales_pick_lists p
    JOIN sales_documents d ON d.id=p.order_id AND d.tenant_id=p.tenant_id AND d.company_id=p.company_id
      AND d.source_system=p.source_system AND d.source_database=p.source_database
    LEFT JOIN erp_sales_pick_list_items pi ON pi.pick_list_id=p.id
    WHERE ${where.join(' AND ')}
    ORDER BY p.pick_date DESC,p.pick_no,pi.id
    LIMIT ?`, [...params, limit]);
  return rows.map(row => ({ ...row, pick_date: normalizeDateValue(row.pick_date), quantity: numeric(row.quantity), picked_quantity: numeric(row.picked_quantity), remaining_pick_quantity: Math.max(numeric(row.quantity) - numeric(row.picked_quantity), 0), source_database: context.source_database, company_id: context.company_id, tenant_id: context.tenant_id, source_system: context.source_system, source_key: `${context.source_database}|sales_order|${row.order_id}|${row.item_id || ''}` }));
}

async function loadSalesOrderChangeReport(req, context, fromDate, toDate, limit) {
  const where = ['c.tenant_id=?', 'c.company_id=?', 'c.source_system=?', 'c.source_database=?'];
  const params = [context.tenant_id, context.company_id, context.source_system, context.source_database];
  if (fromDate) { where.push('c.change_date>=?'); params.push(fromDate); }
  if (toDate) { where.push('c.change_date<=?'); params.push(toDate); }
  addReportFilter(where, params, req.query.customer_code, 'd.customer_code');
  addReportFilter(where, params, req.query.item_code, 'i.item_code');
  const [rows] = await pool.query(`
    SELECT c.id AS change_id,c.change_no,c.change_date,c.status,c.reason,c.old_quantity,c.new_quantity,c.old_unit_price,c.new_unit_price,c.new_expected_date,
      d.id AS document_id,d.document_no,d.document_date,d.customer_code,i.id AS item_id,i.item_code
    FROM sales_order_changes c
    JOIN sales_document_items i ON i.id=c.order_item_id
    JOIN sales_documents d ON d.id=i.document_id AND d.tenant_id=c.tenant_id AND d.company_id=c.company_id
      AND d.source_system=c.source_system AND d.source_database=c.source_database
    WHERE ${where.join(' AND ')}
    ORDER BY c.change_date DESC,c.change_no
    LIMIT ?`, [...params, limit]);
  return rows.map(row => ({ ...row, change_date: normalizeDateValue(row.change_date), document_date: normalizeDateValue(row.document_date), new_expected_date: normalizeDateValue(row.new_expected_date), source_database: context.source_database, company_id: context.company_id, tenant_id: context.tenant_id, source_system: context.source_system, source_key: `${context.source_database}|sales_order_change|${row.change_id}|${row.item_id}` }));
}

async function loadSalesContractReport(req, context, fromDate, toDate, limit) {
  const where = ['c.tenant_id=?', 'c.company_id=?', 'c.source_system=?', 'c.source_database=?'];
  const params = [context.tenant_id, context.company_id, context.source_system, context.source_database];
  if (fromDate) { where.push('c.contract_date>=?'); params.push(fromDate); }
  if (toDate) { where.push('c.contract_date<=?'); params.push(toDate); }
  addReportFilter(where, params, req.query.customer_code, 'c.customer_code');
  addReportFilter(where, params, req.query.item_code, 'ci.item_code');
  const [rows] = await pool.query(`
    SELECT c.id AS contract_id,c.contract_no,c.contract_date,c.status,c.customer_code,c.currency_code,
      ci.id AS item_id,ci.line_no,ci.item_code,ci.item_name,ci.quantity,ci.converted_quantity,ci.unit_price,ci.amount,ci.expected_date
    FROM erp_sales_contracts c
    JOIN erp_sales_contract_items ci ON ci.contract_id=c.id
    WHERE ${where.join(' AND ')}
    ORDER BY c.contract_date DESC,c.contract_no,ci.line_no
    LIMIT ?`, [...params, limit]);
  return rows.map(row => ({ ...row, contract_date: normalizeDateValue(row.contract_date), expected_date: normalizeDateValue(row.expected_date), quantity: numeric(row.quantity), converted_quantity: numeric(row.converted_quantity), remaining_quantity: Math.max(numeric(row.quantity) - numeric(row.converted_quantity), 0), unit_price: numeric(row.unit_price), amount: numeric(row.amount), source_database: context.source_database, company_id: context.company_id, tenant_id: context.tenant_id, source_system: context.source_system, source_key: `${context.source_database}|sales_contract|${row.contract_id}|${row.item_id}` }));
}

function pricingEffectiveStatus(row, asOfDate) {
  if (trim(row.status) === 'voided') return '已作廢';
  if (!numeric(row.is_active)) return '已停用';
  if (trim(row.status) !== 'approved') return '待核准';
  const date = asOfDate || new Date().toISOString().slice(0, 10);
  const from = normalizeDateValue(row.effective_from);
  const to = normalizeDateValue(row.effective_to);
  if (from && from > date) return '尚未生效';
  if (to && to < date) return '已失效';
  return '生效中';
}

async function loadSalesPricingDetailReport(req, context, fromDate, toDate, limit, asOfDate) {
  const where = ['p.tenant_id=?', 'p.company_id=?', 'p.source_system=?', 'p.source_database=?'];
  const params = [context.tenant_id, context.company_id, context.source_system, context.source_database];
  if (fromDate) { where.push('p.effective_from>=?'); params.push(fromDate); }
  if (toDate) { where.push('p.effective_from<=?'); params.push(toDate); }
  addReportFilter(where, params, req.query.customer_code, 'p.customer_code');
  addReportFilter(where, params, req.query.item_code, 'p.item_code');
  addReportFilter(where, params, req.query.currency_code, 'p.currency_code');
  addReportFilter(where, params, req.query.status, 'p.status');
  if (trim(req.query.active_only) === '1') where.push('p.is_active=1');
  const [rows] = await pool.query(`
    SELECT p.id AS pricing_id,p.customer_code,c.customer_name,p.item_code,i.item_name,i.specification,
      p.pricing_unit,p.currency_code,p.unit_price,p.discount_rate,p.tax_included,p.quantity_pricing_flag,p.trade_condition,
      p.effective_from,p.effective_to,p.status,p.is_active,p.source_kind,p.source_document_no,p.source_document_type,
      p.source_table,p.source_key,
      (SELECT COUNT(*) FROM erp_customer_item_price_tiers t WHERE t.pricing_id=p.id) AS tier_count,
      (SELECT COUNT(*) FROM erp_customer_item_price_events pe WHERE pe.pricing_id=p.id
        AND pe.tenant_id=p.tenant_id AND pe.company_id=p.company_id
        AND pe.source_system=p.source_system AND pe.source_database=p.source_database) AS event_count
    FROM erp_customer_item_prices p
    LEFT JOIN erp_customers c ON c.tenant_id=p.tenant_id AND c.company_id=p.company_id AND c.source_system=p.source_system
      AND c.source_database=p.source_database AND c.customer_code=p.customer_code
    LEFT JOIN erp_items i ON i.tenant_id=p.tenant_id AND i.company_id=p.company_id AND i.source_system=p.source_system
      AND i.source_database=p.source_database AND i.item_code=p.item_code
    WHERE ${where.join(' AND ')}
    ORDER BY p.customer_code,p.item_code,p.effective_from DESC,p.id DESC
    LIMIT ?`, [...params, limit]);
  return rows.map(row => ({
    ...row,
    effective_from: normalizeDateValue(row.effective_from),
    effective_to: normalizeDateValue(row.effective_to),
    unit_price: numeric(row.unit_price),
    discount_rate: row.discount_rate === null || row.discount_rate === undefined ? null : numeric(row.discount_rate),
    discount_rate_percent: row.discount_rate === null || row.discount_rate === undefined ? null : Number((numeric(row.discount_rate) * 100).toFixed(4)),
    tax_included: numeric(row.tax_included),
    quantity_pricing_flag: numeric(row.quantity_pricing_flag),
    tier_count: numeric(row.tier_count),
    event_count: numeric(row.event_count),
    is_active: numeric(row.is_active),
    effective_status: pricingEffectiveStatus(row, asOfDate),
    source_database: context.source_database,
    company_id: context.company_id,
    tenant_id: context.tenant_id,
    source_system: context.source_system,
    source_key: trim(row.source_key) || `${context.source_database}|customer_price|${row.pricing_id}|${row.customer_code}|${row.item_code}`
  }));
}

function reportSourceDefinitions(report) {
  const tables = report.mode === 'pricing_detail'
    ? 'erp_customer_item_prices + erp_customer_item_price_tiers + erp_customer_item_price_events + ERP 主檔對照'
    : report.mode === 'schedule'
    ? 'erp_sales_delivery_schedules + sales_documents'
    : report.mode === 'pick_list'
      ? 'erp_sales_pick_lists + erp_sales_pick_list_items + sales_documents'
      : report.mode === 'order_change_detail'
        ? 'sales_order_changes + sales_documents + sales_document_items'
        : report.mode === 'contract_detail'
          ? 'erp_sales_contracts + erp_sales_contract_items'
          : report.mode === 'shipped_not_invoiced'
            ? 'sales_documents + sales_document_items + finance_vouchers + finance_voucher_sources'
            : 'sales_documents + sales_document_items + ERP 主檔對照';
  const trace = report.mode === 'pricing_detail'
    ? 'source_database + pricing_id + customer_code + item_code + effective_from + source_key'
    : report.mode === 'schedule'
    ? 'source_database + order_id + order_item_id + schedule_no'
    : report.mode === 'pick_list'
      ? 'source_database + order_id + order_item_id + pick_no'
      : report.mode === 'order_change_detail'
        ? 'source_database + change_id + order_item_id + change_no'
        : report.mode === 'contract_detail'
          ? 'source_database + contract_id + item_id + contract_no'
          : 'source_database + document_id + item_id + document_no + line_no';
  return [{
    source: report.report_name,
    tables,
    evidence: '《iSM-訂單管理系統》正式報表名稱／目標 ERP 結構',
    trace,
    rule: report.note
  }];
}

function reportColumnsAsObjects(report) {
  return reportColumns(report).map(([key, label]) => ({ key, label }));
}

async function buildSalesReportRows(req, context, report, fromDate, toDate, limit) {
  if (report.mode === 'pricing_detail') return loadSalesPricingDetailReport(req, context, fromDate, toDate, limit, optionalDate(req.query.as_of_date) || toDate || null);
  if (report.mode === 'unavailable') return [];
  if (report.mode === 'schedule') return loadSalesScheduleReport(req, context, fromDate, toDate, limit);
  if (report.mode === 'pick_list') return loadSalesPickReport(req, context, fromDate, toDate, limit);
  if (report.mode === 'order_change_detail') return loadSalesOrderChangeReport(req, context, fromDate, toDate, limit);
  if (report.mode === 'contract_detail') return loadSalesContractReport(req, context, fromDate, toDate, limit);

  let rows = await loadSalesReportBaseRows(req, context, report, fromDate, toDate, limit);
  if (report.mode === 'price_exception') {
    rows = rows.map(row => ({
      ...row,
      exception_reason: [numeric(row.unit_price) <= EPSILON ? '單價小於等於 0' : '', trim(row.price_source_kind) ? '' : '缺少計價來源'].filter(Boolean).join('；')
    })).filter(row => row.exception_reason);
  }
  if (report.mode === 'customer_order_summary') {
    return reportGroup(rows, ['customer_code', 'customer_name', 'currency_code'], ['order_quantity', 'delivered_quantity', 'remaining_quantity', 'order_amount', 'delivered_amount', 'remaining_amount']);
  }
  if (report.mode === 'customer_sales_summary') {
    return reportGroup(rows.map(row => ({ ...row, sales_quantity: row.shipment_quantity, sales_amount: row.shipment_amount, net_sales_amount: row.shipment_amount - row.return_amount })), ['customer_code', 'customer_name', 'currency_code'], ['sales_quantity', 'sales_amount', 'return_quantity', 'return_amount', 'net_sales_amount']);
  }
  if (report.mode === 'order_profit') {
    const grouped = reportGroup(rows, ['document_id', 'document_no', 'document_date', 'customer_code', 'customer_name', 'currency_code'], ['order_quantity', 'delivered_quantity', 'remaining_quantity', 'order_amount', 'cost_amount', 'cost_covered_line']);
    return grouped.map(row => ({
      ...row,
      profit_amount: numeric(row.order_amount) - numeric(row.cost_amount),
      cost_coverage_rate: row.line_count ? Number(((numeric(row.cost_covered_line) / numeric(row.line_count)) * 100).toFixed(4)) : 0
    }));
  }
  if (report.mode === 'department_sales_period') {
    const prepared = rows.map(row => ({ ...row, period_code: String(row.document_date || '').slice(0, 7), sales_quantity: row.shipment_quantity, sales_amount: row.shipment_amount, net_sales_amount: row.shipment_amount - row.return_amount }));
    return reportGroup(prepared, ['period_code', 'department_code', 'department_name', 'currency_code'], ['sales_quantity', 'sales_amount', 'return_quantity', 'return_amount', 'net_sales_amount']);
  }
  if (report.mode === 'return_reason') {
    const prepared = rows.map(row => ({ ...row, reason: trim(row.note) || '未填寫原因', quantity: row.return_quantity, amount: row.return_amount }));
    return reportGroup(prepared, ['reason', 'currency_code'], ['quantity', 'amount']);
  }
  if (report.mode === 'contract_shipment_detail') {
    return rows.map(row => ({ ...row, contract_source_status: row.contract_id ? '有合約來源' : '獨立銷貨起點' }));
  }
  return rows;
}

function buildInventoryFilters(req, alias, categoryAlias = 'im') {
  const filters = [];
  const params = [];
  const category = `NULLIF(CONCAT_WS('／',NULLIF(${categoryAlias}.category_1,''),NULLIF(${categoryAlias}.category_2,''),NULLIF(${categoryAlias}.category_3,''),NULLIF(${categoryAlias}.category_4,'')),'')`;
  addEqual(filters, params, req.query.item_code, `${alias}.item_code`);
  addRange(filters, params, req.query.item_from, req.query.item_to, `${alias}.item_code`);
  addEqual(filters, params, req.query.warehouse_code, `${alias}.warehouse_code`);
  const categoryCode = trim(req.query.category_code);
  if (categoryCode) {
    filters.push(`${category} LIKE ?`);
    params.push(`%${categoryCode}%`);
  }
  return { filters, params };
}

function buildMovementWhere(req, context, fromDate, toDate) {
  const where = ['m.tenant_id=?', 'm.company_id=?', 'm.source_system=?'];
  const params = [context.tenant_id, context.company_id, context.source_system];
  if (fromDate) {
    where.push('m.movement_date>=?');
    params.push(fromDate);
  }
  if (toDate) {
    where.push('m.movement_date<=?');
    params.push(toDate);
  }
  return { where, params };
}

async function loadInventoryAnalysis(req, context, fromDate, toDate, limit) {
  const balanceFilter = buildInventoryFilters(req, 'b');
  const balanceWhere = ['b.tenant_id=?', 'b.company_id=?', 'b.source_system=?', ...balanceFilter.filters];
  const balanceParams = [context.tenant_id, context.company_id, context.source_system, ...balanceFilter.params];
  const [balanceRows] = await pool.query(`
    SELECT b.item_code,b.warehouse_code,
      MAX(im.item_name) AS item_name,
      MAX(im.specification) AS specification,
      MAX(im.unit) AS unit,
      MAX(${categoryExpression}) AS category_code,
      COALESCE(SUM(b.quantity_on_hand),0) AS current_quantity,
      COALESCE(SUM(b.inventory_amount),0) AS current_amount,
      COALESCE(MAX(b.last_movement_at),NULL) AS balance_last_movement_at
    FROM erp_inventory_balances b
    LEFT JOIN erp_items im
      ON im.tenant_id=b.tenant_id AND im.company_id=b.company_id AND im.source_system=b.source_system
      AND im.source_database=? AND im.item_code=b.item_code
    WHERE ${balanceWhere.join(' AND ')}
    GROUP BY b.item_code,b.warehouse_code
    ORDER BY b.item_code,b.warehouse_code`, [context.source_database, ...balanceParams]);

  const movementFilter = buildInventoryFilters(req, 'm');
  const movementRange = buildMovementWhere(req, context, fromDate, toDate);
  const movementWhere = [...movementRange.where, ...movementFilter.filters];
  const movementParams = [...movementRange.params, ...movementFilter.params];
  const movementSqlFrom = `
    FROM inventory_movement_ledger m
    LEFT JOIN erp_items im
      ON im.tenant_id=m.tenant_id AND im.company_id=m.company_id AND im.source_system=m.source_system
      AND im.source_database=? AND im.item_code=m.item_code`;
  const movementSelect = `
    SELECT m.item_code,m.warehouse_code,
      MAX(im.item_name) AS item_name,
      MAX(im.specification) AS specification,
      MAX(im.unit) AS unit,
      MAX(NULLIF(CONCAT_WS('／',NULLIF(im.category_1,''),NULLIF(im.category_2,''),NULLIF(im.category_3,''),NULLIF(im.category_4,'')),'')) AS category_code,
      COALESCE(SUM(m.quantity_delta),0) AS period_net_quantity,
      COALESCE(SUM(CASE WHEN m.quantity_delta>0 THEN m.quantity_delta ELSE 0 END),0) AS period_in_quantity,
      COALESCE(SUM(CASE WHEN m.quantity_delta<0 THEN -m.quantity_delta ELSE 0 END),0) AS period_out_quantity,
      COALESCE(SUM(CASE WHEN m.movement_kind='shipment' AND m.quantity_delta<0 THEN -m.quantity_delta ELSE 0 END),0) AS period_sales_out_quantity,
      COALESCE(SUM(CASE WHEN m.movement_kind='sales_return' AND m.quantity_delta>0 THEN m.quantity_delta ELSE 0 END),0) AS period_sales_return_quantity,
      COALESCE(SUM(CASE WHEN m.movement_kind='purchase_receipt' AND m.quantity_delta>0 THEN m.quantity_delta ELSE 0 END),0) AS period_purchase_in_quantity,
      COALESCE(SUM(CASE WHEN m.movement_kind='purchase_return' AND m.quantity_delta<0 THEN -m.quantity_delta ELSE 0 END),0) AS period_purchase_return_quantity,
      COALESCE(SUM(m.amount_delta),0) AS period_net_amount,
      COUNT(*) AS ledger_row_count,
      SUBSTRING_INDEX(GROUP_CONCAT(DISTINCT CONCAT(m.document_type,'｜',m.document_no) ORDER BY m.movement_date DESC,m.document_no SEPARATOR '、'),'、',5) AS ledger_document_sample,
      MAX(m.movement_date) AS last_movement_date
    ${movementSqlFrom}
    WHERE ${movementWhere.join(' AND ')}
    GROUP BY m.item_code,m.warehouse_code`;
  const [movementRows] = await pool.query(movementSelect, [context.source_database, ...movementParams]);

  const inventoryMap = new Map();
  for (const raw of balanceRows) {
    const row = normalizeRow({
      item_code: raw.item_code,
      warehouse_code: raw.warehouse_code,
      item_name: raw.item_name,
      specification: raw.specification,
      unit: raw.unit,
      category_code: raw.category_code,
      current_quantity: raw.current_quantity,
      current_amount: raw.current_amount,
      balance_last_movement_at: raw.balance_last_movement_at,
      period_net_quantity: 0,
      period_in_quantity: 0,
      period_out_quantity: 0,
      period_sales_out_quantity: 0,
      period_sales_return_quantity: 0,
      period_purchase_in_quantity: 0,
      period_purchase_return_quantity: 0,
      period_net_amount: 0,
      ledger_row_count: 0,
      ledger_document_sample: '',
      last_movement_date: null
    }, ['current_quantity', 'current_amount', 'period_net_quantity', 'period_in_quantity', 'period_out_quantity', 'period_sales_out_quantity', 'period_sales_return_quantity', 'period_purchase_in_quantity', 'period_purchase_return_quantity', 'period_net_amount', 'ledger_row_count']);
    inventoryMap.set(`${row.item_code}\u0000${row.warehouse_code}`, row);
  }
  for (const raw of movementRows) {
    const row = normalizeRow(raw, ['period_net_quantity', 'period_in_quantity', 'period_out_quantity', 'period_sales_out_quantity', 'period_sales_return_quantity', 'period_purchase_in_quantity', 'period_purchase_return_quantity', 'period_net_amount', 'ledger_row_count']);
    const key = `${row.item_code}\u0000${row.warehouse_code}`;
    const existing = inventoryMap.get(key);
    if (existing) Object.assign(existing, row);
    else inventoryMap.set(key, {
      item_code: row.item_code,
      warehouse_code: row.warehouse_code,
      item_name: row.item_name,
      specification: row.specification,
      unit: row.unit,
      category_code: row.category_code,
      current_quantity: 0,
      current_amount: 0,
      balance_last_movement_at: null,
      ...row
    });
  }

  const inventoryRows = [...inventoryMap.values()]
    .sort((a, b) => numeric(b.period_out_quantity) - numeric(a.period_out_quantity) || String(a.item_code).localeCompare(String(b.item_code)) || String(a.warehouse_code).localeCompare(String(b.warehouse_code)))
    .slice(0, limit);

  const [[balanceSummary]] = await pool.query(`
    SELECT COUNT(DISTINCT CONCAT(b.item_code,'｜',b.warehouse_code)) AS balance_row_count,
      COUNT(DISTINCT b.item_code) AS item_count,
      COALESCE(SUM(b.quantity_on_hand),0) AS current_quantity,
      COALESCE(SUM(b.inventory_amount),0) AS current_amount
    FROM erp_inventory_balances b
    LEFT JOIN erp_items im
      ON im.tenant_id=b.tenant_id AND im.company_id=b.company_id AND im.source_system=b.source_system
      AND im.source_database=? AND im.item_code=b.item_code
    WHERE ${balanceWhere.join(' AND ')}`, [context.source_database, ...balanceParams]);
  const movementSummarySql = `
    SELECT COUNT(*) AS ledger_row_count,
      COALESCE(SUM(m.quantity_delta),0) AS period_net_quantity,
      COALESCE(SUM(CASE WHEN m.quantity_delta>0 THEN m.quantity_delta ELSE 0 END),0) AS period_in_quantity,
      COALESCE(SUM(CASE WHEN m.quantity_delta<0 THEN -m.quantity_delta ELSE 0 END),0) AS period_out_quantity,
      COALESCE(SUM(CASE WHEN m.movement_kind='shipment' AND m.quantity_delta<0 THEN -m.quantity_delta ELSE 0 END),0) AS period_sales_out_quantity,
      COALESCE(SUM(CASE WHEN m.movement_kind='sales_return' AND m.quantity_delta>0 THEN m.quantity_delta ELSE 0 END),0) AS period_sales_return_quantity,
      COALESCE(SUM(CASE WHEN m.movement_kind='purchase_receipt' AND m.quantity_delta>0 THEN m.quantity_delta ELSE 0 END),0) AS period_purchase_in_quantity,
      COALESCE(SUM(CASE WHEN m.movement_kind='purchase_return' AND m.quantity_delta<0 THEN -m.quantity_delta ELSE 0 END),0) AS period_purchase_return_quantity,
      COALESCE(SUM(m.amount_delta),0) AS period_net_amount
    ${movementSqlFrom}
    WHERE ${movementWhere.join(' AND ')}`;
  const [[movementSummary]] = await pool.query(movementSummarySql, [context.source_database, ...movementParams]);
  return {
    rows: inventoryRows,
    summary: normalizeRow({
      balance_row_count: balanceSummary?.balance_row_count,
      item_count: balanceSummary?.item_count,
      current_quantity: balanceSummary?.current_quantity,
      current_amount: balanceSummary?.current_amount,
      ledger_row_count: movementSummary?.ledger_row_count,
      period_net_quantity: movementSummary?.period_net_quantity,
      period_in_quantity: movementSummary?.period_in_quantity,
      period_out_quantity: movementSummary?.period_out_quantity,
      period_sales_out_quantity: movementSummary?.period_sales_out_quantity,
      period_sales_return_quantity: movementSummary?.period_sales_return_quantity,
      period_purchase_in_quantity: movementSummary?.period_purchase_in_quantity,
      period_purchase_return_quantity: movementSummary?.period_purchase_return_quantity,
      period_net_amount: movementSummary?.period_net_amount
    }, ['balance_row_count', 'item_count', 'current_quantity', 'current_amount', 'ledger_row_count', 'period_net_quantity', 'period_in_quantity', 'period_out_quantity', 'period_sales_out_quantity', 'period_sales_return_quantity', 'period_purchase_in_quantity', 'period_purchase_return_quantity', 'period_net_amount'])
  };
}

async function loadReceivableAnalysis(req, context, fromDate, toDate, limit) {
  const where = ['o.tenant_id=?', 'o.company_id=?', 'o.source_system=?', 'o.source_database=?', `o.account_type='AR'`, `o.status IN (${ACTIVE_AR_STATUSES.map(() => '?').join(',')})`];
  const params = [context.tenant_id, context.company_id, context.source_system, context.source_database, ...ACTIVE_AR_STATUSES];
  if (fromDate) {
    where.push('o.document_date>=?');
    params.push(fromDate);
  }
  if (toDate) {
    where.push('o.document_date<=?');
    params.push(toDate);
  }
  addEqual(where, params, req.query.customer_code, 'o.party_code');
  addRange(where, params, req.query.customer_from, req.query.customer_to, 'o.party_code');
  addEqual(where, params, req.query.currency_code, 'o.currency_code');
  const fromSql = `
    FROM finance_open_items o
    LEFT JOIN erp_customers cm
      ON cm.tenant_id=o.tenant_id AND cm.company_id=o.company_id AND cm.source_system=o.source_system
      AND cm.source_database=o.source_database AND cm.customer_code=o.party_code`;
  const [rows] = await pool.query(`
    SELECT o.party_code,MAX(cm.customer_name) AS customer_name,o.currency_code,
      COUNT(*) AS ar_item_count,
      SUM(CASE WHEN o.source_kind='shipment' THEN 1 ELSE 0 END) AS direct_shipment_count,
      SUM(CASE WHEN o.source_kind='finance_voucher' THEN 1 ELSE 0 END) AS voucher_count,
      COALESCE(SUM(o.original_amount),0) AS original_amount,
      COALESCE(SUM(o.settled_amount),0) AS settled_amount,
      COALESCE(SUM(o.adjustment_amount),0) AS adjustment_amount,
      COALESCE(SUM(o.balance_amount),0) AS balance_amount,
      COALESCE(SUM(CASE WHEN o.balance_amount>0 THEN o.balance_amount ELSE 0 END),0) AS outstanding_amount,
      SUM(CASE WHEN o.balance_amount>0 THEN 1 ELSE 0 END) AS open_balance_count,
      SUBSTRING_INDEX(GROUP_CONCAT(DISTINCT CONCAT(o.source_kind,'｜',COALESCE(o.source_document_no,o.document_no)) ORDER BY o.document_date DESC,o.id DESC SEPARATOR '、'),'、',5) AS source_document_sample,
      GROUP_CONCAT(DISTINCT o.source_kind ORDER BY o.source_kind SEPARATOR '、') AS source_kind_codes,
      GROUP_CONCAT(DISTINCT o.status ORDER BY o.status SEPARATOR '、') AS status_codes
    ${fromSql}
    WHERE ${where.join(' AND ')}
    GROUP BY o.party_code,o.currency_code
    ORDER BY balance_amount DESC,o.party_code,o.currency_code
    LIMIT ?`, [...params, limit]);
  const [summaryRows] = await pool.query(`
    SELECT COUNT(*) AS ar_item_count,
      COUNT(DISTINCT o.party_code) AS customer_count,
      COALESCE(SUM(o.original_amount),0) AS original_amount,
      COALESCE(SUM(o.settled_amount),0) AS settled_amount,
      COALESCE(SUM(o.adjustment_amount),0) AS adjustment_amount,
      COALESCE(SUM(o.balance_amount),0) AS balance_amount,
      COALESCE(SUM(CASE WHEN o.balance_amount>0 THEN o.balance_amount ELSE 0 END),0) AS outstanding_amount,
      SUM(CASE WHEN o.balance_amount>0 THEN 1 ELSE 0 END) AS open_balance_count
    ${fromSql}
    WHERE ${where.join(' AND ')}`, params);
  const summaryRow = summaryRows[0] || {};
  const numericKeys = ['ar_item_count', 'direct_shipment_count', 'voucher_count', 'original_amount', 'settled_amount', 'adjustment_amount', 'balance_amount', 'outstanding_amount', 'open_balance_count'];
  return {
    rows: rows.map(row => ({ ...normalizeRow(row, numericKeys), collection_rate: rate(row.settled_amount, row.original_amount) })),
    summary: {
      ...normalizeRow({
        ar_item_count: summaryRow.ar_item_count,
        customer_count: summaryRow.customer_count,
        original_amount: summaryRow.original_amount,
        settled_amount: summaryRow.settled_amount,
        adjustment_amount: summaryRow.adjustment_amount,
        balance_amount: summaryRow.balance_amount,
        outstanding_amount: summaryRow.outstanding_amount,
        open_balance_count: summaryRow.open_balance_count
      }, ['ar_item_count', 'customer_count', 'original_amount', 'settled_amount', 'adjustment_amount', 'balance_amount', 'outstanding_amount', 'open_balance_count']),
      collection_rate: rate(summaryRow.settled_amount, summaryRow.original_amount)
    }
  };
}

export function registerSalesAnalysisRoutes(app) {
  app.get('/api/sales-workflow/report-center', async (req, res, next) => {
    try {
      await ensureTargetSalesWorkflowSchema();
      await ensureTargetFinanceWorkflowSchema();
      const sourceDatabase = sourceDbFromRequest(req);
      const context = contextFor(sourceDatabase);
      const reportKey = trim(req.query.report_key || req.query.report || 'customer-order-statistics');
      const report = salesReportByKey.get(reportKey);
      if (!report) throw badRequest(`不支援的 iSM 銷售報表：${reportKey}`);
      const fromDate = optionalDate(req.query.from_date || req.query.date_from);
      const toDate = optionalDate(req.query.to_date || req.query.date_to);
      const asOfDate = optionalDate(req.query.as_of_date) || toDate || null;
      if (fromDate && toDate && fromDate > toDate) throw badRequest('銷售報表日期起日不可晚於迄日');
      if (report.mode === 'pricing_detail') await ensureTargetSalesPricingSchema();
      const limit = clampLimit(req.query.limit);
      const rows = await buildSalesReportRows(req, context, report, fromDate, toDate, limit);
      const summary = summarizeSalesReportRows(rows);
      if (report.mode === 'order_profit') {
        summary.cost_coverage_rate = summary.line_count ? Number(((rows.reduce((sum, row) => sum + numeric(row.cost_covered_line), 0) / summary.line_count) * 100).toFixed(4)) : 0;
      }
      res.json({ ok: true, data: {
        report_key: report.key,
        report_name: report.report_name,
        section: report.section,
        status: report.status,
        status_label: reportStatusLabel(report.status),
        availability: report.mode === 'unavailable' ? 'planned' : 'queryable',
        note: report.note,
        source_database: sourceDatabase,
        company_id: context.company_id,
        tenant_id: context.tenant_id,
        source_system: context.source_system,
        target_database: sourceDatabases[sourceDatabase]?.target_database || null,
        from_date: fromDate,
        to_date: toDate,
        as_of_date: asOfDate,
        limit,
        columns: reportColumnsAsObjects(report),
        rows,
        summary,
        catalog: salesReportCatalog.map(item => ({ key: item.key, report_name: item.report_name, section: item.section, status: item.status, status_label: reportStatusLabel(item.status), note: item.note })),
        source_definitions: reportSourceDefinitions(report),
        excluded_scope: ['製造', 'BOM', '成本計算模組；訂單利潤報表目前只列可取得的明細成本，不宣稱完整毛利'],
        reconciliation: '報表中心固定使用登入工作階段的公司別與 source_database；每列保留來源鍵，不跨公司、不混用 SH／SC。來源不足的文件報表維持尚未完成狀態，不以合併頁結果冒充正式報表。'
      }});
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/sales-workflow/analysis', async (req, res, next) => {
    try {
      await ensureTargetSalesWorkflowSchema();
      await ensureTargetFinanceWorkflowSchema();
      const sourceDatabase = sourceDbFromRequest(req);
      const context = contextFor(sourceDatabase);
      const groupBy = trim(req.query.group_by || 'customer_item').toLowerCase();
      const definition = groupDefinitions[groupBy];
      if (!definition) throw badRequest('不支援的銷售分析維度');
      const fromDate = optionalDate(req.query.from_date || req.query.date_from);
      const toDate = optionalDate(req.query.to_date || req.query.date_to);
      if (fromDate && toDate && fromDate > toDate) throw badRequest('銷售分析日期起日不可晚於迄日');
      const limit = clampLimit(req.query.limit);
      const { where, params } = buildSalesWhere(req, context, fromDate, toDate);
      const whereSql = `WHERE ${where.join(' AND ')}`;
      const groupSql = [...definition.group, 'd.currency_code'].filter((value, index, list) => list.indexOf(value) === index).join(',');
      const orderSql = [`remaining_amount DESC`, ...definition.order, 'd.currency_code'].join(',');
      const [salesRows] = await pool.query(`
        SELECT ${definition.select.join(',')},${salesMetricExpressions.join(',')}
        ${salesFromSql}
        ${whereSql}
        GROUP BY ${groupSql}
        ORDER BY ${orderSql}
        LIMIT ?`, [...params, limit]);
      const [[salesSummaryRow]] = await pool.query(`
        SELECT ${salesSummaryMetricExpressions.join(',')}
        ${salesFromSql}
        ${whereSql}`, params);
      const salesSummary = normalizeRow(salesSummaryRow || {}, salesNumericFields);
      salesSummary.quote_to_order_rate = rate(salesSummary.linked_quote_order_count, salesSummary.quote_count);
      salesSummary.order_fulfillment_rate = rate(salesSummary.delivered_quantity, salesSummary.order_quantity);
      salesSummary.shipment_return_rate = rate(salesSummary.return_quantity, salesSummary.shipment_quantity);
      salesSummary.net_sales_amount = numeric(salesSummary.shipment_amount) - numeric(salesSummary.return_amount);
      const inventory = await loadInventoryAnalysis(req, context, fromDate, toDate, limit);
      const receivable = await loadReceivableAnalysis(req, context, fromDate, toDate, limit);
      const dataQuality = {
        unmapped_customer_count: numeric(salesSummaryRow?.unmapped_customer_count),
        unmapped_item_count: numeric(salesSummaryRow?.unmapped_item_count),
        unmapped_department_count: numeric(salesSummaryRow?.unmapped_department_count),
        unmapped_salesperson_count: numeric(salesSummaryRow?.unmapped_salesperson_count),
        source_linked_line_count: numeric(salesSummary.source_linked_line_count),
        orphan_source_line_count: numeric(salesSummary.orphan_source_line_count)
      };
      // The source and target are returned explicitly so the UI can show the
      // company boundary and every analysis row can be traced back to a line.
      res.json({ ok: true, data: {
        report_code: 'COP-ANALYSIS',
        report_name: '銷售分析系統',
        source_database: sourceDatabase,
        company_id: context.company_id,
        tenant_id: context.tenant_id,
        source_system: context.source_system,
        target_database: sourceDatabases[sourceDatabase]?.target_database || null,
        from_date: fromDate,
        to_date: toDate,
        group_by: groupBy,
        group_label: definition.label,
        limit,
        sales_rows: salesRows.map(row => normalizeRow({ ...row, group_by: groupBy, group_label: definition.label }, salesNumericFields)),
        inventory_rows: inventory.rows,
        receivable_rows: receivable.rows,
        summary: {
          sales: salesSummary,
          inventory: inventory.summary,
          receivable: receivable.summary,
          rates: {
            quote_to_order_rate: salesSummary.quote_to_order_rate,
            order_fulfillment_rate: salesSummary.order_fulfillment_rate,
            shipment_return_rate: salesSummary.shipment_return_rate,
            receivable_collection_rate: receivable.summary.collection_rate
          },
          data_quality: dataQuality
        },
        source_definitions: [
          {
            source: '銷售統計／COPR20 與銷售分析',
            tables: 'sales_documents + sales_document_items',
            evidence: 'schema-confirmed／目標 ERP',
            trace: '公司別／source_database + document_no + line_no + source_item_id',
            rule: '報價、訂單列入核准／已完成資料；銷貨、銷退只列入已過帳資料；訂單已交量沿用明細 related_quantity。'
          },
          {
            source: '庫存管理',
            tables: 'erp_inventory_balances + inventory_movement_ledger',
            evidence: 'schema-confirmed／目標 ERP',
            trace: 'item_code + warehouse_code + document_no + movement_kind',
            rule: '目前餘額與查詢區間異動分開呈現，庫存數量不回算成銷售金額。'
          },
          {
            source: '應收管理',
            tables: 'finance_open_items + finance_vouchers + finance_voucher_sources',
            evidence: 'schema-confirmed／目標 ERP',
            trace: 'party_code + currency_code + source_kind + source_document_no',
            rule: '以非作廢且已核准／已立帳的 AR 帳款彙總；來源憑單可再回溯銷貨或結帳憑單。'
          }
        ],
        excluded_scope: ['製造', 'BOM', '成本計算', '毛利分析'],
        reconciliation: '本報表把銷售、庫存、應收分成三個可追溯區塊；銷售統計可追到單據明細，庫存可追到異動台帳，應收可追到帳款與憑單來源。不同幣別分開彙總，不跨公司、不混用 SH／SC。'
      }});
    } catch (error) {
      next(error);
    }
  });
}
