import {
  pool,
  tx,
  ensureTargetFinanceWorkflowSchema,
  ensureTargetSalesPhase2Schema
} from './db.js';
import { hasDepartmentAccess, recordAccessAudit } from './auth.js';

const EPS = 0.000001;

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function forbidden(message = '您沒有此作業權限') {
  const error = new Error(message);
  error.status = 403;
  return error;
}

function notFound(message) {
  const error = new Error(message);
  error.status = 404;
  return error;
}

function text(value, label, max = 500) {
  const result = String(value ?? '').trim();
  if (result.length > max) throw badRequest(`${label}不可超過 ${max} 個字元`);
  return result;
}

function requiredText(value, label, max = 500) {
  const result = text(value, label, max);
  if (!result) throw badRequest(`${label}為必填`);
  return result;
}

function date(value, label, required = false) {
  const result = String(value ?? '').trim();
  if (!result) {
    if (required) throw badRequest(`${label}為必填`);
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw badRequest(`${label}格式必須為 YYYY-MM-DD`);
  const parsed = new Date(`${result}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) throw badRequest(`${label}不是有效日期`);
  return result;
}

function integer(value, label, fallback, min = 1, max = 500) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const result = Number(value);
  if (!Number.isInteger(result) || result < min || result > max) throw badRequest(`${label}格式不正確`);
  return result;
}

function contextOf(req) {
  const source = req.erpContext;
  if (!source?.source_database) throw badRequest('登入工作階段尚未固定公司別，無法執行訂單管理作業');
  return {
    tenant_id: source.tenant_id || 'default',
    company_id: source.company_id || source.source_database,
    source_system: source.source_system || 'iSM',
    source_database: String(source.source_database).toUpperCase(),
    target_database: source.target_database || 'inventory_erp',
    department_scope_mode: source.department_scope_mode || 'all',
    department_codes: Array.isArray(source.department_codes) ? source.department_codes : [],
    department_code: source.department_code || null
  };
}

function contextParams(context, alias = '') {
  const prefix = alias ? `${alias}.` : '';
  return [
    `${prefix}tenant_id=?`,
    `${prefix}company_id=?`,
    `${prefix}source_system=?`,
    `${prefix}source_database=?`
  ];
}

function contextValues(context) {
  return [context.tenant_id, context.company_id, context.source_system, context.source_database];
}

function userId(req) {
  const id = Number(req.auth?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function parseStoredJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return value; }
}

function dateRange(query) {
  const from = date(query.from_date || query.date_from, '日期起日');
  const to = date(query.to_date || query.date_to, '日期迄日');
  if (from && to && from > to) throw badRequest('日期起日不可晚於迄日');
  return { from, to };
}

function whereDate(conditions, params, column, range) {
  if (range.from) { conditions.push(`${column}>=?`); params.push(range.from); }
  if (range.to) { conditions.push(`${column}<=?`); params.push(range.to); }
}

function scopedDepartment(context, req, conditions, params, alias = 'e') {
  if (context.department_scope_mode !== 'selected') return;
  const requested = text(req.query.department_code || req.query.department, '部門代號', 30).toUpperCase();
  if (requested && !context.department_codes.includes(requested)) throw forbidden(`您沒有部門 ${requested} 的存取權限`);
  const codes = requested ? [requested] : context.department_codes;
  if (!codes.length) throw forbidden('此帳號尚未設定可查詢的部門範圍');
  conditions.push(`${alias}.department_code IN (${codes.map(() => '?').join(',')})`);
  params.push(...codes);
}

async function assertDepartment(req, context, departmentCode) {
  if (context.department_scope_mode !== 'selected') return;
  const allowed = await hasDepartmentAccess(userId(req), req.auth?.role_code, context.source_database, departmentCode);
  if (!allowed) throw forbidden(`訂單所屬部門不在目前帳號授權範圍：${departmentCode || '未設定部門'}`);
}

function orderNextStage(row) {
  if (row.status === 'voided') return '作廢／不再往下';
  if (row.status === 'draft') return '待核准';
  if (Number(row.delivered_quantity) > Number(row.quantity) + EPS) return '待處理超交異常';
  if (Number(row.remaining_quantity) > EPS) return '待銷貨／追蹤未交';
  if (row.status === 'closed') return '已結案';
  if (row.status === 'completed') return '待受控結案';
  return '可進入銷貨確認';
}

function orderException(row) {
  if (row.status === 'closed' && Number(row.remaining_quantity) > EPS) return '已結案但仍有未交量，禁止直接忽略';
  if (Number(row.delivered_quantity) > Number(row.quantity) + EPS) return '已交量超過訂單量，需建立受控更正紀錄';
  if (row.status === 'draft') return '訂單尚未核准';
  if (row.status === 'voided') return '訂單已作廢';
  return '';
}

function normalizeOrderRow(row) {
  const quantity = Number(row.quantity || 0);
  const delivered = Number(row.delivered_quantity || 0);
  const unitPrice = Number(row.unit_price || 0);
  const remaining = Math.max(quantity - delivered, 0);
  const result = {
    ...row,
    order_id: Number(row.order_id),
    order_item_id: Number(row.order_item_id),
    quantity,
    delivered_quantity: delivered,
    remaining_quantity: remaining,
    unit_price: unitPrice,
    order_amount: quantity * unitPrice,
    remaining_amount: remaining * unitPrice,
    source_key: `sales_documents:${Number(row.order_id)}/items:${Number(row.order_item_id)}`
  };
  result.next_stage = orderNextStage(result);
  result.exception_reason = orderException(result);
  return result;
}

function orderConditions(context, req, { includeOrderNo = true, includeItem = true } = {}) {
  const conditions = [...contextParams(context, 'd'), "d.document_kind='sales_order'"];
  const params = contextValues(context);
  const range = dateRange(req.query);
  whereDate(conditions, params, 'd.document_date', range);
  const customer = text(req.query.customer_code, '客戶代號', 30);
  const orderNo = includeOrderNo ? text(req.query.order_no, '訂單單號', 60) : '';
  const status = text(req.query.status, '狀態', 30);
  const itemCode = includeItem ? text(req.query.item_code, '品號', 40) : '';
  const salesperson = text(req.query.salesperson_code, '業務員代號', 30);
  if (customer) { conditions.push('d.customer_code=?'); params.push(customer); }
  if (orderNo) { conditions.push('d.document_no LIKE ?'); params.push(`%${orderNo}%`); }
  if (status) { conditions.push('d.status=?'); params.push(status); }
  if (itemCode) { conditions.push('i.item_code=?'); params.push(itemCode); }
  if (salesperson) { conditions.push('d.salesperson_code=?'); params.push(salesperson); }
  scopedDepartment(context, req, conditions, params, 'e');
  return { conditions, params, range };
}

async function loadOrderRows(context, req, limit = 500) {
  const { conditions, params } = orderConditions(context, req);
  const [rows] = await pool.query(`
    SELECT d.id AS order_id, i.id AS order_item_id, d.document_no, d.document_date,
      d.document_type, d.customer_code, COALESCE(c.customer_name,'') AS customer_name,
      d.currency_code, d.warehouse_code, d.salesperson_code,
      COALESCE(e.employee_name,'') AS salesperson_name,
      COALESCE(e.department_code,'') AS department_code,
      COALESCE(dep.department_name,'') AS department_name,
      i.item_code, i.item_name, i.specification, i.unit, i.quantity,
      COALESCE(i.related_quantity,0) AS delivered_quantity, i.unit_price,
      d.status, d.inventory_status, d.source_document_id,
      CASE WHEN i.related_quantity > i.quantity THEN i.related_quantity-i.quantity ELSE 0 END AS over_quantity
    FROM sales_documents d
    JOIN sales_document_items i ON i.document_id=d.id
    LEFT JOIN erp_customers c
      ON c.tenant_id=d.tenant_id AND c.company_id=d.company_id
      AND c.source_system=d.source_system AND c.source_database=d.source_database
      AND c.customer_code=d.customer_code
    LEFT JOIN erp_employees e
      ON e.tenant_id=d.tenant_id AND e.company_id=d.company_id
      AND e.source_system=d.source_system AND e.source_database=d.source_database
      AND e.employee_code=d.salesperson_code
    LEFT JOIN erp_departments dep
      ON dep.tenant_id=e.tenant_id AND dep.company_id=e.company_id
      AND dep.source_system=e.source_system AND dep.source_database=e.source_database
      AND dep.department_code=e.department_code
    WHERE ${conditions.join(' AND ')}
    ORDER BY d.document_date DESC,d.id DESC,i.line_no,i.id
    LIMIT ${limit}`, params);
  return rows.map(normalizeOrderRow);
}

async function loadOrderForControl(conn, context, orderId, lock = false) {
  const [[order]] = await conn.query(`SELECT * FROM sales_documents
    WHERE id=? AND ${contextParams(context).join(' AND ')} AND document_kind='sales_order'
    LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [orderId, ...contextValues(context)]);
  if (!order) throw notFound('找不到目前公司別的客戶訂單');
  const [items] = await conn.query(`SELECT i.*,COALESCE(e.department_code,'') AS department_code
    FROM sales_document_items i
    LEFT JOIN erp_employees e ON e.tenant_id=? AND e.company_id=? AND e.source_system=?
      AND e.source_database=? AND e.employee_code=?
    WHERE i.document_id=? ORDER BY i.line_no,i.id`, [
    context.tenant_id, context.company_id, context.source_system, context.source_database,
    order.salesperson_code, orderId
  ]);
  return { ...order, items };
}

function accountingMonthBounds(value) {
  const postingDate = date(value, '過帳日期', true);
  const [year, month] = postingDate.split('-').map(Number);
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { period_code: postingDate.slice(0, 7), start_date: `${postingDate.slice(0, 7)}-01`, end_date: end };
}

function storedDate(value, label = '日期') {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const result = String(value ?? '').trim();
  return date(result.slice(0, 10), label, true);
}

async function assertOpenAccountingPeriod(conn, context, postingDate) {
  const bounds = accountingMonthBounds(postingDate);
  let [[period]] = await conn.query(`SELECT * FROM accounting_periods
    WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=?
      AND start_date<=? AND end_date>=? FOR UPDATE`, [
    ...contextValues(context), bounds.start_date, bounds.end_date
  ]);
  if (!period) {
    await conn.query(`INSERT IGNORE INTO accounting_periods
      (tenant_id,company_id,source_system,source_database,period_code,start_date,end_date,status,note)
      VALUES(?,?,?,?,?,?,?,'open','系統首次使用自動建立開放期間')`, [
      ...contextValues(context), bounds.period_code, bounds.start_date, bounds.end_date
    ]);
    [[period]] = await conn.query(`SELECT * FROM accounting_periods
      WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND period_code=? FOR UPDATE`, [
      ...contextValues(context), bounds.period_code
    ]);
  }
  if (!period || period.status !== 'open') throw badRequest(`會計期間 ${bounds.period_code} 已關帳或不存在，禁止訂單維護過帳`);
  return period;
}

// 管理維護的受控作廢／封存不能因為查不到期間就自動開一個新期間。
// 既有過帳流程仍沿用上面的相容邏輯；這裡採嚴格檢查，讓預覽與執行結果一致。
async function assertExistingOpenAccountingPeriod(conn, context, postingDate) {
  const bounds = accountingMonthBounds(storedDate(postingDate, '過帳日期'));
  const [[period]] = await conn.query(`SELECT * FROM accounting_periods
    WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=?
      AND start_date<=? AND end_date>=? FOR UPDATE`, [
    ...contextValues(context), bounds.start_date, bounds.end_date
  ]);
  if (!period || period.status !== 'open') {
    throw badRequest(`會計期間 ${bounds.period_code} 未開放或已關帳，禁止受控作廢／封存`);
  }
  return period;
}

async function recordControlEvent(conn, context, orderId, actionCode, before, after, reason, changedBy) {
  await conn.query(`INSERT INTO erp_sales_order_control_events(
      order_id,tenant_id,company_id,source_system,source_database,action_code,before_json,after_json,reason,changed_by)
    VALUES(?,?,?,?,?,?,?,?,?,?)`, [
    orderId, ...contextValues(context), actionCode,
    JSON.stringify(before ?? null), JSON.stringify(after ?? null), reason, changedBy
  ]);
}

async function recordVersion(conn, context, order, item, afterStatus, reason, changedBy, changeKind) {
  const [[last]] = await conn.query(`SELECT version_no FROM sales_order_versions
    WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND order_id=?
    ORDER BY version_no DESC LIMIT 1 FOR UPDATE`, [...contextValues(context), order.id]);
  const versionNo = Number(last?.version_no || 0) + 1;
  await conn.query(`INSERT INTO sales_order_versions(
      tenant_id,company_id,source_system,source_database,order_id,order_item_id,version_no,change_kind,
      before_status,after_status,before_quantity,after_quantity,before_delivered_quantity,after_delivered_quantity,
      before_unit_price,after_unit_price,reason,changed_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    ...contextValues(context), order.id, item?.id || null, versionNo, changeKind,
    order.status, afterStatus, Number(item?.quantity || 0), Number(item?.quantity || 0),
    Number(item?.related_quantity || 0), Number(item?.related_quantity || 0),
    Number(item?.unit_price || 0), Number(item?.unit_price || 0), reason, changedBy
  ]);
  return versionNo;
}

async function assertControlOrder(req, conn, context, orderId, action, reason) {
  const order = await loadOrderForControl(conn, context, orderId, true);
  const department = order.items.map(item => item.department_code).find(Boolean) || null;
  await assertDepartment(req, context, department);
  await assertOpenAccountingPeriod(conn, context, order.document_date);
  if (!reason) throw badRequest('受控維護作業必須填寫原因');
  if (['draft', 'voided', 'closed'].includes(order.status) && action === 'recalculate') {
    throw badRequest('草稿、作廢或已結案訂單不可直接重算；請依受控解結／重開流程處理');
  }
  if (['draft', 'voided', 'closed'].includes(order.status) && action === 'close') {
    throw badRequest('草稿、作廢或已結案訂單不可再次指定結案');
  }
  return order;
}

function orderBefore(order) {
  return {
    id: Number(order.id), document_no: order.document_no, status: order.status,
    inventory_status: order.inventory_status,
    items: order.items.map(item => ({ id: Number(item.id), quantity: Number(item.quantity || 0), related_quantity: Number(item.related_quantity || 0), unit_price: Number(item.unit_price || 0) }))
  };
}

function archiveDate(value) {
  return date(value || new Date().toISOString().slice(0, 10), '作廢／封存日期', true);
}

function archiveReason(label, count, message) {
  return count ? `${message}（${count} 筆）` : '';
}

async function buildOrderArchiveImpact(conn, context, order, controlledDate) {
  const itemIds = order.items.map(item => Number(item.id)).filter(id => Number.isInteger(id) && id > 0);
  const itemPlaceholders = itemIds.length ? itemIds.map(() => '?').join(',') : '0';
  const checks = [];
  const blockingReasons = [];
  const addCheck = (code, label, rows, message) => {
    const list = Array.isArray(rows) ? rows : [];
    const passed = list.length === 0;
    checks.push({ code, label, passed, count: list.length, details: list.slice(0, 20) });
    if (!passed) blockingReasons.push(archiveReason(label, list.length, message));
    return list;
  };
  const addStatusCheck = (code, label, passed, message, details = null) => {
    checks.push({ code, label, passed: Boolean(passed), count: passed ? 0 : 1, details: details ? [details] : [] });
    if (!passed) blockingReasons.push(message);
  };

  addStatusCheck('ORDER_STATUS', '訂單狀態', ['draft', 'approved'].includes(String(order.status)),
    `目前訂單狀態為 ${order.status}，只能封存草稿或已核准且尚未履約的訂單`, { status: order.status });
  addStatusCheck('ORDER_ITEMS', '訂單明細', itemIds.length > 0, '訂單沒有明細，禁止受控作廢／封存');

  const deliveredQuantity = order.items.reduce((sum, item) => sum + Number(item.related_quantity || 0), 0);
  addStatusCheck('DELIVERED_QUANTITY', '已交量', deliveredQuantity <= EPS,
    `訂單已有 ${deliveredQuantity} 已交量，必須先走銷貨沖回／受控解結／重開`, { delivered_quantity: deliveredQuantity });

  let downstreamDocuments = [];
  if (itemIds.length) {
    [downstreamDocuments] = await conn.query(`SELECT sd.id,sd.document_kind,sd.document_no,sd.document_date,sd.status,
        sd.inventory_status,si.id item_id,si.source_item_id,si.quantity
      FROM sales_documents sd JOIN sales_document_items si ON si.document_id=sd.id
      WHERE ${contextParams(context, 'sd').join(' AND ')}
        AND si.source_item_id IN (${itemPlaceholders})
        AND sd.document_kind IN ('shipment','sales_return')
        AND sd.status<>'voided'
      ORDER BY sd.document_date,sd.id,si.line_no,si.id`, [...contextValues(context), ...itemIds]);
  }
  addCheck('DOWNSTREAM_DOCUMENTS', '銷貨／銷退下游單據', downstreamDocuments,
    '已有銷貨／銷退下游單據，禁止級聯清除；請先依沖回與重開流程處理');

  const [deliverySchedules] = await conn.query(`SELECT id,schedule_no,order_item_id,scheduled_date,quantity,fulfilled_quantity,status
    FROM erp_sales_delivery_schedules s
    WHERE ${contextParams(context, 's').join(' AND ')} AND s.order_id=? AND s.status<>'cancelled'
    ORDER BY s.scheduled_date,s.id`, [...contextValues(context), order.id]);
  addCheck('DELIVERY_SCHEDULES', '交期排程', deliverySchedules,
    '仍有有效交期排程，請先取消或完成排程後再封存');

  const [pickLists] = await conn.query(`SELECT id,pick_no,warehouse_code,pick_date,status
    FROM erp_sales_pick_lists p
    WHERE ${contextParams(context, 'p').join(' AND ')} AND p.order_id=? AND p.status<>'cancelled'
    ORDER BY p.pick_date,p.id`, [...contextValues(context), order.id]);
  addCheck('PICK_LISTS', '揀貨單', pickLists,
    '仍有有效揀貨單，請先取消或完成揀貨流程後再封存');

  const [procurementDemands] = await conn.query(`SELECT id,demand_no,order_item_id,quantity,status,procurement_document_id
    FROM erp_sales_procurement_demands d
    WHERE ${contextParams(context, 'd').join(' AND ')} AND d.order_id=? AND d.status<>'cancelled'
    ORDER BY d.id`, [...contextValues(context), order.id]);
  addCheck('PROCUREMENT_DEMANDS', '缺料採購需求', procurementDemands,
    '仍有有效缺料採購需求，請先取消或完成正式轉採購後再封存');

  let pendingChanges = [];
  if (itemIds.length) {
    [pendingChanges] = await conn.query(`SELECT id,change_no,order_item_id,change_date,new_quantity,new_unit_price,status
      FROM sales_order_changes c
      WHERE ${contextParams(context, 'c').join(' AND ')}
        AND c.order_item_id IN (${itemPlaceholders}) AND c.status='draft'
      ORDER BY c.change_date,c.id`, [...contextValues(context), ...itemIds]);
  }
  addCheck('PENDING_CHANGES', '待核准訂單變更', pendingChanges,
    '仍有待核准訂單變更，請先核准或作廢變更草稿後再封存');

  const financeLinkConditions = itemIds.length
    ? '(vs.source_document_id=? OR vs.source_document_item_id IN (' + itemPlaceholders + '))'
    : 'vs.source_document_id=?';
  const financeLinkParams = itemIds.length
    ? [...contextValues(context), order.id, ...itemIds]
    : [...contextValues(context), order.id];
  const [financeLinks] = await conn.query(`SELECT DISTINCT vs.id,vs.source_kind,vs.source_document_id,vs.source_document_item_id,
      v.id AS voucher_id,v.voucher_no,v.voucher_date,v.status AS voucher_status
    FROM finance_voucher_sources vs JOIN finance_vouchers v ON v.id=vs.voucher_id
    WHERE ${contextParams(context, 'v').join(' AND ')} AND v.status<>'voided'
      AND ${financeLinkConditions}
    ORDER BY v.voucher_date,v.id`, financeLinkParams);
  addCheck('FINANCE_LINKS', '財務憑證來源', financeLinks,
    '已有未作廢財務憑證來源，禁止直接封存；請先依財務沖回／更正流程處理');

  const [creditApprovals] = await conn.query(`SELECT id,document_no,status,requested_at
    FROM sales_credit_approval_requests r
    WHERE ${contextParams(context, 'r').join(' AND ')} AND r.document_id=? AND r.status='pending'
    ORDER BY r.requested_at,r.id`, [...contextValues(context), order.id]);
  addCheck('CREDIT_APPROVALS', '待核准信用放行', creditApprovals,
    '仍有待核准信用放行申請，請先完成核准或駁回後再封存');

  const orderDate = storedDate(order.document_date, '訂單日期');
  const dates = [...new Set([orderDate, controlledDate].filter(Boolean))];
  const periodChecks = [];
  for (const postingDate of dates) {
    const bounds = accountingMonthBounds(postingDate);
    const [[period]] = await conn.query(`SELECT period_code,status,start_date,end_date
      FROM accounting_periods
      WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=?
        AND start_date<=? AND end_date>=?
      LIMIT 1`, [...contextValues(context), bounds.start_date, bounds.end_date]);
    const passed = period?.status === 'open';
    periodChecks.push({ date: postingDate, period_code: bounds.period_code, status: period?.status || 'missing', passed });
    if (!passed) blockingReasons.push(`會計期間 ${bounds.period_code} 未開放或已關帳，禁止受控作廢／封存`);
  }
  checks.push({ code: 'ACCOUNTING_PERIOD', label: '會計期間', passed: periodChecks.every(row => row.passed), count: periodChecks.filter(row => !row.passed).length, details: periodChecks });

  return {
    order_id: Number(order.id), document_no: order.document_no, document_date: orderDate,
    status: order.status, controlled_date: controlledDate, can_archive: blockingReasons.length === 0,
    blocking_reasons: [...new Set(blockingReasons.filter(Boolean))], checks,
    effects: {
      target_action: 'sales_documents.status=voided',
      source_database: 'SH／SC 原始資料維持唯讀',
      inventory: '不改變庫存、不建立庫存異動',
      finance: '不改變應收／應付、不建立財務沖銷',
      downstream: '不級聯修改下游單據',
      audit: '保留原單、明細、訂單版本與控制事件'
    },
    counts: {
      item_count: itemIds.length, delivered_quantity: deliveredQuantity,
      downstream_document_count: downstreamDocuments.length, delivery_schedule_count: deliverySchedules.length,
      pick_list_count: pickLists.length, procurement_demand_count: procurementDemands.length,
      pending_change_count: pendingChanges.length, finance_link_count: financeLinks.length,
      pending_credit_approval_count: creditApprovals.length
    }
  };
}

async function archiveCheck(req, res, next) {
  try {
    await ensureTargetSalesPhase2Schema();
    await ensureTargetFinanceWorkflowSchema();
    const context = contextOf(req);
    const orderId = integer(req.params.id, '訂單 ID', null, 1, Number.MAX_SAFE_INTEGER);
    const controlledDate = archiveDate(req.query.archive_date);
    const order = await loadOrderForControl(pool, context, orderId, false);
    const department = order.items.map(item => item.department_code).find(Boolean) || null;
    const departmentAllowed = await hasDepartmentAccess(userId(req), req.auth?.role_code, context.source_database, department);
    const impact = await buildOrderArchiveImpact(pool, context, order, controlledDate);
    if (!departmentAllowed) {
      impact.can_archive = false;
      impact.blocking_reasons.push(`訂單所屬部門不在目前帳號授權範圍：${department || '未設定部門'}`);
      impact.checks.push({ code: 'DEPARTMENT_SCOPE', label: '部門權限', passed: false, count: 1, details: [{ department_code: department }] });
    } else {
      impact.checks.push({ code: 'DEPARTMENT_SCOPE', label: '部門權限', passed: true, count: 0, details: [{ department_code: department }] });
    }
    impact.blocking_reasons = [...new Set(impact.blocking_reasons)];
    impact.can_archive = impact.blocking_reasons.length === 0;
    res.json({ ok: true, data: { ...impact, company_id: context.company_id, source_database: context.source_database, target_database: context.target_database } });
  } catch (error) { next(error); }
}

async function archiveOrder(req, res, next) {
  try {
    await ensureTargetSalesPhase2Schema();
    await ensureTargetFinanceWorkflowSchema();
    const context = contextOf(req);
    const orderId = integer(req.params.id, '訂單 ID', null, 1, Number.MAX_SAFE_INTEGER);
    const reason = requiredText(req.body?.reason, '作廢／封存原因');
    const controlledDate = archiveDate(req.body?.archive_date);
    const result = await tx(async conn => {
      const order = await loadOrderForControl(conn, context, orderId, true);
      const department = order.items.map(item => item.department_code).find(Boolean) || null;
      await assertDepartment(req, context, department);
      const orderDate = storedDate(order.document_date, '訂單日期');
      await assertExistingOpenAccountingPeriod(conn, context, orderDate);
      if (orderDate !== controlledDate) await assertExistingOpenAccountingPeriod(conn, context, controlledDate);
      const impact = await buildOrderArchiveImpact(conn, context, order, controlledDate);
      if (!impact.can_archive) throw badRequest(`訂單不可受控作廢／封存：${impact.blocking_reasons.join('；')}`);
      const before = orderBefore(order);
      const note = `受控作廢／封存：${reason}`;
      const [updated] = await conn.query(`UPDATE sales_documents SET status='voided',
          note=TRIM(CONCAT(COALESCE(note,''),CASE WHEN COALESCE(note,'')='' THEN '' ELSE '；' END,?))
        WHERE id=? AND ${contextParams(context).join(' AND ')} AND document_kind='sales_order' AND status=?`,
        [note, order.id, ...contextValues(context), order.status]);
      if (!updated.affectedRows) throw badRequest('訂單狀態已變更，請重新查詢後再執行');
      for (const item of order.items) {
        await recordVersion(conn, context, order, item, 'voided', reason, userId(req), 'controlled_archive');
      }
      if (!order.items.length) await recordVersion(conn, context, order, null, 'voided', reason, userId(req), 'controlled_archive');
      const after = { ...before, status: 'voided', controlled_date: controlledDate, action: 'controlled_archive', reason, impact };
      await recordControlEvent(conn, context, order.id, 'CONTROLLED_ARCHIVE', before, after, reason, userId(req));
      return { id: Number(order.id), document_no: order.document_no, status: 'voided', controlled_date: controlledDate, source_key: `sales_documents:${Number(order.id)}`, message: '訂單已受控作廢／封存；原單、明細、版本與控制事件均保留，未級聯修改下游資料' };
    });
    await recordAccessAudit({
      actorUserId: req.auth?.id, targetUserId: req.auth?.id, actionCode: 'SALES_ORDER_CONTROLLED_ARCHIVE',
      entityType: 'sales_order', entityId: result.id, sourceKey: context.source_database,
      reason, ipAddress: req.ip, userAgent: req.get('user-agent')
    });
    res.json({ ok: true, data: result });
  } catch (error) { next(error); }
}

async function recalculateOrder(req, res, next) {
  try {
    await ensureTargetSalesPhase2Schema();
    await ensureTargetFinanceWorkflowSchema();
    const context = contextOf(req);
    const orderId = integer(req.params.id, '訂單 ID', null, 1, Number.MAX_SAFE_INTEGER);
    const reason = requiredText(req.body?.reason, '重算原因');
    const result = await tx(async conn => {
      const order = await assertControlOrder(req, conn, context, orderId, 'recalculate', reason);
      const before = orderBefore(order);
      const changes = [];
      for (const item of order.items) {
        const [[posted]] = await conn.query(`SELECT COALESCE(SUM(si.quantity),0) AS quantity
          FROM sales_document_items si JOIN sales_documents sd ON sd.id=si.document_id
          WHERE si.source_item_id=? AND sd.tenant_id=? AND sd.company_id=? AND sd.source_system=?
            AND sd.source_database=? AND sd.document_kind='shipment'
            AND sd.status='posted' AND sd.inventory_status='posted'`, [
          item.id, ...contextValues(context)
        ]);
        const nextQuantity = Number(posted.quantity || 0);
        if (Math.abs(nextQuantity - Number(item.related_quantity || 0)) > EPS) {
          await conn.query('UPDATE sales_document_items SET related_quantity=? WHERE id=? AND document_id=?', [nextQuantity, item.id, order.id]);
          const afterItem = { ...item, related_quantity: nextQuantity };
          await recordVersion(conn, context, order, afterItem, order.status, reason, userId(req), 'delivered_quantity_recalculated');
          changes.push({ item_id: Number(item.id), before_delivered_quantity: Number(item.related_quantity || 0), after_delivered_quantity: nextQuantity });
        }
      }
      const [[totals]] = await conn.query(`SELECT COALESCE(SUM(quantity),0) AS ordered_quantity,
          COALESCE(SUM(related_quantity),0) AS delivered_quantity
        FROM sales_document_items WHERE document_id=?`, [order.id]);
      const ordered = Number(totals.ordered_quantity || 0);
      const delivered = Number(totals.delivered_quantity || 0);
      const status = delivered >= ordered - EPS && ordered > EPS ? 'completed' : delivered > EPS ? 'partial' : 'approved';
      if (status !== order.status) await conn.query('UPDATE sales_documents SET status=? WHERE id=?', [status, order.id]);
      const after = { ...before, status, delivered_quantity: delivered, ordered_quantity: ordered, changes };
      await recordControlEvent(conn, context, order.id, 'DELIVERED_QUANTITY_RECALCULATED', before, after, reason, userId(req));
      return { id: order.id, document_no: order.document_no, status, ordered_quantity: ordered, delivered_quantity: delivered, changes, message: '訂單已依已過帳銷貨重算已交量，並保留版本／事件紀錄' };
    });
    res.json({ ok: true, data: result });
  } catch (error) { next(error); }
}

async function closeOrder(req, res, next) {
  try {
    await ensureTargetSalesPhase2Schema();
    await ensureTargetFinanceWorkflowSchema();
    const context = contextOf(req);
    const orderId = integer(req.params.id, '訂單 ID', null, 1, Number.MAX_SAFE_INTEGER);
    const reason = requiredText(req.body?.reason, '指定結案原因');
    const result = await tx(async conn => {
      const order = await assertControlOrder(req, conn, context, orderId, 'close', reason);
      const [[totals]] = await conn.query(`SELECT COALESCE(SUM(quantity),0) AS ordered_quantity,
          COALESCE(SUM(related_quantity),0) AS delivered_quantity
        FROM sales_document_items WHERE document_id=?`, [order.id]);
      const ordered = Number(totals.ordered_quantity || 0);
      const delivered = Number(totals.delivered_quantity || 0);
      const remaining = Math.max(ordered - delivered, 0);
      if (remaining > EPS) throw badRequest(`訂單仍有 ${remaining} 未交量，不可指定結案；請先完成交貨或依受控流程處理`);
      if (!['approved', 'partial', 'completed'].includes(order.status)) throw badRequest('只有已核准、部分交貨或已完成的訂單可以指定結案');
      const before = orderBefore(order);
      await conn.query(`UPDATE sales_documents SET status='closed',closed_by=?,closed_at=NOW(),close_note=? WHERE id=? AND ${contextParams(context).join(' AND ')}`, [userId(req), reason, order.id, ...contextValues(context)]);
      const after = { ...before, status: 'closed', ordered_quantity: ordered, delivered_quantity: delivered, remaining_quantity: remaining };
      await recordVersion(conn, context, order, null, 'closed', reason, userId(req), 'controlled_close');
      await recordControlEvent(conn, context, order.id, 'CONTROLLED_CLOSE', before, after, reason, userId(req));
      return { id: order.id, document_no: order.document_no, status: 'closed', ordered_quantity: ordered, delivered_quantity: delivered, remaining_quantity: remaining, message: '訂單已受控指定結案，並保留版本／事件紀錄' };
    });
    res.json({ ok: true, data: result });
  } catch (error) { next(error); }
}

async function listCustomers(context, req, limit) {
  const conditions = [...contextParams(context, 'c')];
  const params = contextValues(context);
  const keyword = text(req.query.keyword, '查詢關鍵字', 120);
  const active = text(req.query.active, '啟用狀態', 10);
  if (keyword) {
    conditions.push('(c.customer_code LIKE ? OR c.customer_name LIKE ? OR c.short_name LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  if (active === '0' || active === '1') { conditions.push('c.is_active=?'); params.push(Number(active)); }
  const [rows] = await pool.query(`SELECT c.id,c.customer_code,c.short_name,c.customer_name,c.responsible_person,
      c.contact_name,c.phone,c.email,c.tax_id,c.currency_code,c.payment_term_code,c.invoice_type,c.tax_type,
      c.closing_day,c.is_active,c.source_table,c.source_key
    FROM erp_customers c WHERE ${conditions.join(' AND ')}
    ORDER BY c.customer_code LIMIT ${limit}`, params);
  return rows.map(row => ({ ...row, id: Number(row.id), is_active: Number(row.is_active), source_key: `erp_customers:${Number(row.id)}`, next_stage: Number(row.is_active) ? '可供訂單引用' : '停用／不可新增交易' }));
}

async function listTree(context, req, limit) {
  const { conditions, params } = orderConditions(context, req);
  const [orders] = await pool.query(`SELECT DISTINCT d.id,d.document_no,d.document_date,d.document_type,d.customer_code,d.currency_code,
      d.salesperson_code,d.status,d.inventory_status,d.source_document_id,d.contract_id
    FROM sales_documents d
    LEFT JOIN sales_document_items i ON i.document_id=d.id
    LEFT JOIN erp_employees e ON e.tenant_id=d.tenant_id AND e.company_id=d.company_id
      AND e.source_system=d.source_system AND e.source_database=d.source_database AND e.employee_code=d.salesperson_code
    WHERE ${conditions.join(' AND ')} ORDER BY d.document_date DESC,d.id DESC LIMIT ${limit}`, params);
  const orderIds = orders.map(row => Number(row.id));
  if (!orderIds.length) return [];
  const idPlaceholders = orderIds.map(() => '?').join(',');
  const [orderItems] = await pool.query(`SELECT i.id,i.document_id,i.item_code,i.item_name,i.quantity,i.related_quantity,i.unit_price,
      d.document_no,d.document_date,d.document_type,d.customer_code,d.status,d.inventory_status,d.source_document_id
    FROM sales_document_items i JOIN sales_documents d ON d.id=i.document_id
    WHERE i.document_id IN (${idPlaceholders}) AND ${contextParams(context, 'd').join(' AND ')}
    ORDER BY d.document_date DESC,d.id DESC,i.line_no,i.id`, [...orderIds, ...contextValues(context)]);
  const itemIds = orderItems.map(row => Number(row.id));
  const linked = [];
  if (itemIds.length) {
    const itemPlaceholders = itemIds.map(() => '?').join(',');
    const [shipments] = await pool.query(`SELECT sd.id,si.id item_id,si.source_item_id,sd.document_no,sd.document_date,sd.document_type,
        sd.customer_code,sd.status,sd.inventory_status,si.item_code,si.item_name,si.quantity,si.related_quantity,si.unit_price,
        si.source_item_id AS order_item_id
      FROM sales_document_items si JOIN sales_documents sd ON sd.id=si.document_id
      WHERE si.source_item_id IN (${itemPlaceholders}) AND sd.tenant_id=? AND sd.company_id=? AND sd.source_system=?
        AND sd.source_database=? AND sd.document_kind='shipment'
      ORDER BY sd.document_date,sd.id,si.line_no,si.id`, [...itemIds, ...contextValues(context)]);
    linked.push(...shipments.map(row => ({ ...row, node_level: 1, node_kind: 'shipment', parent_item_id: Number(row.source_item_id) })));
    const shipmentItemIds = shipments.map(row => Number(row.item_id));
    if (shipmentItemIds.length) {
      const shipmentPlaceholders = shipmentItemIds.map(() => '?').join(',');
      const [returns] = await pool.query(`SELECT rd.id,ri.id item_id,ri.source_item_id,rd.document_no,rd.document_date,rd.document_type,
          rd.customer_code,rd.status,rd.inventory_status,ri.item_code,ri.item_name,ri.quantity,ri.related_quantity,ri.unit_price,
          ri.source_item_id AS shipment_item_id
        FROM sales_document_items ri JOIN sales_documents rd ON rd.id=ri.document_id
        WHERE ri.source_item_id IN (${shipmentPlaceholders}) AND rd.tenant_id=? AND rd.company_id=?
          AND rd.source_system=? AND rd.source_database=? AND rd.document_kind='sales_return'
        ORDER BY rd.document_date,rd.id,ri.line_no,ri.id`, [...shipmentItemIds, ...contextValues(context)]);
      linked.push(...returns.map(row => ({ ...row, node_level: 2, node_kind: 'sales_return', parent_item_id: Number(row.source_item_id) })));
    }
  }
  const sourceIds = orders.map(row => Number(row.source_document_id || 0)).filter(Boolean);
  const sourceMap = new Map();
  if (sourceIds.length) {
    const placeholders = sourceIds.map(() => '?').join(',');
    const [sources] = await pool.query(`SELECT id,document_no,document_date,document_kind,document_type,customer_code,status,inventory_status
      FROM sales_documents WHERE id IN (${placeholders}) AND ${contextParams(context).join(' AND ')}`, [...sourceIds, ...contextValues(context)]);
    for (const source of sources) sourceMap.set(Number(source.id), source);
  }
  const rows = [];
  for (const order of orders) {
    const orderLines = orderItems.filter(item => Number(item.document_id) === Number(order.id));
    const source = sourceMap.get(Number(order.source_document_id || 0));
    if (source) rows.push({
      node_id: `source:${Number(source.id)}`, node_level: -1, node_kind: source.document_kind,
      document_id: Number(source.id), document_no: source.document_no, document_date: source.document_date,
      document_type: source.document_type, customer_code: source.customer_code, status: source.status,
      inventory_status: source.inventory_status, source_key: `sales_documents:${Number(source.id)}`,
      parent_source_key: null, next_stage: '訂單', exception_reason: '', quantity: 0, delivered_quantity: 0, remaining_quantity: 0
    });
    for (const item of orderLines) {
      const root = normalizeOrderRow({
        order_id: order.id, order_item_id: item.id, document_no: order.document_no, document_date: order.document_date,
        document_type: order.document_type, customer_code: order.customer_code, item_code: item.item_code,
        item_name: item.item_name, quantity: item.quantity, delivered_quantity: item.related_quantity,
        unit_price: item.unit_price, status: order.status, inventory_status: order.inventory_status
      });
      rows.push({
        node_id: root.source_key, node_level: 0, node_kind: 'sales_order', document_id: Number(order.id),
        order_item_id: Number(item.id), document_no: order.document_no, document_date: order.document_date,
        document_type: order.document_type, customer_code: order.customer_code, item_code: item.item_code,
        item_name: item.item_name, status: order.status, inventory_status: order.inventory_status,
        quantity: root.quantity, delivered_quantity: root.delivered_quantity, remaining_quantity: root.remaining_quantity,
        source_key: root.source_key, parent_source_key: source ? `sales_documents:${Number(source.id)}` : null,
        next_stage: root.next_stage, exception_reason: root.exception_reason
      });
      const children = linked.filter(child => child.node_kind === 'shipment' && Number(child.parent_item_id) === Number(item.id));
      for (const child of children) {
        const childKey = `sales_documents:${Number(child.id)}/items:${Number(child.item_id)}`;
        rows.push({
          node_id: childKey, node_level: 1, node_kind: child.node_kind, document_id: Number(child.id),
          order_item_id: Number(item.id), document_no: child.document_no, document_date: child.document_date,
          document_type: child.document_type, customer_code: child.customer_code, item_code: child.item_code,
          item_name: child.item_name, status: child.status, inventory_status: child.inventory_status,
          quantity: Number(child.quantity || 0), delivered_quantity: Number(child.related_quantity || 0), remaining_quantity: 0,
          source_key: childKey, parent_source_key: root.source_key,
          next_stage: child.status === 'posted' && child.inventory_status === 'posted' ? '應收／銷退追蹤' : '待銷貨確認／過帳',
          exception_reason: child.status === 'posted' && child.inventory_status === 'posted' ? '' : '銷貨尚未完成過帳'
        });
        const returnChildren = linked.filter(x => x.node_kind === 'sales_return' && Number(x.parent_item_id) === Number(child.item_id));
        for (const ret of returnChildren) {
          const retKey = `sales_documents:${Number(ret.id)}/items:${Number(ret.item_id)}`;
          rows.push({
            node_id: retKey, node_level: 2, node_kind: ret.node_kind, document_id: Number(ret.id),
            order_item_id: Number(item.id), document_no: ret.document_no, document_date: ret.document_date,
            document_type: ret.document_type, customer_code: ret.customer_code, item_code: ret.item_code,
            item_name: ret.item_name, status: ret.status, inventory_status: ret.inventory_status,
            quantity: Number(ret.quantity || 0), delivered_quantity: Number(ret.related_quantity || 0), remaining_quantity: 0,
            source_key: retKey, parent_source_key: `sales_documents:${Number(child.id)}/items:${Number(child.item_id)}`,
            next_stage: ret.status === 'posted' && ret.inventory_status === 'posted' ? '應收沖帳／退款／待抵' : '待銷退驗收／過帳',
            exception_reason: ret.status === 'posted' && ret.inventory_status === 'posted' ? '' : '銷退尚未完成驗收／過帳'
          });
        }
      }
    }
  }
  return rows.slice(0, limit);
}

async function listCustomerTransactions(context, req, limit) {
  const conditions = [...contextParams(context, 'd')];
  const params = contextValues(context);
  const range = dateRange(req.query);
  whereDate(conditions, params, 'd.document_date', range);
  const customer = text(req.query.customer_code, '客戶代號', 30);
  const itemCode = text(req.query.item_code, '品號', 40);
  scopedDepartment(context, req, conditions, params, 'e');
  if (customer) { conditions.push('d.customer_code=?'); params.push(customer); }
  if (itemCode) { conditions.push('i.item_code=?'); params.push(itemCode); }
  const [rows] = await pool.query(`SELECT d.id document_id,i.id document_item_id,d.document_kind,d.document_type,d.document_no,
      d.document_date,d.customer_code,COALESCE(c.customer_name,'') customer_name,d.currency_code,d.status,d.inventory_status,
      i.item_code,i.item_name,i.specification,i.unit,i.quantity,i.related_quantity,i.unit_price,i.allowance_amount,
      d.source_document_id
    FROM sales_documents d JOIN sales_document_items i ON i.document_id=d.id
    LEFT JOIN erp_customers c ON c.tenant_id=d.tenant_id AND c.company_id=d.company_id
      AND c.source_system=d.source_system AND c.source_database=d.source_database AND c.customer_code=d.customer_code
    LEFT JOIN erp_employees e ON e.tenant_id=d.tenant_id AND e.company_id=d.company_id
      AND e.source_system=d.source_system AND e.source_database=d.source_database AND e.employee_code=d.salesperson_code
    WHERE ${conditions.join(' AND ')} ORDER BY d.document_date DESC,d.id DESC,i.line_no,i.id LIMIT ${limit}`, params);
  return rows.map(row => {
    const quantity = Number(row.quantity || 0), unitPrice = Number(row.unit_price || 0), allowance = Number(row.allowance_amount || 0);
    const sign = row.document_kind === 'sales_return' ? -1 : 1;
    let nextStage = '—', exception = '';
    if (row.document_kind === 'quotation') nextStage = '待轉訂單';
    else if (row.document_kind === 'sales_order') nextStage = Number(row.quantity || 0) > Number(row.related_quantity || 0) ? '待銷貨／追蹤未交' : '待結案／銷貨完成';
    else if (row.document_kind === 'shipment') { nextStage = row.status === 'posted' && row.inventory_status === 'posted' ? '應收／銷退追蹤' : '待銷貨確認／過帳'; exception = nextStage.startsWith('待') ? '銷貨尚未完成過帳' : ''; }
    else if (row.document_kind === 'sales_return') { nextStage = row.status === 'posted' && row.inventory_status === 'posted' ? '應收沖帳／退款／待抵' : '待銷退驗收／過帳'; exception = nextStage.startsWith('待') ? '銷退尚未完成驗收／過帳' : ''; }
    return {
      ...row, document_id: Number(row.document_id), document_item_id: Number(row.document_item_id), quantity,
      related_quantity: Number(row.related_quantity || 0), unit_price: unitPrice, amount: sign * (quantity * unitPrice - allowance),
      source_key: `sales_documents:${Number(row.document_id)}/items:${Number(row.document_item_id)}`,
      next_stage: nextStage, exception_reason: exception
    };
  });
}

async function listEvents(context, req) {
  const orderId = req.query.order_id ? integer(req.query.order_id, '訂單 ID', null, 1, Number.MAX_SAFE_INTEGER) : null;
  const eventLimit = integer(req.query.limit, '筆數上限', 200, 1, 500);
  const conditions = [...contextParams(context, 'e')];
  const params = contextValues(context);
  if (orderId) { conditions.push('e.order_id=?'); params.push(orderId); }
  const [events] = await pool.query(`SELECT e.id,e.order_id,e.action_code,e.before_json,e.after_json,e.reason,e.changed_by,
      e.created_at,u.username changed_by_username,u.display_name changed_by_name
    FROM erp_sales_order_control_events e LEFT JOIN access_users u ON u.id=e.changed_by
    WHERE ${conditions.join(' AND ')} ORDER BY e.created_at DESC,e.id DESC LIMIT ${eventLimit}`, params);
  const versionConditions = [...contextParams(context, 'v')];
  const versionParams = contextValues(context);
  if (orderId) { versionConditions.push('v.order_id=?'); versionParams.push(orderId); }
  const [versions] = await pool.query(`SELECT v.*,u.username changed_by_username,u.display_name changed_by_name
    FROM sales_order_versions v LEFT JOIN access_users u ON u.id=v.changed_by
    WHERE ${versionConditions.join(' AND ')} ORDER BY v.created_at DESC,v.id DESC LIMIT ${eventLimit}`, versionParams);
  return {
    events: events.map(row => ({ ...row, id: Number(row.id), order_id: Number(row.order_id), before_json: parseStoredJson(row.before_json), after_json: parseStoredJson(row.after_json) })),
    versions: versions.map(row => ({ ...row, id: Number(row.id), order_id: Number(row.order_id), order_item_id: row.order_item_id == null ? null : Number(row.order_item_id), version_no: Number(row.version_no), before_quantity: Number(row.before_quantity || 0), after_quantity: Number(row.after_quantity || 0), before_delivered_quantity: Number(row.before_delivered_quantity || 0), after_delivered_quantity: Number(row.after_delivered_quantity || 0) }))
  };
}

export function registerSalesMaintenanceRoutes(app) {
  app.get('/api/sales-workflow/maintenance/orders', async (req, res, next) => {
    try {
      await ensureTargetSalesPhase2Schema();
      const context = contextOf(req);
      const limit = integer(req.query.limit, '筆數上限', 500, 1, 2000);
      const rows = await loadOrderRows(context, req, limit);
      res.json({ ok: true, data: { rows, criteria: req.query, company_id: context.company_id, source_database: context.source_database, target_database: context.target_database } });
    } catch (error) { next(error); }
  });

  app.get('/api/sales-workflow/maintenance/queries/customer', async (req, res, next) => {
    try {
      await ensureTargetSalesPhase2Schema();
      const context = contextOf(req);
      const rows = await listCustomers(context, req, integer(req.query.limit, '筆數上限', 500, 1, 2000));
      res.json({ ok: true, data: { rows, company_id: context.company_id, source_database: context.source_database, target_database: context.target_database } });
    } catch (error) { next(error); }
  });

  app.get('/api/sales-workflow/maintenance/queries/order', async (req, res, next) => {
    try {
      await ensureTargetSalesPhase2Schema();
      const context = contextOf(req);
      const rows = await loadOrderRows(context, req, integer(req.query.limit, '筆數上限', 500, 1, 2000));
      res.json({ ok: true, data: { rows, company_id: context.company_id, source_database: context.source_database, target_database: context.target_database } });
    } catch (error) { next(error); }
  });

  app.get('/api/sales-workflow/maintenance/queries/tree', async (req, res, next) => {
    try {
      await ensureTargetSalesPhase2Schema();
      const context = contextOf(req);
      const rows = await listTree(context, req, integer(req.query.limit, '筆數上限', 100, 1, 500));
      res.json({ ok: true, data: { rows, company_id: context.company_id, source_database: context.source_database, target_database: context.target_database } });
    } catch (error) { next(error); }
  });

  app.get('/api/sales-workflow/maintenance/queries/customer-transactions', async (req, res, next) => {
    try {
      await ensureTargetSalesPhase2Schema();
      const context = contextOf(req);
      const rows = await listCustomerTransactions(context, req, integer(req.query.limit, '筆數上限', 500, 1, 2000));
      res.json({ ok: true, data: { rows, company_id: context.company_id, source_database: context.source_database, target_database: context.target_database } });
    } catch (error) { next(error); }
  });

  app.get('/api/sales-workflow/maintenance/events', async (req, res, next) => {
    try {
      await ensureTargetSalesPhase2Schema();
      const context = contextOf(req);
      res.json({ ok: true, data: await listEvents(context, req) });
    } catch (error) { next(error); }
  });

  app.get('/api/sales-workflow/maintenance/orders/:id/archive-check', archiveCheck);
  app.post('/api/sales-workflow/maintenance/orders/:id/recalculate', recalculateOrder);
  app.post('/api/sales-workflow/maintenance/orders/:id/close', closeOrder);
  app.post('/api/sales-workflow/maintenance/orders/:id/archive', archiveOrder);
}
