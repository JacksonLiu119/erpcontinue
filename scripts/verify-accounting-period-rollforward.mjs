import 'dotenv/config';
import mysql from 'mysql2/promise';

const API = 'http://127.0.0.1:3000/api';
const SOURCE = 'SH';
const STAMP = String(Date.now());
const YEAR = '2098';
const SHORT = STAMP.slice(-12);
const MARKER = `R08-${SHORT}`;
const BANK_ACCOUNT_NO = `R08-${SHORT}`;
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

function dateOf(year, month, day = 1) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function lastDayOf(year, month) {
  return new Date(Date.UTC(Number(year), month, 0)).toISOString().slice(0, 10);
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

async function expectError(work, label) {
  let rejected = false;
  try { await work(); } catch (_) { rejected = true; }
  assert(rejected, `${label}：預期拒絕但未拒絕`);
}

async function idsByQuery(conn, sql, params) {
  const [rows] = await conn.query(sql, params);
  return rows.map(row => Number(row.id)).filter(Boolean);
}

async function deleteIds(conn, table, ids) {
  if (!ids.length) return;
  await conn.query(`DELETE FROM ${table} WHERE id IN (?)`, [ids]);
}

async function cleanup(conn, marker = MARKER) {
  await conn.beginTransaction();
  try {
    const batchIds = await idsByQuery(conn, 'SELECT id FROM accounting_opening_batches WHERE source_label LIKE ? OR note LIKE ?', [`${marker}%`, `${marker}%`]);
    const yearIds = await idsByQuery(conn, 'SELECT id FROM accounting_year_closings WHERE note LIKE ?', [`${marker}%`]);
    const periodIds = await idsByQuery(conn, 'SELECT id FROM accounting_periods WHERE note LIKE ?', [`${marker}%`]);
    const monthIds = await idsByQuery(conn, 'SELECT id FROM accounting_month_closings WHERE note LIKE ?', [`${marker}%`]);

    const openingJournalIds = batchIds.length
      ? await idsByQuery(conn, 'SELECT id FROM accounting_journals WHERE source_kind=? AND source_id IN (?)', ['opening_batch', batchIds])
      : [];
    const yearJournalIds = yearIds.length
      ? await idsByQuery(conn, 'SELECT id FROM accounting_journals WHERE source_kind=? AND source_id IN (?)', ['year_close', yearIds])
      : [];
    const manualJournalIds = await idsByQuery(conn, 'SELECT id FROM accounting_journals WHERE memo LIKE ?', [`${marker}%`]);
    const journalIds = [...new Set([...openingJournalIds, ...yearJournalIds, ...manualJournalIds])];
    await deleteIds(conn, 'accounting_journal_lines', journalIds);
    await deleteIds(conn, 'accounting_journals', journalIds);

    if (batchIds.length) {
      const openingBalanceIds = await idsByQuery(conn, 'SELECT id FROM finance_opening_balances WHERE opening_batch_id IN (?)', [batchIds]);
      if (openingBalanceIds.length) {
        await conn.query('DELETE FROM finance_open_items WHERE source_kind=? AND source_document_id IN (?)', ['opening_balance', openingBalanceIds]);
      }
      await conn.query('DELETE FROM finance_opening_balances WHERE opening_batch_id IN (?)', [batchIds]);
      const noteIds = await idsByQuery(conn, 'SELECT id FROM finance_notes WHERE opening_batch_id IN (?)', [batchIds]);
      await deleteIds(conn, 'finance_note_events', noteIds);
      await conn.query('DELETE FROM finance_notes WHERE opening_batch_id IN (?)', [batchIds]);
      const bankAccountIds = await idsByQuery(conn, 'SELECT id FROM finance_bank_accounts WHERE opening_batch_id IN (?)', [batchIds]);
      if (bankAccountIds.length) {
        const transactionIds = await idsByQuery(conn, 'SELECT id FROM finance_bank_transactions WHERE bank_account_id IN (?)', [bankAccountIds]);
        await deleteIds(conn, 'finance_bank_transaction_events', transactionIds);
        await conn.query('DELETE FROM finance_bank_transactions WHERE bank_account_id IN (?)', [bankAccountIds]);
        await conn.query('DELETE FROM finance_bank_accounts WHERE id IN (?)', [bankAccountIds]);
      }
      await conn.query('DELETE FROM accounting_opening_lines WHERE batch_id IN (?)', [batchIds]);
      await conn.query('DELETE FROM accounting_opening_events WHERE batch_id IN (?)', [batchIds]);
      await conn.query('DELETE FROM accounting_opening_batches WHERE id IN (?)', [batchIds]);
    }

    await deleteIds(conn, 'accounting_month_closing_lines', monthIds);
    await deleteIds(conn, 'accounting_month_closings', monthIds);
    await deleteIds(conn, 'accounting_year_closing_lines', yearIds);
    await deleteIds(conn, 'accounting_year_closings', yearIds);
    if (periodIds.length) {
      await conn.query('DELETE FROM accounting_period_events WHERE period_id IN (?)', [periodIds]);
      await conn.query('DELETE FROM accounting_periods WHERE id IN (?)', [periodIds]);
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  }
}

const control = await mysql.createConnection(config);
let target;
let token;
try {
  token = await login();
  const api = makeApi(token);
  const [[source]] = await control.query('SELECT target_database FROM erp_data_sources WHERE source_key=? AND enabled=1 LIMIT 1', [SOURCE]);
  assert(source, '找不到 SH 公司資料來源');
  target = await mysql.createConnection({ ...config, database: source.target_database || config.database });

  // 先讓服務完成增量建表，再清理相同測試前綴可能殘留的資料。
  await api(`/accounting/opening-batches?source_database=${SOURCE}`);
  await cleanup(target);

  for (let month = 1; month <= 12; month += 1) {
    await api('/accounting/periods', 'POST', {
      source_database: SOURCE,
      period_code: `${YEAR}-${String(month).padStart(2, '0')}`,
      start_date: dateOf(YEAR, month),
      end_date: lastDayOf(YEAR, month),
      note: MARKER,
    });
  }

  const batch = await api('/accounting/opening-batches', 'POST', {
    source_database: SOURCE,
    opening_date: dateOf(YEAR, 1),
    source_label: MARKER,
    note: MARKER,
    lines: [
      { entry_kind: 'bank', bank_code: '998', bank_name: 'R08 測試銀行', bank_account_no: BANK_ACCOUNT_NO, amount: 5000, source_document_no: `${MARKER}-BANK` },
      { entry_kind: 'ar', party_code: `${MARKER}C`, amount: 3000, document_no: `${MARKER}AR`, source_document_no: 'LEGACY-AR-01', due_date: dateOf(YEAR, 2, 28) },
      { entry_kind: 'ap', party_code: `${MARKER}V`, amount: 2000, document_no: `${MARKER}AP`, source_document_no: 'LEGACY-AP-01', due_date: dateOf(YEAR, 2, 28) },
      { entry_kind: 'ar_note', party_code: `${MARKER}C`, amount: 800, note_no: `${MARKER}ARN`, note_type: 'check', note_status: 'received', due_date: dateOf(YEAR, 3, 31) },
      { entry_kind: 'ap_note', party_code: `${MARKER}V`, amount: 600, note_no: `${MARKER}APN`, note_type: 'check', note_status: 'issued', due_date: dateOf(YEAR, 3, 31) },
    ],
  });
  assert(batch.id && batch.status === 'draft', '期初批次建立失敗', batch);
  const validated = await api(`/accounting/opening-batches/${batch.id}/validate?source_database=${SOURCE}`, 'POST', { source_database: SOURCE });
  assert(validated.status === 'validated' && Number(validated.line_count) === 5, '期初批次檢核失敗', validated);
  const approved = await api(`/accounting/opening-batches/${batch.id}/approve?source_database=${SOURCE}`, 'POST', { source_database: SOURCE });
  assert(approved.status === 'approved', '期初批次核准失敗', approved);
  const posted = await api(`/accounting/opening-batches/${batch.id}/post?source_database=${SOURCE}`, 'POST', { source_database: SOURCE });
  assert(posted.status === 'posted', '期初批次過帳失敗', posted);
  closeEnough(posted.debit_total, posted.credit_total, '期初批次過帳借貸平衡');

  const detail = await api(`/accounting/opening-batches/${batch.id}?source_database=${SOURCE}`);
  assert(detail.status === 'posted' && detail.lines.length === 5 && detail.lines.every(row => Number(row.created_target_id) > 0), '期初批次目標資料未完整建立', detail);
  const [[bank]] = await target.query('SELECT current_balance,opening_batch_id FROM finance_bank_accounts WHERE account_no=? AND source_database=?', [BANK_ACCOUNT_NO, SOURCE]);
  assert(bank && Number(bank.opening_batch_id) === Number(batch.id), '銀行期初餘額未建立', bank);
  const [[counts]] = await target.query(`SELECT
      (SELECT COUNT(*) FROM finance_opening_balances WHERE opening_batch_id=?) ar_ap_count,
      (SELECT COUNT(*) FROM finance_notes WHERE opening_batch_id=?) note_count,
      (SELECT COUNT(*) FROM finance_open_items WHERE source_kind='opening_balance' AND source_document_id IN (SELECT id FROM finance_opening_balances WHERE opening_batch_id=?)) open_item_count`, [batch.id, batch.id, batch.id]);
  assert(Number(counts.ar_ap_count) === 2 && Number(counts.note_count) === 2 && Number(counts.open_item_count) === 2, '應收／應付／票據期初目標資料未完整建立', counts);

  const reportQuery = `source_database=${SOURCE}&date_from=${dateOf(YEAR, 1)}&date_to=${dateOf(YEAR, 12, 31)}&limit=1000`;
  const trial = await api(`/accounting/trial-balance?${reportQuery}`);
  const balances = await api(`/accounting/account-balances?source_database=${SOURCE}&as_of_date=${dateOf(YEAR, 12, 31)}`);
  const details = await api(`/accounting/ledger-details?${reportQuery}`);
  const reconciliation = await api(`/accounting/reconciliation?source_database=${SOURCE}&as_of_date=${dateOf(YEAR, 12, 31)}`);
  assert(trial.balanced && trial.rows.some(row => row.account_code === '1001') && trial.rows.some(row => row.account_code === '1101') && trial.rows.some(row => row.account_code === '2101'), '試算表未呈現期初銀行／應收／應付科目', trial);
  assert(balances.rows.length >= trial.rows.length && details.rows.length > 0 && Array.isArray(reconciliation.controls) && Array.isArray(reconciliation.banks), '科目餘額／總帳明細／子帳核對報表未完整回傳', { balances: balances.rows.length, details: details.rows.length, reconciliation });

  const blocker = await api('/accounting/opening-batches', 'POST', {
    source_database: SOURCE,
    opening_date: dateOf(YEAR, 2),
    source_label: `${MARKER}:BLOCKER`,
    note: `${MARKER}:BLOCKER`,
    lines: [{ entry_kind: 'bank', bank_code: '997', bank_name: 'R08 阻擋測試銀行', bank_account_no: `${BANK_ACCOUNT_NO}B`, amount: 1 }],
  });
  const blockerPeriodId = await awaitPeriodId(target, SOURCE, `${YEAR}-02`);
  await expectError(() => api(`/accounting/periods/${blockerPeriodId}/close?source_database=${SOURCE}`, 'POST', { source_database: SOURCE, reason: MARKER }), '期間關帳遇到期初批次草稿');
  assert(blocker.status === 'draft', '關帳攔截測試批次狀態錯誤', blocker);
  await cleanup(target, `${MARKER}:BLOCKER`);

  const manual = await api('/accounting/journals', 'POST', {
    source_database: SOURCE,
    journal_date: dateOf(YEAR, 12, 15),
    memo: MARKER,
    lines: [
      { account_code: '1001', debit_amount: 40, credit_amount: 0, description: `${MARKER} 現金流入` },
      { account_code: '5101', debit_amount: 60, credit_amount: 0, description: `${MARKER} 費用` },
      { account_code: '4101', debit_amount: 0, credit_amount: 100, description: `${MARKER} 收入` },
    ],
  });
  await api(`/accounting/journals/${manual.id}/post?source_database=${SOURCE}`, 'POST', { source_database: SOURCE });

  const periodRows = await api(`/accounting/periods?source_database=${SOURCE}`);
  const periodMap = new Map(periodRows.map(row => [String(row.period_code), row]));
  for (let month = 1; month <= 12; month += 1) {
    const periodCode = `${YEAR}-${String(month).padStart(2, '0')}`;
    const period = periodMap.get(periodCode);
    assert(period, `找不到測試期間 ${periodCode}`);
    const closed = await api(`/accounting/periods/${period.id}/close?source_database=${SOURCE}`, 'POST', { source_database: SOURCE, reason: MARKER });
    assert(closed.status === 'closed', `期間 ${periodCode} 關帳失敗`, closed);
    const monthClosing = await api('/accounting/month-closings', 'POST', { source_database: SOURCE, period_code: periodCode, close_date: lastDayOf(YEAR, month), note: MARKER });
    assert(monthClosing.reconciliation_status === 'balanced', `期間 ${periodCode} 月底快照不平衡`, monthClosing);
  }
  const monthRows = await api(`/accounting/month-closings?source_database=${SOURCE}`);
  assert(monthRows.filter(row => String(row.period_code).startsWith(`${YEAR}-`) && row.status === 'closed').length === 12, '12 個月底結轉快照未完整建立', monthRows);

  const year = await api('/accounting/year-closings', 'POST', { source_database: SOURCE, fiscal_year: YEAR, close_date: dateOf(YEAR, 12, 31), retained_earnings_account_code: '3201', retained_earnings_account_name: '保留盈餘', note: MARKER });
  const yearPosted = await api(`/accounting/year-closings/${year.id}/post?source_database=${SOURCE}`, 'POST', { source_database: SOURCE });
  assert(yearPosted.status === 'posted' && yearPosted.next_fiscal_year === '2099' && yearPosted.reconciliation_status === 'balanced', '年度結轉失敗', yearPosted);
  closeEnough(yearPosted.total_debit, yearPosted.total_credit, '年度結轉借貸平衡');
  await expectError(() => api(`/accounting/periods/${periodMap.get(`${YEAR}-12`).id}/reopen?source_database=${SOURCE}`, 'POST', { source_database: SOURCE, reason: MARKER }), '年度結轉後重新開帳攔截');

  console.log(JSON.stringify({ ok: true, checked: [
    '銀行／應收／應付／應收票據／應付票據期初批次導入',
    '期初建立→檢核→核准→過帳與原始單號保留',
    '期初批次借貸平衡與目標子帳建立',
    '試算表／科目餘額／總帳明細／子帳核對 API',
    '未完成期初批次阻擋期間關帳',
    '12 個月月底結轉快照與借貸核對',
    '年度損益結轉／下一年度標記／年度後重新開帳攔截',
  ], batch_id: batch.id, year_closing_id: year.id, fiscal_year: YEAR }, null, 2));
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

async function awaitPeriodId(conn, sourceDatabase, periodCode) {
  const [[period]] = await conn.query('SELECT id FROM accounting_periods WHERE source_database=? AND period_code=? ORDER BY id DESC LIMIT 1', [sourceDatabase, periodCode]);
  assert(period, `找不到期間 ${periodCode}`);
  return period.id;
}
