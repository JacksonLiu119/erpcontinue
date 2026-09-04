import { pool, getSourcePool, sourceDatabases, tx, ensureTargetSalesForecastSchema } from './db.js';

const EPS = 0.000001;

function text(value, max = 500) {
  const result = String(value ?? '').trim();
  return result ? result.slice(0, max) : null;
}

function requiredText(value, label, max = 120) {
  const result = text(value, max);
  if (!result) throw badRequest(label + '為必填');
  return result;
}

function number(value, label, { required = false, min = null } = {}) {
  if (value === null || value === undefined || String(value).trim() === '') {
    if (required) throw badRequest(label + '為必填');
    return null;
  }
  const result = Number(value);
  if (!Number.isFinite(result) || (min !== null && result < min - EPS)) {
    throw badRequest(label + '格式或範圍錯誤');
  }
  return result;
}

function dateText(value, label = '日期', required = true) {
  const result = value instanceof Date
    ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(value)
    : String(value ?? '').trim().slice(0, 10);
  if (!result) {
    if (required) throw badRequest(label + '為必填');
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw badRequest(label + '格式錯誤，請使用 YYYY-MM-DD');
  const date = new Date(result + 'T00:00:00Z');
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== result) throw badRequest(label + '不是有效日期');
  return result;
}

function bool(value) {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value ?? '').trim().toLowerCase()) ? 1 : 0;
}

function badRequest(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function notFound(message) {
  return badRequest(message, 404);
}

function contextForDatabase(value) {
  const sourceName = String(value || '').trim().toUpperCase();
  const source = sourceDatabases[sourceName];
  if (!source) throw badRequest('不允許的資料庫來源：' + sourceName);
  return {
    sourceName,
    source,
    context: {
      tenant_id: source.tenant_id || sourceName,
      company_id: source.company_id || sourceName,
      source_system: source.source_system || source.adapter_code || 'iSM',
      source_database: sourceName
    }
  };
}

function requestContext(req) {
  return contextForDatabase(req.erpContext?.source_database || req.body?.source_database || req.query.source_database || 'SH');
}

function contextWhere(alias, context) {
  const prefix = alias ? alias + '.' : '';
  return [
    prefix + 'tenant_id=?',
    prefix + 'company_id=?',
    prefix + 'source_system=?',
    prefix + 'source_database=?'
  ];
}

function contextParams(context) {
  return [context.tenant_id, context.company_id, context.source_system, context.source_database];
}

async function sourceTableNames(sourceName) {
  const sourcePool = getSourcePool(sourceName);
  const [rows] = await sourcePool.query(
    "SELECT LOWER(TABLE_NAME) table_name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND LOWER(TABLE_NAME) IN ('copme','copmf')"
  );
  return { sourcePool, tables: new Set(rows.map(row => String(row.table_name).toLowerCase())) };
}

async function loadSourceForecast(sourceName, limit = 100) {
  const { sourcePool, tables } = await sourceTableNames(sourceName);
  const source = sourceDatabases[sourceName];
  const company = String(source.company_id || sourceName).trim();
  const result = { header: [], detail: [], source_read_only: true, source_database: sourceName, tables: [...tables] };
  if (tables.has('copme')) {
    const [rows] = await sourcePool.query(
      'SELECT * FROM copme WHERE TRIM(COMPANY)=? ORDER BY CREATE_DATE DESC, ME001 DESC LIMIT ?',
      [company, limit]
    );
    result.header = rows;
  }
  if (tables.has('copmf')) {
    const [rows] = await sourcePool.query(
      'SELECT * FROM copmf WHERE TRIM(COMPANY)=? ORDER BY CREATE_DATE DESC, MF002, MF003 LIMIT ?',
      [company, limit * 5]
    );
    result.detail = rows;
  }
  if (!result.header.length && !result.detail.length) {
    result.warning = '來源 COPME／COPMF 目前沒有可供匯入的銷售預測資料；本頁不會回寫來源資料庫。';
  }
  return result;
}

async function targetForecast(conn, context, id, lock = false) {
  const suffix = lock ? ' FOR UPDATE' : '';
  const [[header]] = await conn.query(
    'SELECT * FROM erp_sales_forecasts WHERE id=? AND ' + contextWhere('', context).join(' AND ') + suffix,
    [id, ...contextParams(context)]
  );
  if (!header) throw notFound('找不到目前公司別的銷售預測');
  const [items] = await conn.query(
    'SELECT * FROM erp_sales_forecast_items WHERE forecast_id=? ORDER BY line_no,id',
    [id]
  );
  return { header, items };
}

function forecastSnapshot(header, items = []) {
  if (!header) return null;
  return {
    id: header.id,
    forecast_no: header.forecast_no,
    forecast_version: header.forecast_version,
    forecast_basis: header.forecast_basis,
    period_from: dateText(header.period_from, '期間起日'),
    period_to: dateText(header.period_to, '期間迄日'),
    customer_code: header.customer_code,
    department_code: header.department_code,
    salesperson_code: header.salesperson_code,
    channel_code: header.channel_code,
    customer_type: header.customer_type,
    include_production_plan: Number(header.include_production_plan || 0),
    status: header.status,
    close_mode: header.close_mode,
    line_count: items.length,
    forecast_quantity: items.reduce((sum, item) => sum + Number(item.forecast_quantity || 0), 0),
    ordered_quantity: items.reduce((sum, item) => sum + Number(item.ordered_quantity || 0), 0),
    remaining_quantity: items.reduce((sum, item) => sum + Math.max(Number(item.forecast_quantity || 0) - Number(item.ordered_quantity || 0), 0), 0),
    forecast_amount: items.reduce((sum, item) => sum + Number(item.forecast_amount || 0), 0),
    ordered_amount: items.reduce((sum, item) => sum + Number(item.ordered_amount || 0), 0),
    remaining_amount: items.reduce((sum, item) => sum + Math.max(Number(item.forecast_amount || 0) - Number(item.ordered_amount || 0), 0), 0)
  };
}

async function validateItem(conn, context, itemCode) {
  const code = requiredText(itemCode, '品號', 40);
  const [[row]] = await conn.query(
    'SELECT id,item_code,item_name,specification,unit,category_1,category_2,category_3,category_4 FROM erp_items WHERE ' +
    contextWhere('', context).join(' AND ') + ' AND item_code=? LIMIT 1',
    [...contextParams(context), code]
  );
  if (!row) throw badRequest('找不到目前公司別的品號主檔：' + code);
  return row;
}

async function validateCategory(conn, context, categoryType, categoryCode) {
  const code = requiredText(categoryCode, '分類' + categoryType, 30);
  const [[row]] = await conn.query(
    'SELECT category_code,category_name FROM erp_item_categories WHERE ' +
    contextWhere('', context).join(' AND ') + ' AND category_type=? AND category_code=? LIMIT 1',
    [...contextParams(context), String(categoryType), code]
  );
  if (!row) throw badRequest('找不到目前公司別的分類' + categoryType + '：' + code);
  return row;
}

async function validateReferences(conn, context, body) {
  const customerCode = text(body.customer_code, 30);
  if (customerCode) {
    const [[customer]] = await conn.query(
      'SELECT customer_code,customer_name FROM erp_customers WHERE ' +
      contextWhere('', context).join(' AND ') + ' AND customer_code=? LIMIT 1',
      [...contextParams(context), customerCode]
    );
    if (!customer) throw badRequest('找不到目前公司別的客戶主檔：' + customerCode);
  }
  let currencyCode = text(body.currency_code, 10);
  if (!currencyCode) {
    const [[defaultCurrency]] = await conn.query(
      "SELECT currency_code FROM erp_currencies WHERE " + contextWhere('', context).join(' AND ') +
      " ORDER BY CASE currency_code WHEN 'NTD' THEN 1 WHEN 'TWD' THEN 2 ELSE 3 END, id LIMIT 1",
      contextParams(context)
    );
    currencyCode = defaultCurrency?.currency_code || null;
  }
  if (!currencyCode) throw badRequest('目前公司尚未建立可用幣別主檔');
  const [[currency]] = await conn.query(
    'SELECT currency_code FROM erp_currencies WHERE ' + contextWhere('', context).join(' AND ') + ' AND currency_code=? LIMIT 1',
    [...contextParams(context), currencyCode]
  );
  if (!currency) throw badRequest('目前公司尚未建立幣別主檔：' + currencyCode);
  const warehouseCode = text(body.warehouse_code, 30);
  if (warehouseCode) {
    const [[warehouse]] = await conn.query(
      'SELECT warehouse_code FROM erp_warehouses WHERE ' + contextWhere('', context).join(' AND ') + ' AND warehouse_code=? LIMIT 1',
      [...contextParams(context), warehouseCode]
    );
    if (!warehouse) throw badRequest('找不到目前公司別的庫別主檔：' + warehouseCode);
  }
  return { customerCode, currencyCode, warehouseCode };
}

async function normalizeForecastInput(conn, context, body, current = null) {
  const value = (key, fallback = null) =>
    Object.prototype.hasOwnProperty.call(body, key) ? body[key] : (current?.[key] ?? fallback);
  const basis = text(value('forecast_basis', 'item'), 12);
  if (!['item', 'category'].includes(basis)) throw badRequest('預測基礎只能選依品號或依類別');
  const periodFrom = dateText(value('period_from'), '預測期間起日');
  const periodTo = dateText(value('period_to'), '預測期間迄日');
  if (periodTo < periodFrom) throw badRequest('預測期間迄日不可早於起日');
  const refs = await validateReferences(conn, context, {
    customer_code: value('customer_code'),
    currency_code: value('currency_code'),
    warehouse_code: value('warehouse_code')
  });
  const rawLines = Array.isArray(body.lines) ? body.lines : (Array.isArray(body.items) ? body.items : null);
  if (!rawLines || !rawLines.length) throw badRequest('至少要有一筆銷售預測明細');
  if (rawLines.length > 500) throw badRequest('單一預測最多 500 筆明細');
  const lines = [];
  const seen = new Set();
  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index] || {};
    const lineNo = index + 1;
    const forecastDate = dateText(raw.forecast_date || raw.date || periodFrom, '第 ' + lineNo + ' 筆預測日期');
    if (forecastDate < periodFrom || forecastDate > periodTo) throw badRequest('第 ' + lineNo + ' 筆預測日期不在預測期間內');
    const warehouseCode = text(raw.warehouse_code, 30) || refs.warehouseCode;
    if (warehouseCode) {
      const [[warehouse]] = await conn.query(
        'SELECT warehouse_code FROM erp_warehouses WHERE ' + contextWhere('', context).join(' AND ') + ' AND warehouse_code=? LIMIT 1',
        [...contextParams(context), warehouseCode]
      );
      if (!warehouse) throw badRequest('第 ' + lineNo + ' 筆找不到目前公司別的庫別：' + warehouseCode);
    }
    const quantity = number(raw.forecast_quantity ?? raw.quantity, '第 ' + lineNo + ' 筆預測數量', { required: true, min: 0 });
    const unitPrice = number(raw.unit_price, '第 ' + lineNo + ' 筆單價', { required: true, min: 0 });
    const currencyCode = text(raw.currency_code, 10) || refs.currencyCode;
    const [[currency]] = await conn.query(
      'SELECT currency_code FROM erp_currencies WHERE ' + contextWhere('', context).join(' AND ') + ' AND currency_code=? LIMIT 1',
      [...contextParams(context), currencyCode]
    );
    if (!currency) throw badRequest('第 ' + lineNo + ' 筆找不到目前公司別的幣別：' + currencyCode);
    let item = null;
    const line = {
      line_no: lineNo,
      item_code: null,
      item_name: null,
      specification: null,
      category_1: null,
      category_2: null,
      category_3: null,
      category_4: null,
      forecast_date: forecastDate,
      warehouse_code: warehouseCode,
      forecast_quantity: quantity,
      ordered_quantity: 0,
      unit: text(raw.unit, 20) || 'PCS',
      currency_code: currencyCode,
      unit_price: unitPrice,
      forecast_amount: quantity * unitPrice,
      ordered_amount: 0,
      close_mode: text(raw.close_mode || value('close_mode', 'auto'), 10) === 'manual' ? 'manual' : 'auto',
      status: 'open',
      source_table: 'manual',
      source_key: text(raw.source_key, 160),
      note: text(raw.note, 500)
    };
    if (basis === 'item') {
      item = await validateItem(conn, context, raw.item_code);
      line.item_code = item.item_code;
      line.item_name = item.item_name;
      line.specification = item.specification;
      line.unit = text(raw.unit, 20) || item.unit || 'PCS';
      line.category_1 = item.category_1;
      line.category_2 = item.category_2;
      line.category_3 = item.category_3;
      line.category_4 = item.category_4;
      if (text(raw.item_code, 40) !== item.item_code) throw badRequest('第 ' + lineNo + ' 筆品號格式錯誤');
    } else {
      for (let categoryType = 1; categoryType <= 4; categoryType += 1) {
        const category = await validateCategory(conn, context, categoryType, raw['category_' + categoryType]);
        line['category_' + categoryType] = category.category_code;
      }
      line.unit = text(raw.unit, 20) || 'PCS';
    }
    const key = [
      basis,
      line.item_code || '',
      line.category_1 || '',
      line.category_2 || '',
      line.category_3 || '',
      line.category_4 || '',
      line.forecast_date,
      line.warehouse_code || '',
      line.currency_code
    ].join('|');
    if (seen.has(key)) throw badRequest('第 ' + lineNo + ' 筆明細與前面明細重複');
    seen.add(key);
    lines.push(line);
  }
  return {
    forecast_no: text(value('forecast_no'), 60),
    forecast_version: text(value('forecast_version', 'V1'), 40) || 'V1',
    forecast_basis: basis,
    period_from: periodFrom,
    period_to: periodTo,
    customer_code: refs.customerCode,
    department_code: text(value('department_code'), 30),
    salesperson_code: text(value('salesperson_code'), 30),
    channel_code: text(value('channel_code'), 30),
    customer_type: text(value('customer_type'), 30),
    include_production_plan: bool(value('include_production_plan', 0)),
    customer_description: text(value('customer_description'), 500),
    source_kind: text(value('source_kind', 'manual'), 30) || 'manual',
    source_table: text(value('source_table', 'manual'), 60) || 'manual',
    source_key: text(value('source_key'), 160),
    note: text(value('note'), 500),
    close_mode: text(value('close_mode', 'auto'), 10) === 'manual' ? 'manual' : 'auto',
    lines
  };
}

async function nextForecastNumber(conn, context, periodFrom) {
  const prefix = 'FC' + periodFrom.replace(/-/g, '').slice(0, 8);
  for (let serial = 1; serial <= 9999; serial += 1) {
    const candidate = prefix + String(serial).padStart(4, '0');
    const [[row]] = await conn.query(
      'SELECT id FROM erp_sales_forecasts WHERE ' + contextWhere('', context).join(' AND ') + ' AND forecast_no=? LIMIT 1',
      [...contextParams(context), candidate]
    );
    if (!row) return candidate;
  }
  throw badRequest('今日銷售預測單號已用罄，請調整編號規則');
}

async function insertForecastLines(conn, forecastId, lines) {
  for (const line of lines) {
    await conn.query(
      'INSERT INTO erp_sales_forecast_items(' +
      'forecast_id,line_no,item_code,item_name,specification,category_1,category_2,category_3,category_4,' +
      'forecast_date,warehouse_code,forecast_quantity,ordered_quantity,unit,currency_code,unit_price,' +
      'forecast_amount,ordered_amount,close_mode,status,source_table,source_key,note) ' +
      'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        forecastId, line.line_no, line.item_code, line.item_name, line.specification,
        line.category_1, line.category_2, line.category_3, line.category_4, line.forecast_date,
        line.warehouse_code, line.forecast_quantity, 0, line.unit, line.currency_code, line.unit_price,
        line.forecast_amount, 0, line.close_mode, 'open', line.source_table, line.source_key, line.note
      ]
    );
  }
}

async function insertForecastEvent(conn, forecastId, context, eventKind, before, after, reason, userId) {
  await conn.query(
    'INSERT INTO erp_sales_forecast_events(' +
    'forecast_id,tenant_id,company_id,source_system,source_database,event_kind,before_json,after_json,reason,changed_by) ' +
    'VALUES(?,?,?,?,?,?,?,?,?,?)',
    [
      forecastId, context.tenant_id, context.company_id, context.source_system, context.source_database,
      eventKind, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null,
      reason || eventKind, userId || null
    ]
  );
}

export async function refreshSalesForecastMetrics(conn, context, forecastId) {
  const [[header]] = await conn.query(
    'SELECT * FROM erp_sales_forecasts WHERE id=? AND ' + contextWhere('', context).join(' AND ') + ' FOR UPDATE',
    [forecastId, ...contextParams(context)]
  );
  if (!header) return null;
  const [items] = await conn.query('SELECT * FROM erp_sales_forecast_items WHERE forecast_id=? ORDER BY line_no FOR UPDATE', [forecastId]);
  for (const item of items) {
    const [[metrics]] = await conn.query(
      "SELECT COALESCE(SUM(si.quantity),0) ordered_quantity, COALESCE(SUM(si.quantity*si.unit_price),0) ordered_amount " +
      "FROM sales_document_items si JOIN sales_documents sd ON sd.id=si.document_id " +
      "WHERE si.forecast_item_id=? AND sd.tenant_id=? AND sd.company_id=? AND sd.source_system=? AND sd.source_database=? " +
      "AND sd.document_kind='sales_order' AND sd.status NOT IN ('draft','voided')",
      [item.id, context.tenant_id, context.company_id, context.source_system, context.source_database]
    );
    const orderedQuantity = Number(metrics.ordered_quantity || 0);
    const orderedAmount = Number(metrics.ordered_amount || 0);
    const autoClosed = (header.close_mode === 'auto' || item.close_mode === 'auto')
      && orderedQuantity + EPS >= Number(item.forecast_quantity || 0);
    const status = header.status === 'closed' || autoClosed ? 'closed' : 'open';
    await conn.query(
      'UPDATE erp_sales_forecast_items SET ordered_quantity=?,ordered_amount=?,status=? WHERE id=? AND forecast_id=?',
      [orderedQuantity, orderedAmount, status, item.id, forecastId]
    );
    item.ordered_quantity = orderedQuantity;
    item.ordered_amount = orderedAmount;
    item.status = status;
  }
  if (header.status === 'approved' && items.length && items.every(item => item.status === 'closed')) {
    await conn.query(
      "UPDATE erp_sales_forecasts SET status='closed',closed_by=COALESCE(closed_by,approved_by),closed_at=COALESCE(closed_at,NOW()) WHERE id=?",
      [forecastId]
    );
    header.status = 'closed';
  }
  return forecastSnapshot(header, items);
}

export async function resolveSalesForecastOrderLink(conn, context, input = {}) {
  const forecastItemId = Number(input.forecast_item_id || 0) || null;
  const forecastNo = text(input.forecast_no, 60);
  if (!forecastItemId && !forecastNo) return null;
  const itemCode = text(input.item_code, 40);
  const documentDate = dateText(input.document_date || input.order_date, '訂單日期');
  const customerCode = text(input.customer_code, 30);
  const requestedWarehouse = text(input.warehouse_code, 30);
  const params = [...contextParams(context)];
  const where = contextWhere('f', context);
  where.push("f.status='approved'");
  if (forecastItemId) {
    where.push('fi.id=?');
    params.push(forecastItemId);
  }
  if (forecastNo) {
    where.push('f.forecast_no=?');
    params.push(forecastNo);
  }
  const [[row]] = await conn.query(
    'SELECT f.*,fi.* ,fi.id forecast_item_id, f.id forecast_id FROM erp_sales_forecasts f ' +
    'JOIN erp_sales_forecast_items fi ON fi.forecast_id=f.id WHERE ' + where.join(' AND ') +
    ' LIMIT 1 FOR UPDATE',
    params
  );
  if (!row) throw badRequest('指定的銷售預測不存在、未核准、已結案或不屬於目前公司');
  if (forecastNo && row.forecast_no !== forecastNo) throw badRequest('銷售預測單號與明細不一致');
  if (row.customer_code && row.customer_code !== customerCode) throw badRequest('銷售預測客戶與訂單客戶不一致');
  if (row.forecast_basis === 'item' && row.item_code !== itemCode) throw badRequest('訂單品號與依品號銷售預測不一致');
  if (row.forecast_basis === 'category') {
    const [[item]] = await conn.query(
      'SELECT category_1,category_2,category_3,category_4 FROM erp_items WHERE ' +
      contextWhere('', context).join(' AND ') + ' AND item_code=? LIMIT 1',
      [...contextParams(context), itemCode]
    );
    if (!item) throw badRequest('找不到訂單品號，無法比對依類別銷售預測');
    for (let categoryType = 1; categoryType <= 4; categoryType += 1) {
      if (String(row['category_' + categoryType] || '') !== String(item['category_' + categoryType] || '')) {
        throw badRequest('訂單品號分類與銷售預測分類不一致');
      }
    }
  }
  const forecastWarehouse = text(row.warehouse_code, 30);
  if (forecastWarehouse && requestedWarehouse && forecastWarehouse !== requestedWarehouse) {
    throw badRequest('訂單庫別與銷售預測庫別不一致');
  }
  const orderQuantity = number(input.quantity, '訂單數量', { required: true, min: 0 });
  const [[metrics]] = await conn.query(
    "SELECT COALESCE(SUM(si.quantity),0) ordered_quantity FROM sales_document_items si " +
    "JOIN sales_documents sd ON sd.id=si.document_id " +
    "WHERE si.forecast_item_id=? AND sd.tenant_id=? AND sd.company_id=? AND sd.source_system=? AND sd.source_database=? " +
    "AND sd.document_kind='sales_order' AND sd.status NOT IN ('draft','voided') AND (? IS NULL OR sd.id<>?)",
    [row.forecast_item_id, context.tenant_id, context.company_id, context.source_system, context.source_database,
      input.document_id || null, input.document_id || null]
  );
  const remaining = Math.max(Number(row.forecast_quantity || 0) - Number(metrics.ordered_quantity || 0), 0);
  if (orderQuantity > remaining + EPS) throw badRequest('訂單數量超過銷售預測剩餘量 ' + remaining);
  return {
    forecast_id: row.forecast_id,
    forecast_item_id: row.forecast_item_id,
    forecast_no: row.forecast_no,
    warehouse_code: forecastWarehouse || requestedWarehouse || null,
    forecast_basis: row.forecast_basis,
    remaining_quantity: remaining
  };
}

async function forecastList(conn, context, query = {}) {
  const where = contextWhere('f', context);
  const params = contextParams(context);
  const status = text(query.status, 20);
  if (status && status !== 'all') {
    where.push('f.status=?');
    params.push(status);
  }
  const basis = text(query.forecast_basis, 12);
  if (['item', 'category'].includes(basis)) {
    where.push('f.forecast_basis=?');
    params.push(basis);
  }
  const keyword = text(query.keyword, 60);
  if (keyword) {
    where.push('(f.forecast_no LIKE ? OR f.customer_code LIKE ? OR fi.item_code LIKE ? OR fi.category_1 LIKE ? OR fi.category_2 LIKE ? OR fi.category_3 LIKE ? OR fi.category_4 LIKE ?)');
    params.push('%' + keyword + '%', '%' + keyword + '%', '%' + keyword + '%', '%' + keyword + '%', '%' + keyword + '%', '%' + keyword + '%', '%' + keyword + '%');
  }
  const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 500);
  const [rows] = await conn.query(
    'SELECT f.*,COUNT(fi.id) line_count,COALESCE(SUM(fi.forecast_quantity),0) forecast_quantity,' +
    'COALESCE(SUM(fi.ordered_quantity),0) ordered_quantity,COALESCE(SUM(fi.forecast_amount),0) forecast_amount,' +
    'COALESCE(SUM(fi.ordered_amount),0) ordered_amount ' +
    'FROM erp_sales_forecasts f LEFT JOIN erp_sales_forecast_items fi ON fi.forecast_id=f.id ' +
    'WHERE ' + where.join(' AND ') + ' GROUP BY f.id ORDER BY f.period_from DESC,f.id DESC LIMIT ' + limit,
    params
  );
  return rows.map(row => ({
    ...row,
    remaining_quantity: Math.max(Number(row.forecast_quantity || 0) - Number(row.ordered_quantity || 0), 0),
    remaining_amount: Math.max(Number(row.forecast_amount || 0) - Number(row.ordered_amount || 0), 0)
  }));
}

function reportWhere(context, query) {
  const where = contextWhere('f', context);
  const params = contextParams(context);
  const from = dateText(query.date_from, '起日', false);
  const to = dateText(query.date_to, '迄日', false);
  if (from) {
    where.push('f.period_to>=?');
    params.push(from);
  }
  if (to) {
    where.push('f.period_from<=?');
    params.push(to);
  }
  const status = text(query.status, 20);
  if (status && status !== 'all') {
    where.push('f.status=?');
    params.push(status);
  }
  const basis = text(query.forecast_basis, 12);
  if (['item', 'category'].includes(basis)) {
    where.push('f.forecast_basis=?');
    params.push(basis);
  }
  for (const field of ['forecast_no', 'customer_code', 'channel_code', 'customer_type']) {
    const value = text(query[field], 60);
    if (value) {
      where.push('f.' + field + '=?');
      params.push(value);
    }
  }
  const itemCode = text(query.item_code, 40);
  if (itemCode) {
    where.push('fi.item_code=?');
    params.push(itemCode);
  }
  for (let categoryType = 1; categoryType <= 4; categoryType += 1) {
    const value = text(query['category_' + categoryType], 30);
    if (value) {
      where.push('fi.category_' + categoryType + '=?');
      params.push(value);
    }
  }
  const closure = text(query.closure, 20);
  if (closure === 'open') where.push("fi.status='open'");
  if (closure === 'closed') where.push("fi.status='closed'");
  return { where, params };
}

export function registerSalesForecastRoutes(app) {
  app.get('/api/sales-workflow/forecasts/source', async (req, res, next) => {
    try {
      const { sourceName } = requestContext(req);
      res.json({ ok: true, data: await loadSourceForecast(sourceName) });
    } catch (error) { next(error); }
  });

  app.get('/api/sales-workflow/forecasts/report', async (req, res, next) => {
    try {
      await ensureTargetSalesForecastSchema();
      const { context } = requestContext(req);
      const { where, params } = reportWhere(context, req.query);
      const limit = Math.min(Math.max(Number(req.query.limit) || 300, 1), 1000);
      const [rows] = await pool.query(
        'SELECT f.forecast_no,f.forecast_version,f.forecast_basis,f.period_from,f.period_to,f.customer_code,' +
        'f.department_code,f.salesperson_code,f.channel_code,f.customer_type,f.status forecast_status,f.close_mode,' +
        'fi.id forecast_item_id,fi.line_no,fi.item_code,fi.item_name,fi.specification,fi.category_1,fi.category_2,' +
        'fi.category_3,fi.category_4,fi.forecast_date,fi.warehouse_code,fi.forecast_quantity,fi.ordered_quantity,' +
        'GREATEST(fi.forecast_quantity-fi.ordered_quantity,0) remaining_quantity,fi.unit,fi.currency_code,fi.unit_price,' +
        'fi.forecast_amount,fi.ordered_amount,GREATEST(fi.forecast_amount-fi.ordered_amount,0) remaining_amount,fi.status,' +
        'fi.note FROM erp_sales_forecasts f JOIN erp_sales_forecast_items fi ON fi.forecast_id=f.id WHERE ' +
        where.join(' AND ') + ' ORDER BY f.period_from DESC,f.forecast_no,fi.line_no LIMIT ' + limit,
        params
      );
      res.json({ ok: true, data: { rows, reconciliation: '本報表只核對預測版本／期間／明細與明確連結的訂單受訂量；接單統計／跟催仍維持獨立查詢。' } });
    } catch (error) { next(error); }
  });

  app.get('/api/sales-workflow/forecasts', async (req, res, next) => {
    try {
      await ensureTargetSalesForecastSchema();
      const { context } = requestContext(req);
      res.json({ ok: true, data: await forecastList(pool, context, req.query) });
    } catch (error) { next(error); }
  });

  app.get('/api/sales-workflow/forecasts/:id/events', async (req, res, next) => {
    try {
      await ensureTargetSalesForecastSchema();
      const { context } = requestContext(req);
      const id = Number(req.params.id);
      const [rows] = await pool.query(
        'SELECT * FROM erp_sales_forecast_events WHERE forecast_id=? AND ' +
        contextWhere('', context).join(' AND ') + ' ORDER BY id DESC',
        [id, ...contextParams(context)]
      );
      res.json({ ok: true, data: rows });
    } catch (error) { next(error); }
  });

  app.get('/api/sales-workflow/forecasts/:id', async (req, res, next) => {
    try {
      await ensureTargetSalesForecastSchema();
      const { context } = requestContext(req);
      const result = await targetForecast(pool, context, Number(req.params.id));
      res.json({ ok: true, data: { ...result, summary: forecastSnapshot(result.header, result.items) } });
    } catch (error) { next(error); }
  });

  app.post('/api/sales-workflow/forecasts', async (req, res, next) => {
    try {
      await ensureTargetSalesForecastSchema();
      const { context, source } = requestContext(req);
      const body = req.body || {};
      const result = await tx(async conn => {
        const input = await normalizeForecastInput(conn, context, body);
        const forecastNo = input.forecast_no || await nextForecastNumber(conn, context, input.period_from);
        const [insert] = await conn.query(
          'INSERT INTO erp_sales_forecasts(' +
          'tenant_id,company_id,source_system,source_database,forecast_no,forecast_version,forecast_basis,period_from,period_to,' +
          'customer_code,department_code,salesperson_code,channel_code,customer_type,include_production_plan,customer_description,' +
          'status,close_mode,source_kind,source_table,source_key,note,created_by,updated_by) ' +
          "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'draft',?,?,?,?,?,?,?)",
          [
            context.tenant_id, context.company_id, context.source_system, context.source_database, forecastNo,
            input.forecast_version, input.forecast_basis, input.period_from, input.period_to, input.customer_code,
            input.department_code, input.salesperson_code, input.channel_code, input.customer_type,
            input.include_production_plan, input.customer_description, input.close_mode, input.source_kind,
            input.source_table, input.source_key, input.note, req.auth?.id || null, req.auth?.id || null
          ]
        );
        await insertForecastLines(conn, insert.insertId, input.lines);
        const current = await targetForecast(conn, context, insert.insertId);
        await insertForecastEvent(conn, insert.insertId, context, 'created', null, forecastSnapshot(current.header, current.items), '建立銷售預測草稿', req.auth?.id);
        return { ...current, summary: forecastSnapshot(current.header, current.items), source_target_database: source.target_database };
      });
      res.status(201).json({ ok: true, data: result });
    } catch (error) { next(error); }
  });

  app.put('/api/sales-workflow/forecasts/:id', async (req, res, next) => {
    try {
      await ensureTargetSalesForecastSchema();
      const { context } = requestContext(req);
      const id = Number(req.params.id);
      const result = await tx(async conn => {
        const before = await targetForecast(conn, context, id, true);
        if (before.header.status !== 'draft') throw badRequest('只有草稿可以修改；核准後請用受控結案／重開流程');
        const input = await normalizeForecastInput(conn, context, req.body || {}, before.header);
        await conn.query(
          'UPDATE erp_sales_forecasts SET forecast_version=?,forecast_basis=?,period_from=?,period_to=?,customer_code=?,' +
          'department_code=?,salesperson_code=?,channel_code=?,customer_type=?,include_production_plan=?,customer_description=?,' +
          'close_mode=?,source_key=?,note=?,updated_by=? WHERE id=? AND ' + contextWhere('', context).join(' AND '),
          [
            input.forecast_version, input.forecast_basis, input.period_from, input.period_to, input.customer_code,
            input.department_code, input.salesperson_code, input.channel_code, input.customer_type,
            input.include_production_plan, input.customer_description, input.close_mode, input.source_key, input.note,
            req.auth?.id || null, id, ...contextParams(context)
          ]
        );
        await conn.query('DELETE FROM erp_sales_forecast_items WHERE forecast_id=?', [id]);
        await insertForecastLines(conn, id, input.lines);
        const after = await targetForecast(conn, context, id);
        await insertForecastEvent(conn, id, context, 'updated', forecastSnapshot(before.header, before.items), forecastSnapshot(after.header, after.items), text(req.body?.reason, 500) || '修改銷售預測草稿', req.auth?.id);
        return { ...after, summary: forecastSnapshot(after.header, after.items) };
      });
      res.json({ ok: true, data: result });
    } catch (error) { next(error); }
  });

  app.post('/api/sales-workflow/forecasts/:id/approve', async (req, res, next) => {
    try {
      await ensureTargetSalesForecastSchema();
      const { context } = requestContext(req);
      const id = Number(req.params.id);
      const result = await tx(async conn => {
        const before = await targetForecast(conn, context, id, true);
        if (before.header.status !== 'draft') throw badRequest('只有草稿可以核准');
        await conn.query(
          "UPDATE erp_sales_forecasts SET status='approved',approved_by=?,approved_at=NOW(),updated_by=? WHERE id=? AND " +
          contextWhere('', context).join(' AND '),
          [req.auth?.id || null, req.auth?.id || null, id, ...contextParams(context)]
        );
        const after = await targetForecast(conn, context, id, true);
        await insertForecastEvent(conn, id, context, 'approved', forecastSnapshot(before.header, before.items), forecastSnapshot(after.header, after.items), text(req.body?.reason, 500) || '核准銷售預測', req.auth?.id);
        return { ...after, summary: await refreshSalesForecastMetrics(conn, context, id) };
      });
      res.json({ ok: true, data: result });
    } catch (error) { next(error); }
  });

  app.post('/api/sales-workflow/forecasts/:id/close', async (req, res, next) => {
    try {
      await ensureTargetSalesForecastSchema();
      const { context } = requestContext(req);
      const id = Number(req.params.id);
      const result = await tx(async conn => {
        const before = await targetForecast(conn, context, id, true);
        if (before.header.status !== 'approved') throw badRequest('只有已核准預測可以結案');
        await conn.query(
          "UPDATE erp_sales_forecasts SET status='closed',close_mode='manual',closed_by=?,closed_at=NOW(),updated_by=? WHERE id=? AND " +
          contextWhere('', context).join(' AND '),
          [req.auth?.id || null, req.auth?.id || null, id, ...contextParams(context)]
        );
        await conn.query("UPDATE erp_sales_forecast_items SET status='closed',close_mode='manual' WHERE forecast_id=?", [id]);
        const after = await targetForecast(conn, context, id);
        await insertForecastEvent(conn, id, context, 'closed', forecastSnapshot(before.header, before.items), forecastSnapshot(after.header, after.items), text(req.body?.reason, 500) || '手動結案銷售預測', req.auth?.id);
        return { ...after, summary: forecastSnapshot(after.header, after.items) };
      });
      res.json({ ok: true, data: result });
    } catch (error) { next(error); }
  });

  app.post('/api/sales-workflow/forecasts/:id/reopen', async (req, res, next) => {
    try {
      await ensureTargetSalesForecastSchema();
      const { context } = requestContext(req);
      const id = Number(req.params.id);
      const result = await tx(async conn => {
        const before = await targetForecast(conn, context, id, true);
        if (before.header.status !== 'closed') throw badRequest('只有已結案預測可以重開');
        await conn.query(
          "UPDATE erp_sales_forecasts SET status='approved',close_mode='manual',closed_by=NULL,closed_at=NULL,updated_by=? WHERE id=? AND " +
          contextWhere('', context).join(' AND '),
          [req.auth?.id || null, id, ...contextParams(context)]
        );
        await conn.query("UPDATE erp_sales_forecast_items SET status='open',close_mode='manual' WHERE forecast_id=?", [id]);
        const after = await targetForecast(conn, context, id);
        await insertForecastEvent(conn, id, context, 'reopened', forecastSnapshot(before.header, before.items), forecastSnapshot(after.header, after.items), text(req.body?.reason, 500) || '受控重開銷售預測', req.auth?.id);
        return { ...after, summary: forecastSnapshot(after.header, after.items) };
      });
      res.json({ ok: true, data: result });
    } catch (error) { next(error); }
  });
}
