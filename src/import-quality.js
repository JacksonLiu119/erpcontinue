import {
  pool,
  getSourcePool,
  sourceDatabases,
  runWithTargetDatabase,
  tx,
  ensureImportQualitySchema,
  ensureTargetReceiptWorkflowSchema,
  ensureTargetSalesWorkflowSchema
} from './db.js';

const EPSILON = 0.000001;

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function notFound(message) {
  const error = new Error(message);
  error.status = 404;
  return error;
}

function trim(value) {
  return String(value ?? '').trim();
}

function sourceFromRequest(req) {
  const sourceName = trim(
    req.query.source_database || req.body?.source_database || req.headers['x-source-database'] || 'SH'
  ).toUpperCase();
  if (!sourceDatabases[sourceName]) throw badRequest(`不允許的資料庫來源：${sourceName}`);
  return sourceName;
}

function limitFromRequest(value, fallback = 200) {
  return Math.min(Math.max(Number(value) || fallback, 1), 1000);
}

function jsonValue(value) {
  return value == null ? null : JSON.stringify(value);
}

function correctionNo(id) {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  return `DQ-${stamp}-${String(id).padStart(8, '0')}`;
}

async function latestBatchId(sourceName) {
  const [[batch]] = await pool.query(
    `SELECT id FROM erp_import_batches
     WHERE source_database=? ORDER BY id DESC LIMIT 1`,
    [sourceName]
  );
  return batch?.id || null;
}

async function sourceJulyCheck(sourceName) {
  const source = sourceDatabases[sourceName];
  const result = {
    source_database: sourceName,
    database_name: source?.database || null,
    read_only: Boolean(source?.read_only),
    period: '2026-07',
    status: 'not_checked',
    tables: []
  };
  if (!source || source.adapter_code !== 'ism-sh') {
    result.status = 'not_applicable';
    result.note = '目前僅對 iSM 來源執行固定欄位的唯讀月份核對。';
    return result;
  }
  try {
    const sourcePool = getSourcePool(sourceName);
    const companyCode = source.company_id || sourceName;
    const [rows] = await sourcePool.query(`
      SELECT 'copta' AS table_name, COUNT(*) AS row_count
        FROM copta WHERE COMPANY=? AND TA003 BETWEEN '20260701' AND '20260731'
      UNION ALL
      SELECT 'coptg', COUNT(*)
        FROM coptg WHERE COMPANY=? AND TG003 BETWEEN '20260701' AND '20260731'
      UNION ALL
      SELECT 'purta', COUNT(*)
        FROM purta WHERE COMPANY=? AND TA013 BETWEEN '20260701' AND '20260731'
      UNION ALL
      SELECT 'purtc', COUNT(*)
        FROM purtc WHERE COMPANY=? AND TC003 BETWEEN '20260701' AND '20260731'
      UNION ALL
      SELECT 'purtg', COUNT(*)
        FROM purtg WHERE COMPANY=? AND TG014 BETWEEN '20260701' AND '20260731'`,
      [companyCode, companyCode, companyCode, companyCode, companyCode]
    );
    result.status = 'read_only_checked';
    result.tables = rows.map(row => ({ table_name: row.table_name, row_count: Number(row.row_count || 0) }));
    result.complete_native_chain = result.tables.every(row => Number(row.row_count) > 0);
    result.note = result.complete_native_chain
      ? '來源在此月份具備各核心表資料，仍須依來源鍵核對一對多關係。'
      : '來源沒有完整的 2026 年 7 月原生配銷鏈；ERP 測試資料需與來源資料分開呈現。';
  } catch (error) {
    result.status = 'unavailable';
    result.note = `來源唯讀檢查未完成：${String(error.message).slice(0, 300)}`;
  }
  return result;
}

async function targetQualitySnapshot(sourceName, documentNo = null) {
  return runWithTargetDatabase(sourceName, async () => {
    // These are target-side schemas.  The call never opens a write path to
    // SH; source databases are only queried by sourceJulyCheck() with SELECT.
    await ensureTargetSalesWorkflowSchema();
    await ensureTargetReceiptWorkflowSchema();

    const normalizedDocumentNo = trim(documentNo);
    const salesDocumentFilter = normalizedDocumentNo ? ' AND d.document_no=?' : '';
    const purchaseDocumentFilter = normalizedDocumentNo ? ' AND o.purchase_order_no=?' : '';

    const [salesIssues] = await pool.query(`
      SELECT d.id AS target_id, d.tenant_id, d.company_id, d.source_system,
        d.source_database, d.document_kind, d.document_type, d.document_no,
        d.document_date, d.status, d.note,
        COUNT(i.id) AS line_count,
        COALESCE(SUM(i.quantity),0) AS ordered_quantity,
        COALESCE(SUM(i.related_quantity),0) AS delivered_quantity,
        COALESCE(SUM(GREATEST(i.quantity-COALESCE(i.related_quantity,0),0)),0) AS remaining_quantity,
        SUM(CASE WHEN GREATEST(i.quantity-COALESCE(i.related_quantity,0),0)>? THEN 1 ELSE 0 END) AS remaining_line_count
      FROM sales_documents d
      JOIN sales_document_items i ON i.document_id=d.id
      WHERE d.source_database=?
        AND d.document_kind='sales_order'
        AND d.status IN ('completed','closed')
        ${salesDocumentFilter}
      GROUP BY d.id, d.tenant_id, d.company_id, d.source_system,
        d.source_database, d.document_kind, d.document_type, d.document_no,
        d.document_date, d.status, d.note
      HAVING remaining_quantity>?
      ORDER BY d.document_date, d.id`,
      [EPSILON, sourceName, ...(normalizedDocumentNo ? [normalizedDocumentNo] : []), EPSILON]
    );

    const [purchaseIssues] = await pool.query(`
      SELECT o.id AS target_id, o.tenant_id, o.company_id, o.source_system,
        o.source_database, 'purchase_order' AS document_kind, o.document_type,
        o.purchase_order_no AS document_no, o.order_date AS document_date,
        o.status, o.note,
        COUNT(i.id) AS line_count,
        COALESCE(SUM(i.qty_ordered),0) AS ordered_quantity,
        COALESCE(SUM(i.qty_received),0) AS received_quantity,
        COALESCE(SUM(i.qty_cancelled),0) AS cancelled_quantity,
        COALESCE(SUM(GREATEST(i.qty_ordered-i.qty_received-COALESCE(i.qty_cancelled,0),0)),0) AS remaining_quantity,
        SUM(CASE WHEN GREATEST(i.qty_ordered-i.qty_received-COALESCE(i.qty_cancelled,0),0)>? THEN 1 ELSE 0 END) AS remaining_line_count
      FROM procurement_orders o
      JOIN procurement_order_items i ON i.purchase_order_id=o.id
      WHERE o.source_database=? AND o.status='closed'
        ${purchaseDocumentFilter}
      GROUP BY o.id, o.tenant_id, o.company_id, o.source_system,
        o.source_database, o.document_type, o.purchase_order_no,
        o.order_date, o.status, o.note
      HAVING remaining_quantity>?
      ORDER BY o.order_date, o.id`,
      [EPSILON, sourceName, ...(normalizedDocumentNo ? [normalizedDocumentNo] : []), EPSILON]
    );

    const [testRows] = await pool.query(`
      SELECT 'sales_documents' AS data_area, COUNT(*) AS row_count
        FROM sales_documents
        WHERE source_database=? AND note LIKE '%FLOWAUDIT:%'
      UNION ALL
      SELECT 'procurement_orders', COUNT(*)
        FROM procurement_orders
        WHERE source_database=? AND note LIKE '%FLOWAUDIT:%'
      UNION ALL
      SELECT 'procurement_receipts', COUNT(*)
        FROM procurement_receipts
        WHERE source_database=? AND note LIKE '%FLOWAUDIT:%'
      UNION ALL
      SELECT 'erp_items', COUNT(*)
        FROM erp_items
        WHERE source_database=? AND source_table='FLOW_AUDIT_202607'`,
      [sourceName, sourceName, sourceName, sourceName]
    );

    return {
      salesIssues,
      purchaseIssues,
      testRows: testRows.map(row => ({ data_area: row.data_area, row_count: Number(row.row_count || 0) }))
    };
  });
}

function qualityRecord(sourceName, row, kind, batchId) {
  const sales = kind === 'sales';
  const documentNo = String(row.document_no);
  const lineCount = Number(row.remaining_line_count || 0);
  const remainingQuantity = Number(row.remaining_quantity || 0);
  const issueCode = sales ? 'SALES_ORDER_CLOSED_WITH_REMAINING_QTY' : 'PURCHASE_ORDER_CLOSED_WITH_REMAINING_QTY';
  const sourceTable = sales ? 'copta/coptb' : 'purtc/purtd';
  const sourceKey = `${sourceName}:${sourceTable}:${documentNo}`;
  const actual = sales
    ? {
        target_status: row.status,
        line_count: Number(row.line_count || 0),
        remaining_line_count: lineCount,
        ordered_quantity: Number(row.ordered_quantity || 0),
        delivered_quantity: Number(row.delivered_quantity || 0),
        remaining_quantity: remainingQuantity
      }
    : {
        target_status: row.status,
        line_count: Number(row.line_count || 0),
        remaining_line_count: lineCount,
        ordered_quantity: Number(row.ordered_quantity || 0),
        received_quantity: Number(row.received_quantity || 0),
        cancelled_quantity: Number(row.cancelled_quantity || 0),
        remaining_quantity: remainingQuantity
      };
  return {
    batch_id: batchId,
    tenant_id: row.tenant_id || sourceDatabases[sourceName]?.tenant_id || sourceName,
    company_id: row.company_id || sourceDatabases[sourceName]?.company_id || sourceName,
    source_system: row.source_system || sourceDatabases[sourceName]?.source_system || 'iSM',
    source_database: sourceName,
    issue_code: issueCode,
    severity: 'warning',
    source_table: sourceTable,
    source_key: sourceKey,
    target_table: sales ? 'sales_documents' : 'procurement_orders',
    target_id: Number(row.target_id),
    document_kind: row.document_kind,
    document_type: row.document_type,
    document_no: documentNo,
    line_no: null,
    item_code: null,
    expected_json: { remaining_quantity: 0, rule: '結案／完成單據不可帶有未交或未收量' },
    actual_json: actual,
    rule_description: sales
      ? '歷史銷售訂單已標示完成／結案，但標準 ERP 仍計算出未交量；來源結案語意與匯入後一對多交貨關係需要人工確認。'
      : '歷史採購單已標示結案，但標準 ERP 仍計算出未進貨量；來源結案語意與匯入後一對多進貨關係需要人工確認。',
    recommended_action: '預設保留警示；若確認要修正 ERP，建立目標端更正案件並依沖回／重開／重作流程處理，不回寫 SH／SC 原始資料。'
  };
}

async function upsertQualityRecord(record) {
  const [result] = await pool.query(`
    INSERT INTO erp_import_quality_issues
      (batch_id,tenant_id,company_id,source_system,source_database,issue_code,severity,status,
       source_table,source_key,target_table,target_id,document_kind,document_type,document_no,line_no,item_code,
       expected_json,actual_json,rule_description,recommended_action,last_seen_at)
    VALUES (?,?,?,?,?,?,?,'open',?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())
    ON DUPLICATE KEY UPDATE
      batch_id=COALESCE(VALUES(batch_id),batch_id),
      tenant_id=VALUES(tenant_id), company_id=VALUES(company_id), source_system=VALUES(source_system),
      target_table=VALUES(target_table), target_id=VALUES(target_id), document_kind=VALUES(document_kind),
      document_type=VALUES(document_type), document_no=VALUES(document_no), line_no=VALUES(line_no),
      item_code=VALUES(item_code), expected_json=VALUES(expected_json), actual_json=VALUES(actual_json),
      rule_description=VALUES(rule_description), recommended_action=VALUES(recommended_action),
      last_seen_at=NOW()`,
    [
      record.batch_id, record.tenant_id, record.company_id, record.source_system, record.source_database,
      record.issue_code, record.severity, record.source_table, record.source_key, record.target_table,
      record.target_id, record.document_kind, record.document_type, record.document_no, record.line_no,
      record.item_code, jsonValue(record.expected_json), jsonValue(record.actual_json),
      record.rule_description, record.recommended_action
    ]
  );
  return Number(result.insertId || 0);
}

async function scanQuality(sourceName, documentNo = null) {
  const normalizedDocumentNo = trim(documentNo);
  const snapshot = await targetQualitySnapshot(sourceName, normalizedDocumentNo);
  const batchId = await latestBatchId(sourceName);
  let created = 0;
  for (const row of snapshot.salesIssues) {
    const id = await upsertQualityRecord(qualityRecord(sourceName, row, 'sales', batchId));
    if (id) created += 1;
  }
  for (const row of snapshot.purchaseIssues) {
    const id = await upsertQualityRecord(qualityRecord(sourceName, row, 'purchase', batchId));
    if (id) created += 1;
  }
  const sourceCheck = await sourceJulyCheck(sourceName);
  const issueLineCount = [...snapshot.salesIssues, ...snapshot.purchaseIssues]
    .reduce((sum, row) => sum + Number(row.remaining_line_count || 0), 0);
  const result = {
    source_database: sourceName,
    scanned_sales_documents: snapshot.salesIssues.length,
    scanned_purchase_documents: snapshot.purchaseIssues.length,
    issue_document_count: snapshot.salesIssues.length + snapshot.purchaseIssues.length,
    issue_line_count: issueLineCount,
    created_or_updated_count: created,
    test_data: snapshot.testRows,
    source_july_check: sourceCheck,
    policy: 'warning_only_until_approved',
    policy_note: '匯入異常先保留警示；更正案件只記錄目標端決策，不會直接更新 SH／SC。',
    document_no: normalizedDocumentNo || null
  };
  const logBatchId = batchId;
  if (logBatchId) {
    await pool.query(
      'INSERT INTO erp_import_logs(batch_id,level,message,details_json) VALUES(?,?,?,?)',
      [logBatchId, issueLineCount ? 'warning' : 'info', `資料品質掃描完成：${result.issue_document_count} 張單據／${issueLineCount} 行待確認`, jsonValue(result)]
    );
  }
  return result;
}

async function listQuality(sourceName, req) {
  const conditions = ['source_database=?'];
  const params = [sourceName];
  const status = trim(req.query.status);
  const issueCode = trim(req.query.issue_code);
  const documentNo = trim(req.query.document_no);
  if (['open', 'acknowledged', 'correction_pending', 'resolved', 'ignored'].includes(status)) {
    conditions.push('status=?');
    params.push(status);
  }
  if (issueCode) {
    conditions.push('issue_code=?');
    params.push(issueCode);
  }
  if (documentNo) {
    conditions.push('document_no LIKE ?');
    params.push(`%${documentNo}%`);
  }
  const limit = limitFromRequest(req.query.limit, 200);
  const [rows] = await pool.query(`
    SELECT id,batch_id,tenant_id,company_id,source_system,source_database,issue_code,severity,status,
      source_table,source_key,target_table,target_id,document_kind,document_type,document_no,line_no,item_code,
      expected_json,actual_json,rule_description,recommended_action,resolution_type,resolution_note,correction_no,
      decided_by,decided_at,resolved_by,resolved_at,last_seen_at,created_at,updated_at
    FROM erp_import_quality_issues
    WHERE ${conditions.join(' AND ')}
    ORDER BY FIELD(status,'open','correction_pending','acknowledged','resolved','ignored'),created_at DESC,id DESC
    LIMIT ${limit}`, params);
  const [[summary]] = await pool.query(`
    SELECT COUNT(*) AS issue_count,
      SUM(status IN ('open','acknowledged','correction_pending')) AS active_count,
      SUM(status='resolved') AS resolved_count,
      SUM(status='ignored') AS ignored_count,
      SUM(severity='error') AS error_count,
      SUM(severity='warning') AS warning_count
    FROM erp_import_quality_issues WHERE ${conditions.join(' AND ')}`, params);
  const snapshot = await targetQualitySnapshot(sourceName, documentNo);
  return {
    rows,
    summary: {
      issue_count: Number(summary.issue_count || 0),
      active_count: Number(summary.active_count || 0),
      resolved_count: Number(summary.resolved_count || 0),
      ignored_count: Number(summary.ignored_count || 0),
      error_count: Number(summary.error_count || 0),
      warning_count: Number(summary.warning_count || 0),
      detected_sales_documents: snapshot.salesIssues.length,
      detected_purchase_documents: snapshot.purchaseIssues.length,
      detected_remaining_lines: [...snapshot.salesIssues, ...snapshot.purchaseIssues]
        .reduce((sum, row) => sum + Number(row.remaining_line_count || 0), 0)
    },
    origin: {
      target_test_data: snapshot.testRows,
      source_july_check: await sourceJulyCheck(sourceName),
      policy: 'warning_only_until_approved'
    }
  };
}

async function transitionQuality(id, action, req) {
  const body = req.body || {};
  const note = trim(body.note || body.resolution_note);
  return tx(async conn => {
    const [[issue]] = await conn.query(
      'SELECT * FROM erp_import_quality_issues WHERE id=? FOR UPDATE',
      [id]
    );
    if (!issue) throw notFound('找不到資料品質異常');
    const fromStatus = issue.status;
    let toStatus;
    let resolutionType = issue.resolution_type;
    let correction = issue.correction_no;
    if (['resolved', 'ignored'].includes(fromStatus)) throw badRequest('已結案的資料品質異常不可再次變更');
    if (action === 'acknowledge') {
      if (!['open', 'acknowledged'].includes(fromStatus)) throw badRequest('目前狀態不可確認警示');
      toStatus = 'acknowledged';
    } else if (action === 'correction') {
      resolutionType = trim(body.resolution_type) || 'target_correction';
      if (!['target_correction', 'import_rule'].includes(resolutionType)) throw badRequest('更正類型必須是目標端更正或匯入修復規則');
      if (!note) throw badRequest('建立更正案件必須填寫原因或處理說明');
      toStatus = 'correction_pending';
      correction = correction || correctionNo(id);
    } else if (action === 'resolve' || action === 'ignore') {
      if (!note) throw badRequest('結案或忽略必須填寫原因');
      resolutionType = action === 'ignore' ? 'ignored' : (trim(body.resolution_type) || 'warning_only');
      if (!['warning_only', 'import_rule', 'ignored'].includes(resolutionType)) throw badRequest('處理類型不正確');
      toStatus = action === 'ignore' ? 'ignored' : 'resolved';
    } else {
      throw badRequest('不支援的資料品質處理動作');
    }
    if (action !== 'acknowledge' && !note) throw badRequest('請填寫處理說明');
    await conn.query(`
      UPDATE erp_import_quality_issues
      SET status=?, resolution_type=?, resolution_note=CASE WHEN ?='' THEN resolution_note ELSE ? END,
          correction_no=?, decided_by=?, decided_at=NOW(),
          resolved_by=CASE WHEN ? IN ('resolved','ignored') THEN ? ELSE resolved_by END,
          resolved_at=CASE WHEN ? IN ('resolved','ignored') THEN NOW() ELSE resolved_at END
      WHERE id=?`,
      [toStatus, resolutionType, note, note, correction, req.auth.id,
        toStatus, req.auth.id, toStatus, id]
    );
    await conn.query(`
      INSERT INTO erp_import_quality_events(issue_id,action_code,from_status,to_status,note,actor_id)
      VALUES(?,?,?,?,?,?)`, [id, action, fromStatus, toStatus, note || null, req.auth.id]);
    return { id, action, from_status: fromStatus, status: toStatus, correction_no: correction, resolution_type: resolutionType };
  });
}

export function registerImportQualityRoutes(app) {
  app.get('/api/import/data-quality', async (req, res, next) => {
    try {
      await ensureImportQualitySchema();
      const sourceName = sourceFromRequest(req);
      res.json({ ok: true, data: await listQuality(sourceName, req) });
    } catch (error) { next(error); }
  });

  app.get('/api/import/data-quality/:id', async (req, res, next) => {
    try {
      await ensureImportQualitySchema();
      const sourceName = sourceFromRequest(req);
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) throw badRequest('資料品質異常識別碼錯誤');
      const [[issue]] = await pool.query('SELECT * FROM erp_import_quality_issues WHERE id=? AND source_database=?', [id, sourceName]);
      if (!issue) throw notFound('找不到資料品質異常');
      const [events] = await pool.query('SELECT * FROM erp_import_quality_events WHERE issue_id=? ORDER BY created_at DESC,id DESC', [id]);
      res.json({ ok: true, data: { issue, events } });
    } catch (error) { next(error); }
  });

  app.post('/api/import/data-quality/scan', async (req, res, next) => {
    try {
      if (req.auth?.role_code !== 'ADMIN') throw Object.assign(new Error('只有系統管理員可以執行資料品質掃描'), { status: 403 });
      await ensureImportQualitySchema();
      const sourceName = sourceFromRequest(req);
      res.json({ ok: true, data: await scanQuality(sourceName, req.body?.document_no) });
    } catch (error) { next(error); }
  });

  for (const action of ['acknowledge', 'correction', 'resolve', 'ignore']) {
    app.post(`/api/import/data-quality/:id/${action}`, async (req, res, next) => {
      try {
        if (req.auth?.role_code !== 'ADMIN') throw Object.assign(new Error('只有系統管理員可以處理資料品質異常'), { status: 403 });
        await ensureImportQualitySchema();
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id < 1) throw badRequest('資料品質異常識別碼錯誤');
        res.json({ ok: true, data: await transitionQuality(id, action, req) });
      } catch (error) { next(error); }
    });
  }
}
