import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { pool, reloadSourceDatabases, sourceDatabases } from '../src/db.js';
import { REPORT_KEYS } from '../src/reports.js';

dotenv.config();

const baseUrl = String(process.env.ERP_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const fromDate = argumentValue('--from-date') || '2000-01-01';
const toDate = argumentValue('--to-date') || todayTaipei();
const requestedSource = argumentValue('--source')?.toUpperCase() || '';
const FLOW_KEYS = ['sales', 'procurement', 'health'];
const CHECK_TABLES = [
  'procurement_requisitions', 'procurement_orders', 'procurement_receipts', 'procurement_returns',
  'sales_documents', 'finance_open_items', 'finance_settlements', 'finance_notes',
  'finance_bank_accounts', 'finance_bank_transactions', 'erp_inventory_balances',
  'erp_inventory_movements', 'erp_inventory_documents', 'erp_import_batches',
  'erp_import_quality_issues', 'accounting_journals', 'accounting_opening_batches',
  'accounting_periods'
];

function argumentValue(name) {
  const exact = process.argv.find(value => value === name);
  if (exact) return process.argv[process.argv.indexOf(exact) + 1] || '';
  const prefix = `${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) || '';
}

function todayTaipei() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date()).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function quoteIdentifier(value) {
  return `\`${String(value).replaceAll('`', '``')}\``;
}

function mysqlConfig(database) {
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database,
    decimalNumbers: true,
  };
}

async function apiRequest(path, token, options = {}) {
  const headers = new Headers(options.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) throw new Error(`${path}：${body.error || `HTTP ${response.status}`}`);
  return body.data ?? body;
}

async function login() {
  const result = await apiRequest('/api/auth/login', '', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.ERP_AUDIT_USER || 'admin', password: process.env.ERP_AUDIT_PASSWORD || '12345678' }),
  });
  if (!result?.token) throw new Error('登入回應沒有提供稽核用權杖');
  return result.token;
}

function assertEqual(actual, expected, label) {
  if (String(actual ?? '') !== String(expected ?? '')) throw new Error(`${label}不一致：${actual}（預期 ${expected}）`);
}

function checkReportPayload(payload, source) {
  if (!payload || typeof payload !== 'object') throw new Error(`${source.key} 報表沒有回傳物件`);
  assertEqual(payload.source_database, source.key, `${source.key} 報表來源`);
  assertEqual(payload.company?.tenant_id, source.tenant_id, `${source.key} 報表租戶`);
  assertEqual(payload.company?.company_id, source.company_id, `${source.key} 報表公司`);
  assertEqual(payload.company?.source_system, source.source_system, `${source.key} 報表來源系統`);
  if (!Array.isArray(payload.rows)) throw new Error(`${source.key} 報表 rows 不是陣列`);
  for (const row of payload.rows) {
    if (row.source_database !== undefined) assertEqual(row.source_database, source.key, `${source.key} 報表明細來源`);
    if (row.tenant_id !== undefined) assertEqual(row.tenant_id, source.tenant_id, `${source.key} 報表明細租戶`);
    if (row.company_id !== undefined) assertEqual(row.company_id, source.company_id, `${source.key} 報表明細公司`);
    if (row.source_system !== undefined) assertEqual(row.source_system, source.source_system, `${source.key} 報表明細來源系統`);
  }
  if (payload.report === 'work-order-arrivals' && payload.available === false && payload.status !== 'needs_mapping') {
    throw new Error(`${source.key} 製令報表未提供明確的待對照狀態`);
  }
  return { report: payload.report, available: payload.available !== false, status: payload.status, rows: payload.rows.length };
}

async function tableColumns(connection, tableName) {
  const [rows] = await connection.query(`
    SELECT COLUMN_NAME column_name
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?`, [tableName]);
  return new Set(rows.map(row => String(row.column_name)));
}

async function tableExists(connection, tableName) {
  const [[row]] = await connection.query(`
    SELECT COUNT(*) count
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND TABLE_TYPE='BASE TABLE'`, [tableName]);
  return Number(row?.count || 0) > 0;
}

async function verifyTargetIsolation(source) {
  const targetDatabase = source.target_database || process.env.DB_NAME || 'inventory_erp';
  const connection = await mysql.createConnection(mysqlConfig(targetDatabase));
  const checks = [];
  try {
    const expected = {
      tenant_id: source.tenant_id,
      company_id: source.company_id,
      source_system: source.source_system,
      source_database: source.key,
    };
    for (const tableName of CHECK_TABLES) {
      if (!await tableExists(connection, tableName)) continue;
      const columns = await tableColumns(connection, tableName);
      const scopedColumns = Object.keys(expected).filter(column => columns.has(column));
      if (!scopedColumns.length) continue;
      const mismatchWhere = scopedColumns.map(column => `(${quoteIdentifier(column)} IS NULL OR ${quoteIdentifier(column)}<>?)`).join(' OR ');
      const mismatchParams = scopedColumns.map(column => expected[column]);
      const [[mismatch]] = await connection.query(`SELECT COUNT(*) count FROM ${quoteIdentifier(tableName)} WHERE ${mismatchWhere}`, mismatchParams);
      const nullWhere = scopedColumns.map(column => `${quoteIdentifier(column)} IS NULL`).join(' OR ');
      const [[missing]] = await connection.query(`SELECT COUNT(*) count FROM ${quoteIdentifier(tableName)} WHERE ${nullWhere}`);
      checks.push({ table: tableName, scoped_by: scopedColumns, mismatch_count: Number(mismatch?.count || 0), missing_scope_count: Number(missing?.count || 0) });
      if (Number(mismatch?.count || 0) > 0) throw new Error(`${targetDatabase}.${tableName} 發現其他公司或不一致的範圍資料`);
    }
    return { target_database: targetDatabase, checks };
  } finally {
    await connection.end();
  }
}

async function verifySource(source, token) {
  const queryBase = new URLSearchParams({ source_database: source.key, from_date: fromDate, to_date: toDate, as_of_date: toDate, limit: '100' });
  const reports = [];
  for (const report of REPORT_KEYS) {
    const query = new URLSearchParams(queryBase);
    query.set('report', report);
    const payload = await apiRequest(`/api/reports/operations?${query}`, token);
    reports.push(checkReportPayload(payload, source));
  }
  const flowAudits = [];
  for (const flow of FLOW_KEYS) {
    const payload = await apiRequest(`/api/flow-audit/${flow}?${queryBase}`, token);
    if (!payload || typeof payload !== 'object') throw new Error(`${source.key} ${flow} 流程稽核沒有回傳物件`);
    if (flow === 'health') {
      if (!payload.sales || !payload.procurement) throw new Error(`${source.key} 營運健康度缺少銷售／採購摘要`);
    } else if (!Array.isArray(payload.rows) || !Array.isArray(payload.supplemental_rows)) {
      throw new Error(`${source.key} ${flow} 流程稽核缺少 rows／supplemental_rows`);
    }
    flowAudits.push({ flow, rows: Array.isArray(payload.rows) ? payload.rows.length : 0, supplemental_rows: Array.isArray(payload.supplemental_rows) ? payload.supplemental_rows.length : 0 });
  }
  const quality = await apiRequest(`/api/import/data-quality?${new URLSearchParams({ source_database: source.key, limit: '100' })}`, token);
  if (!quality || typeof quality !== 'object' || !quality.summary || !quality.origin) throw new Error(`${source.key} 資料品質稽核回應不完整`);
  return {
    source_database: source.key,
    company_id: source.company_id,
    target_database: source.target_database,
    reports,
    flow_audits: flowAudits,
    quality: { issue_count: quality.summary.issue_count, active_count: quality.summary.active_count },
    isolation: await verifyTargetIsolation(source),
  };
}

let token = '';
try {
  await reloadSourceDatabases();
  const sources = Object.values(sourceDatabases).filter(source => !requestedSource || source.key === requestedSource);
  if (!sources.length) throw new Error(requestedSource ? `找不到啟用中的公司來源：${requestedSource}` : '目前沒有啟用中的公司來源');
  token = await login();
  const checked = [];
  for (const source of sources) checked.push(await verifySource(source, token));
  console.log(JSON.stringify({
    ok: true,
    base_url: baseUrl,
    date_range: { from_date: fromDate, to_date: toDate },
    checked_sources: checked,
    report_count: checked.length * REPORT_KEYS.length,
    flow_audit_count: checked.length * FLOW_KEYS.length,
    message: '所有啟用公司均已重跑報表、流程稽核、資料品質與目標資料隔離檢查。'
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
} finally {
  if (token) {
    try { await apiRequest('/api/auth/logout', token, { method: 'POST' }); } catch (_) { /* 稽核結果不因登出失敗改變 */ }
  }
  try { await pool.end(); } catch (_) { /* process will exit */ }
}
