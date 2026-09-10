import 'dotenv/config';
import mysql from 'mysql2/promise';

const API = `${String(process.env.ERP_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '')}/api`;
const SOURCE = 'SH';
const ISOLATION_SOURCE = 'SC';
const STAMP = String(Date.now());
const MARKER = `VERIFY:AUT-R1:${STAMP}`;
const DATE = '2026-08-31';
const INVENTORY_DOC = `${MARKER}:INV`;
const FINANCE_DOC = `${MARKER}:AR`;
const TYPE_CODE = `R1${STAMP.slice(-12)}`.slice(0, 20);
const NATURE_CODE = `R1N${STAMP.slice(-9)}`.slice(0, 12);
const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'inventory_erp',
  decimalNumbers: true
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

function makeApi(token, sourceDatabase = SOURCE) {
  return async (path, method = 'GET', body) => {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-ERP-Context-Key': sourceDatabase,
        'X-Source-Database': sourceDatabase
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const responseText = await response.text();
    let payload;
    try { payload = JSON.parse(responseText); } catch { payload = { error: responseText }; }
    if (!response.ok || payload.ok === false) {
      throw new Error(`${method} ${path}: ${payload.error || response.status}`);
    }
    return payload.data ?? payload;
  };
}

async function expectFailure(action, pattern, label) {
  let error = null;
  try { await action(); } catch (caught) { error = caught; }
  assert(error, `${label} 應該被拒絕`);
  if (pattern) assert(pattern.test(error.message), `${label} 的拒絕原因不符合預期：${error.message}`);
}

function safeDatabaseName(value) {
  const name = String(value || '').trim();
  assert(/^[A-Za-z0-9_$-]{1,120}$/.test(name), `資料庫名稱不安全：${name}`);
  return name;
}

async function loadSourceConfig(connection, sourceKey) {
  const [[row]] = await connection.query(`SELECT source_key,target_database,tenant_id,company_id,source_system
    FROM erp_data_sources WHERE source_key=? AND enabled=1 LIMIT 1`, [sourceKey]);
  assert(row, `找不到 ${sourceKey} 公司範圍`);
  return row;
}

async function cleanup(target) {
  const [draftRows] = await target.query(`SELECT DISTINCT d.id
    FROM accounting_drafts d
    LEFT JOIN accounting_draft_events e ON e.draft_id=d.id
    WHERE d.memo=? OR d.source_document_no LIKE ? OR e.reason=?`,
    [MARKER, `${MARKER}%`, MARKER]);
  const draftIds = draftRows.map(row => Number(row.id)).filter(Boolean);

  const journalConditions = ['memo=?'];
  const journalParams = [MARKER];
  if (draftIds.length) {
    journalConditions.push("(source_kind IN ('manual_journal','accounting_draft') AND source_id IN (?))");
    journalParams.push(draftIds);
  }
  const [journalRows] = await target.query(`SELECT id FROM accounting_journals WHERE ${journalConditions.join(' OR ')}`, journalParams);
  const journalIds = journalRows.map(row => Number(row.id)).filter(Boolean);
  if (journalIds.length) await target.query('DELETE FROM accounting_journal_lines WHERE journal_id IN (?)', [journalIds]);
  if (journalIds.length) await target.query('DELETE FROM accounting_journals WHERE id IN (?)', [journalIds]);
  if (draftIds.length) await target.query('DELETE FROM accounting_draft_lines WHERE draft_id IN (?)', [draftIds]);
  if (draftIds.length) await target.query('DELETE FROM accounting_draft_sources WHERE draft_id IN (?)', [draftIds]);
  if (draftIds.length) await target.query('DELETE FROM accounting_draft_events WHERE draft_id IN (?)', [draftIds]);
  if (draftIds.length) await target.query('DELETE FROM accounting_drafts WHERE id IN (?)', [draftIds]);

  await target.query('DELETE FROM finance_open_items WHERE note=? OR document_no IN (?)', [MARKER, [FINANCE_DOC]]);
  await target.query('DELETE FROM inventory_movement_ledger WHERE document_no=?', [INVENTORY_DOC]);

  const [natureRows] = await target.query('SELECT id FROM erp_document_natures WHERE note=?', [MARKER]);
  if (natureRows.length) await target.query('DELETE FROM erp_document_natures WHERE id IN (?)', [natureRows.map(row => Number(row.id))]);

  const [parameterRows] = await target.query('SELECT id FROM accounting_system_parameters WHERE note=?', [MARKER]);
  const parameterIds = parameterRows.map(row => Number(row.id)).filter(Boolean);
  if (parameterIds.length) await target.query('DELETE FROM accounting_system_parameter_events WHERE parameter_id IN (?)', [parameterIds]);
  if (parameterIds.length) await target.query('DELETE FROM accounting_system_parameters WHERE id IN (?)', [parameterIds]);
}

const connections = [];
const target = await mysql.createConnection(dbConfig);
connections.push(target);
let token;

try {
  token = await login();
  const api = makeApi(token, SOURCE);
  const apiSc = makeApi(token, ISOLATION_SOURCE);

  // 先讓服務完成既有目標結構的增量檢核，再清除本次唯一標記的殘留。
  await api(`/accounting/drafts?source_database=${SOURCE}`);
  await cleanup(target);

  const sh = await loadSourceConfig(target, SOURCE);
  const sc = await loadSourceConfig(target, ISOLATION_SOURCE);

  const settings = await api(`/accounting/auto-settings?source_database=${SOURCE}`);
  assert(settings.effective?.accounting_classification === '1', 'AJSI01 會計分類預設值不正確', settings.effective);
  assert(['draft_only', 'draft_and_voucher'].includes(settings.effective?.posting_method), 'AJSI01 拋轉設定不正確', settings.effective);
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

  // 以既有單據性質表建立一次性測試規則，驗證「單據性質優先於共用預設規則」。
  const natureValues = [
    sh.tenant_id, sh.company_id, sh.source_system, SOURCE, 'INV', 'inventory_movement', NATURE_CODE,
    TYPE_CODE, 'R1 測試庫存異動', 'R1 測試庫存異動', TYPE_CODE, 'daily', 4, 4, 0, 1, 0, 'batch', 0,
    null, 'increase', '5101', '銷貨成本', '1201', '商品存貨', 0, 1, 'verification', 'verification', MARKER, 1
  ];
  const [natureResult] = await target.query(`INSERT INTO erp_document_natures
    (tenant_id,company_id,source_system,source_database,module_code,document_kind,nature_code,type_code,type_name,type_full_name,
     number_prefix,numbering_method,year_digits,serial_digits,requires_approval,auto_confirm,direct_settlement,settlement_mode,
     require_source_document,source_document_kind,inventory_effect,debit_account_code,debit_account_name,credit_account_code,
     credit_account_name,is_default,is_active,source_table,source_status,note,created_by)
    VALUES(${Array(natureValues.length).fill('?').join(',')})`, natureValues);
  assert(Number(natureResult.insertId) > 0, '測試單據性質建立失敗');

  const [movementResult] = await target.query(`INSERT INTO inventory_movement_ledger
    (tenant_id,company_id,source_system,document_id,document_no,document_type,movement_kind,movement_date,item_code,warehouse_code,
     location_code,lot_no,quantity_delta,unit_cost,amount_delta)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    sh.tenant_id, sh.company_id, sh.source_system, null, INVENTORY_DOC, TYPE_CODE, TYPE_CODE, DATE,
    `R1-ITEM-${STAMP.slice(-8)}`, 'MAIN', '', '', 1, 100, 100
  ]);
  const movementId = Number(movementResult.insertId);
  assert(movementId > 0, '測試庫存異動建立失敗');

  const sourceRows = await api(`/accounting/sources?source_database=${SOURCE}&date_from=${DATE}&date_to=${DATE}&limit=100`);
  const inventorySource = sourceRows.find(row => Number(row.id) === movementId && row.source_ref_kind === 'inventory_movement');
  assert(inventorySource, 'AJSB02 未列出可供自動分錄的庫存異動來源', sourceRows.filter(row => Number(row.id) === movementId));

  const aggregate = await api('/accounting/drafts/generate', 'POST', {
    source_database: SOURCE,
    source_refs: [{ source_kind: 'inventory_movement', source_id: movementId }],
    draft_date: DATE,
    draft_mode: 'aggregate',
    memo: MARKER
  });
  assert(aggregate.generation_mode === 'aggregate' && aggregate.draft_count === 1, 'INV 彙總模式未產生一張底稿', aggregate);
  assert(aggregate.source_locked && aggregate.source_count === 1 && aggregate.line_count === 2, 'INV 底稿來源鎖定或明細不完整', aggregate);
  assert(Number(aggregate.debit_total) === 100 && Number(aggregate.credit_total) === 100, 'INV 底稿借貸金額不平衡', aggregate);

  const aggregateDetail = await api(`/accounting/drafts/${aggregate.id}?source_database=${SOURCE}`);
  assert(aggregateDetail.sources?.[0]?.source_kind === 'inventory_movement', '底稿明細未保留 INV 來源種類', aggregateDetail.sources);
  assert(aggregateDetail.lines?.some(line => line.account_code === '5101' && Number(line.debit_amount) === 100), '單據性質借方科目未套用', aggregateDetail.lines);
  assert(aggregateDetail.lines?.some(line => line.account_code === '1201' && Number(line.credit_amount) === 100), '單據性質貸方科目未套用', aggregateDetail.lines);

  const draftReport = await api(`/accounting/auto-reports?source_database=${SOURCE}&report=draft_detail&date_from=${DATE}&date_to=${DATE}&account_type=INV&limit=2000`);
  assert(draftReport.rows.some(row => Number(row.id) === aggregate.id && Number(row.source_count) === 1 && Number(row.debit_total) === 100), 'AJSR01 未呈現 INV 底稿與科目彙總', draftReport);
  assert(draftReport.account_summary?.some(row => row.account_code === '5101' && Number(row.debit_amount) === 100), 'AJSR01 未呈現 INV 科目彙總', draftReport.account_summary);

  const sourceReport = await api(`/accounting/auto-reports?source_database=${SOURCE}&report=source&date_from=${DATE}&date_to=${DATE}&account_type=INV&limit=2000`);
  assert(sourceReport.rows.some(row => Number(row.draft_id) === aggregate.id && row.source_ref_kind === 'inventory_movement'), 'AJSR02 未呈現 INV 來源記錄', sourceReport);
  const statusReport = await api(`/accounting/auto-reports?source_database=${SOURCE}&report=status&date_from=${DATE}&date_to=${DATE}&account_type=INV&limit=2000`);
  assert(statusReport.rows.find(row => row.document_no === INVENTORY_DOC)?.generation_status === 'draft', 'AJSR03 未呈現 INV 已產生底稿狀態', statusReport);

  const restored = await api(`/accounting/drafts/${aggregate.id}/restore`, 'POST', { source_database: SOURCE, reason: MARKER });
  assert(restored.status === 'restored' && restored.source_locked === false, 'AJSB21 底稿還原未釋放 INV 來源', restored);

  const perDocument = await api('/accounting/drafts/generate', 'POST', {
    source_database: SOURCE,
    source_refs: [{ source_kind: 'inventory_movement', source_id: movementId }],
    draft_date: DATE,
    draft_mode: 'per_document',
    memo: MARKER
  });
  assert(perDocument.generation_mode === 'per_document' && perDocument.draft_count === 1, 'INV 逐張模式未依來源產生底稿', perDocument);
  const approved = await api(`/accounting/drafts/${perDocument.id}/approve`, 'POST', { source_database: SOURCE, reason: MARKER });
  assert(approved.status === 'approved' && approved.debit_total === 100, 'INV 底稿核准失敗', approved);
  const posted = await api(`/accounting/drafts/${perDocument.id}/post`, 'POST', { source_database: SOURCE, memo: MARKER });
  assert(posted.status === 'posted' && posted.journal_id > 0, 'INV 底稿拋轉正式傳票失敗', posted);
  await expectFailure(
    () => api('/accounting/drafts/generate', 'POST', { source_database: SOURCE, source_refs: [{ source_kind: 'inventory_movement', source_id: movementId }], draft_date: DATE, memo: MARKER }),
    /鎖定|已拋轉/,
    '已拋轉 INV 來源重複產生'
  );
  const postedStatus = await api(`/accounting/auto-reports?source_database=${SOURCE}&report=status&date_from=${DATE}&date_to=${DATE}&account_type=INV&limit=2000`);
  assert(postedStatus.rows.find(row => row.document_no === INVENTORY_DOC)?.generation_status === '已拋轉傳票', 'AJSR03 未回寫 INV 正式傳票狀態', postedStatus);

  // 保留 AR/AP 既有流程相容性，同時確認不可把帳款與庫存來源混在同一份底稿。
  const [financeResult] = await target.query(`INSERT INTO finance_open_items
    (tenant_id,company_id,source_system,source_database,account_type,document_no,document_date,due_date,party_code,currency_code,
     source_kind,source_document_id,source_document_no,original_amount,settled_amount,balance_amount,base_original_amount,
     base_settled_amount,base_balance_amount,status,note,created_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?)`, [
    sh.tenant_id, sh.company_id, sh.source_system, SOURCE, 'AR', FINANCE_DOC, DATE, DATE, `R1-CUSTOMER-${STAMP.slice(-8)}`, 'TWD',
    'shipment', null, FINANCE_DOC, 77, 0, 77, 77, 0, 77, MARKER, 1
  ]);
  const financeId = Number(financeResult.insertId);
  assert(financeId > 0, '測試 AR 帳款建立失敗');
  await expectFailure(
    () => api('/accounting/drafts/generate', 'POST', { source_database: SOURCE, source_refs: [
      { source_kind: 'inventory_movement', source_id: movementId }, { source_kind: 'finance_open_item', source_id: financeId }
    ], draft_date: DATE, memo: MARKER }),
    /不可混合/,
    '帳款與庫存混合底稿'
  );
  const financeDraft = await api('/accounting/drafts/generate', 'POST', {
    source_database: SOURCE,
    source_refs: [{ source_kind: 'finance_open_item', source_id: financeId }],
    draft_date: DATE,
    draft_mode: 'aggregate',
    memo: MARKER
  });
  const financeDetail = await api(`/accounting/drafts/${financeDraft.id}?source_database=${SOURCE}`);
  const clearingLine = financeDetail.lines?.find(line => Number(line.required_clearing) === 1);
  assert(clearingLine?.clearing_type === 'AR' && String(clearingLine.clearing_ref).includes(FINANCE_DOC), 'AR 底稿未保留立沖必要欄位', financeDetail.lines);
  const financeCleared = await api(`/accounting/drafts/${financeDraft.id}/clear`, 'POST', { source_database: SOURCE, reason: MARKER });
  assert(financeCleared.status === 'restored', 'AR 測試底稿清除失敗', financeCleared);

  const switchedSc = await api('/auth/context', 'POST', { source_key: ISOLATION_SOURCE });
  assert(switchedSc.context_key === ISOLATION_SOURCE, '公司切換 API 未切換到 SC', switchedSc);
  const scStatus = await apiSc(`/accounting/auto-reports?source_database=${ISOLATION_SOURCE}&report=status&date_from=${DATE}&date_to=${DATE}&limit=2000`);
  assert(!scStatus.rows.some(row => row.document_no === INVENTORY_DOC || row.document_no === FINANCE_DOC), 'SC 報表混入 SH 測試資料', scStatus.rows.filter(row => [INVENTORY_DOC, FINANCE_DOC].includes(row.document_no)));
  const scDatabase = safeDatabaseName(sc.target_database || process.env.DB_NAME || 'inventory_erp');
  const scConnection = scDatabase === dbConfig.database ? target : await mysql.createConnection({ ...dbConfig, database: scDatabase });
  if (scConnection !== target) connections.push(scConnection);
  const [[scMarker]] = await scConnection.query(`SELECT COUNT(*) count FROM inventory_movement_ledger
    WHERE document_no=? AND tenant_id=? AND company_id=? AND source_system=?`, [INVENTORY_DOC, sc.tenant_id, sc.company_id, sc.source_system]);
  assert(Number(scMarker.count) === 0, 'SC 目標庫存異動被寫入 SH 測試資料', scMarker);
  const switchedSh = await apiSc('/auth/context', 'POST', { source_key: SOURCE });
  assert(switchedSh.context_key === SOURCE, '公司切換 API 未切回 SH', switchedSh);

  console.log(JSON.stringify({
    ok: true,
    checked: [
      'AJSI01 公司別參數草稿、受控停用與 AJSI02～AJSI24 目錄',
      'INV 庫存異動來源、單據性質優先套用與借貸平衡',
      'AJSB01 彙總／逐張產生、來源鎖定、還原、核准與正式傳票',
      'AJSR01～AJSR03 INV 底稿、來源與產生狀況報表',
      'AR 立沖欄位相容與帳款／庫存來源不可混用',
      'SH／SC 公司資料隔離與目標庫檢核'
    ],
    source_database: SOURCE,
    inventory_document: INVENTORY_DOC,
    finance_document: FINANCE_DOC,
    posted_journal_id: posted.journal_id
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
  for (const connection of [...connections].reverse()) {
    try { await connection.end(); } catch (_) {}
  }
}
