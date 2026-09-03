import 'dotenv/config';
import mysql from 'mysql2/promise';

const API = 'http://127.0.0.1:3000/api';
const SOURCE = 'SH';
const OTHER_SOURCE = 'SC';
const STAMP = String(Date.now());
const DATE = '2026-08-31';
const MARKER = `VERIFY:R07:BANK-NOTE:${STAMP}`;
const ACCOUNT_NO = `R07-${STAMP}`;
const SETTLEMENT_NO = `R07-SETTLEMENT-${STAMP}`;
const NOTE_NO = `R07-NOTE-${STAMP}`;
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
  assert(Math.abs(Number(actual) - Number(expected)) < 0.000001, `${label}應為 ${expected}，實際 ${actual}`);
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
  return async (path, method = 'GET', body = undefined) => {
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

async function switchContext(api, sourceKey) {
  return api('/auth/context', 'POST', { source_key: sourceKey });
}

async function expectError(work, label) {
  let rejected = false;
  try { await work(); } catch (_) { rejected = true; }
  assert(rejected, `${label}：預期拒絕但未拒絕`);
}

async function cleanup(target) {
  await target.beginTransaction();
  try {
    const [[settlement]] = await target.query('SELECT id FROM finance_settlements WHERE settlement_no=? OR note=? LIMIT 1', [SETTLEMENT_NO, MARKER]);
    const settlementId = Number(settlement?.id || 0);
    if (settlementId) await target.query('DELETE FROM finance_allocations WHERE settlement_id=?', [settlementId]);

    const [[account]] = await target.query('SELECT id FROM finance_bank_accounts WHERE account_no=? AND source_database=? LIMIT 1', [ACCOUNT_NO, SOURCE]);
    const accountId = Number(account?.id || 0);
    if (accountId) {
      const [reconciliations] = await target.query('SELECT id FROM finance_bank_reconciliations WHERE bank_account_id=? OR note=?', [accountId, MARKER]);
      const reconciliationIds = reconciliations.map(row => Number(row.id)).filter(Boolean);
      if (reconciliationIds.length) await target.query('DELETE FROM finance_bank_reconciliations WHERE id IN (?)', [reconciliationIds]);
    }

    const [drafts] = await target.query('SELECT id FROM accounting_drafts WHERE source_document_no LIKE ? OR memo LIKE ?', ['R07-%', 'VERIFY:R07:%']);
    const draftIds = drafts.map(row => Number(row.id)).filter(Boolean);
    if (draftIds.length) await target.query('DELETE FROM accounting_drafts WHERE id IN (?)', [draftIds]);

    await target.query('DELETE FROM finance_notes WHERE note_no=? OR memo=?', [NOTE_NO, MARKER]);
    if (settlementId) await target.query('DELETE FROM finance_settlements WHERE id=?', [settlementId]);
    if (accountId) await target.query('DELETE FROM finance_bank_transactions WHERE bank_account_id=?', [accountId]);
    if (accountId) await target.query('DELETE FROM finance_bank_accounts WHERE id=?', [accountId]);
    await target.commit();
  } catch (error) {
    await target.rollback();
    throw error;
  }
}

const control = await mysql.createConnection(config);
let target;
let token;
try {
  token = await login();
  const api = makeApi(token);
  await switchContext(api, SOURCE);
  const [[source]] = await control.query('SELECT target_database FROM erp_data_sources WHERE source_key=? AND enabled=1 LIMIT 1', [SOURCE]);
  assert(source, '找不到 SH 公司資料來源');
  target = await mysql.createConnection({ ...config, database: source.target_database || config.database });

  // 讓服務先完成增量建表，再清理本次測試可能殘留的資料。
  await api(`/finance-workflow/banks/accounts?source_database=${SOURCE}`);
  await cleanup(target);

  const [[context]] = await target.query('SELECT tenant_id,company_id,source_system FROM erp_data_sources WHERE source_key=? AND enabled=1 LIMIT 1', [SOURCE]);
  assert(context, '找不到 SH 公司範圍');
  const [permissionRows] = await control.query(`SELECT r.role_code,p.feature_code,p.can_view,p.can_create,p.can_update,p.can_approve
    FROM access_roles r JOIN access_role_permissions p ON p.role_id=r.id
    WHERE r.role_code='FINANCE' AND p.feature_code IN ('finance-bookkeeping','finance-cash','finance-reconcile')`);
  const permissions = Object.fromEntries(permissionRows.map(row => [row.feature_code, row]));
  assert(Number(permissions['finance-bookkeeping']?.can_view) === 1 && Number(permissions['finance-bookkeeping']?.can_create) === 0, '管帳權限未限制為查詢', permissions);
  assert(Number(permissions['finance-cash']?.can_create) === 1 && Number(permissions['finance-cash']?.can_update) === 1, '管錢權限未啟用存提款／票據異動', permissions);
  assert(Number(permissions['finance-reconcile']?.can_create) === 1 && Number(permissions['finance-reconcile']?.can_approve) === 1, '對帳權限未啟用建立／完成', permissions);

  await switchContext(api, OTHER_SOURCE);
  const beforeOtherCompany = await api(`/finance-workflow/banks/accounts?source_database=${OTHER_SOURCE}`);
  await switchContext(api, SOURCE);
  const createdAccount = await api('/finance-workflow/banks/accounts', 'POST', {
    source_database: SOURCE, bank_code: '013', bank_name: 'R07 測試銀行', account_no: ACCOUNT_NO,
    currency_code: 'TWD', opening_balance: 1000, note: MARKER,
  });
  const accountId = Number(createdAccount.id);
  assert(accountId, '銀行帳戶建立失敗', createdAccount);
  await switchContext(api, OTHER_SOURCE);
  const afterOtherCompany = await api(`/finance-workflow/banks/accounts?source_database=${OTHER_SOURCE}`);
  assert(!afterOtherCompany.some(row => Number(row.id) === accountId) && afterOtherCompany.length === beforeOtherCompany.length, 'SH 銀行帳戶穿透到 SC 公司', { beforeOtherCompany, afterOtherCompany, accountId });
  await switchContext(api, SOURCE);

  const deposit = await api('/finance-workflow/banks/transactions', 'POST', {
    source_database: SOURCE, bank_account_id: accountId, transaction_date: DATE, transaction_type: 'deposit',
    direction: 'in', amount: 250, counter_account_code: '1101', counter_account_name: '應收帳款', memo: MARKER,
  });
  const withdrawal = await api('/finance-workflow/banks/transactions', 'POST', {
    source_database: SOURCE, bank_account_id: accountId, transaction_date: DATE, transaction_type: 'withdrawal',
    direction: 'out', amount: 100, counter_account_code: '2101', counter_account_name: '應付帳款', memo: MARKER,
  });
  const postedDeposit = await api(`/finance-workflow/banks/transactions/${deposit.id}/post?source_database=${SOURCE}`, 'POST', { source_database: SOURCE });
  const postedWithdrawal = await api(`/finance-workflow/banks/transactions/${withdrawal.id}/post?source_database=${SOURCE}`, 'POST', { source_database: SOURCE });
  let [accountRows] = await target.query('SELECT current_balance FROM finance_bank_accounts WHERE id=?', [accountId]);
  closeEnough(accountRows[0].current_balance, 1150, '存提款過帳後銀行餘額');

  const reconciliation = await api('/finance-workflow/banks/reconciliations', 'POST', {
    source_database: SOURCE, bank_account_id: accountId, reconciliation_date: DATE, statement_balance: 1150,
    transaction_ids: [deposit.id, withdrawal.id], note: MARKER,
  });
  closeEnough(reconciliation.difference_amount, 0, '銀行對帳差異');
  assert(Number(reconciliation.matched_count) === 2, '逐筆對帳未收錄兩筆交易', reconciliation);
  const reconciliationItems = await api(`/finance-workflow/banks/reconciliations/${reconciliation.id}/items?source_database=${SOURCE}`);
  assert(reconciliationItems.length === 2 && reconciliationItems.every(row => row.item_status === 'matched'), '逐筆對帳明細不完整', reconciliationItems);
  const completedReconciliation = await api(`/finance-workflow/banks/reconciliations/${reconciliation.id}/complete?source_database=${SOURCE}`, 'POST', { source_database: SOURCE });
  assert(completedReconciliation.status === 'completed' && Number(completedReconciliation.matched_count) === 2, '銀行對帳完成失敗', completedReconciliation);
  await expectError(() => api(`/finance-workflow/banks/transactions/${deposit.id}/reverse?source_database=${SOURCE}`, 'POST', { source_database: SOURCE, reversal_date: DATE, reason: MARKER }), '已對帳銀行交易沖回');
  const correction = await api('/finance-workflow/banks/transactions', 'POST', {
    source_database: SOURCE, bank_account_id: accountId, transaction_date: DATE, transaction_type: 'deposit',
    direction: 'in', amount: 40, counter_account_code: '1101', counter_account_name: '應收帳款', memo: MARKER,
  });
  const postedCorrection = await api(`/finance-workflow/banks/transactions/${correction.id}/post?source_database=${SOURCE}`, 'POST', { source_database: SOURCE });
  const reversedCorrection = await api(`/finance-workflow/banks/transactions/${correction.id}/reverse?source_database=${SOURCE}`, 'POST', { source_database: SOURCE, reversal_date: DATE, reason: MARKER });
  assert(reversedCorrection.reversal_transaction_id && reversedCorrection.accounting_draft_id, '未建立銀行交易沖回與沖回底稿', reversedCorrection);

  const [settlementResult] = await target.query(`INSERT INTO finance_settlements
    (tenant_id,company_id,source_system,source_database,account_type,settlement_no,settlement_date,party_code,payment_method,amount,status,note,created_by,currency_code,exchange_rate,base_amount,exchange_difference)
    VALUES(?,?,?,?,?,?,?,?,?,?, 'posted', ?, ?, 'TWD', 1, ?, 0)`, [
    context.tenant_id, context.company_id, context.source_system, SOURCE, 'AR', SETTLEMENT_NO, DATE,
    'R07-CUSTOMER', 'check', 80, MARKER, 1, 80,
  ]);
  const note = await api('/finance-workflow/notes', 'POST', {
    source_database: SOURCE, account_type: 'AR', note_no: NOTE_NO, settlement_id: settlementResult.insertId,
    note_type: 'check', issue_date: DATE, due_date: '2026-09-30', amount: 80, bank_code: '013',
    bank_account: ACCOUNT_NO, bank_account_id: accountId, memo: MARKER,
  });
  const outstandingNotes = await api(`/finance-workflow/notes?source_database=${SOURCE}&account_type=AR&outstanding=1`);
  assert(outstandingNotes.some(row => Number(row.id) === Number(note.id)), '未兌現票據查詢未呈現已收票據', outstandingNotes);
  const deposited = await api(`/finance-workflow/notes/${note.id}/status?source_database=${SOURCE}`, 'POST', {
    source_database: SOURCE, status: 'deposited', status_date: DATE, status_note: MARKER,
  });
  const cashed = await api(`/finance-workflow/notes/${note.id}/status?source_database=${SOURCE}`, 'POST', {
    source_database: SOURCE, status: 'cashed', status_date: DATE, status_note: MARKER,
  });
  const dishonored = await api(`/finance-workflow/notes/${note.id}/status?source_database=${SOURCE}`, 'POST', {
    source_database: SOURCE, status: 'dishonored', status_date: DATE, status_note: MARKER,
  });
  assert(deposited.accounting_draft_id && cashed.bank_transaction_id && cashed.accounting_draft_id && dishonored.bank_transaction_id && dishonored.accounting_draft_id, '票據狀態未完整產生銀行交易／分錄底稿', { deposited, cashed, dishonored });

  [accountRows] = await target.query('SELECT current_balance FROM finance_bank_accounts WHERE id=?', [accountId]);
  closeEnough(accountRows[0].current_balance, 1150, '票據兌現／退票沖回後銀行餘額');
  const noteEvents = await api(`/finance-workflow/notes/${note.id}/events?source_database=${SOURCE}`);
  assert(noteEvents.length === 4 && noteEvents.some(row => row.bank_transaction_id) && noteEvents.some(row => row.accounting_draft_id), '票據狀態歷程未完整保留', noteEvents);
  const [noteRows] = await target.query('SELECT * FROM finance_notes WHERE id=?', [note.id]);
  assert(noteRows[0]?.status === 'dishonored', '票據最終狀態錯誤', noteRows[0]);
  const closedNotes = await api(`/finance-workflow/notes?source_database=${SOURCE}&account_type=AR&outstanding=1`);
  assert(!closedNotes.some(row => Number(row.id) === Number(note.id)), '票據退票後仍出現在未兌現清單', closedNotes);
  const outstanding = await api(`/finance-workflow/banks/transactions?source_database=${SOURCE}&unreconciled_only=1`);
  const noteTransactions = outstanding.filter(row => row.reference_type === 'finance_note' && Number(row.reference_id) === Number(note.id));
  assert(noteTransactions.length === 2 && noteTransactions.every(row => Number(row.reconciled) === 0), '未對帳／未兌現清單未呈現票據銀行交易', noteTransactions);

  const draftIds = [postedDeposit.accounting_draft_id, postedWithdrawal.accounting_draft_id, postedCorrection.accounting_draft_id, reversedCorrection.accounting_draft_id, deposited.accounting_draft_id, cashed.accounting_draft_id, dishonored.accounting_draft_id].map(Number).filter(Boolean);
  const [draftRows] = await target.query(`SELECT d.id,d.source_document_no,
      COALESCE(SUM(l.debit_amount),0) debit_total,COALESCE(SUM(l.credit_amount),0) credit_total
    FROM accounting_drafts d LEFT JOIN accounting_draft_lines l ON l.draft_id=d.id
    WHERE d.id IN (?) GROUP BY d.id,d.source_document_no`, [draftIds]);
  assert(draftRows.length === draftIds.length && draftRows.length >= 5, '銀行／票據流程產生的分錄底稿數量不足', { draftIds, draftRows });
  draftRows.forEach(row => closeEnough(row.debit_total, row.credit_total, `底稿 ${row.source_document_no} 借貸平衡`));
  const [transactionEvents] = await target.query(`SELECT e.event_kind,COUNT(*) event_count FROM finance_bank_transaction_events e
    JOIN finance_bank_transactions t ON t.id=e.transaction_id WHERE t.bank_account_id=? GROUP BY e.event_kind`, [accountId]);
  const eventKinds = Object.fromEntries(transactionEvents.map(row => [row.event_kind, Number(row.event_count)]));
  assert((eventKinds.created || 0) >= 3 && (eventKinds.posted || 0) >= 5 && (eventKinds.reversed || 0) >= 1 && (eventKinds.reversal_created || 0) >= 1, '銀行交易事件歷程不足', eventKinds);

  console.log(JSON.stringify({ ok: true, checked: [
    'SH／SC 公司範圍隔離', '管帳／管錢／逐筆對帳權限分離', '存提款草稿與過帳', '銀行餘額回寫',
    '逐筆對帳與對帳差異', '已對帳交易沖回限制', '應收票據託收／兌現／退票', '票據狀態歷程',
    '票況銀行交易與平衡分錄底稿', '未對帳／未兌現查詢',
  ], bank_account_id: accountId, reconciliation_id: reconciliation.id, note_no: NOTE_NO, draft_count: draftRows.length }, null, 2));
} finally {
  if (target) {
    try { await cleanup(target); } catch (error) { console.error(`cleanup failed: ${error.message}`); }
  }
  if (token) {
    try { await fetch(`${API}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }); } catch (_) {}
  }
  await control.end();
  if (target) await target.end();
}
