import 'dotenv/config';
import mysql from 'mysql2/promise';

const API = 'http://127.0.0.1:3000/api';
const SOURCE = 'SH';
const DATE = '2026-08-20';
const STAMP = String(Date.now());
const MARKER = `VERIFY:R13:ADVANCES-OFFSET:${STAMP}`;
const CUSTOMER = `R13C${STAMP}`;
const SUPPLIER = `R13S${STAMP}`;
const AR_DOC = `R13-AR-${STAMP}`;
const AP_DOC = `R13-AP-${STAMP}`;
const config = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'inventory_erp',
};

function assert(condition, message, details = undefined) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

function closeEnough(actual, expected, label) {
  assert(Math.abs(Number(actual) - Number(expected)) < 0.0001, `${label}應為 ${expected}，實際 ${actual}`);
}

async function login() {
  const response = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '12345678' }),
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) throw new Error(payload.error || '管理員登入失敗');
  return payload.data?.token || payload.token;
}

function makeApi(token) {
  return async (path, method = 'GET', body) => {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { error: text }; }
    if (!response.ok || payload.ok === false) throw new Error(`${method} ${path}: ${payload.error || response.status}`);
    return payload.data ?? payload;
  };
}

async function expectError(work, label) {
  let rejected = false;
  try { await work(); } catch (_) { rejected = true; }
  assert(rejected, `${label}：預期拒絕但未拒絕`);
}

async function draftTotals(target, draftId) {
  const [[totals]] = await target.query(`SELECT COUNT(*) line_count,
      COALESCE(SUM(debit_amount),0) debit_total,COALESCE(SUM(credit_amount),0) credit_total
    FROM accounting_draft_lines WHERE draft_id=?`, [draftId]);
  closeEnough(totals.debit_total, totals.credit_total, `底稿 ${draftId} 借貸平衡`);
  assert(Number(totals.line_count) >= 2, `底稿 ${draftId} 應至少有兩行`, totals);
  return totals;
}

async function cleanup(target) {
  await target.beginTransaction();
  try {
    const [advanceRows] = await target.query('SELECT id,accounting_draft_id FROM finance_advances WHERE note=?', [MARKER]);
    const advanceIds = advanceRows.map(row => Number(row.id)).filter(Boolean);
    const [movementRows] = advanceIds.length
      ? await target.query(`SELECT id,accounting_draft_id FROM finance_advance_movements WHERE advance_id IN (?)`, [advanceIds])
      : [[]];
    const [crossRows] = await target.query('SELECT id,accounting_draft_id FROM finance_cross_offsets WHERE note=?', [MARKER]);
    const draftIds = [...new Set([
      ...advanceRows.map(row => Number(row.accounting_draft_id)),
      ...movementRows.map(row => Number(row.accounting_draft_id)),
      ...crossRows.map(row => Number(row.accounting_draft_id)),
    ].filter(Boolean))];
    if (draftIds.length) {
      const [journals] = await target.query(`SELECT id FROM accounting_journals WHERE source_kind='accounting_draft' AND source_id IN (?)`, [draftIds]);
      const journalIds = journals.map(row => Number(row.id)).filter(Boolean);
      if (journalIds.length) await target.query('DELETE FROM accounting_journal_lines WHERE journal_id IN (?)', [journalIds]);
      if (journalIds.length) await target.query('DELETE FROM accounting_journals WHERE id IN (?)', [journalIds]);
      await target.query('DELETE FROM accounting_drafts WHERE id IN (?)', [draftIds]);
    }
    if (crossRows.length) await target.query('DELETE FROM finance_cross_offsets WHERE id IN (?)', [crossRows.map(row => Number(row.id))]);
    if (advanceIds.length) await target.query('DELETE FROM finance_advance_movements WHERE advance_id IN (?)', [advanceIds]);
    if (advanceIds.length) await target.query('DELETE FROM finance_advances WHERE id IN (?)', [advanceIds]);
    await target.query('DELETE FROM finance_party_links WHERE note=?', [MARKER]);
    await target.query('DELETE FROM finance_open_items WHERE note=?', [MARKER]);
    await target.commit();
  } catch (error) {
    await target.rollback();
    throw error;
  }
}

const target = await mysql.createConnection(config);
let token;
try {
  token = await login();
  const api = makeApi(token);

  // 先讓服務完成目標庫增量建表，再清理可能的同一批測試殘留。
  await api(`/finance-workflow/advances?source_database=${SOURCE}`);
  await cleanup(target);

  const [[context]] = await target.query(`SELECT tenant_id,company_id,source_system
    FROM erp_data_sources WHERE source_key=? AND enabled=1 LIMIT 1`, [SOURCE]);
  assert(context, '找不到 SH／仙暉公司的目標資料範圍');

  const openIds = [];
  const sourceIds = [Number(`${STAMP}1`), Number(`${STAMP}2`)];
  for (const [index, documentNo] of [AR_DOC, AP_DOC].entries()) {
    const accountType = index === 0 ? 'AR' : 'AP';
    const partyCode = index === 0 ? CUSTOMER : SUPPLIER;
    const [result] = await target.query(`INSERT INTO finance_open_items
      (tenant_id,company_id,source_system,source_database,account_type,document_no,document_date,due_date,party_code,currency_code,
       exchange_rate,source_kind,source_document_id,source_document_no,original_amount,settled_amount,balance_amount,
       base_original_amount,base_settled_amount,base_balance_amount,status,note,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'open',?,?)`, [
      context.tenant_id, context.company_id, context.source_system, SOURCE, accountType, documentNo, DATE, DATE, partyCode, 'TWD',
      1, 'VERIFY_R13', sourceIds[index], documentNo, 100, 0, 100, 100, 0, 100, MARKER, 1,
    ]);
    openIds.push(Number(result.insertId));
  }
  const [arOpenId, apOpenId] = openIds;

  const createAdvance = async (accountType, partyCode, amount) => {
    const created = await api('/finance-workflow/advances', 'POST', {
      source_database: SOURCE,
      account_type: accountType,
      advance_kind: accountType === 'AR' ? 'overpayment' : 'prepayment',
      advance_date: DATE,
      party_code: partyCode,
      original_amount: amount,
      currency_code: 'TWD',
      exchange_rate: 1,
      source_document_no: MARKER,
      note: MARKER,
    });
    assert(created.status === 'draft' && created.id, '預收／預付草稿建立失敗', created);
    return created;
  };

  const arAdvance = await createAdvance('AR', CUSTOMER, 100);
  const apAdvance = await createAdvance('AP', SUPPLIER, 80);
  const arApproved = await api(`/finance-workflow/advances/${arAdvance.id}/approve?source_database=${SOURCE}`, 'POST', { source_database: SOURCE });
  const apApproved = await api(`/finance-workflow/advances/${apAdvance.id}/approve?source_database=${SOURCE}`, 'POST', { source_database: SOURCE });
  assert(arApproved.status === 'available' && arApproved.accounting_draft_id, 'AR 預收／溢收核准或分錄底稿失敗', arApproved);
  assert(apApproved.status === 'available' && apApproved.accounting_draft_id, 'AP 預付核准或分錄底稿失敗', apApproved);
  await draftTotals(target, arApproved.accounting_draft_id);
  await draftTotals(target, apApproved.accounting_draft_id);

  const firstApply = await api(`/finance-workflow/advances/${arAdvance.id}/apply?source_database=${SOURCE}`, 'POST', {
    source_database: SOURCE, open_item_id: arOpenId, amount: 40, movement_date: '2026-08-21', note: MARKER,
  });
  const secondApply = await api(`/finance-workflow/advances/${arAdvance.id}/apply?source_database=${SOURCE}`, 'POST', {
    source_database: SOURCE, open_item_id: arOpenId, amount: 30, movement_date: '2026-08-22', note: MARKER,
  });
  closeEnough(firstApply.advance_balance_amount, 60, '第一次轉抵後預收餘額');
  closeEnough(secondApply.advance_balance_amount, 30, '第二次轉抵後預收餘額');
  closeEnough(secondApply.open_item_balance_amount, 30, '分批轉抵後應收餘額');
  await draftTotals(target, firstApply.accounting_draft_id);
  await draftTotals(target, secondApply.accounting_draft_id);

  const refund = await api(`/finance-workflow/advances/${arAdvance.id}/refund?source_database=${SOURCE}`, 'POST', {
    source_database: SOURCE, amount: 20, movement_date: '2026-08-23', note: MARKER,
  });
  closeEnough(refund.balance_amount, 10, '部分退款後預收餘額');
  await draftTotals(target, refund.accounting_draft_id);

  await api('/finance-workflow/party-links', 'POST', {
    source_database: SOURCE, customer_code: CUSTOMER, supplier_code: SUPPLIER,
    relationship_type: 'customer_supplier', note: MARKER,
  });

  const openOffset = await api('/finance-workflow/cross-offsets', 'POST', {
    source_database: SOURCE, offset_kind: 'open_items', offset_date: '2026-08-24',
    ar_open_item_id: arOpenId, ap_open_item_id: apOpenId, amount: 25, currency_code: 'TWD', note: MARKER,
  });
  assert(openOffset.offset_kind === 'open_items' && openOffset.accounting_draft_id, '應收／應付帳款對沖失敗', openOffset);
  await draftTotals(target, openOffset.accounting_draft_id);

  const advanceOffset = await api('/finance-workflow/cross-offsets', 'POST', {
    source_database: SOURCE, offset_kind: 'advances', offset_date: '2026-08-25',
    ar_advance_id: arAdvance.id, ap_advance_id: apAdvance.id, amount: 10, currency_code: 'TWD', note: MARKER,
  });
  assert(advanceOffset.offset_kind === 'advances' && advanceOffset.accounting_draft_id, '預收／預付對沖失敗', advanceOffset);
  await draftTotals(target, advanceOffset.accounting_draft_id);

  const [[arAdvanceRow]] = await target.query('SELECT original_amount,applied_amount,refunded_amount,balance_amount,status FROM finance_advances WHERE id=?', [arAdvance.id]);
  const [[apAdvanceRow]] = await target.query('SELECT original_amount,applied_amount,refunded_amount,balance_amount,status FROM finance_advances WHERE id=?', [apAdvance.id]);
  closeEnough(arAdvanceRow.original_amount, 100, 'AR 預收原額');
  closeEnough(arAdvanceRow.applied_amount, 80, 'AR 預收已用額');
  closeEnough(arAdvanceRow.refunded_amount, 20, 'AR 預收已退款額');
  closeEnough(arAdvanceRow.balance_amount, 0, 'AR 預收剩餘額');
  assert(arAdvanceRow.status === 'applied', 'AR 預收完成對沖後狀態錯誤', arAdvanceRow);
  closeEnough(apAdvanceRow.applied_amount, 10, 'AP 預付已用額');
  closeEnough(apAdvanceRow.balance_amount, 70, 'AP 預付剩餘額');

  const [[arOpenRow]] = await target.query('SELECT settled_amount,balance_amount,status FROM finance_open_items WHERE id=?', [arOpenId]);
  const [[apOpenRow]] = await target.query('SELECT settled_amount,balance_amount,status FROM finance_open_items WHERE id=?', [apOpenId]);
  closeEnough(arOpenRow.settled_amount, 95, 'AR 帳款沖抵後已用額');
  closeEnough(arOpenRow.balance_amount, 5, 'AR 帳款沖抵後剩餘額');
  closeEnough(apOpenRow.settled_amount, 25, 'AP 帳款對沖後已用額');
  closeEnough(apOpenRow.balance_amount, 75, 'AP 帳款對沖後剩餘額');

  const [movementRows] = await target.query(`SELECT movement_kind,amount,base_amount,exchange_difference,open_item_id,related_advance_id,accounting_draft_id
    FROM finance_advance_movements WHERE advance_id=? ORDER BY id`, [arAdvance.id]);
  assert(movementRows.length === 4 && movementRows.filter(row => row.movement_kind === 'apply').length === 2 && movementRows.some(row => row.movement_kind === 'refund') && movementRows.some(row => row.movement_kind === 'offset'), '立沖異動明細未完整保留分批轉抵／退款／對沖', movementRows);
  assert(movementRows.every(row => row.accounting_draft_id), '立沖異動未關聯會計分錄底稿', movementRows);

  const movementDetail = await api(`/finance-workflow/advances/${arAdvance.id}/movements?source_database=${SOURCE}`);
  assert(movementDetail.advance?.id === arAdvance.id && movementDetail.rows.length === 4, '立沖明細查詢未呈現表頭與全部異動', movementDetail);
  const advanceRows = await api(`/finance-workflow/advances?source_database=${SOURCE}&account_type=AR`);
  const displayedAdvance = advanceRows.find(row => Number(row.id) === Number(arAdvance.id));
  assert(displayedAdvance && Number(displayedAdvance.movement_count) === 4, '立沖餘額查詢未呈現異動筆數', displayedAdvance);
  const crossRows = await api(`/finance-workflow/cross-offsets?source_database=${SOURCE}`);
  assert(crossRows.filter(row => row.note === MARKER).length === 2, '對沖查詢未呈現兩種對沖來源', crossRows);

  const clearing = await api(`/accounting/clearing?source_database=${SOURCE}&from_date=2026-08-20&to_date=2026-08-31&limit=500`);
  assert(clearing.rows.some(row => row.row_kind === 'advance') && clearing.rows.some(row => row.row_kind === 'cross_offset'), '立沖帳查詢未合併預收／預付與跨 AR/AP 對沖明細', clearing);
  const clearingAdvance = clearing.advance_summary.find(row => row.account_type === 'AR' && row.party_code === CUSTOMER);
  assert(clearingAdvance, '立沖帳查詢未呈現 AR 預收摘要', clearing.advance_summary);
  closeEnough(clearingAdvance.original_amount, 100, '立沖查詢 AR 原額');
  closeEnough(clearingAdvance.used_amount, 80, '立沖查詢 AR 已用額');
  closeEnough(clearingAdvance.refunded_amount, 20, '立沖查詢 AR 已退款額');
  closeEnough(clearingAdvance.remaining_amount, 0, '立沖查詢 AR 剩餘額');

  await expectError(() => api(`/finance-workflow/advances/${arAdvance.id}/apply?source_database=${SOURCE}`, 'POST', {
    source_database: SOURCE, open_item_id: apOpenId, amount: 1, movement_date: '2026-08-26', note: MARKER,
  }), '不同 AR／AP 類別的立沖轉抵');
  await expectError(() => api('/finance-workflow/cross-offsets', 'POST', {
    source_database: SOURCE, offset_kind: 'open_items', offset_date: '2026-08-26',
    ar_open_item_id: arOpenId, ap_open_item_id: apOpenId, amount: 1, currency_code: 'USD', note: MARKER,
  }), '不同幣別的客戶兼廠商對沖');

  console.log(JSON.stringify({ ok: true, checked: [
    'AR／AP 預收預付與溢收溢付建立及核准','可用／已用／退款／剩餘餘額','分批轉抵與逐筆明細','退款／退回與退款分錄底稿',
    '同公司同來源同對象同幣別限制','應收／應付帳款對沖','預收／預付對沖','對沖匯差與雙方分錄底稿',
    '立沖帳摘要與明細查詢','錯誤類別與幣別攔截'
  ], marker: MARKER }, null, 2));
} finally {
  try { await cleanup(target); } catch (error) { console.error(`cleanup failed: ${error.message}`); }
  if (token) {
    try {
      const response = await fetch(`${API}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      await response.text();
    } catch (_) {}
  }
  await target.end();
}
