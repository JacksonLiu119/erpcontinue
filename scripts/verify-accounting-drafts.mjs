import 'dotenv/config';
import mysql from 'mysql2/promise';

const API = 'http://127.0.0.1:3000/api';
const SOURCE = 'SH';
const STAMP = String(Date.now());
const MARKER = `VERIFY:R06:ACCOUNTING-DRAFT:${STAMP}`;
const DOCS = [`R06-AR-${STAMP}-1`, `R06-AR-${STAMP}-2`, `R06-AR-${STAMP}-3`];
const DATE = '2026-08-31';
const dbConfig = {
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
  let failed = false;
  try { await work(); } catch (_) { failed = true; }
  assert(failed, `${label}：預期拒絕但未拒絕`);
}

async function cleanup(target) {
  const [draftRows] = await target.query(`SELECT DISTINCT d.id
    FROM accounting_drafts d LEFT JOIN accounting_draft_events e ON e.draft_id=d.id
    LEFT JOIN accounting_draft_sources s ON s.draft_id=d.id
    WHERE e.reason=? OR d.source_document_no LIKE ? OR s.source_document_no IN (?)`, [MARKER, `R06-AR-${STAMP}-%`, DOCS]);
  const draftIds = draftRows.map(row => Number(row.id)).filter(Boolean);
  const [journalRows] = await target.query(`SELECT id FROM accounting_journals WHERE memo=?${draftIds.length ? ' OR (source_kind=\'accounting_draft\' AND source_id IN (?))' : ''}`, draftIds.length ? [MARKER, draftIds] : [MARKER]);
  const journalIds = journalRows.map(row => Number(row.id)).filter(Boolean);
  if (journalIds.length) await target.query('DELETE FROM accounting_journal_lines WHERE journal_id IN (?)', [journalIds]);
  if (journalIds.length) await target.query('DELETE FROM accounting_journals WHERE id IN (?)', [journalIds]);
  if (draftIds.length) await target.query('DELETE FROM accounting_drafts WHERE id IN (?)', [draftIds]);
  await target.query('DELETE FROM finance_open_items WHERE note=? OR document_no IN (?)', [MARKER, DOCS]);
}

const target = await mysql.createConnection(dbConfig);
let token;
try {
  token = await login();
  const api = makeApi(token);
  // 先讓目前服務完成增量建表與舊底稿回填，再清理可能的上次測試殘留。
  await api(`/accounting/drafts?source_database=${SOURCE}`);
  await cleanup(target);

  const [[context]] = await target.query(`SELECT tenant_id,company_id,source_system
    FROM erp_data_sources WHERE source_key=? AND enabled=1 LIMIT 1`, [SOURCE]);
  assert(context, '找不到 SH 公司範圍');
  const amounts = [100, 50, 30];
  const balances = [40, 50, 30];
  const openIds = [];
  for (let i = 0; i < DOCS.length; i++) {
    const [result] = await target.query(`INSERT INTO finance_open_items
      (tenant_id,company_id,source_system,source_database,account_type,document_no,document_date,due_date,party_code,currency_code,
       source_kind,source_document_id,source_document_no,original_amount,settled_amount,balance_amount,base_original_amount,base_settled_amount,base_balance_amount,status,note,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?)`, [
      context.tenant_id, context.company_id, context.source_system, SOURCE, 'AR', DOCS[i], DATE, DATE, 'R06-CUSTOMER', 'TWD',
      'shipment', null, DOCS[i], amounts[i], amounts[i] - balances[i], balances[i], amounts[i], amounts[i] - balances[i], balances[i], MARKER, 1,
    ]);
    openIds.push(Number(result.insertId));
  }

  const generated = await api('/accounting/drafts/generate', 'POST', {
    source_database: SOURCE,
    source_refs: openIds.slice(0, 2),
    draft_date: DATE,
    memo: MARKER,
  });
  assert(generated.status === 'draft' && generated.source_locked && generated.source_count === 2, '自動產生底稿未鎖定兩筆來源', generated);
  assert(generated.line_count === 2 && Number(generated.debit_total) === 90 && Number(generated.credit_total) === 90, '多筆來源未依剩餘餘額彙總為平衡底稿', generated);

  const detail = await api(`/accounting/drafts/${generated.id}?source_database=${SOURCE}`);
  assert(detail.lines.length === 2 && detail.sources.length === 2 && detail.events.some(row => row.event_kind === 'generated'), '底稿明細／來源／產生事件不完整', detail);
  const clearingLine = detail.lines.find(row => Number(row.required_clearing) === 1);
  assert(clearingLine && clearingLine.clearing_type === 'AR' && String(clearingLine.clearing_ref).includes(DOCS[0]), '立沖必填欄位未帶入來源', clearingLine);

  const sourceRows = await api(`/accounting/sources?source_database=${SOURCE}&limit=100`);
  assert(Number(sourceRows.find(row => Number(row.id) === openIds[2])?.remaining_amount) === 30, '來源清單未呈現目前可立帳餘額', sourceRows.find(row => Number(row.id) === openIds[2]));
  assert(!sourceRows.some(row => openIds.slice(0, 2).includes(Number(row.id))), '已鎖定來源仍出現在待拋轉清單');
  await expectError(() => api('/accounting/journals/transfer', 'POST', { source_database: SOURCE, open_item_id: openIds[0], memo: MARKER }), '舊直接拋轉路徑繞過來源鎖定');

  const maintainedLines = detail.lines.map(line => ({ ...line, description: `${line.description || ''}／維護` }));
  const maintained = await api(`/accounting/drafts/${generated.id}`, 'PUT', { source_database: SOURCE, lines: maintainedLines, reason: MARKER });
  assert(maintained.status === 'draft' && maintained.line_count === 2, '草稿維護失敗', maintained);
  const clearingBypassLines = maintainedLines.map(line => ({ ...line, required_clearing:0, party_code:null, clearing_ref:null }));
  await expectError(() => api(`/accounting/drafts/${generated.id}`, 'PUT', { source_database: SOURCE, lines: clearingBypassLines, reason: MARKER }), '取消既有立沖必填');
  await expectError(() => api(`/accounting/drafts/${generated.id}`, 'PUT', { source_database: SOURCE, lines: [...maintainedLines, { ...maintainedLines[0], line_no: 3 }], reason: MARKER }), '底稿新增行次');

  const approved = await api(`/accounting/drafts/${generated.id}/approve`, 'POST', { source_database: SOURCE, reason: MARKER });
  assert(approved.status === 'approved', '底稿核准失敗', approved);
  await expectError(() => api(`/accounting/drafts/${generated.id}`, 'PUT', { source_database: SOURCE, lines: maintainedLines, reason: MARKER }), '核准後維護底稿');
  const posted = await api(`/accounting/drafts/${generated.id}/post`, 'POST', { source_database: SOURCE, memo: MARKER });
  assert(posted.status === 'posted' && posted.line_count === 2, '底稿拋轉正式傳票失敗', posted);
  const [[journalTotals]] = await target.query(`SELECT COUNT(*) line_count,COALESCE(SUM(debit_amount),0) debit_total,COALESCE(SUM(credit_amount),0) credit_total
    FROM accounting_journal_lines WHERE journal_id=?`, [posted.journal_id]);
  assert(Number(journalTotals.line_count) === 2 && Math.abs(Number(journalTotals.debit_total) - Number(journalTotals.credit_total)) < 0.000001, '正式傳票借貸不平衡', journalTotals);
  const afterPostSources = await api(`/accounting/sources?source_database=${SOURCE}&limit=100`);
  assert(!afterPostSources.some(row => openIds.slice(0, 2).includes(Number(row.id))), '已拋轉來源重新出現在清單');

  const restored = await api('/accounting/drafts/generate', 'POST', { source_database: SOURCE, source_refs: [openIds[2]], draft_date: DATE, memo: MARKER });
  const restoredResult = await api(`/accounting/drafts/${restored.id}/restore`, 'POST', { source_database: SOURCE, reason: MARKER });
  assert(restoredResult.status === 'restored' && restoredResult.source_locked === false, '底稿還原未釋放來源鎖定', restoredResult);
  const afterRestoreSources = await api(`/accounting/sources?source_database=${SOURCE}&limit=100`);
  assert(afterRestoreSources.some(row => Number(row.id) === openIds[2]), '還原後來源未回到可產生底稿清單');
  await expectError(() => api(`/accounting/drafts/${generated.id}/restore`, 'POST', { source_database: SOURCE, reason: MARKER }), '已拋轉底稿還原');

  const finalDetail = await api(`/accounting/drafts/${generated.id}?source_database=${SOURCE}`);
  assert(finalDetail.events.some(row => row.event_kind === 'updated') && finalDetail.events.some(row => row.event_kind === 'approved') && finalDetail.events.some(row => row.event_kind === 'posted'), '底稿完整事件鏈未保留', finalDetail.events);
  console.log(JSON.stringify({ ok:true, checked:[
    '多筆來源自動產生與科目彙總','來源單據鎖定與舊路徑攔截','底稿只能維護既有行次','立沖必填／借貸平衡檢查','核准後不可維護','拋轉正式傳票','還原釋放來源與事件歷程'
  ], draft_no:generated.draft_no, journal_no:posted.journal_no, line_count:posted.line_count }, null, 2));
} finally {
  try { await cleanup(target); } catch (error) { console.error(`cleanup failed: ${error.message}`); }
  if (token) {
    try {
      const response = await fetch(`${API}/auth/logout`, { method:'POST', headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' } });
      await response.text();
    } catch (_) {}
  }
  await target.end();
}
