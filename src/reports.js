import {
  getSourcePool,
  pool,
  runWithTargetDatabase,
  sourceDatabases,
} from './db.js';

const EPS = 0.000001;
const DEFAULT_FROM_DATE = '2000-01-01';

const REPORT_DEFINITIONS = [
  {
    key: 'supplier-arrivals',
    label: '廠商預計進料',
    description: '依廠商、採購單與預計交期列出尚未交貨數量。',
    columns: [
      ['supplier_code', '廠商代號'], ['supplier_name', '廠商名稱'],
      ['purchase_order_no', '採購單號'], ['order_date', '採購日期'],
      ['expected_date', '預計進料日'], ['item_code', '品號'],
      ['item_name', '品名'], ['warehouse_code', '庫別'],
      ['qty_ordered', '採購量'], ['qty_received', '已交量'],
      ['qty_cancelled', '取消量'], ['remaining_quantity', '待進料量'],
      ['remaining_amount', '待進料金額'], ['currency_code', '幣別'],
      ['purchase_status', '採購狀態'], ['overdue', '逾期'],
      ['closed_with_remaining', '結案仍有未交'],
    ],
  },
  {
    key: 'item-arrivals',
    label: '品號／庫別預計進料',
    description: '依品號與庫別彙總各採購單尚未交貨量，並附目前庫存。',
    columns: [
      ['item_code', '品號'], ['item_name', '品名'], ['warehouse_code', '庫別'],
      ['next_expected_date', '最近預計進料日'], ['pending_quantity', '待進料量'],
      ['pending_amount', '待進料金額'], ['current_quantity', '目前庫存量'],
      ['current_amount', '目前庫存金額'], ['purchase_order_count', '採購單數'],
      ['supplier_count', '廠商數'], ['overdue_quantity', '逾期待進料量'],
    ],
  },
  {
    key: 'work-order-arrivals',
    label: '製令預計進料',
    description: '製令／生產入庫的預計進料；目前新 ERP 尚未完成製令表對照時會明確標示。',
    columns: [
      ['work_order_no', '製令單號'], ['expected_date', '預計入庫日'],
      ['item_code', '品號'], ['item_name', '品名'], ['warehouse_code', '庫別'],
      ['planned_quantity', '預計量'], ['received_quantity', '已入庫量'],
      ['remaining_quantity', '待入庫量'], ['remaining_amount', '待入庫金額'],
      ['status', '製令狀態'],
    ],
  },
  {
    key: 'open-documents',
    label: '未交／未結案',
    description: '同時列出請購、採購、報價與訂單的未轉、未交及已結案仍有剩餘異常。',
    columns: [
      ['flow', '流程'], ['document_kind', '單據種類'], ['document_no', '單號'],
      ['document_date', '日期'], ['partner_code', '對象'], ['item_code', '品號'],
      ['item_name', '品名'], ['warehouse_code', '庫別'],
      ['ordered_quantity', '原始量'], ['fulfilled_quantity', '已轉／已交量'],
      ['cancelled_quantity', '取消量'], ['remaining_quantity', '剩餘量'],
      ['remaining_amount', '剩餘金額'], ['currency_code', '幣別'],
      ['status', '狀態'], ['expected_date', '預計日'], ['overdue', '逾期'],
      ['unclosed', '尚未結案'], ['closed_with_remaining', '結案仍有剩餘'],
    ],
  },
  {
    key: 'aging',
    label: '應收／應付帳齡',
    description: '依截至日計算未結清帳款的到期天數與帳齡區間。',
    columns: [
      ['account_type', '類別'], ['party_code', '對象'], ['document_no', '帳款單號'],
      ['document_date', '立帳日'], ['due_date', '到期日'], ['currency_code', '幣別'],
      ['source_kind', '來源種類'], ['source_document_no', '來源單號'],
      ['original_amount', '原始金額'], ['settled_amount', '已沖金額'],
      ['balance_amount', '未結餘額'], ['status', '狀態'],
      ['overdue_days', '逾期天數'], ['aging_bucket', '帳齡區間'],
    ],
  },
  {
    key: 'cash-forecast',
    label: '資金預估',
    description: '以銀行帳戶帳面餘額、已過帳銀行異動及應收應付到期日計算各幣別預估餘額。',
    columns: [
      ['event_date', '預估日'], ['currency_code', '幣別'], ['flow_type', '流向'],
      ['source_type', '來源'], ['document_no', '單號／交易號'],
      ['party_code', '對象'], ['amount', '金額'], ['is_actual', '已過帳'],
      ['running_balance', '預估餘額'], ['memo', '備註'],
    ],
  },
  {
    key: 'note-status',
    label: '票據票況',
    description: '列出應收／應付票據狀態、到期日、逾期情形與未兌現金額。',
    columns: [
      ['account_type', '類別'], ['note_no', '票據號碼'], ['note_type', '票據種類'],
      ['issue_date', '票據日'], ['due_date', '到期日'], ['party_code', '對象'],
      ['bank_code', '銀行'], ['amount', '票面金額'], ['status', '票況'],
      ['is_unsettled', '未兌現／未付款'], ['overdue_days', '逾期天數'],
      ['status_date', '狀態日'], ['memo', '備註'],
    ],
  },
];

// 應收報表依文件逐項列名，但資料查詢集中在同一個報表中心。
// 這裡只使用既有目標 ERP 的 AR、結帳、來源與收款資料，不另外建立報表資料表。
const RECEIVABLE_REPORT_DEFINITIONS = [
  { key: 'statement', label: '應收帳款對帳單', description: '依客戶、日期與來源逐筆核對應收立帳、結帳及收款。' },
  { key: 'customer_detail', label: '客戶帳款明細表', description: '依客戶列出原始、已沖、剩餘與來源鍵。' },
  { key: 'customer_aging', label: '客戶帳齡分析表', description: '依截至日列出客戶未收餘額與帳齡區間。' },
  { key: 'salesperson_detail', label: '業務員帳款明細表', description: '依銷貨來源業務員追蹤應收與收款。' },
  { key: 'salesperson_aging', label: '業務員帳齡分析表', description: '依銷貨來源業務員及截至日分析未收帳齡。' },
  { key: 'salesperson_collection', label: '業務員收款明細表', description: '依業務員列出已沖收款及收款來源。' },
  { key: 'ledger', label: '應收帳款分戶帳', description: '以應收立帳為分戶，保留來源、發票、收款與餘額。' },
  { key: 'invoice_difference', label: '銷貨發票差異明細表', description: '比對銷貨／退貨來源與結帳發票是否完成對應。' },
  { key: 'overdue', label: '逾期應收帳款明細表', description: '列出截至日已逾期且仍有餘額的應收。' },
  { key: 'statement_total', label: '應收帳款對帳單總表', description: '依客戶及幣別彙總應收、已沖與剩餘金額。' },
  { key: 'open', label: '未結案應收明細表', description: '列出尚未結清的應收與下一段收款狀態。' },
  { key: 'party_relation', label: '客戶廠商關係明細表', description: '列出同公司、同來源的客戶兼廠商關係。' },
  { key: 'e_invoice', label: '電子發票憑證列印', description: '依結帳憑單的發票資料提供憑證列印來源。' },
];

const RECEIVABLE_REPORT_COLUMNS = [
  ['report_name', '報表'], ['document_no', '應收／結帳單號'], ['document_date', '日期'],
  ['party_code', '客戶代號'], ['party_name', '客戶名稱'], ['salesperson_code', '業務員代號'],
  ['salesperson_name', '業務員名稱'], ['supplier_code', '廠商代號'], ['supplier_name', '廠商名稱'],
  ['relationship_type', '關係'], ['source_kind', '來源種類'], ['source_document_type', '來源單別'],
  ['source_document_no', '來源單號'], ['source_key', '來源鍵'], ['customer_source_key', '客戶主檔來源鍵'],
  ['invoice_no', '發票號碼'], ['invoice_date', '發票日期'], ['invoice_status', '發票狀態'],
  ['invoice_difference_reason', '發票差異／說明'], ['is_invoice_issue', '發票異常'], ['currency_code', '幣別'], ['exchange_rate', '匯率'],
  ['source_quantity', '來源數量'], ['source_count', '來源筆數'], ['original_amount', '原始金額'],
  ['adjustment_amount', '調整金額'], ['settled_amount', '已沖金額'], ['balance_amount', '剩餘金額'],
  ['base_original_amount', '本位原始金額'], ['base_settled_amount', '本位已沖金額'],
  ['base_balance_amount', '本位剩餘金額'], ['due_date', '到期日'], ['overdue_days', '逾期天數'],
  ['aging_bucket', '帳齡區間'], ['status', '帳款狀態'], ['settlement_nos', '收款／沖銷單號'],
  ['settlement_dates', '收款日期'], ['settlement_statuses', '收款狀態'], ['item_codes', '品號'],
  ['source_customer_codes', '來源客戶'], ['is_invoiced', '已開票'], ['is_settled', '已結清'], ['note', '備註'],
];

export const REPORT_KEYS = REPORT_DEFINITIONS.map(row => row.key);

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function todayTaipei() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date()).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dateInput(value, fallback) {
  const text = String(value || fallback || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    if (value) throw badRequest(`日期格式錯誤：${value}`);
    return fallback;
  }
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) throw badRequest(`日期不存在：${text}`);
  return text;
}

function dateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(value).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  return String(value).slice(0, 10);
}

function reportRange(query = {}) {
  const to = dateInput(query.to_date, todayTaipei());
  const from = dateInput(query.from_date, DEFAULT_FROM_DATE);
  const asOf = dateInput(query.as_of_date, to);
  if (from > to) throw badRequest('日期起日不可晚於迄日');
  return { from, to, asOf };
}

function reportLimit(query = {}, fallback = 5000) {
  return Math.min(Math.max(Number(query.limit || fallback), 1), 20000);
}

function contextFor(sourceName) {
  const db = String(sourceName || 'SH').trim().toUpperCase();
  const source = sourceDatabases[db];
  if (!source) throw badRequest(`找不到資料來源：${db}`);
  return {
    sourceDatabase: db,
    tenant_id: source.tenant_id || db,
    company_id: source.company_id || db,
    source_system: source.source_system || source.adapter_code || 'iSM',
    target_database: source.target_database || 'inventory_erp',
  };
}

function scope(alias, context) {
  return {
    sql: `${alias}.tenant_id=? AND ${alias}.company_id=? AND ${alias}.source_system=? AND ${alias}.source_database=?`,
    params: [context.tenant_id, context.company_id, context.source_system, context.sourceDatabase],
  };
}

function inventoryScope(alias, context) {
  return {
    sql: `${alias}.tenant_id=? AND ${alias}.company_id=? AND ${alias}.source_system=?`,
    params: [context.tenant_id, context.company_id, context.source_system],
  };
}

function q(value) {
  return `\`${String(value).replaceAll('`', '``')}\``;
}

async function tableExists(tableName) {
  const [[row]] = await pool.query(
    "SELECT COUNT(*) count FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND TABLE_TYPE='BASE TABLE'",
    [tableName]
  );
  return Number(row?.count || 0) > 0;
}

async function tableColumns(tableName) {
  const [rows] = await pool.query(
    'SELECT COLUMN_NAME column_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',
    [tableName]
  );
  return new Set(rows.map(row => String(row.column_name)));
}

function decorate(rows, context, dateFields = []) {
  return rows.map(row => {
    const next = {
      ...row,
      tenant_id: context.tenant_id,
      company_id: context.company_id,
      source_system: context.source_system,
      source_database: context.sourceDatabase,
    };
    for (const field of dateFields) if (next[field]) next[field] = dateOnly(next[field]);
    return next;
  });
}

function definitionFor(key) {
  const definition = REPORT_DEFINITIONS.find(row => row.key === key);
  if (!definition) throw badRequest(`不支援的報表：${key}`);
  return definition;
}

function columnsFor(definition) {
  return definition.columns.map(([key, label]) => ({ key, label }));
}

function finish(definition, context, range, rows, summary = {}, options = {}) {
  return {
    report: definition.key,
    label: definition.label,
    description: definition.description,
    available: options.available !== false,
    status: options.status || 'available',
    source_database: context.sourceDatabase,
    company: {
      tenant_id: context.tenant_id,
      company_id: context.company_id,
      source_system: context.source_system,
      target_database: context.target_database,
    },
    range: { from_date: range.from, to_date: range.to, as_of_date: range.asOf },
    columns: columnsFor(definition),
    rows: decorate(rows, context, options.dateFields || []),
    summary: { row_count: rows.length, ...summary },
    warnings: options.warnings || [],
    meta: options.meta || {},
  };
}

function number(value) {
  const result = Number(value || 0);
  return Number.isFinite(result) ? result : 0;
}

function sum(rows, field) {
  return rows.reduce((total, row) => total + number(row[field]), 0);
}

function groupTotals(rows, keyField, amountField) {
  const groups = new Map();
  for (const row of rows) {
    const key = String(row[keyField] || '—');
    const current = groups.get(key) || { key, count: 0, amount: 0, quantity: 0 };
    current.count += 1;
    current.amount += number(row[amountField]);
    current.quantity += number(row.remaining_quantity ?? row.pending_quantity ?? row.balance_amount);
    groups.set(key, current);
  }
  return [...groups.values()];
}

function uniqueTexts(...values) {
  return [...new Set(values.flatMap(value => String(value ?? '').split(/[、,，]/).map(item => item.trim()).filter(Boolean)))];
}

function receivableDefinitionFor(key) {
  if (key === 'all') return {
    key: 'all', label: '全部應收明細（集中報表中心）', description: '集中列出目前公司所有有效應收來源。', columns: RECEIVABLE_REPORT_COLUMNS,
  };
  const definition = RECEIVABLE_REPORT_DEFINITIONS.find(row => row.key === key);
  if (!definition) throw badRequest(`不支援的應收報表：${key}`);
  return { ...definition, columns: RECEIVABLE_REPORT_COLUMNS };
}

function canonicalSourceKey(sourceDatabase, kind, id, documentNo) {
  const reference = Number(id || 0) > 0 ? String(id) : String(documentNo || '').trim();
  return reference ? `${sourceDatabase}:${String(kind || 'source').trim()}:${reference}` : null;
}

function receivableOverdueDays(dueDate, asOf) {
  const due = dateOnly(dueDate);
  if (!due || due >= asOf) return 0;
  const days = Math.floor((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86400000);
  return Math.max(days, 0);
}

function receivableAgingBucket(days, dueDate, asOf) {
  const due = dateOnly(dueDate);
  if (!due) return '未設定到期日';
  if (due >= asOf) return '未到期';
  if (days <= 30) return '逾期 1-30 天';
  if (days <= 60) return '逾期 31-60 天';
  if (days <= 90) return '逾期 61-90 天';
  return '逾期 91 天以上';
}

function mapById(rows) {
  return new Map(rows.map(row => [Number(row.id), row]));
}

function mapListBy(rows, field) {
  const result = new Map();
  for (const row of rows) {
    const key = String(row[field] ?? '');
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(row);
  }
  return result;
}

function aggregateReceivableRows(rows, definition) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.party_code || '—'}|${row.currency_code || 'TWD'}`;
    const current = groups.get(key) || {
      ...row, report_name: definition.label, document_no: '多筆彙總', document_date: null,
      source_document_no: '', source_key: '', customer_source_key: row.customer_source_key || '',
      invoice_no: '', invoice_date: null, invoice_status: '', invoice_difference_reason: '',
      is_invoice_issue: 0, is_invoiced: 0, source_quantity: 0, source_count: 0, original_amount: 0,
      adjustment_amount: 0, settled_amount: 0, balance_amount: 0, base_original_amount: 0,
      base_settled_amount: 0, base_balance_amount: 0, settlement_nos: '', settlement_dates: '',
      settlement_statuses: '', item_codes: '', source_customer_codes: '', status: '', due_date: null,
      overdue_days: 0, aging_bucket: '—', salesperson_code: '', salesperson_name: '',
      source_kind: '', source_document_type: '', is_settled: 0, note: '', document_count: 0,
    };
    current.document_count += 1;
    current.source_quantity += number(row.source_quantity);
    current.source_count += number(row.source_count);
    for (const field of ['original_amount', 'adjustment_amount', 'settled_amount', 'balance_amount', 'base_original_amount', 'base_settled_amount', 'base_balance_amount']) current[field] += number(row[field]);
    for (const field of ['source_document_no', 'source_key', 'invoice_no', 'invoice_status', 'settlement_nos', 'settlement_dates', 'settlement_statuses', 'item_codes', 'source_customer_codes', 'status', 'salesperson_code', 'salesperson_name', 'source_kind', 'source_document_type', 'invoice_difference_reason', 'note']) current[field] = uniqueTexts(current[field], row[field]).join('、');
    current.is_invoice_issue = current.is_invoice_issue || Number(row.is_invoice_issue || 0);
    current.is_invoiced = current.is_invoiced || Number(row.is_invoiced || 0);
    current.is_settled = current.balance_amount <= EPS ? 1 : 0;
    groups.set(key, current);
  }
  return [...groups.values()];
}

async function reportReceivablePartyRelations(context, range, limit, definition) {
  if (!await tableExists('finance_party_links')) return finish(definition, context, range, [], {}, {
    available: false, status: 'needs_schema', warnings: ['目前目標 ERP 尚未建立客戶兼廠商關係表。'],
  });
  const hasCustomers = await tableExists('erp_customers');
  const hasSuppliers = await tableExists('erp_suppliers');
  const customerSelect = hasCustomers ? 'COALESCE(NULLIF(c.customer_name,\'\'),pl.customer_code)' : 'pl.customer_code';
  const supplierSelect = hasSuppliers ? 'COALESCE(NULLIF(s.supplier_name,\'\'),pl.supplier_code)' : 'pl.supplier_code';
  const customerJoin = hasCustomers ? `LEFT JOIN erp_customers c ON c.customer_code=pl.customer_code AND c.tenant_id=pl.tenant_id AND c.company_id=pl.company_id AND c.source_system=pl.source_system AND c.source_database=pl.source_database` : '';
  const supplierJoin = hasSuppliers ? `LEFT JOIN erp_suppliers s ON s.supplier_code=pl.supplier_code AND s.tenant_id=pl.tenant_id AND s.company_id=pl.company_id AND s.source_system=pl.source_system AND s.source_database=pl.source_database` : '';
  const pScope = scope('pl', context);
  const [rows] = await pool.query(`
    SELECT pl.id,pl.customer_code,${customerSelect} customer_name,pl.supplier_code,${supplierSelect} supplier_name,
      pl.relationship_type,pl.is_active,pl.note,pl.created_at
    FROM finance_party_links pl ${customerJoin} ${supplierJoin}
    WHERE ${pScope.sql} ORDER BY pl.customer_code,pl.supplier_code LIMIT ?`, [...pScope.params, limit]);
  const mapped = rows.map(row => ({
    report_name: definition.label, document_no: `關係-${row.id}`, document_date: row.created_at,
    party_code: row.customer_code, party_name: row.customer_name, supplier_code: row.supplier_code,
    supplier_name: row.supplier_name, relationship_type: row.relationship_type,
    source_kind: 'finance_party_link', source_document_type: 'customer_supplier',
    source_document_no: `關係-${row.id}`, source_key: canonicalSourceKey(context.sourceDatabase, 'finance_party_link', row.id),
    status: Number(row.is_active) ? 'active' : 'inactive', is_settled: 0, is_invoice_issue: 0,
    note: row.note || '', source_count: 1, source_quantity: 0, original_amount: 0,
    adjustment_amount: 0, settled_amount: 0, balance_amount: 0, base_original_amount: 0,
    base_settled_amount: 0, base_balance_amount: 0,
  }));
  return finish(definition, context, range, mapped, {
    relation_count: mapped.length, active_relation_count: mapped.filter(row => row.status === 'active').length,
  }, { dateFields: ['document_date'], meta: { report_scope: '目前公司有效客戶兼廠商關係；本報表不以交易日期過濾' } });
}

async function reportReceivableCenter(context, range, limit, query = {}) {
  const reportKind = String(query.report_kind || 'statement').trim().toLowerCase();
  const definition = receivableDefinitionFor(reportKind);
  if (reportKind === 'party_relation') {
    const result = await reportReceivablePartyRelations(context, range, limit, definition);
    return {
      ...result,
      report: 'receivable-center',
      requested_report: reportKind,
      requested_report_label: definition.label,
      filters: { source_database: context.sourceDatabase, from_date: range.from, to_date: range.to, as_of_date: range.asOf },
      meta: {
        ...(result.meta || {}),
        central_report: true,
        report_kind: reportKind,
        report_names: RECEIVABLE_REPORT_DEFINITIONS.map(row => row.label),
        source_basis: 'finance_party_links＋erp_customers／erp_suppliers',
        dimensions: ['公司別', '客戶', '廠商', '關係', '來源鍵'],
      },
    };
  }
  if (!await tableExists('finance_open_items')) {
    const result = finish(definition, context, range, [], {}, {
      available: false, status: 'needs_schema', warnings: ['目前目標 ERP 尚未建立應收／應付帳款表。'],
      meta: { central_report: true, report_kind: reportKind, report_names: RECEIVABLE_REPORT_DEFINITIONS.map(row => row.label) },
    });
    return { ...result, report: 'receivable-center', requested_report: reportKind, requested_report_label: definition.label,
      filters: { source_database: context.sourceDatabase, from_date: range.from, to_date: range.to, as_of_date: range.asOf } };
  }

  const oScope = scope('o', context);
  const conditions = [oScope.sql, `o.account_type='AR'`, `o.status<>'voided'`, 'o.document_date BETWEEN ? AND ?'];
  const params = [...oScope.params, range.from, range.to];
  const customerCode = String(query.customer_code || '').trim();
  const currencyCode = String(query.currency_code || '').trim().toUpperCase();
  if (customerCode) { conditions.push('o.party_code=?'); params.push(customerCode); }
  if (currencyCode) { conditions.push('o.currency_code=?'); params.push(currencyCode); }
  // 維度篩選會在來源補齊後再套用；掃描上限提高，避免業務員／來源鍵篩選只看到前幾筆。
  const scanLimit = Math.min(Math.max(limit * (query.salesperson_code || query.source_key || query.invoice_no ? 10 : 2), 2000), 50000);
  const [openRows] = await pool.query(`
    SELECT o.id,o.tenant_id,o.company_id,o.source_system,o.source_database,o.account_type,o.document_no,
      o.document_date,o.due_date,o.party_code,o.currency_code,o.source_kind,o.source_document_id,o.source_document_no,
      o.original_amount,o.settled_amount,o.balance_amount,o.status,o.note,o.adjustment_amount,o.exchange_rate,
      o.base_original_amount,o.base_settled_amount,o.base_balance_amount
    FROM finance_open_items o WHERE ${conditions.join(' AND ')}
    ORDER BY o.document_date DESC,o.id DESC LIMIT ?`, [...params, scanLimit]);
  if (!openRows.length) {
    const empty = finish(definition, context, range, [], { matched_row_count: 0 }, {
      meta: { central_report: true, report_kind: reportKind, report_names: RECEIVABLE_REPORT_DEFINITIONS.map(row => row.label) },
    });
    return { ...empty, report: 'receivable-center', requested_report: reportKind, requested_report_label: definition.label,
      filters: { source_database: context.sourceDatabase, from_date: range.from, to_date: range.to, as_of_date: range.asOf },
      warnings: ['目前條件查無應收資料。'] };
  }

  const hasVouchers = await tableExists('finance_vouchers');
  const hasVoucherSources = hasVouchers && await tableExists('finance_voucher_sources');
  const hasSalesDocuments = await tableExists('sales_documents');
  const hasCustomers = await tableExists('erp_customers');
  const hasEmployees = await tableExists('erp_employees');
  const hasSettlements = await tableExists('finance_settlements') && await tableExists('finance_allocations');
  const voucherIds = uniqueTexts(openRows.filter(row => row.source_kind === 'finance_voucher' && Number(row.source_document_id)).map(row => row.source_document_id)).map(Number).filter(Boolean);
  const directSalesIds = uniqueTexts(openRows.filter(row => ['shipment', 'sales_return', 'sales_order', 'quotation'].includes(row.source_kind) && Number(row.source_document_id)).map(row => row.source_document_id)).map(Number).filter(Boolean);
  const voucherMap = new Map();
  if (hasVouchers && voucherIds.length) {
    const vScope = scope('v', context);
    const [rows] = await pool.query(`SELECT v.id,v.account_type,v.document_type,v.voucher_no,v.voucher_date,v.due_date,v.party_code,
        v.currency_code,v.settlement_mode,v.invoice_no,v.invoice_date,v.status,v.note,v.closing_basis,v.source_code,
        v.invoice_type,v.tax_id,v.invoice_status,v.exchange_rate,v.total_amount,v.base_total_amount
      FROM finance_vouchers v WHERE ${vScope.sql} AND v.id IN (?)`, [...vScope.params, voucherIds]);
    for (const row of rows) voucherMap.set(Number(row.id), row);
  }
  let voucherSourceRows = [];
  if (hasVoucherSources && voucherIds.length) {
    const vScope = scope('v', context);
    const [rows] = await pool.query(`SELECT vs.* FROM finance_voucher_sources vs
      JOIN finance_vouchers v ON v.id=vs.voucher_id WHERE ${vScope.sql} AND v.id IN (?) ORDER BY vs.voucher_id,vs.id`, [...vScope.params, voucherIds]);
    voucherSourceRows = rows;
  }
  const salesIds = uniqueTexts([...directSalesIds, ...voucherSourceRows.filter(row => Number(row.source_document_id)).map(row => row.source_document_id)]).map(Number).filter(Boolean);
  const salesMap = new Map();
  if (hasSalesDocuments && salesIds.length) {
    const sdScope = scope('sd', context);
    const [rows] = await pool.query(`SELECT sd.id,sd.document_kind,sd.document_type,sd.document_no,sd.document_date,
        sd.customer_code,sd.salesperson_code,sd.currency_code,sd.status,sd.return_type
      FROM sales_documents sd WHERE ${sdScope.sql} AND sd.id IN (?)`, [...sdScope.params, salesIds]);
    for (const row of rows) salesMap.set(Number(row.id), row);
  }
  const partyCodes = uniqueTexts(openRows.map(row => row.party_code));
  const customerMap = new Map();
  if (hasCustomers && partyCodes.length) {
    const cScope = scope('c', context);
    const [rows] = await pool.query(`SELECT c.customer_code,c.customer_name,c.responsible_person,c.source_key
      FROM erp_customers c WHERE ${cScope.sql} AND c.customer_code IN (?)`, [...cScope.params, partyCodes]);
    for (const row of rows) customerMap.set(String(row.customer_code), row);
  }
  const sourceSalespersonCodes = uniqueTexts([...salesMap.values()].map(row => row.salesperson_code));
  const employeeMap = new Map();
  if (hasEmployees && sourceSalespersonCodes.length) {
    const eScope = scope('e', context);
    const [rows] = await pool.query(`SELECT e.employee_code,e.employee_name FROM erp_employees e
      WHERE ${eScope.sql} AND e.employee_code IN (?)`, [...eScope.params, sourceSalespersonCodes]);
    for (const row of rows) employeeMap.set(String(row.employee_code), row);
  }
  const settlementsByItem = new Map();
  if (hasSettlements) {
    const ids = openRows.map(row => Number(row.id)).filter(Boolean);
    const sScope = scope('s', context);
    const [rows] = await pool.query(`SELECT a.open_item_id,s.settlement_no,s.settlement_date,s.status,a.allocated_amount
      FROM finance_allocations a JOIN finance_settlements s ON s.id=a.settlement_id
      JOIN finance_open_items ao ON ao.id=a.open_item_id
      WHERE ao.id IN (?) AND ${scope('ao', context).sql} AND ${sScope.sql}
      ORDER BY s.settlement_date,s.id`, [ids, ...scope('ao', context).params, ...sScope.params]);
    for (const row of rows) {
      if (!settlementsByItem.has(Number(row.open_item_id))) settlementsByItem.set(Number(row.open_item_id), []);
      settlementsByItem.get(Number(row.open_item_id)).push(row);
    }
  }
  const sourceByVoucher = mapListBy(voucherSourceRows, 'voucher_id');
  const warningList = [];
  if (openRows.length >= scanLimit) warningList.push(`來源資料超過本次掃描上限 ${scanLimit} 筆，請縮小日期或客戶條件後再查詢。`);

  const mapped = openRows.map(row => {
    const voucher = voucherMap.get(Number(row.source_document_id));
    const refs = [{ kind: 'finance_open_item', id: row.id, no: row.document_no, date: row.document_date, type: 'finance_open_item' }];
    const sourceRows = [];
    if (row.source_kind === 'finance_voucher' && voucher) {
      refs.push({ kind: 'finance_voucher', id: voucher.id, no: voucher.voucher_no, date: voucher.voucher_date, type: voucher.document_type });
      sourceRows.push(...(sourceByVoucher.get(Number(voucher.id)) || []));
    } else if (Number(row.source_document_id)) {
      sourceRows.push({ source_kind: row.source_kind, source_document_id: row.source_document_id, source_document_no: row.source_document_no });
    }
    for (const source of sourceRows) {
      const sourceDoc = salesMap.get(Number(source.source_document_id));
      refs.push({
        kind: source.source_kind || row.source_kind, id: source.source_document_id,
        no: source.source_document_no || sourceDoc?.document_no, date: source.source_date || sourceDoc?.document_date,
        type: source.source_document_type || sourceDoc?.document_type || sourceDoc?.document_kind,
        salesperson_code: sourceDoc?.salesperson_code, customer_code: sourceDoc?.customer_code,
      });
    }
    if (!sourceRows.length && row.source_kind !== 'finance_voucher' && Number(row.source_document_id)) {
      const sourceDoc = salesMap.get(Number(row.source_document_id));
      if (sourceDoc) refs.push({ kind: sourceDoc.document_kind, id: sourceDoc.id, no: sourceDoc.document_no, date: sourceDoc.document_date, type: sourceDoc.document_type, salesperson_code: sourceDoc.salesperson_code, customer_code: sourceDoc.customer_code });
    }
    const actualRefs = refs.filter(ref => ref.kind !== 'finance_open_item');
    const sourceKinds = uniqueTexts(actualRefs.map(ref => ref.kind));
    const sourceTypes = uniqueTexts(actualRefs.map(ref => ref.type));
    const sourceNos = uniqueTexts(actualRefs.map(ref => ref.no));
    const sourceKeys = uniqueTexts(refs.map(ref => canonicalSourceKey(context.sourceDatabase, ref.kind, ref.id, ref.no)));
    const salespersonCodes = uniqueTexts(actualRefs.map(ref => ref.salesperson_code));
    const salespersonNames = uniqueTexts(salespersonCodes.map(code => employeeMap.get(code)?.employee_name || code));
    const sourceCustomerCodes = uniqueTexts(actualRefs.map(ref => ref.customer_code || row.party_code));
    const itemCodes = uniqueTexts(sourceRows.map(source => source.item_code));
    const sourceQuantity = sourceRows.reduce((total, source) => total + number(source.quantity), 0);
    const settlements = settlementsByItem.get(Number(row.id)) || [];
    const settlementNos = uniqueTexts(settlements.map(item => item.settlement_no));
    const settlementDates = uniqueTexts(settlements.map(item => dateOnly(item.settlement_date)));
    const settlementStatuses = uniqueTexts(settlements.map(item => item.status));
    const saleSource = sourceKinds.some(kind => ['shipment', 'sales_return'].includes(kind)) || ['shipment', 'sales_return'].includes(row.source_kind);
    const invoiceStatus = voucher ? String(voucher.invoice_status || (voucher.invoice_no ? 'issued' : 'none')) : (saleSource ? 'missing' : 'not_applicable');
    const invoiceNo = voucher?.invoice_no || '';
    const invoiceIssue = saleSource && (!voucher || !invoiceNo || !['issued', 'received'].includes(invoiceStatus));
    const invoiceDifferenceReason = saleSource
      ? (!voucher ? '銷貨／銷退來源未找到應收結帳憑單' : (!invoiceNo ? '應收已立帳但尚未登錄發票' : (!['issued', 'received'].includes(invoiceStatus) ? `發票狀態為 ${invoiceStatus}` : '已完成發票對應')))
      : (voucher ? (invoiceNo ? '非銷貨來源／已登錄發票' : '非銷貨來源／不適用') : '非銷貨來源');
    const days = receivableOverdueDays(row.due_date, range.asOf);
    const settlementBalance = number(row.balance_amount);
    return {
      report_name: definition.label, document_no: row.document_no, document_date: dateOnly(row.document_date),
      party_code: row.party_code, party_name: customerMap.get(String(row.party_code))?.customer_name || row.party_code,
      salesperson_code: salespersonCodes.join('、'), salesperson_name: salespersonNames.join('、'),
      source_kind: sourceKinds.join('、') || row.source_kind, source_document_type: sourceTypes.join('、') || voucher?.document_type || row.source_kind,
      source_document_no: sourceNos.join('、') || row.source_document_no || voucher?.voucher_no || '', source_key: sourceKeys.join('、'),
      customer_source_key: customerMap.get(String(row.party_code))?.source_key || '', invoice_no: invoiceNo,
      invoice_date: dateOnly(voucher?.invoice_date), invoice_status: invoiceStatus, invoice_difference_reason: invoiceDifferenceReason,
      is_invoice_issue: invoiceIssue ? 1 : 0, currency_code: row.currency_code || voucher?.currency_code || 'TWD', exchange_rate: number(row.exchange_rate || voucher?.exchange_rate || 1),
      source_quantity: sourceQuantity, source_count: actualRefs.length, item_codes: itemCodes.join('、'), source_customer_codes: sourceCustomerCodes.join('、'),
      original_amount: number(row.original_amount), adjustment_amount: number(row.adjustment_amount), settled_amount: number(row.settled_amount), balance_amount: settlementBalance,
      base_original_amount: number(row.base_original_amount || row.original_amount), base_settled_amount: number(row.base_settled_amount || row.settled_amount), base_balance_amount: number(row.base_balance_amount || row.balance_amount),
      due_date: dateOnly(row.due_date), overdue_days: days, aging_bucket: receivableAgingBucket(days, row.due_date, range.asOf), status: row.status,
      settlement_nos: settlementNos.join('、'), settlement_dates: settlementDates.join('、'), settlement_statuses: settlementStatuses.join('、'),
      is_invoiced: invoiceNo ? 1 : 0, is_settled: settlementBalance <= EPS ? 1 : 0,
      note: row.note || voucher?.note || '',
    };
  });
  const unassignedSalespersonCount = mapped.filter(row => !row.salesperson_code).length;
  const invoiceIssueCount = mapped.filter(row => row.is_invoice_issue).length;
  if (unassignedSalespersonCount) warningList.push(`${unassignedSalespersonCount} 筆應收來源未帶業務員，維持空值並列為未指定，不以客戶或建立人員猜補。`);
  if (invoiceIssueCount) warningList.push(`${invoiceIssueCount} 筆銷貨／銷退來源的發票資料未完成對應，請由發票差異報表追查。`);

  const filterText = value => String(value || '').trim().toUpperCase();
  const salespersonFilter = filterText(query.salesperson_code);
  const invoiceFilter = filterText(query.invoice_no);
  const invoiceStatusFilter = filterText(query.invoice_status);
  const sourceKeyFilter = filterText(query.source_key);
  const documentTypeFilter = filterText(query.document_type);
  let rows = mapped.filter(row => {
    if (salespersonFilter && !uniqueTexts(row.salesperson_code).some(value => filterText(value) === salespersonFilter)) return false;
    if (invoiceFilter && !filterText(row.invoice_no).includes(invoiceFilter)) return false;
    if (invoiceStatusFilter && invoiceStatusFilter !== 'ALL' && filterText(row.invoice_status) !== invoiceStatusFilter) return false;
    if (sourceKeyFilter && !filterText(row.source_key).includes(sourceKeyFilter)) return false;
    if (documentTypeFilter && documentTypeFilter !== 'ALL' && !uniqueTexts(row.source_document_type).some(value => filterText(value) === documentTypeFilter)) return false;
    if (['customer_aging', 'salesperson_aging', 'overdue', 'open'].includes(reportKind) && (row.balance_amount <= EPS || row.status === 'settled')) return false;
    if (reportKind === 'salesperson_collection' && row.settled_amount <= EPS && !row.settlement_nos) return false;
    if (reportKind === 'invoice_difference' && !row.is_invoice_issue) return false;
    if (reportKind === 'e_invoice' && !row.invoice_no && !['issued', 'received', 'voided'].includes(row.invoice_status)) return false;
    return true;
  });
  if (reportKind === 'overdue') rows = rows.filter(row => row.overdue_days > 0);
  const matchedRowCount = rows.length;
  const outputRows = reportKind === 'statement_total'
    ? aggregateReceivableRows(rows, definition).slice(0, limit)
    : rows.slice(0, limit);
  const bySalesperson = new Map();
  const byInvoiceStatus = new Map();
  for (const row of rows) {
    for (const code of (uniqueTexts(row.salesperson_code).length ? uniqueTexts(row.salesperson_code) : ['未指定業務員'])) {
      const current = bySalesperson.get(code) || { key: code, count: 0, original_amount: 0, settled_amount: 0, balance_amount: 0 };
      current.count += 1; current.original_amount += number(row.original_amount); current.settled_amount += number(row.settled_amount); current.balance_amount += number(row.balance_amount); bySalesperson.set(code, current);
    }
    const status = row.invoice_status || 'none';
    const invoiceGroup = byInvoiceStatus.get(status) || { key: status, count: 0, amount: 0 };
    invoiceGroup.count += 1; invoiceGroup.amount += number(row.balance_amount); byInvoiceStatus.set(status, invoiceGroup);
  }
  const result = finish(definition, context, range, outputRows, {
    matched_row_count: matchedRowCount, customer_count: new Set(rows.map(row => row.party_code).filter(Boolean)).size,
    salesperson_count: new Set(rows.flatMap(row => uniqueTexts(row.salesperson_code))).size,
    source_key_count: new Set(rows.flatMap(row => uniqueTexts(row.source_key))).size,
    original_amount: sum(rows, 'original_amount'), adjustment_amount: sum(rows, 'adjustment_amount'),
    settled_amount: sum(rows, 'settled_amount'), balance_amount: sum(rows, 'balance_amount'),
    base_balance_amount: sum(rows, 'base_balance_amount'), settled_count: rows.filter(row => row.is_settled).length,
    overdue_count: rows.filter(row => row.overdue_days > 0).length, overdue_balance: sum(rows.filter(row => row.overdue_days > 0), 'balance_amount'),
    invoice_issue_count: rows.filter(row => row.is_invoice_issue).length, uninvoiced_count: rows.filter(row => !row.invoice_no).length,
    salesperson_unassigned_count: rows.filter(row => !row.salesperson_code).length,
    by_salesperson: [...bySalesperson.values()], by_invoice_status: [...byInvoiceStatus.values()],
  }, { dateFields: ['document_date', 'invoice_date', 'due_date'], warnings: warningList, meta: {
    central_report: true, report_kind: reportKind, report_names: RECEIVABLE_REPORT_DEFINITIONS.map(row => row.label),
    source_basis: 'finance_open_items＋finance_vouchers／finance_voucher_sources＋sales_documents＋收款沖銷',
    dimensions: ['公司別', '日期起訖', '截至日', '客戶', '業務員', '發票號碼／狀態', '來源種類／單別／單號／來源鍵', '幣別'],
    source_read_only: true,
  } });
  return { ...result, report: 'receivable-center', requested_report: reportKind, requested_report_label: definition.label,
    filters: {
      source_database: context.sourceDatabase, from_date: range.from, to_date: range.to, as_of_date: range.asOf,
      customer_code: customerCode || null, salesperson_code: salespersonFilter || null, invoice_no: invoiceFilter || null,
      invoice_status: invoiceStatusFilter || null, source_key: sourceKeyFilter || null, document_type: documentTypeFilter || null,
      currency_code: currencyCode || null,
    } };
}

async function supplierJoin() {
  if (!await tableExists('erp_suppliers')) return {
    select: 'o.supplier_code supplier_code, o.supplier_code supplier_name',
    join: '',
  };
  return {
    select: "o.supplier_code supplier_code, COALESCE(NULLIF(s.supplier_name,''),NULLIF(s.short_name,''),o.supplier_code) supplier_name",
    join: `LEFT JOIN erp_suppliers s
      ON s.supplier_code=o.supplier_code AND s.source_database=o.source_database
      AND s.tenant_id=o.tenant_id AND s.company_id=o.company_id AND s.source_system=o.source_system`,
  };
}

async function loadOpenPurchaseLines(context, range, limit, includeExpectedOnly = true) {
  if (!await tableExists('procurement_orders') || !await tableExists('procurement_order_items')) return [];
  const supplier = await supplierJoin();
  const oScope = scope('o', context);
  const expectedExpression = 'COALESCE(i.expected_date,o.expected_date,o.order_date)';
  const remainingExpression = 'GREATEST(i.qty_ordered-COALESCE(i.qty_received,0)-COALESCE(i.qty_cancelled,0),0)';
  const conditions = [
    oScope.sql,
    "o.status NOT IN ('draft','cancelled')",
    `${remainingExpression}>?`,
    `${expectedExpression} BETWEEN ? AND ?`,
  ];
  const params = [...oScope.params, EPS, range.from, range.to, limit];
  if (!includeExpectedOnly) {
    conditions[3] = 'COALESCE(i.expected_date,o.expected_date,o.order_date) BETWEEN ? AND ?';
  }
  const [rows] = await pool.query(`
    SELECT ${supplier.select}, o.purchase_order_no, o.order_date,
      ${expectedExpression} expected_date, i.item_code, i.item_name, i.warehouse_code,
      i.qty_ordered, COALESCE(i.qty_received,0) qty_received,
      COALESCE(i.qty_cancelled,0) qty_cancelled,
      ${remainingExpression} remaining_quantity,
      ${remainingExpression}*COALESCE(i.unit_price,0) remaining_amount,
      o.currency_code, o.status purchase_status, o.id purchase_order_id,
      i.id purchase_order_item_id,
      CASE WHEN o.status='closed' THEN 1 ELSE 0 END closed_status
    FROM procurement_orders o
    JOIN procurement_order_items i ON i.purchase_order_id=o.id
    ${supplier.join}
    WHERE ${conditions.join(' AND ')}
    ORDER BY expected_date, o.purchase_order_no, i.line_no
    LIMIT ?`, params);
  return rows.map(row => ({
    ...row,
    overdue: dateOnly(row.expected_date) < range.asOf ? 1 : 0,
    closed_with_remaining: row.closed_status && number(row.remaining_quantity) > EPS ? 1 : 0,
  }));
}

async function reportSupplierArrivals(context, range, limit, definition) {
  const rows = await loadOpenPurchaseLines(context, range, limit, true);
  return finish(definition, context, range, rows, {
    supplier_count: new Set(rows.map(row => row.supplier_code)).size,
    purchase_order_count: new Set(rows.map(row => row.purchase_order_no)).size,
    pending_quantity: sum(rows, 'remaining_quantity'),
    pending_amount: sum(rows, 'remaining_amount'),
    overdue_quantity: sum(rows.filter(row => row.overdue), 'remaining_quantity'),
    overdue_order_count: new Set(rows.filter(row => row.overdue).map(row => row.purchase_order_no)).size,
    closed_with_remaining_count: rows.filter(row => row.closed_with_remaining).length,
    by_supplier: groupTotals(rows, 'supplier_code', 'remaining_amount'),
  }, { dateFields: ['order_date', 'expected_date'] });
}

async function reportItemArrivals(context, range, limit, definition) {
  const lines = await loadOpenPurchaseLines(context, range, Math.max(limit, 20000), true);
  const balances = new Map();
  if (await tableExists('erp_inventory_balances')) {
    const bScope = inventoryScope('b', context);
    const [rows] = await pool.query(`
      SELECT b.item_code, b.warehouse_code,
        COALESCE(SUM(b.quantity_on_hand),0) current_quantity,
        COALESCE(SUM(b.inventory_amount),0) current_amount
      FROM erp_inventory_balances b
      WHERE ${bScope.sql}
      GROUP BY b.item_code,b.warehouse_code`, bScope.params);
    for (const row of rows) balances.set(`${row.item_code}|${row.warehouse_code || ''}`, row);
  }
  const grouped = new Map();
  for (const row of lines) {
    const key = `${row.item_code}|${row.warehouse_code || ''}`;
    const current = grouped.get(key) || {
      item_code: row.item_code,
      item_name: row.item_name,
      warehouse_code: row.warehouse_code,
      next_expected_date: row.expected_date,
      pending_quantity: 0,
      pending_amount: 0,
      purchase_order_count: new Set(),
      supplier_count: new Set(),
      overdue_quantity: 0,
    };
    current.item_name ||= row.item_name;
    if (dateOnly(row.expected_date) < dateOnly(current.next_expected_date)) current.next_expected_date = row.expected_date;
    current.pending_quantity += number(row.remaining_quantity);
    current.pending_amount += number(row.remaining_amount);
    current.purchase_order_count.add(row.purchase_order_no);
    current.supplier_count.add(row.supplier_code);
    if (row.overdue) current.overdue_quantity += number(row.remaining_quantity);
    grouped.set(key, current);
  }
  const rows = [...grouped.values()].map(row => {
    const balance = balances.get(`${row.item_code}|${row.warehouse_code || ''}`) || {};
    return {
      ...row,
      purchase_order_count: row.purchase_order_count.size,
      supplier_count: row.supplier_count.size,
      current_quantity: number(balance.current_quantity),
      current_amount: number(balance.current_amount),
    };
  }).sort((a, b) => String(a.next_expected_date).localeCompare(String(b.next_expected_date)) || String(a.item_code).localeCompare(String(b.item_code))).slice(0, limit);
  return finish(definition, context, range, rows, {
    item_warehouse_count: rows.length,
    pending_quantity: sum(rows, 'pending_quantity'),
    pending_amount: sum(rows, 'pending_amount'),
    current_quantity: sum(rows, 'current_quantity'),
    current_amount: sum(rows, 'current_amount'),
    overdue_quantity: sum(rows, 'overdue_quantity'),
  }, { dateFields: ['next_expected_date'] });
}

async function legacyManufacturingSnapshot(sourceName) {
  try {
    const sourcePool = getSourcePool(sourceName);
    const [tables] = await sourcePool.query(`
      SELECT TABLE_NAME table_name
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('mocta','moctb','mocma','mocmb')
      ORDER BY TABLE_NAME`);
    const sourceTables = [];
    let rowCount = 0;
    for (const table of tables) {
      const [[count]] = await sourcePool.query(`SELECT COUNT(*) count FROM ${q(table.table_name)}`);
      sourceTables.push({ table_name: table.table_name, row_count: number(count.count) });
      rowCount += number(count.count);
    }
    return { source_tables: sourceTables, source_row_count: rowCount };
  } catch (error) {
    return { source_tables: [], source_row_count: 0, source_error: error.message };
  }
}

function pickColumn(columns, names) {
  return names.find(name => columns.has(name)) || null;
}

async function reportWorkOrderArrivals(context, range, limit, definition) {
  const candidates = ['manufacturing_orders', 'production_orders', 'mo_orders'];
  let targetTable = null;
  for (const candidate of candidates) if (await tableExists(candidate)) { targetTable = candidate; break; }
  if (!targetTable) {
    const legacy = await legacyManufacturingSnapshot(context.sourceDatabase);
    return finish(definition, context, range, [], {
      target_table: null,
      legacy_source_row_count: legacy.source_row_count,
    }, {
      available: false,
      status: 'needs_mapping',
      warnings: ['目前新 ERP 沒有標準化製令／生產入庫表；原始來源表只做唯讀存在性檢查，尚未直接把欄位當成製令報表。'],
      meta: {
        note: '待依 iSM 製造文件確認 MOCTA／MOCTB 欄位後，再建立標準化製令來源對照。',
        legacy_source_tables: legacy.source_tables,
        legacy_source_error: legacy.source_error || null,
      },
    });
  }
  const columns = await tableColumns(targetTable);
  const map = {
    orderNo: pickColumn(columns, ['work_order_no', 'manufacturing_order_no', 'order_no', 'document_no']),
    expectedDate: pickColumn(columns, ['expected_date', 'planned_receipt_date', 'completion_date']),
    itemCode: pickColumn(columns, ['item_code', 'product_code', 'sku']),
    itemName: pickColumn(columns, ['item_name', 'product_name', 'name']),
    warehouseCode: pickColumn(columns, ['warehouse_code', 'to_warehouse_code']),
    planned: pickColumn(columns, ['planned_quantity', 'qty_planned', 'quantity']),
    received: pickColumn(columns, ['received_quantity', 'qty_received', 'completed_quantity', 'qty_completed']),
    unitPrice: pickColumn(columns, ['unit_cost', 'unit_price', 'cost']),
    status: pickColumn(columns, ['status', 'order_status']),
    tenant: pickColumn(columns, ['tenant_id']),
    company: pickColumn(columns, ['company_id']),
    system: pickColumn(columns, ['source_system']),
    source: pickColumn(columns, ['source_database']),
  };
  const required = ['orderNo', 'expectedDate', 'itemCode', 'planned', 'received', 'tenant', 'company', 'system'];
  if (required.some(key => !map[key])) {
    return finish(definition, context, range, [], {}, {
      available: false,
      status: 'needs_mapping',
      warnings: [`已發現 ${targetTable}，但欄位尚未符合標準製令報表對照，暫不猜測欄位意義。`],
      meta: { target_table: targetTable, columns: [...columns] },
    });
  }
  const aliases = {
    orderNo: 'work_order_no', expectedDate: 'expected_date', itemCode: 'item_code',
    itemName: 'item_name', warehouseCode: 'warehouse_code', planned: 'planned_quantity',
    received: 'received_quantity', unitPrice: 'unit_price', status: 'status',
  };
  const selectColumn = key => map[key] ? `${q(map[key])} ${aliases[key]}` : `NULL ${aliases[key]}`;
  const where = [
    `${q(map.tenant)}=?`, `${q(map.company)}=?`, `${q(map.system)}=?`,
    `${q(map.expectedDate)} BETWEEN ? AND ?`,
    `GREATEST(${q(map.planned)}-COALESCE(${q(map.received)},0),0)>?`,
  ];
  const params = [context.tenant_id, context.company_id, context.source_system, range.from, range.to, EPS, limit];
  if (map.source) { where.splice(3, 0, `${q(map.source)}=?`); params.splice(3, 0, context.sourceDatabase); }
  const [rows] = await pool.query(`
    SELECT ${selectColumn('orderNo')},${selectColumn('expectedDate')},${selectColumn('itemCode')},
      ${selectColumn('itemName')},${selectColumn('warehouseCode')},${selectColumn('planned')},
      ${selectColumn('received')},${selectColumn('unitPrice')},${selectColumn('status')},
      GREATEST(${q(map.planned)}-COALESCE(${q(map.received)},0),0) remaining_quantity,
      GREATEST(${q(map.planned)}-COALESCE(${q(map.received)},0),0)*COALESCE(${map.unitPrice ? q(map.unitPrice) : '0'},0) remaining_amount
    FROM ${q(targetTable)}
    WHERE ${where.join(' AND ')}
    ORDER BY ${q(map.expectedDate)},${q(map.orderNo)}
    LIMIT ?`, params);
  return finish(definition, context, range, rows, {
    target_table: targetTable,
    planned_quantity: sum(rows, 'planned_quantity'),
    received_quantity: sum(rows, 'received_quantity'),
    remaining_quantity: sum(rows, 'remaining_quantity'),
    remaining_amount: sum(rows, 'remaining_amount'),
  }, { dateFields: ['expected_date'] });
}

async function reportOpenDocuments(context, range, limit, definition) {
  const rows = [];
  const purchaseLines = await loadOpenPurchaseLines(context, range, limit, false);
  for (const row of purchaseLines) rows.push({
    flow: '採購', document_kind: 'purchase_order', document_no: row.purchase_order_no,
    document_date: row.order_date, partner_code: row.supplier_code, item_code: row.item_code,
    item_name: row.item_name, warehouse_code: row.warehouse_code,
    ordered_quantity: number(row.qty_ordered), fulfilled_quantity: number(row.qty_received),
    cancelled_quantity: number(row.qty_cancelled), remaining_quantity: number(row.remaining_quantity),
    remaining_amount: number(row.remaining_amount), currency_code: row.currency_code,
    status: row.purchase_status, expected_date: row.expected_date, overdue: row.overdue,
    unclosed: row.purchase_status !== 'closed' ? 1 : 0,
    closed_with_remaining: row.closed_with_remaining,
  });
  if (await tableExists('procurement_requisitions') && await tableExists('procurement_requisition_items')) {
    const rScope = scope('r', context);
    const remaining = 'GREATEST(i.qty_requested-COALESCE(i.qty_ordered,0),0)';
    const [requisitions] = await pool.query(`
      SELECT r.requisition_no document_no,r.requisition_date document_date,
        i.item_code,i.item_name,i.warehouse_code,i.qty_requested ordered_quantity,
        COALESCE(i.qty_ordered,0) fulfilled_quantity,${remaining} remaining_quantity,
        i.required_date expected_date,r.status
      FROM procurement_requisitions r JOIN procurement_requisition_items i ON i.requisition_id=r.id
      WHERE ${rScope.sql} AND r.status NOT IN ('cancelled','closed')
        AND (${remaining}>? OR r.status NOT IN ('converted','closed'))
        AND COALESCE(i.required_date,r.requisition_date) BETWEEN ? AND ?
      ORDER BY expected_date,r.requisition_no,i.line_no LIMIT ?`, [...rScope.params, EPS, range.from, range.to, limit]);
    for (const row of requisitions) rows.push({
      flow: '請購', document_kind: 'requisition', document_no: row.document_no,
      document_date: row.document_date, partner_code: '', item_code: row.item_code,
      item_name: row.item_name, warehouse_code: row.warehouse_code,
      ordered_quantity: number(row.ordered_quantity), fulfilled_quantity: number(row.fulfilled_quantity),
      cancelled_quantity: 0, remaining_quantity: number(row.remaining_quantity), remaining_amount: 0,
      currency_code: 'TWD', status: row.status, expected_date: row.expected_date,
      overdue: dateOnly(row.expected_date) < range.asOf ? 1 : 0,
      unclosed: !['closed','cancelled'].includes(row.status) ? 1 : 0, closed_with_remaining: 0,
    });
  }
  if (await tableExists('sales_documents') && await tableExists('sales_document_items')) {
    const dScope = scope('d', context);
    const remaining = 'GREATEST(i.quantity-COALESCE(i.related_quantity,0),0)';
    const [sales] = await pool.query(`
      SELECT d.document_kind,d.document_no,d.document_date,d.customer_code partner_code,
        d.currency_code,d.status,i.item_code,i.item_name,i.warehouse_code,
        i.quantity ordered_quantity,COALESCE(i.related_quantity,0) fulfilled_quantity,
        ${remaining} remaining_quantity,${remaining}*COALESCE(i.unit_price,0) remaining_amount,
        i.expected_date
      FROM sales_documents d JOIN sales_document_items i ON i.document_id=d.id
      WHERE ${dScope.sql} AND d.document_kind IN ('quotation','sales_order') AND d.status<>'voided'
        AND (${remaining}>? OR d.status NOT IN ('completed','closed'))
        AND d.document_date BETWEEN ? AND ?
      ORDER BY d.document_date,d.document_no,i.line_no LIMIT ?`, [...dScope.params, EPS, range.from, range.to, limit]);
    for (const row of sales) rows.push({
      flow: row.document_kind === 'quotation' ? '報價' : '銷售',
      document_kind: row.document_kind, document_no: row.document_no,
      document_date: row.document_date, partner_code: row.partner_code, item_code: row.item_code,
      item_name: row.item_name, warehouse_code: row.warehouse_code,
      ordered_quantity: number(row.ordered_quantity), fulfilled_quantity: number(row.fulfilled_quantity),
      cancelled_quantity: 0, remaining_quantity: number(row.remaining_quantity),
      remaining_amount: number(row.remaining_amount), currency_code: row.currency_code,
      status: row.status, expected_date: row.expected_date,
      overdue: row.expected_date && dateOnly(row.expected_date) < range.asOf ? 1 : 0,
      unclosed: !['completed','closed'].includes(row.status) ? 1 : 0,
      closed_with_remaining: ['completed','closed'].includes(row.status) && number(row.remaining_quantity) > EPS ? 1 : 0,
    });
  }
  rows.sort((a, b) => String(a.expected_date || a.document_date).localeCompare(String(b.expected_date || b.document_date)) || String(a.document_no).localeCompare(String(b.document_no)));
  const clipped = rows.slice(0, limit);
  return finish(definition, context, range, clipped, {
    by_flow: groupTotals(clipped, 'flow', 'remaining_amount'),
    remaining_quantity: sum(clipped, 'remaining_quantity'),
    remaining_amount: sum(clipped, 'remaining_amount'),
    overdue_count: clipped.filter(row => row.overdue).length,
    unclosed_count: clipped.filter(row => row.unclosed).length,
    closed_with_remaining_count: clipped.filter(row => row.closed_with_remaining).length,
  }, { dateFields: ['document_date', 'expected_date'] });
}

function agingBucket(overdueDays, dueDate, asOf) {
  if (!dueDate) return '未設定到期日';
  if (dueDate >= asOf) return '未到期';
  if (overdueDays <= 30) return '逾期 1-30 天';
  if (overdueDays <= 60) return '逾期 31-60 天';
  if (overdueDays <= 90) return '逾期 61-90 天';
  return '逾期 91 天以上';
}

async function reportAging(context, range, limit, definition) {
  if (!await tableExists('finance_open_items')) return finish(definition, context, range, [], {}, {
    available: false, status: 'needs_schema', warnings: ['目前公司尚未建立應收／應付帳款表。']
  });
  const itemScope = scope('o', context);
  const [rows] = await pool.query(`
    SELECT o.account_type,o.party_code,o.document_no,o.document_date,o.due_date,o.currency_code,
      o.source_kind,o.source_document_no,o.original_amount,o.settled_amount,o.balance_amount,o.status
    FROM finance_open_items o
    WHERE ${itemScope.sql} AND o.status NOT IN ('voided','settled')
      AND o.balance_amount>? AND o.document_date BETWEEN ? AND ?
    ORDER BY o.due_date,o.document_date,o.document_no LIMIT ?`, [...itemScope.params, EPS, range.from, range.asOf, limit]);
  const mapped = rows.map(row => {
    const dueDate = dateOnly(row.due_date);
    const days = dueDate && dueDate < range.asOf ? Math.max(Math.floor((Date.parse(`${range.asOf}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86400000), 0) : 0;
    return { ...row, overdue_days: days, aging_bucket: agingBucket(days, dueDate, range.asOf) };
  });
  const bucketSummary = new Map();
  for (const row of mapped) {
    const key = `${row.account_type}/${row.aging_bucket}/${row.currency_code || 'TWD'}`;
    const current = bucketSummary.get(key) || { key, count: 0, balance_amount: 0 };
    current.count += 1; current.balance_amount += number(row.balance_amount); bucketSummary.set(key, current);
  }
  return finish(definition, context, range, mapped, {
    ar_balance: sum(mapped.filter(row => row.account_type === 'AR'), 'balance_amount'),
    ap_balance: sum(mapped.filter(row => row.account_type === 'AP'), 'balance_amount'),
    overdue_balance: sum(mapped.filter(row => row.overdue_days > 0), 'balance_amount'),
    overdue_count: mapped.filter(row => row.overdue_days > 0).length,
    by_bucket: [...bucketSummary.values()],
  }, { dateFields: ['document_date', 'due_date'], meta: { as_of_date: range.asOf } });
}

async function reportCashForecast(context, range, limit, definition) {
  const hasBanks = await tableExists('finance_bank_accounts');
  const hasTransactions = await tableExists('finance_bank_transactions');
  const hasOpenItems = await tableExists('finance_open_items');
  const starting = new Map();
  const warnings = [];
  if (hasBanks) {
    const bScope = scope('b', context);
    const transactionJoin = hasTransactions ? `
      LEFT JOIN finance_bank_transactions t ON t.bank_account_id=b.id
        AND t.tenant_id=b.tenant_id AND t.company_id=b.company_id
        AND t.source_system=b.source_system AND t.source_database=b.source_database
        AND t.status='posted' AND t.transaction_date<?` : '';
    const transactionParams = hasTransactions ? [range.from, ...bScope.params] : bScope.params;
    const [rows] = await pool.query(`
      SELECT COALESCE(b.currency_code,'TWD') currency_code,COUNT(DISTINCT b.id) bank_account_count,
        COALESCE(SUM(b.opening_balance),0)+COALESCE(SUM(CASE WHEN t.direction='in' THEN t.amount WHEN t.direction='out' THEN -t.amount ELSE 0 END),0) starting_balance
      FROM finance_bank_accounts b
      ${transactionJoin}
      WHERE ${bScope.sql} AND b.is_active=1 GROUP BY b.currency_code`, transactionParams);
    for (const row of rows) starting.set(row.currency_code || 'TWD', {
      currency_code: row.currency_code || 'TWD', bank_account_count: number(row.bank_account_count), starting_balance: number(row.starting_balance)
    });
  }
  if (!starting.size) warnings.push('目前公司沒有啟用中的銀行帳戶，預估起始餘額以 0 顯示；請先完成銀行期初／帳戶設定。');
  const events = [];
  if (hasTransactions && hasBanks) {
    const tScope = scope('t', context);
    const bScope = scope('b', context);
    const [rows] = await pool.query(`
      SELECT t.transaction_date event_date,t.transaction_no document_no,t.transaction_type,
        t.direction,t.amount,t.reference_no,t.counterparty party_code,t.memo,
        COALESCE(b.currency_code,'TWD') currency_code
      FROM finance_bank_transactions t JOIN finance_bank_accounts b ON b.id=t.bank_account_id
        AND ${bScope.sql}
      WHERE ${tScope.sql} AND t.status='posted' AND t.transaction_date BETWEEN ? AND ?
      ORDER BY t.transaction_date,t.id LIMIT ?`, [...bScope.params, ...tScope.params, range.from, range.to, limit]);
    for (const row of rows) events.push({
      event_date: row.event_date, currency_code: row.currency_code || 'TWD',
      flow_type: row.direction === 'out' ? '流出' : '流入', source_type: '已過帳銀行異動',
      document_no: row.document_no || row.reference_no, party_code: row.party_code,
      amount: number(row.amount), is_actual: 1, memo: row.memo || row.transaction_type || '',
      signed_amount: row.direction === 'out' ? -number(row.amount) : number(row.amount),
    });
  }
  if (hasOpenItems) {
    const oScope = scope('o', context);
    const [rows] = await pool.query(`
      SELECT COALESCE(o.due_date,o.document_date) event_date,o.account_type,
        o.document_no,o.party_code,o.currency_code,o.balance_amount,o.source_kind
      FROM finance_open_items o
      WHERE ${oScope.sql} AND o.status NOT IN ('voided','settled') AND o.balance_amount>?
        AND COALESCE(o.due_date,o.document_date) BETWEEN ? AND ?
      ORDER BY event_date,o.document_no LIMIT ?`, [...oScope.params, EPS, range.from, range.to, limit]);
    for (const row of rows) events.push({
      event_date: row.event_date, currency_code: row.currency_code || 'TWD',
      flow_type: row.account_type === 'AP' ? '流出' : '流入',
      source_type: row.account_type === 'AP' ? '待付款應付' : '待收款應收',
      document_no: row.document_no, party_code: row.party_code, amount: number(row.balance_amount),
      is_actual: 0, memo: row.source_kind || '',
      signed_amount: row.account_type === 'AP' ? -number(row.balance_amount) : number(row.balance_amount),
    });
  }
  events.sort((a, b) => dateOnly(a.event_date).localeCompare(dateOnly(b.event_date)) || String(a.source_type).localeCompare(String(b.source_type)) || String(a.document_no).localeCompare(String(b.document_no)));
  const running = new Map([...starting.entries()].map(([key, row]) => [key, number(row.starting_balance)]));
  const resultRows = events.slice(0, limit).map(event => {
    const currency = event.currency_code || 'TWD';
    if (!running.has(currency)) running.set(currency, number(starting.get(currency)?.starting_balance));
    const balance = running.get(currency) + number(event.signed_amount);
    running.set(currency, balance);
    return { ...event, running_balance: balance };
  });
  const byCurrency = new Map();
  for (const [currency, account] of starting) byCurrency.set(currency, {
    currency_code: currency, starting_balance: number(account.starting_balance), expected_in: 0, expected_out: 0, actual_in: 0, actual_out: 0,
  });
  for (const event of resultRows) {
    const currency = event.currency_code || 'TWD';
    const row = byCurrency.get(currency) || { currency_code: currency, starting_balance: 0, expected_in: 0, expected_out: 0, actual_in: 0, actual_out: 0 };
    if (event.flow_type === '流入') event.is_actual ? row.actual_in += number(event.amount) : row.expected_in += number(event.amount);
    else event.is_actual ? row.actual_out += number(event.amount) : row.expected_out += number(event.amount);
    byCurrency.set(currency, row);
  }
  for (const row of byCurrency.values()) row.ending_forecast = row.starting_balance + row.expected_in + row.actual_in - row.expected_out - row.actual_out;
  if (new Set(resultRows.map(row => row.currency_code)).size > 1) warnings.push('不同幣別分開計算，報表不會把原幣直接相加。');
  return finish(definition, context, range, resultRows, {
    event_count: resultRows.length,
    by_currency: [...byCurrency.values()],
    expected_in: sum(resultRows.filter(row => !row.is_actual && row.flow_type === '流入'), 'amount'),
    expected_out: sum(resultRows.filter(row => !row.is_actual && row.flow_type === '流出'), 'amount'),
    actual_in: sum(resultRows.filter(row => row.is_actual && row.flow_type === '流入'), 'amount'),
    actual_out: sum(resultRows.filter(row => row.is_actual && row.flow_type === '流出'), 'amount'),
  }, { dateFields: ['event_date'], warnings, meta: { starting_balance_basis: '銀行期初餘額＋起算日前已過帳異動；各幣別分開計算' } });
}

async function reportNoteStatus(context, range, limit, definition) {
  if (!await tableExists('finance_notes')) return finish(definition, context, range, [], {}, {
    available: false, status: 'needs_schema', warnings: ['目前公司尚未建立票據表。']
  });
  const nScope = scope('n', context);
  const [rows] = await pool.query(`
    SELECT n.account_type,n.note_no,n.note_type,n.issue_date,n.due_date,n.party_code,
      n.bank_code,n.amount,n.status,n.status_date,n.memo
    FROM finance_notes n
    WHERE ${nScope.sql} AND COALESCE(n.due_date,n.issue_date) BETWEEN ? AND ?
    ORDER BY n.due_date,n.note_no LIMIT ?`, [...nScope.params, range.from, range.to, limit]);
  const terminal = row => row.account_type === 'AP' ? ['honored','dishonored','voided'] : ['cashed','dishonored','voided'];
  const mapped = rows.map(row => {
    const due = dateOnly(row.due_date), unsettled = !terminal(row).includes(row.status);
    const overdue = unsettled && due && due < range.asOf ? Math.max(Math.floor((Date.parse(`${range.asOf}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86400000), 0) : 0;
    return { ...row, is_unsettled: unsettled ? 1 : 0, overdue_days: overdue };
  });
  const statuses = new Map();
  for (const row of mapped) {
    const key = `${row.account_type}/${row.status}`;
    const current = statuses.get(key) || { key, count: 0, amount: 0 };
    current.count += 1; current.amount += number(row.amount); statuses.set(key, current);
  }
  return finish(definition, context, range, mapped, {
    unsettled_count: mapped.filter(row => row.is_unsettled).length,
    unsettled_amount: sum(mapped.filter(row => row.is_unsettled), 'amount'),
    overdue_count: mapped.filter(row => row.overdue_days > 0).length,
    overdue_amount: sum(mapped.filter(row => row.overdue_days > 0), 'amount'),
    by_status: [...statuses.values()],
  }, { dateFields: ['issue_date', 'due_date', 'status_date'] });
}

async function buildReport(key, context, range, limit) {
  const definition = definitionFor(key);
  if (key === 'supplier-arrivals') return reportSupplierArrivals(context, range, limit, definition);
  if (key === 'item-arrivals') return reportItemArrivals(context, range, limit, definition);
  if (key === 'work-order-arrivals') return reportWorkOrderArrivals(context, range, limit, definition);
  if (key === 'open-documents') return reportOpenDocuments(context, range, limit, definition);
  if (key === 'aging') return reportAging(context, range, limit, definition);
  if (key === 'cash-forecast') return reportCashForecast(context, range, limit, definition);
  if (key === 'note-status') return reportNoteStatus(context, range, limit, definition);
  throw badRequest(`不支援的報表：${key}`);
}

export function registerReportingRoutes(app) {
  app.get('/api/reports/definitions', (_req, res) => {
    res.json({ ok: true, data: REPORT_DEFINITIONS.map(({ key, label, description }) => ({ key, label, description })) });
  });
  app.get('/api/reports/receivable-center', async (req, res, next) => {
    try {
      const sourceName = String(req.query.source_database || req.get('X-Source-Database') || 'SH').trim().toUpperCase();
      const context = contextFor(sourceName);
      const range = reportRange(req.query);
      const limit = reportLimit(req.query, 500);
      const result = await runWithTargetDatabase(sourceName, () => reportReceivableCenter(context, range, limit, req.query));
      res.json({ ok: true, data: result });
    } catch (error) { next(error); }
  });
  app.get('/api/reports/operations', async (req, res, next) => {
    try {
      const sourceName = String(req.query.source_database || req.get('X-Source-Database') || 'SH').trim().toUpperCase();
      const context = contextFor(sourceName);
      const range = reportRange(req.query);
      const limit = reportLimit(req.query);
      const result = await runWithTargetDatabase(sourceName, () => buildReport(String(req.query.report || 'supplier-arrivals'), context, range, limit));
      res.json({ ok: true, data: result });
    } catch (error) { next(error); }
  });
}
