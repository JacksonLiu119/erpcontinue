import 'dotenv/config';
import mysql from 'mysql2/promise';

const API = process.env.TEST_API_URL || 'http://127.0.0.1:3000/api';
const SOURCE = 'SH';
const FROM = '2000-01-01';
const TO = '2099-12-31';
const AS_OF = process.env.FLOW_AUDIT_AS_OF || '2026-09-03';
const GENERATION_KEY = `FLOW-AUDIT-VERIFY-${Date.now()}`;
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

async function request(token, path, method = 'GET', body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Source-Database': SOURCE,
      'X-Company-Id': SOURCE,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { error: text }; }
  if (!response.ok || payload.ok === false) throw new Error(`${method} ${path}: ${payload.error || response.status}`);
  return payload.data ?? payload;
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

function recommendationKey(row) { return `${row.source_key}|${row.issue_code}`; }

async function restoreOrRemoveTestRows(db, context, beforeRows, beforeEventIds) {
  const [touched] = await db.query(`SELECT * FROM flow_audit_recommendations
    WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND generation_key=?`, [
    context.tenant_id, context.company_id, context.source_system, SOURCE, GENERATION_KEY,
  ]);
  if (!touched.length) return;
  const beforeByKey = new Map(beforeRows.map(row => [recommendationKey(row), row]));
  const touchedIds = touched.map(row => Number(row.id));
  const [newEvents] = await db.query(`SELECT id FROM flow_audit_recommendation_events
    WHERE recommendation_id IN (?)`, [touchedIds]);
  const beforeEventSet = new Set(beforeEventIds.map(Number));
  const eventIdsToDelete = newEvents.map(row => Number(row.id)).filter(id => !beforeEventSet.has(id));
  await db.beginTransaction();
  try {
    if (eventIdsToDelete.length) await db.query('DELETE FROM flow_audit_recommendation_events WHERE id IN (?)', [eventIdsToDelete]);
    for (const row of touched) {
      const old = beforeByKey.get(recommendationKey(row));
      if (!old) {
        await db.query('DELETE FROM flow_audit_recommendations WHERE id=?', [row.id]);
        continue;
      }
      await db.query(`UPDATE flow_audit_recommendations SET
        generation_key=?,flow_kind=?,issue_code=?,source_kind=?,source_key=?,source_id=?,source_item_id=?
        ,source_document_no=?,source_date=?,expected_date=?,due_date=?,party_code=?,item_code=?,warehouse_code=?
        ,currency_code=?,overdue_days=?,expected_overdue_days=?,aging_bucket=?,remaining_quantity=?,remaining_amount=?
        ,financial_impact=?,reason=?,proposed_action=?,status=?,decision_note=?,approved_by=?,approved_at=?
        ,applied_by=?,applied_at=?,payload_json=?,created_by=?,created_at=?,updated_at=? WHERE id=?`, [
        old.generation_key, old.flow_kind, old.issue_code, old.source_kind, old.source_key, old.source_id, old.source_item_id,
        old.source_document_no, old.source_date, old.expected_date, old.due_date, old.party_code, old.item_code, old.warehouse_code,
        old.currency_code, old.overdue_days, old.expected_overdue_days, old.aging_bucket, old.remaining_quantity, old.remaining_amount,
        old.financial_impact, old.reason, old.proposed_action, old.status, old.decision_note, old.approved_by, old.approved_at,
        old.applied_by, old.applied_at, old.payload_json, old.created_by, old.created_at, old.updated_at, row.id,
      ]);
    }
    await db.commit();
  } catch (error) {
    await db.rollback();
    throw error;
  }
}

async function main() {
  const db = await mysql.createConnection(config);
  let token;
  let context;
  let beforeRows = [];
  let beforeEventIds = [];
  try {
    token = await login();
    const health = await request(token, `/flow-audit/health?source_database=${SOURCE}&from_date=${FROM}&to_date=${TO}&as_of_date=${AS_OF}&limit=200`);
    assert(health.sales && health.procurement && health.inventory && health.financial && Array.isArray(health.alerts), '營運健康度未提供完整跨模組摘要', health);

    // 測試前保存既有同公司建議與事件；測試結束會還原，避免污染正式稽核資料。
    [[context]] = await db.query(`SELECT tenant_id,company_id,source_system
      FROM erp_data_sources WHERE source_key=? AND enabled=1 LIMIT 1`, [SOURCE]);
    assert(context, '找不到 SH／仙暉公司的目標資料範圍');
    [beforeRows] = await db.query(`SELECT * FROM flow_audit_recommendations
      WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=?`, [
      context.tenant_id, context.company_id, context.source_system, SOURCE,
    ]);
    const beforeIds = beforeRows.map(row => Number(row.id));
    if (beforeIds.length) {
      const [events] = await db.query('SELECT id FROM flow_audit_recommendation_events WHERE recommendation_id IN (?)', [beforeIds]);
      beforeEventIds = events.map(row => Number(row.id));
    }

    const generated = await request(token, '/flow-audit/recommendations/generate', 'POST', {
      source_database: SOURCE, from_date: FROM, to_date: TO, as_of_date: AS_OF,
      limit: 200, flow_kind: 'all', generation_key: GENERATION_KEY,
    });
    assert(Number(generated.candidate_count) > 0, '目前沒有可供稽核建議驗證的異常候選', generated);

    const rows = await request(token, `/flow-audit/recommendations?source_database=${SOURCE}&from_date=${FROM}&to_date=${TO}&as_of_date=${AS_OF}&flow_kind=all&status=all&generation_key=${GENERATION_KEY}&limit=200`);
    assert(Array.isArray(rows) && rows.length > 0, '稽核建議產生後查不到同批資料', generated);
    assert(rows.every(row => row.source_database === SOURCE && row.status === 'pending'), '新產生建議未維持公司隔離或待核准狀態', rows[0]);

    const pending = rows.find(row => row.status === 'pending');
    assert(pending, '本批沒有待核准更正建議');
    const approved = await request(token, `/flow-audit/recommendations/${pending.id}/approve`, 'POST', {
      source_database: SOURCE, note: '自動回歸測試：核准鏈驗證後還原',
    });
    assert(approved.status === 'approved', '更正建議核准流程失敗', approved);
    const detail = await request(token, `/flow-audit/recommendations/${pending.id}?source_database=${SOURCE}`);
    assert(detail.recommendation?.status === 'approved', '核准後詳細資料狀態錯誤', detail);
    assert((detail.events || []).some(event => event.event_kind === 'generated') && (detail.events || []).some(event => event.event_kind === 'approved'), '更正建議事件歷程不完整', detail.events);
    console.log(`verify-flow-audit-recommendations: ok (候選 ${generated.candidate_count}、本批 ${rows.length}、跨模組摘要與核准歷程均通過)`);
  } finally {
    if (context) await restoreOrRemoveTestRows(db, context, beforeRows, beforeEventIds);
    await db.end();
  }
}

main().catch(error => {
  console.error(`verify-flow-audit-recommendations: failed: ${error.message}`);
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  process.exitCode = 1;
});
