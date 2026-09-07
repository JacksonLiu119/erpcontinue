import {
  pool,
  sourceDatabases,
  ensureTargetSalesWorkflowSchema,
  ensureTargetFinanceWorkflowSchema
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
