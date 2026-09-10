import 'dotenv/config';
import mysql from 'mysql2/promise';

const API = `${String(process.env.ERP_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '')}/api`;
const SOURCE = 'SH';
const STAMP = String(Date.now());
const MARKER = `VERIFY:AUT-G01-G03:${STAMP}`;
const DATE = '2026-08-31';
const DOCS = [`AUT-G03-AR-${STAMP}-1`, `AUT-G03-AR-${STAMP}-2`, `AUT-G03-AR-${STAMP}-3`];
const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'inventory_erp'
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
    body: JSON.stringify({
      username: process.env.ERP_VERIFY_USER || 'admin',
      password: process.env.ERP_VERIFY_PASSWORD || '12345678'
    })
  });
  const payload = await response.json().catch(() => ({}));
  assert(response.ok && payload.ok !== false, `管理員登入失敗：${payload.error || response.status}`);
  return payload.data?.token || payload.token;
}

function makeApi(token) {
  return async (path, method = 'GET', body) => {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-ERP-Context-Key': SOURCE,
        'X-Source-Database': SOURCE
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { error: text }; }
    if (!response.ok || payload.ok === false) {
      throw new Error(`${method} ${path}: ${payload.error || response.status}`);
    }
    return payload.data ?? payload;
  };
}

async function cleanup(target) {
  const [draftRows] = await target.query(`SELECT DISTINCT d.id
    FROM accounting_drafts d
    LEFT JOIN accounting_draft_events e ON e.draft_id=d.id
    WHERE d.memo=? OR d.source_document_no LIKE ? OR e.reason=?`,
    [MARKER, `AUT-G03-AR-${STAMP}-%`, MARKER]);
  const draftIds = draftRows.map(row => Number(row.id)).filter(Boolean);

  const journalCondition = draftIds.length
    ? 'memo=? OR (source_kind IN (\'manual_journal\',\'accounting_draft\') AND source_id IN (?))'
    : 'memo=?';
  const journalParams = draftIds.length ? [MARKER, draftIds] : [MARKER];
  const [journalRows] = await target.query(`SELECT id FROM accounting_journals WHERE ${journalCondition}`, journalParams);
  const journalIds = journalRows.map(row => Number(row.id)).filter(Boolean);
  if (journalIds.length) await target.query('DELETE FROM accounting_journal_lines WHERE journal_id IN (?)', [journalIds]);
  if (journalIds.length) await target.query('DELETE FROM accounting_journals WHERE id IN (?)', [journalIds]);
  if (draftIds.length) await target.query('DELETE FROM accounting_draft_lines WHERE draft_id IN (?)', [draftIds]);
  if (draftIds.length) await target.query('DELETE FROM accounting_draft_sources WHERE draft_id IN (?)', [draftIds]);
  if (draftIds.length) await target.query('DELETE FROM accounting_draft_events WHERE draft_id IN (?)', [draftIds]);
  if (draftIds.length) await target.query('DELETE FROM accounting_drafts WHERE id IN (?)', [draftIds]);
  await target.query('DELETE FROM finance_open_items WHERE note=? OR document_no IN (?)', [MARKER, DOCS]);

  const [parameterRows] = await target.query('SELECT id FROM accounting_system_parameters WHERE note=?', [MARKER]);
  const parameterIds = parameterRows.map(row => Number(row.id)).filter(Boolean);
  if (parameterIds.length) await target.query('DELETE FROM accounting_system_parameter_events WHERE parameter_id IN (?)', [parameterIds]);
  if (parameterIds.length) await target.query('DELETE FROM accounting_system_parameters WHERE id IN (?)', [parameterIds]);
}

const target = await mysql.createConnection(dbConfig);
let token;
try {
  token = await login();
  const api = makeApi(token);

  // 先讓服務完成既有目標結構的增量檢核，再清除本次唯一標記的殘留。
  await api(`/accounting/drafts?source_database=${SOURCE}`);
  await cleanup(target);

  const [[context]] = await target.query(`SELECT tenant_id,company_id,source_system
    FROM erp_data_sources WHERE source_key=? AND enabled=1 LIMIT 1`, [SOURCE]);
  assert(context, '找不到 SH 公司範圍');

  const settings = await api(`/accounting/auto-settings?source_database=${SOURCE}`);
  assert(settings.effective?.accounting_classification === '1', 'AJSI01 會計分類預設值不正確', settings.effective);
  assert(settings.effective?.posting_method === 'draft_only', 'AJSI01 預設拋轉方式不正確', settings.effective);
  assert(settings.effective?.aggregate_accounts === true && settings.effective?.draft_opening_method === 'aggregate', 'AJSI01 彙總設定不正確', settings.effective);
  assert(Array.isArray(settings.nature_catalog) && settings.nature_catalog.length === 19, 'AJSI02～AJSI24 分錄性質目錄不完整', settings.nature_catalog);

  const settingDraft = await api('/accounting/auto-settings', 'POST', {
    source_database: SOURCE,
    settings: { AUT_AJSI01_SAME_ACCOUNT_AGGREGATION: '1' },
    note: MARKER,
    reason: MARKER
  });
  const settingId = Number(settingDraft.settings?.[0]?.id);
  assert(settingDraft.status === 'draft' && settingId > 0, 'AJSI01 設定未建立草稿', settingDraft);
  const voidedSetting = await api(`/accounting/g01/parameters/${settingId}/void`, 'POST', {
    source_database: SOURCE,
    reason: MARKER
  });
  assert(voidedSetting.status === 'voided', 'AJSI01 設定草稿未能受控停用', voidedSetting);

  const openIds = [];
  const amounts = [100, 50, 30];
  for (let i = 0; i < DOCS.length; i += 1) {
    const [result] = await target.query(`INSERT INTO finance_open_items
      (tenant_id,company_id,source_system,source_database,account_type,document_no,document_date,due_date,party_code,currency_code,
       source_kind,source_document_id,source_document_no,original_amount,settled_amount,balance_amount,base_original_amount,base_settled_amount,base_balance_amount,status,note,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?)`, [
      context.tenant_id, context.company_id, context.source_system, SOURCE, 'AR', DOCS[i], DATE, DATE, `AUT-CUSTOMER-${STAMP}`, 'TWD',
      'shipment', null, DOCS[i], amounts[i], 0, amounts[i], amounts[i], 0, amounts[i], MARKER, 1
    ]);
    openIds.push(Number(result.insertId));
  }

  const aggregate = await api('/accounting/drafts/generate', 'POST', {
    source_database: SOURCE,
    source_refs: openIds.slice(0, 2),
    draft_date: DATE,
    draft_mode: 'aggregate',
    memo: MARKER
  });
  assert(aggregate.generation_mode === 'aggregate' && aggregate.draft_count === 1, 'AJSB01 彙總模式未產生一張底稿', aggregate);
  assert(aggregate.source_locked && aggregate.source_count === 2 && aggregate.line_count === 2, '彙總底稿未鎖定兩筆來源或明細不完整', aggregate);
  assert(Number(aggregate.debit_total) === 150 && Number(aggregate.credit_total) === 150, '彙總底稿借貸金額不平衡', aggregate);

  const draftReport = await api(`/accounting/auto-reports?source_database=${SOURCE}&report=draft_detail&date_from=${DATE}&date_to=${DATE}&limit=2000`);
  assert(draftReport.rows.some(row => Number(row.id) === aggregate.id && Number(row.source_count) === 2 && Number(row.debit_total) === 150), 'AJSR01 底稿明細表未呈現彙總結果', draftReport);
  const sourceReport = await api(`/accounting/auto-reports?source_database=${SOURCE}&report=source&date_from=${DATE}&date_to=${DATE}&limit=2000`);
  assert(sourceReport.rows.filter(row => Number(row.draft_id) === aggregate.id).length === 2, 'AJSR02 來源單據記錄表未呈現兩筆來源', sourceReport);
  const statusReport = await api(`/accounting/auto-reports?source_database=${SOURCE}&report=status&date_from=${DATE}&date_to=${DATE}&limit=2000`);
  assert(statusReport.rows.find(row => row.document_no === DOCS[0])?.generation_status === 'draft', 'AJSR03 未呈現已產生底稿狀態', statusReport);
  assert(statusReport.rows.find(row => row.document_no === DOCS[2])?.generation_status === '未產生', 'AJSR03 未呈現未產生狀態', statusReport);

  const cleared = await api(`/accounting/drafts/${aggregate.id}/clear`, 'POST', { source_database: SOURCE, reason: MARKER });
  assert(cleared.status === 'restored' && cleared.source_locked === false && cleared.event_kind === 'cleared', 'AJSB 自動分錄清除未釋放來源並保留事件', cleared);

  const perDocument = await api('/accounting/drafts/generate', 'POST', {
    source_database: SOURCE,
    source_refs: openIds.slice(0, 2),
    draft_date: DATE,
    draft_mode: 'per_document',
    memo: MARKER
  });
  assert(perDocument.generation_mode === 'per_document' && perDocument.draft_count === 2, 'AJSB01 逐張模式未依來源產生兩張底稿', perDocument);
  assert(perDocument.drafts.every(row => row.source_count === 1 && row.line_count === 2), '逐張底稿的來源或明細數不正確', perDocument.drafts);
  for (const draft of perDocument.drafts) {
    const result = await api(`/accounting/drafts/${draft.id}/clear`, 'POST', { source_database: SOURCE, reason: MARKER });
    assert(result.status === 'restored', '逐張底稿清除失敗', result);
  }

  const journal = await api('/accounting/journals', 'POST', {
    source_database: SOURCE,
    journal_date: DATE,
    memo: MARKER,
    lines: [
      { account_code: '1101', debit_amount: 80, credit_amount: 0, description: MARKER },
      { account_code: '4101', debit_amount: 0, credit_amount: 80, description: MARKER }
    ]
  });
  const posted = await api(`/accounting/journals/${journal.id}/post`, 'POST', { source_database: SOURCE });
  assert(posted.status === 'posted', '正式傳票過帳失敗', posted);
  const reversed = await api(`/accounting/journals/${journal.id}/reverse`, 'POST', {
    source_database: SOURCE,
    reversal_date: DATE,
    reason: MARKER
  });
  assert(reversed.action === 'reverse' && reversed.original_journal_id === journal.id && reversed.original_journal_no === journal.journal_no, 'AJSB22 沖回底稿未保留原傳票關聯', reversed);
  const [[originalRow]] = await target.query('SELECT status FROM accounting_journals WHERE id=?', [journal.id]);
  const [[reversalDraft]] = await target.query('SELECT source_kind,source_id,status FROM accounting_drafts WHERE id=?', [reversed.id]);
  const [originalLines] = await target.query('SELECT account_code,debit_amount,credit_amount FROM accounting_journal_lines WHERE journal_id=? ORDER BY line_no', [journal.id]);
  const [reversalLines] = await target.query('SELECT account_code,debit_amount,credit_amount FROM accounting_draft_lines WHERE draft_id=? ORDER BY line_no', [reversed.id]);
  assert(originalRow?.status === 'posted' && reversalDraft?.source_kind === 'journal_reversal' && Number(reversalDraft?.source_id) === journal.id && reversalDraft.status === 'draft', '原傳票未維持已過帳或沖回底稿狀態錯誤', { originalRow, reversalDraft });
  assert(reversalLines.length === originalLines.length && reversalLines.every((line, index) => line.account_code === originalLines[index].account_code && Number(line.debit_amount) === Number(originalLines[index].credit_amount) && Number(line.credit_amount) === Number(originalLines[index].debit_amount)), '沖回底稿未反向複製原傳票借貸', { originalLines, reversalLines });
  const clearedReversal = await api(`/accounting/drafts/${reversed.id}/clear`, 'POST', { source_database: SOURCE, reason: MARKER });
  assert(clearedReversal.status === 'restored', '沖回底稿未能受控清除', clearedReversal);

  console.log(JSON.stringify({
    ok: true,
    checked: [
      'AJSI01 公司別參數、版本草稿與受控停用',
      'AJSI02～AJSI24 分錄性質目錄對照',
      'AJSB01 多來源彙總與逐張產生',
      'AJSR01～AJSR03 底稿、來源與產生狀況報表',
      '來源鎖定、清除與事件保留',
      'AJSB22 原傳票保留與沖回底稿'
    ],
    aggregate_draft_no: aggregate.draft_no,
    per_document_count: perDocument.draft_count,
    original_journal_no: journal.journal_no,
    reversal_draft_no: reversed.draft_no
  }, null, 2));
} finally {
  try { await cleanup(target); } catch (error) { console.error(`cleanup failed: ${error.message}`); }
  if (token) {
    try {
      const response = await fetch(`${API}/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      });
      await response.text();
    } catch (_) {}
  }
  await target.end();
}
