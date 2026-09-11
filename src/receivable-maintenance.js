import { pool, sourceDatabases, tx, ensureTargetFinanceWorkflowSchema } from './db.js';
import { recordAccessAudit } from './auth.js';

// AR-G03：應收維護／月統計／月底前置檢核。
// 所有查詢都使用登入工作階段的固定公司上下文；這個模組不連線到 SH／SC 原始庫，
// 也不建立新的資料表。月統計採既有帳款、沖銷、銷退調整與 1101 總帳即時計算，
// 讓沒有額外快照表的既有公司也可以先得到可稽核的結果。

const EPS = 0.000001;
const MAX_MONTHS = 120;
const DEFAULT_LIMIT = 100;

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const badRequest = message => httpError(400, message);
const notFound = message => httpError(404, message);

function text(value) {
  return String(value ?? '').trim();
}

function dateText(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const valueText = text(value);
  return valueText ? valueText.slice(0, 10) : '';
}

function validDate(value, label = '日期') {
  const result = dateText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw badRequest(`${label}格式錯誤，必須為 YYYY-MM-DD`);
  const parsed = new Date(`${result}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) {
    throw badRequest(`${label}格式錯誤，必須為有效日期`);
  }
  return result;
}

function validPeriod(value, label = '會計期間') {
  const result = text(value);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(result)) throw badRequest(`${label}格式錯誤，必須為 YYYY-MM`);
  return result;
}

function numeric(value) {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function rounded(value) {
  return Number(numeric(value).toFixed(6));
}

function scope(alias, context) {
  return [
    `${alias}.tenant_id=?`, `${alias}.company_id=?`, `${alias}.source_system=?`, `${alias}.source_database=?`
  ];
}

function contextParams(context) {
  return [context.tenant_id, context.company_id, context.source_system, context.source_database];
}

function contextOf(req) {
  const key = text(req.erpContext?.source_database || req.query.source_database || req.body?.source_database).toUpperCase();
  if (!key) throw httpError(403, '目前登入帳號尚未設定公司別，無法執行應收作業');
  const source = sourceDatabases[key];
  if (!source) throw badRequest(`不允許的資料來源：${key}`);
  const requested = text(req.query.source_database || req.body?.source_database).toUpperCase();
  if (requested && requested !== key) throw httpError(409, `目前登入公司為 ${key}，不可改用 ${requested}`);
  const session = req.erpContext || {};
  const context = {
    tenant_id: session.tenant_id || source.tenant_id || key,
    company_id: session.company_id || source.company_id || key,
    source_system: session.source_system || source.source_system || source.adapter_code || 'iSM',
    source_database: key,
    target_database: session.target_database || source.target_database || 'inventory_erp'
  };
  if (session.company_id && String(session.company_id) !== String(context.company_id)) {
    throw httpError(409, '登入公司上下文不一致，已拒絕此作業');
  }
  return context;
}

function filtersOf(input = {}) {
  const to = validDate(input.to_date || input.as_of_date || new Date().toISOString().slice(0, 10), '日期迄日');
  const from = validDate(input.from_date || `${to.slice(0, 4)}-01-01`, '日期起日');
  const asOf = validDate(input.as_of_date || to, '截至日');
  if (from > to) throw badRequest('日期起日不可晚於日期迄日');
  const limitValue = Number(input.limit);
  const limit = Number.isInteger(limitValue) ? Math.min(Math.max(limitValue, 1), 500) : DEFAULT_LIMIT;
  return {
    from_date: from,
    to_date: to,
    as_of_date: asOf,
    party_code: text(input.party_code),
    currency_code: text(input.currency_code).toUpperCase(),
    limit
  };
}

function monthEnd(period) {
  const [year, month] = period.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function previousDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function monthCodes(from, to) {
  const start = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(`${to.slice(0, 7)}-01T00:00:00Z`);
  const codes = [];
  for (const current = start; current <= end; current.setUTCMonth(current.getUTCMonth() + 1)) {
    codes.push(`${current.getUTCFullYear()}-${String(current.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return codes;
}

function between(value, from, to) {
  return value >= from && value <= to;
}

function sumRows(rows, field) {
  return rows.reduce((sum, row) => sum + numeric(row[field]), 0);
}

function check(code, label, status, message, count = 0, amount = 0) {
  return { code, label, status, message, count: numeric(count), amount: rounded(amount) };
}

async function queryBaseRows(conn, context, filters) {
  const itemWhere = [
    ...scope('oi', context),
    "oi.account_type='AR'",
    "oi.status IN ('open','partial','settled')",
    'oi.document_date<=?'
  ];
  const itemParams = [...contextParams(context), filters.as_of_date];
  if (filters.party_code) { itemWhere.push('oi.party_code=?'); itemParams.push(filters.party_code); }
  if (filters.currency_code) { itemWhere.push('oi.currency_code=?'); itemParams.push(filters.currency_code); }
  const [items] = await conn.query(`
    SELECT oi.id,oi.document_no,DATE_FORMAT(oi.document_date,'%Y-%m-%d') document_date,
      DATE_FORMAT(oi.due_date,'%Y-%m-%d') due_date,oi.party_code,oi.currency_code,
      oi.source_kind,oi.source_document_id,oi.source_document_no,oi.original_amount,
      oi.settled_amount,oi.balance_amount,oi.adjustment_amount,oi.status,oi.note
    FROM finance_open_items oi
    WHERE ${itemWhere.join(' AND ')}
    ORDER BY oi.document_date,oi.id`, itemParams);

  const allocationWhere = [
    ...scope('oi', context), ...scope('s', context),
    "oi.account_type='AR'", "s.account_type='AR'", "s.status='posted'",
    's.settlement_date<=?'
  ];
  const allocationParams = [...contextParams(context), ...contextParams(context), filters.as_of_date];
  if (filters.party_code) { allocationWhere.push('oi.party_code=?'); allocationParams.push(filters.party_code); }
  if (filters.currency_code) { allocationWhere.push('oi.currency_code=?'); allocationParams.push(filters.currency_code); }
  const [settlements] = await conn.query(`
    SELECT a.open_item_id,DATE_FORMAT(s.settlement_date,'%Y-%m-%d') event_date,
      a.allocated_amount,s.settlement_no,s.id settlement_id
    FROM finance_allocations a
    JOIN finance_open_items oi ON oi.id=a.open_item_id
    JOIN finance_settlements s ON s.id=a.settlement_id
    WHERE ${allocationWhere.join(' AND ')}
    ORDER BY s.settlement_date,s.id,a.id`, allocationParams);

  const returnWhere = [
    ...scope('oi', context), ...scope('ra', context),
    "oi.account_type='AR'", "ra.status NOT IN ('voided','cancelled')",
    'ra.adjustment_date<=?'
  ];
  const returnParams = [...contextParams(context), ...contextParams(context), filters.as_of_date];
  if (filters.party_code) { returnWhere.push('oi.party_code=?'); returnParams.push(filters.party_code); }
  if (filters.currency_code) { returnWhere.push('oi.currency_code=?'); returnParams.push(filters.currency_code); }
  const [returnAllocations] = await conn.query(`
    SELECT raa.open_item_id,DATE_FORMAT(ra.adjustment_date,'%Y-%m-%d') event_date,
      raa.allocated_amount,ra.id adjustment_id,ra.sales_return_id,ra.status adjustment_status
    FROM finance_return_adjustment_allocations raa
    JOIN finance_return_adjustments ra ON ra.id=raa.adjustment_id
    JOIN finance_open_items oi ON oi.id=raa.open_item_id
    WHERE ${returnWhere.join(' AND ')}
    ORDER BY ra.adjustment_date,ra.id,raa.id`, returnParams);

  const [glEvents] = await conn.query(`
    SELECT DATE_FORMAT(j.journal_date,'%Y-%m-%d') event_date,
      COALESCE(SUM(l.debit_amount),0) debit_amount,
      COALESCE(SUM(l.credit_amount),0) credit_amount,
      COUNT(DISTINCT j.id) journal_count
    FROM accounting_journals j
    JOIN accounting_journal_lines l ON l.journal_id=j.id
    WHERE ${scope('j', context).join(' AND ')}
      AND j.status='posted' AND l.account_code='1101' AND j.journal_date<=?
    GROUP BY j.journal_date
    ORDER BY j.journal_date`, [...contextParams(context), filters.as_of_date]);

  return { items, settlements, returnAllocations, glEvents };
}

async function queryControlRows(conn, context, filters) {
  const params = [...contextParams(context), filters.as_of_date];
  const [[drafts]] = await conn.query(`
    SELECT COUNT(*) count,COALESCE(SUM(v.total_amount),0) amount
    FROM finance_vouchers v
    WHERE ${scope('v', context).join(' AND ')} AND v.account_type='AR'
      AND v.status IN ('draft','approved') AND v.voucher_date<=?`, params);

  const [[unallocatedSettlements]] = await conn.query(`
    SELECT COUNT(*) count,COALESCE(SUM(s.amount),0) amount
    FROM finance_settlements s
    WHERE ${scope('s', context).join(' AND ')} AND s.account_type='AR'
      AND s.status='posted' AND s.settlement_date<=?
      AND NOT EXISTS (SELECT 1 FROM finance_allocations a WHERE a.settlement_id=s.id)`, params);

  const [[orphans]] = await conn.query(`
    SELECT COUNT(*) count,COALESCE(SUM(oi.balance_amount),0) amount
    FROM finance_open_items oi
    LEFT JOIN finance_vouchers v
      ON v.id=oi.source_document_id AND v.account_type='AR'
      AND v.tenant_id=oi.tenant_id AND v.company_id=oi.company_id
      AND v.source_system=oi.source_system AND v.source_database=oi.source_database
    WHERE ${scope('oi', context).join(' AND ')} AND oi.account_type='AR'
      AND oi.source_kind='finance_voucher' AND oi.status IN ('open','partial','settled')
      AND (v.id IS NULL OR v.status='voided')`, contextParams(context));

  const [[pendingReturns]] = await conn.query(`
    SELECT COUNT(*) count,COALESCE(SUM(ra.return_amount),0) amount
    FROM finance_return_adjustments ra
    WHERE ${scope('ra', context).join(' AND ')}
      AND ra.status IN ('pending','approved') AND ra.adjustment_date<=?`, params);

  const periodCode = filters.as_of_date.slice(0, 7);
  const [[period]] = await conn.query(`
    SELECT period_code,start_date,end_date,status,closed_at,reopened_at
    FROM accounting_periods p
    WHERE ${scope('p', context).join(' AND ')} AND p.period_code=? LIMIT 1`, [...contextParams(context), periodCode]);
  const [[latestClosing]] = await conn.query(`
    SELECT id,period_code,close_date,status,reconciliation_status,line_count,total_debit,total_credit
    FROM accounting_month_closings m
    WHERE ${scope('m', context).join(' AND ')}
    ORDER BY period_code DESC,id DESC LIMIT 1`, contextParams(context));
  const [[account]] = await conn.query(`
    SELECT account_code,account_name
    FROM accounting_accounts
    WHERE tenant_id=? AND company_id=? AND source_system=? AND account_code='1101'
    LIMIT 1`, [context.tenant_id, context.company_id, context.source_system]);

  const creditWhere = [...scope('c', context), 'c.credit_date<=?'];
  const creditParams = [...contextParams(context), filters.as_of_date];
  if (filters.party_code) { creditWhere.push('c.party_code=?'); creditParams.push(filters.party_code); }
  if (filters.currency_code) { creditWhere.push('c.currency_code=?'); creditParams.push(filters.currency_code); }
  const [[credits]] = await conn.query(`
    SELECT COUNT(*) count,COALESCE(SUM(c.original_amount),0) original_amount,
      COALESCE(SUM(c.applied_amount),0) applied_amount,COALESCE(SUM(c.refunded_amount),0) refunded_amount,
      COALESCE(SUM(c.balance_amount),0) balance_amount
    FROM finance_customer_credits c
    WHERE ${creditWhere.join(' AND ')} AND c.status IN ('available','partial')`, creditParams);

  return { drafts, unallocatedSettlements, orphans, pendingReturns, period, latestClosing, account, credits };
}

function makeItemMaps(items, settlements, returnAllocations) {
  const settlementByItem = new Map();
  const returnByItem = new Map();
  const add = (map, key, value) => map.set(key, numeric(map.get(key)) + numeric(value));
  for (const row of settlements) add(settlementByItem, Number(row.open_item_id), row.allocated_amount);
  for (const row of returnAllocations) add(returnByItem, Number(row.open_item_id), row.allocated_amount);
  return { settlementByItem, returnByItem };
}

function makeGlBalance(glEvents, until = null) {
  return glEvents
    .filter(row => !until || dateText(row.event_date) <= until)
    .reduce((sum, row) => sum + numeric(row.debit_amount) - numeric(row.credit_amount), 0);
}

function buildMonthly(items, settlements, returnAllocations, glEvents, filters) {
  const effectiveTo = filters.to_date < filters.as_of_date ? filters.to_date : filters.as_of_date;
  if (effectiveTo < filters.from_date) return { rows: [], truncated: false, from: null, to: null };
  const allCodes = monthCodes(filters.from_date, effectiveTo);
  const selectedCodes = allCodes.length > MAX_MONTHS ? allCodes.slice(-MAX_MONTHS) : allCodes;
  const itemBalanceAt = until => {
    const itemAmount = items.filter(row => dateText(row.document_date) <= until).reduce((sum, row) => sum + numeric(row.original_amount), 0);
    const settled = settlements.filter(row => dateText(row.event_date) <= until).reduce((sum, row) => sum + numeric(row.allocated_amount), 0);
    const returns = returnAllocations.filter(row => dateText(row.event_date) <= until).reduce((sum, row) => sum + numeric(row.allocated_amount), 0);
    return itemAmount - settled - returns;
  };
  const rows = selectedCodes.map(period => {
    const start = `${period}-01`;
    const end = effectiveTo < monthEnd(period) ? effectiveTo : monthEnd(period);
    const periodItems = items.filter(row => between(dateText(row.document_date), start, end));
    const periodSettlements = settlements.filter(row => between(dateText(row.event_date), start, end));
    const periodReturns = returnAllocations.filter(row => between(dateText(row.event_date), start, end));
    const periodGl = glEvents.filter(row => between(dateText(row.event_date), start, end));
    const opening = itemBalanceAt(previousDate(start));
    const billed = sumRows(periodItems, 'original_amount');
    const settlementAmount = sumRows(periodSettlements, 'allocated_amount');
    const returnAmount = sumRows(periodReturns, 'allocated_amount');
    const ending = opening + billed - settlementAmount - returnAmount;
    const glDebit = sumRows(periodGl, 'debit_amount');
    const glCredit = sumRows(periodGl, 'credit_amount');
    const glBalance = makeGlBalance(glEvents, end);
    return {
      period_code: period,
      period_start: start,
      period_end: end,
      opening_balance: rounded(opening),
      billed_amount: rounded(billed),
      return_adjustment_amount: rounded(returnAmount),
      settlement_amount: rounded(settlementAmount),
      ending_balance: rounded(ending),
      gl_debit: rounded(glDebit),
      gl_credit: rounded(glCredit),
      gl_balance: rounded(glBalance),
      difference_amount: rounded(glBalance - ending),
      open_item_count: periodItems.length,
      settlement_count: periodSettlements.length,
      return_count: periodReturns.length,
      reconciliation_status: Math.abs(glBalance - ending) <= EPS ? 'balanced' : 'difference'
    };
  });
  return {
    rows,
    truncated: allCodes.length > selectedCodes.length,
    from: selectedCodes[0] || null,
    to: selectedCodes.at(-1) || null,
    requested_from: allCodes[0] || null,
    requested_to: allCodes.at(-1) || null
  };
}

async function buildOverview(conn, context, filters) {
  const base = await queryBaseRows(conn, context, filters);
  const controls = await queryControlRows(conn, context, filters);
  const { items, settlements, returnAllocations, glEvents } = base;
  const { settlementByItem, returnByItem } = makeItemMaps(items, settlements, returnAllocations);
  const details = items.map(row => {
    const settlementAmount = numeric(settlementByItem.get(Number(row.id)));
    const returnAmount = numeric(returnByItem.get(Number(row.id)));
    const expected = numeric(row.original_amount) - settlementAmount - returnAmount;
    const current = numeric(row.balance_amount);
    return {
      ...row,
      original_amount: rounded(row.original_amount),
      stored_settled_amount: rounded(row.settled_amount),
      stored_adjustment_amount: rounded(row.adjustment_amount),
      current_balance: rounded(current),
      settlement_amount: rounded(settlementAmount),
      return_adjustment_amount: rounded(returnAmount),
      expected_balance: rounded(expected),
      difference_amount: rounded(current - expected),
      formula_status: Math.abs(current - expected) <= EPS ? 'balanced' : 'difference',
      next_stage: Math.abs(expected) <= EPS ? '已結清／可查歷程' : '收款／沖銷或受控調整',
      source_key: `${row.source_kind || 'finance_open_item'}:${row.source_document_id || row.id}`
    };
  });
  const formulaRows = details.filter(row => Math.abs(row.difference_amount) > EPS);
  const periodItems = items.filter(row => between(dateText(row.document_date), filters.from_date, filters.to_date));
  const periodSettlements = settlements.filter(row => between(dateText(row.event_date), filters.from_date, filters.to_date));
  const periodReturns = returnAllocations.filter(row => between(dateText(row.event_date), filters.from_date, filters.to_date));
  const glInRange = glEvents.filter(row => between(dateText(row.event_date), filters.from_date, filters.to_date));
  const currentBalance = sumRows(details, 'current_balance');
  const reconstructedBalance = sumRows(details, 'expected_balance');
  const glBalance = makeGlBalance(glEvents, filters.as_of_date);
  const today = new Date().toISOString().slice(0, 10);
  const formulaComparable = filters.as_of_date >= today;
  const checks = [
    check('COMPANY_CONTEXT', '公司／來源固定', 'passed', `固定於 ${context.company_id}／${context.source_database}；未接受畫面自行指定的其他公司`, 0, 0),
    check('SOURCE_READ_ONLY', '原始資料唯讀', 'passed', '本次只讀取目標 ERP；未連線寫入 SH／SC 原始資料庫', 0, 0),
    check('AR_FORMULA', '應收子帳餘額公式', formulaComparable ? (formulaRows.length ? 'blocked' : 'passed') : 'info', formulaComparable ? (formulaRows.length ? `有 ${formulaRows.length} 筆目前餘額與原額－沖銷－銷退調整不一致` : '目前應收餘額可由原額－已過帳沖銷－銷退沖帳重算') : '截至日早於今天，資料表只保存目前餘額，歷史截至日先提供重算值，不將目前餘額誤判為當時餘額', formulaRows.length, sumRows(formulaRows, 'difference_amount')),
    check('GL_AR_RECONCILIATION', '1101 應收子帳／總帳核對', filters.party_code || filters.currency_code ? 'info' : (Math.abs(glBalance - reconstructedBalance) <= EPS ? 'passed' : 'warning'), filters.party_code || filters.currency_code ? '指定客戶／幣別時，子帳可依條件篩選；1101 總帳仍是目前公司的全體控制科目，請用未加維度條件的查詢比較' : (Math.abs(glBalance - reconstructedBalance) <= EPS ? '1101 總帳與應收子帳重算一致' : `1101 總帳與應收子帳重算差異 ${rounded(glBalance - reconstructedBalance)}`), 0, glBalance - reconstructedBalance),
    check('UNALLOCATED_SETTLEMENT', '已過帳收款未沖銷', numeric(controls.unallocatedSettlements?.count) ? 'blocked' : 'passed', numeric(controls.unallocatedSettlements?.count) ? '發現已過帳收款沒有沖銷明細' : '所有已過帳收款都有沖銷明細', controls.unallocatedSettlements?.count, controls.unallocatedSettlements?.amount),
    check('ORPHAN_OPEN_ITEM', '孤兒應收帳款', numeric(controls.orphans?.count) ? 'blocked' : 'passed', numeric(controls.orphans?.count) ? '發現應收立帳找不到有效來源憑單' : '應收立帳均可找到目前公司的來源憑單或合法來源', controls.orphans?.count, controls.orphans?.amount),
    check('DRAFT_VOUCHER', '未核准結帳憑單', numeric(controls.drafts?.count) ? 'warning' : 'passed', numeric(controls.drafts?.count) ? `仍有 ${controls.drafts.count} 張草稿／已核准但未完成承接的應收憑單` : '沒有未處理的應收草稿／待承接憑單', controls.drafts?.count, controls.drafts?.amount),
    check('PENDING_RETURN', '待處理銷退應收調整', numeric(controls.pendingReturns?.count) ? 'warning' : 'passed', numeric(controls.pendingReturns?.count) ? `仍有 ${controls.pendingReturns.count} 筆銷退應收調整待處理` : '沒有待處理銷退應收調整', controls.pendingReturns?.count, controls.pendingReturns?.amount),
    check('AR_CONTROL_ACCOUNT', '應收控制科目 1101', controls.account ? 'passed' : 'blocked', controls.account ? `目前公司已設定 ${controls.account.account_code} ${controls.account.account_name}` : '目前公司尚未設定應收控制科目 1101，無法完成總帳核對', controls.account ? 1 : 0, 0),
    check('ACCOUNTING_PERIOD', '截至日會計期間', controls.period ? 'passed' : 'warning', controls.period ? `${controls.periodCode || filters.as_of_date.slice(0, 7)} 期間狀態：${controls.period.status}` : `找不到 ${filters.as_of_date.slice(0, 7)} 會計期間；月結前需先建立期間`, controls.period ? 1 : 0, 0),
    check('MONTH_CLOSING_SNAPSHOT', '月底結轉快照', controls.latestClosing ? 'info' : 'warning', controls.latestClosing ? `最近月底快照為 ${controls.latestClosing.period_code}／${controls.latestClosing.status}` : '目前尚無月底快照；本頁月統計採既有資料即時計算，不自動建立快照', controls.latestClosing ? 1 : 0, 0)
  ];
  const monthly = buildMonthly(items, settlements, returnAllocations, glEvents, filters);
  const warnings = checks.filter(item => ['blocked', 'warning'].includes(item.status)).map(item => `${item.label}：${item.message}`);
  if (monthly.truncated) warnings.push(`日期範圍含 ${monthly.requested_from}～${monthly.requested_to}，月統計畫面為避免過量只顯示最後 ${MAX_MONTHS} 個月；摘要仍依完整範圍計算。`);

  return {
    source_database: context.source_database,
    company: { tenant_id: context.tenant_id, company_id: context.company_id, source_system: context.source_system, target_database: context.target_database },
    range: filters,
    calculation_mode: 'read_only_on_demand',
    gl_control_account: controls.account || { account_code: '1101', account_name: '應收帳款' },
    source_tables: [
      'finance_open_items', 'finance_vouchers', 'finance_voucher_sources', 'finance_settlements',
      'finance_allocations', 'finance_return_adjustments', 'finance_return_adjustment_allocations',
      'finance_customer_credits', 'accounting_journals', 'accounting_journal_lines',
      'accounting_periods', 'accounting_month_closings'
    ],
    summary: {
      open_item_count: items.length,
      original_amount: rounded(sumRows(items, 'original_amount')),
      settled_amount: rounded(sumRows(settlements, 'allocated_amount')),
      return_adjustment_amount: rounded(sumRows(returnAllocations, 'allocated_amount')),
      current_balance: rounded(currentBalance),
      reconstructed_balance: rounded(reconstructedBalance),
      formula_difference: rounded(currentBalance - reconstructedBalance),
      gl_ar_balance: rounded(glBalance),
      gl_difference: rounded(glBalance - reconstructedBalance),
      period_open_item_count: periodItems.length,
      period_billed_amount: rounded(sumRows(periodItems, 'original_amount')),
      period_settlement_amount: rounded(sumRows(periodSettlements, 'allocated_amount')),
      period_return_adjustment_amount: rounded(sumRows(periodReturns, 'allocated_amount')),
      period_gl_debit: rounded(sumRows(glInRange, 'debit_amount')),
      period_gl_credit: rounded(sumRows(glInRange, 'credit_amount')),
      customer_credit_balance: rounded(controls.credits?.balance_amount),
      draft_voucher_count: numeric(controls.drafts?.count),
      draft_voucher_amount: rounded(controls.drafts?.amount),
      exception_count: checks.filter(item => ['blocked', 'warning'].includes(item.status)).length,
      reconciliation_status: Math.abs(glBalance - reconstructedBalance) <= EPS ? 'balanced' : 'difference'
    },
    monthly: monthly.rows,
    monthly_scope: monthly,
    checks,
    warnings,
    rows: details.slice(0, filters.limit),
    row_count: details.length,
    control: {
      unallocated_settlement_count: numeric(controls.unallocatedSettlements?.count),
      orphan_open_item_count: numeric(controls.orphans?.count),
      pending_return_count: numeric(controls.pendingReturns?.count),
      accounting_period: controls.period || null,
      latest_month_closing: controls.latestClosing || null,
      customer_credits: controls.credits || { count: 0, balance_amount: 0 }
    }
  };
}

async function archiveEvaluation(conn, context, id, { lock = false } = {}) {
  const suffix = lock ? ' FOR UPDATE' : '';
  const [[voucher]] = await conn.query(`
    SELECT v.*
    FROM finance_vouchers v
    WHERE v.id=? AND ${scope('v', context).join(' AND ')} AND v.account_type='AR'${suffix}`,
    [id, ...contextParams(context)]);
  if (!voucher) throw notFound('找不到目前公司可受控封存的應收憑單');
  const [[openItem]] = await conn.query(`
    SELECT oi.*
    FROM finance_open_items oi
    WHERE ${scope('oi', context).join(' AND ')} AND oi.account_type='AR'
      AND oi.source_kind='finance_voucher' AND oi.source_document_id=?
    ORDER BY oi.id LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [...contextParams(context), id]);
  const [[settlementImpact]] = await conn.query(`
    SELECT COUNT(DISTINCT s.id) count,COALESCE(SUM(a.allocated_amount),0) amount
    FROM finance_allocations a JOIN finance_settlements s ON s.id=a.settlement_id
    WHERE a.open_item_id=? AND s.status<>'voided'`, [openItem?.id || 0]);
  const [[returnImpact]] = await conn.query(`
    SELECT COUNT(DISTINCT ra.id) count,COALESCE(SUM(raa.allocated_amount),0) amount
    FROM finance_return_adjustment_allocations raa
    JOIN finance_return_adjustments ra ON ra.id=raa.adjustment_id
    WHERE raa.open_item_id=? AND ${scope('ra', context).join(' AND ')}
      AND ra.status NOT IN ('voided','cancelled')`, [openItem?.id || 0, ...contextParams(context)]);
  const [[journalImpact]] = await conn.query(`
    SELECT COUNT(*) count
    FROM accounting_journals j
    WHERE ${scope('j', context).join(' AND ')} AND j.status<>'voided'
      AND ((j.source_kind IN ('finance_ar','finance_voucher','finance_open_item') AND j.source_id IN (?,?))
        OR (j.source_kind IN ('finance_ar','finance_voucher','finance_open_item') AND j.source_document_no=?))`,
    [...contextParams(context), id, openItem?.id || 0, voucher.voucher_no]);
  const [[sourceLinks]] = await conn.query('SELECT COUNT(*) count,COALESCE(SUM(allocated_amount),0) amount FROM finance_voucher_sources WHERE voucher_id=?', [id]);
  const periodCode = dateText(voucher.voucher_date).slice(0, 7);
  const [[period]] = await conn.query(`
    SELECT period_code,start_date,end_date,status
    FROM accounting_periods p
    WHERE ${scope('p', context).join(' AND ')} AND p.period_code=? LIMIT 1`, [...contextParams(context), periodCode]);
  const hasInvoice = Boolean(text(voucher.invoice_no)) || ['issued', 'received', 'voided'].includes(String(voucher.invoice_status || ''));
  const openItemClean = !openItem || (
    openItem.status === 'open' &&
    Math.abs(numeric(openItem.balance_amount) - numeric(openItem.original_amount)) <= EPS &&
    Math.abs(numeric(openItem.adjustment_amount)) <= EPS
  );
  const checks = [
    check('COMPANY_CONTEXT', '公司／來源範圍', 'passed', `憑單屬於 ${context.company_id}／${context.source_database}`),
    check('ARCHIVE_STATUS', '憑單狀態', ['draft', 'approved'].includes(String(voucher.status)) ? 'passed' : 'blocked', ['draft', 'approved'].includes(String(voucher.status)) ? '草稿或已核准未結清憑單可進入受控封存檢核' : '已過帳／已作廢憑單不可用封存替代，請走沖回／重作流程'),
    check('OPEN_ITEM', '應收立帳狀態', openItemClean ? 'passed' : 'blocked', openItem ? (openItemClean ? '尚未沖銷且餘額與原額一致' : '已有沖銷、銷退調整或帳款狀態不是可受控封存') : '尚未建立應收立帳，可封存草稿憑單'),
    check('SETTLEMENT_IMPACT', '收款／沖銷關聯', numeric(settlementImpact?.count) ? 'blocked' : 'passed', numeric(settlementImpact?.count) ? '已有收款／沖銷關聯，不可封存' : '沒有收款／沖銷關聯', settlementImpact?.count, settlementImpact?.amount),
    check('RETURN_ADJUSTMENT', '銷退應收調整', numeric(returnImpact?.count) ? 'blocked' : 'passed', numeric(returnImpact?.count) ? '已有銷退應收沖帳關聯，不可封存' : '沒有銷退應收沖帳關聯', returnImpact?.count, returnImpact?.amount),
    check('POSTED_JOURNAL', '正式傳票', numeric(journalImpact?.count) ? 'blocked' : 'passed', numeric(journalImpact?.count) ? '已有正式傳票關聯，必須走沖回／重作' : '尚無正式傳票關聯', journalImpact?.count),
    check('INVOICE', '發票資料', hasInvoice ? 'blocked' : 'passed', hasInvoice ? '已有發票資料或發票事件，請走發票作廢／重開與受控更正' : '尚未登錄發票'),
    check('ACCOUNTING_PERIOD', '憑單日期期間', period?.status === 'open' ? 'passed' : 'blocked', period ? (period.status === 'open' ? `憑單日期所在期間 ${periodCode} 開放` : `憑單日期所在期間 ${periodCode} 已關帳`) : `找不到憑單日期所在期間 ${periodCode}，禁止受控封存`),
    check('SOURCE_LINKS', '來源明細保留', 'info', `保留 ${numeric(sourceLinks?.count)} 筆來源明細，不執行刪除` , sourceLinks?.count, sourceLinks?.amount)
  ];
  const canArchive = checks.every(item => !['blocked'].includes(item.status));
  return { voucher, openItem: openItem || null, sourceLinks, period, checks, can_archive: canArchive };
}

async function archiveCandidates(conn, context, limit) {
  const [rows] = await conn.query(`
    SELECT v.id,v.document_type,v.voucher_no,DATE_FORMAT(v.voucher_date,'%Y-%m-%d') voucher_date,
      v.due_date,v.party_code,v.currency_code,v.total_amount,v.status,v.invoice_status,v.invoice_no,
      (SELECT oi.id FROM finance_open_items oi WHERE ${scope('oi', context).join(' AND ')}
        AND oi.account_type='AR' AND oi.source_kind='finance_voucher' AND oi.source_document_id=v.id ORDER BY oi.id LIMIT 1) open_item_id,
      (SELECT oi.status FROM finance_open_items oi WHERE ${scope('oi', context).join(' AND ')}
        AND oi.account_type='AR' AND oi.source_kind='finance_voucher' AND oi.source_document_id=v.id ORDER BY oi.id LIMIT 1) open_item_status,
      (SELECT COUNT(*) FROM finance_voucher_sources vs WHERE vs.voucher_id=v.id) source_count
    FROM finance_vouchers v
    WHERE ${scope('v', context).join(' AND ')} AND v.account_type='AR' AND v.status IN ('draft','approved')
    ORDER BY v.voucher_date DESC,v.id DESC LIMIT ?`, [
      ...contextParams(context), ...contextParams(context), ...contextParams(context), limit
    ]);
  return rows;
}

export function registerReceivableMaintenanceRoutes(app) {
  app.get('/api/finance-workflow/ar-g03/overview', async (req, res, next) => {
    try {
      await ensureTargetFinanceWorkflowSchema();
      const context = contextOf(req);
      const filters = filtersOf(req.query);
      const data = await buildOverview(pool, context, filters);
      res.json({ ok: true, data });
    } catch (error) { next(error); }
  });

  app.post('/api/finance-workflow/ar-g03/recalculate', async (req, res, next) => {
    try {
      await ensureTargetFinanceWorkflowSchema();
      const context = contextOf(req);
      const filters = filtersOf(req.body || {});
      const data = await buildOverview(pool, context, filters);
      res.json({ ok: true, data: { operation: 'recalculate_preview', ...data } });
    } catch (error) { next(error); }
  });

  app.get('/api/finance-workflow/ar-g03/month-close-check', async (req, res, next) => {
    try {
      await ensureTargetFinanceWorkflowSchema();
      const context = contextOf(req);
      const periodCode = validPeriod(req.query.period_code || text(req.query.as_of_date).slice(0, 7) || new Date().toISOString().slice(0, 7));
      const closeDate = validDate(req.query.close_date || monthEnd(periodCode), '結轉日期');
      if (closeDate.slice(0, 7) !== periodCode) throw badRequest('結轉日期必須落在指定會計期間內');
      const filters = filtersOf({ from_date: `${periodCode}-01`, to_date: closeDate, as_of_date: closeDate, limit: 500 });
      const data = await buildOverview(pool, context, filters);
      const [[period]] = await pool.query(`SELECT period_code,start_date,end_date,status,closed_at,reopened_at FROM accounting_periods p WHERE ${scope('p', context).join(' AND ')} AND p.period_code=? LIMIT 1`, [...contextParams(context), periodCode]);
      const monthChecks = [
        check('PERIOD_EXISTS', '會計期間存在', period ? 'passed' : 'blocked', period ? `${periodCode} 已建立` : `${periodCode} 尚未建立`),
        check('PERIOD_CLOSED', '期間已關帳', period?.status === 'closed' ? 'passed' : 'blocked', period?.status === 'closed' ? `${periodCode} 已關帳，可建立既有月底快照` : `${periodCode} 尚未關帳；先完成期間檢核與關帳`),
        check('AR_FORMULA', '應收重算', data.checks.find(item => item.code === 'AR_FORMULA')?.status === 'passed' ? 'passed' : 'blocked', data.checks.find(item => item.code === 'AR_FORMULA')?.message || '應收子帳公式尚未通過'),
        check('GL_AR_RECONCILIATION', '子帳／1101 總帳', Math.abs(numeric(data.summary.gl_difference)) <= EPS ? 'passed' : 'blocked', Math.abs(numeric(data.summary.gl_difference)) <= EPS ? '1101 與應收子帳重算一致' : `1101 與應收子帳差異 ${data.summary.gl_difference}`),
        check('NO_UNALLOCATED_SETTLEMENT', '收款沖銷完整', data.control.unallocated_settlement_count ? 'blocked' : 'passed', data.control.unallocated_settlement_count ? `有 ${data.control.unallocated_settlement_count} 筆已過帳收款未沖銷` : '已過帳收款均有沖銷明細'),
        check('NO_DRAFT_VOUCHER', '未處理憑單', data.summary.draft_voucher_count ? 'blocked' : 'passed', data.summary.draft_voucher_count ? `仍有 ${data.summary.draft_voucher_count} 張應收憑單待處理` : '沒有待處理應收憑單')
      ];
      const blocking = monthChecks.filter(item => item.status === 'blocked');
      res.json({ ok: true, data: {
        source_database: context.source_database,
        company: data.company,
        period_code: periodCode,
        close_date: closeDate,
        snapshot_mode: '沿用 accounting_month_closings；AR 月統計採既有帳款／沖銷／銷退與 1101 即時計算，不新增 AR 快照表',
        can_build_existing_snapshot: blocking.length === 0,
        checks: monthChecks,
        blocking_checks: blocking.map(item => item.code),
        overview: data
      } });
    } catch (error) { next(error); }
  });

  app.get('/api/finance-workflow/ar-g03/archive-candidates', async (req, res, next) => {
    try {
      await ensureTargetFinanceWorkflowSchema();
      const context = contextOf(req);
      const limitValue = Number(req.query.limit);
      const limit = Number.isInteger(limitValue) ? Math.min(Math.max(limitValue, 1), 100) : 50;
      const rows = await archiveCandidates(pool, context, limit);
      res.json({ ok: true, data: { source_database: context.source_database, company_id: context.company_id, rows } });
    } catch (error) { next(error); }
  });

  app.get('/api/finance-workflow/ar-g03/vouchers/:id/archive-check', async (req, res, next) => {
    try {
      await ensureTargetFinanceWorkflowSchema();
      const context = contextOf(req);
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) throw badRequest('應收憑單代號不正確');
      const data = await archiveEvaluation(pool, context, id);
      res.json({ ok: true, data: { ...data, voucher: { id: data.voucher.id, voucher_no: data.voucher.voucher_no, status: data.voucher.status, voucher_date: dateText(data.voucher.voucher_date), invoice_status: data.voucher.invoice_status, invoice_no: data.voucher.invoice_no } } });
    } catch (error) { next(error); }
  });

  app.post('/api/finance-workflow/ar-g03/vouchers/:id/archive', async (req, res, next) => {
    try {
      await ensureTargetFinanceWorkflowSchema();
      const context = contextOf(req);
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) throw badRequest('應收憑單代號不正確');
      const reason = text(req.body?.reason);
      if (!reason) throw badRequest('受控封存必須輸入原因');
      const archiveDate = validDate(req.body?.archive_date || new Date().toISOString().slice(0, 10), '封存日期');
      const result = await tx(async conn => {
        const evaluation = await archiveEvaluation(conn, context, id, { lock: true });
        if (!evaluation.can_archive) throw badRequest(`此憑單不可受控封存：${evaluation.checks.filter(item => item.status === 'blocked').map(item => item.label).join('、')}`);
        const beforeVoucher = { ...evaluation.voucher };
        const note = `${evaluation.voucher.note ? `${evaluation.voucher.note}\n` : ''}[AR-G03 受控封存 ${archiveDate}] ${reason}`.slice(0, 500);
        await conn.query("UPDATE finance_vouchers SET status='voided',note=? WHERE id=?", [note, id]);
        if (evaluation.openItem) {
          await conn.query("UPDATE finance_open_items SET status='voided',note=? WHERE id=?", [note, evaluation.openItem.id]);
        }
        const [[afterVoucher]] = await conn.query('SELECT * FROM finance_vouchers WHERE id=?', [id]);
        return { id, voucher_no: evaluation.voucher.voucher_no, status: 'voided', before: beforeVoucher, after: afterVoucher, open_item_id: evaluation.openItem?.id || null };
      });
      await recordAccessAudit({
        actorUserId: req.auth?.id, targetUserId: req.auth?.id, actionCode: 'AR_G03_ARCHIVE',
        entityType: 'finance_voucher', entityId: result.id, sourceKey: context.source_database,
        before: result.before, after: result.after, reason, ipAddress: req.ip, userAgent: req.get('user-agent')
      });
      res.json({ ok: true, data: { id: result.id, voucher_no: result.voucher_no, status: result.status, open_item_id: result.open_item_id, message: '已受控封存目標 ERP 憑單；原單、來源明細與稽核歷程均保留' } });
    } catch (error) { next(error); }
  });
}
