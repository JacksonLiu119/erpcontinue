import 'dotenv/config';
import mysql from 'mysql2/promise';

const API = 'http://127.0.0.1:3000/api';
const SOURCE = 'SH';
const stamp = String(Date.now());
const DOCUMENT_NO = `DQ-VERIFY-${stamp}`;
const MARKER = `VERIFY:R09:IMPORT-QUALITY:${stamp}`;
const config = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'inventory_erp',
  charset: 'utf8mb4'
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
    body: JSON.stringify({ username: 'admin', password: '12345678' })
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
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch (_) { payload = { error: text }; }
    if (!response.ok || payload.ok === false) {
      throw new Error(`${method} ${path}: ${payload.error || response.statusText}`);
    }
    return payload.data ?? payload;
  };
}

async function cleanup(target) {
  const [issues] = await target.query(
    'SELECT id FROM erp_import_quality_issues WHERE source_key=?',
    [`${SOURCE}:copta/coptb:${DOCUMENT_NO}`]
  );
  if (issues.length) await target.query('DELETE FROM erp_import_quality_issues WHERE id IN (?)', [issues.map(row => row.id)]);
  const [documents] = await target.query('SELECT id FROM sales_documents WHERE document_no=? AND note=?', [DOCUMENT_NO, MARKER]);
  if (documents.length) await target.query('DELETE FROM sales_documents WHERE id IN (?)', [documents.map(row => row.id)]);
}

const control = await mysql.createConnection(config);
const source = await mysql.createConnection({ ...config, database: 'sh' });
let target;
try {
  const token = await login();
  const api = makeApi(token);

  const [[sourceBefore]] = await source.query(
    `SELECT TA019 FROM copta WHERE COMPANY='SH' AND TA001='2110' AND TA002='01150701001' LIMIT 1`
  );
  assert(sourceBefore, '找不到 SH 原始稽核單據');

  const [[targetInfo]] = await control.query(
    'SELECT target_database FROM erp_data_sources WHERE source_key=? AND enabled=1 LIMIT 1',
    [SOURCE]
  );
  assert(targetInfo?.target_database === null || targetInfo?.target_database === undefined, 'SH 目標資料庫設定不符合預期');
  target = control;

  // 先讓服務完成增量建表；此 GET 只有查詢，不會建立業務資料。
  await api(`/import/data-quality?source_database=${SOURCE}&document_no=${encodeURIComponent(DOCUMENT_NO)}`);
  await cleanup(target);

  const [[context]] = await target.query(
    'SELECT tenant_id,company_id,source_system FROM erp_data_sources WHERE source_key=? AND enabled=1 LIMIT 1',
    [SOURCE]
  );
  assert(context, '找不到 SH 的 ERP 公司範圍');
  const [documentResult] = await target.execute(`
    INSERT INTO sales_documents
      (tenant_id,company_id,source_system,source_database,document_kind,document_type,document_no,
       document_date,customer_code,currency_code,status,inventory_status,note)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,'not_applicable',?)`, [
      context.tenant_id, context.company_id, context.source_system, SOURCE, 'sales_order', 'DQ', DOCUMENT_NO,
      '2026-07-15', 'DQ-CUSTOMER', 'TWD', 'completed', MARKER
    ]);
  const documentId = Number(documentResult.insertId);
  await target.execute(`
    INSERT INTO sales_document_items
      (document_id,line_no,item_code,item_name,unit,quantity,related_quantity,unit_price,note)
    VALUES(?,?,?,?,?,?,?,?,?)`, [documentId, 1, 'DQ-ITEM', '匯入品質測試品', 'PCS', 12, 0, 100, MARKER]);

  const scan = await api('/import/data-quality/scan', 'POST', { source_database: SOURCE, document_no: DOCUMENT_NO });
  assert(scan.issue_document_count === 1 && scan.issue_line_count === 1, '指定單號掃描結果不正確', scan);
  assert(scan.document_no === DOCUMENT_NO && scan.policy === 'warning_only_until_approved', '掃描沒有保留唯讀警示策略', scan);

  const listed = await api(`/import/data-quality?source_database=${SOURCE}&document_no=${encodeURIComponent(DOCUMENT_NO)}`);
  const issue = listed.rows?.[0];
  assert(issue?.issue_code === 'SALES_ORDER_CLOSED_WITH_REMAINING_QTY', '沒有建立完成但有剩餘量的匯入品質異常', listed);
  const actual = typeof issue.actual_json === 'string' ? JSON.parse(issue.actual_json) : issue.actual_json;
  assert(Number(actual?.remaining_quantity) === 12 && Number(actual?.remaining_line_count) === 1, '異常實際數量留痕不正確', issue);

  const corrected = await api(`/import/data-quality/${issue.id}/correction`, 'POST', {
    source_database: SOURCE,
    resolution_type: 'target_correction',
    note: MARKER
  });
  assert(corrected.status === 'correction_pending' && corrected.correction_no, '目標端更正案件未建立', corrected);
  const detail = await api(`/import/data-quality/${issue.id}`);
  assert(detail.events?.some(event => event.action_code === 'correction'), '更正事件沒有保留', detail);

  const [[sourceAfter]] = await source.query(
    `SELECT TA019 FROM copta WHERE COMPANY='SH' AND TA001='2110' AND TA002='01150701001' LIMIT 1`
  );
  assert(sourceAfter.TA019 === sourceBefore.TA019, '品質掃描不應變更 SH 原始資料');
  console.log(JSON.stringify({
    ok: true,
    checked: [
      '指定單號唯讀掃描',
      '完成單據剩餘量異常留痕',
      '目標端更正案件與事件歷程',
      'SH 原始資料未被修改'
    ],
    document_no: DOCUMENT_NO,
    correction_no: corrected.correction_no
  }, null, 2));
} finally {
  if (target) await cleanup(target);
  if (target && target !== control) await target.end();
  await source.end();
  await control.end();
}
