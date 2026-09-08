import {
  pool,
  tx,
  ensureTargetFinanceWorkflowSchema,
  ensureTargetSalesPhase2Schema,
  ensureTargetSalesPricingSchema
} from './db.js';

const EPS = 0.000001;

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function notFound(message) {
  const error = new Error(message);
  error.status = 404;
  return error;
}

function text(value, label, max = 500, required = false) {
  const result = String(value ?? '').trim();
  if (required && !result) throw badRequest(`${label}為必填`);
  if (result.length > max) throw badRequest(`${label}不可超過 ${max} 個字元`);
  return result || null;
}

function number(value, label, { required = false, min = null, max = null } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') {
    if (required) throw badRequest(`${label}為必填`);
    return null;
  }
  const result = Number(value);
  if (!Number.isFinite(result)) throw badRequest(`${label}必須是數字`);
  if (min !== null && result < min - EPS) throw badRequest(`${label}不可小於 ${min}`);
  if (max !== null && result > max + EPS) throw badRequest(`${label}不可大於 ${max}`);
  return result;
}

function positive(value, label) {
  return number(value, label, { required: true, min: EPS });
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

function dateOnly(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const raw = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw.slice(0, 10) : parsed.toISOString().slice(0, 10);
}

function json(value) {
  return value == null ? null : JSON.stringify(value);
}

function parseObjectArray(value, label) {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) { /* handled below */ }
  }
  throw badRequest(`${label}格式必須是陣列`);
}

function parseStoredJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return value; }
}

function contextOf(req) {
  const source = req.erpContext;
  if (!source?.source_database) throw badRequest('登入工作階段尚未固定公司別，無法執行銷售作業');
  return {
    tenant_id: source.tenant_id || 'default',
    company_id: source.company_id || source.source_database,
    source_system: source.source_system || 'iSM',
    source_database: String(source.source_database).toUpperCase(),
    target_database: source.target_database || 'inventory_erp'
  };
}

function contextParams(c, prefix = '') {
  const p = prefix ? `${prefix}.` : '';
  return [`${p}tenant_id=?`, `${p}company_id=?`, `${p}source_system=?`, `${p}source_database=?`];
}

function contextValues(c) {
  return [c.tenant_id, c.company_id, c.source_system, c.source_database];
}

function userId(req) {
  const id = Number(req.auth?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function statusAfterApproval(row) {
  return Number(row?.requires_approval ?? 1) === 1 && Number(row?.auto_confirm ?? 0) !== 1 ? 'draft' : 'approved';
}

async function nextNumber(conn, table, column, prefix, c, value) {
  const day = String(value).replaceAll('-', '');
  const base = `${prefix}${day}`;
  for (let serial = 1; serial < 100000; serial += 1) {
    const candidate = `${base}${String(serial).padStart(4, '0')}`;
    const [[row]] = await conn.query(`SELECT 1 AS found FROM ${table}
      WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND ${column}=? LIMIT 1`,
    [...contextValues(c), candidate]);
    if (!row) return candidate;
  }
  throw badRequest(`無法產生${table}的單號`);
}

async function recordEvent(conn, table, idColumn, id, c, eventKind, before, after, reason, changedBy) {
  await conn.query(`INSERT INTO ${table}(${idColumn},tenant_id,company_id,source_system,source_database,event_kind,before_json,after_json,reason,changed_by)
    VALUES(?,?,?,?,?,?,?,?,?,?)`, [
    id, ...contextValues(c), eventKind, json(before), json(after), String(reason || eventKind).slice(0, 500), changedBy
  ]);
}

async function assertCustomerItem(conn, c, customerCode, itemCode) {
  const [[customer]] = await conn.query(`SELECT id,customer_code,customer_name,currency_code,is_active
    FROM erp_customers WHERE ${contextParams(c).join(' AND ')} AND customer_code=? LIMIT 1`,
  [...contextValues(c), customerCode]);
  if (!customer || Number(customer.is_active ?? 1) !== 1) throw badRequest(`找不到目前公司別已啟用的客戶：${customerCode}`);
  const [[item]] = await conn.query(`SELECT id,item_code,item_name,specification,unit
    FROM erp_items WHERE ${contextParams(c).join(' AND ')} AND item_code=? LIMIT 1`,
  [...contextValues(c), itemCode]);
  if (!item) throw badRequest(`找不到目前公司別的品號：${itemCode}`);
  return { customer, item };
}

async function assertCurrency(conn, c, currencyCode) {
  const [[currency]] = await conn.query(`SELECT currency_code FROM erp_currencies
    WHERE ${contextParams(c).join(' AND ')} AND currency_code=? LIMIT 1`, [...contextValues(c), currencyCode]);
  if (!currency) throw badRequest(`目前公司尚未建立幣別主檔：${currencyCode}`);
}

async function loadSalesDocumentType(conn, c, typeCode, kind) {
  const [[row]] = await conn.query(`SELECT * FROM sales_document_types
    WHERE ${contextParams(c).join(' AND ')} AND document_kind=? AND type_code=?
      AND (source_database=? OR source_database IS NULL OR source_database='') AND is_active=1 LIMIT 1`,
  [...contextValues(c), kind, typeCode, c.source_database]);
  if (!row) throw badRequest(`找不到目前公司別啟用中的${kind}單別：${typeCode}`);
  return row;
}

async function getContract(conn, c, id, lock = false) {
  const [[contract]] = await conn.query(`SELECT * FROM erp_sales_contracts
    WHERE id=? AND ${contextParams(c).join(' AND ')} LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
  [id, ...contextValues(c)]);
  if (!contract) throw notFound('找不到目前公司別的合約訂單');
  const [items] = await conn.query(`SELECT ci.*,
      COALESCE((SELECT SUM(oi.quantity) FROM sales_documents od
        JOIN sales_document_items oi ON oi.document_id=od.id
        WHERE od.contract_id=ci.contract_id AND oi.contract_item_id=ci.id AND od.status<>'voided'),0) AS converted_quantity_calc,
      COALESCE((SELECT SUM(si.quantity) FROM sales_documents od
        JOIN sales_document_items oi ON oi.document_id=od.id AND oi.contract_item_id=ci.id
        JOIN sales_document_items si ON si.source_item_id=oi.id
        JOIN sales_documents sd ON sd.id=si.document_id AND sd.document_kind='shipment'
          AND sd.status='posted' AND sd.inventory_status='posted'
        WHERE od.contract_id=ci.contract_id AND od.status<>'voided'),0) AS delivered_quantity
    FROM erp_sales_contract_items ci WHERE ci.contract_id=? ORDER BY ci.line_no,ci.id`, [id]);
  const normalized = items.map(row => ({
    ...row,
    converted_quantity: Number(row.converted_quantity_calc || 0),
    delivered_quantity: Number(row.delivered_quantity || 0),
    remaining_quantity: Math.max(Number(row.quantity || 0) - Number(row.converted_quantity_calc || 0), 0),
    amount: Number(row.amount || 0)
  }));
  return { ...contract, items: normalized };
}

async function refreshContractStatus(conn, c, contractId) {
  const [[totals]] = await conn.query(`SELECT
      COALESCE(SUM(quantity),0) total_quantity,
      COALESCE(SUM(converted_quantity),0) converted_quantity
    FROM erp_sales_contract_items WHERE contract_id=?`, [contractId]);
  const [[contract]] = await conn.query(`SELECT status FROM erp_sales_contracts
    WHERE id=? AND ${contextParams(c).join(' AND ')} FOR UPDATE`, [contractId, ...contextValues(c)]);
  if (!contract || contract.status === 'voided' || contract.status === 'closed') return;
  const total = Number(totals.total_quantity || 0), converted = Number(totals.converted_quantity || 0);
  const next = converted >= total - EPS && total > EPS ? 'completed' : converted > EPS ? 'partial' : contract.status === 'draft' ? 'draft' : 'approved';
  await conn.query(`UPDATE erp_sales_contracts SET status=? WHERE id=? AND ${contextParams(c).join(' AND ')}`, [next, contractId, ...contextValues(c)]);
}

async function readOrder(conn, c, orderId, lock = false) {
  const [[order]] = await conn.query(`SELECT * FROM sales_documents
    WHERE id=? AND ${contextParams(c).join(' AND ')} AND document_kind='sales_order' LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
  [orderId, ...contextValues(c)]);
  if (!order) throw notFound('找不到目前公司別的客戶訂單');
  const [items] = await conn.query(`SELECT * FROM sales_document_items WHERE document_id=? ORDER BY line_no,id`, [orderId]);
  return { ...order, items };
}

async function recordOrderControlEvent(conn, c, orderId, actionCode, before, after, reason, changedBy) {
  await conn.query(`INSERT INTO erp_sales_order_control_events(
      order_id,tenant_id,company_id,source_system,source_database,action_code,before_json,after_json,reason,changed_by)
    VALUES(?,?,?,?,?,?,?,?,?,?)`, [
    orderId, ...contextValues(c), actionCode, json(before), json(after), String(reason || actionCode).slice(0, 500), changedBy
  ]);
}

function exceptionRow(values) {
  return {
    exception_code: values.exception_code,
    severity: values.severity || 'warning',
    reason: values.reason,
    source_kind: values.source_kind || null,
    source_document_id: values.source_document_id == null ? null : Number(values.source_document_id),
    source_document_no: values.source_document_no || null,
    document_date: values.document_date || null,
    customer_code: values.customer_code || null,
    item_code: values.item_code || null,
    remaining_quantity: Number(values.remaining_quantity || 0),
    remaining_amount: Number(values.remaining_amount || 0),
    next_stage: values.next_stage || null,
    status: values.status || null,
    source_table: values.source_table || 'sales_documents',
    source_key: values.source_key || null
  };
}

function csvCell(value) {
  const result = String(value ?? '');
  return /[",\r\n]/.test(result) ? `"${result.replaceAll('"', '""')}"` : result;
}

export function registerSalesPhase2Routes(app) {
  // S02：批次調整沿用既有客戶產品計價主檔與核准流程；每一列仍是獨立版本，
  // 不覆蓋歷史價格，也不把 SH／SC 的價格規則混在一起。
  app.post('/api/sales-workflow/customer-pricing/batch', async (req, res, next) => {
    try {
      await ensureTargetSalesPricingSchema();
      const c = contextOf(req), body = req.body || {};
      const lines = parseObjectArray(body.items ?? body.lines, '批次計價明細');
      if (!lines.length || lines.length > 500) throw badRequest('批次計價明細筆數必須介於 1～500 筆');
      const batchNo = text(body.batch_no, '批次編號', 60) || `BPRICE-${Date.now()}`;
      const reason = text(body.reason, '批次調整原因', 500, true);
      const result = await tx(async conn => {
        const ids = [];
        for (const [index, line] of lines.entries()) {
          const customerCode = text(line.customer_code, `第 ${index + 1} 筆客戶代號`, 30, true);
          const itemCode = text(line.item_code, `第 ${index + 1} 筆品號`, 40, true);
          const pricingUnit = text(line.pricing_unit ?? line.unit ?? 'PCS', `第 ${index + 1} 筆計價單位`, 20, true);
          const currencyCode = text(line.currency_code || 'TWD', `第 ${index + 1} 筆幣別`, 10, true);
          const unitPrice = number(line.unit_price, `第 ${index + 1} 筆單價`, { required: true, min: 0 });
          const discountPercent = number(line.discount_rate_pct, `第 ${index + 1} 筆折扣率（%）`, { min: 0, max: 100 });
          const effectiveFrom = date(line.effective_from, `第 ${index + 1} 筆生效日`, true);
          const effectiveTo = date(line.effective_to, `第 ${index + 1} 筆失效日`);
          if (effectiveTo && effectiveTo < effectiveFrom) throw badRequest(`第 ${index + 1} 筆失效日不可早於生效日`);
          const { customer, item } = await assertCustomerItem(conn, c, customerCode, itemCode);
          await assertCurrency(conn, c, currencyCode);
          const [[duplicate]] = await conn.query(`SELECT id FROM erp_customer_item_prices
            WHERE ${contextParams(c).join(' AND ')} AND customer_code=? AND item_code=? AND pricing_unit=?
              AND currency_code=? AND effective_from=? LIMIT 1`,
          [...contextValues(c), customerCode, itemCode, pricingUnit, currencyCode, effectiveFrom]);
          if (duplicate) throw badRequest(`第 ${index + 1} 筆與既有計價版本的生效日重複`);
          const [inserted] = await conn.query(`INSERT INTO erp_customer_item_prices(
            tenant_id,company_id,source_system,source_database,customer_id,customer_code,mapping_id,item_id,item_code,
            pricing_unit,currency_code,unit_price,discount_rate,tax_included,quantity_pricing_flag,trade_condition,
            effective_from,effective_to,status,is_active,source_kind,source_document_no,source_document_type,source_table,source_key,
            note,created_by,updated_by)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? ,?,'draft',1,'batch_adjustment',?,?, 'sales_customer_pricing_batch',?,?,?,?)`, [
            ...contextValues(c), customer.id, customerCode, line.mapping_id || null, item.id, itemCode,
            pricingUnit, currencyCode, unitPrice, discountPercent == null ? null : discountPercent / 100,
            Number(line.tax_included) ? 1 : 0, Number(line.quantity_pricing_flag) ? 1 : 0,
            text(line.trade_condition || '1', '交易條件', 10, true), effectiveFrom, effectiveTo,
            batchNo, 'batch', `BATCH:${batchNo}`, text(line.note, '備註', 500) || reason, userId(req), userId(req)
          ]);
          const id = Number(inserted.insertId);
          await insertSalesPricingBatchEvent(conn, id, c, 'batch_created', null, { id, batch_no: batchNo, customer_code: customerCode, item_code: itemCode }, reason, userId(req));
          ids.push(id);
        }
        return { batch_no: batchNo, ids };
      });
      res.status(201).json({ ok: true, data: { ...result, target_database: c.target_database, company_id: c.company_id, source_database: c.source_database, status: 'draft' } });
    } catch (error) { next(error); }
  });

  // S03：合約訂單。合約轉訂單時獨立保存 contract_id／contract_item_id，
  // 不借用 source_item_id，確保後續訂單→銷貨仍可維持原本的一對多鏈結。
  app.get('/api/sales-workflow/contracts', async (req, res, next) => {
    try {
      await ensureTargetSalesPhase2Schema();
      const c = contextOf(req), conditions = [...contextParams(c, 'c')], params = [...contextValues(c)];
      const customerCode = text(req.query.customer_code, '客戶代號', 30);
      const status = text(req.query.status, '狀態', 20);
      const fromDate = date(req.query.from_date, '起日');
      const toDate = date(req.query.to_date, '迄日');
      if (customerCode) { conditions.push('c.customer_code=?'); params.push(customerCode); }
      if (status) { conditions.push('c.status=?'); params.push(status); }
      if (fromDate) { conditions.push('c.contract_date>=?'); params.push(fromDate); }
      if (toDate) { conditions.push('c.contract_date<=?'); params.push(toDate); }
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
      const [rows] = await pool.query(`SELECT c.*,
          COALESCE((SELECT SUM(ci.quantity) FROM erp_sales_contract_items ci WHERE ci.contract_id=c.id),0) total_quantity,
          COALESCE((SELECT SUM(ci.converted_quantity) FROM erp_sales_contract_items ci WHERE ci.contract_id=c.id),0) cached_converted_quantity,
          COALESCE((SELECT SUM(oi.quantity) FROM sales_documents od JOIN sales_document_items oi ON oi.document_id=od.id
            WHERE od.contract_id=c.id AND od.status<>'voided'),0) converted_quantity,
          COALESCE((SELECT SUM(si.quantity) FROM sales_documents od JOIN sales_document_items oi ON oi.document_id=od.id
            JOIN sales_document_items si ON si.source_item_id=oi.id
            JOIN sales_documents sd ON sd.id=si.document_id AND sd.document_kind='shipment' AND sd.status='posted' AND sd.inventory_status='posted'
            WHERE od.contract_id=c.id AND od.status<>'voided'),0) delivered_quantity
        FROM erp_sales_contracts c WHERE ${conditions.join(' AND ')} ORDER BY c.contract_date DESC,c.id DESC LIMIT ?`, [...params, limit]);
      res.json({ ok: true, data: rows.map(row => ({ ...row, total_quantity: Number(row.total_quantity || 0), converted_quantity: Number(row.converted_quantity || 0), delivered_quantity: Number(row.delivered_quantity || 0), remaining_quantity: Math.max(Number(row.total_quantity || 0) - Number(row.converted_quantity || 0), 0) })) });
    } catch (error) { next(error); }
  });

  app.get('/api/sales-workflow/contracts/:id', async (req, res, next) => {
    try {
      await ensureTargetSalesPhase2Schema();
      const c = contextOf(req), contract = await getContract(pool, c, Number(req.params.id));
      res.json({ ok: true, data: contract });
    } catch (error) { next(error); }
  });

  app.post('/api/sales-workflow/contracts', async (req, res, next) => {
    try {
      await ensureTargetSalesPhase2Schema();
      const c = contextOf(req), body = req.body || {};
      const customerCode = text(body.customer_code, '客戶代號', 30, true);
      const contractDate = date(body.contract_date, '合約日期', true);
      const periodFrom = date(body.period_from, '合約起日');
      const periodTo = date(body.period_to, '合約迄日');
      if (periodFrom && periodTo && periodTo < periodFrom) throw badRequest('合約迄日不可早於起日');
      const currencyCode = text(body.currency_code || 'TWD', '幣別', 10, true);
      const rawItems = parseObjectArray(body.items, '合約明細');
      const lines = rawItems.length ? rawItems : [body];
      if (lines.length > 200) throw badRequest('合約明細不可超過 200 筆');
      const result = await tx(async conn => {
        const { customer } = await assertCustomerItem(conn, c, customerCode, text(lines[0].item_code, '品號', 40, true));
        await assertCurrency(conn, c, currencyCode);
        const contractNo = text(body.contract_no, '合約單號', 60) || await nextNumber(conn, 'erp_sales_contracts', 'contract_no', 'CT', c, contractDate);
        const [header] = await conn.query(`INSERT INTO erp_sales_contracts(
          tenant_id,company_id,source_system,source_database,contract_no,contract_type,customer_code,contract_date,
          period_from,period_to,currency_code,status,note,source_kind,source_table,source_key,created_by)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,'draft',?,'manual','erp_sales_contracts',?,?)`, [
          ...contextValues(c), contractNo, text(body.contract_type || 'sales_contract', '合約類型', 30, true), customerCode,
          contractDate, periodFrom, periodTo, currencyCode, text(body.note, '備註', 500), `CONTRACT:${contractNo}`, userId(req)
        ]);
        const contractId = Number(header.insertId);
        let totalAmount = 0;
        for (const [index, line] of lines.entries()) {
          const itemCode = text(line.item_code, `第 ${index + 1} 筆品號`, 40, true);
          const { item } = await assertCustomerItem(conn, c, customerCode, itemCode);
          const quantity = positive(line.quantity, `第 ${index + 1} 筆數量`);
          const unitPrice = number(line.unit_price ?? 0, `第 ${index + 1} 筆單價`, { min: 0 });
          const expectedDate = date(line.expected_date, `第 ${index + 1} 筆預計交期`);
          const amount = quantity * Number(unitPrice || 0);
          totalAmount += amount;
          await conn.query(`INSERT INTO erp_sales_contract_items(
            contract_id,line_no,item_code,item_name,specification,unit,warehouse_code,quantity,unit_price,amount,expected_date,note)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, [
            contractId, index + 1, itemCode, text(line.item_name, '品名', 160) || item.item_name,
            text(line.specification, '規格', 160) || item.specification || null, text(line.unit, '單位', 20) || item.unit || 'PCS',
            text(line.warehouse_code, '庫別', 30), quantity, unitPrice || 0, amount, expectedDate, text(line.note, '明細備註', 255)
          ]);
        }
        await conn.query('UPDATE erp_sales_contracts SET note=CONCAT(COALESCE(note,\'\'), CASE WHEN COALESCE(note,\'\')=\'\' THEN \'\' ELSE \'；\' END, ?) WHERE id=?', [`合約金額 ${totalAmount}`, contractId]);
        const after = await getContract(conn, c, contractId);
        await recordEvent(conn, 'erp_sales_contract_events', 'contract_id', contractId, c, 'created', null, after, '建立合約訂單', userId(req));
        return after;
      });
      res.status(201).json({ ok: true, data: result });
    } catch (error) { next(error); }
  });

  app.post('/api/sales-workflow/contracts/:id/approve', async (req, res, next) => {
    try {
      await ensureTargetSalesPhase2Schema();
      const c = contextOf(req), id = Number(req.params.id);
      const result = await tx(async conn => {
        const before = await getContract(conn, c, id, true);
        if (before.status !== 'draft') throw badRequest('只有草稿合約可以核准');
        const afterStatus = before.items.length ? 'approved' : 'draft';
        if (afterStatus === 'draft') throw badRequest('合約至少要有一筆明細');
        await conn.query(`UPDATE erp_sales_contracts SET status='approved',approved_by=?,approved_at=NOW()
          WHERE id=? AND ${contextParams(c).join(' AND ')}`, [userId(req), id, ...contextValues(c)]);
        const after = await getContract(conn, c, id);
        await recordEvent(conn, 'erp_sales_contract_events', 'contract_id', id, c, 'approved', before, after, text(req.body?.reason, '核准說明', 500) || '核准合約訂單', userId(req));
        return after;
      });
      res.json({ ok: true, data: result });
    } catch (error) { next(error); }
  });

  app.post('/api/sales-workflow/contracts/:id/convert', async (req, res, next) => {
    try {
      await ensureTargetSalesPhase2Schema();
      const c = contextOf(req), body = req.body || {}, id = Number(req.params.id);
      const result = await tx(async conn => {
        const contract = await getContract(conn, c, id, true);
        if (!['approved', 'partial'].includes(contract.status)) throw badRequest('只有已核准或部分轉單的合約可以轉訂單');
        const contractItemId = Number(body.contract_item_id);
        const line = contract.items.find(item => Number(item.id) === contractItemId);
        if (!line) throw badRequest('找不到目前合約的明細');
        const quantity = positive(body.quantity, '轉訂單數量');
        if (quantity > Number(line.remaining_quantity) + EPS) throw badRequest(`轉單數量超過合約未轉量 ${line.remaining_quantity}`);
        const orderDate = date(body.document_date || contract.contract_date, '訂單日期', true);
        if (orderDate < dateOnly(contract.contract_date)) throw badRequest('訂單日期不可早於合約日期');
        const documentType = await loadSalesDocumentType(conn, c, text(body.document_type, '訂單單別', 20, true), 'sales_order');
        const documentNo = text(body.document_no, '訂單單號', 60) || await nextNumber(conn, 'sales_documents', 'document_no', String(documentType.number_prefix || documentType.type_code), c, orderDate);
        const orderStatus = statusAfterApproval(documentType);
        const [orderResult] = await conn.query(`INSERT INTO sales_documents(
          tenant_id,company_id,source_system,source_database,document_kind,document_type,document_no,document_date,
          customer_code,currency_code,warehouse_code,salesperson_code,contract_id,status,inventory_status,note,created_by,
          approved_by,approved_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
          ...contextValues(c), 'sales_order', documentType.type_code, documentNo, orderDate, contract.customer_code, contract.currency_code,
          text(body.warehouse_code, '庫別', 30) || line.warehouse_code || null, text(body.salesperson_code, '業務員', 30), id,
          orderStatus, 'not_applicable', text(body.note, '備註', 500), userId(req), orderStatus === 'approved' ? userId(req) : null, orderStatus === 'approved' ? new Date() : null
        ]);
        const orderId = Number(orderResult.insertId);
        await conn.query(`INSERT INTO sales_document_items(
          document_id,line_no,source_item_id,contract_item_id,item_code,item_name,specification,unit,warehouse_code,quantity,unit_price,expected_date,note)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
          orderId, 1, null, line.id, line.item_code, line.item_name, line.specification, line.unit, line.warehouse_code,
          quantity, line.unit_price, line.expected_date || null, text(body.line_note, '明細備註', 255)
        ]);
        await conn.query('UPDATE erp_sales_contract_items SET converted_quantity=converted_quantity+? WHERE id=? AND contract_id=?', [quantity, line.id, id]);
        await refreshContractStatus(conn, c, id);
        const after = await getContract(conn, c, id);
        await recordEvent(conn, 'erp_sales_contract_events', 'contract_id', id, c, 'converted_to_order', contract, after, `轉客戶訂單 ${documentNo} ${quantity}`, userId(req));
        return { contract: after, order_id: orderId, order_no: documentNo, order_status: orderStatus, target_database: c.target_database };
      });
      res.status(201).json({ ok: true, data: result });
    } catch (error) { next(error); }
  });

  app.post('/api/sales-workflow/contracts/:id/close', async (req, res, next) => {
    try {
      await ensureTargetSalesPhase2Schema();
      const c = contextOf(req), id = Number(req.params.id);
      const result = await tx(async conn => {
        const before = await getContract(conn, c, id, true);
        const remaining = before.items.reduce((sum, item) => sum + Number(item.remaining_quantity || 0), 0);
        if (!['approved', 'partial', 'completed'].includes(before.status) || remaining > EPS) throw badRequest(`合約尚有未轉訂單數量 ${remaining}，不可結案`);
        await conn.query(`UPDATE erp_sales_contracts SET status='closed',closed_by=?,closed_at=NOW(),close_note=?
          WHERE id=? AND ${contextParams(c).join(' AND ')}`, [userId(req), text(req.body?.reason, '結案說明', 255) || '合約已全部轉訂單', id, ...contextValues(c)]);
        const after = await getContract(conn, c, id);
        await recordEvent(conn, 'erp_sales_contract_events', 'contract_id', id, c, 'closed', before, after, text(req.body?.reason, '結案說明', 500) || '合約結案', userId(req));
        return after;
      });
      res.json({ ok: true, data: result });
    } catch (error) { next(error); }
  });

  // S04：預計出貨／交期排程。排程只保留承諾量，不提前扣庫存；銷貨過帳後
  // 透過 reconcile 將已出貨量按交期 FIFO 回寫，避免排程重複占用訂單未交量。
  app.get('/api/sales-workflow/delivery-schedules', async (req, res, next) => {
    try {
      await ensureTargetSalesPhase2Schema();
      const c = contextOf(req), conditions = [...contextParams(c, 's')], params = [...contextValues(c)];
      if (req.query.order_id) { conditions.push('s.order_id=?'); params.push(Number(req.query.order_id)); }
      if (req.query.status) { conditions.push('s.status=?'); params.push(text(req.query.status, '狀態', 20)); }
      if (req.query.from_date) { conditions.push('s.scheduled_date>=?'); params.push(date(req.query.from_date, '起日', true)); }
      if (req.query.to_date) { conditions.push('s.scheduled_date<=?'); params.push(date(req.query.to_date, '迄日', true)); }
      const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
      const [rows] = await pool.query(`SELECT s.*,d.document_no order_no,d.document_date order_date,d.status order_status
        FROM erp_sales_delivery_schedules s JOIN sales_documents d ON d.id=s.order_id
        WHERE ${conditions.join(' AND ')} ORDER BY s.scheduled_date,s.id LIMIT ?`, [...params, limit]);
      res.json({ ok: true, data: rows });
    } catch (error) { next(error); }
  });

  app.post('/api/sales-workflow/delivery-schedules', async (req, res, next) => {
    try {
      await ensureTargetSalesPhase2Schema();
      const c = contextOf(req), body = req.body || {};
      const orderItemId = Number(body.order_item_id), scheduledDate = date(body.scheduled_date, '預計出貨日', true), quantity = positive(body.quantity, '排程數量');
      const result = await tx(async conn => {
        const [[line]] = await conn.query(`SELECT i.*,d.id order_id,d.document_no,d.document_date,d.customer_code,d.status order_status,d.source_database
          FROM sales_document_items i JOIN sales_documents d ON d.id=i.document_id
          WHERE i.id=? AND ${contextParams(c, 'd').join(' AND ')} AND d.document_kind='sales_order' FOR UPDATE`, [orderItemId, ...contextValues(c)]);
        if (!line) throw notFound('找不到目前公司別的訂單明細');
        if (!['approved', 'partial'].includes(line.order_status)) throw badRequest('只有已核准或部分交貨的訂單可以建立交期排程');
        const unshipped = Math.max(Number(line.quantity || 0) - Number(line.related_quantity || 0), 0);
        const [[reserved]] = await conn.query(`SELECT COALESCE(SUM(quantity),0) quantity FROM erp_sales_delivery_schedules
          WHERE order_item_id=? AND ${contextParams(c).join(' AND ')} AND status<>'cancelled'`, [orderItemId, ...contextValues(c)]);
        const available = Math.max(unshipped - Number(reserved.quantity || 0), 0);
        if (quantity > available + EPS) throw badRequest(`排程數量超過訂單尚未排程量 ${available}`);
        const scheduleNo = text(body.schedule_no, '排程單號', 60) || await nextNumber(conn, 'erp_sales_delivery_schedules', 'schedule_no', 'DS', c, scheduledDate);
        const [inserted] = await conn.query(`INSERT INTO erp_sales_delivery_schedules(
          tenant_id,company_id,source_system,source_database,schedule_no,order_id,order_item_id,customer_code,item_code,scheduled_date,quantity,status,note,created_by)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,'draft',?,?)`, [
          ...contextValues(c), scheduleNo, line.order_id, orderItemId, line.customer_code, line.item_code, scheduledDate, quantity,
          text(body.note, '備註', 500), userId(req)
        ]);
        const id = Number(inserted.insertId);
        const after = { id, schedule_no: scheduleNo, order_id: line.order_id, order_item_id: orderItemId, quantity, status: 'draft' };
        await recordEvent(conn, 'erp_sales_delivery_schedule_events', 'schedule_id', id, c, 'created', null, after, '建立預計出貨排程', userId(req));
        return after;
      });
      res.status(201).json({ ok: true, data: result });
    } catch (error) { next(error); }
  });

  app.post('/api/sales-workflow/delivery-schedules/:id/approve', async (req, res, next) => {
    try {
      await ensureTargetSalesPhase2Schema();
      const c = contextOf(req), id = Number(req.params.id);
      const result = await tx(async conn => {
        const [[before]] = await conn.query(`SELECT * FROM erp_sales_delivery_schedules WHERE id=? AND ${contextParams(c).join(' AND ')} FOR UPDATE`, [id, ...contextValues(c)]);
        if (!before) throw notFound('找不到目前公司別的交期排程');
        if (before.status !== 'draft') throw badRequest('只有草稿排程可以核准');
        await conn.query(`UPDATE erp_sales_delivery_schedules SET status='approved',approved_by=?,approved_at=NOW() WHERE id=? AND ${contextParams(c).join(' AND ')}`, [userId(req), id, ...contextValues(c)]);
        const [[after]] = await conn.query('SELECT * FROM erp_sales_delivery_schedules WHERE id=?', [id]);
        await recordEvent(conn, 'erp_sales_delivery_schedule_events', 'schedule_id', id, c, 'approved', before, after, text(req.body?.reason, '核准說明', 500) || '核准交期排程', userId(req));
        return after;
      });
      res.json({ ok: true, data: result });
    } catch (error) { next(error); }
  });

  app.post('/api/sales-workflow/delivery-schedules/:id/reconcile', async (req, res, next) => {
    try {
      await ensureTargetSalesPhase2Schema();
      const c = contextOf(req), id = Number(req.params.id);
      const result = await tx(async conn => {
        const [[target]] = await conn.query(`SELECT * FROM erp_sales_delivery_schedules WHERE id=? AND ${contextParams(c).join(' AND ')} FOR UPDATE`, [id, ...contextValues(c)]);
        if (!target) throw notFound('找不到目前公司別的交期排程');
        const [schedules] = await conn.query(`SELECT * FROM erp_sales_delivery_schedules
          WHERE order_item_id=? AND ${contextParams(c).join(' AND ')} AND status IN ('approved','partial','fulfilled') ORDER BY scheduled_date,id FOR UPDATE`, [target.order_item_id, ...contextValues(c)]);
        const [[shipped]] = await conn.query(`SELECT COALESCE(SUM(si.quantity),0) quantity FROM sales_document_items si
          JOIN sales_documents sd ON sd.id=si.document_id
          WHERE si.source_item_id=? AND ${contextParams(c, 'sd').join(' AND ')} AND sd.document_kind='shipment' AND sd.status='posted' AND sd.inventory_status='posted'`, [target.order_item_id, ...contextValues(c)]);
        let remaining = Number(shipped.quantity || 0);
        for (const schedule of schedules) {
          const fulfilled = Math.min(Number(schedule.quantity || 0), Math.max(remaining, 0));
          const nextStatus = fulfilled >= Number(schedule.quantity || 0) - EPS ? 'fulfilled' : fulfilled > EPS ? 'partial' : 'approved';
          await conn.query('UPDATE erp_sales_delivery_schedules SET fulfilled_quantity=?,status=? WHERE id=?', [fulfilled, nextStatus, schedule.id]);
          remaining -= fulfilled;
        }
        const [[after]] = await conn.query('SELECT * FROM erp_sales_delivery_schedules WHERE id=?', [id]);
        await recordEvent(conn, 'erp_sales_delivery_schedule_events', 'schedule_id', id, c, 'reconciled', target, after, `依已過帳銷貨量 ${shipped.quantity || 0} 回寫排程`, userId(req));
        return { target: after, shipped_quantity: Number(shipped.quantity || 0), unallocated_shipped_quantity: Math.max(remaining, 0) };
      });
      res.json({ ok: true, data: result });
    } catch (error) { next(error); }
  });

  app.post('/api/sales-workflow/delivery-schedules/:id/cancel', async (req, res, next) => {
    try {
      await ensureTargetSalesPhase2Schema();
      const c = contextOf(req), id = Number(req.params.id);
      const result = await tx(async conn => {
        const [[before]] = await conn.query(`SELECT * FROM erp_sales_delivery_schedules WHERE id=? AND ${contextParams(c).join(' AND ')} FOR UPDATE`, [id, ...contextValues(c)]);
        if (!before) throw notFound('找不到目前公司別的交期排程');
        if (['fulfilled', 'cancelled'].includes(before.status)) throw badRequest('已完成或已取消的排程不可再次取消');
        await conn.query(`UPDATE erp_sales_delivery_schedules SET status='cancelled',cancelled_by=?,cancelled_at=NOW() WHERE id=? AND ${contextParams(c).join(' AND ')}`, [userId(req), id, ...contextValues(c)]);
        const [[after]] = await conn.query('SELECT * FROM erp_sales_delivery_schedules WHERE id=?', [id]);
        await recordEvent(conn, 'erp_sales_delivery_schedule_events', 'schedule_id', id, c, 'cancelled', before, after, text(req.body?.reason, '取消說明', 500) || '取消交期排程', userId(req));
        return after;
      });
      res.json({ ok: true, data: result });
    } catch (error) { next(error); }
  });

  // S05：跨模組銷售例外查詢。這裡只讀取目前公司的目標資料，將「未轉、未交、
  // 已出貨未立帳、孤兒來源、未定價與逾期」統一成可追蹤的異常列，不直接修正單據。
  app.get('/api/sales-workflow/exceptions', async (req, res, next) => {
    try {
      await ensureTargetSalesPhase2Schema();
      await ensureTargetFinanceWorkflowSchema();
      const c = contextOf(req), fromDate = date(req.query.from_date, '起日'), toDate = date(req.query.to_date, '迄日'), asOf = date(req.query.as_of, '截至日') || toDate || new Date().toISOString().slice(0, 10);
      if (fromDate && toDate && fromDate > toDate) throw badRequest('起日不可晚於迄日');
      const rows = [];
      const range = (alias = 'd') => { const parts = [...contextParams(c, alias)], values = [...contextValues(c)]; if (fromDate) { parts.push(`${alias}.document_date>=?`); values.push(fromDate); } if (toDate) { parts.push(`${alias}.document_date<=?`); values.push(toDate); } return { parts, values }; };
      {
        const r = range('d');
        const [data] = await pool.query(`SELECT d.id,d.document_no,d.document_date,d.customer_code,d.status,i.item_code,
            GREATEST(i.quantity-i.related_quantity,0) remaining_quantity,
            GREATEST(i.quantity-i.related_quantity,0)*i.unit_price remaining_amount
          FROM sales_documents d JOIN sales_document_items i ON i.document_id=d.id
          WHERE ${r.parts.join(' AND ')} AND d.document_kind='quotation' AND d.status IN ('approved','partial') AND i.quantity-i.related_quantity>0
          ORDER BY d.document_date,d.id LIMIT 1000`, r.values);
        rows.push(...data.map(row => exceptionRow({ ...row, exception_code: 'QUOTE_NOT_CONVERTED', severity: 'info', reason: '報價尚有數量未轉成訂單', source_kind: 'quotation', next_stage: 'sales_order', source_key: `sales_documents:${row.id}` })));
      }
      {
        const r = range('d');
        const [data] = await pool.query(`SELECT d.id,d.document_no,d.document_date,d.customer_code,d.status,i.item_code,i.expected_date,
            GREATEST(i.quantity-i.related_quantity,0) remaining_quantity,
            GREATEST(i.quantity-i.related_quantity,0)*i.unit_price remaining_amount
          FROM sales_documents d JOIN sales_document_items i ON i.document_id=d.id
          WHERE ${r.parts.join(' AND ')} AND d.document_kind='sales_order' AND d.status IN ('approved','partial')
            AND i.expected_date IS NOT NULL AND i.expected_date<? AND i.quantity-i.related_quantity>0 ORDER BY i.expected_date,d.id LIMIT 1000`, [...r.values, asOf]);
        rows.push(...data.map(row => exceptionRow({ ...row, exception_code: 'ORDER_OVERDUE', severity: 'warning', reason: `訂單預計交期 ${String(row.expected_date).slice(0, 10)} 已逾期仍有未交量`, source_kind: 'sales_order', next_stage: 'shipment', source_key: `sales_documents:${row.id}` })));
      }
      {
        const r = range('d');
        const [data] = await pool.query(`SELECT d.id,d.document_no,d.document_date,d.customer_code,d.status,i.item_code,i.quantity,i.unit_price
          FROM sales_documents d JOIN sales_document_items i ON i.document_id=d.id
          WHERE ${r.parts.join(' AND ')} AND d.document_kind IN ('quotation','sales_order') AND d.status IN ('approved','partial') AND i.unit_price<=0
          ORDER BY d.document_date,d.id LIMIT 1000`, r.values);
        rows.push(...data.map(row => exceptionRow({ ...row, exception_code: 'SALES_LINE_UNPRICED', severity: 'warning', reason: '核准銷售單據明細沒有有效單價', source_kind: row.status, remaining_quantity: row.quantity, remaining_amount: Number(row.quantity || 0) * Number(row.unit_price || 0), next_stage: 'customer_pricing', source_key: `sales_documents:${row.id}` })));
      }
      {
        const r = range('d');
        const [data] = await pool.query(`SELECT d.id,d.document_no,d.document_date,d.customer_code,d.status,d.document_kind
          FROM sales_documents d WHERE ${r.parts.join(' AND ')} AND d.document_kind='shipment' AND d.status='posted' AND d.inventory_status='posted'
          AND NOT EXISTS(SELECT 1 FROM finance_voucher_sources vs WHERE vs.source_document_id=d.id AND vs.source_kind IN ('sales_shipment','shipment','sales_document'))
          ORDER BY d.document_date,d.id LIMIT 1000`, r.values);
        rows.push(...data.map(row => exceptionRow({ ...row, exception_code: 'SHIPMENT_NOT_INVOICED', severity: 'warning', reason: '銷貨已完成庫存過帳，但找不到應收／發票來源', source_kind: 'shipment', next_stage: 'receivable', source_key: `sales_documents:${row.id}` })));
      }
      {
        const [data] = await pool.query(`SELECT d.id,d.document_no,d.document_date,d.customer_code,d.status,d.document_kind,
            i.item_code,i.source_item_id
          FROM sales_documents d JOIN sales_document_items i ON i.document_id=d.id
          LEFT JOIN sales_document_items parent ON parent.id=i.source_item_id
          WHERE ${contextParams(c, 'd').join(' AND ')} AND i.source_item_id IS NOT NULL AND parent.id IS NULL
          ORDER BY d.document_date,d.id LIMIT 1000`, [...contextValues(c)]);
        rows.push(...data.map(row => exceptionRow({ ...row, exception_code: 'SALES_ORPHAN_SOURCE', severity: 'error', reason: '銷售明細的來源明細不存在，流程鏈結中斷', source_kind: row.document_kind, next_stage: 'correction', source_key: `sales_document_items:${row.id}` })));
      }
      {
        const r = range('d');
        const [data] = await pool.query(`SELECT d.id,d.document_no,d.document_date,d.customer_code,d.status,d.document_kind,
            DATEDIFF(?,d.document_date) age_days
          FROM sales_documents d WHERE ${r.parts.join(' AND ')} AND d.status='draft' AND d.document_date<?
          ORDER BY d.document_date,d.id LIMIT 1000`, [asOf, ...r.values, asOf]);
        rows.push(...data.map(row => exceptionRow({ ...row, exception_code: 'SALES_DRAFT_AGING', severity: 'info', reason: `草稿單據已存在 ${row.age_days} 天尚未核准`, source_kind: row.document_kind, next_stage: 'approve', source_key: `sales_documents:${row.id}` })));
      }
      const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 2000);
      const limited = rows.slice(0, limit);
      const summary = limited.reduce((out, row) => { out.total += 1; out[row.severity] = (out[row.severity] || 0) + 1; out[row.exception_code] = (out[row.exception_code] || 0) + 1; return out; }, { total: 0 });
      res.json({ ok: true, data: { rows: limited, summary, criteria: { from_date: fromDate, to_date: toDate, as_of: asOf }, company_id: c.company_id, source_database: c.source_database, target_database: c.target_database } });
    } catch (error) { next(error); }
  });

  // S06：訂單後續管理工具，重計已交量、受控結案、揀貨單與缺料採購需求。
  app.post('/api/sales-workflow/orders/:id/recalculate', async (req, res, next) => {
    try {
      await ensureTargetSalesPhase2Schema();
      const c = contextOf(req), id = Number(req.params.id);
      const result = await tx(async conn => {
        const before = await readOrder(conn, c, id, true);
        if (['draft', 'voided'].includes(before.status)) throw badRequest('草稿或作廢訂單不可重算交貨量');
        if (before.status === 'closed') throw badRequest('已結案訂單不可直接重算，請先走受控沖回／重開流程');
        const afterItems = [];
        for (const item of before.items) {
          const [[row]] = await conn.query(`SELECT COALESCE(SUM(si.quantity),0) quantity FROM sales_document_items si
            JOIN sales_documents sd ON sd.id=si.document_id
            WHERE si.source_item_id=? AND ${contextParams(c, 'sd').join(' AND ')} AND sd.document_kind='shipment' AND sd.status='posted' AND sd.inventory_status='posted'`, [item.id, ...contextValues(c)]);
          const delivered = Math.min(Number(item.quantity || 0), Number(row.quantity || 0));
          await conn.query('UPDATE sales_document_items SET related_quantity=? WHERE id=?', [delivered, item.id]);
          afterItems.push({ id: item.id, before_related_quantity: Number(item.related_quantity || 0), related_quantity: delivered });
        }
        const allDelivered = afterItems.length > 0 && before.items.every((item, index) => Number(afterItems[index].related_quantity) >= Number(item.quantity) - EPS);
        const someDelivered = afterItems.some(item => item.related_quantity > EPS);
        const afterStatus = allDelivered ? 'completed' : someDelivered ? 'partial' : 'approved';
        await conn.query(`UPDATE sales_documents SET status=? WHERE id=? AND ${contextParams(c).join(' AND ')}`, [afterStatus, id, ...contextValues(c)]);
        const after = await readOrder(conn, c, id);
        await recordOrderControlEvent(conn, c, id, 'recalculated', before, after, text(req.body?.reason, '重算說明', 500) || '依已過帳銷貨重算訂單已交量', userId(req));
        return { before, after, item_changes: afterItems };
      });
      res.json({ ok: true, data: result });
    } catch (error) { next(error); }
  });

  app.post('/api/sales-workflow/orders/:id/close', async (req, res, next) => {
    try {
      await ensureTargetSalesPhase2Schema();
      const c = contextOf(req), id = Number(req.params.id);
      const result = await tx(async conn => {
        const before = await readOrder(conn, c, id, true);
        const remaining = before.items.reduce((sum, item) => sum + Math.max(Number(item.quantity || 0) - Number(item.related_quantity || 0), 0), 0);
        if (remaining > EPS) throw badRequest(`訂單尚有未交量 ${remaining}，不可結案`);
        if (!['approved', 'partial', 'completed'].includes(before.status)) throw badRequest('目前訂單狀態不可結案');
        await conn.query(`UPDATE sales_documents SET status='closed',closed_by=?,closed_at=NOW(),close_note=? WHERE id=? AND ${contextParams(c).join(' AND ')}`, [userId(req), text(req.body?.reason, '結案說明', 255) || '訂單已全部交付', id, ...contextValues(c)]);
        const after = await readOrder(conn, c, id);
        await recordOrderControlEvent(conn, c, id, 'closed', before, after, text(req.body?.reason, '結案說明', 500) || '訂單結案', userId(req));
        return after;
      });
      res.json({ ok: true, data: result });
    } catch (error) { next(error); }
  });

  app.get('/api/sales-workflow/pick-lists', async (req, res, next) => {
    try {
      await ensureTargetSalesPhase2Schema();
      const c = contextOf(req), params = [...contextValues(c)], conditions = [...contextParams(c, 'p')];
      if (req.query.order_id) { conditions.push('p.order_id=?'); params.push(Number(req.query.order_id)); }
      if (req.query.status) { conditions.push('p.status=?'); params.push(text(req.query.status, '狀態', 20)); }
      const [rows] = await pool.query(`SELECT p.*,d.document_no order_no,d.customer_code
        FROM erp_sales_pick_lists p JOIN sales_documents d ON d.id=p.order_id
        WHERE ${conditions.join(' AND ')} ORDER BY p.pick_date DESC,p.id DESC LIMIT 500`, params);
      for (const row of rows) {
        const [items] = await pool.query('SELECT * FROM erp_sales_pick_list_items WHERE pick_list_id=? ORDER BY id', [row.id]);
        row.items = items;
      }
      res.json({ ok: true, data: rows });
    } catch (error) { next(error); }
  });

  app.post('/api/sales-workflow/orders/:id/pick-lists', async (req, res, next) => {
    try {
      await ensureTargetSalesPhase2Schema();
      const c = contextOf(req), body = req.body || {}, orderId = Number(req.params.id);
      const rawLines = parseObjectArray(body.items, '揀貨明細');
      const result = await tx(async conn => {
        const order = await readOrder(conn, c, orderId, true);
        if (!['approved', 'partial'].includes(order.status)) throw badRequest('只有已核准或部分交貨的訂單可以建立揀貨單');
        const lines = rawLines.length ? rawLines : order.items.map(item => ({ order_item_id: item.id, quantity: Math.max(Number(item.quantity) - Number(item.related_quantity), 0) })).filter(item => item.quantity > EPS);
        if (!lines.length || lines.length > 200) throw badRequest('揀貨單至少要有一筆明細，且不可超過 200 筆');
        const pickDate = date(body.pick_date || new Date().toISOString().slice(0, 10), '揀貨日期', true);
        const pickNo = text(body.pick_no, '揀貨單號', 60) || await nextNumber(conn, 'erp_sales_pick_lists', 'pick_no', 'PK', c, pickDate);
        const [header] = await conn.query(`INSERT INTO erp_sales_pick_lists(
          tenant_id,company_id,source_system,source_database,pick_no,order_id,warehouse_code,pick_date,status,note,created_by)
          VALUES(?,?,?,?,?,?,?,?,'draft',?,?)`, [...contextValues(c), pickNo, orderId, text(body.warehouse_code, '庫別', 30), pickDate, text(body.note, '備註', 500), userId(req)]);
        const pickId = Number(header.insertId);
        for (const [index, input] of lines.entries()) {
          const line = order.items.find(item => Number(item.id) === Number(input.order_item_id));
          if (!line) throw badRequest(`第 ${index + 1} 筆不是目前訂單明細`);
          const quantity = positive(input.quantity, `第 ${index + 1} 筆揀貨量`);
          const [[reserved]] = await conn.query(`SELECT COALESCE(SUM(pi.quantity),0) quantity FROM erp_sales_pick_list_items pi
            JOIN erp_sales_pick_lists p ON p.id=pi.pick_list_id
            WHERE pi.order_item_id=? AND ${contextParams(c, 'p').join(' AND ')} AND p.status<>'cancelled'`, [line.id, ...contextValues(c)]);
          const available = Math.max(Number(line.quantity) - Number(line.related_quantity) - Number(reserved.quantity || 0), 0);
          if (quantity > available + EPS) throw badRequest(`第 ${index + 1} 筆揀貨量超過可揀量 ${available}`);
          await conn.query('INSERT INTO erp_sales_pick_list_items(pick_list_id,order_item_id,item_code,quantity,note) VALUES(?,?,?,?,?)', [pickId, line.id, line.item_code, quantity, text(input.note, '明細備註', 255)]);
        }
        const [[after]] = await conn.query('SELECT * FROM erp_sales_pick_lists WHERE id=?', [pickId]);
        await recordOrderControlEvent(conn, c, orderId, 'pick_list_created', null, after, `建立揀貨單 ${pickNo}`, userId(req));
        return after;
      });
      res.status(201).json({ ok: true, data: result });
    } catch (error) { next(error); }
  });

  app.post('/api/sales-workflow/pick-lists/:id/approve', async (req, res, next) => {
    try {
      await ensureTargetSalesPhase2Schema();
      const c = contextOf(req), id = Number(req.params.id);
      const [[before]] = await pool.query(`SELECT p.* FROM erp_sales_pick_lists p JOIN sales_documents d ON d.id=p.order_id
        WHERE p.id=? AND ${contextParams(c, 'p').join(' AND ')}`, [id, ...contextValues(c)]);
      if (!before) throw notFound('找不到目前公司別的揀貨單');
      if (before.status !== 'draft') throw badRequest('只有草稿揀貨單可以核准');
      await pool.query(`UPDATE erp_sales_pick_lists SET status='approved',approved_by=?,approved_at=NOW() WHERE id=? AND ${contextParams(c).join(' AND ')}`, [userId(req), id, ...contextValues(c)]);
      res.json({ ok: true, data: { id, status: 'approved' } });
    } catch (error) { next(error); }
  });

  app.post('/api/sales-workflow/pick-lists/:id/complete', async (req, res, next) => {
    try {
      await ensureTargetSalesPhase2Schema();
      const c = contextOf(req), id = Number(req.params.id);
      const [[before]] = await pool.query(`SELECT * FROM erp_sales_pick_lists WHERE id=? AND ${contextParams(c).join(' AND ')} FOR UPDATE`, [id, ...contextValues(c)]);
      if (!before) throw notFound('找不到目前公司別的揀貨單');
      if (before.status !== 'approved') throw badRequest('只有已核准揀貨單可以完成揀貨');
      const [items] = await pool.query('SELECT * FROM erp_sales_pick_list_items WHERE pick_list_id=?', [id]);
      for (const item of items) await pool.query('UPDATE erp_sales_pick_list_items SET picked_quantity=quantity WHERE id=?', [item.id]);
      await pool.query(`UPDATE erp_sales_pick_lists SET status='picked',completed_by=?,completed_at=NOW() WHERE id=? AND ${contextParams(c).join(' AND ')}`, [userId(req), id, ...contextValues(c)]);
      res.json({ ok: true, data: { id, status: 'picked', line_count: items.length } });
    } catch (error) { next(error); }
  });

  app.get('/api/sales-workflow/procurement-demands', async (req, res, next) => {
    try {
      await ensureTargetSalesPhase2Schema();
      const c = contextOf(req), conditions = [...contextParams(c)], params = [...contextValues(c)];
      if (req.query.order_id) { conditions.push('order_id=?'); params.push(Number(req.query.order_id)); }
      if (req.query.status) { conditions.push('status=?'); params.push(text(req.query.status, '狀態', 20)); }
      const [rows] = await pool.query(`SELECT * FROM erp_sales_procurement_demands WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT 500`, params);
      res.json({ ok: true, data: rows });
    } catch (error) { next(error); }
  });

  app.post('/api/sales-workflow/orders/:id/procurement-demands', async (req, res, next) => {
    try {
      await ensureTargetSalesPhase2Schema();
      const c = contextOf(req), body = req.body || {}, orderId = Number(req.params.id), rawLines = parseObjectArray(body.items, '採購需求明細');
      const result = await tx(async conn => {
        const order = await readOrder(conn, c, orderId, true);
        if (!['approved', 'partial'].includes(order.status)) throw badRequest('只有已核准或部分交貨的訂單可以建立採購需求');
        const lines = rawLines.length ? rawLines : [{ order_item_id: body.order_item_id, quantity: body.quantity }];
        if (lines.length > 200) throw badRequest('採購需求明細不可超過 200 筆');
        const demandDate = date(body.demand_date || new Date().toISOString().slice(0, 10), '需求日期', true);
        const demandNo = text(body.demand_no, '需求單號', 60) || await nextNumber(conn, 'erp_sales_procurement_demands', 'demand_no', 'SD', c, demandDate);
        const inserted = [];
        for (const [index, input] of lines.entries()) {
          const line = order.items.find(item => Number(item.id) === Number(input.order_item_id));
          if (!line) throw badRequest(`第 ${index + 1} 筆不是目前訂單明細`);
          const quantity = positive(input.quantity, `第 ${index + 1} 筆需求量`);
          const remaining = Math.max(Number(line.quantity) - Number(line.related_quantity), 0);
          if (quantity > remaining + EPS) throw badRequest(`第 ${index + 1} 筆需求量超過訂單未交量 ${remaining}`);
          const [row] = await conn.query(`INSERT INTO erp_sales_procurement_demands(
            tenant_id,company_id,source_system,source_database,demand_no,order_id,order_item_id,item_code,quantity,status,reason,created_by)
            VALUES(?,?,?,?,?,?,?,?,?,'draft',?,?)`, [...contextValues(c), `${demandNo}-${index + 1}`, orderId, line.id, line.item_code, quantity, text(input.reason || body.reason, '需求原因', 500, true), userId(req)]);
          inserted.push(Number(row.insertId));
        }
        await recordOrderControlEvent(conn, c, orderId, 'procurement_demand_created', null, { demand_no: demandNo, ids: inserted }, '建立訂單缺料採購需求；待採購人員轉成請購／採購', userId(req));
        return { demand_no: demandNo, ids: inserted, status: 'draft' };
      });
      res.status(201).json({ ok: true, data: result });
    } catch (error) { next(error); }
  });

  app.post('/api/sales-workflow/procurement-demands/:id/submit', async (req, res, next) => {
    try {
      await ensureTargetSalesPhase2Schema();
      const c = contextOf(req), id = Number(req.params.id);
      const [result] = await pool.query(`UPDATE erp_sales_procurement_demands SET status='pending',approved_by=NULL,approved_at=NULL
        WHERE id=? AND ${contextParams(c).join(' AND ')} AND status='draft'`, [id, ...contextValues(c)]);
      if (!result.affectedRows) throw badRequest('只有目前公司的草稿採購需求可以送審');
      res.json({ ok: true, data: { id, status: 'pending' } });
    } catch (error) { next(error); }
  });

  app.post('/api/sales-workflow/procurement-demands/:id/approve', async (req, res, next) => {
    try {
      await ensureTargetSalesPhase2Schema();
      const c = contextOf(req), id = Number(req.params.id);
      const [result] = await pool.query(`UPDATE erp_sales_procurement_demands SET status='converted',approved_by=?,approved_at=NOW()
        WHERE id=? AND ${contextParams(c).join(' AND ')} AND status='pending'`, [userId(req), id, ...contextValues(c)]);
      if (!result.affectedRows) throw badRequest('只有目前公司的待審採購需求可以核准');
      res.json({ ok: true, data: { id, status: 'converted', message: '需求已核准；請由採購作業建立正式請購／採購單，正式單號待回寫。' } });
    } catch (error) { next(error); }
  });

  // S07：銷售文件／憑證匯出與列印資料。輸出只讀，不改變文件狀態；財務憑單
  // 透過 finance_voucher_sources 回查，因此報價、訂單、銷貨與應收可對應。
  app.get('/api/sales-workflow/documents/export', async (req, res, next) => {
    try {
      await ensureTargetSalesPhase2Schema();
      await ensureTargetFinanceWorkflowSchema();
      const c = contextOf(req), conditions = [...contextParams(c, 'd')], params = [...contextValues(c)];
      if (req.query.document_kind) { conditions.push('d.document_kind=?'); params.push(text(req.query.document_kind, '文件種類', 30)); }
      if (req.query.from_date) { conditions.push('d.document_date>=?'); params.push(date(req.query.from_date, '起日', true)); }
      if (req.query.to_date) { conditions.push('d.document_date<=?'); params.push(date(req.query.to_date, '迄日', true)); }
      if (req.query.customer_code) { conditions.push('d.customer_code=?'); params.push(text(req.query.customer_code, '客戶代號', 30)); }
      if (req.query.document_no) { conditions.push('d.document_no LIKE ?'); params.push(`%${text(req.query.document_no, '單號', 60)}%`); }
      const limit = Math.min(Math.max(Number(req.query.limit) || 1000, 1), 5000);
      const [rows] = await pool.query(`SELECT d.id,d.document_kind,d.document_type,d.document_no,d.document_date,d.customer_code,d.currency_code,
          d.status,d.inventory_status,d.contract_id,i.id item_id,i.contract_item_id,i.line_no,i.item_code,i.item_name,i.quantity,i.related_quantity,
          GREATEST(i.quantity-i.related_quantity,0) remaining_quantity,i.unit_price,i.expected_date,i.price_source_kind,i.price_source_no,
          (SELECT COUNT(*) FROM finance_voucher_sources vs WHERE vs.source_document_id=d.id) finance_source_count
        FROM sales_documents d JOIN sales_document_items i ON i.document_id=d.id
        WHERE ${conditions.join(' AND ')} ORDER BY d.document_date,d.document_no,i.line_no LIMIT ?`, [...params, limit]);
      const headers = ['文件種類','單別','單號','日期','客戶','幣別','狀態','庫存狀態','合約ID','明細行','品號','數量','已交量','剩餘量','單價','預計日期','價格來源','財務來源數'];
      const csvRows = [headers, ...rows.map(row => [row.document_kind,row.document_type,row.document_no,String(row.document_date).slice(0, 10),row.customer_code,row.currency_code,row.status,row.inventory_status,row.contract_id,row.line_no,row.item_code,row.quantity,row.related_quantity,row.remaining_quantity,row.unit_price,row.expected_date ? String(row.expected_date).slice(0, 10) : '',row.price_source_kind || '',row.finance_source_count])];
      const csv = `\uFEFF${csvRows.map(row => row.map(csvCell).join(',')).join('\r\n')}`;
      res.json({ ok: true, data: { rows, csv, filename: `sales-documents-${c.source_database}-${new Date().toISOString().slice(0, 10)}.csv`, criteria: req.query, company_id: c.company_id, source_database: c.source_database, target_database: c.target_database } });
    } catch (error) { next(error); }
  });

  app.get('/api/sales-workflow/documents/:id/print', async (req, res, next) => {
    try {
      await ensureTargetSalesPhase2Schema();
      await ensureTargetFinanceWorkflowSchema();
      const c = contextOf(req), id = Number(req.params.id);
      const [[document]] = await pool.query(`SELECT * FROM sales_documents WHERE id=? AND ${contextParams(c).join(' AND ')}`, [id, ...contextValues(c)]);
      if (!document) throw notFound('找不到目前公司別的銷售文件');
      const [items] = await pool.query('SELECT * FROM sales_document_items WHERE document_id=? ORDER BY line_no,id', [id]);
      const [vouchers] = await pool.query(`SELECT DISTINCT v.* FROM finance_vouchers v JOIN finance_voucher_sources vs ON vs.voucher_id=v.id
        WHERE ${contextParams(c, 'v').join(' AND ')} AND vs.source_document_id=? ORDER BY v.voucher_date,v.id`, [...contextValues(c), id]);
      res.json({ ok: true, data: { document, items, finance_vouchers: vouchers, printed_at: new Date().toISOString(), source_database: c.source_database, target_database: c.target_database } });
    } catch (error) { next(error); }
  });
}

async function insertSalesPricingBatchEvent(conn, pricingId, c, eventKind, before, after, reason, changedBy) {
  await conn.query(`INSERT INTO erp_customer_item_price_events(
    pricing_id,tenant_id,company_id,source_system,source_database,event_kind,before_json,after_json,reason,changed_by)
    VALUES(?,?,?,?,?,?,?,?,?,?)`, [pricingId, ...contextValues(c), eventKind, json(before), json(after), String(reason || eventKind).slice(0, 500), changedBy]);
}
