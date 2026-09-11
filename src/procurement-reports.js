const EPSILON = 0.000001;

const G02_REPORTS = Object.freeze({
  progress: '採購跟催管理報表',
  supplier_expected: '廠商預計進貨表',
  item_expected: '品號預計進貨表',
  manufacturing_expected: '製令預計進貨表',
  supplier_delivery: '廠商採購交貨狀況表',
});

const G03_REPORTS = Object.freeze({
  supplier_detail: '廠商進貨明細表',
  supplier_summary: '廠商進貨彙總表',
  supplier_statistics: '廠商進貨統計表',
  item_history_detail: '品號歷史進貨記錄表',
  item_history_summary: '品號歷史進貨彙總表',
  rejected_open: '驗退件未退明細表',
  purchase_detail: '採購明細表',
  receipt_detail: '進貨明細表',
  rejected_return_detail: '驗退件退回明細表',
  return_detail: '退貨明細表',
  requisition_detail: '廠商／品號別請購明細表',
  invoice_missing: '已進貨未收發票明細表',
});

const REPORT_COLUMNS = Object.freeze({
  progress: [
    ['purchase_order_no', '採購單號'], ['order_date', '採購日'], ['expected_date', '預交日'],
    ['supplier_code', '廠商代號'], ['item_code', '品號'], ['item_name', '品名'],
    ['warehouse_code', '庫別'], ['qty_ordered', '採購量'], ['qty_received', '已交量'],
    ['pending_arrival_quantity', '待驗收量'], ['qty_cancelled', '取消量'],
    ['remaining_quantity', '未交量'], ['remaining_amount', '未交金額'], ['progress_status', '進度／結案'],
    ['source_key', '來源鍵'], ['next_stage', '下一階段'],
  ],
  supplier_expected: [
    ['supplier_code', '廠商代號'], ['order_count', '採購單數'], ['line_count', '明細筆數'],
    ['qty_ordered', '採購量'], ['qty_received', '已交量'], ['pending_arrival_quantity', '待驗收量'],
    ['remaining_quantity', '未交量'], ['remaining_amount', '未交金額'], ['earliest_expected_date', '最早預交日'],
    ['overdue_line_count', '逾期筆數'], ['source_key', '來源鍵'], ['next_stage', '下一階段'],
  ],
  item_expected: [
    ['item_code', '品號'], ['item_name', '品名'], ['warehouse_code', '庫別'],
    ['order_count', '採購單數'], ['line_count', '明細筆數'], ['qty_ordered', '採購量'],
    ['qty_received', '已交量'], ['pending_arrival_quantity', '待驗收量'], ['remaining_quantity', '未交量'],
    ['remaining_amount', '未交金額'], ['earliest_expected_date', '最早預交日'],
    ['source_key', '來源鍵'], ['next_stage', '下一階段'],
  ],
  supplier_delivery: [
    ['supplier_code', '廠商代號'], ['order_count', '採購單數'], ['line_count', '明細筆數'],
    ['qty_ordered', '採購量'], ['qty_received', '已交量'], ['remaining_quantity', '未交量'],
    ['remaining_amount', '未交金額'], ['on_time_line_count', '準時交貨筆數'],
    ['overdue_line_count', '逾期筆數'], ['source_key', '來源鍵'], ['next_stage', '下一階段'],
  ],
  supplier_detail: [
    ['receipt_no', '進貨單號'], ['receipt_date', '進貨日'], ['arrival_date', '到貨日'],
    ['supplier_code', '廠商代號'], ['purchase_order_no', '採購單號'], ['item_code', '品號'],
    ['item_name', '品名'], ['warehouse_code', '庫別'], ['qty_received', '到貨量'],
    ['qty_accepted', '驗收合格量'], ['qty_rejected', '驗退量'], ['qty_rejected_returned', '驗退已退量'],
    ['qty_returned', '退貨量'], ['qty_priced', '計價量'], ['qty_paid', '付款量'],
    ['priced_amount', '計價金額'], ['unpaid_amount', '未付金額'], ['invoice_no', '發票號碼'],
    ['quality_status', '品質／退回狀態'], ['source_key', '來源鍵'], ['next_stage', '下一階段'],
  ],
  supplier_summary: [
    ['supplier_code', '廠商代號'], ['receipt_count', '進貨單數'], ['line_count', '明細筆數'],
    ['qty_received', '到貨量'], ['qty_accepted', '驗收合格量'], ['qty_rejected', '驗退量'],
    ['qty_rejected_returned', '驗退已退量'], ['qty_returned', '退貨量'], ['qty_priced', '計價量'],
    ['qty_paid', '付款量'], ['priced_amount', '計價金額'], ['unpaid_amount', '未付金額'],
    ['invoice_missing_count', '未收發票筆數'], ['source_key', '來源鍵'], ['next_stage', '下一階段'],
  ],
  supplier_statistics: [
    ['period', '期間'], ['supplier_code', '廠商代號'], ['receipt_count', '進貨單數'],
    ['line_count', '明細筆數'], ['qty_received', '到貨量'], ['qty_accepted', '驗收合格量'],
    ['qty_rejected', '驗退量'], ['qty_returned', '退貨量'], ['priced_amount', '計價金額'],
    ['unpaid_amount', '未付金額'], ['source_key', '來源鍵'], ['next_stage', '下一階段'],
  ],
  item_history_detail: [
    ['item_code', '品號'], ['item_name', '品名'], ['receipt_no', '進貨單號'], ['receipt_date', '進貨日'],
    ['supplier_code', '廠商代號'], ['purchase_order_no', '採購單號'], ['qty_received', '到貨量'],
    ['qty_accepted', '驗收合格量'], ['qty_rejected', '驗退量'], ['qty_returned', '退貨量'],
    ['qty_priced', '計價量'], ['qty_paid', '付款量'], ['priced_amount', '計價金額'],
    ['source_key', '來源鍵'], ['next_stage', '下一階段'],
  ],
  item_history_summary: [
    ['item_code', '品號'], ['item_name', '品名'], ['receipt_count', '進貨單數'], ['line_count', '明細筆數'],
    ['qty_received', '到貨量'], ['qty_accepted', '驗收合格量'], ['qty_rejected', '驗退量'],
    ['qty_returned', '退貨量'], ['qty_priced', '計價量'], ['qty_paid', '付款量'],
    ['priced_amount', '計價金額'], ['unpaid_amount', '未付金額'], ['source_key', '來源鍵'],
    ['next_stage', '下一階段'],
  ],
  rejected_open: [
    ['receipt_no', '進貨單號'], ['receipt_date', '進貨日'], ['supplier_code', '廠商代號'],
    ['item_code', '品號'], ['qty_rejected', '驗退量'], ['qty_rejected_returned', '驗退已退量'],
    ['remaining_rejected_quantity', '待退量'], ['source_key', '來源鍵'], ['next_stage', '下一階段'],
  ],
  purchase_detail: [
    ['purchase_order_no', '採購單號'], ['order_date', '採購日'], ['expected_date', '預交日'],
    ['supplier_code', '廠商代號'], ['item_code', '品號'], ['item_name', '品名'], ['warehouse_code', '庫別'],
    ['qty_ordered', '採購量'], ['qty_received', '已交量'], ['remaining_quantity', '未交量'],
    ['remaining_amount', '未交金額'], ['purchase_order_status', '採購狀態'], ['source_key', '來源鍵'],
    ['next_stage', '下一階段'],
  ],
  receipt_detail: [
    ['receipt_no', '進貨單號'], ['receipt_date', '進貨日'], ['arrival_date', '到貨日'],
    ['supplier_code', '廠商代號'], ['purchase_order_no', '採購單號'], ['item_code', '品號'],
    ['item_name', '品名'], ['qty_received', '到貨量'], ['qty_accepted', '驗收合格量'],
    ['qty_rejected', '驗退量'], ['qty_returned', '退貨量'], ['qty_priced', '計價量'], ['qty_paid', '付款量'],
    ['priced_amount', '計價金額'], ['unpaid_amount', '未付金額'], ['inventory_status', '庫存狀態'],
    ['source_key', '來源鍵'], ['next_stage', '下一階段'],
  ],
  rejected_return_detail: [
    ['receipt_no', '進貨單號'], ['supplier_code', '廠商代號'], ['item_code', '品號'],
    ['returned_date', '實際退回日'], ['returned_quantity', '退回量'], ['returned_by', '退回人員'],
    ['note', '備註'], ['source_key', '來源鍵'], ['next_stage', '下一階段'],
  ],
  return_detail: [
    ['return_no', '退貨單號'], ['return_date', '退貨日'], ['return_type', '退貨／折讓'],
    ['supplier_code', '廠商代號'], ['receipt_no', '來源進貨單號'], ['item_code', '品號'],
    ['return_quantity', '退貨量'], ['allowance_amount', '折讓金額'], ['priced_quantity', '已計價退回量'],
    ['status', '狀態'], ['inventory_status', '庫存狀態'], ['source_key', '來源鍵'], ['next_stage', '下一階段'],
  ],
  requisition_detail: [
    ['requisition_no', '請購單號'], ['requisition_date', '請購日'], ['requester_code', '請購人員'],
    ['department_code', '部門'], ['supplier_code', '廠商代號'], ['item_code', '品號'], ['item_name', '品名'],
    ['qty_requested', '請購量'], ['qty_ordered', '已轉採購量'], ['remaining_quantity', '未轉量'],
    ['requisition_status', '請購狀態'], ['source_key', '來源鍵'], ['next_stage', '下一階段'],
  ],
  invoice_missing: [
    ['receipt_no', '進貨單號'], ['receipt_date', '進貨日'], ['supplier_code', '廠商代號'],
    ['purchase_order_no', '採購單號'], ['item_code', '品號'], ['qty_accepted', '驗收合格量'],
    ['qty_priced', '計價量'], ['priced_amount', '計價金額'], ['invoice_status', '發票狀態'],
    ['receipt_status', '進貨狀態'], ['source_key', '來源鍵'], ['next_stage', '下一階段'],
  ],
});

function error(status, message) {
  return Object.assign(new Error(message), { status });
}

function text(value) {
  return String(value ?? '').trim();
}

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function amount(value) {
  return Math.round((number(value) + Number.EPSILON) * 1000000) / 1000000;
}

function date(value, label) {
  const result = text(value);
  if (!result) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw error(400, `${label} 必須是 YYYY-MM-DD`);
  const parsed = new Date(`${result}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== result) {
    throw error(400, `${label} 不是有效日期`);
  }
  return result;
}

function filtersFrom(req) {
  const from = date(req.query.date_from || req.query.from_date, '起日');
  const to = date(req.query.date_to || req.query.to_date, '迄日');
  if (from && to && from > to) throw error(400, '日期起訖順序錯誤');
  return {
    dateFrom: from,
    dateTo: to,
    supplierCode: text(req.query.supplier_code),
    itemCode: text(req.query.item_code),
    warehouseCode: text(req.query.warehouse_code),
    limit: Math.min(Math.max(Number(req.query.limit) || 100, 1), 500),
  };
}

function contextParams(context) {
  return [context.tenant_id, context.company_id, context.source_system, context.source_database];
}

function scope(alias, context) {
  return [
    `${alias}.tenant_id=?`, `${alias}.company_id=?`, `${alias}.source_system=?`, `${alias}.source_database=?`,
  ];
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function lineRemaining(row) {
  return Math.max(number(row.qty_ordered) - number(row.qty_received) - number(row.qty_cancelled) - number(row.pending_arrival_quantity), 0);
}

function orderLineStatus(row) {
  const remaining = number(row.remaining_quantity);
  const pending = number(row.pending_arrival_quantity);
  const accepted = number(row.qty_received);
  if (row.purchase_order_status === 'closed') return 'closed';
  if (remaining <= EPSILON) return 'fulfilled_waiting_close';
  if (pending > EPSILON && accepted > EPSILON) return 'partial_arrival_waiting_inspection';
  if (pending > EPSILON) return 'arrived_waiting_inspection';
  if (row.expected_date && row.expected_date < today()) return 'overdue';
  if (accepted > EPSILON) return 'partial';
  return 'open';
}

function orderNextStage(row) {
  if (number(row.pending_arrival_quantity) > EPSILON) return '進貨驗收';
  if (number(row.remaining_quantity) > EPSILON) return '廠商到貨／進貨建立';
  if (row.purchase_order_status !== 'closed') return '採購指定結案／應付';
  return '應付／付款或流程稽核';
}

async function fetchOrderLines(conn, context, filters) {
  const pendingScope = scope('pr', context);
  const where = [...scope('o', context), "o.status<>'cancelled'"];
  const params = [...contextParams(context)];

  if (filters.dateFrom) { where.push('COALESCE(i.expected_date,o.expected_date,o.order_date)>=?'); params.push(filters.dateFrom); }
  if (filters.dateTo) { where.push('COALESCE(i.expected_date,o.expected_date,o.order_date)<=?'); params.push(filters.dateTo); }
  if (filters.supplierCode) { where.push('o.supplier_code=?'); params.push(filters.supplierCode); }
  if (filters.itemCode) { where.push('i.item_code=?'); params.push(filters.itemCode); }
  if (filters.warehouseCode) { where.push('i.warehouse_code=?'); params.push(filters.warehouseCode); }

  const [rows] = await conn.query(`
    SELECT o.id AS purchase_order_id, o.purchase_order_no, o.order_date, o.expected_date AS order_expected_date,
      o.supplier_code, o.currency_code, o.status AS purchase_order_status, o.document_type AS order_document_type,
      o.tenant_id, o.company_id, o.source_system, o.source_database,
      i.id AS purchase_order_item_id, i.requisition_item_id, i.line_no, i.item_code, i.item_name,
      i.specification, i.warehouse_code, i.unit, i.qty_ordered, i.qty_received, i.qty_cancelled,
      i.unit_price, i.expected_date, COALESCE(p.pending_arrival_quantity,0) AS pending_arrival_quantity
    FROM procurement_orders o
    JOIN procurement_order_items i ON i.purchase_order_id=o.id
    LEFT JOIN (
      SELECT ri.purchase_order_item_id,
        SUM(CASE WHEN pr.status='pending_inspection' THEN COALESCE(ri.qty_received,0)
          ELSE GREATEST(COALESCE(ri.qty_received,0)-COALESCE(ri.qty_accepted,0),0) END) AS pending_arrival_quantity
      FROM procurement_receipt_items ri
      JOIN procurement_receipts pr ON pr.id=ri.receipt_id
      WHERE ${pendingScope.join(' AND ')} AND pr.status IN ('pending_inspection','partially_accepted')
        AND COALESCE(pr.inventory_status,'pending')='pending'
      GROUP BY ri.purchase_order_item_id
    ) p ON p.purchase_order_item_id=i.id
    WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(i.expected_date,o.expected_date,o.order_date) ASC,o.id ASC,i.line_no ASC`,
  [...contextParams(context), ...params]);

  return rows.map(row => {
    const expectedDate = row.expected_date || row.order_expected_date || null;
    const normalized = {
      ...row,
      order_date: row.order_date ? String(row.order_date).slice(0, 10) : null,
      expected_date: expectedDate ? String(expectedDate).slice(0, 10) : null,
      qty_ordered: number(row.qty_ordered),
      qty_received: number(row.qty_received),
      qty_cancelled: number(row.qty_cancelled),
      unit_price: number(row.unit_price),
      pending_arrival_quantity: number(row.pending_arrival_quantity),
    };
    normalized.remaining_quantity = amount(lineRemaining(normalized));
    normalized.remaining_amount = amount(normalized.remaining_quantity * normalized.unit_price);
    normalized.ordered_amount = amount(normalized.qty_ordered * normalized.unit_price);
    normalized.progress_status = orderLineStatus(normalized);
    normalized.source_key = `PUR-PO:${normalized.purchase_order_id}/${normalized.purchase_order_item_id}`;
    normalized.next_stage = orderNextStage(normalized);
    return normalized;
  });
}

function sumRows(rows, key) {
  return amount(rows.reduce((total, row) => total + number(row[key]), 0));
}

function groupRows(rows, keys, numericKeys, options = {}) {
  const grouped = new Map();
  for (const row of rows) {
    const groupKey = keys.map(key => text(row[key])).join('\u001f');
    if (!grouped.has(groupKey)) {
      const item = {};
      for (const key of keys) item[key] = row[key] ?? '';
      for (const key of numericKeys) item[key] = 0;
      item.line_count = 0;
      item.order_count = new Set();
      item.receipt_count = new Set();
      grouped.set(groupKey, item);
    }
    const item = grouped.get(groupKey);
    item.line_count += 1;
    if (row.purchase_order_id != null) item.order_count.add(String(row.purchase_order_id));
    if (row.receipt_id != null) item.receipt_count.add(String(row.receipt_id));
    for (const key of numericKeys) item[key] = amount(number(item[key]) + number(row[key]));
    if (options.minDateKey && row[options.minDateKey]) {
      if (!item[options.outputDateKey] || String(row[options.minDateKey]) < String(item[options.outputDateKey])) item[options.outputDateKey] = row[options.minDateKey];
    }
    if (options.collect) options.collect(item, row);
  }
  return [...grouped.values()].map(item => {
    if (item.order_count instanceof Set) item.order_count = item.order_count.size;
    if (item.receipt_count instanceof Set) item.receipt_count = item.receipt_count.size;
    return item;
  });
}

function orderReportRows(lines, report) {
  if (report === 'progress') return lines;
  if (report === 'supplier_expected') {
    const rows = groupRows(lines, ['supplier_code'], ['qty_ordered', 'qty_received', 'pending_arrival_quantity', 'remaining_quantity', 'remaining_amount'], {
      minDateKey: 'expected_date', outputDateKey: 'earliest_expected_date',
      collect: (item, row) => {
        item.overdue_line_count = number(item.overdue_line_count) + (['overdue', 'partial'].includes(row.progress_status) && row.expected_date && row.expected_date < today() ? 1 : 0);
      },
    });
    return rows.map(row => ({ ...row, source_key: `PUR-G02:SUPPLIER:${row.supplier_code}`, next_stage: row.remaining_quantity > EPSILON ? '廠商到貨／進貨驗收' : '採購結案／應付' }));
  }
  if (report === 'item_expected') {
    const rows = groupRows(lines, ['item_code', 'item_name', 'warehouse_code'], ['qty_ordered', 'qty_received', 'pending_arrival_quantity', 'remaining_quantity', 'remaining_amount'], {
      minDateKey: 'expected_date', outputDateKey: 'earliest_expected_date',
    });
    return rows.map(row => ({ ...row, source_key: `PUR-G02:ITEM:${row.item_code}:${row.warehouse_code || 'NA'}`, next_stage: row.remaining_quantity > EPSILON ? '廠商到貨／進貨驗收' : '採購結案／應付' }));
  }
  if (report === 'supplier_delivery') {
    const rows = groupRows(lines, ['supplier_code'], ['qty_ordered', 'qty_received', 'remaining_quantity', 'remaining_amount'], {
      collect: (item, row) => {
        item.on_time_line_count = number(item.on_time_line_count) + (row.expected_date && row.remaining_quantity <= EPSILON ? 1 : 0);
        item.overdue_line_count = number(item.overdue_line_count) + (row.expected_date && row.remaining_quantity > EPSILON && row.expected_date < today() ? 1 : 0);
      },
    });
    return rows.map(row => ({ ...row, source_key: `PUR-G02:DELIVERY:${row.supplier_code}`, next_stage: row.remaining_quantity > EPSILON ? '催交／到貨登錄' : '完成交貨／採購結案' }));
  }
  return [];
}

async function fetchReceiptRows(conn, context, filters) {
  const where = [...scope('r', context), "r.status<>'voided'"];
  const params = [...contextParams(context)];
  if (filters.dateFrom) { where.push('r.receipt_date>=?'); params.push(filters.dateFrom); }
  if (filters.dateTo) { where.push('r.receipt_date<=?'); params.push(filters.dateTo); }
  if (filters.supplierCode) { where.push('r.supplier_code=?'); params.push(filters.supplierCode); }
  if (filters.itemCode) { where.push('ri.item_code=?'); params.push(filters.itemCode); }
  if (filters.warehouseCode) { where.push('COALESCE(ri.warehouse_code,r.warehouse_code)=?'); params.push(filters.warehouseCode); }

  const [rows] = await conn.query(`
    SELECT r.id AS receipt_id, r.receipt_no, r.receipt_date, r.arrival_date, r.delivery_note_no, r.invoice_no,
      r.received_by, r.supplier_code, r.warehouse_code AS receipt_warehouse_code, r.status AS receipt_status,
      r.inventory_status, r.tenant_id, r.company_id, r.source_system, r.source_database,
      ri.id AS receipt_item_id, ri.purchase_order_item_id, ri.line_no AS receipt_line_no, ri.item_code,
      ri.item_name, ri.specification, ri.warehouse_code, ri.unit, ri.qty_received, ri.qty_accepted,
      ri.qty_rejected, ri.qty_rejected_returned, ri.qty_returned, ri.qty_priced, ri.qty_paid,
      ri.qty_returned_priced, ri.unit_cost, ri.freight_amount, ri.insurance_amount, ri.other_expense_amount,
      ri.inspection_status, ri.inspection_note, ri.inspected_by, ri.inspected_at,
      o.id AS purchase_order_id, o.purchase_order_no, o.order_date, o.expected_date,
      oi.line_no AS purchase_order_line_no, o.status AS purchase_order_status
    FROM procurement_receipts r
    JOIN procurement_receipt_items ri ON ri.receipt_id=r.id
    LEFT JOIN procurement_order_items oi ON oi.id=ri.purchase_order_item_id
    LEFT JOIN procurement_orders o ON o.id=oi.purchase_order_id AND ${scope('o', context).join(' AND ')}
    WHERE ${where.join(' AND ')}
    ORDER BY r.receipt_date DESC,r.id DESC,ri.line_no ASC`, [...contextParams(context), ...params]);

  return rows.map(row => {
    const received = number(row.qty_received);
    const accepted = number(row.qty_accepted);
    const rejected = number(row.qty_rejected);
    const rejectedReturned = number(row.qty_rejected_returned);
    const returned = number(row.qty_returned);
    const priced = number(row.qty_priced);
    const returnedPriced = number(row.qty_returned_priced);
    const paid = Math.min(Math.max(number(row.qty_paid), 0), Math.max(priced - returnedPriced, 0));
    const activePriced = Math.max(priced - returnedPriced, 0);
    const expenseTotal = number(row.freight_amount) + number(row.insurance_amount) + number(row.other_expense_amount);
    const pricedAmount = amount(priced * number(row.unit_cost) + (accepted > EPSILON ? expenseTotal * priced / accepted : 0));
    const activePricedAmount = amount(activePriced * number(row.unit_cost) + (accepted > EPSILON ? expenseTotal * activePriced / accepted : 0));
    const paidAmount = amount(activePriced > EPSILON ? activePricedAmount * paid / activePriced : 0);
    const qualityOpen = Math.max(rejected - rejectedReturned, 0);
    const returnable = Math.max(accepted - returned, 0);
    const nextStage = qualityOpen > EPSILON ? '驗退件退回' : row.inventory_status !== 'posted' ? '進貨確認／庫存過帳' : activePriced - paid > EPSILON ? '應付／付款' : '採購流程稽核';
    return {
      ...row,
      receipt_date: row.receipt_date ? String(row.receipt_date).slice(0, 10) : null,
      arrival_date: row.arrival_date ? String(row.arrival_date).slice(0, 10) : null,
      order_date: row.order_date ? String(row.order_date).slice(0, 10) : null,
      expected_date: row.expected_date ? String(row.expected_date).slice(0, 10) : null,
      warehouse_code: row.warehouse_code || row.receipt_warehouse_code || '',
      qty_received: received,
      qty_accepted: accepted,
      qty_rejected: rejected,
      qty_rejected_returned: rejectedReturned,
      qty_returned: returned,
      qty_priced: priced,
      qty_paid: paid,
      qty_returned_priced: returnedPriced,
      returnable_quantity: amount(returnable),
      remaining_rejected_quantity: amount(qualityOpen),
      pricing_eligible_quantity: amount(Math.max(accepted - returned - activePriced, 0)),
      priced_amount: pricedAmount,
      active_priced_amount: activePricedAmount,
      paid_amount: paidAmount,
      unpaid_amount: amount(Math.max(activePricedAmount - paidAmount, 0)),
      invoice_status: text(row.invoice_no) ? 'registered' : 'missing',
      quality_status: qualityOpen > EPSILON ? '驗退件待退回' : returned > EPSILON ? '已有退貨' : rejected > EPSILON ? '驗退已完成' : '合格',
      source_key: `PUR-GR:${row.receipt_id}/${row.receipt_item_id}`,
      next_stage: nextStage,
      paid_amount_basis: '依既有付款量按有效計價金額比例計算',
    };
  });
}

async function fetchReturnRows(conn, context, filters) {
  const where = [...scope('r', context), "r.status<>'voided'"];
  const params = [...contextParams(context)];
  if (filters.dateFrom) { where.push('r.return_date>=?'); params.push(filters.dateFrom); }
  if (filters.dateTo) { where.push('r.return_date<=?'); params.push(filters.dateTo); }
  if (filters.supplierCode) { where.push('r.supplier_code=?'); params.push(filters.supplierCode); }
  if (filters.itemCode) { where.push('ri.item_code=?'); params.push(filters.itemCode); }

  const [rows] = await conn.query(`
    SELECT r.id AS return_id, r.return_no, r.return_date, r.return_type, r.supplier_code, r.status,
      r.inventory_status, r.note, r.tenant_id, r.company_id, r.source_system, r.source_database,
      ri.id AS return_item_id, ri.receipt_item_id, ri.item_code, ri.item_name, ri.warehouse_code,
      ri.unit, ri.return_quantity, ri.allowance_amount, ri.priced_quantity, ri.unit_cost, ri.reason,
      pr.receipt_no, pr.receipt_date
    FROM procurement_returns r
    JOIN procurement_return_items ri ON ri.return_id=r.id
    LEFT JOIN procurement_receipt_items pri ON pri.id=ri.receipt_item_id
    LEFT JOIN procurement_receipts pr ON pr.id=pri.receipt_id AND ${scope('pr', context).join(' AND ')}
    WHERE ${where.join(' AND ')}
    ORDER BY r.return_date DESC,r.id DESC,ri.line_no ASC`, [...contextParams(context), ...params]);
  return rows.map(row => ({
    ...row,
    return_date: row.return_date ? String(row.return_date).slice(0, 10) : null,
    receipt_date: row.receipt_date ? String(row.receipt_date).slice(0, 10) : null,
    return_quantity: number(row.return_quantity),
    allowance_amount: amount(row.allowance_amount),
    priced_quantity: number(row.priced_quantity),
    unit_cost: number(row.unit_cost),
    source_key: `PUR-RETURN:${row.return_id}/${row.return_item_id}`,
    next_stage: row.return_type === 'return' && row.inventory_status !== 'posted' ? '退貨確認／庫存過帳' : '應付沖帳／流程稽核',
  }));
}

async function fetchRejectedReturnRows(conn, context, filters) {
  const where = [...scope('rr', context)];
  const params = [...contextParams(context)];
  if (filters.dateFrom) { where.push('rr.returned_date>=?'); params.push(filters.dateFrom); }
  if (filters.dateTo) { where.push('rr.returned_date<=?'); params.push(filters.dateTo); }
  if (filters.supplierCode) { where.push('pr.supplier_code=?'); params.push(filters.supplierCode); }
  if (filters.itemCode) { where.push('pri.item_code=?'); params.push(filters.itemCode); }
  const [rows] = await conn.query(`
    SELECT rr.id AS rejected_return_id, rr.receipt_id, rr.receipt_item_id, rr.returned_date,
      rr.returned_quantity, rr.returned_by, rr.note, rr.tenant_id, rr.company_id, rr.source_system,
      rr.source_database, pr.receipt_no, pr.supplier_code, pri.item_code
    FROM procurement_rejected_returns rr
    JOIN procurement_receipts pr ON pr.id=rr.receipt_id AND ${scope('pr', context).join(' AND ')}
    JOIN procurement_receipt_items pri ON pri.id=rr.receipt_item_id AND pri.receipt_id=rr.receipt_id
    WHERE ${where.join(' AND ')}
    ORDER BY rr.returned_date DESC,rr.id DESC`, [...contextParams(context), ...params]);
  return rows.map(row => ({
    ...row,
    returned_date: row.returned_date ? String(row.returned_date).slice(0, 10) : null,
    returned_quantity: number(row.returned_quantity),
    source_key: `PUR-REJECT-RETURN:${row.rejected_return_id}`,
    next_stage: '驗退／採購流程稽核',
  }));
}

async function fetchRequisitionRows(conn, context, filters) {
  const where = [...scope('r', context)];
  const params = [...contextParams(context)];
  if (filters.dateFrom) { where.push('r.requisition_date>=?'); params.push(filters.dateFrom); }
  if (filters.dateTo) { where.push('r.requisition_date<=?'); params.push(filters.dateTo); }
  if (filters.itemCode) { where.push('ri.item_code=?'); params.push(filters.itemCode); }
  const [rows] = await conn.query(`
    SELECT r.id AS requisition_id, r.requisition_no, r.requisition_date, r.requester_code,
      r.department_code, r.status AS requisition_status, r.tenant_id, r.company_id, r.source_system,
      r.source_database, ri.id AS requisition_item_id, ri.item_code, ri.item_name, ri.warehouse_code,
      ri.qty_requested, ri.qty_ordered, COALESCE(GROUP_CONCAT(DISTINCT o.supplier_code ORDER BY o.supplier_code SEPARATOR ','),'') AS supplier_code
    FROM procurement_requisitions r
    JOIN procurement_requisition_items ri ON ri.requisition_id=r.id
    LEFT JOIN procurement_order_items oi ON oi.requisition_item_id=ri.id
    LEFT JOIN procurement_orders o ON o.id=oi.purchase_order_id AND ${scope('o', context).join(' AND ')}
    WHERE ${where.join(' AND ')}
    GROUP BY r.id,r.requisition_no,r.requisition_date,r.requester_code,r.department_code,r.status,
      r.tenant_id,r.company_id,r.source_system,r.source_database,ri.id,ri.item_code,ri.item_name,ri.warehouse_code,
      ri.qty_requested,ri.qty_ordered
    ORDER BY r.requisition_date DESC,r.id DESC,ri.line_no ASC`, [...contextParams(context), ...params]);
  return rows.map(row => ({
    ...row,
    requisition_date: row.requisition_date ? String(row.requisition_date).slice(0, 10) : null,
    qty_requested: number(row.qty_requested),
    qty_ordered: number(row.qty_ordered),
    remaining_quantity: amount(Math.max(number(row.qty_requested) - number(row.qty_ordered), 0)),
    source_key: `PUR-RQ:${row.requisition_id}/${row.requisition_item_id}`,
    next_stage: number(row.qty_requested) > number(row.qty_ordered) ? '採購建立／轉單' : row.requisition_status === 'closed' ? '流程稽核' : '請購結案',
  }));
}

function receiptSummaryRows(receipts, keys, periodKey = null) {
  const rows = receipts.map(row => ({
    ...row,
    period: periodKey ? String(row[periodKey] || '').slice(0, 7) : undefined,
    invoice_missing_count: row.invoice_status === 'missing' ? 1 : 0,
  }));
  const groupKeys = periodKey ? [...keys, 'period'] : keys;
  const groups = groupRows(rows, groupKeys, [
    'qty_received', 'qty_accepted', 'qty_rejected', 'qty_rejected_returned', 'qty_returned',
    'qty_priced', 'qty_paid', 'priced_amount', 'unpaid_amount', 'invoice_missing_count',
  ]);
  return groups.map(row => ({
    ...row,
    source_key: `PUR-G03:${groupKeys.map(key => row[key] || 'NA').join(':')}`,
    next_stage: number(row.unpaid_amount) > EPSILON ? '應付／付款' : number(row.qty_rejected) > number(row.qty_rejected_returned) ? '驗退件退回' : '採購流程稽核',
  }));
}

function g03Rows(report, receiptRows, orderRows, returnRows, rejectedReturnRows, requisitionRows) {
  switch (report) {
    case 'supplier_detail': return receiptRows;
    case 'supplier_summary': return receiptSummaryRows(receiptRows, ['supplier_code']);
    case 'supplier_statistics': return receiptSummaryRows(receiptRows, ['supplier_code'], 'receipt_date');
    case 'item_history_detail': return receiptRows;
    case 'item_history_summary': return receiptSummaryRows(receiptRows, ['item_code', 'item_name']);
    case 'rejected_open': return receiptRows.filter(row => number(row.remaining_rejected_quantity) > EPSILON).map(row => ({
      receipt_no: row.receipt_no, receipt_date: row.receipt_date, supplier_code: row.supplier_code,
      item_code: row.item_code, qty_rejected: row.qty_rejected, qty_rejected_returned: row.qty_rejected_returned,
      remaining_rejected_quantity: row.remaining_rejected_quantity, source_key: row.source_key, next_stage: '驗退件退回',
    }));
    case 'purchase_detail': return orderRows.map(row => ({ ...row, purchase_order_status: row.purchase_order_status }));
    case 'receipt_detail': return receiptRows;
    case 'rejected_return_detail': return rejectedReturnRows;
    case 'return_detail': return returnRows;
    case 'requisition_detail': return requisitionRows;
    case 'invoice_missing': return receiptRows.filter(row => row.invoice_status === 'missing' && number(row.qty_accepted) > EPSILON).map(row => ({
      receipt_no: row.receipt_no, receipt_date: row.receipt_date, supplier_code: row.supplier_code,
      purchase_order_no: row.purchase_order_no, item_code: row.item_code, qty_accepted: row.qty_accepted,
      qty_priced: row.qty_priced, priced_amount: row.priced_amount, invoice_status: row.invoice_status,
      receipt_status: row.receipt_status, source_key: row.source_key, next_stage: '發票補登／應付核對',
    }));
    default: return [];
  }
}

function reportSummary(rows) {
  return {
    row_count: rows.length,
    qty_ordered: sumRows(rows, 'qty_ordered'),
    qty_received: sumRows(rows, 'qty_received'),
    qty_accepted: sumRows(rows, 'qty_accepted'),
    qty_rejected: sumRows(rows, 'qty_rejected'),
    qty_returned: sumRows(rows, 'qty_returned'),
    qty_priced: sumRows(rows, 'qty_priced'),
    qty_paid: sumRows(rows, 'qty_paid'),
    remaining_quantity: sumRows(rows, 'remaining_quantity'),
    remaining_amount: sumRows(rows, 'remaining_amount'),
    priced_amount: sumRows(rows, 'priced_amount'),
    unpaid_amount: sumRows(rows, 'unpaid_amount'),
  };
}

async function fetchReconciliation(conn, context, filters) {
  const where = [...scope('o', context), "o.status NOT IN ('cancelled')"];
  const params = [...contextParams(context)];
  if (filters.dateFrom) { where.push('COALESCE(i.expected_date,o.expected_date,o.order_date)>=?'); params.push(filters.dateFrom); }
  if (filters.dateTo) { where.push('COALESCE(i.expected_date,o.expected_date,o.order_date)<=?'); params.push(filters.dateTo); }
  if (filters.supplierCode) { where.push('o.supplier_code=?'); params.push(filters.supplierCode); }
  if (filters.itemCode) { where.push('i.item_code=?'); params.push(filters.itemCode); }
  if (filters.warehouseCode) { where.push('i.warehouse_code=?'); params.push(filters.warehouseCode); }
  const [rows] = await conn.query(`
    SELECT o.id AS purchase_order_id,o.purchase_order_no,o.status AS purchase_order_status,o.supplier_code,
      o.order_date,o.expected_date AS order_expected_date,i.id AS purchase_order_item_id,i.line_no,
      i.item_code,i.item_name,i.warehouse_code,i.qty_ordered,i.qty_received,i.qty_cancelled,i.expected_date,
      COUNT(CASE WHEN r.id IS NOT NULL AND r.status<>'voided' THEN ri.id END) AS receipt_detail_count,
      COALESCE(SUM(CASE WHEN r.id IS NOT NULL AND r.status<>'voided'
        AND ri.inspection_status IN ('accepted','partially_accepted')
        THEN GREATEST(COALESCE(ri.qty_accepted,0)-COALESCE(ri.qty_returned,0),0) ELSE 0 END),0) AS recalculated_qty_received
    FROM procurement_orders o
    JOIN procurement_order_items i ON i.purchase_order_id=o.id
    LEFT JOIN procurement_receipt_items ri ON ri.purchase_order_item_id=i.id
    LEFT JOIN procurement_receipts r ON r.id=ri.receipt_id AND ${scope('r', context).join(' AND ')}
    WHERE ${where.join(' AND ')}
    GROUP BY o.id,o.purchase_order_no,o.status,o.supplier_code,o.order_date,o.expected_date,
      i.id,i.line_no,i.item_code,i.item_name,i.warehouse_code,i.qty_ordered,i.qty_received,i.qty_cancelled,i.expected_date
    ORDER BY ABS(COALESCE(SUM(CASE WHEN r.id IS NOT NULL AND r.status<>'voided'
      AND ri.inspection_status IN ('accepted','partially_accepted')
      THEN GREATEST(COALESCE(ri.qty_accepted,0)-COALESCE(ri.qty_returned,0),0) ELSE 0 END),0)-i.qty_received) DESC,
      o.id DESC,i.line_no ASC`, [...contextParams(context), ...params]);
  return rows.map(row => {
    const stored = number(row.qty_received);
    const recalculated = Math.max(number(row.recalculated_qty_received), 0);
    const expected = row.expected_date || row.order_expected_date || null;
    const remaining = Math.max(number(row.qty_ordered) - recalculated - number(row.qty_cancelled), 0);
    const difference = amount(recalculated - stored);
    const issues = [];
    if (Math.abs(difference) > EPSILON && number(row.receipt_detail_count) === 0 && stored > EPSILON) issues.push('歷史已交量缺少已關聯的目標進貨明細，需資料品質對照，不可直接清零');
    else if (Math.abs(difference) > EPSILON) issues.push('已交量與驗收合格量重算結果不一致');
    if (row.purchase_order_status === 'closed' && remaining > EPSILON) issues.push('已結案但仍有未交量');
    if (recalculated + number(row.qty_cancelled) > number(row.qty_ordered) + EPSILON) issues.push('驗收合格量超過採購量');
    if (expected && expected < today() && remaining > EPSILON) issues.push('預交日已逾期');
    return {
      ...row,
      order_date: row.order_date ? String(row.order_date).slice(0, 10) : null,
      expected_date: expected ? String(expected).slice(0, 10) : null,
      qty_ordered: number(row.qty_ordered), qty_received: stored, qty_cancelled: number(row.qty_cancelled), receipt_detail_count: number(row.receipt_detail_count),
      recalculated_qty_received: amount(recalculated), difference, remaining_quantity: amount(remaining),
      issue_count: issues.length, issue_reason: issues.join('；'),
      source_key: `PUR-G04:RECALC:${row.purchase_order_item_id}`,
    };
  });
}

function supplierRatings(orderLines, receiptRows) {
  const map = new Map();
  const get = supplier => {
    const key = text(supplier) || '未指定';
    if (!map.has(key)) map.set(key, {
      supplier_code: key, order_count: new Set(), line_count: 0, qty_ordered: 0, qty_received: 0,
      remaining_quantity: 0, remaining_amount: 0, overdue_line_count: 0, receipt_count: new Set(),
      accepted_quantity: 0, rejected_quantity: 0, rejected_returned_quantity: 0, on_time_receipt_count: 0,
      dated_receipt_count: 0,
    });
    return map.get(key);
  };
  for (const row of orderLines) {
    const item = get(row.supplier_code);
    item.order_count.add(String(row.purchase_order_id)); item.line_count += 1;
    item.qty_ordered += number(row.qty_ordered); item.qty_received += number(row.qty_received);
    item.remaining_quantity += number(row.remaining_quantity); item.remaining_amount += number(row.remaining_amount);
    if (row.expected_date && row.expected_date < today() && number(row.remaining_quantity) > EPSILON) item.overdue_line_count += 1;
  }
  for (const row of receiptRows) {
    const item = get(row.supplier_code);
    item.receipt_count.add(String(row.receipt_id)); item.accepted_quantity += number(row.qty_accepted);
    item.rejected_quantity += number(row.qty_rejected); item.rejected_returned_quantity += number(row.qty_rejected_returned);
    if (row.expected_date) {
      item.dated_receipt_count += 1;
      if (row.receipt_date <= row.expected_date) item.on_time_receipt_count += 1;
    }
  }
  return [...map.values()].map(row => {
    const qualityBase = row.accepted_quantity + row.rejected_quantity;
    return {
      supplier_code: row.supplier_code, order_count: row.order_count.size, line_count: row.line_count,
      receipt_count: row.receipt_count.size, qty_ordered: amount(row.qty_ordered), qty_received: amount(row.qty_received),
      remaining_quantity: amount(row.remaining_quantity), remaining_amount: amount(row.remaining_amount),
      overdue_line_count: row.overdue_line_count, accepted_quantity: amount(row.accepted_quantity),
      rejected_quantity: amount(row.rejected_quantity), rejected_returned_quantity: amount(row.rejected_returned_quantity),
      quality_rate: qualityBase > EPSILON ? amount(row.accepted_quantity / qualityBase * 100) : null,
      on_time_rate: row.dated_receipt_count ? amount(row.on_time_receipt_count / row.dated_receipt_count * 100) : null,
      source_key: `PUR-G04:RATING:${row.supplier_code}`, next_stage: row.remaining_quantity > EPSILON ? '催交／品質追蹤' : '採購結案／應付核對',
    };
  }).sort((a, b) => number(b.remaining_amount) - number(a.remaining_amount));
}

function maintenanceExceptions(reconciliation, receiptRows) {
  const rows = [];
  for (const row of reconciliation) if (row.issue_count) rows.push({
    category: '採購已交量／結案', document_no: row.purchase_order_no, item_code: row.item_code,
    reason: row.issue_reason, quantity: row.difference, amount: '', source_key: row.source_key, next_stage: '產生重算建議／受控更正',
  });
  for (const row of receiptRows) if (number(row.remaining_rejected_quantity) > EPSILON) rows.push({
    category: '驗退件未退', document_no: row.receipt_no, item_code: row.item_code,
    reason: `驗退 ${row.qty_rejected}，已退 ${row.qty_rejected_returned}，待退 ${row.remaining_rejected_quantity}`,
    quantity: row.remaining_rejected_quantity, amount: '', source_key: row.source_key, next_stage: '驗退件退回',
  });
  for (const row of receiptRows) if (row.receipt_status !== 'posted' && ['accepted', 'partially_accepted'].includes(row.inspection_status)) rows.push({
    category: '驗收後未入庫', document_no: row.receipt_no, item_code: row.item_code,
    reason: `驗收合格 ${row.qty_accepted}，庫存狀態 ${row.inventory_status || 'pending'}`,
    quantity: row.qty_accepted, amount: row.priced_amount, source_key: row.source_key, next_stage: '進貨確認／庫存過帳',
  });
  return rows.slice(0, 500);
}

function dataState(rows) {
  return rows.length ? 'sample_validated' : 'empty_validated';
}

function responseMeta(sourceDatabase, source, context, filters) {
  return {
    source_database: sourceDatabase,
    company_id: context.company_id,
    tenant_id: context.tenant_id,
    source_system: context.source_system,
    target_database: source?.target_database || null,
    filters: {
      date_from: filters.dateFrom, date_to: filters.dateTo,
      supplier_code: filters.supplierCode || null, item_code: filters.itemCode || null, warehouse_code: filters.warehouseCode || null,
    },
  };
}

export function registerProcurementReportRoutes(app, dependencies) {
  const { pool, tx, sourceDatabases, sourceDbFromRequest, ensureProcurementSchema, ensureTargetReceiptWorkflowSchema } = dependencies;
  const contextFor = sourceDatabase => {
    const source = sourceDatabases[sourceDatabase] || {};
    return {
      tenant_id: source.tenant_id || sourceDatabase,
      company_id: source.company_id || sourceDatabase,
      source_system: source.source_system || 'iSM',
      source_database: sourceDatabase,
    };
  };

  app.get('/api/procurement/g02/reports', async (req, res, next) => {
    try {
      await ensureProcurementSchema();
      await ensureTargetReceiptWorkflowSchema();
      const sourceDatabase = sourceDbFromRequest(req);
      const source = sourceDatabases[sourceDatabase];
      const context = contextFor(sourceDatabase);
      const filters = filtersFrom(req);
      const report = text(req.query.report) || 'progress';
      if (!Object.prototype.hasOwnProperty.call(G02_REPORTS, report)) throw error(400, `不支援的 PUR-G02 報表：${report}`);
      const meta = responseMeta(sourceDatabase, source, context, filters);
      if (report === 'manufacturing_expected') {
        return res.json({ ok: true, data: {
          ...meta, report, report_name: G02_REPORTS[report], columns: [], rows: [], total_count: 0,
          data_state: 'not_implemented', availability: 'not_implemented', summary: { row_count: 0 },
          source_tables: [], issues: ['目前範圍不含製造／MRP，既有目標資料結構沒有製令預計進貨來源，保留文件節點但不猜測資料。'],
        } });
      }
      const lines = await fetchOrderLines(pool, context, filters);
      const sourceLines = req.query.open_only === '1' ? lines.filter(row => number(row.remaining_quantity) > EPSILON) : lines;
      const rows = orderReportRows(sourceLines, report);
      return res.json({ ok: true, data: {
        ...meta, report, report_name: G02_REPORTS[report], columns: (REPORT_COLUMNS[report] || []).map(([key, label]) => ({ key, label })),
        rows: rows.slice(0, filters.limit), total_count: rows.length, data_state: dataState(rows), availability: 'implemented',
        summary: reportSummary(rows), source_tables: ['procurement_orders', 'procurement_order_items', 'procurement_receipts', 'procurement_receipt_items'],
        issues: [],
      } });
    } catch (err) { next(err); }
  });

  app.get('/api/procurement/g03/reports', async (req, res, next) => {
    try {
      await ensureProcurementSchema();
      await ensureTargetReceiptWorkflowSchema();
      const sourceDatabase = sourceDbFromRequest(req);
      const source = sourceDatabases[sourceDatabase];
      const context = contextFor(sourceDatabase);
      const filters = filtersFrom(req);
      const report = text(req.query.report) || 'supplier_detail';
      if (!Object.prototype.hasOwnProperty.call(G03_REPORTS, report)) throw error(400, `不支援的 PUR-G03 報表：${report}`);
      const [receiptRows, orderRows, returnRows, rejectedReturnRows, requisitionRows] = await Promise.all([
        fetchReceiptRows(pool, context, filters),
        fetchOrderLines(pool, context, filters),
        fetchReturnRows(pool, context, filters),
        fetchRejectedReturnRows(pool, context, filters),
        fetchRequisitionRows(pool, context, filters),
      ]);
      const rows = g03Rows(report, receiptRows, orderRows, returnRows, rejectedReturnRows, requisitionRows);
      const meta = responseMeta(sourceDatabase, source, context, filters);
      return res.json({ ok: true, data: {
        ...meta, report, report_name: G03_REPORTS[report], columns: (REPORT_COLUMNS[report] || []).map(([key, label]) => ({ key, label })),
        rows: rows.slice(0, filters.limit), total_count: rows.length, data_state: dataState(rows), availability: 'implemented',
        summary: reportSummary(rows), source_tables: ['procurement_receipts', 'procurement_receipt_items', 'procurement_returns', 'procurement_rejected_returns', 'procurement_orders', 'procurement_requisitions'],
        issues: [],
      } });
    } catch (err) { next(err); }
  });

  app.get('/api/procurement/g04/maintenance', async (req, res, next) => {
    try {
      await ensureProcurementSchema();
      await ensureTargetReceiptWorkflowSchema();
      const sourceDatabase = sourceDbFromRequest(req);
      const source = sourceDatabases[sourceDatabase];
      const context = contextFor(sourceDatabase);
      const filters = filtersFrom(req);
      const [reconciliation, orderLines, receiptRows] = await Promise.all([
        fetchReconciliation(pool, context, filters),
        fetchOrderLines(pool, context, filters),
        fetchReceiptRows(pool, context, filters),
      ]);
      const mismatches = reconciliation.filter(row => Math.abs(number(row.difference)) > EPSILON);
      const exceptions = maintenanceExceptions(reconciliation, receiptRows);
      return res.json({ ok: true, data: {
        ...responseMeta(sourceDatabase, source, context, filters),
        module: 'PUR-G04', module_name: '其他維護作業', data_state: dataState([...reconciliation, ...receiptRows]),
        availability: 'implemented_with_controlled_gaps',
        reconciliation: {
          rows: reconciliation.slice(0, filters.limit), total_count: reconciliation.length,
          mismatch_count: mismatches.length, closed_with_remaining_count: reconciliation.filter(row => row.purchase_order_status === 'closed' && number(row.remaining_quantity) > EPSILON).length,
          columns: [
            ['purchase_order_no', '採購單號'], ['item_code', '品號'], ['qty_ordered', '採購量'], ['qty_received', '現已交量'], ['receipt_detail_count', '已關聯進貨明細'],
            ['recalculated_qty_received', '重算已交量'], ['difference', '差異量'], ['remaining_quantity', '重算未交量'],
            ['purchase_order_status', '採購狀態'], ['issue_reason', '異常原因'], ['source_key', '來源鍵'],
          ].map(([key, label]) => ({ key, label })),
        },
        supplier_ratings: {
          rows: supplierRatings(orderLines, receiptRows).slice(0, filters.limit),
          columns: [
            ['supplier_code', '廠商代號'], ['order_count', '採購單數'], ['receipt_count', '進貨單數'],
            ['qty_ordered', '採購量'], ['qty_received', '已交量'], ['remaining_quantity', '未交量'],
            ['remaining_amount', '未交金額'], ['overdue_line_count', '逾期筆數'], ['quality_rate', '合格率％'],
            ['on_time_rate', '準時率％'], ['source_key', '來源鍵'], ['next_stage', '下一階段'],
          ].map(([key, label]) => ({ key, label })),
        },
        exceptions: {
          rows: exceptions, total_count: exceptions.length,
          columns: [['category', '異常類別'], ['document_no', '單號'], ['item_code', '品號'], ['reason', '異常原因'], ['quantity', '數量'], ['amount', '金額'], ['source_key', '來源鍵'], ['next_stage', '下一階段']].map(([key, label]) => ({ key, label })),
        },
        summary: {
          order_line_count: orderLines.length, receipt_line_count: receiptRows.length,
          reconciliation_count: reconciliation.length, mismatch_count: mismatches.length,
          exception_count: exceptions.length, remaining_quantity: sumRows(orderLines, 'remaining_quantity'), remaining_amount: sumRows(orderLines, 'remaining_amount'),
        },
        source_tables: ['procurement_orders', 'procurement_order_items', 'procurement_receipts', 'procurement_receipt_items'],
        issues: ['統計資料更新目前採即時計算，不另建快照表。採購單據清除依既有規則不提供直接刪除，改以受控沖回／封存與權限流程處理。'],
      } });
    } catch (err) { next(err); }
  });

  app.post('/api/procurement/g04/recalculate', async (req, res, next) => {
    try {
      await ensureProcurementSchema();
      await ensureTargetReceiptWorkflowSchema();
      const sourceDatabase = sourceDbFromRequest(req);
      const source = sourceDatabases[sourceDatabase];
      const context = contextFor(sourceDatabase);
      const fakeRequest = { query: { ...(req.body || {}), source_database: sourceDatabase } };
      const filters = filtersFrom(fakeRequest);
      const preview = await fetchReconciliation(pool, context, filters);
      const mismatches = preview.filter(row => Math.abs(number(row.difference)) > EPSILON);
      const apply = req.body?.apply === true || String(req.body?.apply).toLowerCase() === 'true';
      if (!apply) return res.json({ ok: true, data: {
        ...responseMeta(sourceDatabase, source, context, filters), module: 'PUR-G04', applied: false,
        reason: text(req.body?.reason) || '預覽模式', preview_count: mismatches.length, rows: mismatches,
        data_state: dataState(preview), issues: ['目前為預覽，未變更目標資料。若要套用，必須由具權限人員提供原因並再次送出 apply=true。'],
      } });
      const reason = text(req.body?.reason);
      if (!reason) throw error(400, '套用已交量重算必須填寫原因');
      const blocked = mismatches.filter(row => ['closed', 'cancelled'].includes(row.purchase_order_status));
      const eligible = mismatches.filter(row => !['closed', 'cancelled'].includes(row.purchase_order_status));
      const result = await tx(async conn => {
        let updatedCount = 0;
        for (const row of eligible) {
          const [updated] = await conn.query(`UPDATE procurement_order_items i
            JOIN procurement_orders o ON o.id=i.purchase_order_id
            SET i.qty_received=?
            WHERE i.id=? AND ${scope('o', context).join(' AND ')} AND o.status NOT IN ('closed','cancelled')`,
          [row.recalculated_qty_received, row.purchase_order_item_id, ...contextParams(context)]);
          updatedCount += Number(updated.affectedRows || 0);
        }
        const orderIds = [...new Set(eligible.map(row => Number(row.purchase_order_id)))];
        for (const orderId of orderIds) {
          const [[totals]] = await conn.query(`SELECT SUM(CASE WHEN i.qty_received+i.qty_cancelled>=i.qty_ordered THEN 1 ELSE 0 END) complete_lines,
              COUNT(*) line_count,MAX(i.qty_received) max_received
            FROM procurement_order_items i JOIN procurement_orders o ON o.id=i.purchase_order_id
            WHERE i.purchase_order_id=? AND ${scope('o', context).join(' AND ')}`,[orderId, ...contextParams(context)]);
          const nextStatus = number(totals.complete_lines) === number(totals.line_count) ? 'received' : number(totals.max_received) > EPSILON ? 'partial_received' : 'confirmed';
          await conn.query(`UPDATE procurement_orders o SET o.status=? WHERE o.id=? AND ${scope('o', context).join(' AND ')} AND o.status NOT IN ('closed','cancelled')`,[nextStatus, orderId, ...contextParams(context)]);
        }
        return { updatedCount };
      });
      return res.json({ ok: true, data: {
        ...responseMeta(sourceDatabase, source, context, filters), module: 'PUR-G04', applied: true, reason,
        preview_count: mismatches.length, updated_count: result.updatedCount, blocked_count: blocked.length,
        blocked, data_state: dataState(preview), issues: blocked.length ? ['已結案／已取消單據只列為異常，不自動改狀態；必須另走受控解結／沖回流程。'] : [],
      } });
    } catch (err) { next(err); }
  });
}
