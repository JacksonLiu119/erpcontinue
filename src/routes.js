import { pool, getSourcePool, sourceDatabases, reloadSourceDatabases, runWithTargetDatabase, tx, ensureProcurementSchema, ensureTargetProcurementTypeSchema, ensureTargetReceiptWorkflowSchema, ensureTargetReversalSchema, ensureTargetSalesWorkflowSchema, ensureTargetSalesCustomerItemSchema, ensureTargetSalesPricingSchema, ensureTargetSalesForecastSchema, ensureTargetDocumentNatureSchema, ensureTargetFinanceWorkflowSchema, validateOperationalSource } from './db.js';
import { hashPassword, getDepartmentScope, recordAccessAudit } from './auth.js';
import { registerImportQualityRoutes } from './import-quality.js';
import { registerReportingRoutes } from './reports.js';
import { registerSourceFinancialPreviewRoutes } from './source-financial-preview.js';
import { registerSalesForecastRoutes, resolveSalesForecastOrderLink, refreshSalesForecastMetrics } from './sales-forecast.js';

const listTables = {
  customers: ['id', 'code', 'name', 'tax_id', 'contact_name', 'phone', 'email', 'address', 'credit_limit', 'is_active'],
  suppliers: ['id', 'code', 'name', 'tax_id', 'contact_name', 'phone', 'email', 'address', 'is_active'],
  products: ['id', 'sku', 'name', 'spec', 'unit', 'standard_cost', 'sale_price', 'safety_stock', 'is_lot_tracked', 'is_active'],
  warehouses: ['id', 'code', 'name', 'is_active']
};

const basicDataSources = {
  company: { program: 'CMSI11', name: '公司資料／稅籍資料', table: 'cmsml', fields: 'ML001 AS company_code, ML002 AS short_name, ML003 AS company_name, ML005 AS phone, ML007 AS tax_id, ML012 AS address', search: ['ML001', 'ML002', 'ML003', 'ML007'] },
  common: { program: 'CMSI01', name: '共用參數', table: 'cmsma', fields: 'MA001 AS tax_rate, MA002 AS separator, MA003 AS currency_code, MA004 AS tax_rate_value, MA007 AS account_name', search: ['MA001', 'MA003', 'MA007'] },
  categories: { program: 'INVI01', name: '品號類別', table: 'invma', fields: 'MA001 AS category_type, MA002 AS category_code, MA003 AS category_name', search: ['MA001', 'MA002', 'MA003'] },
  encoding: { program: 'CMSI07', name: '編碼原則', table: 'cmsmh', fields: 'MH001 AS rule_type, MH002 AS rule_result, MH003 AS rule_code, MH004 AS default_name', search: ['MH001', 'MH002', 'MH003', 'MH004'] },
  warehouses: { program: 'CMSI03', name: '庫別', table: 'cmsmc', fields: 'MC001 AS warehouse_code, MC002 AS warehouse_name, MC003 AS site_code, MC004 AS warehouse_type, MC005 AS allow_in, MC006 AS allow_out', search: ['MC001', 'MC002', 'MC003'] },
  productionLines: { program: 'CMSI04', name: '生產線', table: 'cmsmd', fields: 'MD001 AS line_code, MD002 AS line_name, MD004 AS daily_capacity', search: ['MD001', 'MD002'] },
  departments: { program: 'CMSI05', name: '部門', table: 'cmsme', fields: 'ME001 AS department_code, ME002 AS department_name, ME004 AS depreciation_account', search: ['ME001', 'ME002'] },
  employees: { program: 'CMSI10', name: '員工', table: 'cmsmv', fields: 'MV001 AS employee_code, MV002 AS employee_name, MV004 AS department_code, MV020 AS email', search: ['MV001', 'MV002', 'MV004'] },
  roles: { program: 'CMSI09', name: '職務類別', table: 'cmsmj', fields: 'MJ001 AS role_code, MJ002 AS role_type, MJ003 AS role_name', search: ['MJ001', 'MJ002', 'MJ003'] },
  currencies: { program: 'CMSI06', name: '幣別匯率', table: 'cmsmf', fields: 'MF001 AS currency_code, MF002 AS currency_name, MF003 AS decimal_places, MF007 AS note', search: ['MF001', 'MF002'] },
  items: { program: 'INVI02', name: '品號資料', table: 'invmb', fields: 'MB001 AS item_code, MB002 AS item_name, MB003 AS specification, MB004 AS unit, MB005 AS category_1, MB006 AS category_2', search: ['MB001', 'MB002', 'MB003'] },
  customers: { program: 'COP master', name: '客戶資料', table: 'copma', fields: 'MA001 AS customer_code, MA003 AS customer_name, MA004 AS short_name, MA006 AS phone', search: ['MA001', 'MA003', 'MA004'] },
  suppliers: { program: 'PUR master', name: '廠商資料', table: 'purma', fields: 'MA001 AS supplier_code, MA003 AS supplier_name, MA004 AS short_name, MA006 AS phone', search: ['MA001', 'MA003', 'MA004'] }
};

const sourceBasicDataSources = {
  'ism-sh': basicDataSources,
  'ism-smartdscsys': {
    company: { program: 'DSCMB', name: '公司／資料庫註冊', table: 'dscmb', fields: 'MB001 AS company_code, MB002 AS company_name, MB003 AS database_code', search: ['MB001', 'MB002', 'MB003'] },
    employees: { program: 'DSCMA', name: '系統使用者', table: 'dscma', fields: 'MA001 AS user_code, MA002 AS user_name, MA003 AS user_key', search: ['MA001', 'MA002'] },
    common: { program: 'DSCMF', name: '公司資料索引', table: 'dscmf', fields: 'MF001 AS system_code, MF002 AS company_code, MF003 AS company_name, MF004 AS created_date', search: ['MF001', 'MF002', 'MF003'] },
    banks: { program: 'CMSI06', name: '銀行資料', table: 'cmsmo', fields: 'MO001 AS bank_code, MO002 AS branch_code, MO003 AS bank_type, MO004 AS bank_short_name, MO005 AS bank_alias, MO006 AS bank_name', search: ['MO001', 'MO002', 'MO004', 'MO005', 'MO006'] },
    userNotes: { program: 'CMSMM', name: '使用者備註資料', table: 'cmsmm', fields: 'MM001 AS user_code, MM002 AS sequence_no, MM003 AS note', search: ['MM001', 'MM002', 'MM003'] },
  },
  'ism-dscrpt': {
    reports: { program: 'DSCRPT', name: '報表格式', table: 'fmtrpt', fields: 'RPTNAME AS report_code, USERID AS user_id, EXTNAME AS extension, FORMATNO AS format_no, MEMOLIST AS report_title, ISDEFAULT AS is_default', search: ['RPTNAME', 'USERID', 'MEMOLIST'] },
    reportFields: { program: 'DSCRPT', name: '報表欄位', table: 'fmtfield', fields: 'RPTNAME AS report_code, USERID AS user_id, FORMATNO AS format_no, FIELDORDER AS field_order, FIELDNO AS field_no, FIELDTITLE AS field_title, DATATYPE AS data_type', search: ['RPTNAME', 'USERID', 'FIELDTITLE'] },
  },
};

function getBasicDataSources(sourceName) {
  const adapterCode = sourceDatabases[sourceName]?.adapter_code;
  return sourceBasicDataSources[adapterCode] || basicDataSources;
}

function normalizeContextKey(value) {
  const key = String(value ?? '').trim().toUpperCase();
  return key || null;
}

function uniqueContextValues(values) {
  return [...new Set(values.map(normalizeContextKey).filter(Boolean))];
}

function isControlApiPath(path) {
  return [
    '/api/company-contexts', '/api/source-databases', '/api/master-source-mappings',
    '/api/import/', '/api/access-users', '/api/access-roles', '/api/access-role-permissions',
    '/api/access-departments', '/api/access-audit',
    '/api/reports/definitions'
  ].some(prefix => path === prefix || path.startsWith(prefix));
}

function normalizeDepartmentValue(value) {
  const code = String(value ?? '').trim().toUpperCase();
  return code || null;
}

function uniqueDepartmentValues(values) {
  return [...new Set(values.map(normalizeDepartmentValue).filter(Boolean))];
}

function isDepartmentScopedPath(path) {
  return [
    '/api/sh/', '/api/master/departments', '/api/master/employees',
    '/api/procurement/', '/api/sales-workflow/', '/api/inventory-workflow/',
    '/api/inventory-opening', '/api/finance-workflow/', '/api/accounting/',
    '/api/flow-audit/', '/api/reports/'
  ].some(prefix => path === prefix || path.startsWith(prefix));
}

function scopedRowHasDepartment(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).some(key => key === 'department_code' || /_department_code$/i.test(key));
}

function scopedRowDepartmentCodes(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value)
    .filter(([key]) => key === 'department_code' || /_department_code$/i.test(key))
    .map(([, item]) => normalizeDepartmentValue(item))
    .filter(Boolean);
}

function scopedRowAllowed(value, allowedCodes) {
  const codes = scopedRowDepartmentCodes(value);
  // 沒有部門值的公司層級資料不因部門範圍被誤當成其他部門；
  // 有明確部門值時，所有部門欄位都必須在授權集合內。
  return !codes.length || codes.every(code => allowedCodes.has(code));
}

function filterDepartmentPayload(value, allowedCodes) {
  if (Array.isArray(value)) {
    return value.filter(item => !scopedRowHasDepartment(item) || scopedRowAllowed(item, allowedCodes))
      .map(item => filterDepartmentPayload(item, allowedCodes));
  }
  if (!value || typeof value !== 'object') return value;
  if (scopedRowHasDepartment(value) && !scopedRowAllowed(value, allowedCodes)) return null;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, filterDepartmentPayload(item, allowedCodes)]));
}

async function recordAccessDenied(req, { actionCode = 'ACCESS_DENIED', sourceKey = null, departmentCode = null, reason }) {
  try {
    await recordAccessAudit({
      actorUserId:req.auth?.id, targetUserId:req.auth?.id, actionCode, entityType:'access_request',
      entityId:`${req.method} ${req.path}`, sourceKey, departmentCode, reason,
      ipAddress:req.ip, userAgent:req.get('user-agent')
    });
  } catch (error) {
    // 權限拒絕不能因為稽核寫入失敗而放行；將錯誤留在伺服器紀錄供管理員處理。
    console.error('Access audit write failed:', error.message);
  }
}

export function registerApi(app) {
  // 公司別與來源資料庫必須成對驗證。來源資料庫本身仍維持唯讀，
  // 所有新 ERP 查詢／寫入都只能使用登入工作階段目前固定的公司上下文。
  // 這個中介層套用到所有互動式 API，避免只修正某一支畫面而留下跨公司例外。
  app.use(async (req, res, next) => {
    // 這兩支是用來取得可切換清單的控制 API，必須先允許它們回應，
    // 才能把瀏覽器舊的 localStorage 公司別校正成登入工作階段的公司別。
    if (req.path === '/api/company-contexts' || req.path === '/api/source-databases') return next();

    const sourceCandidates = uniqueContextValues([
      req.query.source_database, req.query.db, req.body?.source_database,
      req.headers['x-source-database'], req.headers['x-erp-context-key']
    ]);
    if (sourceCandidates.length > 1) {
      await recordAccessDenied(req, { actionCode:'CROSS_COMPANY_REQUEST_REJECTED', sourceKey:sourceCandidates[0], reason:'請求同時帶入不同公司／資料庫來源' });
      return res.status(409).json({ ok:false, error:'公司上下文來源不一致，已拒絕此請求。請重新整理後再操作。' });
    }
    const requestedSource = sourceCandidates[0] || null;
    if (requestedSource && !sourceDatabases[requestedSource]) {
      await recordAccessDenied(req, { actionCode:'UNKNOWN_COMPANY_REQUEST_REJECTED', sourceKey:requestedSource, reason:'請求指定不存在或未啟用的公司／資料庫來源' });
      return res.status(400).json({ ok:false, error:`不允許的資料庫來源：${requestedSource}` });
    }

    const sessionSource = normalizeContextKey(req.auth?.current_source_key);
    if (sessionSource && requestedSource && sessionSource !== requestedSource) {
      await recordAccessDenied(req, { actionCode:'CROSS_COMPANY_REQUEST_REJECTED', sourceKey:requestedSource, reason:`登入工作階段固定為 ${sessionSource}，不可改用 ${requestedSource}` });
      return res.status(409).json({ ok:false, error:`目前登入公司為 ${sessionSource}，不可從此作業指定 ${requestedSource}。` });
    }
    const sourceName = sessionSource || requestedSource;
    if (!sourceName) {
      if (isControlApiPath(req.path)) return next();
      return res.status(403).json({ ok:false, error:'目前登入帳號尚未設定可用的公司別，無法執行此作業。' });
    }
    const source = sourceDatabases[sourceName];
    if (!source) return res.status(400).json({ ok:false, error:`不允許的資料庫來源：${sourceName}` });

    if (req.auth?.role_code !== 'ADMIN') {
      const [[access]] = await pool.query('SELECT 1 allowed FROM access_user_companies WHERE user_id=? AND source_key=?', [req.auth.id, sourceName]);
      if (!access) {
        await recordAccessDenied(req, { actionCode:'CROSS_COMPANY_REQUEST_REJECTED', sourceKey:sourceName, reason:'帳號未被授權進入此公司別' });
        return res.status(403).json({ ok:false, error:'您沒有此公司別的存取權限。' });
      }
    }
    const companyCandidates = uniqueContextValues([
      req.query.company_id, req.body?.company_id, req.headers['x-company-id']
    ]);
    const expectedCompany = normalizeContextKey(source.company_id || sourceName);
    if (companyCandidates.some(companyId => companyId !== expectedCompany)) {
      await recordAccessDenied(req, { actionCode:'CROSS_COMPANY_REQUEST_REJECTED', sourceKey:sourceName, reason:'公司代號與資料庫來源不一致' });
      return res.status(409).json({ ok:false, error:'公司別與資料庫來源不一致，為避免資料混用已拒絕此請求。' });
    }

    const departmentCandidates = uniqueDepartmentValues([
      req.query.department_code, req.query.department,
      req.body?.department_code, req.body?.department,
      req.headers['x-department-code'], req.headers['x-erp-department-code']
    ]);
    if (departmentCandidates.length > 1) {
      await recordAccessDenied(req, { actionCode:'CROSS_DEPARTMENT_REQUEST_REJECTED', sourceKey:sourceName, reason:'請求同時帶入不同部門範圍' });
      return res.status(409).json({ ok:false, error:'部門範圍參數不一致，已拒絕此請求。請重新整理後再操作。' });
    }
    const requestedDepartment = departmentCandidates[0] || null;
    const departmentScope = req.auth?.role_code === 'ADMIN'
      ? { source_key:sourceName, mode:'all', department_codes:[] }
      : await getDepartmentScope(req.auth.id, sourceName);
    if (req.auth?.role_code !== 'ADMIN' && departmentScope.mode === 'selected') {
      if (requestedDepartment && !departmentScope.department_codes.includes(requestedDepartment)) {
        await recordAccessDenied(req, { actionCode:'CROSS_DEPARTMENT_REQUEST_REJECTED', sourceKey:sourceName, departmentCode:requestedDepartment, reason:`部門不在帳號授權範圍：${departmentScope.department_codes.join('、')}` });
        return res.status(403).json({ ok:false, error:`您沒有部門 ${requestedDepartment} 的存取權限。` });
      }
      if (!requestedDepartment && isDepartmentScopedPath(req.path)) {
        await recordAccessDenied(req, { actionCode:'DEPARTMENT_CONTEXT_REQUIRED', sourceKey:sourceName, reason:'此帳號已設定指定部門範圍，但請求未帶入目前部門' });
        return res.status(403).json({ ok:false, error:'此帳號已限制部門範圍，請先在上方選擇目前部門後再操作。' });
      }
    }
    if (requestedDepartment) {
      req.query.department_code = requestedDepartment;
      if (req.body && typeof req.body === 'object' && !Array.isArray(req.body) && !req.body.department_code) {
        req.body.department_code = requestedDepartment;
      }
    }

    req.erpContext = {
      context_key: sourceName, source_database: sourceName, tenant_id: source.tenant_id,
      company_id: source.company_id, source_system: source.source_system,
      target_database: source.target_database, read_only: source.read_only,
      department_scope_mode:departmentScope.mode,
      department_codes:departmentScope.department_codes,
      department_code:requestedDepartment
    };
    if (req.auth?.role_code !== 'ADMIN' && departmentScope.mode === 'selected') {
      const allowedCodes = new Set(departmentScope.department_codes);
      const sendJson = res.json.bind(res);
      res.json = payload => sendJson(filterDepartmentPayload(payload, allowedCodes));
    }
    // 讓既有各路由即使沒有顯式帶 source_database，也只能使用目前工作階段的公司。
    req.query.source_database = sourceName;
    req.query.db = sourceName;
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body) && !req.body.source_database) {
      req.body.source_database = sourceName;
    }
    if (isControlApiPath(req.path)) return next();
    return runWithTargetDatabase(sourceName, next);
  });
  app.use('/api/sh', (req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      return res.status(410).json({ ok:false, error:'客戶來源資料庫已設定為唯讀，請使用新 ERP 主檔作業。' });
    }
    next();
  });
  registerImportQualityRoutes(app);
  registerReportingRoutes(app);
  registerCanonicalMasterRoutes(app);
  registerInventoryOpeningRoutes(app);
  app.get('/api/company-contexts', async (_req, res, next) => {
    try {
      await ensureProcurementSchema();
      const [rows] = await pool.query(`
        SELECT s.source_key AS context_key, s.source_key AS source_database,
          s.tenant_id, s.company_id, s.source_system, s.database_name, s.target_database,
          s.label AS source_label, s.read_only,
          COALESCE(c.company_code, s.company_id, s.source_key) AS company_code,
          COALESCE(c.short_name, s.source_key) AS short_name,
          COALESCE(c.company_name, s.label) AS company_name,
          c.tax_id,
          CASE WHEN c.id IS NULL THEN 0 ELSE 1 END AS has_company_master
        FROM erp_data_sources s
        LEFT JOIN erp_companies c
          ON c.id = (
            SELECT MIN(c2.id) FROM erp_companies c2
            WHERE c2.source_database=s.source_key
              AND c2.tenant_id=s.tenant_id
              AND c2.source_system=s.source_system
          )
        WHERE s.enabled=1
          AND (?='ADMIN' OR EXISTS(SELECT 1 FROM access_user_companies auc WHERE auc.user_id=? AND auc.source_key=s.source_key))
        ORDER BY s.sort_order, s.source_key`, [_req.auth.role_code, _req.auth.id]);
      res.json({ ok:true, data:rows });
    } catch (error) { next(error); }
  });
  app.get('/api/source-databases', async (_req, res, next) => {
    try {
      const [rows] = await pool.query('SELECT SCHEMA_NAME AS schema_name FROM information_schema.SCHEMATA');
      const existing = new Set(rows.map(row => String(row.schema_name).toLowerCase()));
      const [allowedRows] = _req.auth.role_code === 'ADMIN' ? [[]] : await pool.query('SELECT source_key FROM access_user_companies WHERE user_id=?', [_req.auth.id]);
      const allowed = new Set(allowedRows.map(row => String(row.source_key).toUpperCase()));
      const entries = Object.entries(sourceDatabases).filter(([key]) => _req.auth.role_code === 'ADMIN' || allowed.has(key));
      const data = await Promise.all(entries.map(async ([key, source]) => {
        const exists = existing.has(source.database.toLowerCase());
        let tableCount = 0;
        if (exists) {
          const [[count]] = await pool.query('SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [source.database]);
          tableCount = Number(count.count);
        }
        return { key, label: source.label, database: source.database, target_database: source.target_database, tenant_id: source.tenant_id, company_id: source.company_id, source_system: source.source_system, exists, tableCount };
      }));
      res.json({ ok: true, data });
    } catch (error) { next(error); }
  });

  app.get('/api/master-source-mappings', async (req, res, next) => {
    try {
      await ensureProcurementSchema();
      const sourceDatabase = String(req.query.db || '').trim().toUpperCase();
      const entity = String(req.query.entity || '').trim();
      const conditions = [];
      const params = [];
      if (sourceDatabase) { conditions.push('source_database = ?'); params.push(sourceDatabase); }
      if (entity) { conditions.push('standard_entity = ?'); params.push(entity); }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const [rows] = await pool.query(`SELECT id, source_database, source_table, source_field,
        standard_entity, standard_table, standard_field, mapping_type, transform_rule,
        is_key, mapping_status, evidence_status, note
        FROM erp_master_source_mappings ${where}
        ORDER BY source_database, standard_entity, sort_order, id`, params);
      res.json({ ok:true, data:rows, source:'inventory_erp.erp_master_source_mappings' });
    } catch (error) { next(error); }
  });

  app.get('/api/import/batches', async (req, res, next) => {
    try {
      await ensureProcurementSchema();
      const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
      const [rows] = await pool.query(`SELECT b.id, b.batch_no, b.tenant_id, b.company_id, b.source_system,
        b.source_database, b.status, b.started_at, b.completed_at, b.total_tables, b.total_rows,
        b.imported_rows, b.skipped_rows, b.error_rows, b.notes, b.created_at,
        (SELECT COUNT(*) FROM erp_import_errors e WHERE e.batch_id=b.id AND e.status='open') AS open_error_count
        FROM erp_import_batches b ORDER BY b.created_at DESC LIMIT ${limit}`);
      res.json({ ok:true, data:rows });
    } catch (error) { next(error); }
  });

  app.get('/api/import/batches/:id', async (req, res, next) => {
    try {
      await ensureProcurementSchema();
      const id = Number(req.params.id);
      const [[batch]] = await pool.query('SELECT * FROM erp_import_batches WHERE id=?', [id]);
      if (!batch) throw notFound('找不到匯入批次');
      const [reconciliations] = await pool.query('SELECT * FROM erp_import_reconciliations WHERE batch_id=? ORDER BY source_table, target_table', [id]);
      const [errors] = await pool.query('SELECT id, source_table, source_key, error_code, error_message, status, resolved_by, resolved_at, created_at FROM erp_import_errors WHERE batch_id=? ORDER BY created_at DESC', [id]);
      const [logs] = await pool.query('SELECT id, level, message, details_json, created_at FROM erp_import_logs WHERE batch_id=? ORDER BY created_at DESC', [id]);
      res.json({ ok:true, data:{ batch, reconciliations, errors, logs } });
    } catch (error) { next(error); }
  });

  app.post('/api/import/batches', async (req, res, next) => {
    try {
      if (req.auth?.role_code !== 'ADMIN') throw Object.assign(new Error('只有系統管理員可以建立匯入批次'), { status:403 });
      await ensureProcurementSchema();
      const sourceName = String(req.body?.source_database || 'SH').trim().toUpperCase();
      const source = sourceDatabases[sourceName];
      if (!source) throw badRequest(`不存在的來源資料庫：${sourceName}`);
      const now = new Date();
      const stamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
      const batchNo = `IMP-${stamp}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const [result] = await pool.query(`INSERT INTO erp_import_batches
        (batch_no, tenant_id, company_id, source_system, source_database, status, initiated_by, notes)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`, [
        batchNo, source.tenant_id, source.company_id, source.source_system, sourceName,
        req.auth?.user_id || null, String(req.body?.notes || '').trim() || null
      ]);
      await pool.query('INSERT INTO erp_import_logs (batch_id, level, message) VALUES (?, ?, ?)', [result.insertId, 'info', '建立匯入批次']);
      res.status(201).json({ ok:true, data:{ id:result.insertId, batch_no:batchNo } });
    } catch (error) { next(error); }
  });

  app.post('/api/import/batches/:id/reconciliations', async (req, res, next) => {
    try {
      if (req.auth?.role_code !== 'ADMIN') throw Object.assign(new Error('只有系統管理員可以寫入匯入核對結果'), { status:403 });
      const id = Number(req.params.id); const body = req.body || {};
      const sourceTable = String(body.source_table || '').trim(); const targetTable = String(body.target_table || '').trim();
      if (!sourceTable || !targetTable) throw badRequest('來源表與目標表不可空白');
      await pool.query(`INSERT INTO erp_import_reconciliations
        (batch_id, source_table, target_table, source_count, target_count, imported_count, skipped_count, error_count, status, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE source_count=VALUES(source_count), target_count=VALUES(target_count), imported_count=VALUES(imported_count), skipped_count=VALUES(skipped_count), error_count=VALUES(error_count), status=VALUES(status), note=VALUES(note)`, [
        id, sourceTable, targetTable, Number(body.source_count || 0), Number(body.target_count || 0), Number(body.imported_count || 0), Number(body.skipped_count || 0), Number(body.error_count || 0), String(body.status || 'completed'), String(body.note || '').trim() || null
      ]);
      res.json({ ok:true });
    } catch (error) { next(error); }
  });

  app.post('/api/import/batches/:id/errors', async (req, res, next) => {
    try {
      if (req.auth?.role_code !== 'ADMIN') throw Object.assign(new Error('只有系統管理員可以寫入匯入錯誤'), { status:403 });
      const id = Number(req.params.id); const body = req.body || {};
      if (!body.source_table || !body.error_code || !body.error_message) throw badRequest('來源表、錯誤代碼與錯誤訊息不可空白');
      const payload = body.payload == null ? null : JSON.stringify(body.payload);
      const [result] = await pool.query(`INSERT INTO erp_import_errors
        (batch_id, source_table, source_key, error_code, error_message, payload_json)
        VALUES (?, ?, ?, ?, ?, ?)`, [id, String(body.source_table), body.source_key ? String(body.source_key) : null, String(body.error_code), String(body.error_message), payload]);
      res.status(201).json({ ok:true, data:{ id:result.insertId } });
    } catch (error) { next(error); }
  });

  app.patch('/api/import/errors/:id/resolve', async (req, res, next) => {
    try {
      if (req.auth?.role_code !== 'ADMIN') throw Object.assign(new Error('只有系統管理員可以處理匯入錯誤'), { status:403 });
      const [result] = await pool.query(`UPDATE erp_import_errors SET status='resolved', resolved_by=?, resolved_at=NOW() WHERE id=?`, [req.auth?.user_id || null, Number(req.params.id)]);
      if (!result.affectedRows) throw notFound('找不到匯入錯誤');
      res.json({ ok:true });
    } catch (error) { next(error); }
  });

  app.post('/api/source-databases', async (req, res, next) => {
    try {
      if (req.auth?.role_code !== 'ADMIN') throw Object.assign(new Error('僅系統管理員可新增資料庫來源'), { status:403 });
      const body = req.body || {};
      const sourceKey = String(body.source_key || '').trim().toUpperCase();
      const label = String(body.label || '').trim();
      const adapterCode = String(body.adapter_code || '').trim();
      const databaseName = String(body.database_name || '').trim();
      if (!/^[A-Z0-9_-]{2,60}$/.test(sourceKey) || !label || !adapterCode || !/^[A-Za-z0-9_$-]{1,120}$/.test(databaseName)) {
        throw badRequest('來源代號、名稱、轉接器與資料庫名稱為必填');
      }
      const connectionConfig = {
        host: String(body.host || '127.0.0.1'), port: Number(body.port || 3306),
        username: String(body.username || 'root'), password_env: String(body.password_env || '') || null,
        database_name: databaseName,
      };
      const validation = await validateOperationalSource(connectionConfig);
      if (!validation.passed) {
        const missing = Object.entries(validation.modules).filter(([,value]) => !value.passed).map(([name]) => name).join('、');
        throw badRequest(`此資料庫未通過營運資料驗證，缺少有效資料模組：${missing}。不會加入公司切換清單。`);
      }
      await pool.query(`INSERT INTO erp_data_sources
        (source_key, label, adapter_code, host, port, database_name, target_database, username, password_env, tenant_id, company_id, source_system, enabled, read_only, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        sourceKey, label, adapterCode, String(body.host || '127.0.0.1'), Number(body.port || 3306),
        databaseName, String(body.target_database || process.env.DB_NAME || 'inventory_erp'), String(body.username || 'root'), String(body.password_env || '') || null,
        String(body.tenant_id || sourceKey).trim(), String(body.company_id || sourceKey).trim(), String(body.source_system || 'iSM').trim(),
        body.enabled === false ? 0 : 1, body.read_only === false ? 0 : 1, Number(body.sort_order || 100)
      ]);
      await reloadSourceDatabases();
      res.status(201).json({ ok:true, data:{ source_key:sourceKey, validation } });
    } catch (error) { if (error.code === 'ER_DUP_ENTRY') error = badRequest('資料來源代號已存在'); next(error); }
  });

  app.put('/api/source-databases/:key', async (req, res, next) => {
    try {
      if (req.auth?.role_code !== 'ADMIN') throw Object.assign(new Error('僅系統管理員可修改資料庫來源'), { status:403 });
      const sourceKey = String(req.params.key || '').trim().toUpperCase();
      const body = req.body || {};
      const label = String(body.label || '').trim();
      const adapterCode = String(body.adapter_code || '').trim();
      const databaseName = String(body.database_name || '').trim();
      if (!sourceDatabases[sourceKey] || !label || !adapterCode || !/^[A-Za-z0-9_$-]{1,120}$/.test(databaseName)) throw badRequest('資料來源不存在或設定不完整');
      await pool.query(`UPDATE erp_data_sources SET label=?, adapter_code=?, host=?, port=?, database_name=?, target_database=?,
        username=?, password_env=?, tenant_id=?, company_id=?, source_system=?, enabled=?, read_only=?, sort_order=? WHERE source_key=?`, [
        label, adapterCode, String(body.host || '127.0.0.1'), Number(body.port || 3306), databaseName,
        String(body.target_database || process.env.DB_NAME || 'inventory_erp'), String(body.username || 'root'), String(body.password_env || '') || null,
        String(body.tenant_id || sourceKey).trim(), String(body.company_id || sourceKey).trim(), String(body.source_system || 'iSM').trim(),
        body.enabled === false ? 0 : 1, body.read_only === false ? 0 : 1, Number(body.sort_order || 100), sourceKey
      ]);
      await reloadSourceDatabases();
      res.json({ ok:true, data:{ source_key:sourceKey } });
    } catch (error) { next(error); }
  });

  app.get('/api/sh/basic-data', async (_req, res, next) => {
    try {
      const sourceName = sourceDbFromRequest(_req);
      const sourcePool = getSourcePool(sourceName);
      const mappedSources = getBasicDataSources(sourceName);
      const [tableRows] = await sourcePool.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()'
      );
      const availableTables = new Set(tableRows.map(row => String(row.TABLE_NAME).toLowerCase()));
      const data = await Promise.all(Object.entries(mappedSources).map(async ([key, source]) => {
        if (!availableTables.has(source.table.toLowerCase())) {
          return { key, ...source, count: 0, status: 'table-not-found' };
        }
        const [[row]] = await sourcePool.query(`SELECT COUNT(*) AS count FROM ${source.table}`);
        return { key, ...source, count: Number(row.count), status: 'schema-confirmed' };
      }));
      res.json({ ok: true, data, source: `${sourceName} information_schema + mapped tables` });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/sh/basic-data/:key', async (req, res, next) => {
    try {
      const sourceName = sourceDbFromRequest(req);
      const sourcePool = getSourcePool(sourceName);
      const mappedSources = getBasicDataSources(sourceName);
      const source = mappedSources[req.params.key];
      if (!source) throw badRequest('找不到基本資料來源');
      const [[table]] = await sourcePool.query(
        'SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = LOWER(?)',
        [source.table]
      );
      if (!Number(table.count)) {
        return res.json({ ok: true, data: [], source: `${sourceName}.${source.table}`, program: source.program, status: 'table-not-found' });
      }
      const keyword = String(req.query.keyword || '').trim();
      const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
      const params = [];
      const where = keyword ? `WHERE CONCAT_WS(' ', ${source.search.join(', ')}) LIKE ?` : '';
      if (keyword) params.push(`%${keyword}%`);
      params.push(limit);
      const [rows] = await sourcePool.query(`SELECT ${source.fields} FROM ${source.table} ${where} LIMIT ?`, params);
      res.json({ ok: true, data: rows, source: `${sourceName}.${source.table}`, program: source.program });
    } catch (error) {
      next(error);
    }
  });

  for (const [table, fields] of Object.entries(listTables)) {
    app.get(`/api/${table}`, async (req, res, next) => {
      try {
        const keyword = table === 'warehouses' ? String(req.query.keyword || '').trim() : '';
        const where = keyword ? 'WHERE code LIKE :keyword OR name LIKE :keyword' : '';
        const [rows] = await pool.query(`SELECT ${fields.join(', ')} FROM ${table} ${where} ORDER BY id DESC LIMIT 200`, keyword ? { keyword: `%${keyword}%` } : undefined);
        res.json({ ok: true, data: rows });
      } catch (error) {
        next(error);
      }
    });

    app.post(`/api/${table}`, async (req, res, next) => {
      try {
        const payload = pick(req.body, fields.filter((field) => field !== 'id'));
        const keys = Object.keys(payload);
        if (keys.length === 0) throw badRequest('沒有可新增的欄位');
        const placeholders = keys.map((key) => `:${key}`).join(', ');
        const [result] = await pool.query(
          `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`,
          payload
        );
        res.status(201).json({ ok: true, id: result.insertId });
      } catch (error) {
        next(error);
      }
    });

    app.put(`/api/${table}/:id`, async (req, res, next) => {
      try {
        const payload = pick(req.body, fields.filter((field) => field !== 'id'));
        const keys = Object.keys(payload);
        if (keys.length === 0) throw badRequest('沒有可更新的資料');
        const set = keys.map((key) => `${key} = :${key}`).join(', ');
        payload.id = Number(req.params.id);
        const [result] = await pool.query(`UPDATE ${table} SET ${set} WHERE id = :id`, payload);
        if (result.affectedRows === 0) throw notFound('找不到要修改的資料');
        res.json({ ok: true, id: payload.id });
      } catch (error) {
        next(error);
      }
    });
  }

  app.get('/api/inventory', async (_req, res, next) => {
    try {
      const [rows] = await pool.query(`
        SELECT
          p.id AS product_id,
          p.sku,
          p.name AS product_name,
          p.unit,
          p.safety_stock,
          w.code AS warehouse_code,
          w.name AS warehouse_name,
          s.lot_no,
          s.qty_on_hand,
          s.qty_reserved,
          (s.qty_on_hand - s.qty_reserved) AS qty_available
        FROM inventory_stock s
        JOIN products p ON p.id = s.product_id
        JOIN warehouses w ON w.id = s.warehouse_id
        ORDER BY p.sku, w.code, s.lot_no
      `);
      res.json({ ok: true, data: rows });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/sh/inventory', async (req, res, next) => {
    try {
      const sourceName = sourceDbFromRequest(req);
      const sourcePool = getSourcePool(sourceName);
      const keyword = String(req.query.keyword || '').trim();
      const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 100);
      const params = [];
      let where = '';
      if (keyword) {
        where = `WHERE CONCAT_WS(' ', d.TB004, d.TB005, h.TA001, h.TA002, d.TB012, w.MC002) LIKE ?`;
        params.push(`%${keyword}%`);
      }
      params.push(limit);
      const [rows] = await sourcePool.query(`
        SELECT
          COALESCE(NULLIF(d.TB019, ''), NULLIF(h.TA003, ''), d.CREATE_DATE) AS inventory_date,
          h.TA001 AS document_type,
          h.TA002 AS document_no,
          d.TB012 AS warehouse_code,
          w.MC002 AS warehouse_name,
          d.TB003 AS line_no,
          TRIM(d.TB004) AS item_code,
          TRIM(COALESCE(NULLIF(d.TB005, ''), m.MB002)) AS item_name,
          TRIM(COALESCE(NULLIF(d.TB008, ''), m.MB004)) AS unit,
          d.TB007 AS quantity,
          d.TB012 AS category_code,
          TRIM(COALESCE(NULLIF(d.TB017, ''), '')) AS supplier_name
        FROM invtb d
        LEFT JOIN invta h ON h.COMPANY = d.COMPANY AND h.TA001 = d.TB001 AND h.TA002 = d.TB002
        LEFT JOIN invmb m ON m.COMPANY = d.COMPANY AND m.MB001 = d.TB004
        LEFT JOIN cmsmc w ON w.COMPANY = d.COMPANY AND w.MC001 = d.TB012
        ${where}
        ORDER BY inventory_date DESC, document_no DESC, line_no DESC
        LIMIT ?
      `, params);
      res.json({ ok: true, data: rows, source: `${sourceName}.invtb + ${sourceName}.invta + ${sourceName}.invmb + ${sourceName}.cmsmc` });
    } catch (error) {
      next(error);
    }
  });

  // iSM INVI09 / inventory detail ledger.  INVLA is the posted inventory
  // movement ledger, so this endpoint is intentionally read-only.
  app.get('/api/sh/inventory-details', async (req, res, next) => {
    try {
      const sourceName = sourceDbFromRequest(req);
      const sourcePool = getSourcePool(sourceName);
      const [[table]] = await sourcePool.query(
        "SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = 'invla'"
      );
      if (!Number(table.count)) {
        return res.json({ ok: true, data: [], source: `${sourceName}.invla`, status: 'table-not-found' });
      }

      const keyword = String(req.query.keyword || '').trim();
      const warehouse = String(req.query.warehouse || '').trim();
      const direction = String(req.query.direction || '').trim();
      const dateFrom = String(req.query.date_from || '').replace(/[^0-9]/g, '');
      const dateTo = String(req.query.date_to || '').replace(/[^0-9]/g, '');
      const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 200);
      const clauses = [];
      const params = [];
      if (keyword) {
        clauses.push("CONCAT_WS(' ', a.LA001, m.MB002, a.LA006, q.MQ002, a.LA007, a.LA009, w.MC002, a.LA010) LIKE ?");
        params.push(`%${keyword}%`);
      }
      if (warehouse) {
        clauses.push('a.LA009 = ?');
        params.push(warehouse);
      }
      if (direction === 'in' || direction === 'out') {
        clauses.push(direction === 'in' ? 'a.LA005 > 0' : 'a.LA005 < 0');
      }
      if (/^\d{8}$/.test(dateFrom)) {
        clauses.push('a.LA004 >= ?');
        params.push(dateFrom);
      }
      if (/^\d{8}$/.test(dateTo)) {
        clauses.push('a.LA004 <= ?');
        params.push(dateTo);
      }
      params.push(limit);
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const [rows] = await sourcePool.query(`
        SELECT
          a.LA004 AS inventory_date,
          a.LA006 AS document_type,
          COALESCE(NULLIF(q.MQ002, ''), a.LA006) AS document_name,
          a.LA007 AS document_no,
          a.LA008 AS line_no,
          a.LA005 AS direction_sign,
          a.LA009 AS warehouse_code,
          w.MC002 AS warehouse_name,
          TRIM(a.LA001) AS item_code,
          TRIM(m.MB002) AS item_name,
          TRIM(m.MB003) AS specification,
          TRIM(m.MB004) AS unit,
          TRIM(a.LA010) AS counterparty,
          a.LA011 AS quantity,
          a.LA012 AS unit_cost,
          a.LA013 AS amount,
          a.LA014 AS movement_type,
          a.LA015 AS cost_impact
        FROM invla a
        LEFT JOIN invmb m ON m.COMPANY = a.COMPANY AND m.MB001 = a.LA001
        LEFT JOIN cmsmc w ON w.COMPANY = a.COMPANY AND w.MC001 = a.LA009
        LEFT JOIN cmsmq q ON q.COMPANY = a.COMPANY AND q.MQ001 = a.LA006
        ${where}
        ORDER BY a.LA004 DESC, a.LA007 DESC, a.LA008 DESC
        LIMIT ?
      `, params);
      res.json({ ok: true, data: rows, source: `${sourceName}.invla + ${sourceName}.invmb + ${sourceName}.cmsmc + ${sourceName}.cmsmq`, status: 'sample-validated' });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/sh/inventory-ledger', async (req, res, next) => {
    try {
      const sourceName = sourceDbFromRequest(req);
      const sourcePool = getSourcePool(sourceName);
      const keyword = String(req.query.keyword || '').trim();
      const warehouse = String(req.query.warehouse || '').trim();
      const dateFrom = String(req.query.date_from || '').replace(/[^0-9]/g, '');
      const dateTo = String(req.query.date_to || '').replace(/[^0-9]/g, '');
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const filters = [];
      const params = [];
      if (keyword) { filters.push("CONCAT_WS(' ', l.item_code, l.item_name, l.warehouse_code, l.warehouse_name, l.document_type, l.document_no) LIKE ?"); params.push(`%${keyword}%`); }
      if (warehouse) { filters.push('l.warehouse_code = ?'); params.push(warehouse); }
      if (/^\d{8}$/.test(dateFrom)) { filters.push('l.inventory_date >= ?'); params.push(dateFrom); }
      if (/^\d{8}$/.test(dateTo)) { filters.push('l.inventory_date <= ?'); params.push(dateTo); }
      params.push(limit);
      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      const [rows] = await sourcePool.query(`
        WITH ledger AS (
          SELECT a.LA004 AS inventory_date, a.LA001 AS item_code, TRIM(m.MB002) AS item_name,
                 a.LA009 AS warehouse_code, w.MC002 AS warehouse_name,
                 a.LA006 AS document_type, a.LA007 AS document_no, a.LA008 AS line_no,
                 a.LA005 AS direction_sign, a.LA011 AS quantity,
                 SUM(a.LA005 * a.LA011) OVER (PARTITION BY a.COMPANY, a.LA001, a.LA009 ORDER BY a.LA004, a.LA007, a.LA008 ROWS UNBOUNDED PRECEDING) AS running_quantity
          FROM invla a
          LEFT JOIN invmb m ON m.COMPANY = a.COMPANY AND m.MB001 = a.LA001
          LEFT JOIN cmsmc w ON w.COMPANY = a.COMPANY AND w.MC001 = a.LA009
        )
        SELECT * FROM ledger l
        ${where}
        ORDER BY l.inventory_date DESC, l.document_no DESC, l.line_no DESC
        LIMIT ?
      `, params);
      res.json({ ok: true, data: rows, source: `${sourceName}.invla`, status: 'sample-validated' });
    } catch (error) { next(error); }
  });

  app.get('/api/sh/inventory-balance', async (req, res, next) => {
    try {
      const sourceName = sourceDbFromRequest(req);
      const sourcePool = getSourcePool(sourceName);
      const month = String(req.query.month || '').replace(/[^0-9]/g, '').slice(0, 6);
      const keyword = String(req.query.keyword || '').trim();
      const warehouse = String(req.query.warehouse || '').trim();
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const [[latest]] = await sourcePool.query('SELECT MAX(LEFT(LA004, 6)) AS month FROM invla');
      const selectedMonth = /^\d{6}$/.test(month) ? month : latest.month;
      const filters = ['a.LA004 <= CONCAT(?, \'99\')'];
      const filterParams = [selectedMonth];
      if (keyword) { filters.push("CONCAT_WS(' ', a.LA001, m.MB002) LIKE ?"); filterParams.push(`%${keyword}%`); }
      if (warehouse) { filters.push('a.LA009 = ?'); filterParams.push(warehouse); }
      const params = [selectedMonth, selectedMonth, selectedMonth, ...filterParams, limit];
      const [rows] = await sourcePool.query(`
        SELECT a.LA001 AS item_code, TRIM(m.MB002) AS item_name, TRIM(m.MB004) AS unit,
               a.LA009 AS warehouse_code, w.MC002 AS warehouse_name,
               SUM(CASE WHEN a.LA004 < CONCAT(?, '01') THEN a.LA005 * a.LA011 ELSE 0 END) AS opening_quantity,
               SUM(CASE WHEN LEFT(a.LA004, 6) = ? AND a.LA005 > 0 THEN a.LA011 ELSE 0 END) AS receipt_quantity,
               SUM(CASE WHEN LEFT(a.LA004, 6) = ? AND a.LA005 < 0 THEN a.LA011 ELSE 0 END) AS issue_quantity,
               SUM(a.LA005 * a.LA011) AS ending_quantity
        FROM invla a
        LEFT JOIN invmb m ON m.COMPANY = a.COMPANY AND m.MB001 = a.LA001
        LEFT JOIN cmsmc w ON w.COMPANY = a.COMPANY AND w.MC001 = a.LA009
        WHERE ${filters.join(' AND ')}
        GROUP BY a.COMPANY, a.LA001, m.MB002, m.MB004, a.LA009, w.MC002
        HAVING receipt_quantity <> 0 OR issue_quantity <> 0 OR opening_quantity <> 0
        ORDER BY a.LA001, a.LA009
        LIMIT ?
      `, params);
      res.json({ ok: true, data: rows, period: selectedMonth, source: `${sourceName}.invla (calculated)`, status: 'sample-validated' });
    } catch (error) { next(error); }
  });

  app.get('/api/sh/inventory-movement-stats', async (req, res, next) => {
    try {
      const sourceName = sourceDbFromRequest(req);
      const sourcePool = getSourcePool(sourceName);
      const dateFrom = String(req.query.date_from || '').replace(/[^0-9]/g, '');
      const dateTo = String(req.query.date_to || '').replace(/[^0-9]/g, '');
      const filters = [];
      const params = [];
      if (/^\d{8}$/.test(dateFrom)) { filters.push('a.LA004 >= ?'); params.push(dateFrom); }
      if (/^\d{8}$/.test(dateTo)) { filters.push('a.LA004 <= ?'); params.push(dateTo); }
      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      const [rows] = await sourcePool.query(`
        SELECT a.LA006 AS document_type, COALESCE(NULLIF(q.MQ002, ''), a.LA006) AS document_name,
               a.LA014 AS movement_type, a.LA005 AS direction_sign,
               COUNT(*) AS detail_count, COUNT(DISTINCT CONCAT(a.LA006, '-', a.LA007)) AS document_count,
               SUM(a.LA011) AS quantity, SUM(a.LA013) AS amount
        FROM invla a
        LEFT JOIN cmsmq q ON q.COMPANY = a.COMPANY AND q.MQ001 = a.LA006
        ${where}
        GROUP BY a.LA006, q.MQ002, a.LA014, a.LA005
        ORDER BY a.LA006, a.LA005
      `, params);
      res.json({ ok: true, data: rows, source: `${sourceName}.invla + ${sourceName}.cmsmq`, status: 'sample-validated' });
    } catch (error) { next(error); }
  });

  app.get('/api/sh/department-movement-stats', async (req, res, next) => {
    try {
      const sourceName = sourceDbFromRequest(req);
      const sourcePool = getSourcePool(sourceName);
      const dateFrom = String(req.query.date_from || '').replace(/[^0-9]/g, '');
      const dateTo = String(req.query.date_to || '').replace(/[^0-9]/g, '');
      const filters = [];
      const params = [];
      if (/^\d{8}$/.test(dateFrom)) { filters.push('h.TA003 >= ?'); params.push(dateFrom); }
      if (/^\d{8}$/.test(dateTo)) { filters.push('h.TA003 <= ?'); params.push(dateTo); }
      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      const [rows] = await sourcePool.query(`
        SELECT h.TA004 AS department_code, COALESCE(NULLIF(e.ME002, ''), '未建部門') AS department_name,
               h.TA001 AS document_type, COALESCE(NULLIF(q.MQ002, ''), h.TA001) AS document_name,
               COUNT(DISTINCT CONCAT(h.TA001, '-', h.TA002)) AS document_count,
               COUNT(d.TB003) AS detail_count,
               SUM(d.TB007) AS quantity,
               SUM(CASE WHEN q.MQ010 = '-1' THEN -d.TB007 ELSE d.TB007 END) AS net_quantity,
               SUM(d.TB011) AS amount
        FROM invta h
        JOIN invtb d ON d.COMPANY = h.COMPANY AND d.TB001 = h.TA001 AND d.TB002 = h.TA002
        LEFT JOIN cmsme e ON e.COMPANY = h.COMPANY AND e.ME001 = h.TA004
        LEFT JOIN cmsmq q ON q.COMPANY = h.COMPANY AND q.MQ001 = h.TA001
        ${where}
        GROUP BY h.TA004, e.ME002, h.TA001, q.MQ002
        ORDER BY h.TA004, h.TA001
      `, params);
      res.json({ ok: true, data: rows, source: `${sourceName}.invta + ${sourceName}.invtb + ${sourceName}.cmsme + ${sourceName}.cmsmq`, status: 'sample-validated' });
    } catch (error) { next(error); }
  });

  app.get('/api/sh/purchase-receipts', async (req, res, next) => {
    try {
      const sourceName = sourceDbFromRequest(req);
      const sourcePool = getSourcePool(sourceName);
      const keyword = String(req.query.keyword || '').trim();
      const dateFrom = String(req.query.date_from || '').replace(/[^0-9]/g, '');
      const dateTo = String(req.query.date_to || '').replace(/[^0-9]/g, '');
      const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 200);
      const filters = [];
      const params = [];
      if (keyword) { filters.push("CONCAT_WS(' ', h.TC001, h.TC002, h.TC004, s.MA003, d.TD004, d.TD005, d.TD007, w.MC002) LIKE ?"); params.push(`%${keyword}%`); }
      if (/^\d{8}$/.test(dateFrom)) { filters.push('h.TC003 >= ?'); params.push(dateFrom); }
      if (/^\d{8}$/.test(dateTo)) { filters.push('h.TC003 <= ?'); params.push(dateTo); }
      params.push(limit);
      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      const [rows] = await sourcePool.query(`
        SELECT h.TC003 AS receipt_date, h.TC001 AS document_type, h.TC002 AS document_no,
               h.TC004 AS supplier_code, TRIM(s.MA003) AS supplier_name,
               d.TD003 AS line_no, TRIM(d.TD004) AS item_code, TRIM(d.TD005) AS item_name,
               TRIM(d.TD006) AS specification, d.TD007 AS warehouse_code, w.MC002 AS warehouse_name,
               d.TD008 AS quantity, TRIM(d.TD009) AS unit, d.TD010 AS unit_price, d.TD011 AS amount,
               d.TD012 AS expected_date
        FROM purtc h
        JOIN purtd d ON d.COMPANY = h.COMPANY AND d.TD001 = h.TC001 AND d.TD002 = h.TC002
        LEFT JOIN purma s ON s.COMPANY = h.COMPANY AND s.MA001 = h.TC004
        LEFT JOIN cmsmc w ON w.COMPANY = h.COMPANY AND w.MC001 = d.TD007
        ${where}
        ORDER BY h.TC003 DESC, h.TC002 DESC, d.TD003 DESC
        LIMIT ?
      `, params);
      res.json({ ok: true, data: rows, source: `${sourceName}.purtc + ${sourceName}.purtd + ${sourceName}.purma + ${sourceName}.cmsmc`, status: 'sample-validated' });
    } catch (error) { next(error); }
  });

  app.get('/api/sh/warehouses', async (req, res, next) => {
    try {
      const sourceName = sourceDbFromRequest(req);
      const sourcePool = getSourcePool(sourceName);
      const [[table]] = await sourcePool.query(
        'SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = LOWER(?)',
        ['cmsmc']
      );
      if (!Number(table.count)) {
        return res.json({ ok: true, data: [], source: `${sourceName}.cmsmc`, status: 'table-not-found' });
      }
      const keyword = String(req.query.keyword || '').trim();
      const where = keyword ? 'WHERE MC001 LIKE :keyword OR MC002 LIKE :keyword OR MC003 LIKE :keyword' : '';
      const [rows] = await sourcePool.query(`
        SELECT MC001 AS warehouse_code, MC002 AS warehouse_name, MC003 AS site_code,
               MC004 AS status_code, MC005 AS allow_in, MC006 AS allow_out
        FROM cmsmc
        ${where}
        ORDER BY MC001
      `, keyword ? { keyword: `%${keyword}%` } : undefined);
      res.json({ ok: true, data: rows, source: `${sourceName}.cmsmc` });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/sh/warehouses', async (req, res, next) => {
    try {
      const sourceName = sourceDbFromRequest(req);
      const sourcePool = getSourcePool(sourceName);
      const { warehouse_code, warehouse_name, site_code, status_code, allow_in, allow_out } = req.body || {};
      const code = String(warehouse_code || '').trim();
      const name = String(warehouse_name || '').trim();
      if (!code || !name) throw badRequest('倉別代號與倉別名稱為必填');
      if (code.length > 10 || name.length > 10) throw badRequest('倉別代號最多 10 碼，倉別名稱最多 10 碼');
      const [[table]] = await sourcePool.query(
        'SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = LOWER(?)',
        ['cmsmc']
      );
      if (!Number(table.count)) throw badRequest(`${sourceName} 沒有 cmsmc 倉別資料表`);
      await sourcePool.execute(`
        INSERT INTO cmsmc
          (COMPANY, CREATOR, USR_GROUP, CREATE_DATE, MODIFIER, MODI_DATE, FLAG,
           MC001, MC002, MC003, MC004, MC005, MC006)
        VALUES (?, 'DS', 'DS', DATE_FORMAT(NOW(), '%Y%m%d'), 'DS', DATE_FORMAT(NOW(), '%Y%m%d'), 5, ?, ?, ?, ?, ?, ?)
      `, [sourceName, code, name, String(site_code || '').trim(), String(status_code || '1').trim(), String(allow_in || 'Y').trim(), String(allow_out || 'Y').trim()]);
      res.status(201).json({ ok: true, message: '倉別新增成功', code });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') error = badRequest('倉別代號已存在，請改用其他代號');
      next(error);
    }
  });

  app.put('/api/sh/warehouses/:code', async (req, res, next) => {
    try {
      const sourceName = sourceDbFromRequest(req);
      const sourcePool = getSourcePool(sourceName);
      const code = String(req.params.code || '').trim();
      const { warehouse_name, site_code, status_code, allow_in, allow_out } = req.body || {};
      const name = String(warehouse_name || '').trim();
      if (!code || !name) throw badRequest('倉別代號與倉別名稱為必填');
      const [result] = await sourcePool.execute(`
        UPDATE cmsmc
        SET MC002 = ?, MC003 = ?, MC004 = ?, MC005 = ?, MC006 = ?,
            MODIFIER = 'DS', MODI_DATE = DATE_FORMAT(NOW(), '%Y%m%d')
        WHERE MC001 = ?
      `, [name, String(site_code || '').trim(), String(status_code || '1').trim(), String(allow_in || 'Y').trim(), String(allow_out || 'Y').trim(), code]);
      if (!result.affectedRows) return res.status(404).json({ ok: false, error: '找不到要修改的倉別' });
      res.json({ ok: true, message: '倉別修改成功', code });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/sh/departments', async (req, res, next) => {
    try {
      const sourceName = sourceDbFromRequest(req);
      const sourcePool = getSourcePool(sourceName);
      const keyword = String(req.query.keyword || '').trim();
      const where = keyword ? 'WHERE ME001 LIKE :keyword OR ME002 LIKE :keyword OR ME003 LIKE :keyword' : '';
      const [rows] = await sourcePool.query(`
        SELECT ME001 AS department_code, ME002 AS department_name, ME003 AS note, ME004 AS account_code
        FROM cmsme ${where} ORDER BY ME001
      `, keyword ? { keyword: `%${keyword}%` } : undefined);
      res.json({ ok: true, data: rows, source: `${sourceName}.cmsme` });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/sh/departments', async (req, res, next) => {
    try {
      const sourceName = sourceDbFromRequest(req);
      const sourcePool = getSourcePool(sourceName);
      const { department_code, department_name, note, account_code } = req.body || {};
      const code = String(department_code || '').trim();
      const name = String(department_name || '').trim();
      if (!code || !name) throw badRequest('部門代號與部門名稱為必填');
      if (code.length > 6 || name.length > 10) throw badRequest('部門代號最多 6 碼，部門名稱最多 10 碼');
      await sourcePool.execute(`
        INSERT INTO cmsme
          (COMPANY, CREATOR, USR_GROUP, CREATE_DATE, MODIFIER, MODI_DATE, FLAG, ME001, ME002, ME003, ME004)
        VALUES (?, 'DS', 'DS', DATE_FORMAT(NOW(), '%Y%m%d'), 'DS', DATE_FORMAT(NOW(), '%Y%m%d'), 1, ?, ?, ?, ?)
      `, [sourceName, code, name, String(note || '').trim(), String(account_code || '').trim()]);
      res.status(201).json({ ok: true, message: '部門新增成功', code });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') error = badRequest('部門代號已存在，請改用其他代號');
      next(error);
    }
  });

  app.put('/api/sh/departments/:code', async (req, res, next) => {
    try {
      const sourceName = sourceDbFromRequest(req);
      const sourcePool = getSourcePool(sourceName);
      const code = String(req.params.code || '').trim();
      const { department_name, note, account_code } = req.body || {};
      const name = String(department_name || '').trim();
      if (!code || !name) throw badRequest('部門代號與部門名稱為必填');
      const [result] = await sourcePool.execute(`
        UPDATE cmsme
        SET ME002 = ?, ME003 = ?, ME004 = ?, MODIFIER = 'DS', MODI_DATE = DATE_FORMAT(NOW(), '%Y%m%d')
        WHERE ME001 = ?
      `, [name, String(note || '').trim(), String(account_code || '').trim(), code]);
      if (!result.affectedRows) return res.status(404).json({ ok: false, error: '找不到要修改的部門' });
      res.json({ ok: true, message: '部門修改成功', code });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/sh/employees', async (req, res, next) => {
    try {
      const sourceName = sourceDbFromRequest(req);
      const sourcePool = getSourcePool(sourceName);
      const keyword = String(req.query.keyword || '').trim();
      const where = keyword ? 'WHERE MV001 LIKE :keyword OR MV002 LIKE :keyword OR MV003 LIKE :keyword OR MV004 LIKE :keyword OR MV020 LIKE :keyword' : '';
      const [rows] = await sourcePool.query(`
        SELECT MV001 AS employee_code, MV002 AS employee_name, MV003 AS company_code,
               MV004 AS department_code, MV005 AS job_title, MV020 AS email
        FROM cmsmv ${where} ORDER BY MV001
      `, keyword ? { keyword: `%${keyword}%` } : undefined);
      res.json({ ok: true, data: rows, source: `${sourceName}.cmsmv` });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/sh/employees', async (req, res, next) => {
    try {
      const sourceName = sourceDbFromRequest(req);
      const sourcePool = getSourcePool(sourceName);
      const { employee_code, employee_name, company_code, department_code, job_title, email } = req.body || {};
      const code = String(employee_code || '').trim();
      const name = String(employee_name || '').trim();
      if (!code || !name) throw badRequest('員工代號與員工姓名為必填');
      if (code.length > 10 || name.length > 10) throw badRequest('員工代號與姓名最多 10 碼');
      await sourcePool.execute(`
        INSERT INTO cmsmv
          (COMPANY, CREATOR, USR_GROUP, CREATE_DATE, MODIFIER, MODI_DATE, FLAG,
           MV001, MV002, MV003, MV004, MV005, MV020)
        VALUES (?, 'DS', 'DS', DATE_FORMAT(NOW(), '%Y%m%d'), 'DS', DATE_FORMAT(NOW(), '%Y%m%d'), 1, ?, ?, ?, ?, ?, ?)
      `, [sourceName, code, name, String(company_code || sourceName).trim(), String(department_code || '').trim(), String(job_title || '').trim(), String(email || '').trim()]);
      res.status(201).json({ ok: true, message: '員工新增成功', code });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') error = badRequest('員工代號已存在，請改用其他代號');
      next(error);
    }
  });

  app.put('/api/sh/employees/:code', async (req, res, next) => {
    try {
      const sourceName = sourceDbFromRequest(req);
      const sourcePool = getSourcePool(sourceName);
      const code = String(req.params.code || '').trim();
      const { employee_name, company_code, department_code, job_title, email } = req.body || {};
      const name = String(employee_name || '').trim();
      if (!code || !name) throw badRequest('員工代號與員工姓名為必填');
      const [result] = await sourcePool.execute(`
        UPDATE cmsmv
        SET MV002 = ?, MV003 = ?, MV004 = ?, MV005 = ?, MV020 = ?,
            MODIFIER = 'DS', MODI_DATE = DATE_FORMAT(NOW(), '%Y%m%d')
        WHERE MV001 = ?
      `, [name, String(company_code || sourceName).trim(), String(department_code || '').trim(), String(job_title || '').trim(), String(email || '').trim(), code]);
      if (!result.affectedRows) return res.status(404).json({ ok: false, error: '找不到要修改的員工' });
      res.json({ ok: true, message: '員工修改成功', code });
    } catch (error) {
      next(error);
    }
  });

  registerSourcePartnerRoutes(app);
  registerDocumentNatureRoutes(app);
  registerProcurementWorkflowRoutes(app);
  registerSalesReturnInspectionRoutes(app);
  registerSalesWorkflowRoutes(app);
  registerSalesCustomerItemRoutes(app);
  registerSalesCustomerPricingRoutes(app);
  registerSalesForecastRoutes(app);
  registerFlowAuditRoutes(app);
  registerFinanceWorkflowRoutes(app);
  registerAccountingWorkflowRoutes(app);
  registerSourceFinancialPreviewRoutes(app);
  registerInventoryWorkflowRoutes(app);
  registerReversalRoutes(app);
  registerAccessControlRoutes(app);

  app.get('/api/reports/dashboard', async (_req, res, next) => {
    try {
      const [[products]] = await pool.query('SELECT COUNT(*) AS count FROM products WHERE is_active = 1');
      const [[customers]] = await pool.query('SELECT COUNT(*) AS count FROM customers WHERE is_active = 1');
      const [[suppliers]] = await pool.query('SELECT COUNT(*) AS count FROM suppliers WHERE is_active = 1');
      const [[lowStock]] = await pool.query(`
        SELECT COUNT(*) AS count
        FROM products p
        LEFT JOIN (
          SELECT product_id, SUM(qty_on_hand - qty_reserved) AS qty_available
          FROM inventory_stock
          GROUP BY product_id
        ) s ON s.product_id = p.id
        WHERE p.is_active = 1 AND COALESCE(s.qty_available, 0) < p.safety_stock
      `);
      res.json({
        ok: true,
        data: {
          products: products.count,
          customers: customers.count,
          suppliers: suppliers.count,
          lowStock: lowStock.count
        }
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/purchase-receipts', async (req, res, next) => {
    try {
      const result = await tx(async (conn) => {
        const body = req.body || {};
        assertRequired(body, ['receipt_no', 'supplier_id', 'warehouse_id', 'receipt_date', 'items']);
        if (!Array.isArray(body.items) || body.items.length === 0) throw badRequest('進貨明細不可為空');

        const [receipt] = await conn.query(
          `INSERT INTO purchase_receipts
            (receipt_no, purchase_order_id, supplier_id, warehouse_id, receipt_date, note)
           VALUES (:receipt_no, :purchase_order_id, :supplier_id, :warehouse_id, :receipt_date, :note)`,
          {
            receipt_no: body.receipt_no,
            purchase_order_id: body.purchase_order_id || null,
            supplier_id: body.supplier_id,
            warehouse_id: body.warehouse_id,
            receipt_date: body.receipt_date,
            note: body.note || null
          }
        );

        for (const item of body.items) {
          assertRequired(item, ['product_id', 'qty_received']);
          const lotNo = item.lot_no || '';
          const unitCost = Number(item.unit_cost || 0);
          const qty = Number(item.qty_received);
          if (qty <= 0) throw badRequest('進貨數量必須大於 0');

          await conn.query(
            `INSERT INTO purchase_receipt_items
              (purchase_receipt_id, product_id, lot_no, qty_received, unit_cost)
             VALUES (?, ?, ?, ?, ?)`,
            [receipt.insertId, item.product_id, lotNo, qty, unitCost]
          );
          await applyStockMove(conn, {
            move_type: 'purchase_receipt',
            ref_table: 'purchase_receipts',
            ref_id: receipt.insertId,
            product_id: item.product_id,
            warehouse_id: body.warehouse_id,
            lot_no: lotNo,
            qty_delta: qty,
            unit_cost: unitCost,
            note: body.receipt_no
          });
        }
        return { id: receipt.insertId };
      });
      res.status(201).json({ ok: true, ...result });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/sales-shipments', async (req, res, next) => {
    try {
      const result = await tx(async (conn) => {
        const body = req.body || {};
        assertRequired(body, ['shipment_no', 'customer_id', 'warehouse_id', 'shipment_date', 'items']);
        if (!Array.isArray(body.items) || body.items.length === 0) throw badRequest('出貨明細不可為空');

        const [shipment] = await conn.query(
          `INSERT INTO sales_shipments
            (shipment_no, sales_order_id, customer_id, warehouse_id, shipment_date, note)
           VALUES (:shipment_no, :sales_order_id, :customer_id, :warehouse_id, :shipment_date, :note)`,
          {
            shipment_no: body.shipment_no,
            sales_order_id: body.sales_order_id || null,
            customer_id: body.customer_id,
            warehouse_id: body.warehouse_id,
            shipment_date: body.shipment_date,
            note: body.note || null
          }
        );

        for (const item of body.items) {
          assertRequired(item, ['product_id', 'qty_shipped']);
          const lotNo = item.lot_no || '';
          const qty = Number(item.qty_shipped);
          if (qty <= 0) throw badRequest('出貨數量必須大於 0');
          await ensureAvailableStock(conn, item.product_id, body.warehouse_id, lotNo, qty);

          await conn.query(
            `INSERT INTO sales_shipment_items
              (sales_shipment_id, product_id, lot_no, qty_shipped, unit_price)
             VALUES (?, ?, ?, ?, ?)`,
            [shipment.insertId, item.product_id, lotNo, qty, Number(item.unit_price || 0)]
          );
          await applyStockMove(conn, {
            move_type: 'sales_shipment',
            ref_table: 'sales_shipments',
            ref_id: shipment.insertId,
            product_id: item.product_id,
            warehouse_id: body.warehouse_id,
            lot_no: lotNo,
            qty_delta: -qty,
            unit_cost: 0,
            note: body.shipment_no
          });
        }
        return { id: shipment.insertId };
      });
      res.status(201).json({ ok: true, ...result });
    } catch (error) {
      next(error);
    }
  });
}

async function applyStockMove(conn, move) {
  await conn.query(
    `INSERT INTO inventory_moves
      (move_type, ref_table, ref_id, product_id, warehouse_id, lot_no, qty_delta, unit_cost, note)
     VALUES (:move_type, :ref_table, :ref_id, :product_id, :warehouse_id, :lot_no, :qty_delta, :unit_cost, :note)`,
    move
  );

  await conn.query(
    `INSERT INTO inventory_stock
      (product_id, warehouse_id, lot_no, qty_on_hand)
     VALUES (:product_id, :warehouse_id, :lot_no, :qty_delta)
     ON DUPLICATE KEY UPDATE qty_on_hand = qty_on_hand + VALUES(qty_on_hand)`,
    move
  );
}

async function ensureAvailableStock(conn, productId, warehouseId, lotNo, requiredQty) {
  const [[row]] = await conn.query(
    `SELECT COALESCE(qty_on_hand - qty_reserved, 0) AS available
     FROM inventory_stock
     WHERE product_id = ? AND warehouse_id = ? AND lot_no = ?
     FOR UPDATE`,
    [productId, warehouseId, lotNo || '']
  );
  if (!row || Number(row.available) < requiredQty) {
    throw badRequest(`庫存不足：product_id=${productId}, warehouse_id=${warehouseId}, lot_no=${lotNo || ''}`);
  }
}

function pick(source, fields) {
  const result = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      result[field] = source[field];
    }
  }
  return result;
}

function assertRequired(source, fields) {
  for (const field of fields) {
    if (source[field] === undefined || source[field] === null || source[field] === '') {
      throw badRequest(`缺少必要欄位：${field}`);
    }
  }
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function dateText(value) {
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  const text = String(value ?? '').trim();
  return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : text.slice(0, 10);
}

function accountingMonthBounds(value) {
  const date = dateText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('日期格式錯誤，必須為 YYYY-MM-DD');
  const [year, month] = date.split('-').map(Number);
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { period_code: date.slice(0, 7), start_date: `${date.slice(0, 7)}-01`, end_date: end };
}

function assertChronologicalDate(postingDate, sourceDate, label) {
  const posting = dateText(postingDate), source = dateText(sourceDate);
  if (posting && source && posting < source) throw badRequest(`${label}不可早於來源單據日期（${source}）`);
}

async function assertOpenAccountingPeriod(conn, context, postingDate) {
  const bounds = accountingMonthBounds(postingDate);
  let [[period]] = await conn.query(`SELECT * FROM accounting_periods
    WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=?
      AND start_date<=? AND end_date>=? FOR UPDATE`,
    [context.tenant_id, context.company_id, context.source_system, context.source_database || context.company_id, bounds.start_date, bounds.end_date]);
  if (!period) {
    await conn.query(`INSERT IGNORE INTO accounting_periods
      (tenant_id,company_id,source_system,source_database,period_code,start_date,end_date,status,note)
      VALUES(?,?,?,?,?,?,?,'open','系統首次使用自動建立開放期間')`,
      [context.tenant_id, context.company_id, context.source_system, context.source_database || context.company_id, bounds.period_code, bounds.start_date, bounds.end_date]);
    [[period]] = await conn.query(`SELECT * FROM accounting_periods
      WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND period_code=? FOR UPDATE`,
      [context.tenant_id, context.company_id, context.source_system, context.source_database || context.company_id, bounds.period_code]);
  }
  if (!period || period.status !== 'open') throw badRequest(`會計期間 ${bounds.period_code} 已關帳或不存在，禁止過帳`);
  return period;
}

function notFound(message) {
  const error = new Error(message);
  error.status = 404;
  return error;
}

function sourceDbFromRequest(req) {
  const requested = String(
    req.erpContext?.source_database || req.query.source_database || req.query.db ||
    req.body?.source_database || req.headers['x-source-database'] || 'SH'
  ).toUpperCase();
  if (!sourceDatabases[requested]) throw badRequest(`不允許的資料庫來源：${requested}`);
  return requested;
}

function requireShMasterSource(sourceName) {
  const source = sourceDatabases[sourceName];
  if (source?.adapter_code !== 'ism-sh') {
    throw Object.assign(new Error('目前標準主檔先以 SH 資料表為主；SMARTDSCSYS 與 DSCRPT 待個別確認後再開放。'), { status: 409 });
  }
}

const canonicalMasterConfigs = {
  warehouses: {
    table: 'erp_warehouses', code: 'warehouse_code', name: 'warehouse_name', sourceTable: 'cmsmc',
    fields: ['warehouse_code', 'warehouse_name', 'site_code', 'warehouse_type', 'allow_in', 'allow_out'],
    select: 'warehouse_code, warehouse_name, site_code, warehouse_type, allow_in, allow_out, is_active',
    sourceSelect: 'MC001 AS warehouse_code, MC002 AS warehouse_name, MC003 AS site_code, MC004 AS warehouse_type, MC005 AS allow_in, MC006 AS allow_out'
  },
  departments: {
    table: 'erp_departments', code: 'department_code', name: 'department_name', sourceTable: 'cmsme',
    fields: ['department_code', 'department_name', 'note', 'account_code'],
    select: 'department_code, department_name, note, account_code',
    sourceSelect: 'ME001 AS department_code, ME002 AS department_name, ME003 AS note, ME004 AS account_code'
  },
  employees: {
    table: 'erp_employees', code: 'employee_code', name: 'employee_name', sourceTable: 'cmsmv',
    fields: ['employee_code', 'employee_name', 'company_code', 'department_code', 'job_title', 'email'],
    select: 'employee_code, employee_name, company_code, department_code, job_title, email',
    sourceSelect: 'MV001 AS employee_code, MV002 AS employee_name, MV003 AS company_code, MV004 AS department_code, MV005 AS job_title, MV020 AS email'
  },
  customers: {
    table: 'erp_customers', code: 'customer_code', name: 'customer_name', sourceTable: 'copma',
    fields: ['customer_code', 'short_name', 'customer_name', 'responsible_person', 'contact_name', 'phone', 'fax', 'email', 'mobile', 'tax_id', 'currency_code', 'payment_term_code', 'payment_term_source_value', 'invoice_type', 'tax_type', 'closing_day'],
    select: 'customer_code, short_name, customer_name, responsible_person, contact_name, phone, fax, email, mobile, tax_id, currency_code, payment_term_code, payment_term_source_value, invoice_type, tax_type, closing_day',
    sourceSelect: `MA001 AS customer_code, MA002 AS short_name, MA003 AS customer_name,
      MA004 AS responsible_person, MA005 AS contact_name, MA006 AS phone, MA008 AS fax,
      MA009 AS email, MA138 AS mobile, MA010 AS tax_id, MA014 AS currency_code,
      CASE WHEN EXISTS (SELECT 1 FROM cmsnf nf WHERE nf.NF001='2' AND TRIM(nf.NF002)=TRIM(copma.MA083)) THEN MA083 ELSE NULL END AS payment_term_code,
      MA083 AS payment_term_source_value, MA037 AS invoice_type, MA038 AS tax_type, MA043 AS closing_day`
  },
  suppliers: {
    table: 'erp_suppliers', code: 'supplier_code', name: 'supplier_name', sourceTable: 'purma',
    fields: ['supplier_code', 'short_name', 'supplier_name', 'supplier_class', 'responsible_person', 'contact_name', 'phone', 'fax', 'email', 'mobile', 'tax_id', 'currency_code', 'payment_method', 'payment_term_code', 'payment_term_source_value', 'invoice_type', 'tax_type', 'closing_month_offset', 'closing_day'],
    select: 'supplier_code, short_name, supplier_name, supplier_class, responsible_person, contact_name, phone, fax, email, mobile, tax_id, currency_code, payment_method, payment_term_code, payment_term_source_value, invoice_type, tax_type, closing_month_offset, closing_day',
    sourceSelect: `MA001 AS supplier_code, MA002 AS short_name, MA003 AS supplier_name,
      MA004 AS supplier_class, MA012 AS responsible_person, MA013 AS contact_name,
      MA008 AS phone, MA010 AS fax, MA011 AS email, MA095 AS mobile, MA005 AS tax_id,
      MA021 AS currency_code, MA024 AS payment_method,
      COALESCE(
        (SELECT nf.NF002 FROM cmsnf nf WHERE nf.NF001='1' AND TRIM(nf.NF002)=TRIM(purma.MA025) LIMIT 1),
        (SELECT nf.NF002 FROM cmsnf nf WHERE nf.NF001='1' AND TRIM(nf.NF003)=TRIM(purma.MA025) ORDER BY nf.NF002 LIMIT 1)
      ) AS payment_term_code,
      MA025 AS payment_term_source_value, MA030 AS invoice_type, MA044 AS tax_type,
      MA034 AS closing_month_offset, MA035 AS closing_day`
  },
  companies: {
    table: 'erp_companies', code: 'company_code', name: 'company_name', sourceTable: 'cmsml',
    fields: ['company_code', 'short_name', 'company_name', 'address', 'phone', 'tax_id'],
    select: 'company_code, short_name, company_name, address, phone, tax_id',
    sourceSelect: 'ML001 AS company_code, ML002 AS short_name, ML003 AS company_name, ML004 AS address, ML005 AS phone, ML007 AS tax_id'
  },
  'code-rules': {
    table: 'erp_code_rules', code: 'rule_code', name: 'default_name', sourceTable: 'cmsmh',
    fields: ['rule_type', 'rule_value', 'rule_code', 'default_name'],
    select: 'rule_type, rule_value, rule_code, default_name',
    sourceSelect: 'MH001 AS rule_type, MH002 AS rule_value, MH003 AS rule_code, MH004 AS default_name'
  },
  'item-categories': {
    table: 'erp_item_categories', code: 'category_code', name: 'category_name', sourceTable: 'invma',
    fields: ['category_type', 'category_code', 'category_name'],
    select: 'category_type, category_code, category_name',
    sourceSelect: 'MA001 AS category_type, MA002 AS category_code, MA003 AS category_name', trackImport: true
  },
  items: {
    table: 'erp_items', code: 'item_code', name: 'item_name', sourceTable: 'invmb', allowNameBlank: true,
    fields: ['item_code', 'item_name', 'specification', 'unit', 'category_1', 'category_2', 'category_3', 'category_4'],
    select: 'item_code, item_name, specification, unit, category_1, category_2, category_3, category_4',
    sourceSelect: 'MB001 AS item_code, MB002 AS item_name, MB003 AS specification, MB004 AS unit, MB005 AS category_1, MB006 AS category_2, MB007 AS category_3, NULL AS category_4', trackImport: true
  },
  'job-categories': {
    table: 'erp_job_categories', code: 'job_code', name: 'job_name', sourceTable: 'cmsmj', allowNameBlank: true,
    fields: ['job_code', 'job_category', 'job_name', 'note'],
    select: 'job_code, job_category, job_name, note', related: ['job-category-employees'],
    sourceSelect: 'MJ001 AS job_code, MJ002 AS job_category, MJ003 AS job_name, MJ004 AS note'
  },
  'job-category-employees': {
    table: 'erp_job_category_employees', code: 'assignment_code', name: 'assignment_code', sourceTable: 'cmsmk',
    required: ['job_code', 'employee_code'],
    fields: ['assignment_code', 'job_code', 'employee_code', 'assignment_type', 'assignment_name', 'note'],
    select: 'assignment_code, job_code, employee_code, assignment_type, assignment_name, note',
    sourceSelect: "CONCAT(TRIM(MK001), ':', TRIM(MK002)) AS assignment_code, MK001 AS job_code, MK002 AS employee_code, MK003 AS assignment_type, MK004 AS assignment_name, MK005 AS note"
  },
  currencies: {
    table: 'erp_currencies', code: 'currency_code', name: 'currency_name', sourceTable: 'cmsmf',
    fields: ['currency_code', 'currency_name', 'unit_price_digits', 'amount_digits', 'unit_cost_digits', 'cost_amount_digits', 'note'],
    select: 'currency_code, currency_name, unit_price_digits, amount_digits, unit_cost_digits, cost_amount_digits, note', related: ['currency-rates'],
    sourceSelect: 'MF001 AS currency_code, MF002 AS currency_name, MF003 AS unit_price_digits, MF004 AS amount_digits, MF005 AS unit_cost_digits, MF006 AS cost_amount_digits, MF007 AS note'
  },
  'currency-rates': {
    table: 'erp_currency_rates', code: 'rate_code', name: 'rate_code', sourceTable: 'cmsmg',
    required: ['currency_code', 'effective_date'],
    fields: ['rate_code', 'currency_code', 'effective_date', 'bank_buy_rate', 'bank_sell_rate', 'customs_buy_rate', 'customs_sell_rate'],
    select: 'rate_code, currency_code, effective_date, bank_buy_rate, bank_sell_rate, customs_buy_rate, customs_sell_rate',
    sourceSelect: "CONCAT(TRIM(MG001), ':', TRIM(MG002)) AS rate_code, MG001 AS currency_code, MG002 AS effective_date, MG003 AS bank_buy_rate, MG004 AS bank_sell_rate, MG005 AS customs_buy_rate, MG006 AS customs_sell_rate"
  },
  'payment-terms': {
    table: 'erp_payment_terms', code: 'term_code', name: 'term_name', sourceTable: 'cmsnf',
    required: ['term_type'],
    fields: ['term_type', 'term_code', 'term_name', 'due_rule_type', 'due_offset', 'due_base_type', 'due_base_day', 'realization_rule_type', 'realization_offset', 'realization_base_type', 'realization_base_day', 'is_enabled', 'due_months', 'due_day', 'realization_months', 'realization_day', 'note'],
    select: 'term_type, term_code, term_name, due_rule_type, due_offset, due_base_type, due_base_day, realization_rule_type, realization_offset, realization_base_type, realization_base_day, is_enabled, due_months, due_day, realization_months, realization_day, note',
    sourceSelect: 'NF001 AS term_type, NF002 AS term_code, NF003 AS term_name, NF004 AS due_rule_type, NF005 AS due_offset, NF006 AS due_base_type, NF007 AS due_base_day, NF008 AS realization_rule_type, NF009 AS realization_offset, NF010 AS realization_base_type, NF011 AS realization_base_day, NF012 AS is_enabled, NF014 AS due_months, NF015 AS due_day, NF016 AS realization_months, NF018 AS realization_day, NF017 AS note'
  },
  calendars: {
    table: 'erp_calendars', code: 'calendar_code', name: 'shift_name', sourceTable: 'cmsmi', allowNameBlank: true,
    required: ['industry_type', 'calendar_year', 'shift_code'],
    fields: ['calendar_code', 'industry_type', 'calendar_year', 'shift_code', 'shift_name', 'note'],
    select: 'calendar_code, industry_type, calendar_year, shift_code, shift_name, note', related: ['calendar-days'],
    sourceSelect: "CONCAT(TRIM(MI001), '-', TRIM(MI002), '-', TRIM(MI003)) AS calendar_code, MI001 AS industry_type, MI002 AS calendar_year, MI003 AS shift_code, '' AS shift_name, MI004 AS note"
  },
  'calendar-days': {
    table: 'erp_calendar_days', code: 'calendar_day_code', name: 'calendar_day_code', sourceTable: 'cmsmp',
    required: ['calendar_code', 'industry_type', 'calendar_year', 'shift_code', 'work_date'],
    fields: ['calendar_day_code', 'calendar_code', 'industry_type', 'calendar_year', 'shift_code', 'work_date', 'day_type', 'work_hours', 'note', 'closed_flag'],
    select: 'calendar_day_code, calendar_code, industry_type, calendar_year, shift_code, work_date, day_type, work_hours, note, closed_flag',
    sourceSelect: "CONCAT(TRIM(MP001), '-', TRIM(MP002), '-', TRIM(MP003), ':', TRIM(MP004)) AS calendar_day_code, CONCAT(TRIM(MP001), '-', TRIM(MP002), '-', TRIM(MP003)) AS calendar_code, MP001 AS industry_type, MP002 AS calendar_year, MP003 AS shift_code, MP004 AS work_date, MP005 AS day_type, MP006 AS work_hours, MP007 AS note, MP008 AS closed_flag"
  }
};

async function syncCanonicalMaster(sourceName, type) {
  const config = canonicalMasterConfigs[type];
  const source = sourceDatabases[sourceName];
  if (!config || !source || source.adapter_code !== 'ism-sh') return;
  const sourcePool = getSourcePool(sourceName);
  const [[table]] = await sourcePool.query(
    'SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = LOWER(?)',
    [config.sourceTable]
  );
  if (!Number(table.count)) return;
  const [rows] = await sourcePool.query(`SELECT ${config.sourceSelect} FROM ${config.sourceTable}`);
  const insertFields = [...config.fields, 'tenant_id', 'company_id', 'source_system', 'source_database', 'source_table', 'source_key'];
  const placeholders = `(${insertFields.map(() => '?').join(', ')})`;
  const validRows = rows.filter(row => String(row[config.code] || '').trim() && (config.allowNameBlank || String(row[config.name] || '').trim()));
  let batchId = null;
  if (config.trackImport && validRows.length) {
    const [[existing]] = await pool.query(`SELECT COUNT(*) AS count FROM ${config.table} WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=?`, [source.tenant_id, source.company_id, source.source_system, sourceName]);
    if (Number(existing.count) >= validRows.length) return;
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const batchNo = `IMP-${stamp}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const [batch] = await pool.query(`INSERT INTO erp_import_batches
      (batch_no, tenant_id, company_id, source_system, source_database, status, started_at, total_tables, total_rows)
      VALUES (?, ?, ?, ?, ?, 'running', NOW(), 1, ?)`, [batchNo, source.tenant_id, source.company_id, source.source_system, sourceName, validRows.length]);
    batchId = batch.insertId;
  }
  let importedRows = 0;
  for (let start = 0; start < validRows.length; start += 500) {
    const values = [];
    const groups = validRows.slice(start, start + 500).map(row => {
      values.push(...config.fields.map(field => row[field] ?? null), source.tenant_id, source.company_id, source.source_system, sourceName, config.sourceTable, `${source.tenant_id}:${source.company_id}:${source.source_system}:${config.sourceTable}:${String(row[config.code]).trim()}`);
      return placeholders;
    });
    const [result] = await pool.query(`INSERT IGNORE INTO ${config.table} (${insertFields.join(', ')}) VALUES ${groups.join(', ')}`, values);
    importedRows += Number(result.affectedRows || 0);
  }
  if (batchId) {
    const [[target]] = await pool.query(`SELECT COUNT(*) AS count FROM ${config.table} WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=?`, [source.tenant_id, source.company_id, source.source_system, sourceName]);
    const skippedRows = Math.max(validRows.length - importedRows, 0);
    await pool.query(`UPDATE erp_import_batches SET status='completed', completed_at=NOW(), imported_rows=?, skipped_rows=?, error_rows=0 WHERE id=?`, [importedRows, skippedRows, batchId]);
    await pool.query(`INSERT INTO erp_import_reconciliations
      (batch_id, source_table, target_table, source_count, target_count, imported_count, skipped_count, error_count, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'completed')`, [batchId, config.sourceTable, config.table, validRows.length, Number(target.count), importedRows, skippedRows]);
    await pool.query('INSERT INTO erp_import_logs (batch_id, level, message) VALUES (?, ?, ?)', [batchId, 'info', `完成 ${config.sourceTable} 匯入 ${importedRows} 筆`]);
  }
}

async function syncCommonParameters(sourceName) {
  const source = sourceDatabases[sourceName];
  if (!source || source.adapter_code !== 'ism-sh') return;
  const sourcePool = getSourcePool(sourceName);
  const [[table]] = await sourcePool.query('SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND LOWER(TABLE_NAME)=\'cmsma\'');
  if (!Number(table.count)) return;
  const [rows] = await sourcePool.query('SELECT * FROM cmsma LIMIT 1');
  if (!rows.length) return;
  for (const [field, value] of Object.entries(rows[0])) {
    if (!/^MA\d+$/.test(field) || value === null || String(value).trim() === '') continue;
    await pool.query(`INSERT IGNORE INTO erp_common_parameters
      (tenant_id, company_id, source_system, parameter_code, parameter_value, data_type, source_field, source_database, source_table, source_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      source.tenant_id, source.company_id, source.source_system, field, String(value), typeof value === 'number' ? 'number' : 'text', field,
      sourceName, 'cmsma', `${source.tenant_id}:${source.company_id}:cmsma:${field}`
    ]);
  }
}

function registerCanonicalMasterRoutes(app) {
  for (const [type, config] of Object.entries(canonicalMasterConfigs)) {
    app.get(`/api/master/${type}`, async (req, res, next) => {
      try {
        const sourceName = sourceDbFromRequest(req);
        await ensureProcurementSchema();
        await syncCanonicalMaster(sourceName, type);
        for (const relatedType of config.related || []) await syncCanonicalMaster(sourceName, relatedType);
        const source = sourceDatabases[sourceName];
        const keyword = String(req.query.keyword || '').trim();
        const where = keyword ? `AND CONCAT_WS(' ', ${config.fields.join(', ')}) LIKE ?` : '';
        const params = keyword ? [source.tenant_id, source.company_id, source.source_system, sourceName, `%${keyword}%`] : [source.tenant_id, source.company_id, source.source_system, sourceName];
        const [rows] = await pool.query(`SELECT ${config.select} FROM ${config.table} WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? ${where} ORDER BY ${config.code} LIMIT 200`, params);
        res.json({ ok:true, data:rows, source:`inventory_erp.${config.table}` });
      } catch (error) { next(error); }
    });

    app.post(`/api/master/${type}`, async (req, res, next) => {
      try {
        const sourceName = sourceDbFromRequest(req);
        requireShMasterSource(sourceName);
        const body = req.body || {};
        const code = trim(body[config.code]);
        const name = trim(body[config.name]);
        if (!code || (!config.allowNameBlank && !name)) throw badRequest(config.allowNameBlank ? `${config.code} 為必填` : `${config.code} 與 ${config.name} 為必填`);
        for (const field of config.required || []) if (!trim(body[field])) throw badRequest(`${field} 為必填`);
        const values = config.fields.map(field => trim(body[field]) || null);
        const source = sourceDatabases[sourceName];
        const fields = [...config.fields, 'tenant_id', 'company_id', 'source_system', 'source_database', 'source_table', 'source_key'];
        await pool.query(`INSERT INTO ${config.table} (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`, [
          ...values, source.tenant_id, source.company_id, source.source_system, sourceName, 'inventory_erp', `${source.tenant_id}:${source.company_id}:${source.source_system}:NEW:${code}`
        ]);
        res.status(201).json({ ok:true, data:{ code } });
      } catch (error) { if (error.code === 'ER_DUP_ENTRY') error = badRequest('代號已存在'); next(error); }
    });

    app.put(`/api/master/${type}/:code`, async (req, res, next) => {
      try {
        const sourceName = sourceDbFromRequest(req);
        requireShMasterSource(sourceName);
        const code = trim(req.params.code);
        const body = req.body || {};
        const name = trim(body[config.name]);
        if (!code || (!config.allowNameBlank && !name)) throw badRequest(config.allowNameBlank ? `${config.code} 為必填` : `${config.code} 與 ${config.name} 為必填`);
        for (const field of config.required || []) if (!trim(body[field])) throw badRequest(`${field} 為必填`);
        const fields = config.fields.filter(field => field !== config.code);
        const values = fields.map(field => trim(body[field]) || null);
        const source = sourceDatabases[sourceName];
        const [result] = await pool.query(`UPDATE ${config.table} SET ${fields.map(field => `${field}=?`).join(', ')} WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND ${config.code}=?`, [...values, source.tenant_id, source.company_id, source.source_system, sourceName, code]);
        if (!result.affectedRows) throw notFound('找不到要修改的主檔資料');
        res.json({ ok:true, data:{ code } });
      } catch (error) { next(error); }
    });
  }
  app.get('/api/master/common-parameters', async (req, res, next) => {
    try {
      const sourceName = sourceDbFromRequest(req);
      await ensureProcurementSchema();
      await syncCommonParameters(sourceName);
      const source = sourceDatabases[sourceName];
      const keyword = String(req.query.keyword || '').trim();
      const where = keyword ? 'AND CONCAT_WS(\' \', parameter_code, parameter_value, source_field) LIKE ?' : '';
      const params = keyword ? [source.tenant_id, source.company_id, source.source_system, sourceName, `%${keyword}%`] : [source.tenant_id, source.company_id, source.source_system, sourceName];
      const [rows] = await pool.query(`SELECT parameter_code, parameter_value, data_type, source_field
        FROM erp_common_parameters WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? ${where}
        ORDER BY parameter_code LIMIT 200`, params);
      res.json({ ok:true, data:rows, source:'inventory_erp.erp_common_parameters' });
    } catch (error) { next(error); }
  });
}

function inventoryOpeningValidation(quantity, amount) {
  const qty = Number(quantity || 0);
  const value = Number(amount || 0);
  if (qty === 0 && value !== 0) return { status:'error', message:'庫存數量為 0，但庫存金額不為 0，必須修正後才能過帳。' };
  const warnings = [];
  if (qty < 0) warnings.push('來源為負庫存');
  if (qty !== 0 && value === 0) warnings.push('來源庫存成本為 0');
  return { status:warnings.length ? 'warning' : 'ok', message:warnings.join('；') || null };
}

async function refreshInventoryOpeningBatch(conn, batchId, nextStatus = null) {
  await conn.query(`UPDATE erp_inventory_opening_lines SET
    unit_cost=CASE WHEN quantity<>0 THEN amount/quantity ELSE 0 END,
    validation_status=CASE WHEN quantity=0 AND amount<>0 THEN 'error' WHEN quantity<0 OR (quantity<>0 AND amount=0) THEN 'warning' ELSE 'ok' END,
    validation_message=CASE
      WHEN quantity=0 AND amount<>0 THEN '庫存數量為 0，但庫存金額不為 0，必須修正後才能過帳。'
      WHEN quantity<0 AND amount=0 THEN '來源為負庫存；來源庫存成本為 0'
      WHEN quantity<0 THEN '來源為負庫存'
      WHEN quantity<>0 AND amount=0 THEN '來源庫存成本為 0'
      ELSE NULL END
    WHERE batch_id=?`, [batchId]);
  const [[summary]] = await conn.query(`SELECT COUNT(*) imported_rows,
    SUM(validation_status='error') error_rows, SUM(validation_status='warning') warning_rows,
    COALESCE(SUM(quantity),0) total_quantity, COALESCE(SUM(amount),0) total_amount
    FROM erp_inventory_opening_lines WHERE batch_id=?`, [batchId]);
  const status = nextStatus || (Number(summary.error_rows) ? 'draft_with_errors' : 'draft');
  await conn.query(`UPDATE erp_inventory_opening_batches SET status=?, imported_rows=?, error_rows=?, warning_rows=?, total_quantity=?, total_amount=? WHERE id=?`,
    [status, summary.imported_rows, summary.error_rows, summary.warning_rows, summary.total_quantity, summary.total_amount, batchId]);
  return summary;
}

function registerInventoryOpeningRoutes(app) {
  app.get('/api/inventory-opening', async (req, res, next) => {
    try {
      const sourceName = sourceDbFromRequest(req); requireShMasterSource(sourceName); await ensureProcurementSchema();
      const source = sourceDatabases[sourceName];
      const requestedId = Number(req.query.batch_id || 0);
      const params = requestedId
        ? [requestedId, source.tenant_id, source.company_id, source.source_system, sourceName]
        : [source.tenant_id, source.company_id, source.source_system, sourceName];
      const [[batch]] = requestedId
        ? await pool.query(`SELECT * FROM erp_inventory_opening_batches WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=?`, params)
        : await pool.query(`SELECT * FROM erp_inventory_opening_batches WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? ORDER BY id DESC LIMIT 1`, params);
      if (!batch) return res.json({ ok:true, data:{ batch:null, lines:[], source:'SH.invmc' } });
      const keyword = trim(req.query.keyword);
      const limit = Math.min(Math.max(Number(req.query.limit || 200), 1), 1000);
      const where = keyword ? "AND CONCAT_WS(' ', item_code, item_name, warehouse_code, warehouse_name, validation_message) LIKE ?" : '';
      const lineParams = keyword ? [batch.id, `%${keyword}%`] : [batch.id];
      const [lines] = await pool.query(`SELECT id, line_no, item_code, item_name, specification, unit,
        warehouse_code, warehouse_name, location_code, quantity, unit_cost, amount,
        validation_status, validation_message, note FROM erp_inventory_opening_lines
        WHERE batch_id=? ${where} ORDER BY validation_status='error' DESC, validation_status='warning' DESC, item_code, warehouse_code LIMIT ${limit}`, lineParams);
      res.json({ ok:true, data:{ batch, lines, source:'SH.invmc (MC001/MC002/MC003/MC007/MC008)' } });
    } catch (error) { next(error); }
  });

  app.post('/api/inventory-opening/import', async (req, res, next) => {
    try {
      const sourceName = sourceDbFromRequest(req); requireShMasterSource(sourceName); await ensureProcurementSchema();
      await syncCanonicalMaster(sourceName, 'items'); await syncCanonicalMaster(sourceName, 'warehouses');
      const source = sourceDatabases[sourceName]; const sourcePool = getSourcePool(sourceName);
      const [rows] = await sourcePool.query(`SELECT TRIM(s.MC001) item_code, m.MB002 item_name, m.MB003 specification, m.MB004 unit,
        TRIM(s.MC002) warehouse_code, w.MC002 warehouse_name, TRIM(s.MC003) location_code,
        s.MC007 quantity, s.MC008 amount
        FROM invmc s
        LEFT JOIN invmb m ON m.COMPANY=s.COMPANY AND m.MB001=s.MC001
        LEFT JOIN cmsmc w ON w.COMPANY=s.COMPANY AND w.MC001=s.MC002
        WHERE s.MC007<>0 OR s.MC008<>0 ORDER BY s.MC001, s.MC002, s.MC003`);
      if (!rows.length) throw badRequest('SH.invmc 目前沒有可開帳的庫存數量或金額');
      const [itemRows] = await pool.query(`SELECT item_code FROM erp_items WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=?`, [source.tenant_id, source.company_id, source.source_system, sourceName]);
      const [warehouseRows] = await pool.query(`SELECT warehouse_code FROM erp_warehouses WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=?`, [source.tenant_id, source.company_id, source.source_system, sourceName]);
      const itemSet = new Set(itemRows.map(row => trim(row.item_code))); const warehouseSet = new Set(warehouseRows.map(row => trim(row.warehouse_code)));
      const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14); const nonce=Math.random().toString(36).slice(2,6).toUpperCase();
      const openingDate = /^\d{8}$/.test(trim(req.body?.opening_date)) ? trim(req.body.opening_date) : new Date().toLocaleDateString('sv-SE', { timeZone:'Asia/Taipei' }).replaceAll('-', '');
      const openingNo = `OPEN-${sourceName}-${stamp}-${nonce}`; const importNo = `IMP-OPEN-${sourceName}-${stamp}-${nonce}`;
      const result = await tx(async (conn) => {
        await conn.query(`UPDATE erp_inventory_opening_batches SET status='superseded'
          WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND status IN ('draft','draft_with_errors','validated')`,
          [source.tenant_id, source.company_id, source.source_system, sourceName]);
        const [importBatch] = await conn.query(`INSERT INTO erp_import_batches
          (batch_no, tenant_id, company_id, source_system, source_database, status, initiated_by, started_at, total_tables, total_rows, notes)
          VALUES (?, ?, ?, ?, ?, 'running', ?, NOW(), 1, ?, '庫存開帳來源：SH.invmc；僅匯入數量或金額不為 0 的品號庫別資料')`,
          [importNo, source.tenant_id, source.company_id, source.source_system, sourceName, req.auth?.id || null, rows.length]);
        const [opening] = await conn.query(`INSERT INTO erp_inventory_opening_batches
          (opening_no, tenant_id, company_id, source_system, source_database, opening_date, status, source_rows, import_batch_id, note, created_by)
          VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
          [openingNo, source.tenant_id, source.company_id, source.source_system, sourceName, openingDate, rows.length, importBatch.insertId, trim(req.body?.note) || null, req.auth?.id || null]);
        const errors = [];
        for (let start=0; start<rows.length; start+=300) {
          const values=[]; const groups=[];
          rows.slice(start,start+300).forEach((row,index) => {
            const messages=[]; let status='ok';
            if (!itemSet.has(row.item_code)) { status='error'; messages.push('品號尚未匯入標準主檔'); }
            if (!warehouseSet.has(row.warehouse_code)) { status='error'; messages.push('庫別尚未匯入標準主檔'); }
            const check=inventoryOpeningValidation(row.quantity,row.amount);
            if (check.status==='error') status='error'; else if (check.status==='warning' && status==='ok') status='warning';
            if (check.message) messages.push(check.message);
            const lineNo=start+index+1; const sourceKey=`${row.item_code}|${row.warehouse_code}|${row.location_code || ''}`;
            values.push(opening.insertId,lineNo,row.item_code,row.item_name || '',row.specification || '',row.unit || '',row.warehouse_code,row.warehouse_name || '',row.location_code || '',Number(row.quantity||0),Number(row.quantity||0)!==0?Number(row.amount||0)/Number(row.quantity):0,Number(row.amount||0),status,messages.join('；')||null,'invmc',sourceKey,null);
            groups.push(`(${Array(17).fill('?').join(',')})`);
            if (status==='error') errors.push({ sourceKey, message:messages.join('；'), row });
          });
          await conn.query(`INSERT INTO erp_inventory_opening_lines
            (batch_id,line_no,item_code,item_name,specification,unit,warehouse_code,warehouse_name,location_code,quantity,unit_cost,amount,validation_status,validation_message,source_table,source_key,note)
            VALUES ${groups.join(',')}`, values);
        }
        const summary = await refreshInventoryOpeningBatch(conn, opening.insertId);
        for (const error of errors) await conn.query(`INSERT INTO erp_import_errors
          (batch_id, source_table, source_key, error_code, error_message, payload_json)
          VALUES (?, 'invmc', ?, 'OPENING_VALIDATION', ?, ?)`, [importBatch.insertId, error.sourceKey, error.message, JSON.stringify(error.row)]);
        await conn.query(`UPDATE erp_import_batches SET status=?, completed_at=NOW(), imported_rows=?, skipped_rows=0, error_rows=? WHERE id=?`,
          [Number(summary.error_rows)?'completed_with_errors':'completed', summary.imported_rows, summary.error_rows, importBatch.insertId]);
        await conn.query(`INSERT INTO erp_import_reconciliations
          (batch_id, source_table, target_table, source_count, target_count, imported_count, skipped_count, error_count, status, note)
          VALUES (?, 'invmc', 'erp_inventory_opening_lines', ?, ?, ?, 0, ?, ?, '篩選 MC007<>0 OR MC008<>0')`,
          [importBatch.insertId, rows.length, summary.imported_rows, summary.imported_rows, summary.error_rows, Number(summary.error_rows)?'needs_review':'completed']);
        return { id:opening.insertId, opening_no:openingNo, ...summary };
      });
      res.status(201).json({ ok:true, data:result });
    } catch (error) { next(error); }
  });

  app.put('/api/inventory-opening/:batchId/lines/:lineId', async (req, res, next) => {
    try {
      const batchId=Number(req.params.batchId), lineId=Number(req.params.lineId);
      const quantity=Number(req.body?.quantity), amount=Number(req.body?.amount);
      if (!Number.isFinite(quantity) || !Number.isFinite(amount)) throw badRequest('數量與金額必須是有效數字');
      await tx(async (conn) => {
        const [[batch]]=await conn.query("SELECT status FROM erp_inventory_opening_batches WHERE id=? FOR UPDATE",[batchId]);
        if (!batch) throw notFound('找不到庫存開帳批次');
        if (!['draft','draft_with_errors','validated'].includes(batch.status)) throw badRequest('只有草稿或已驗證批次可以修改');
        const [changed]=await conn.query(`UPDATE erp_inventory_opening_lines SET quantity=?, amount=?, note=? WHERE id=? AND batch_id=?`,[quantity,amount,trim(req.body?.note)||null,lineId,batchId]);
        if (!changed.affectedRows) throw notFound('找不到庫存開帳明細');
        await refreshInventoryOpeningBatch(conn,batchId);
      });
      res.json({ok:true,data:{id:lineId}});
    } catch(error){next(error);}
  });

  app.post('/api/inventory-opening/:id/validate', async (req, res, next) => {
    try {
      const id=Number(req.params.id);
      const summary=await tx(async conn=>{
        const [[batch]]=await conn.query("SELECT status, import_batch_id FROM erp_inventory_opening_batches WHERE id=? FOR UPDATE",[id]);
        if(!batch) throw notFound('找不到庫存開帳批次');
        if(!['draft','draft_with_errors','validated'].includes(batch.status)) throw badRequest('此批次目前不能重新驗證');
        const result=await refreshInventoryOpeningBatch(conn,id);
        const status=Number(result.error_rows)?'draft_with_errors':'validated';
        await conn.query('UPDATE erp_inventory_opening_batches SET status=?, validated_by=?, validated_at=NOW() WHERE id=?',[status,req.auth?.id||null,id]);
        if (batch.import_batch_id) {
          await conn.query("DELETE FROM erp_import_errors WHERE batch_id=? AND error_code='OPENING_VALIDATION'",[batch.import_batch_id]);
          const [errorLines]=await conn.query("SELECT source_key,validation_message,item_code,warehouse_code,quantity,amount FROM erp_inventory_opening_lines WHERE batch_id=? AND validation_status='error'",[id]);
          for(const line of errorLines) await conn.query(`INSERT INTO erp_import_errors
            (batch_id,source_table,source_key,error_code,error_message,payload_json) VALUES (?,'invmc',?,'OPENING_VALIDATION',?,?)`,
            [batch.import_batch_id,line.source_key,line.validation_message,JSON.stringify(line)]);
          await conn.query("UPDATE erp_import_batches SET status=?, error_rows=? WHERE id=?",[Number(result.error_rows)?'completed_with_errors':'completed',result.error_rows,batch.import_batch_id]);
          await conn.query("UPDATE erp_import_reconciliations SET error_count=?, status=? WHERE batch_id=? AND source_table='invmc' AND target_table='erp_inventory_opening_lines'",[result.error_rows,Number(result.error_rows)?'needs_review':'completed',batch.import_batch_id]);
        }
        return {...result,status};
      });
      res.json({ok:true,data:summary});
    } catch(error){next(error);}
  });

  app.post('/api/inventory-opening/:id/approve', async (req, res, next) => {
    try {
      const id=Number(req.params.id);
      const [result]=await pool.query(`UPDATE erp_inventory_opening_batches SET status='approved', approved_by=?, approved_at=NOW()
        WHERE id=? AND status='validated' AND error_rows=0`,[req.auth?.id||null,id]);
      if(!result.affectedRows) throw badRequest('必須先完成驗證且沒有錯誤，才能核准');
      res.json({ok:true,data:{id,status:'approved'}});
    } catch(error){next(error);}
  });

  app.post('/api/inventory-opening/:id/post', async (req, res, next) => {
    try {
      const id=Number(req.params.id);
      await tx(async conn=>{
        const [[batch]]=await conn.query('SELECT * FROM erp_inventory_opening_batches WHERE id=? FOR UPDATE',[id]);
        if(!batch) throw notFound('找不到庫存開帳批次');
        if(batch.status!=='approved' || Number(batch.error_rows)) throw badRequest('只有已核准且沒有錯誤的開帳批次可以過帳');
        await conn.query(`DELETE FROM erp_inventory_balances WHERE tenant_id=? AND company_id=? AND source_system=?`,[batch.tenant_id,batch.company_id,batch.source_system]);
        await conn.query(`INSERT INTO erp_inventory_balances
          (tenant_id,company_id,source_system,item_code,warehouse_code,location_code,quantity_on_hand,unit_cost,inventory_amount,opening_batch_id)
          SELECT ?,?,?,item_code,warehouse_code,COALESCE(location_code,''),quantity,unit_cost,amount,?
          FROM erp_inventory_opening_lines WHERE batch_id=?`,[batch.tenant_id,batch.company_id,batch.source_system,id,id]);
        await conn.query("UPDATE erp_inventory_opening_batches SET status='posted', posted_by=?, posted_at=NOW() WHERE id=?",[req.auth?.id||null,id]);
      });
      res.json({ok:true,data:{id,status:'posted'}});
    } catch(error){next(error);}
  });
}

function registerSourcePartnerRoutes(app) {
  const masters = {
    customers: {
      table: 'copma', label: '客戶', code: 'customer_code', name: 'customer_name',
      fields: { customer_code: 'MA001', short_name: 'MA002', customer_name: 'MA003', responsible_person: 'MA004', contact_name: 'MA005', phone: 'MA006', fax: 'MA008', email: 'MA009', mobile: 'MA138', tax_id: 'MA010', currency_code: 'MA014', payment_term_source_value: 'MA083', invoice_type: 'MA037', tax_type: 'MA038', closing_day: 'MA043' }
    },
    suppliers: {
      table: 'purma', label: '廠商', code: 'supplier_code', name: 'supplier_name',
      fields: { supplier_code: 'MA001', short_name: 'MA002', supplier_name: 'MA003', supplier_class: 'MA004', tax_id: 'MA005', phone: 'MA008', fax: 'MA010', email: 'MA011', responsible_person: 'MA012', contact_name: 'MA013', currency_code: 'MA021', payment_method: 'MA024', payment_term_source_value: 'MA025', invoice_type: 'MA030', tax_type: 'MA044', closing_month_offset: 'MA034', closing_day: 'MA035', mobile: 'MA095' }
    }
  };

  for (const [routeName, master] of Object.entries(masters)) {
    const outputFields = Object.entries(master.fields).map(([alias, column]) => `${column} AS ${alias}`).join(', ');
    const searchColumns = Object.values(master.fields);
    app.get(`/api/sh/${routeName}`, async (req, res, next) => {
      try {
        const sourceName = sourceDbFromRequest(req);
        const sourcePool = getSourcePool(sourceName);
        const keyword = String(req.query.keyword || '').trim();
        const where = keyword ? `WHERE CONCAT_WS(' ', ${searchColumns.join(', ')}) LIKE ?` : '';
        const [rows] = await sourcePool.query(`SELECT ${outputFields} FROM ${master.table} ${where} ORDER BY MA001 LIMIT 200`, keyword ? [`%${keyword}%`] : []);
        res.json({ ok: true, data: rows, source: `${sourceName}.${master.table}` });
      } catch (error) { next(error); }
    });

    app.post(`/api/sh/${routeName}`, async (req, res, next) => {
      try {
        const sourceName = sourceDbFromRequest(req);
        const sourcePool = getSourcePool(sourceName);
        const payload = req.body || {};
        const code = String(payload[master.code] || '').trim();
        const name = String(payload[master.name] || '').trim();
        if (!code || !name) throw badRequest(`${master.label}代號與名稱不可空白`);
        if (code.length > 10 || name.length > 72) throw badRequest(`${master.label}代號最多 10 碼，名稱最多 72 碼`);
        const dataColumns = Object.entries(master.fields);
        const columns = ['COMPANY', 'CREATOR', 'USR_GROUP', 'CREATE_DATE', 'MODIFIER', 'MODI_DATE', 'FLAG', ...dataColumns.map(([, column]) => column)];
        const values = [sourceName, 'DS', 'DS', new Date().toISOString().slice(0, 10).replaceAll('-', ''), 'DS', new Date().toISOString().slice(0, 10).replaceAll('-', ''), 1, ...dataColumns.map(([alias]) => String(payload[alias] || '').trim())];
        await sourcePool.query(`INSERT INTO ${master.table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, values);
        res.status(201).json({ ok: true, code });
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') error = badRequest(`${master.label}代號已存在`);
        next(error);
      }
    });

    app.put(`/api/sh/${routeName}/:code`, async (req, res, next) => {
      try {
        const sourceName = sourceDbFromRequest(req);
        const sourcePool = getSourcePool(sourceName);
        const code = String(req.params.code || '').trim();
        const payload = req.body || {};
        const name = String(payload[master.name] || '').trim();
        if (!code || !name) throw badRequest(`${master.label}代號與名稱不可空白`);
        const dataColumns = Object.entries(master.fields).filter(([alias]) => alias !== master.code);
        const set = [...dataColumns.map(([, column]) => `${column} = ?`), "MODIFIER = 'DS'", "MODI_DATE = DATE_FORMAT(NOW(), '%Y%m%d')"];
        const values = [...dataColumns.map(([alias]) => String(payload[alias] || '').trim()), sourceName, code];
        const [result] = await sourcePool.query(`UPDATE ${master.table} SET ${set.join(', ')} WHERE COMPANY = ? AND MA001 = ?`, values);
        if (!result.affectedRows) throw notFound(`${master.label}資料不存在`);
        res.json({ ok: true, code });
      } catch (error) { next(error); }
    });
  }
}

async function nextWorkflowNumber(conn, table, column, prefix, date) {
  const datePart = dateText(date).replaceAll('-', '');
  const like = `${prefix}-${datePart}-%`;
  const [[row]] = await conn.query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} LIKE ?`, [like]);
  return `${prefix}-${datePart}-${String(Number(row.count) + 1).padStart(4, '0')}`;
}

async function nextConfiguredDocumentNumber(conn, table, column, documentType, date) {
  const method = String(documentType.numbering_method || 'daily');
  if (method === 'manual') throw badRequest('此單別採手動編號，請輸入單號');
  const compact = String(date).replaceAll('-', '');
  const yearDigits = Math.min(Math.max(Number(documentType.year_digits) || 4, 1), 4);
  const serialDigits = Math.min(Math.max(Number(documentType.serial_digits) || 4, 1), 9);
  const year = compact.slice(0, 4).slice(-yearDigits);
  const period = method === 'daily' ? `${year}${compact.slice(4, 8)}` : method === 'monthly' ? `${year}${compact.slice(4, 6)}` : '';
  const prefix = String(documentType.number_prefix || documentType.type_code).trim();
  const base = `${prefix}${period}`;
  const [[row]] = await conn.query(`SELECT ${column} AS no FROM ${table} WHERE ${column} LIKE ? ORDER BY ${column} DESC LIMIT 1 FOR UPDATE`, [`${base}%`]);
  const last = row?.no ? Number(String(row.no).slice(-serialDigits)) || 0 : 0;
  return `${base}${String(last + 1).padStart(serialDigits, '0')}`;
}

// A document type belongs to one company/source only.  These helpers are
// intentionally shared by purchasing and sales so a selected type controls
// the same four rules everywhere: source document, approval, settlement and
// numbering.  The legacy ERP remains a read-only reference.
function documentTypeNeedsApproval(documentType) {
  return Number(documentType?.requires_approval ?? 1) === 1 && Number(documentType?.auto_confirm || 0) !== 1;
}

function configuredSourceKind(documentType) {
  return trim(documentType?.source_document_kind)
    || (Number(documentType?.require_purchase_order || 0) ? 'purchase_order' : '')
    || (Number(documentType?.require_sales_order || 0) ? 'sales_order' : '');
}

function assertConfiguredSource(documentType, sourceKind, hasSource, label) {
  const required = Number(documentType?.require_source_document ?? 0) === 1
    || Number(documentType?.require_purchase_order ?? 0) === 1
    || Number(documentType?.require_sales_order ?? 0) === 1;
  const expected = configuredSourceKind(documentType);
  if (required && !hasSource) throw badRequest(`${label}選用的單別必須帶入前置單據${expected ? `（${expected}）` : ''}`);
  if (hasSource && expected && sourceKind && expected !== sourceKind) {
    throw badRequest(`${label}選用的單別只允許由 ${expected} 轉入，目前來源為 ${sourceKind}`);
  }
}

const PROCUREMENT_EPS = 0.000001;

function nonNegativeNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function receiptExpenseTotal(row) {
  return nonNegativeNumber(row.freight_amount) + nonNegativeNumber(row.insurance_amount) + nonNegativeNumber(row.other_expense_amount);
}

// 費用是進貨明細上的整筆費用，計價時依「已計價量／驗收合格量」分攤，
// 讓分批計價、退貨與多筆合併應付可以用同一個基準核對。
function receiptPricingValues(row, pricedQuantity = row.qty_priced) {
  const accepted = Math.max(nonNegativeNumber(row.qty_accepted), 0);
  const quantity = Math.max(nonNegativeNumber(pricedQuantity), 0);
  const expense = receiptExpenseTotal(row);
  const unitCost = Number(row.unit_cost || 0);
  const allocatedExpense = accepted > PROCUREMENT_EPS ? expense * quantity / accepted : 0;
  return {
    pricedAmount: quantity * unitCost + allocatedExpense,
    expenseAmount: expense,
    acceptedQuantity: accepted,
    quantity,
    unitCost
  };
}

function receiptDerivedQuantities(row) {
  const accepted = nonNegativeNumber(row.qty_accepted);
  const returned = nonNegativeNumber(row.qty_returned);
  const priced = nonNegativeNumber(row.qty_priced);
  const returnedPriced = nonNegativeNumber(row.qty_returned_priced);
  const activePriced = Math.max(priced - returnedPriced, 0);
  return {
    pricingEligibleQuantity: Math.max(accepted - returned + returnedPriced, 0),
    activePricedQuantity: activePriced,
    unpricedQuantity: Math.max(accepted - returned - activePriced, 0)
  };
}

async function getReceiptFinancialSummary(conn, receiptId, receiptItemId) {
  const [[row]] = await conn.query(`
    SELECT
      COALESCE(SUM(CASE WHEN v.status<>'voided' THEN vs.allocated_amount ELSE 0 END),0) billed_amount,
      COALESCE(SUM(CASE WHEN v.status IN ('approved','posted') AND oi.status<>'voided'
        THEN vs.allocated_amount * LEAST(1,GREATEST(0,oi.settled_amount/NULLIF(oi.original_amount,0))) ELSE 0 END),0) paid_amount
    FROM finance_voucher_sources vs
    JOIN finance_vouchers v ON v.id=vs.voucher_id
    LEFT JOIN finance_open_items oi ON oi.source_kind='finance_voucher' AND oi.source_document_id=v.id
    WHERE vs.source_kind='purchase_receipt' AND vs.source_document_id=? AND COALESCE(vs.source_document_item_id,0)=COALESCE(?,0)`,
    [receiptId, receiptItemId]);
  return {
    billedAmount: Number(row?.billed_amount || 0),
    paidAmount: Number(row?.paid_amount || 0)
  };
}

async function refreshProcurementPaidQuantities(conn, settlementId) {
  const [refs] = await conn.query(`
    SELECT DISTINCT vs.source_document_id receipt_id,vs.source_document_item_id receipt_item_id
    FROM finance_allocations a
    JOIN finance_open_items oi ON oi.id=a.open_item_id
    JOIN finance_vouchers v ON v.id=oi.source_document_id AND oi.source_kind='finance_voucher'
    JOIN finance_voucher_sources vs ON vs.voucher_id=v.id AND vs.source_kind='purchase_receipt'
    WHERE a.settlement_id=? AND vs.source_document_id IS NOT NULL`, [settlementId]);
  for (const ref of refs) {
    const [[item]] = await conn.query('SELECT * FROM procurement_receipt_items WHERE id=? FOR UPDATE', [ref.receipt_item_id]);
    if (!item) continue;
    const pricing = receiptPricingValues(item, item.qty_priced);
    const summary = await getReceiptFinancialSummary(conn, ref.receipt_id, ref.receipt_item_id);
    const active = receiptDerivedQuantities(item).activePricedQuantity;
    const ratio = pricing.pricedAmount > PROCUREMENT_EPS
      ? Math.min(1, Math.max(0, summary.paidAmount / pricing.pricedAmount)) : 0;
    await conn.query('UPDATE procurement_receipt_items SET qty_paid=? WHERE id=?', [Math.min(active, pricing.quantity * ratio), item.id]);
  }
}

function registerDocumentNatureRoutes(app) {
  const ctx = db => {
    const source = sourceDatabases[db];
    if (!source) throw badRequest(`找不到資料來源：${db}`);
    return { tenant_id:source.tenant_id||'default', company_id:source.company_id||db, source_system:source.source_system||source.adapter_code||'ism-sh', source_database:db };
  };
  const financeDefaults = [
    ['AR','settlement','61','AR61','應收結帳／憑單','ARV','1101','應收帳款','4101','銷貨收入','batch',0],
    ['AR','collection','64','AR64','應收收款／沖銷','ARC','1001','銀行存款','1101','應收帳款','batch',0],
    ['AR','note','65','AR65','應收票據','ARN','1101','應收帳款','1001','銀行存款','batch',0],
    ['AP','settlement','61','AP61','應付結帳／憑單','APV','1201','商品存貨','2101','應付帳款','batch',0],
    ['AP','payment','64','AP64','應付付款／沖銷','APP','2101','應付帳款','1001','銀行存款','batch',0],
    ['AP','note','65','AP65','應付票據','APN','2101','應付帳款','1001','銀行存款','batch',0],
    ['BANK','deposit','D1','BANK-D1','銀行存入','BD','1001','銀行存款','','','manual',0],
    ['BANK','withdrawal','W1','BANK-W1','銀行提領','BW','','','1001','銀行存款','manual',0],
    ['GL','journal','910','GL910','手動傳票','JV','', '', '', '', 'manual',0],
    ['GL','auto_journal','911','GL911','自動分錄傳票','JV','', '', '', '', 'manual',0]
  ];
  const naturePayload = (b, c) => ({
    tenant_id:c.tenant_id, company_id:c.company_id, source_system:c.source_system, source_database:c.source_database,
    module_code:trim(b.module_code).toUpperCase(), document_kind:trim(b.document_kind), nature_code:trim(b.nature_code)||trim(b.type_code),
    type_code:trim(b.type_code), type_name:trim(b.type_name), type_full_name:trim(b.type_full_name)||trim(b.type_name),
    number_prefix:trim(b.number_prefix)||trim(b.type_code), numbering_method:trim(b.numbering_method)||'daily',
    year_digits:Number(b.year_digits)||4, serial_digits:Number(b.serial_digits)||4,
    requires_approval:Number(b.requires_approval??1)?1:0, auto_confirm:Number(b.auto_confirm||0)?1:0,
    direct_settlement:Number(b.direct_settlement||0)?1:0, settlement_mode:trim(b.settlement_mode)||'batch',
    require_source_document:Number(b.require_source_document||0)?1:0, source_document_kind:trim(b.source_document_kind)||null,
    inventory_effect:trim(b.inventory_effect)||'none', debit_account_code:trim(b.debit_account_code)||null,
    debit_account_name:trim(b.debit_account_name)||null, credit_account_code:trim(b.credit_account_code)||null,
    credit_account_name:trim(b.credit_account_name)||null, is_default:Number(b.is_default||0)?1:0,
    is_active:Number(b.is_active??1)?1:0, source_table:trim(b.source_table)||'inventory_erp', source_status:'user_defined', note:trim(b.note)||null
  });
  async function upsertNature(n, overwrite=false) {
    const update = overwrite
      ? `type_name=VALUES(type_name),type_full_name=VALUES(type_full_name),nature_code=VALUES(nature_code),number_prefix=VALUES(number_prefix),numbering_method=VALUES(numbering_method),year_digits=VALUES(year_digits),serial_digits=VALUES(serial_digits),requires_approval=VALUES(requires_approval),auto_confirm=VALUES(auto_confirm),direct_settlement=VALUES(direct_settlement),settlement_mode=VALUES(settlement_mode),require_source_document=VALUES(require_source_document),source_document_kind=VALUES(source_document_kind),inventory_effect=VALUES(inventory_effect),debit_account_code=VALUES(debit_account_code),debit_account_name=VALUES(debit_account_name),credit_account_code=VALUES(credit_account_code),credit_account_name=VALUES(credit_account_name),is_default=VALUES(is_default),is_active=VALUES(is_active),source_table=VALUES(source_table),source_status=VALUES(source_status),note=VALUES(note)`
      : `type_name=VALUES(type_name),type_full_name=VALUES(type_full_name),nature_code=VALUES(nature_code),source_table=VALUES(source_table),source_status=IF(source_status='user_defined',source_status,VALUES(source_status))`;
    await pool.query(`INSERT INTO erp_document_natures
      (tenant_id,company_id,source_system,source_database,module_code,document_kind,nature_code,type_code,type_name,type_full_name,number_prefix,numbering_method,year_digits,serial_digits,requires_approval,auto_confirm,direct_settlement,settlement_mode,require_source_document,source_document_kind,inventory_effect,debit_account_code,debit_account_name,credit_account_code,credit_account_name,is_default,is_active,source_table,source_status,note)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE ${update}`,
      [n.tenant_id,n.company_id,n.source_system,n.source_database,n.module_code,n.document_kind,n.nature_code,n.type_code,n.type_name,n.type_full_name,n.number_prefix,n.numbering_method,n.year_digits,n.serial_digits,n.requires_approval,n.auto_confirm,n.direct_settlement,n.settlement_mode,n.require_source_document,n.source_document_kind,n.inventory_effect,n.debit_account_code,n.debit_account_name,n.credit_account_code,n.credit_account_name,n.is_default,n.is_active,n.source_table,n.source_status,n.note]);
  }
  async function syncFor(db) {
    const c=ctx(db); await ensureTargetDocumentNatureSchema(); await ensureTargetProcurementTypeSchema(); await ensureTargetSalesWorkflowSchema(); await ensureTargetFinanceWorkflowSchema();
    const [pRows]=await pool.query(`SELECT document_kind,type_code,type_name,type_full_name,nature_code,number_prefix,numbering_method,year_digits,serial_digits,requires_approval,auto_confirm,direct_settlement,settlement_mode,require_purchase_order,require_source_document,source_document_kind,ap_document_type,is_default,is_active,note,source_table FROM procurement_document_types WHERE tenant_id=? AND company_id=? AND source_system=?`,[c.tenant_id,c.company_id,c.source_system]);
    for(const r of pRows) await upsertNature({...c,module_code:'PUR',document_kind:r.document_kind,nature_code:r.nature_code||'',type_code:r.type_code,type_name:r.type_name,type_full_name:r.type_full_name,number_prefix:r.number_prefix,numbering_method:r.numbering_method,year_digits:r.year_digits,serial_digits:r.serial_digits,requires_approval:r.requires_approval,auto_confirm:r.auto_confirm,direct_settlement:Number(r.direct_settlement)||['whole','per_document'].includes(r.settlement_mode),settlement_mode:r.settlement_mode||'batch',require_source_document:Number(r.require_source_document)||Number(r.require_purchase_order),source_document_kind:r.source_document_kind||(r.require_purchase_order?'purchase_order':null),inventory_effect:r.document_kind==='receipt'?'in':r.document_kind==='purchase_return'?'out':'none',is_default:r.is_default,is_active:r.is_active,source_table:r.source_table||'procurement_document_types',source_status:'target_confirmed',note:r.note},false);
    const [sRows]=await pool.query(`SELECT document_kind,type_code,type_name,type_full_name,nature_code,number_prefix,numbering_method,year_digits,serial_digits,requires_approval,auto_confirm,direct_settlement,settlement_mode,require_sales_order,require_source_document,source_document_kind,ar_document_type,is_default,is_active,note,source_table FROM sales_document_types WHERE tenant_id=? AND company_id=? AND source_system=?`,[c.tenant_id,c.company_id,c.source_system]);
    for(const r of sRows) await upsertNature({...c,module_code:'SAL',document_kind:r.document_kind,nature_code:r.nature_code||'',type_code:r.type_code,type_name:r.type_name,type_full_name:r.type_full_name,number_prefix:r.number_prefix,numbering_method:r.numbering_method,year_digits:r.year_digits,serial_digits:r.serial_digits,requires_approval:r.requires_approval,auto_confirm:r.auto_confirm,direct_settlement:Number(r.direct_settlement)||['whole','per_document'].includes(r.settlement_mode),settlement_mode:r.settlement_mode||'batch',require_source_document:Number(r.require_source_document)||Number(r.require_sales_order),source_document_kind:r.source_document_kind||(r.require_sales_order?'sales_order':null),inventory_effect:r.document_kind==='shipment'?'out':r.document_kind==='sales_return'?'in':'none',is_default:r.is_default,is_active:r.is_active,source_table:r.source_table||'sales_document_types',source_status:'target_confirmed',note:r.note},false);
    for(const d of financeDefaults){const[nm,kind,nature,code,name,prefix,debitCode,debitName,creditCode,creditName,mode,direct]=d;await upsertNature({...c,module_code:nm,document_kind:kind,nature_code:nature,type_code:code,type_name:name,type_full_name:name,number_prefix:prefix,numbering_method:'daily',year_digits:4,serial_digits:4,requires_approval:1,auto_confirm:0,direct_settlement:direct,settlement_mode:mode,require_source_document:0,source_document_kind:null,inventory_effect:'none',debit_account_code:debitCode||null,debit_account_name:debitName||null,credit_account_code:creditCode||null,credit_account_name:creditName||null,is_default:1,is_active:1,source_table:'accounting_auto_rules',source_status:'standard_default',note:'標準預設；請依公司別與 iSM 單據性質確認'},false);}
    return c;
  }
  async function syncOperational(n,userId=null) {
    if(n.module_code==='PUR'){
      await ensureTargetProcurementTypeSchema(); await pool.query(`INSERT INTO procurement_document_types(tenant_id,company_id,source_system,document_kind,type_code,type_name,type_full_name,nature_code,number_prefix,numbering_method,year_digits,serial_digits,requires_approval,auto_confirm,direct_settlement,settlement_mode,require_purchase_order,require_source_document,source_document_kind,ap_document_type,is_default,is_active,note,source_database,source_table) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE type_name=VALUES(type_name),type_full_name=VALUES(type_full_name),nature_code=VALUES(nature_code),number_prefix=VALUES(number_prefix),numbering_method=VALUES(numbering_method),year_digits=VALUES(year_digits),serial_digits=VALUES(serial_digits),requires_approval=VALUES(requires_approval),auto_confirm=VALUES(auto_confirm),direct_settlement=VALUES(direct_settlement),settlement_mode=VALUES(settlement_mode),require_purchase_order=VALUES(require_purchase_order),require_source_document=VALUES(require_source_document),source_document_kind=VALUES(source_document_kind),ap_document_type=VALUES(ap_document_type),is_default=VALUES(is_default),is_active=VALUES(is_active),note=VALUES(note)`,[n.tenant_id,n.company_id,n.source_system,n.document_kind,n.type_code,n.type_name,n.type_full_name,n.nature_code,n.number_prefix,n.numbering_method,n.year_digits,n.serial_digits,n.requires_approval,n.auto_confirm,n.direct_settlement,n.settlement_mode,n.require_source_document,n.require_source_document,n.source_document_kind,n.module_code==='PUR'&&n.document_kind==='receipt'?n.type_code:null,n.is_default,n.is_active,n.note,n.source_database,'erp_document_natures']);
    }
    if(n.module_code==='SAL'){
      await ensureTargetSalesWorkflowSchema(); await pool.query(`INSERT INTO sales_document_types(tenant_id,company_id,source_system,document_kind,type_code,type_name,type_full_name,nature_code,number_prefix,numbering_method,year_digits,serial_digits,requires_approval,auto_confirm,direct_settlement,settlement_mode,require_sales_order,require_source_document,source_document_kind,ar_document_type,is_default,is_active,note,source_database,source_table) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE type_name=VALUES(type_name),type_full_name=VALUES(type_full_name),nature_code=VALUES(nature_code),number_prefix=VALUES(number_prefix),numbering_method=VALUES(numbering_method),year_digits=VALUES(year_digits),serial_digits=VALUES(serial_digits),requires_approval=VALUES(requires_approval),auto_confirm=VALUES(auto_confirm),direct_settlement=VALUES(direct_settlement),settlement_mode=VALUES(settlement_mode),require_sales_order=VALUES(require_sales_order),require_source_document=VALUES(require_source_document),source_document_kind=VALUES(source_document_kind),ar_document_type=VALUES(ar_document_type),is_default=VALUES(is_default),is_active=VALUES(is_active),note=VALUES(note)`,[n.tenant_id,n.company_id,n.source_system,n.document_kind,n.type_code,n.type_name,n.type_full_name,n.nature_code,n.number_prefix,n.numbering_method,n.year_digits,n.serial_digits,n.requires_approval,n.auto_confirm,n.direct_settlement,n.settlement_mode,n.require_source_document,n.require_source_document,n.source_document_kind,n.module_code==='SAL'&&n.document_kind==='shipment'?n.type_code:null,n.is_default,n.is_active,n.note,n.source_database,'erp_document_natures']);
    }
    if(['AR','AP'].includes(n.module_code)&&n.debit_account_code&&n.credit_account_code){
      await ensureTargetFinanceWorkflowSchema(); const ruleCode=`${n.module_code}-${n.document_kind}-${n.type_code}`; await pool.query(`INSERT INTO accounting_auto_rules(tenant_id,company_id,source_system,source_database,rule_code,module_code,document_kind,document_type,entry_role,debit_account_code,debit_account_name,credit_account_code,credit_account_name,is_active,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,? ,?,?) ON DUPLICATE KEY UPDATE document_kind=VALUES(document_kind),document_type=VALUES(document_type),debit_account_code=VALUES(debit_account_code),debit_account_name=VALUES(debit_account_name),credit_account_code=VALUES(credit_account_code),credit_account_name=VALUES(credit_account_name),is_active=VALUES(is_active),note=VALUES(note)`,[n.tenant_id,n.company_id,n.source_system,n.source_database,ruleCode,n.module_code,n.document_kind,n.type_code,'main',n.debit_account_code,n.debit_account_name||'',n.credit_account_code,n.credit_account_name||'',n.is_active,n.note,userId]);
    }
  }
  app.get('/api/document-natures',async(req,res,next)=>{try{const db=String(req.query.source_database||'SH').toUpperCase(),c=await syncFor(db),module=trim(req.query.module_code).toUpperCase();const params=[c.tenant_id,c.company_id,c.source_system,db],where=['tenant_id=?','company_id=?','source_system=?','source_database=?'];if(module){where.push('module_code=?');params.push(module);}const[rows]=await pool.query(`SELECT * FROM erp_document_natures WHERE ${where.join(' AND ')} ORDER BY module_code,document_kind,type_code`,params);res.json({ok:true,data:rows});}catch(e){next(e);}});
  app.post('/api/document-natures',async(req,res,next)=>{try{const b=req.body||{},db=String(b.source_database||'SH').toUpperCase(),c=ctx(db),n=naturePayload(b,c);if(!['PUR','SAL','AR','AP','BANK','GL'].includes(n.module_code)||!n.document_kind||!n.type_code||!n.type_name)throw badRequest('模組、單據種類、單別代號與名稱不可空白');await ensureTargetDocumentNatureSchema();if(n.is_default)await pool.query('UPDATE erp_document_natures SET is_default=0 WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND module_code=? AND document_kind=?',[c.tenant_id,c.company_id,c.source_system,db,n.module_code,n.document_kind]);await upsertNature(n,true);await syncOperational(n,req.auth?.id||null);res.status(201).json({ok:true,data:n});}catch(e){if(e.code==='ER_DUP_ENTRY')e=badRequest('目前公司別的相同單據性質已存在');next(e);}});
  app.put('/api/document-natures/:id',async(req,res,next)=>{try{const id=Number(req.params.id),db=String(req.body?.source_database||req.query.source_database||'SH').toUpperCase(),c=ctx(db),n=naturePayload(req.body||{},c);const[[old]]=await pool.query('SELECT * FROM erp_document_natures WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=?',[id,c.tenant_id,c.company_id,c.source_system,db]);if(!old)throw notFound('找不到目前公司別的單據性質');n.module_code=old.module_code;n.document_kind=old.document_kind;n.type_code=old.type_code;if(n.is_default)await pool.query('UPDATE erp_document_natures SET is_default=0 WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND module_code=? AND document_kind=? AND id<>?',[c.tenant_id,c.company_id,c.source_system,db,n.module_code,n.document_kind,id]);await pool.query(`UPDATE erp_document_natures SET type_name=?,type_full_name=?,nature_code=?,number_prefix=?,numbering_method=?,year_digits=?,serial_digits=?,requires_approval=?,auto_confirm=?,direct_settlement=?,settlement_mode=?,require_source_document=?,source_document_kind=?,inventory_effect=?,debit_account_code=?,debit_account_name=?,credit_account_code=?,credit_account_name=?,is_default=?,is_active=?,source_status='user_defined',note=? WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=?`,[n.type_name,n.type_full_name,n.nature_code,n.number_prefix,n.numbering_method,n.year_digits,n.serial_digits,n.requires_approval,n.auto_confirm,n.direct_settlement,n.settlement_mode,n.require_source_document,n.source_document_kind,n.inventory_effect,n.debit_account_code,n.debit_account_name,n.credit_account_code,n.credit_account_name,n.is_default,n.is_active,n.note,id,c.tenant_id,c.company_id,c.source_system,db]);await syncOperational({...n,id},req.auth?.id||null);res.json({ok:true,data:{id}});}catch(e){next(e);}});
  app.delete('/api/document-natures/:id',async(req,res,next)=>{try{const id=Number(req.params.id),db=String(req.query.source_database||'SH').toUpperCase(),c=ctx(db);const[r]=await pool.query('UPDATE erp_document_natures SET is_active=0 WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=?',[id,c.tenant_id,c.company_id,c.source_system,db]);if(!r.affectedRows)throw notFound('找不到目前公司別的單據性質');res.json({ok:true,data:{id,is_active:0}});}catch(e){next(e);}});
}

function registerProcurementWorkflowRoutes(app) {
  const contextFor = sourceDatabase => {
    const source = sourceDatabases[sourceDatabase] || {};
    return { tenant_id:source.tenant_id || sourceDatabase, company_id:source.company_id || sourceDatabase, source_system:source.source_system || 'iSM', source_database:sourceDatabase };
  };
  // 採購流程的日期必須晚於來源單據，且過帳只能發生在開放會計期間。
  // 這層在真正過帳 route 前執行，不改動原始來源資料庫。
  app.use('/api/inventory-workflow/procurement/:kind/:id/post', async (req,res,next) => {
    try {
      await ensureTargetFinanceWorkflowSchema();
      const kind=String(req.params.kind), id=Number(req.params.id);
      const db=String(req.body?.source_database||req.query.source_database||req.get('X-Source-Database')||'SH').toUpperCase();
      const c=contextFor(db);
      const table=kind==='receipt'?'procurement_receipts':kind==='return'?'procurement_returns':null;
      if (table) {
        const dateColumn=kind==='receipt'?'receipt_date':'return_date';
        const [[header]]=await pool.query(`SELECT * FROM ${table} WHERE id=? AND source_database=?`,[id,db]);
        if (header) await tx(async conn=>{
          await assertOpenAccountingPeriod(conn,c,header[dateColumn]);
          if (kind==='receipt') {
            const [[source]]=await conn.query(`SELECT MIN(o.order_date) source_date
              FROM procurement_receipt_items ri
              JOIN procurement_order_items oi ON oi.id=ri.purchase_order_item_id
              JOIN procurement_orders o ON o.id=oi.purchase_order_id
              WHERE ri.receipt_id=?`,[id]);
            assertChronologicalDate(header[dateColumn],source?.source_date,'進貨日期');
          } else {
            const [[source]]=await conn.query(`SELECT MIN(r.receipt_date) source_date
              FROM procurement_return_items rti
              JOIN procurement_receipt_items ri ON ri.id=rti.receipt_item_id
              JOIN procurement_receipts r ON r.id=ri.receipt_id
              WHERE rti.return_id=?`,[id]);
            assertChronologicalDate(header[dateColumn],source?.source_date,'退貨日期');
          }
        });
      }
      next();
    } catch(e){next(e);}
  });
  // SH legacy documents are shown as read-only source records.  Do not update
  // PURT* here: confirming those documents also affects inventory and AP.
  app.get('/api/sh/purchase-documents/:kind', async (req, res, next) => {
    try {
      const sourceName = sourceDbFromRequest(req);
      const sourcePool = getSourcePool(sourceName);
      const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
      const kind = req.params.kind;
      let sql = '';

      if (kind === 'requisitions') {
        sql = `SELECT 'official' AS record_origin, 'SH' AS record_source,
          h.TA001 AS document_type, h.TA002 AS document_no, h.TA013 AS document_date,
          h.TA012 AS requester_code, h.TA004 AS department_code, h.TA006 AS note,
          d.TB003 AS line_no, d.TB004 AS item_code, d.TB005 AS item_name, d.TB006 AS specification,
          d.TB008 AS warehouse_code, d.TB007 AS unit, d.TB009 AS quantity,
          0 AS related_quantity, d.TB011 AS required_date, d.TB012 AS item_note, d.TB033 AS status
          FROM purta h JOIN purtb d ON h.COMPANY=d.COMPANY AND h.TA001=d.TB001 AND h.TA002=d.TB002
          WHERE h.COMPANY=? ORDER BY h.TA013 DESC, h.TA002 DESC, d.TB003 LIMIT ?`;
      } else if (kind === 'orders') {
        sql = `SELECT 'official' AS record_origin, 'SH' AS record_source,
          h.TC001 AS document_type, h.TC002 AS document_no, h.TC003 AS document_date,
          h.TC004 AS supplier_code, h.TC005 AS currency_code, h.TC009 AS note,
          d.TD003 AS line_no, d.TD004 AS item_code, d.TD005 AS item_name, d.TD006 AS specification,
          d.TD007 AS warehouse_code, d.TD009 AS unit, d.TD008 AS quantity,
          d.TD015 AS related_quantity, d.TD010 AS unit_price, d.TD011 AS amount,
          d.TD012 AS expected_date, d.TD016 AS status,
          d.TD030 AS source_document_type, d.TD031 AS source_document_no, d.TD032 AS source_line
          FROM purtc h JOIN purtd d ON h.COMPANY=d.COMPANY AND h.TC001=d.TD001 AND h.TC002=d.TD002
          WHERE h.COMPANY=? ORDER BY h.TC003 DESC, h.TC002 DESC, d.TD003 LIMIT ?`;
      } else if (kind === 'receipts') {
        sql = `SELECT 'official' AS record_origin, 'SH' AS record_source,
          h.TG001 AS document_type, h.TG002 AS document_no, h.TG014 AS document_date,
          h.TG005 AS supplier_code, h.TG016 AS note,
          d.TH003 AS line_no, d.TH004 AS item_code, d.TH005 AS item_name, d.TH006 AS specification,
          d.TH009 AS warehouse_code, d.TH008 AS unit, d.TH007 AS quantity,
          d.TH015 AS qty_accepted, d.TH018 AS unit_cost, d.TH011 AS source_document_type,
          d.TH012 AS source_document_no, d.TH013 AS source_line, d.TH014 AS accepted_date, 'posted' AS status
          FROM purtg h JOIN purth d ON h.COMPANY=d.COMPANY AND h.TG001=d.TH001 AND h.TG002=d.TH002
          WHERE h.COMPANY=? ORDER BY h.TG014 DESC, h.TG002 DESC, d.TH003 LIMIT ?`;
      } else {
        throw badRequest(`Unknown purchase document type: ${kind}`);
      }

      const [rows] = await sourcePool.query(sql, [sourceName, limit]);
      res.json({ ok: true, data: rows, source: `${sourceName}.PURT*`, readOnly: true });
    } catch (error) { next(error); }
  });

  app.get('/api/procurement/requisition-lines', async (req, res, next) => {
    try {
      await ensureProcurementSchema();
      const sourceDatabase = String(req.query.source_database || 'SH').toUpperCase();
      const [rows] = await pool.query(`
        SELECT i.id, r.requisition_no, r.requisition_date, r.department_code, r.requester_code,
               i.line_no, i.item_code, i.item_name, i.specification, i.warehouse_code, i.unit,
               i.qty_requested, i.qty_ordered, (i.qty_requested - i.qty_ordered) AS remaining_quantity,
               i.required_date, i.note
        FROM procurement_requisition_items i
        JOIN procurement_requisitions r ON r.id = i.requisition_id
        WHERE r.source_database = ? AND r.status NOT IN ('cancelled', 'closed') AND i.qty_requested > i.qty_ordered
        ORDER BY r.requisition_date DESC, r.requisition_no DESC, i.line_no
      `, [sourceDatabase]);
      res.json({ ok: true, data: rows, source: 'inventory_erp.procurement_requisitions' });
    } catch (error) { next(error); }
  });

  app.get('/api/procurement/order-lines', async (req, res, next) => {
    try {
      await ensureProcurementSchema();
      await ensureTargetReceiptWorkflowSchema();
      const sourceDatabase = String(req.query.source_database || 'SH').toUpperCase();
      const [rows] = await pool.query(`
        SELECT i.id, o.purchase_order_no, o.order_date, o.supplier_code, o.currency_code,
               i.line_no, i.item_code, i.item_name, i.specification, i.warehouse_code, i.unit,
               i.qty_ordered, i.qty_received, i.qty_cancelled,
               COALESCE((SELECT SUM(ri.qty_received) FROM procurement_receipt_items ri
                 JOIN procurement_receipts pr ON pr.id=ri.receipt_id
                 WHERE ri.purchase_order_item_id=i.id AND pr.status='pending_inspection'),0) AS pending_arrival_quantity,
               GREATEST(i.qty_ordered - i.qty_received - i.qty_cancelled - COALESCE((SELECT SUM(ri.qty_received) FROM procurement_receipt_items ri
                 JOIN procurement_receipts pr ON pr.id=ri.receipt_id
                 WHERE ri.purchase_order_item_id=i.id AND pr.status='pending_inspection'),0), 0) AS remaining_quantity,
               i.unit_price, i.expected_date, i.note
        FROM procurement_order_items i
        JOIN procurement_orders o ON o.id = i.purchase_order_id
        WHERE o.source_database = ? AND o.status IN ('confirmed','partial_received') AND i.qty_ordered > i.qty_received + i.qty_cancelled
        ORDER BY o.order_date DESC, o.purchase_order_no DESC, i.line_no
      `, [sourceDatabase]);
      res.json({ ok: true, data: rows, source: 'inventory_erp.procurement_orders' });
    } catch (error) { next(error); }
  });

  app.post('/api/procurement/requisitions', async (req, res, next) => {
    try {
      await ensureProcurementSchema();
      const body = req.body || {};
      const sourceDatabase = String(body.source_database || 'SH').toUpperCase();
      const date = validDate(body.requisition_date);
      const itemCode = String(body.item_code || '').trim();
      const quantity = positiveNumber(body.qty_requested, '請購數量');
      if (!itemCode) throw badRequest('品號不可空白');
      const context = contextFor(sourceDatabase); const typeCode = trim(body.document_type);
      const [[documentType]] = await pool.query(`SELECT * FROM procurement_document_types WHERE tenant_id=? AND company_id=? AND source_system=? AND document_kind='requisition' AND type_code=? AND is_active=1`,[context.tenant_id,context.company_id,context.source_system,typeCode]);
      if (!documentType) throw badRequest('請選擇有效的請購單別');
      const result = await tx(async (conn) => {
        const documentNo = String(body.requisition_no || '').trim() || await nextConfiguredDocumentNumber(conn, 'procurement_requisitions', 'requisition_no', documentType, date);
        const [header] = await conn.query(`INSERT INTO procurement_requisitions
          (tenant_id, company_id, source_system, document_type, requisition_no, requisition_date, requester_code, department_code, warehouse_code, status, note, source_database)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [context.tenant_id, context.company_id, context.source_system, trim(body.document_type) || 'RQ', documentNo, date, trim(body.requester_code), trim(body.department_code), trim(body.warehouse_code), documentTypeNeedsApproval(documentType) ? 'draft' : 'approved', trim(body.note), sourceDatabase]);
        await conn.query(`INSERT INTO procurement_requisition_items
          (requisition_id, line_no, item_code, item_name, specification, warehouse_code, unit, qty_requested, required_date, note)
          VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`, [header.insertId, itemCode, trim(body.item_name), trim(body.specification), trim(body.warehouse_code), trim(body.unit) || 'PCS', quantity, nullableDate(body.required_date), trim(body.item_note)]);
        return { id: header.insertId, documentNo };
      });
      res.status(201).json({ ok: true, ...result });
    } catch (error) { next(error); }
  });

  app.post('/api/procurement/orders', async (req, res, next) => {
    try {
      await ensureProcurementSchema();
      const body = req.body || {};
      const sourceDatabase = String(body.source_database || 'SH').toUpperCase();
      const date = validDate(body.order_date);
      const supplierCode = trim(body.supplier_code);
      const itemCode = trim(body.item_code);
      const sourceLineId = Number(body.requisition_item_id || 0) || null;
      if (!supplierCode || !itemCode) throw badRequest('供應廠商與品號不可空白');
      const quantity = positiveNumber(body.qty_ordered, '採購數量');
      const context = contextFor(sourceDatabase); const typeCode = trim(body.document_type);
      const [[documentType]] = await pool.query(`SELECT * FROM procurement_document_types WHERE tenant_id=? AND company_id=? AND source_system=? AND document_kind='purchase_order' AND type_code=? AND is_active=1`,[context.tenant_id,context.company_id,context.source_system,typeCode]);
      if (!documentType) throw badRequest('請選擇有效的採購單別');
      const result = await tx(async (conn) => {
        let sourceLine = null;
        assertConfiguredSource(documentType, 'requisition', Boolean(sourceLineId), '採購單');
        if (sourceLineId) {
          const [[row]] = await conn.query(`SELECT i.*, r.id AS header_id, r.status AS header_status FROM procurement_requisition_items i JOIN procurement_requisitions r ON r.id=i.requisition_id WHERE i.id=? AND r.source_database=? FOR UPDATE`, [sourceLineId, sourceDatabase]);
          if (!row) throw notFound('請購來源明細不存在');
          if (row.header_status !== 'approved') throw badRequest('請購單必須先核準才能轉採購');
          if (!Number(row.purchase_locked)) throw badRequest('請先完成請購資料維護並鎖定採購資料');
          const [[draftReserved]] = await conn.query(`SELECT COALESCE(SUM(oi.qty_ordered),0) AS quantity
            FROM procurement_order_items oi JOIN procurement_orders po ON po.id=oi.purchase_order_id
            WHERE oi.requisition_item_id=? AND po.status='draft'`, [sourceLineId]);
          if (Number(row.qty_requested) - Number(row.qty_ordered) - Number(draftReserved.quantity) < quantity) throw badRequest('採購數量不可超過請購未轉量（含待核準採購）');
          sourceLine = row;
        }
        const documentNo = trim(body.purchase_order_no) || await nextConfiguredDocumentNumber(conn, 'procurement_orders', 'purchase_order_no', documentType, date);
        const [header] = await conn.query(`INSERT INTO procurement_orders
          (tenant_id, company_id, source_system, document_type, purchase_order_no, supplier_code, order_date, expected_date, currency_code, status, note, source_database)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [context.tenant_id, context.company_id, context.source_system, trim(body.document_type) || 'PO', documentNo, supplierCode, date, nullableDate(body.expected_date), trim(body.currency_code) || 'TWD', documentTypeNeedsApproval(documentType) ? 'draft' : 'confirmed', trim(body.note), sourceDatabase]);
        await conn.query(`INSERT INTO procurement_order_items
          (purchase_order_id, requisition_item_id, line_no, item_code, item_name, specification, warehouse_code, unit, qty_ordered, unit_price, expected_date, note)
          VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [header.insertId, sourceLineId, itemCode, trim(body.item_name) || sourceLine?.item_name || '', trim(body.specification) || sourceLine?.specification || '', trim(body.warehouse_code) || sourceLine?.warehouse_code || '', trim(body.unit) || sourceLine?.unit || 'PCS', quantity, Number(body.unit_price || 0), nullableDate(body.expected_date) || sourceLine?.required_date || null, trim(body.item_note)]);
        if (sourceLine && !documentTypeNeedsApproval(documentType)) {
          await conn.query('UPDATE procurement_requisition_items SET qty_ordered = qty_ordered + ? WHERE id = ?', [quantity, sourceLineId]);
          const [[remaining]] = await conn.query('SELECT COUNT(*) AS count FROM procurement_requisition_items WHERE requisition_id=? AND qty_requested > qty_ordered', [sourceLine.header_id]);
          await conn.query('UPDATE procurement_requisitions SET status=? WHERE id=?', [Number(remaining.count) ? 'draft' : 'converted', sourceLine.header_id]);
        }
        return { id: header.insertId, documentNo };
      });
      res.status(201).json({ ok: true, ...result });
    } catch (error) { next(error); }
  });

  app.post('/api/procurement/receipts', async (req, res, next) => {
    try {
      await ensureProcurementSchema();
      await ensureTargetReceiptWorkflowSchema();
      const body = req.body || {};
      const sourceDatabase = String(body.source_database || 'SH').toUpperCase();
      const date = validDate(body.receipt_date);
      const sourceLineId = Number(body.purchase_order_item_id || 0) || null;
      const itemCode = trim(body.item_code);
      const quantity = positiveNumber(body.qty_received, '進貨數量');
      const context = contextFor(sourceDatabase); const typeCode = trim(body.document_type);
      const [[documentType]] = await pool.query(`SELECT * FROM procurement_document_types WHERE tenant_id=? AND company_id=? AND source_system=? AND document_kind='receipt' AND type_code=? AND is_active=1`,[context.tenant_id,context.company_id,context.source_system,typeCode]);
      if (!documentType) throw badRequest('請選擇有效的進貨單別');
      const result = await tx(async (conn) => {
        let sourceLine = null;
        assertConfiguredSource(documentType, 'purchase_order', Boolean(sourceLineId), '進貨單');
        if (sourceLineId) {
          const [[row]] = await conn.query(`SELECT i.*, o.id AS header_id, o.supplier_code FROM procurement_order_items i JOIN procurement_orders o ON o.id=i.purchase_order_id WHERE i.id=? AND o.source_database=? FOR UPDATE`, [sourceLineId, sourceDatabase]);
          if (!row) throw notFound('採購來源明細不存在');
          const [[arrivalReserved]] = await conn.query(`SELECT COALESCE(SUM(ri.qty_received),0) quantity
            FROM procurement_receipt_items ri JOIN procurement_receipts pr ON pr.id=ri.receipt_id
            WHERE ri.purchase_order_item_id=? AND pr.status='pending_inspection' FOR UPDATE`, [sourceLineId]);
          const remaining=Number(row.qty_ordered)-Number(row.qty_received)-Number(row.qty_cancelled||0)-Number(arrivalReserved.quantity||0);
          if (remaining < quantity) throw badRequest(`進貨數量不可超過採購未交量（已含待驗收到貨 ${arrivalReserved.quantity||0}）`);
          sourceLine = row;
        }
        const supplierCode = trim(body.supplier_code) || sourceLine?.supplier_code || '';
        if (!supplierCode || !itemCode) throw badRequest('供應廠商與品號不可空白');
        const documentNo = trim(body.receipt_no) || await nextConfiguredDocumentNumber(conn, 'procurement_receipts', 'receipt_no', documentType, date);
        const [header] = await conn.query(`INSERT INTO procurement_receipts
          (tenant_id, company_id, source_system, document_type, receipt_no, supplier_code, receipt_date, arrival_date,
           delivery_note_no, invoice_no, received_by, warehouse_code, status, note, source_database)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_inspection', ?, ?)`, [context.tenant_id, context.company_id, context.source_system, trim(body.document_type) || 'GR', documentNo, supplierCode, date,
          nullableDate(body.arrival_date) || date, trim(body.delivery_note_no), trim(body.invoice_no), trim(body.received_by),
          trim(body.warehouse_code) || sourceLine?.warehouse_code || '', trim(body.note), sourceDatabase]);
        const freight=Number(body.freight_amount||0),insurance=Number(body.insurance_amount||0),otherExpense=Number(body.other_expense_amount||0);
        if (![freight,insurance,otherExpense].every(Number.isFinite) || [freight,insurance,otherExpense].some(value=>value<0)) throw badRequest('運費、保險費與其他費用不可為負數');
        await conn.query(`INSERT INTO procurement_receipt_items
          (receipt_id, purchase_order_item_id, line_no, item_code, item_name, specification, warehouse_code, unit, qty_received, qty_accepted, unit_cost, freight_amount, insurance_amount, other_expense_amount, lot_no, note)
          VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`, [header.insertId, sourceLineId, itemCode, trim(body.item_name) || sourceLine?.item_name || '', trim(body.specification) || sourceLine?.specification || '', trim(body.warehouse_code) || sourceLine?.warehouse_code || '', trim(body.unit) || sourceLine?.unit || 'PCS', quantity, Number(body.unit_cost || sourceLine?.unit_price || 0), freight, insurance, otherExpense, trim(body.lot_no), trim(body.item_note)]);
        // 採購已進貨量須等驗收完成後才更新，避免待驗或驗退數量被算入正式進貨。
        return { id: header.insertId, documentNo };
      });
      res.status(201).json({ ok: true, ...result });
    } catch (error) { next(error); }
  });

  app.put('/api/procurement/receipts/:id/pricing', async (req, res, next) => {
    try {
      await ensureTargetReceiptWorkflowSchema();
      await ensureTargetFinanceWorkflowSchema();
      const receiptId = Number(req.params.id);
      const body = req.body || {};
      const sourceDatabase = String(body.source_database || req.query.source_database || 'SH').toUpperCase();
      const rawLines = Array.isArray(body.lines) ? body.lines : [body];
      if (!Number.isInteger(receiptId) || receiptId < 1 || !rawLines.length) throw badRequest('計價進貨與明細不可空白');
      const itemIds = rawLines.map(line => Number(line.receipt_item_id || line.item_id || 0));
      if (itemIds.some(id => !Number.isInteger(id) || id < 1) || new Set(itemIds).size !== itemIds.length) throw badRequest('計價明細識別碼錯誤或重複');
      const result = await tx(async conn => {
        const [[receipt]] = await conn.query(`SELECT id,status,inventory_status,source_database,tenant_id,company_id,source_system
          FROM procurement_receipts WHERE id=? AND source_database=? FOR UPDATE`, [receiptId, sourceDatabase]);
        if (!receipt) throw notFound('進貨單不存在');
        if (receipt.inventory_status !== 'posted' || !['accepted','partially_accepted','posted'].includes(receipt.status)) {
          throw badRequest('進貨必須完成驗收與庫存過帳後才能計價');
        }
        const updated = [];
        for (const raw of rawLines) {
          const itemId = Number(raw.receipt_item_id || raw.item_id);
          const [[item]] = await conn.query(`SELECT * FROM procurement_receipt_items
            WHERE id=? AND receipt_id=? FOR UPDATE`, [itemId, receiptId]);
          if (!item) throw notFound(`找不到進貨明細 ${itemId}`);
          if (!['accepted','partially_accepted'].includes(String(item.inspection_status))) throw badRequest(`進貨明細 ${item.line_no} 尚未完成驗收`);
          const nextQuantity = Number(raw.qty_priced);
          if (!Number.isFinite(nextQuantity) || nextQuantity < 0) throw badRequest(`第 ${item.line_no} 筆計價量必須是非負數`);
          const currentQuantity = nonNegativeNumber(item.qty_priced);
          const returnedPriced = nonNegativeNumber(item.qty_returned_priced);
          const derived = receiptDerivedQuantities(item);
          if (nextQuantity + PROCUREMENT_EPS < currentQuantity) throw badRequest(`第 ${item.line_no} 筆已計價量不可直接減少，請走反計價／更正流程`);
          if (nextQuantity + PROCUREMENT_EPS < returnedPriced) throw badRequest(`第 ${item.line_no} 筆計價量不可小於已計價退回量 ${returnedPriced}`);
          if (nextQuantity > derived.pricingEligibleQuantity + PROCUREMENT_EPS) throw badRequest(`第 ${item.line_no} 筆計價量不可超過可計價量 ${derived.pricingEligibleQuantity}`);
          const freight = raw.freight_amount === undefined ? nonNegativeNumber(item.freight_amount) : Number(raw.freight_amount);
          const insurance = raw.insurance_amount === undefined ? nonNegativeNumber(item.insurance_amount) : Number(raw.insurance_amount);
          const otherExpense = raw.other_expense_amount === undefined ? nonNegativeNumber(item.other_expense_amount) : Number(raw.other_expense_amount);
          if (![freight, insurance, otherExpense].every(Number.isFinite) || [freight, insurance, otherExpense].some(value => value < 0)) throw badRequest(`第 ${item.line_no} 筆運費、保險費與其他費用不可為負數`);
          const summary = await getReceiptFinancialSummary(conn, receiptId, itemId);
          const nextItem = { ...item, qty_priced: nextQuantity, freight_amount: freight, insurance_amount: insurance, other_expense_amount: otherExpense };
          const newPricing = receiptPricingValues(nextItem, nextQuantity);
          if (summary.billedAmount > newPricing.pricedAmount + PROCUREMENT_EPS) throw badRequest(`第 ${item.line_no} 筆計價金額不可低於已立應付 ${summary.billedAmount.toFixed(2)}`);
          if (summary.paidAmount > newPricing.pricedAmount + PROCUREMENT_EPS) throw badRequest(`第 ${item.line_no} 筆計價金額不可低於已付款 ${summary.paidAmount.toFixed(2)}`);
          const reason = trim(raw.reason || body.reason);
          if (!reason) throw badRequest('計價異動必須輸入原因');
          await conn.query(`INSERT INTO procurement_receipt_pricing_events
            (tenant_id,company_id,source_system,source_database,receipt_id,receipt_item_id,event_kind,
             before_qty_priced,after_qty_priced,before_unit_cost,after_unit_cost,before_freight_amount,after_freight_amount,
             before_insurance_amount,after_insurance_amount,before_other_expense_amount,after_other_expense_amount,reason,created_by)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
            receipt.tenant_id || contextFor(sourceDatabase).tenant_id,
            receipt.company_id || contextFor(sourceDatabase).company_id,
            receipt.source_system || contextFor(sourceDatabase).source_system,
            sourceDatabase, receiptId, itemId, currentQuantity ? 'adjust' : 'price',
            currentQuantity, nextQuantity, Number(item.unit_cost || 0), Number(item.unit_cost || 0),
            Number(item.freight_amount || 0), freight, Number(item.insurance_amount || 0), insurance,
            Number(item.other_expense_amount || 0), otherExpense, reason, req.auth.id
          ]);
          await conn.query(`UPDATE procurement_receipt_items
            SET qty_priced=?,freight_amount=?,insurance_amount=?,other_expense_amount=?,priced_at=NOW(),priced_by=?
            WHERE id=?`, [nextQuantity, freight, insurance, otherExpense, req.auth.id, itemId]);
          const after = receiptDerivedQuantities(nextItem);
          updated.push({
            receipt_item_id: itemId, qty_received: Number(item.qty_received || 0), qty_accepted: Number(item.qty_accepted || 0),
            qty_rejected: Number(item.qty_rejected || 0), qty_returned: Number(item.qty_returned || 0),
            qty_priced: nextQuantity, qty_returned_priced: returnedPriced,
            active_priced_quantity: after.activePricedQuantity, unpriced_quantity: after.unpricedQuantity,
            priced_amount: newPricing.pricedAmount, billed_amount: summary.billedAmount, paid_amount: summary.paidAmount,
            unpaid_amount: Math.max(newPricing.pricedAmount - summary.paidAmount, 0)
          });
        }
        return { receipt_id: receiptId, source_database: sourceDatabase, lines: updated };
      });
      res.json({ ok: true, data: result });
    } catch (error) { next(error); }
  });

  app.get('/api/procurement/documents/:kind', async (req, res, next) => {
    try {
      await ensureProcurementSchema();
      await ensureTargetReceiptWorkflowSchema();
      const sourceDatabase = String(req.query.source_database || 'SH').toUpperCase();
      const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
      let sql = '';
      if (req.params.kind === 'requisitions') sql = `SELECT r.id, r.requisition_no AS document_no, DATE_FORMAT(r.requisition_date,'%Y-%m-%d') AS document_date, r.requester_code, r.department_code, r.warehouse_code, r.status, r.note, i.item_code, i.item_name, i.specification, i.unit, i.qty_requested AS quantity, i.qty_ordered AS related_quantity, DATE_FORMAT(i.required_date,'%Y-%m-%d') AS required_date, i.note AS item_note FROM procurement_requisitions r JOIN procurement_requisition_items i ON i.requisition_id=r.id WHERE r.source_database=? ORDER BY r.requisition_date DESC, r.id DESC LIMIT ?`;
      else if (req.params.kind === 'orders') sql = `SELECT o.id, o.purchase_order_no AS document_no, DATE_FORMAT(o.order_date,'%Y-%m-%d') AS document_date, o.supplier_code, o.currency_code, o.status, o.closed_by, DATE_FORMAT(o.closed_at,'%Y-%m-%d %H:%i') closed_at, o.close_note, o.note, i.requisition_item_id AS source_line_id, i.item_code, i.item_name, i.specification, i.warehouse_code, i.unit, i.qty_ordered AS quantity, i.qty_received AS related_quantity, i.qty_cancelled, GREATEST(i.qty_ordered-i.qty_received-i.qty_cancelled,0) remaining_quantity, CASE WHEN i.qty_ordered<=i.qty_received+i.qty_cancelled THEN 1 ELSE 0 END is_fulfilled, CASE WHEN o.status='closed' THEN 1 ELSE 0 END is_closed, i.unit_price, DATE_FORMAT(i.expected_date,'%Y-%m-%d') AS expected_date, i.note AS item_note FROM procurement_orders o JOIN procurement_order_items i ON i.purchase_order_id=o.id WHERE o.source_database=? ORDER BY o.order_date DESC, o.id DESC LIMIT ?`;
      else if (req.params.kind === 'receipts') sql = `SELECT r.id, r.document_type, r.receipt_no AS document_no, DATE_FORMAT(r.receipt_date,'%Y-%m-%d') AS document_date,
        DATE_FORMAT(r.arrival_date,'%Y-%m-%d') AS arrival_date,r.delivery_note_no,r.invoice_no,r.received_by,
        r.supplier_code, r.warehouse_code, r.status,r.inventory_status,DATE_FORMAT(r.inventory_posted_at,'%Y-%m-%d %H:%i') inventory_posted_at,r.note,
         i.id AS receipt_item_id,i.purchase_order_item_id AS source_line_id,o.purchase_order_no,i.item_code,i.item_name,i.specification,i.warehouse_code item_warehouse_code,i.unit,
        i.qty_received AS quantity,i.qty_accepted,i.qty_rejected,i.qty_rejected_returned,i.qty_returned,
        i.qty_priced,i.qty_paid,i.qty_returned_priced,
        GREATEST(i.qty_accepted-i.qty_returned,0) returnable_quantity,
        GREATEST(i.qty_accepted-i.qty_returned+COALESCE(i.qty_returned_priced,0),0) pricing_eligible_quantity,
        GREATEST(COALESCE(i.qty_priced,0)-COALESCE(i.qty_returned_priced,0),0) active_priced_quantity,
        GREATEST(i.qty_accepted-i.qty_returned-(COALESCE(i.qty_priced,0)-COALESCE(i.qty_returned_priced,0)),0) unpriced_quantity,
        i.freight_amount,i.insurance_amount,i.other_expense_amount,
        (COALESCE(i.qty_priced,0)*i.unit_cost+(i.freight_amount+i.insurance_amount+i.other_expense_amount)*COALESCE(i.qty_priced,0)/NULLIF(i.qty_accepted,0)) priced_amount,
        (GREATEST(COALESCE(i.qty_priced,0)-COALESCE(i.qty_returned_priced,0),0)*i.unit_cost+(i.freight_amount+i.insurance_amount+i.other_expense_amount)*GREATEST(COALESCE(i.qty_priced,0)-COALESCE(i.qty_returned_priced,0),0)/NULLIF(i.qty_accepted,0)) active_priced_amount,
        (GREATEST(i.qty_accepted-i.qty_returned-(COALESCE(i.qty_priced,0)-COALESCE(i.qty_returned_priced,0)),0)*i.unit_cost+(i.freight_amount+i.insurance_amount+i.other_expense_amount)*GREATEST(i.qty_accepted-i.qty_returned-(COALESCE(i.qty_priced,0)-COALESCE(i.qty_returned_priced,0)),0)/NULLIF(i.qty_accepted,0)) unpriced_amount,
        (COALESCE(i.qty_priced,0)*i.unit_cost+(i.freight_amount+i.insurance_amount+i.other_expense_amount)*COALESCE(i.qty_priced,0)/NULLIF(i.qty_accepted,0)) billable_amount,
        COALESCE((SELECT SUM(vs.quantity*ABS(vs.allocated_amount/NULLIF(vs.source_amount,0))) FROM finance_voucher_sources vs JOIN finance_vouchers fv ON fv.id=vs.voucher_id WHERE fv.status<>'voided' AND vs.source_kind='purchase_receipt' AND vs.source_document_id=r.id AND vs.source_document_item_id=i.id),0) billed_quantity,
        COALESCE((SELECT SUM(vs.allocated_amount) FROM finance_voucher_sources vs JOIN finance_vouchers fv ON fv.id=vs.voucher_id WHERE fv.status<>'voided' AND vs.source_kind='purchase_receipt' AND vs.source_document_id=r.id AND vs.source_document_item_id=i.id),0) billed_amount,
        COALESCE((SELECT SUM(vs.quantity*ABS(vs.allocated_amount/NULLIF(vs.source_amount,0))*LEAST(1,ABS(fo.settled_amount/NULLIF(fo.original_amount,0)))) FROM finance_voucher_sources vs JOIN finance_vouchers fv ON fv.id=vs.voucher_id JOIN finance_open_items fo ON fo.source_kind='finance_voucher' AND fo.source_document_id=fv.id WHERE fv.status='approved' AND vs.source_kind='purchase_receipt' AND vs.source_document_id=r.id AND vs.source_document_item_id=i.id),0) paid_quantity,
        COALESCE((SELECT SUM(vs.allocated_amount*LEAST(1,ABS(fo.settled_amount/NULLIF(fo.original_amount,0)))) FROM finance_voucher_sources vs JOIN finance_vouchers fv ON fv.id=vs.voucher_id JOIN finance_open_items fo ON fo.source_kind='finance_voucher' AND fo.source_document_id=fv.id WHERE fv.status='approved' AND vs.source_kind='purchase_receipt' AND vs.source_document_id=r.id AND vs.source_document_item_id=i.id),0) paid_amount,
        CASE WHEN COALESCE(i.qty_priced,0)<=0 THEN 'unpriced' WHEN COALESCE(i.qty_priced,0)<GREATEST(i.qty_accepted-i.qty_returned+COALESCE(i.qty_returned_priced,0),0) THEN 'partial' ELSE 'priced' END pricing_status,
        i.inspection_status,i.inspection_note,DATE_FORMAT(i.inspected_at,'%Y-%m-%d %H:%i') inspected_at,i.unit_cost,i.lot_no,i.note AS item_note
        FROM procurement_receipts r JOIN procurement_receipt_items i ON i.receipt_id=r.id
        LEFT JOIN procurement_order_items oi ON oi.id=i.purchase_order_item_id LEFT JOIN procurement_orders o ON o.id=oi.purchase_order_id
        WHERE r.source_database=? ORDER BY r.receipt_date DESC,r.id DESC LIMIT ?`;
      else throw badRequest(`未知的採購單據類型：${req.params.kind}`);
      const [rows] = await pool.query(sql, [sourceDatabase, limit]);
      res.json({ ok: true, data: rows });
    } catch (error) { next(error); }
  });

  app.post('/api/procurement/documents/:kind/:id/approve', async (req, res, next) => {
    try {
      await ensureProcurementSchema();
      const kind = req.params.kind; const id = Number(req.params.id);
      const sourceDatabase = String(req.body?.source_database || req.query.source_database || 'SH').toUpperCase();
      const table = { requisitions:'procurement_requisitions', orders:'procurement_orders', receipts:'procurement_receipts' }[kind];
      if (!table || !Number.isInteger(id) || id < 1) throw badRequest('Invalid document for approval');
      const [[document]] = await pool.query(`SELECT id FROM ${table} WHERE id=? AND source_database=?`, [id, sourceDatabase]);
      if (!document) throw notFound('Document not found');
      await pool.query(`INSERT INTO procurement_document_approvals
        (document_kind, document_id, approval_status, approved_by, note)
        VALUES (?, ?, 'approved', ?, ?)
        ON DUPLICATE KEY UPDATE approval_status='approved', approved_by=VALUES(approved_by), approved_at=NOW(), note=VALUES(note)`, [kind, id, req.auth.id, trim(req.body?.note)]);
      if (kind === 'requisitions') await pool.query("UPDATE procurement_requisitions SET status='approved' WHERE id=? AND source_database=?", [id, sourceDatabase]);
      if (kind === 'orders') await tx(async conn => {
        const [[order]] = await conn.query(`SELECT o.*, t.requires_approval,t.auto_confirm
          FROM procurement_orders o JOIN procurement_document_types t
            ON t.tenant_id=o.tenant_id AND t.company_id=o.company_id AND t.source_system=o.source_system
           AND t.document_kind='purchase_order' AND t.type_code=o.document_type
          WHERE o.id=? AND o.source_database=? FOR UPDATE`, [id, sourceDatabase]);
        if (!order) throw notFound('採購單不存在');
        if (order.status !== 'draft') throw badRequest('只有草稿採購單可以核準');
        const [items] = await conn.query('SELECT * FROM procurement_order_items WHERE purchase_order_id=? FOR UPDATE', [id]);
        for (const item of items.filter(item => item.requisition_item_id)) {
          const [[source]] = await conn.query(`SELECT i.*,r.id header_id FROM procurement_requisition_items i
            JOIN procurement_requisitions r ON r.id=i.requisition_id WHERE i.id=? FOR UPDATE`, [item.requisition_item_id]);
          if (!source || Number(source.qty_requested) - Number(source.qty_ordered) < Number(item.qty_ordered)) throw badRequest('請購未轉量不足，無法核準採購單');
          await conn.query('UPDATE procurement_requisition_items SET qty_ordered=qty_ordered+? WHERE id=?', [item.qty_ordered, item.requisition_item_id]);
          const [[remaining]] = await conn.query('SELECT COUNT(*) count FROM procurement_requisition_items WHERE requisition_id=? AND qty_requested>qty_ordered', [source.header_id]);
          await conn.query('UPDATE procurement_requisitions SET status=? WHERE id=?', [Number(remaining.count)?'approved':'converted',source.header_id]);
        }
        await conn.query("UPDATE procurement_orders SET status='confirmed' WHERE id=?", [id]);
      });
      res.json({ ok:true, data:{ id, kind, source_database:sourceDatabase, approval_status:'approved' } });
    } catch (error) { next(error); }
  });

  app.post('/api/procurement/documents/orders/:id/close', async (req, res, next) => {
    try {
      await ensureProcurementSchema();
      await ensureTargetReceiptWorkflowSchema();
      const id = Number(req.params.id);
      const sourceDatabase = String(req.body?.source_database || 'SH').toUpperCase();
      if (!Number.isInteger(id) || id < 1) throw badRequest('採購單識別碼錯誤');
      await tx(async (conn) => {
        const [[order]] = await conn.query('SELECT id,status FROM procurement_orders WHERE id=? AND source_database=? FOR UPDATE', [id, sourceDatabase]);
        if (!order) throw notFound('採購單不存在');
        if (order.status === 'closed') throw badRequest('採購單已結案');
        if (order.status === 'cancelled') throw badRequest('作廢採購單不可結案');
        const [[open]] = await conn.query('SELECT COUNT(*) count FROM procurement_order_items WHERE purchase_order_id=? AND qty_ordered>qty_received+qty_cancelled', [id]);
        if (Number(open.count)) throw badRequest('採購數量尚未全數到貨，不能結案');
        await conn.query("UPDATE procurement_orders SET status='closed',closed_by=?,closed_at=NOW(),close_note=? WHERE id=?", [req.auth.id, trim(req.body?.close_note), id]);
      });
      res.json({ok:true,data:{id,status:'closed'}});
    } catch (error) { next(error); }
  });

  app.put('/api/procurement/documents/:kind/:id', async (req, res, next) => {
    try {
      await ensureProcurementSchema();
      await ensureTargetFinanceWorkflowSchema();
      const kind = req.params.kind;
      const id = Number(req.params.id);
      const body = req.body || {};
      const sourceDatabase = String(body.source_database || 'SH').toUpperCase();
      if (!Number.isInteger(id) || id < 1) throw badRequest('單據識別碼錯誤');
      await tx(async (conn) => {
        const [[approval]] = await conn.query('SELECT approval_status FROM procurement_document_approvals WHERE document_kind=? AND document_id=?', [kind, id]);
        if (approval?.approval_status === 'approved') throw badRequest('已核准單據不可直接修改；請走取消核准或變更流程');
        if (kind === 'requisitions') {
          const [[row]] = await conn.query('SELECT i.id AS item_id, i.qty_ordered FROM procurement_requisitions r JOIN procurement_requisition_items i ON i.requisition_id=r.id WHERE r.id=? AND r.source_database=? FOR UPDATE', [id, sourceDatabase]);
          if (!row) throw notFound('請購單不存在');
          const quantity = positiveNumber(body.qty_requested, '請購數量');
          if (quantity < Number(row.qty_ordered)) throw badRequest('請購數量不可小於已轉採購量');
          await conn.query('UPDATE procurement_requisitions SET requisition_date=?, requester_code=?, department_code=?, warehouse_code=?, note=? WHERE id=?', [validDate(body.requisition_date), trim(body.requester_code), trim(body.department_code), trim(body.warehouse_code), trim(body.note), id]);
          await conn.query('UPDATE procurement_requisition_items SET item_code=?, item_name=?, specification=?, warehouse_code=?, unit=?, qty_requested=?, required_date=?, note=? WHERE id=?', [trim(body.item_code), trim(body.item_name), trim(body.specification), trim(body.warehouse_code), trim(body.unit) || 'PCS', quantity, nullableDate(body.required_date), trim(body.item_note), row.item_id]);
        } else if (kind === 'orders') {
          const [[row]] = await conn.query('SELECT o.status, i.id AS item_id, i.requisition_item_id, i.qty_ordered, i.qty_received FROM procurement_orders o JOIN procurement_order_items i ON i.purchase_order_id=o.id WHERE o.id=? AND o.source_database=? FOR UPDATE', [id, sourceDatabase]);
          if (!row) throw notFound('採購單不存在');
          if (row.status === 'closed') throw badRequest('已結案採購單不可直接修改；請建立變更或沖回／重作紀錄');
          const quantity = positiveNumber(body.qty_ordered, '採購數量');
          if (quantity < Number(row.qty_received)) throw badRequest('採購數量不可小於已進貨量');
          if (row.requisition_item_id && quantity !== Number(row.qty_ordered)) throw badRequest('已參考請購單的採購數量不可直接修改，請另開採購單或修改請購來源');
          await conn.query('UPDATE procurement_orders SET supplier_code=?, order_date=?, expected_date=?, currency_code=?, note=? WHERE id=?', [trim(body.supplier_code), validDate(body.order_date), nullableDate(body.expected_date), trim(body.currency_code) || 'TWD', trim(body.note), id]);
          await conn.query('UPDATE procurement_order_items SET item_code=?, item_name=?, specification=?, warehouse_code=?, unit=?, qty_ordered=?, unit_price=?, expected_date=?, note=? WHERE id=?', [trim(body.item_code), trim(body.item_name), trim(body.specification), trim(body.warehouse_code), trim(body.unit) || 'PCS', quantity, Number(body.unit_price || 0), nullableDate(body.expected_date), trim(body.item_note), row.item_id]);
        } else if (kind === 'receipts') {
          const [[row]] = await conn.query('SELECT r.status receipt_status, r.inventory_status, i.id AS item_id, i.purchase_order_item_id, i.qty_received FROM procurement_receipts r JOIN procurement_receipt_items i ON i.receipt_id=r.id WHERE r.id=? AND r.source_database=? FOR UPDATE', [id, sourceDatabase]);
          if (!row) throw notFound('進貨單不存在');
          if (row.inventory_status === 'posted' || row.receipt_status === 'posted') throw badRequest('已過帳進貨不可直接修改；請建立反過帳／更正紀錄');
          const [[locked]] = await conn.query(`SELECT v.voucher_no
            FROM finance_voucher_sources vs JOIN finance_vouchers v ON v.id=vs.voucher_id
            WHERE v.status<>'voided' AND v.account_type='AP' AND vs.source_kind='purchase_receipt'
              AND vs.source_document_id=? LIMIT 1`, [id]);
          if (locked) throw badRequest(`進貨單已帶入應付憑單 ${locked.voucher_no}，不可直接修改；請作廢應付憑單或建立退貨／折讓`);
          const quantity = positiveNumber(body.qty_received, '進貨數量');
          const accepted = Number(body.qty_accepted ?? quantity);
          if (accepted < 0 || accepted > quantity) throw badRequest('驗收數量必須介於 0 與進貨數量之間');
          if (row.purchase_order_item_id && quantity !== Number(row.qty_received)) throw badRequest('已參考採購單的進貨數量不可直接修改，請以新的進貨單調整');
          await conn.query('UPDATE procurement_receipts SET supplier_code=?, receipt_date=?, warehouse_code=?, note=? WHERE id=?', [trim(body.supplier_code), validDate(body.receipt_date), trim(body.warehouse_code), trim(body.note), id]);
          await conn.query('UPDATE procurement_receipt_items SET item_code=?, item_name=?, specification=?, warehouse_code=?, unit=?, qty_received=?, qty_accepted=?, unit_cost=?, lot_no=?, note=? WHERE id=?', [trim(body.item_code), trim(body.item_name), trim(body.specification), trim(body.warehouse_code), trim(body.unit) || 'PCS', quantity, accepted, Number(body.unit_cost || 0), trim(body.lot_no), trim(body.item_note), row.item_id]);
        } else throw badRequest('未知的採購單據類型');
      });
      res.json({ ok: true, id });
    } catch (error) { next(error); }
  });

  app.get('/api/procurement/document-types', async (req, res, next) => {
    try {
      await ensureProcurementSchema();
      await ensureTargetProcurementTypeSchema();
      const sourceDatabase = String(req.query.source_database || 'SH').toUpperCase();
      const context = contextFor(sourceDatabase);
      // 預設單別也必須標記目前公司來源；不能讓沒有來源標記的共用預設混入其他公司。
      await pool.query("UPDATE procurement_document_types SET source_database=? WHERE tenant_id=? AND company_id=? AND source_system=? AND (source_database IS NULL OR source_database='')", [sourceDatabase, context.tenant_id, context.company_id, context.source_system]);
      const defaultTypes = [
        ['requisition','RQ','一般請購','RQ'],['purchase_order','PO','一般採購','PO'],
        ['receipt','GR','一般進貨','GR'],['purchase_return','PR','採購退貨／折讓','PR']
      ];
      const sourcePool = getSourcePool(sourceDatabase);
      // iSM PURI04 的權威來源是 CMSMQ；先同步全部 31/33/34/35 單別，
      // 即使舊資料尚未出現過交易，也能在新 ERP 建立作業中選取。
      try {
        const [legacyMasterTypes] = await sourcePool.query(`SELECT MQ001 type_code,MQ002 type_name,MQ034 type_full_name,
          MQ003 nature_code,MQ004 numbering_method,MQ005 year_digits,MQ006 serial_digits,MQ024 item_input_method,
          MQ015 auto_confirm,MQ061 auto_confirm_on_edit,MQ018 update_supplier_price,MQ019 require_purchase_order,
          MQ020 settlement_mode,MQ021 ap_document_type,MQ060 is_default,MQ022 note
          FROM cmsmq WHERE COMPANY=? AND MQ003 IN ('31','33','34','35') ORDER BY MQ003,MQ001`, [sourceDatabase]);
        const kindByNature = { '31':'requisition', '33':'purchase_order', '34':'receipt', '35':'purchase_return' };
        const yes = value => ['Y','y','1','true'].includes(String(value ?? '').trim());
        const methodMap = { '1':'daily', '2':'monthly', '3':'sequence', '4':'manual' };
        const settlementMap = { 'Y':'whole', 'y':'per_document', 'N':'batch' };
        for (const type of legacyMasterTypes) {
          const kind = kindByNature[String(type.nature_code).trim()];
          if (!kind) continue;
          await pool.query(`INSERT INTO procurement_document_types
            (tenant_id,company_id,source_system,document_kind,type_code,type_name,type_full_name,nature_code,number_prefix,
             numbering_method,year_digits,serial_digits,item_input_method,requires_approval,auto_confirm,auto_confirm_on_edit,
             update_supplier_price,require_purchase_order,settlement_mode,ap_document_type,is_default,is_active,note,source_database,source_table)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)
            ON DUPLICATE KEY UPDATE type_name=VALUES(type_name),type_full_name=VALUES(type_full_name),nature_code=VALUES(nature_code),
              numbering_method=VALUES(numbering_method),year_digits=VALUES(year_digits),serial_digits=VALUES(serial_digits),
              item_input_method=VALUES(item_input_method),requires_approval=VALUES(requires_approval),auto_confirm=VALUES(auto_confirm),
              auto_confirm_on_edit=VALUES(auto_confirm_on_edit),update_supplier_price=VALUES(update_supplier_price),
              require_purchase_order=VALUES(require_purchase_order),settlement_mode=VALUES(settlement_mode),
              ap_document_type=VALUES(ap_document_type),is_default=VALUES(is_default),note=VALUES(note),
              source_database=VALUES(source_database),source_table=VALUES(source_table)`, [
            context.tenant_id,context.company_id,context.source_system,kind,String(type.type_code).trim(),String(type.type_name||type.type_code).trim(),
            String(type.type_full_name||'').trim()||null,String(type.nature_code).trim(),String(type.type_code).trim(),
            methodMap[String(type.numbering_method).trim()]||'daily',Number(type.year_digits)||4,Number(type.serial_digits)||4,
            String(type.item_input_method).trim()==='2'?'barcode':'item',Number(!yes(type.auto_confirm)),yes(type.auto_confirm),
            yes(type.auto_confirm_on_edit),yes(type.update_supplier_price),yes(type.require_purchase_order),
            settlementMap[String(type.settlement_mode).trim()]||'batch',String(type.ap_document_type||'').trim()||null,
            yes(type.is_default),String(type.note||'').trim()||'由客戶舊 ERP CMSMQ 匯入',sourceDatabase,'cmsmq'
          ]);
        }
      } catch (_) { /* 非 iSM 客戶可能沒有 CMSMQ，保留標準預設單別。 */ }
      const legacyTypeSources = [
        ['requisition','purta','TA001'],['purchase_order','purtc','TC001'],
        ['receipt','purtg','TG001'],['purchase_return','purti','TI001']
      ];
      for (const [kind, table, column] of legacyTypeSources) {
        try {
          const [legacyTypes] = await sourcePool.query(`SELECT DISTINCT t.${column} type_code, COALESCE(NULLIF(q.MQ002,''),t.${column}) type_name FROM ${table} t LEFT JOIN cmsmq q ON q.COMPANY=t.COMPANY AND q.MQ001=t.${column} WHERE t.COMPANY=? AND t.${column}<>''`,[sourceDatabase]);
          for (const type of legacyTypes) await pool.query(`INSERT IGNORE INTO procurement_document_types
            (tenant_id,company_id,source_system,document_kind,type_code,type_name,number_prefix,requires_approval,allow_overage,is_active,note)
            VALUES(?,?,?,?,?,?,?,1,0,1,'由客戶舊 ERP 單據性質匯入')`,[context.tenant_id,context.company_id,context.source_system,kind,type.type_code,type.type_name,type.type_code]);
        } catch (_) { /* Optional PUR tables may be absent in another customer database. */ }
      }
      for (const row of defaultTypes) {
        const [[exists]] = await pool.query('SELECT COUNT(*) count FROM procurement_document_types WHERE tenant_id=? AND company_id=? AND source_system=? AND document_kind=?',[context.tenant_id,context.company_id,context.source_system,row[0]]);
        if (!Number(exists.count)) await pool.query(`INSERT INTO procurement_document_types
          (tenant_id,company_id,source_system,document_kind,type_code,type_name,type_full_name,nature_code,number_prefix,numbering_method,year_digits,serial_digits,requires_approval,allow_overage,is_active,source_database,source_table)
          VALUES(?,?,?,?,?,?,?,?,?,'daily',4,4,1,0,1,?,'inventory_erp')`,[context.tenant_id,context.company_id,context.source_system,...row.slice(0,3),row[2],({requisition:'31',purchase_order:'33',receipt:'34',purchase_return:'35'})[row[0]],row[3],sourceDatabase]);
      }
      const [rows] = await pool.query(`SELECT id, document_kind, type_code, type_name, type_full_name, nature_code, number_prefix,
        numbering_method,year_digits,serial_digits,item_input_method,requires_approval,auto_confirm,auto_confirm_on_edit,
        update_supplier_price,require_purchase_order,settlement_mode,ap_document_type,is_default,
        allow_overage, is_active, note,source_database,source_table FROM procurement_document_types
        WHERE tenant_id=? AND company_id=? AND source_system=? ORDER BY document_kind, type_code`, [context.tenant_id, context.company_id, context.source_system]);
      res.json({ ok:true, data:rows });
    } catch (error) { next(error); }
  });

  app.post('/api/procurement/document-types', async (req, res, next) => {
    try {
      await ensureProcurementSchema();
      await ensureTargetProcurementTypeSchema();
      const body = req.body || {}; const sourceDatabase = String(body.source_database || 'SH').toUpperCase();
      const context = contextFor(sourceDatabase); const kind = trim(body.document_kind); const code = trim(body.type_code);
      if (!['requisition','purchase_order','receipt','purchase_return'].includes(kind) || !code || !trim(body.type_name)) throw badRequest('請輸入正確的單據類別、單別與名稱');
      const method = trim(body.numbering_method) || 'daily';
      if (!['daily','monthly','sequence','manual'].includes(method)) throw badRequest('編碼方式不正確');
      if (Number(body.is_default)) await pool.query('UPDATE procurement_document_types SET is_default=0 WHERE tenant_id=? AND company_id=? AND source_system=? AND document_kind=?',[context.tenant_id,context.company_id,context.source_system,kind]);
      await pool.query(`INSERT INTO procurement_document_types
        (tenant_id,company_id,source_system,document_kind,type_code,type_name,type_full_name,nature_code,number_prefix,
         numbering_method,year_digits,serial_digits,item_input_method,requires_approval,auto_confirm,auto_confirm_on_edit,
         update_supplier_price,require_purchase_order,settlement_mode,ap_document_type,is_default,allow_overage,is_active,note,source_database,source_table)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [context.tenant_id,context.company_id,context.source_system,kind,code,
        trim(body.type_name),trim(body.type_full_name)||trim(body.type_name),({requisition:'31',purchase_order:'33',receipt:'34',purchase_return:'35'})[kind],
        trim(body.number_prefix)||code,method,Number(body.year_digits)||4,Number(body.serial_digits)||4,trim(body.item_input_method)||'item',
        Number(body.requires_approval??1),Number(body.auto_confirm||0),Number(body.auto_confirm_on_edit||0),Number(body.update_supplier_price||0),
        Number(body.require_purchase_order||0),trim(body.settlement_mode)||'batch',trim(body.ap_document_type)||null,Number(body.is_default||0),
        Number(body.allow_overage||0),Number(body.is_active??1),trim(body.note),sourceDatabase,'inventory_erp']);
      res.status(201).json({ ok:true, data:{ type_code:code } });
    } catch (error) { if (error.code === 'ER_DUP_ENTRY') error = badRequest('此單據性質已存在'); next(error); }
  });

  app.put('/api/procurement/document-types/:id', async (req, res, next) => {
    try {
      await ensureTargetProcurementTypeSchema();
      const id = Number(req.params.id); const body = req.body || {};
      const [[current]] = await pool.query('SELECT * FROM procurement_document_types WHERE id=?',[id]);
      if (!current) throw notFound('單據性質不存在');
      if (Number(body.is_default)) await pool.query('UPDATE procurement_document_types SET is_default=0 WHERE tenant_id=? AND company_id=? AND source_system=? AND document_kind=? AND id<>?',[current.tenant_id,current.company_id,current.source_system,current.document_kind,id]);
      const [result] = await pool.query(`UPDATE procurement_document_types SET type_name=?,type_full_name=?,number_prefix=?,numbering_method=?,year_digits=?,serial_digits=?,item_input_method=?,requires_approval=?,auto_confirm=?,auto_confirm_on_edit=?,update_supplier_price=?,require_purchase_order=?,settlement_mode=?,ap_document_type=?,is_default=?,allow_overage=?,is_active=?,note=? WHERE id=?`,
        [trim(body.type_name),trim(body.type_full_name)||trim(body.type_name),trim(body.number_prefix),trim(body.numbering_method)||'daily',Number(body.year_digits)||4,Number(body.serial_digits)||4,trim(body.item_input_method)||'item',Number(body.requires_approval??1),Number(body.auto_confirm||0),Number(body.auto_confirm_on_edit||0),Number(body.update_supplier_price||0),Number(body.require_purchase_order||0),trim(body.settlement_mode)||'batch',trim(body.ap_document_type)||null,Number(body.is_default||0),Number(body.allow_overage||0),Number(body.is_active??1),trim(body.note),id]);
      if (!result.affectedRows) throw notFound('單據性質不存在');
      res.json({ ok:true, data:{ id } });
    } catch (error) { next(error); }
  });

  app.get('/api/procurement/requisition-maintenance', async (req, res, next) => {
    try {
      const sourceDatabase = String(req.query.source_database || 'SH').toUpperCase();
      const [rows] = await pool.query(`SELECT i.id, r.id AS requisition_id, r.requisition_no, r.requisition_date,
        r.status, r.requester_code, r.department_code, i.line_no, i.item_code, i.item_name, i.specification,
        i.warehouse_code, i.unit, i.qty_requested, i.qty_ordered, i.qty_requested-i.qty_ordered AS remaining_quantity,
        i.required_date, i.suggested_supplier_code, i.suggested_unit_price, i.purchase_locked, i.note
        FROM procurement_requisition_items i JOIN procurement_requisitions r ON r.id=i.requisition_id
        WHERE r.source_database=? AND r.status IN ('approved','converted') AND i.qty_requested>i.qty_ordered
        ORDER BY r.requisition_date DESC, r.requisition_no, i.line_no`, [sourceDatabase]);
      res.json({ ok:true, data:rows });
    } catch (error) { next(error); }
  });

  app.put('/api/procurement/requisition-lines/:id/maintenance', async (req, res, next) => {
    try {
      const id = Number(req.params.id); const body = req.body || {};
      const [result] = await pool.query(`UPDATE procurement_requisition_items i
        JOIN procurement_requisitions r ON r.id=i.requisition_id
        SET i.suggested_supplier_code=?, i.suggested_unit_price=?, i.required_date=?, i.purchase_locked=?, i.note=?
        WHERE i.id=? AND r.status='approved' AND i.qty_requested>i.qty_ordered`,
        [trim(body.suggested_supplier_code), Number(body.suggested_unit_price || 0), nullableDate(body.required_date), Number(body.purchase_locked || 0), trim(body.note), id]);
      if (!result.affectedRows) throw badRequest('只有已核準且尚未全數轉採購的請購資料可以維護');
      res.json({ ok:true, data:{ id } });
    } catch (error) { next(error); }
  });

  app.post('/api/procurement/requisition-lines/:id/convert', async (req, res, next) => {
    try {
      const lineId = Number(req.params.id); const body = req.body || {}; const sourceDatabase = String(body.source_database || 'SH').toUpperCase();
      const result = await tx(async conn => {
        const [[row]] = await conn.query(`SELECT i.*, r.status AS header_status, r.id AS header_id
          FROM procurement_requisition_items i JOIN procurement_requisitions r ON r.id=i.requisition_id
          WHERE i.id=? AND r.source_database=? FOR UPDATE`, [lineId, sourceDatabase]);
        if (!row || row.header_status !== 'approved') throw badRequest('請購單必須先核準才能轉採購');
        if (!Number(row.purchase_locked)) throw badRequest('請先完成請購資料維護並鎖定採購資料');
        const quantity = Number(body.qty_ordered || (Number(row.qty_requested)-Number(row.qty_ordered)));
        if (quantity <= 0 || quantity > Number(row.qty_requested)-Number(row.qty_ordered)) throw badRequest('轉採購數量超過請購未轉量');
        const supplierCode = trim(body.supplier_code) || trim(row.suggested_supplier_code);
        if (!supplierCode) throw badRequest('請先指定供應廠商');
        const date = validDate(body.order_date); const context = contextFor(sourceDatabase);
        const typeCode=trim(body.document_type);
        if (!typeCode) throw badRequest('請選擇本公司要使用的採購單別');
        const [[documentType]] = await conn.query(`SELECT * FROM procurement_document_types WHERE tenant_id=? AND company_id=? AND source_system=? AND document_kind='purchase_order' AND type_code=? AND is_active=1`,[context.tenant_id,context.company_id,context.source_system,typeCode]);
        if (!documentType) throw badRequest('找不到目前公司啟用中的採購單別');
        assertConfiguredSource(documentType, 'requisition', true, '採購單');
        const documentNo = trim(body.purchase_order_no) || await nextConfiguredDocumentNumber(conn, 'procurement_orders', 'purchase_order_no', documentType, date);
        const [header] = await conn.query(`INSERT INTO procurement_orders
          (tenant_id,company_id,source_system,document_type,purchase_order_no,supplier_code,order_date,expected_date,currency_code,status,note,source_database)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [context.tenant_id,context.company_id,context.source_system,documentType.type_code,documentNo,supplierCode,date,nullableDate(body.expected_date)||row.required_date,trim(body.currency_code)||'TWD',documentTypeNeedsApproval(documentType)?'draft':'confirmed',trim(body.note),sourceDatabase]);
        await conn.query(`INSERT INTO procurement_order_items
          (purchase_order_id,requisition_item_id,line_no,item_code,item_name,specification,warehouse_code,unit,qty_ordered,unit_price,expected_date,note)
          VALUES (?,?,1,?,?,?,?,?,?,?,?,?)`, [header.insertId,lineId,row.item_code,row.item_name,row.specification,row.warehouse_code,row.unit,quantity,Number(body.unit_price ?? row.suggested_unit_price ?? 0),nullableDate(body.expected_date)||row.required_date,trim(body.item_note)||row.note]);
        if(!documentTypeNeedsApproval(documentType)){
          await conn.query('UPDATE procurement_requisition_items SET qty_ordered=qty_ordered+? WHERE id=?',[quantity,lineId]);
          const [[remaining]] = await conn.query('SELECT COUNT(*) count FROM procurement_requisition_items WHERE requisition_id=? AND qty_requested>qty_ordered',[row.header_id]);
          await conn.query('UPDATE procurement_requisitions SET status=? WHERE id=?',[Number(remaining.count)?'approved':'converted',row.header_id]);
        }
        return { id:header.insertId, document_no:documentNo };
      });
      res.status(201).json({ ok:true, data:result });
    } catch (error) { next(error); }
  });

  app.get('/api/procurement/order-changes', async (req, res, next) => {
    try {
      const sourceDatabase=String(req.query.source_database||'SH').toUpperCase();
      const [rows]=await pool.query(`SELECT c.id,c.change_no,c.change_date,c.reason,c.status,o.purchase_order_no,
        i.item_code,i.item_name,ci.new_quantity,ci.new_unit_price,ci.new_expected_date
        FROM procurement_order_changes c JOIN procurement_orders o ON o.id=c.purchase_order_id
        JOIN procurement_order_change_items ci ON ci.order_change_id=c.id JOIN procurement_order_items i ON i.id=ci.purchase_order_item_id
        WHERE c.source_database=? ORDER BY c.change_date DESC,c.id DESC`,[sourceDatabase]);
      res.json({ok:true,data:rows});
    } catch(error){next(error);}
  });

  app.post('/api/procurement/order-changes', async (req,res,next)=>{
    try{
      const body=req.body||{}; const orderItemId=Number(body.purchase_order_item_id); const sourceDatabase=String(body.source_database||'SH').toUpperCase();
      const result=await tx(async conn=>{
        const [[row]]=await conn.query(`SELECT i.*,o.id header_id,o.status FROM procurement_order_items i JOIN procurement_orders o ON o.id=i.purchase_order_id WHERE i.id=? AND o.source_database=? FOR UPDATE`,[orderItemId,sourceDatabase]);
        if(!row || !['confirmed','partial_received'].includes(row.status)) throw badRequest('只有已核準且未結案的採購單可以建立變更');
        const quantity=positiveNumber(body.new_quantity,'變更後數量'); if(quantity<Number(row.qty_received)) throw badRequest('變更後數量不可小於已驗收數量');
        const date=validDate(body.change_date); const context=contextFor(sourceDatabase); const changeNo=trim(body.change_no)||await nextWorkflowNumber(conn,'procurement_order_changes','change_no','PC',date);
        const [header]=await conn.query(`INSERT INTO procurement_order_changes (tenant_id,company_id,source_system,change_no,purchase_order_id,change_date,reason,status,source_database,created_by) VALUES (?,?,?,?,?,?,?,'draft',?,?)`,[context.tenant_id,context.company_id,context.source_system,changeNo,row.header_id,date,trim(body.reason)||'採購內容調整',sourceDatabase,req.auth.id]);
        await conn.query(`INSERT INTO procurement_order_change_items (order_change_id,purchase_order_item_id,new_quantity,new_unit_price,new_expected_date,note) VALUES (?,?,?,?,?,?)`,[header.insertId,orderItemId,quantity,Number(body.new_unit_price??row.unit_price),nullableDate(body.new_expected_date)||row.expected_date,trim(body.note)]);
        return {id:header.insertId,change_no:changeNo};
      });
      res.status(201).json({ok:true,data:result});
    }catch(error){next(error);}
  });

  app.post('/api/procurement/order-changes/:id/approve',async(req,res,next)=>{
    try{
      const id=Number(req.params.id);
      await tx(async conn=>{
        const [[row]]=await conn.query(`SELECT c.status,ci.purchase_order_item_id,ci.new_quantity,ci.new_unit_price,ci.new_expected_date,i.qty_received,i.purchase_order_id
          FROM procurement_order_changes c JOIN procurement_order_change_items ci ON ci.order_change_id=c.id JOIN procurement_order_items i ON i.id=ci.purchase_order_item_id WHERE c.id=? FOR UPDATE`,[id]);
        if(!row||row.status!=='draft') throw badRequest('只有草稿變更單可以核準'); if(Number(row.new_quantity)<Number(row.qty_received)) throw badRequest('變更數量不可小於已驗收數量');
        await conn.query('UPDATE procurement_order_items SET qty_ordered=?,unit_price=?,expected_date=? WHERE id=?',[row.new_quantity,row.new_unit_price,row.new_expected_date,row.purchase_order_item_id]);
        await conn.query("UPDATE procurement_order_changes SET status='approved',approved_by=?,approved_at=NOW() WHERE id=?",[req.auth.id,id]);
      });
      res.json({ok:true,data:{id,status:'approved'}});
    }catch(error){next(error);}
  });

  app.get('/api/procurement/pending-inspections',async(req,res,next)=>{
    try{
      await ensureTargetReceiptWorkflowSchema();
      const sourceDatabase=String(req.query.source_database||'SH').toUpperCase();
      const [rows]=await pool.query(`SELECT r.id,r.receipt_no,r.receipt_date,r.supplier_code,r.status,i.id receipt_item_id,
        i.item_code,i.item_name,i.warehouse_code,i.unit,i.qty_received,i.qty_accepted,i.qty_rejected,i.inspection_status,i.inspection_note
        FROM procurement_receipts r JOIN procurement_receipt_items i ON i.receipt_id=r.id
        WHERE r.source_database=? AND r.status IN ('pending_inspection','partially_accepted') ORDER BY r.receipt_date DESC,r.id DESC`,[sourceDatabase]);
      res.json({ok:true,data:rows});
    }catch(error){next(error);}
  });

  app.post('/api/procurement/receipts/:id/inspect',async(req,res,next)=>{
    try{
      await ensureTargetReceiptWorkflowSchema();
      const id=Number(req.params.id); const body=req.body||{};
      const sourceDatabase=String(body.source_database||'SH').toUpperCase();
      await tx(async conn=>{
        const [[row]]=await conn.query(`SELECT r.id receipt_id,r.status,i.id item_id,i.purchase_order_item_id,i.qty_received,i.qty_accepted
          FROM procurement_receipts r JOIN procurement_receipt_items i ON i.receipt_id=r.id WHERE r.id=? AND r.source_database=? FOR UPDATE`,[id,sourceDatabase]);
        if(!row||!['pending_inspection','partially_accepted'].includes(row.status)) throw badRequest('此進貨單不在待驗收狀態');
        const accepted=Number(body.qty_accepted||0),rejected=Number(body.qty_rejected??(Number(row.qty_received)-accepted));
        if(accepted<0||rejected<0||accepted+rejected!==Number(row.qty_received)) throw badRequest('合格量加驗退量必須等於進貨量');
        const delta=accepted-Number(row.qty_accepted||0); const inspectionStatus=rejected===0?'accepted':accepted===0?'rejected':'partially_accepted';
        await conn.query(`UPDATE procurement_receipt_items SET qty_accepted=?,qty_rejected=?,inspection_status=?,inspection_note=?,inspected_by=?,inspected_at=NOW() WHERE id=?`,[accepted,rejected,inspectionStatus,trim(body.inspection_note),req.auth.id,row.item_id]);
        await conn.query('UPDATE procurement_receipts SET status=? WHERE id=?',[inspectionStatus,row.receipt_id]);
        if(row.purchase_order_item_id){
          await conn.query('UPDATE procurement_order_items SET qty_received=qty_received+? WHERE id=?',[delta,row.purchase_order_item_id]);
          const [[order]]=await conn.query('SELECT purchase_order_id FROM procurement_order_items WHERE id=?',[row.purchase_order_item_id]);
          const [[remaining]]=await conn.query('SELECT COUNT(*) count FROM procurement_order_items WHERE purchase_order_id=? AND qty_ordered>qty_received+qty_cancelled',[order.purchase_order_id]);
          await conn.query('UPDATE procurement_orders SET status=? WHERE id=?',[Number(remaining.count)?'partial_received':'received',order.purchase_order_id]);
        }
      });
      res.json({ok:true,data:{id}});
    }catch(error){next(error);}
  });

  app.get('/api/procurement/rejected-items', async (req, res, next) => {
    try {
      await ensureTargetReceiptWorkflowSchema();
      const sourceDatabase = String(req.query.source_database || 'SH').toUpperCase();
      const [rows] = await pool.query(`
        SELECT r.id receipt_id, r.receipt_no, r.receipt_date, r.supplier_code,
          i.id receipt_item_id, i.item_code, i.item_name, i.warehouse_code, i.unit,
          i.qty_rejected, i.qty_rejected_returned,
          GREATEST(i.qty_rejected - i.qty_rejected_returned, 0) AS remaining_return_quantity,
          DATE_FORMAT(MAX(rr.returned_date),'%Y-%m-%d') AS last_returned_date,
          SUBSTRING_INDEX(GROUP_CONCAT(rr.returned_by ORDER BY rr.returned_date DESC, rr.id DESC), ',', 1) AS last_returned_by,
          COUNT(rr.id) AS returned_record_count
        FROM procurement_receipts r
        JOIN procurement_receipt_items i ON i.receipt_id=r.id
        LEFT JOIN procurement_rejected_returns rr ON rr.receipt_item_id=i.id
        WHERE r.source_database=? AND i.qty_rejected>i.qty_rejected_returned
          AND i.inspection_status IN ('rejected','partially_accepted')
        GROUP BY r.id,r.receipt_no,r.receipt_date,r.supplier_code,i.id,i.item_code,i.item_name,i.warehouse_code,i.unit,i.qty_rejected,i.qty_rejected_returned
        ORDER BY r.receipt_date DESC,r.id DESC,i.line_no`, [sourceDatabase]);
      res.json({ok:true,data:rows});
    } catch (error) { next(error); }
  });

  app.get('/api/procurement/rejected-returns', async (req, res, next) => {
    try {
      await ensureTargetReceiptWorkflowSchema();
      const sourceDatabase = String(req.query.source_database || 'SH').toUpperCase();
      const [rows] = await pool.query(`
        SELECT rr.id, r.receipt_no, r.receipt_date, r.supplier_code, i.item_code, i.item_name,
          rr.returned_date, rr.returned_quantity, rr.returned_by, rr.note
        FROM procurement_rejected_returns rr
        JOIN procurement_receipts r ON r.id=rr.receipt_id
        JOIN procurement_receipt_items i ON i.id=rr.receipt_item_id
        WHERE rr.source_database=? ORDER BY rr.returned_date DESC,rr.id DESC LIMIT 20`, [sourceDatabase]);
      res.json({ok:true,data:rows});
    } catch (error) { next(error); }
  });

  app.post('/api/procurement/receipts/:id/rejected-return', async (req, res, next) => {
    try {
      await ensureTargetReceiptWorkflowSchema();
      const id = Number(req.params.id); const body = req.body || {};
      const sourceDatabase = String(body.source_database || 'SH').toUpperCase();
      const receiptItemId = Number(body.receipt_item_id);
      const returnedQuantity = positiveNumber(body.returned_quantity, '實際退回數量');
      const returnedDate = validDate(body.returned_date);
      const returnedBy = trim(body.returned_by);
      if (!Number.isInteger(id) || id < 1 || !Number.isInteger(receiptItemId) || receiptItemId < 1) throw badRequest('驗退件資料識別碼錯誤');
      if (!returnedBy) throw badRequest('請輸入實際退回人員');
      const result = await tx(async conn => {
        const [[row]] = await conn.query(`
          SELECT r.id receipt_id,r.supplier_code,i.id receipt_item_id,i.qty_rejected,i.qty_rejected_returned,i.inspection_status
          FROM procurement_receipts r JOIN procurement_receipt_items i ON i.receipt_id=r.id
          WHERE r.id=? AND i.id=? AND r.source_database=? FOR UPDATE`, [id,receiptItemId,sourceDatabase]);
        if (!row) throw notFound('找不到驗退件');
        if (!['rejected','partially_accepted'].includes(row.inspection_status) || Number(row.qty_rejected) <= 0) throw badRequest('只有完成驗收且有不合格量的進貨才能辦理驗退件退回');
        const remaining = Number(row.qty_rejected) - Number(row.qty_rejected_returned || 0);
        if (returnedQuantity > remaining) throw badRequest(`實際退回數量不可超過待退量 ${remaining}`);
        const context = contextFor(sourceDatabase);
        const [insert] = await conn.query(`INSERT INTO procurement_rejected_returns
          (tenant_id,company_id,source_system,source_database,receipt_id,receipt_item_id,returned_date,returned_quantity,returned_by,note,created_by)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [context.tenant_id,context.company_id,context.source_system,sourceDatabase,id,receiptItemId,returnedDate,returnedQuantity,returnedBy,trim(body.note),req.auth.id]);
        await conn.query('UPDATE procurement_receipt_items SET qty_rejected_returned=qty_rejected_returned+? WHERE id=?', [returnedQuantity,receiptItemId]);
        return {id:insert.insertId,receipt_id:id,receipt_item_id:receiptItemId,returned_quantity:returnedQuantity,returned_date:returnedDate,returned_by:returnedBy};
      });
      res.status(201).json({ok:true,data:result});
    } catch (error) { next(error); }
  });

  app.get('/api/procurement/returnable-receipts',async(req,res,next)=>{
    try{
      const sourceDatabase=String(req.query.source_database||'SH').toUpperCase();
      const [rows]=await pool.query(`SELECT i.id receipt_item_id,r.receipt_no,r.receipt_date,r.supplier_code,
        i.item_code,i.item_name,i.warehouse_code,i.unit,i.qty_accepted,i.qty_returned,i.qty_priced,i.qty_returned_priced,
        COALESCE((SELECT SUM(pri.return_quantity) FROM procurement_return_items pri JOIN procurement_returns pr ON pr.id=pri.return_id
          WHERE pri.receipt_item_id=i.id AND pr.status IN ('draft','approved') AND pr.return_type='return'),0) reserved_return_quantity,
        COALESCE((SELECT SUM(pri.priced_quantity) FROM procurement_return_items pri JOIN procurement_returns pr ON pr.id=pri.return_id
          WHERE pri.receipt_item_id=i.id AND pr.status IN ('draft','approved') AND pr.return_type='return'),0) reserved_priced_quantity,
        GREATEST(i.qty_accepted-i.qty_returned-COALESCE((SELECT SUM(pri.return_quantity) FROM procurement_return_items pri JOIN procurement_returns pr ON pr.id=pri.return_id
          WHERE pri.receipt_item_id=i.id AND pr.status IN ('draft','approved') AND pr.return_type='return'),0),0) returnable_quantity,i.unit_cost
        FROM procurement_receipts r JOIN procurement_receipt_items i ON i.receipt_id=r.id
        WHERE r.source_database=? AND r.inventory_status='posted' AND r.status IN ('accepted','partially_accepted') AND i.qty_accepted>i.qty_returned
        ORDER BY r.receipt_date DESC,r.id DESC`,[sourceDatabase]);
      res.json({ok:true,data:rows});
    }catch(error){next(error);}
  });

  app.get('/api/procurement/returns',async(req,res,next)=>{
    try{
      const sourceDatabase=String(req.query.source_database||'SH').toUpperCase();
      const [rows]=await pool.query(`SELECT r.id,r.return_no,r.return_date,r.return_type,r.supplier_code,r.status,r.inventory_status,r.note,
        i.receipt_item_id,i.item_code,i.item_name,i.warehouse_code,i.unit,i.return_quantity,i.priced_quantity,i.allowance_amount,i.unit_cost,i.reason
        FROM procurement_returns r JOIN procurement_return_items i ON i.return_id=r.id WHERE r.source_database=? ORDER BY r.return_date DESC,r.id DESC`,[sourceDatabase]);
      res.json({ok:true,data:rows});
    }catch(error){next(error);}
  });

  app.post('/api/procurement/returns',async(req,res,next)=>{
    try{
      const body=req.body||{}; const sourceDatabase=String(body.source_database||'SH').toUpperCase(); const returnType=trim(body.return_type);
      if(!['return','allowance'].includes(returnType)) throw badRequest('退貨類型必須是退貨或折讓');
      const result=await tx(async conn=>{
        const receiptItemId=Number(body.receipt_item_id||0)||null; let source=null;
        if(receiptItemId){ const [[row]]=await conn.query(`SELECT i.*,r.supplier_code,r.inventory_status,r.status receipt_status FROM procurement_receipt_items i JOIN procurement_receipts r ON r.id=i.receipt_id WHERE i.id=? AND r.source_database=? FOR UPDATE`,[receiptItemId,sourceDatabase]); if(!row) throw notFound('進貨來源明細不存在'); source=row; }
        const quantity=Number(body.return_quantity||0),allowance=Number(body.allowance_amount||0);
        if(returnType==='return'){
          if(!source || source.inventory_status!=='posted' || !['accepted','partially_accepted'].includes(source.receipt_status)) throw badRequest('實體退貨必須參考已驗收且已入庫的進貨明細');
          const [[reserved]]=await conn.query(`SELECT COALESCE(SUM(i.return_quantity),0) quantity FROM procurement_return_items i JOIN procurement_returns r ON r.id=i.return_id WHERE i.receipt_item_id=? AND r.return_type='return' AND r.status IN ('draft','approved') FOR UPDATE`,[receiptItemId]);
          if(quantity<=0 || quantity>Number(source.qty_accepted)-Number(source.qty_returned)-Number(reserved.quantity||0)) throw badRequest('退貨數量不可超過可退合格數量（已扣除待核准／待過帳退貨）');
        }
        if(returnType==='allowance' && allowance<=0) throw badRequest('折讓金額必須大於零');
        const supplier=trim(body.supplier_code)||source?.supplier_code; const itemCode=trim(body.item_code)||source?.item_code; if(!supplier||!itemCode) throw badRequest('廠商與品號不可空白');
        const date=validDate(body.return_date); const context=contextFor(sourceDatabase); const typeCode=trim(body.document_type);
        const [[documentType]]=await conn.query(`SELECT * FROM procurement_document_types WHERE tenant_id=? AND company_id=? AND source_system=? AND document_kind='purchase_return' AND type_code=? AND is_active=1`,[context.tenant_id,context.company_id,context.source_system,typeCode]);
        if(!documentType) throw badRequest('請選擇有效的退貨／折讓單別');
        const no=trim(body.return_no)||await nextConfiguredDocumentNumber(conn,'procurement_returns','return_no',documentType,date);
        const [header]=await conn.query(`INSERT INTO procurement_returns (tenant_id,company_id,source_system,document_type,return_no,supplier_code,return_date,return_type,status,inventory_status,note,source_database,created_by) VALUES (?,?,?,?,?,?,?,?,'draft',?,?,?,?)`,[context.tenant_id,context.company_id,context.source_system,trim(body.document_type)||'PR',no,supplier,date,returnType,returnType==='return'?'pending':'not_applicable',trim(body.note),sourceDatabase,req.auth.id]);
        await conn.query(`INSERT INTO procurement_return_items (return_id,receipt_item_id,line_no,item_code,item_name,warehouse_code,unit,return_quantity,allowance_amount,unit_cost,reason) VALUES (?,?,1,?,?,?,?,?,?,?,?)`,[header.insertId,receiptItemId,itemCode,trim(body.item_name)||source?.item_name,trim(body.warehouse_code)||source?.warehouse_code,trim(body.unit)||source?.unit||'PCS',quantity,allowance,Number(body.unit_cost??source?.unit_cost??0),trim(body.reason)]);
        return {id:header.insertId,return_no:no};
      });
      res.status(201).json({ok:true,data:result});
    }catch(error){next(error);}
  });

  app.post('/api/procurement/returns/:id/approve',async(req,res,next)=>{
    try{
      const id=Number(req.params.id),sourceDatabase=String(req.body?.source_database||'SH').toUpperCase();
      await tx(async conn=>{
        const [[row]]=await conn.query(`SELECT r.status,r.return_type,i.id return_item_id,i.receipt_item_id,i.return_quantity,i.priced_quantity,
          ri.qty_accepted,ri.qty_returned,ri.qty_priced,ri.qty_returned_priced,ri.purchase_order_item_id,rr.inventory_status receipt_inventory_status
          FROM procurement_returns r JOIN procurement_return_items i ON i.return_id=r.id LEFT JOIN procurement_receipt_items ri ON ri.id=i.receipt_item_id LEFT JOIN procurement_receipts rr ON rr.id=ri.receipt_id WHERE r.id=? AND r.source_database=? FOR UPDATE`,[id,sourceDatabase]);
        if(!row||row.status!=='draft') throw badRequest('只有草稿退貨／折讓單可以核準');
        if(row.return_type==='return'){
          if(row.receipt_inventory_status!=='posted') throw badRequest('來源進貨尚未完成入庫，不能核準實體退貨');
          const [[reserved]]=await conn.query(`SELECT COALESCE(SUM(i.return_quantity),0) quantity,COALESCE(SUM(i.priced_quantity),0) priced_quantity
            FROM procurement_return_items i JOIN procurement_returns r ON r.id=i.return_id
            WHERE i.receipt_item_id=? AND r.return_type='return' AND r.status IN ('draft','approved') AND r.id<>? FOR UPDATE`,[row.receipt_item_id,id]);
          const available=Number(row.qty_accepted)-Number(row.qty_returned)-Number(reserved.quantity||0);
          if(Number(row.return_quantity)>available) throw badRequest(`退貨數量超過目前可退量 ${available}`);
          const pricedAvailable=Math.max(Number(row.qty_priced||0)-Number(row.qty_returned_priced||0)-Number(reserved.priced_quantity||0),0);
          const pricedQuantity=Math.min(Number(row.return_quantity),pricedAvailable);
          await conn.query('UPDATE procurement_return_items SET priced_quantity=? WHERE id=?',[pricedQuantity,row.return_item_id]);
          // 真正退貨須等庫存反向過帳才回沖採購已交量，避免「核准了但庫存未扣」的假性未交。
        }
        await conn.query("UPDATE procurement_returns SET status='approved',approved_by=?,approved_at=NOW() WHERE id=?",[req.auth.id,id]);
      });
      res.json({ok:true,data:{id,status:'approved'}});
    }catch(error){next(error);}
  });

  app.get('/api/procurement/progress',async(req,res,next)=>{
    try{
      const sourceDatabase=String(req.query.source_database||'SH').toUpperCase();
      const limit=Math.min(Math.max(Number(req.query.limit)||10,1),100);
      const [rows]=await pool.query(`SELECT o.id,o.purchase_order_no,o.order_date,o.expected_date,o.supplier_code,o.status,o.closed_at,
        i.item_code,i.item_name,i.unit,i.qty_ordered,i.qty_received,i.qty_cancelled,
        GREATEST(i.qty_ordered-i.qty_received-i.qty_cancelled,0) remaining_quantity,
        CASE WHEN o.status='closed' THEN 'closed' WHEN i.qty_ordered-i.qty_received-i.qty_cancelled<=0 THEN 'fulfilled_waiting_close'
          WHEN o.expected_date<CURDATE() THEN 'overdue' WHEN i.qty_received>0 THEN 'partial' ELSE 'open' END progress_status
        FROM procurement_orders o JOIN procurement_order_items i ON i.purchase_order_id=o.id
        WHERE o.source_database=? AND o.status<>'cancelled' ORDER BY o.order_date DESC,o.id DESC LIMIT ?`,[sourceDatabase,limit]);
      res.json({ok:true,data:rows});
    }catch(error){next(error);}
  });

  app.get('/api/procurement/open-orders',async(req,res,next)=>{
    try{
      const sourceDatabase=String(req.query.source_database||'SH').toUpperCase();
      const limit=Math.min(Math.max(Number(req.query.limit)||10,1),100);
      const [rows]=await pool.query(`SELECT o.purchase_order_no,o.order_date,o.expected_date,o.supplier_code,o.status,
        i.item_code,i.item_name,i.warehouse_code,i.unit,i.qty_ordered,i.qty_received,i.qty_cancelled,
        i.qty_ordered-i.qty_received-i.qty_cancelled remaining_quantity,i.unit_price,
        (i.qty_ordered-i.qty_received-i.qty_cancelled)*i.unit_price remaining_amount
        FROM procurement_orders o JOIN procurement_order_items i ON i.purchase_order_id=o.id
        WHERE o.source_database=? AND o.status NOT IN ('cancelled','closed') AND i.qty_ordered>i.qty_received+i.qty_cancelled
        ORDER BY o.order_date DESC,o.id DESC LIMIT ?`,[sourceDatabase,limit]);
      res.json({ok:true,data:rows});
    }catch(error){next(error);}
  });
}

const SALES_RETURN_FINANCE_EPS = 0.000001;

function salesReturnFinanceContext(sourceDatabase) {
  const db = String(sourceDatabase || '').trim().toUpperCase();
  const source = sourceDatabases[db];
  if (!source) throw badRequest('找不到資料來源：' + db);
  return {
    tenant_id: source.tenant_id || 'default',
    company_id: source.company_id || db,
    source_system: source.source_system || source.adapter_code || 'ism-sh',
    source_database: db,
  };
}

function salesReturnFinanceAmount(document, item) {
  const quantity = Number(item?.quantity ?? item?.return_quantity ?? 0) || 0;
  const unitPrice = Number(item?.unit_price ?? item?.return_unit_price ?? 0) || 0;
  const allowance = Number(item?.allowance_amount ?? item?.return_allowance_amount ?? 0) || 0;
  if (String(document?.return_type || '') === 'allowance') return Math.max(allowance || quantity * unitPrice, 0);
  return Math.max(quantity * unitPrice - allowance, 0);
}

async function recordSalesReturnAdjustmentEvent(conn, adjustment, eventKind, beforeStatus, afterStatus, openItemId, amount, reason, userId) {
  await conn.query(`INSERT INTO finance_return_adjustment_events(
    tenant_id,company_id,source_system,source_database,adjustment_id,event_kind,
    before_status,after_status,open_item_id,amount,reason,created_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, [
    adjustment.tenant_id, adjustment.company_id, adjustment.source_system, adjustment.source_database,
    adjustment.id, eventKind, beforeStatus || null, afterStatus || null, openItemId || null,
    Number(amount || 0), reason || null, userId || null,
  ]);
}

async function ensureSalesReturnAdjustment(conn, document, item, userId) {
  const returnAmount = salesReturnFinanceAmount(document, item);
  if (returnAmount <= SALES_RETURN_FINANCE_EPS) return null;
  const c = salesReturnFinanceContext(document.source_database);
  let [[adjustment]] = await conn.query(`SELECT * FROM finance_return_adjustments
    WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND sales_return_item_id=? FOR UPDATE`,
    [c.tenant_id, c.company_id, c.source_system, c.source_database, item.id]);
  if (!adjustment) {
    const [created] = await conn.query(`INSERT INTO finance_return_adjustments(
      tenant_id,company_id,source_system,source_database,sales_return_id,sales_return_item_id,shipment_item_id,
      adjustment_date,return_amount,receivable_offset_amount,customer_credit_amount,refund_amount,status,note,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,0,0,0,'pending',?,?)`, [
      c.tenant_id, c.company_id, c.source_system, c.source_database, document.id, item.id,
      Number(item.source_item_id || 0) || null, document.document_date, returnAmount,
      '銷退／折讓 ' + document.document_no + ' 已記錄，等待原應收同步', userId,
    ]);
    [[adjustment]] = await conn.query('SELECT * FROM finance_return_adjustments WHERE id=? FOR UPDATE', [created.insertId]);
    await recordSalesReturnAdjustmentEvent(conn, adjustment, 'created', null, 'pending', null, returnAmount,
      '建立銷退應收處理紀錄：' + document.document_no, userId);
  }
  if (Math.abs(Number(adjustment.return_amount || 0) - returnAmount) > SALES_RETURN_FINANCE_EPS) {
    throw badRequest('銷退 ' + document.document_no + ' 已有不同金額的應收處理紀錄');
  }
  return adjustment;
}

async function findSalesReturnFinanceOpenItems(conn, adjustment, document, item) {
  const c = salesReturnFinanceContext(adjustment.source_database);
  const shipmentItemId = Number(item?.source_item_id || adjustment.shipment_item_id || 0) || null;
  if (!shipmentItemId) return [];
  const [[shipment]] = await conn.query(`SELECT si.document_id,sd.customer_code,sd.currency_code
    FROM sales_document_items si
    JOIN sales_documents sd ON sd.id=si.document_id
    WHERE si.id=? AND sd.source_database=? AND sd.document_kind='shipment' FOR UPDATE`,
    [shipmentItemId, c.source_database]);
  if (!shipment) return [];
  const partyCode = trim(document.customer_code) || shipment.customer_code;
  const currencyCode = trim(document.currency_code) || shipment.currency_code || 'TWD';
  const [directOpenItems] = await conn.query(`SELECT oi.* FROM finance_open_items oi
    WHERE oi.tenant_id=? AND oi.company_id=? AND oi.source_system=? AND oi.source_database=?
      AND oi.account_type='AR' AND oi.source_kind='shipment' AND oi.source_document_id=?
      AND oi.party_code=? AND oi.currency_code=?
      AND oi.status IN ('approved','open','partial','settled')
    ORDER BY oi.document_date,oi.id FOR UPDATE`, [
    c.tenant_id, c.company_id, c.source_system, c.source_database, shipment.document_id,
    partyCode, currencyCode,
  ]);
  const [voucherOpenItems] = await conn.query(`SELECT DISTINCT oi.* FROM finance_voucher_sources vs
    JOIN finance_vouchers v ON v.id=vs.voucher_id
    JOIN finance_open_items oi ON oi.source_kind='finance_voucher' AND oi.source_document_id=v.id
    WHERE v.tenant_id=? AND v.company_id=? AND v.source_system=? AND v.source_database=?
      AND v.account_type='AR' AND v.status IN ('approved','posted')
      AND vs.source_kind='shipment' AND vs.source_document_item_id=?
      AND oi.tenant_id=? AND oi.company_id=? AND oi.source_system=? AND oi.source_database=?
      AND oi.party_code=? AND oi.currency_code=?
      AND oi.status IN ('approved','open','partial','settled')
    ORDER BY oi.document_date,oi.id FOR UPDATE`, [
    c.tenant_id, c.company_id, c.source_system, c.source_database, shipmentItemId,
    c.tenant_id, c.company_id, c.source_system, c.source_database, partyCode, currencyCode,
  ]);
  return [...new Map([...directOpenItems, ...voucherOpenItems].map(row => [Number(row.id), row])).values()]
    .sort((a, b) => String(a.document_date).localeCompare(String(b.document_date)) || Number(a.id) - Number(b.id));
}

async function syncSalesReturnAdjustment(conn, adjustmentId, userId) {
  let [[adjustment]] = await conn.query('SELECT * FROM finance_return_adjustments WHERE id=? FOR UPDATE', [adjustmentId]);
  if (!adjustment) return null;
  const [[returnLine]] = await conn.query(`SELECT d.*,i.id sales_return_item_id,i.source_item_id shipment_item_id,
      i.quantity return_quantity,i.unit_price return_unit_price,i.allowance_amount return_allowance_amount
    FROM sales_documents d
    JOIN sales_document_items i ON i.document_id=d.id
    WHERE d.id=? AND i.id=? AND d.document_kind='sales_return' FOR UPDATE`,
    [adjustment.sales_return_id, adjustment.sales_return_item_id]);
  if (!returnLine) return null;
  const returnAmount = salesReturnFinanceAmount(returnLine, returnLine);
  if (Math.abs(Number(adjustment.return_amount || 0) - returnAmount) > SALES_RETURN_FINANCE_EPS) {
    throw badRequest('銷退 ' + returnLine.document_no + ' 的應收處理金額與原單不一致');
  }
  const openItems = await findSalesReturnFinanceOpenItems(conn, adjustment, returnLine, returnLine);
  const beforeStatus = String(adjustment.status || 'pending');
  let offsetTotal = Number(adjustment.receivable_offset_amount || 0);
  const [[existingCredit]] = await conn.query('SELECT * FROM finance_customer_credits WHERE source_adjustment_id=? FOR UPDATE', [adjustment.id]);
  // 舊版本若只建立了待抵資料、尚未回寫 adjustment.customer_credit_amount，
  // 仍以待抵原始金額作為已處理額，避免後續自動同步重複沖帳。
  let creditTotal = Math.max(Number(adjustment.customer_credit_amount || 0), Number(existingCredit?.original_amount || 0));
  let remaining = Math.max(returnAmount - offsetTotal - creditTotal, 0);
  let firstOpenItemId = Number(adjustment.open_item_id || 0) || null;
  const allocationEvents = [];

  for (const openItem of openItems) {
    if (remaining <= SALES_RETURN_FINANCE_EPS) break;
    const usable = Math.max(Number(openItem.balance_amount || 0), 0);
    if (usable <= SALES_RETURN_FINANCE_EPS) continue;
    const applied = Math.min(usable, remaining);
    const rate = Number(openItem.exchange_rate || 1) || 1;
    const balance = Math.max(usable - applied, 0);
    const previousBaseBalance = Number(openItem.base_balance_amount || 0) || usable * rate;
    const baseBalance = Math.max(previousBaseBalance - applied * rate, 0);
    const adjustmentAmount = Number(openItem.adjustment_amount || 0) + applied;
    const baseAdjustmentAmount = Number(openItem.base_adjustment_amount || 0) + applied * rate;
    const nextStatus = balance <= SALES_RETURN_FINANCE_EPS
      ? 'settled'
      : (Number(openItem.settled_amount || 0) + adjustmentAmount > SALES_RETURN_FINANCE_EPS ? 'partial' : 'open');
    await conn.query(`UPDATE finance_open_items SET adjustment_amount=?,base_adjustment_amount=?,
      balance_amount=?,base_balance_amount=?,status=?,
      note=TRIM(CONCAT(COALESCE(note,''),CASE WHEN COALESCE(note,'')='' THEN '' ELSE '；' END,?))
      WHERE id=? AND status<>'voided'`, [
      adjustmentAmount, baseAdjustmentAmount, balance, baseBalance, nextStatus,
      '銷退 ' + returnLine.document_no + ' 自動沖減應收 ' + applied, openItem.id,
    ]);
    await conn.query(`INSERT INTO finance_return_adjustment_allocations(
      adjustment_id,open_item_id,allocated_amount,base_allocated_amount,created_by)
      VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE
        allocated_amount=allocated_amount+VALUES(allocated_amount),
        base_allocated_amount=base_allocated_amount+VALUES(base_allocated_amount)`, [
      adjustment.id, openItem.id, applied, applied * rate, userId,
    ]);
    firstOpenItemId = firstOpenItemId || Number(openItem.id);
    offsetTotal += applied;
    remaining -= applied;
    allocationEvents.push({ openItemId: Number(openItem.id), amount: applied });
  }

  let creditCreated = 0;
  if (openItems.length && remaining > SALES_RETURN_FINANCE_EPS) {
    if (!existingCredit) {
      await conn.query(`INSERT INTO finance_customer_credits(
        tenant_id,company_id,source_system,source_database,party_code,currency_code,credit_date,
        source_adjustment_id,original_amount,balance_amount,status,note,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,'available',?,?)`, [
        adjustment.tenant_id, adjustment.company_id, adjustment.source_system, adjustment.source_database,
        returnLine.customer_code, returnLine.currency_code || 'TWD', returnLine.document_date, adjustment.id,
        remaining, remaining, '銷退 ' + returnLine.document_no + ' 已收款／超過未收部分轉客戶待抵，可再轉抵或退款', userId,
      ]);
      creditTotal += remaining;
      creditCreated = remaining;
    }
  }

  const residual = Math.max(returnAmount - offsetTotal - creditTotal, 0);
  const status = residual > SALES_RETURN_FINANCE_EPS
    ? 'pending'
    : (offsetTotal > SALES_RETURN_FINANCE_EPS && creditTotal > SALES_RETURN_FINANCE_EPS
      ? 'mixed'
      : offsetTotal > SALES_RETURN_FINANCE_EPS ? 'offset' : creditTotal > SALES_RETURN_FINANCE_EPS ? 'credit' : 'pending');
  await conn.query(`UPDATE finance_return_adjustments SET open_item_id=COALESCE(open_item_id,?),
    receivable_offset_amount=?,customer_credit_amount=?,status=?,processed_by=?,processed_at=NOW(),note=?
    WHERE id=?`, [
    firstOpenItemId, offsetTotal, creditTotal, status, userId,
    '銷退／折讓 ' + returnLine.document_no + '：應收沖帳 ' + offsetTotal + '，客戶待抵 ' + creditTotal + '，待同步 ' + residual,
    adjustment.id,
  ]);
  [[adjustment]] = await conn.query('SELECT * FROM finance_return_adjustments WHERE id=? FOR UPDATE', [adjustment.id]);
  for (const event of allocationEvents) {
    await recordSalesReturnAdjustmentEvent(conn, adjustment, 'offset', beforeStatus, status, event.openItemId,
      event.amount, '銷退 ' + returnLine.document_no + ' 自動沖減原應收', userId);
  }
  if (creditCreated > SALES_RETURN_FINANCE_EPS) {
    await recordSalesReturnAdjustmentEvent(conn, adjustment, 'credit', beforeStatus, status, null, creditCreated,
      '銷退 ' + returnLine.document_no + ' 形成客戶待抵', userId);
  }
  if (!allocationEvents.length && creditCreated <= SALES_RETURN_FINANCE_EPS && beforeStatus !== status) {
    await recordSalesReturnAdjustmentEvent(conn, adjustment, 'status_sync', beforeStatus, status, firstOpenItemId, 0,
      '銷退 ' + returnLine.document_no + ' 應收狀態同步', userId);
  }
  return {
    adjustment_id: Number(adjustment.id), status, return_amount: returnAmount,
    receivable_offset_amount: offsetTotal, customer_credit_amount: creditTotal, residual,
    open_item_id: firstOpenItemId, open_item_count: openItems.length,
  };
}

async function syncPendingSalesReturnAdjustmentsForOpenItem(conn, openItemId, userId) {
  const [[openItem]] = await conn.query(`SELECT * FROM finance_open_items WHERE id=? FOR UPDATE`, [openItemId]);
  if (!openItem || openItem.account_type !== 'AR' || !['approved', 'open', 'partial', 'settled'].includes(String(openItem.status))) return [];
  let shipmentItemIds = [];
  if (openItem.source_kind === 'shipment') {
    const [items] = await conn.query(`SELECT si.id FROM sales_document_items si
      JOIN sales_documents sd ON sd.id=si.document_id
      WHERE si.document_id=? AND sd.source_database=?`, [openItem.source_document_id, openItem.source_database]);
    shipmentItemIds = items.map(row => Number(row.id)).filter(Boolean);
  } else if (openItem.source_kind === 'finance_voucher') {
    const [items] = await conn.query(`SELECT DISTINCT source_document_item_id id
      FROM finance_voucher_sources WHERE voucher_id=? AND source_kind='shipment' AND source_document_item_id IS NOT NULL`, [openItem.source_document_id]);
    shipmentItemIds = items.map(row => Number(row.id)).filter(Boolean);
  }
  if (!shipmentItemIds.length) return [];
  const [adjustments] = await conn.query(`SELECT a.id FROM finance_return_adjustments a
    WHERE a.tenant_id=? AND a.company_id=? AND a.source_system=? AND a.source_database=?
      AND a.shipment_item_id IN (?)
      AND a.return_amount-a.receivable_offset_amount-a.customer_credit_amount>?
    ORDER BY a.adjustment_date,a.id FOR UPDATE`, [
    openItem.tenant_id, openItem.company_id, openItem.source_system, openItem.source_database,
    shipmentItemIds, SALES_RETURN_FINANCE_EPS,
  ]);
  const results = [];
  for (const adjustment of adjustments) {
    const result = await syncSalesReturnAdjustment(conn, adjustment.id, userId);
    if (result) results.push(result);
  }
  return results;
}

function registerSalesCustomerItemRoutes(app) {
  const contextForRequest = req => {
    const sourceName = sourceDbFromRequest(req);
    const source = sourceDatabases[sourceName];
    if (source?.adapter_code !== 'ism-sh') throw badRequest('目前客戶品號作業只適用 iSM 銷售來源');
    return {
      sourceName,
      source,
      context: {
        tenant_id: source.tenant_id || 'default',
        company_id: source.company_id || sourceName,
        source_system: source.source_system || 'iSM',
        source_database: sourceName
      }
    };
  };
  const hasOwn = (body, key) => Object.prototype.hasOwnProperty.call(body, key);
  const textValue = (body, key, current = null, fallback = null) => {
    if (hasOwn(body, key)) return trim(body[key]) || null;
    if (current && current[key] !== undefined) return trim(current[key]) || null;
    return fallback;
  };
  const bounded = (value, label, max, required = false) => {
    const text = trim(value);
    if (required && !text) throw badRequest(`${label}為必填`);
    if (text.length > max) throw badRequest(`${label}不可超過 ${max} 個字元`);
    return text || null;
  };
  const activeValue = (value, fallback = 1) => {
    if (value === undefined || value === null || value === '') return fallback;
    if ([1, true, '1', 'true', 'TRUE', 'yes', 'on'].includes(value)) return 1;
    if ([0, false, '0', 'false', 'FALSE', 'no', 'off'].includes(value)) return 0;
    throw badRequest('啟用狀態只能是 0 或 1');
  };
  const normalizedDate = value => value == null || value === '' ? null : validDate(value);
  const rowDate = value => dateText(value) || null;
  const mappingSnapshot = row => ({
    id: Number(row.id),
    customer_code: trim(row.customer_code),
    customer_name: trim(row.customer_name),
    external_item_code: trim(row.external_item_code),
    external_item_name: trim(row.external_item_name) || null,
    external_specification: trim(row.external_specification) || null,
    item_code: trim(row.item_code),
    item_name: trim(row.item_name),
    specification: trim(row.specification) || null,
    unit: trim(row.unit) || null,
    effective_from: rowDate(row.effective_from),
    effective_to: rowDate(row.effective_to),
    is_active: Number(row.is_active) ? 1 : 0,
    note: trim(row.note) || null,
    source_table: trim(row.source_table) || 'manual',
    source_key: trim(row.source_key) || null
  });
  const insertMappingEvent = async (conn, mappingId, context, eventKind, before, after, reason, userId) => {
    await conn.query(`INSERT INTO erp_customer_item_mapping_events
      (mapping_id,tenant_id,company_id,source_system,source_database,event_kind,before_json,after_json,reason,changed_by)
      VALUES(?,?,?,?,?,?,?,?,?,?)`, [
      mappingId, context.tenant_id, context.company_id, context.source_system, context.source_database,
      eventKind, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after),
      String(reason || eventKind).slice(0, 500), Number.isInteger(Number(userId)) ? Number(userId) : null
    ]);
  };
  const ensureTargetContextMaster = async (conn, context, customerCode, itemCode) => {
    const [[customer]] = await conn.query(`SELECT id,customer_code,customer_name
      FROM erp_customers
      WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND customer_code=?
      LIMIT 1`, [context.tenant_id, context.company_id, context.source_system, context.source_database, customerCode]);
    if (!customer) throw badRequest(`找不到目前公司別的客戶主檔：${customerCode}`);
    const [[item]] = await conn.query(`SELECT id,item_code,item_name,specification,unit
      FROM erp_items
      WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND item_code=?
      LIMIT 1`, [context.tenant_id, context.company_id, context.source_system, context.source_database, itemCode]);
    if (!item) throw badRequest(`找不到目前公司別的品號主檔：${itemCode}`);
    return { customer, item };
  };
  const mappingInput = async (conn, context, body, current = null) => {
    const customerCode = bounded(hasOwn(body, 'customer_code') ? body.customer_code : current?.customer_code, '客戶代號', 30, true);
    const externalItemCode = bounded(hasOwn(body, 'external_item_code') ? body.external_item_code : current?.external_item_code, '外部客戶料號', 80, true);
    const itemCode = bounded(hasOwn(body, 'item_code') ? body.item_code : current?.item_code, 'ERP 品號', 40, true);
    const effectiveFrom = normalizedDate(hasOwn(body, 'effective_from') ? body.effective_from : rowDate(current?.effective_from));
    if (!effectiveFrom) throw badRequest('生效日為必填');
    const effectiveTo = normalizedDate(hasOwn(body, 'effective_to') ? body.effective_to : rowDate(current?.effective_to));
    if (effectiveTo && effectiveTo < effectiveFrom) throw badRequest('失效日不可早於生效日');
    const isActive = activeValue(hasOwn(body, 'is_active') ? body.is_active : undefined, Number(current?.is_active ?? 1));
    const note = bounded(hasOwn(body, 'note') ? body.note : current?.note, '備註', 255);
    const { customer, item } = await ensureTargetContextMaster(conn, context, customerCode, itemCode);
    const externalItemName = bounded(
      hasOwn(body, 'external_item_name') ? body.external_item_name : current?.external_item_name,
      '客戶品名', 160
    ) || item.item_name;
    const externalSpecification = bounded(
      hasOwn(body, 'external_specification') ? body.external_specification : current?.external_specification,
      '客戶規格', 160
    );
    return {
      customer, item, customerCode, externalItemCode, itemCode, effectiveFrom, effectiveTo,
      isActive, note, externalItemName, externalSpecification
    };
  };
  const assertNoActiveOverlap = async (conn, context, input, excludeId = null) => {
    if (!input.isActive) return;
    const params = [
      context.tenant_id, context.company_id, context.source_system, context.source_database,
      input.customerCode, input.externalItemCode, input.effectiveTo, input.effectiveFrom
    ];
    let exclude = '';
    if (excludeId) { exclude = ' AND id<>?'; params.push(excludeId); }
    const [[overlap]] = await conn.query(`SELECT id,effective_from,effective_to
      FROM erp_customer_item_mappings
      WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=?
        AND customer_code=? AND external_item_code=? AND is_active=1
        AND effective_from<=COALESCE(?, '9999-12-31')
        AND COALESCE(effective_to,'9999-12-31')>=?${exclude}
      ORDER BY effective_from,id LIMIT 1 FOR UPDATE`, params);
    if (overlap) throw badRequest(`同一客戶的外部客戶料號有效期間重疊（${rowDate(overlap.effective_from)}～${rowDate(overlap.effective_to) || '永久'}），請先調整期間或停用原版本`);
  };
  const effectiveStatus = (row, asOfDate) => {
    if (!Number(row.is_active)) return '已停用';
    if (!asOfDate) return '未套用基準日';
    const from = rowDate(row.effective_from), to = rowDate(row.effective_to);
    if (from && asOfDate < from) return '尚未生效';
    if (to && asOfDate > to) return '已失效';
    return '有效';
  };
  const auditMapping = async (req, sourceName, actionCode, id, before, after, reason) => {
    await recordAccessAudit({
      actorUserId: req.auth?.id, targetUserId: req.auth?.id, actionCode,
      entityType: 'erp_customer_item_mapping', entityId: id == null ? null : String(id),
      sourceKey: sourceName, before, after, reason,
      ipAddress: req.ip, userAgent: req.get('user-agent')
    });
  };

  app.get('/api/sales-workflow/customer-items', async (req, res, next) => {
    try {
      const sourceName = sourceDbFromRequest(req);
      const source = sourceDatabases[sourceName];
      if (source?.adapter_code !== 'ism-sh') throw badRequest('目前客戶品號查詢只適用 iSM 銷售來源');
      const sourcePool = getSourcePool(sourceName);
      const [tableRows] = await sourcePool.query(
        "SELECT LOWER(TABLE_NAME) AS table_name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND LOWER(TABLE_NAME) IN ('copmb','copma','invmb')"
      );
      const tables = new Set(tableRows.map(row => String(row.table_name).toLowerCase()));
      if (!tables.has('copmb')) {
        return res.json({ ok:true, data:[], source:sourceName + '.COPMB', warning:'目前公司來源沒有 COPMB 客戶品號資料' });
      }

      const companyCode = String(source.company_id || sourceName).trim();
      const customerCode = trim(req.query.customer_code);
      const itemCode = trim(req.query.item_code);
      const keyword = trim(req.query.keyword);
      const requestedDate = trim(req.query.as_of_date);
      const asOfDate = requestedDate ? validDate(requestedDate).replace(/-/g, '') : null;
      const activeOnly = String(req.query.active_only ?? '1') !== '0';
      const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
      const where = ['TRIM(b.COMPANY)=?'];
      const params = [companyCode];
      const statusParams = [];
      if (customerCode) {
        where.push('TRIM(b.MB001) LIKE ?');
        params.push('%' + customerCode + '%');
      }
      if (itemCode) {
        where.push('TRIM(b.MB002) LIKE ?');
        params.push('%' + itemCode + '%');
      }
      const keywordFields = ['b.MB001', 'b.MB002'];
      if (tables.has('copma')) keywordFields.push('c.MA002', 'c.MA003');
      if (tables.has('invmb')) keywordFields.push('i.MB002', 'i.MB003');
      if (keyword) {
        where.push(`CONCAT_WS(' ',${keywordFields.join(',')}) LIKE ?`);
        params.push('%' + keyword + '%');
      }
      if (activeOnly && asOfDate) {
        where.push("NULLIF(TRIM(b.MB017),'')<=? AND (NULLIF(TRIM(b.MB018),'') IS NULL OR NULLIF(TRIM(b.MB018),'')>=?)");
        params.push(asOfDate, asOfDate);
      }

      const customerJoin = tables.has('copma')
        ? " LEFT JOIN copma c ON c.COMPANY=b.COMPANY AND TRIM(c.MA001)=TRIM(b.MB001)"
        : '';
      const itemJoin = tables.has('invmb')
        ? " LEFT JOIN invmb i ON i.COMPANY=b.COMPANY AND TRIM(i.MB001)=TRIM(b.MB002)"
        : '';
      const customerName = tables.has('copma')
        ? "COALESCE(NULLIF(TRIM(c.MA003),''),NULLIF(TRIM(c.MA002),''))"
        : 'NULL';
      const itemName = tables.has('invmb') ? "NULLIF(TRIM(i.MB002),'')" : 'NULL';
      const itemSpecification = tables.has('invmb') ? "NULLIF(TRIM(i.MB003),'')" : 'NULL';
      const itemUnit = tables.has('invmb') ? "NULLIF(TRIM(i.MB004),'')" : 'NULL';
      let effectiveStatus = "'未套用基準日'";
      if (asOfDate) {
        effectiveStatus = "CASE WHEN NULLIF(TRIM(b.MB017),'') IS NULL THEN '未設定生效日' WHEN TRIM(b.MB017)>? THEN '尚未生效' WHEN NULLIF(TRIM(b.MB018),'') IS NOT NULL AND TRIM(b.MB018)<? THEN '已失效' ELSE '有效' END";
        statusParams.push(asOfDate, asOfDate);
      }
      const sql = "SELECT TRIM(b.MB001) AS customer_code," +
        customerName + " AS customer_name," +
        "TRIM(b.MB002) AS item_code," +
        itemName + " AS item_name," +
        itemSpecification + " AS specification," +
        "NULLIF(TRIM(b.MB003),'') AS pricing_unit," +
        itemUnit + " AS item_unit," +
        "NULLIF(TRIM(b.MB004),'') AS currency_code," +
        "b.MB008 AS unit_price," +
        "NULLIF(TRIM(b.MB007),'') AS quantity_pricing_flag," +
        "NULLIF(TRIM(b.MB013),'') AS tax_included," +
        "NULLIF(TRIM(b.MB019),'') AS trade_condition," +
        "NULLIF(TRIM(b.MB017),'') AS effective_from," +
        "NULLIF(TRIM(b.MB018),'') AS effective_to," +
        effectiveStatus + " AS effective_status," +
        (tables.has('invmb') ? "CASE WHEN i.MB001 IS NULL THEN 0 ELSE 1 END" : "0") + " AS item_master_match," +
        "b.COMPANY AS source_company," +
        "'COPMB' AS source_table," +
        "CONCAT(TRIM(b.COMPANY),':COPMB:',TRIM(b.MB001),':',TRIM(b.MB002),':',TRIM(b.MB017),':',TRIM(b.MB018),':',TRIM(b.CREATE_DATE),':',TRIM(b.CREATOR),':',b.FLAG) AS source_key " +
        "FROM copmb b" + customerJoin + itemJoin +
        " WHERE " + where.join(' AND ') +
        " ORDER BY TRIM(b.MB001),TRIM(b.MB002),TRIM(b.MB017) DESC,b.FLAG DESC LIMIT ?";
      const [rows] = await sourcePool.query(sql, [...statusParams, ...params, limit]);
      const data = rows.map(row => ({
        ...row,
        source_database: sourceName,
        source_label: source.label,
        target_database: source.target_database,
        company_id: source.company_id
      }));
      res.json({ ok:true, data, source:sourceName + '.COPMB', source_read_only:Boolean(source.read_only) });
    } catch (error) { next(error); }
  });

  app.get('/api/sales-workflow/customer-item-mappings', async (req, res, next) => {
    try {
      await ensureTargetSalesCustomerItemSchema();
      const { sourceName, source, context } = contextForRequest(req);
      const customerCode = trim(req.query.customer_code);
      const externalItemCode = trim(req.query.external_item_code);
      const itemCode = trim(req.query.item_code);
      const keyword = trim(req.query.keyword);
      const asOfDate = trim(req.query.as_of_date) ? validDate(req.query.as_of_date) : null;
      const activeOnly = String(req.query.active_only ?? '1') !== '0';
      const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
      const where = [
        'm.tenant_id=?', 'm.company_id=?', 'm.source_system=?', 'm.source_database=?'
      ];
      const params = [context.tenant_id, context.company_id, context.source_system, context.source_database];
      if (customerCode) { where.push('m.customer_code LIKE ?'); params.push(`%${customerCode}%`); }
      if (externalItemCode) { where.push('m.external_item_code LIKE ?'); params.push(`%${externalItemCode}%`); }
      if (itemCode) { where.push('m.item_code LIKE ?'); params.push(`%${itemCode}%`); }
      if (keyword) {
        where.push(`CONCAT_WS(' ',m.customer_code,m.customer_name,m.external_item_code,m.external_item_name,
          m.external_specification,m.item_code,m.item_name,m.specification) LIKE ?`);
        params.push(`%${keyword}%`);
      }
      if (activeOnly) where.push('m.is_active=1');
      if (asOfDate) {
        where.push("m.effective_from<=? AND (m.effective_to IS NULL OR m.effective_to>=?)");
        params.push(asOfDate, asOfDate);
      }
      const [rows] = await pool.query(`SELECT m.*,
        c.customer_name AS current_customer_name,
        i.item_name AS current_item_name, i.specification AS current_specification, i.unit AS current_unit,
        (SELECT COUNT(*) FROM erp_customer_item_mapping_events e WHERE e.mapping_id=m.id
          AND e.tenant_id=m.tenant_id AND e.company_id=m.company_id AND e.source_system=m.source_system
          AND e.source_database=m.source_database) AS event_count
        FROM erp_customer_item_mappings m
        LEFT JOIN erp_customers c ON c.tenant_id=m.tenant_id AND c.company_id=m.company_id
          AND c.source_system=m.source_system AND c.source_database=m.source_database AND c.customer_code=m.customer_code
        LEFT JOIN erp_items i ON i.tenant_id=m.tenant_id AND i.company_id=m.company_id
          AND i.source_system=m.source_system AND i.source_database=m.source_database AND i.item_code=m.item_code
        WHERE ${where.join(' AND ')}
        ORDER BY m.customer_code,m.external_item_code,m.effective_from DESC,m.id DESC LIMIT ?`, [...params, limit]);
      const data = rows.map(row => ({
        ...row,
        customer_name: trim(row.current_customer_name) || trim(row.customer_name),
        item_name: trim(row.current_item_name) || trim(row.item_name),
        specification: row.current_specification ?? row.specification,
        unit: row.current_unit ?? row.unit,
        effective_from: rowDate(row.effective_from),
        effective_to: rowDate(row.effective_to),
        effective_status: effectiveStatus(row, asOfDate),
        source_database: sourceName,
        source_label: source.label,
        target_database: source.target_database,
        company_id: source.company_id,
        record_type: 'managed',
        source_read_only: Boolean(source.read_only)
      }));
      res.json({ ok:true, data });
    } catch (error) { next(error); }
  });

  app.get('/api/sales-workflow/customer-item-mappings/:id/events', async (req, res, next) => {
    try {
      await ensureTargetSalesCustomerItemSchema();
      const { context } = contextForRequest(req);
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) throw badRequest('客戶品號資料編號錯誤');
      const [[mapping]] = await pool.query(`SELECT id FROM erp_customer_item_mappings
        WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=?`,
        [id, context.tenant_id, context.company_id, context.source_system, context.source_database]);
      if (!mapping) throw notFound('找不到目前公司別的客戶品號資料');
      const [events] = await pool.query(`SELECT id,mapping_id,event_kind,before_json,after_json,reason,changed_by,created_at
        FROM erp_customer_item_mapping_events
        WHERE mapping_id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=?
        ORDER BY id DESC`, [id, context.tenant_id, context.company_id, context.source_system, context.source_database]);
      res.json({ ok:true, data:events });
    } catch (error) { next(error); }
  });

  app.post('/api/sales-workflow/customer-item-mappings', async (req, res, next) => {
    try {
      await ensureTargetSalesCustomerItemSchema();
      const { sourceName, source, context } = contextForRequest(req);
      const body = req.body || {};
      const reason = bounded(body.reason, '異動原因', 500) || '建立客戶品號對照';
      const out = await tx(async conn => {
        const input = await mappingInput(conn, context, body);
        await assertNoActiveOverlap(conn, context, input);
        const [result] = await conn.query(`INSERT INTO erp_customer_item_mappings
          (tenant_id,company_id,source_system,source_database,customer_id,customer_code,customer_name,
           external_item_code,external_item_name,external_specification,item_id,item_code,item_name,specification,unit,
           effective_from,effective_to,is_active,note,source_table,source_key,created_by,updated_by)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
          context.tenant_id, context.company_id, context.source_system, context.source_database,
          input.customer.id, input.customerCode, input.customer.customer_name,
          input.externalItemCode, input.externalItemName, input.externalSpecification,
          input.item.id, input.itemCode, input.item.item_name, input.item.specification || null, input.item.unit || null,
          input.effectiveFrom, input.effectiveTo, input.isActive, input.note, 'manual', null,
          req.auth?.id || null, req.auth?.id || null
        ]);
        const id = Number(result.insertId);
        await conn.query('UPDATE erp_customer_item_mappings SET source_key=? WHERE id=?', [`MANUAL:${id}`, id]);
        const [[after]] = await conn.query('SELECT * FROM erp_customer_item_mappings WHERE id=? FOR UPDATE', [id]);
        await insertMappingEvent(conn, id, context, 'created', null, mappingSnapshot(after), reason, req.auth?.id);
        return { id, mapping: mappingSnapshot(after) };
      });
      await auditMapping(req, sourceName, 'CUSTOMER_ITEM_MAPPING_CREATED', out.id, null, out.mapping, reason);
      res.status(201).json({ ok:true, data:{ ...out, target_database:source.target_database, company_id:source.company_id } });
    } catch (error) { next(error); }
  });

  app.put('/api/sales-workflow/customer-item-mappings/:id', async (req, res, next) => {
    try {
      await ensureTargetSalesCustomerItemSchema();
      const { sourceName, source, context } = contextForRequest(req);
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) throw badRequest('客戶品號資料編號錯誤');
      const body = req.body || {};
      const reason = bounded(body.reason, '異動原因', 500) || '修改客戶品號對照';
      const out = await tx(async conn => {
        const [[beforeRow]] = await conn.query(`SELECT * FROM erp_customer_item_mappings
          WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? FOR UPDATE`,
          [id, context.tenant_id, context.company_id, context.source_system, context.source_database]);
        if (!beforeRow) throw notFound('找不到目前公司別的客戶品號資料');
        const before = mappingSnapshot(beforeRow);
        const input = await mappingInput(conn, context, body, beforeRow);
        await assertNoActiveOverlap(conn, context, input, id);
        await conn.query(`UPDATE erp_customer_item_mappings SET
          customer_id=?,customer_code=?,customer_name=?,external_item_code=?,external_item_name=?,external_specification=?,
          item_id=?,item_code=?,item_name=?,specification=?,unit=?,effective_from=?,effective_to=?,is_active=?,note=?,updated_by=?
          WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=?`, [
          input.customer.id, input.customerCode, input.customer.customer_name,
          input.externalItemCode, input.externalItemName, input.externalSpecification,
          input.item.id, input.itemCode, input.item.item_name, input.item.specification || null, input.item.unit || null,
          input.effectiveFrom, input.effectiveTo, input.isActive, input.note, req.auth?.id || null,
          id, context.tenant_id, context.company_id, context.source_system, context.source_database
        ]);
        const [[afterRow]] = await conn.query('SELECT * FROM erp_customer_item_mappings WHERE id=? FOR UPDATE', [id]);
        const after = mappingSnapshot(afterRow);
        await insertMappingEvent(conn, id, context, 'updated', before, after, reason, req.auth?.id);
        return { id, before, mapping:after };
      });
      await auditMapping(req, sourceName, 'CUSTOMER_ITEM_MAPPING_UPDATED', out.id, out.before, out.mapping, reason);
      res.json({ ok:true, data:{ ...out, target_database:source.target_database, company_id:source.company_id } });
    } catch (error) { next(error); }
  });

  app.delete('/api/sales-workflow/customer-item-mappings/:id', async (req, res, next) => {
    try {
      await ensureTargetSalesCustomerItemSchema();
      const { sourceName, source, context } = contextForRequest(req);
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) throw badRequest('客戶品號資料編號錯誤');
      const reason = bounded(req.body?.reason, '停用原因', 500) || '停用客戶品號對照';
      const out = await tx(async conn => {
        const [[beforeRow]] = await conn.query(`SELECT * FROM erp_customer_item_mappings
          WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? FOR UPDATE`,
          [id, context.tenant_id, context.company_id, context.source_system, context.source_database]);
        if (!beforeRow) throw notFound('找不到目前公司別的客戶品號資料');
        const before = mappingSnapshot(beforeRow);
        if (!before.is_active) return { id, before, mapping:before, alreadyInactive:true };
        await conn.query(`UPDATE erp_customer_item_mappings SET is_active=0,updated_by=?
          WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=?`, [
          req.auth?.id || null, id, context.tenant_id, context.company_id, context.source_system, context.source_database
        ]);
        const [[afterRow]] = await conn.query('SELECT * FROM erp_customer_item_mappings WHERE id=? FOR UPDATE', [id]);
        const after = mappingSnapshot(afterRow);
        await insertMappingEvent(conn, id, context, 'deactivated', before, after, reason, req.auth?.id);
        return { id, before, mapping:after, alreadyInactive:false };
      });
      if (!out.alreadyInactive) await auditMapping(req, sourceName, 'CUSTOMER_ITEM_MAPPING_DEACTIVATED', out.id, out.before, out.mapping, reason);
      res.json({ ok:true, data:{ ...out, target_database:source.target_database, company_id:source.company_id, message:out.alreadyInactive?'資料原已停用，未重複建立事件':'資料已停用；保留歷程，不執行實體刪除' } });
    } catch (error) { next(error); }
  });
}

const SALES_PRICING_EPS = 0.000001;

function salesPricingContextForDatabase(db) {
  const sourceName = String(db || '').trim().toUpperCase();
  const source = sourceDatabases[sourceName];
  if (!source) throw badRequest(`找不到資料來源：${sourceName}`);
  if (source.adapter_code !== 'ism-sh') throw badRequest('目前客戶產品計價作業只適用 iSM 銷售來源');
  return {
    sourceName,
    source,
    context: {
      tenant_id: source.tenant_id || 'default',
      company_id: source.company_id || sourceName,
      source_system: source.source_system || 'iSM',
      source_database: sourceName
    }
  };
}

function pricingBoolean(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  if ([1, true, '1', 'true', 'TRUE', 'Y', 'y', 'yes', 'on'].includes(value)) return 1;
  if ([0, false, '0', 'false', 'FALSE', 'N', 'n', 'no', 'off'].includes(value)) return 0;
  throw badRequest('布林設定只能是 0／1 或 Y／N');
}

function pricingNumber(value, label, { required = false, min = null, max = null } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') {
    if (required) throw badRequest(`${label}為必填`);
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) throw badRequest(`${label}必須是數字`);
  if (min !== null && number < min - SALES_PRICING_EPS) throw badRequest(`${label}不可小於 ${min}`);
  if (max !== null && number > max + SALES_PRICING_EPS) throw badRequest(`${label}不可大於 ${max}`);
  return number;
}

function pricingText(value, label, max, required = false) {
  const text = trim(value);
  if (required && !text) throw badRequest(`${label}為必填`);
  if (text.length > max) throw badRequest(`${label}不可超過 ${max} 個字元`);
  return text || null;
}

function pricingDate(value, label, required = false) {
  if (value === undefined || value === null || String(value).trim() === '') {
    if (required) throw badRequest(`${label}為必填`);
    return null;
  }
  return validDate(value);
}

function pricingEffectiveStatus(row, asOfDate = null) {
  if (String(row.status || '') === 'voided' || !Number(row.is_active ?? 1)) return '已作廢／停用';
  if (String(row.status || '') === 'draft') return '待核准';
  if (!asOfDate) return '已核准';
  const from = dateText(row.effective_from), to = dateText(row.effective_to);
  if (from && asOfDate < from) return '尚未生效';
  if (to && asOfDate > to) return '已失效';
  return '有效';
}

function salesPricingSnapshot(row, tiers = []) {
  if (!row) return null;
  const discount = row.discount_rate === null || row.discount_rate === undefined ? null : Number(row.discount_rate);
  return {
    id: Number(row.id), customer_code: trim(row.customer_code), item_code: trim(row.item_code),
    pricing_unit: trim(row.pricing_unit), currency_code: trim(row.currency_code),
    unit_price: Number(row.unit_price || 0), discount_rate: discount,
    discount_rate_percent: discount === null ? null : discount * 100,
    tax_included: Number(row.tax_included) ? 1 : 0,
    quantity_pricing_flag: Number(row.quantity_pricing_flag) ? 1 : 0,
    trade_condition: trim(row.trade_condition), effective_from: dateText(row.effective_from) || null,
    effective_to: dateText(row.effective_to) || null, status: trim(row.status), is_active: Number(row.is_active) ? 1 : 0,
    source_kind: trim(row.source_kind), source_document_id: row.source_document_id == null ? null : Number(row.source_document_id),
    source_document_no: trim(row.source_document_no) || null, source_document_type: trim(row.source_document_type) || null,
    source_table: trim(row.source_table), source_key: trim(row.source_key) || null, note: trim(row.note) || null,
    tiers: tiers.map(tier => ({
      id: Number(tier.id), line_no: Number(tier.line_no), quantity_from: Number(tier.quantity_from || 0),
      unit_price: tier.unit_price === null || tier.unit_price === undefined ? null : Number(tier.unit_price),
      discount_rate: tier.discount_rate === null || tier.discount_rate === undefined ? null : Number(tier.discount_rate),
      discount_rate_percent: tier.discount_rate === null || tier.discount_rate === undefined ? null : Number(tier.discount_rate) * 100,
      note: trim(tier.note) || null
    }))
  };
}

async function lookupTargetSalesPrice(conn, context, input = {}) {
  const customerCode = trim(input.customer_code);
  const itemCode = trim(input.item_code);
  const pricingUnit = trim(input.pricing_unit || input.unit || 'PCS');
  const currencyCode = trim(input.currency_code || 'TWD');
  const documentDate = pricingDate(input.document_date || input.as_of_date, '計價基準日', true);
  const quantity = pricingNumber(input.quantity ?? 0, '數量', { min: 0 }) ?? 0;
  if (!customerCode || !itemCode) return null;
  const [[price]] = await conn.query(`SELECT p.* FROM erp_customer_item_prices p
    WHERE p.tenant_id=? AND p.company_id=? AND p.source_system=? AND p.source_database=?
      AND p.customer_code=? AND p.item_code=? AND p.pricing_unit=? AND p.currency_code=?
      AND p.status='approved' AND p.is_active=1 AND p.effective_from<=?
      AND (p.effective_to IS NULL OR p.effective_to>=?)
    ORDER BY p.effective_from DESC,p.id DESC LIMIT 1`, [
    context.tenant_id, context.company_id, context.source_system, context.source_database,
    customerCode, itemCode, pricingUnit, currencyCode, documentDate, documentDate
  ]);
  if (!price) return null;
  let tier = null;
  if (Number(price.quantity_pricing_flag)) {
    [[tier]] = await conn.query(`SELECT * FROM erp_customer_item_price_tiers
      WHERE pricing_id=? AND quantity_from<=? ORDER BY quantity_from DESC,id DESC LIMIT 1`, [price.id, quantity]);
  }
  const baseDiscount = price.discount_rate === null || price.discount_rate === undefined ? null : Number(price.discount_rate);
  const applyDiscount = (unitPrice, discountRate) => Number(unitPrice || 0) * (discountRate === null ? 1 : Math.max(0, 1 - discountRate));
  let appliedUnitPrice = applyDiscount(price.unit_price, baseDiscount);
  let discountRate = baseDiscount;
  if (tier) {
    discountRate = tier.discount_rate === null || tier.discount_rate === undefined ? baseDiscount : Number(tier.discount_rate);
    appliedUnitPrice = tier.unit_price === null || tier.unit_price === undefined
      ? applyDiscount(price.unit_price, discountRate)
      : Number(tier.unit_price || 0);
  }
  return {
    price_rule_id: Number(price.id), price_tier_id: tier ? Number(tier.id) : null,
    unit_price: appliedUnitPrice, base_unit_price: Number(price.unit_price || 0),
    discount_rate: discountRate, discount_rate_percent: discountRate === null ? null : discountRate * 100,
    pricing_unit: trim(price.pricing_unit), currency_code: trim(price.currency_code),
    tax_included: Number(price.tax_included) ? 1 : 0, trade_condition: trim(price.trade_condition),
    effective_from: dateText(price.effective_from), effective_to: dateText(price.effective_to) || null,
    price_source_kind: 'customer_price', price_source_id: Number(price.id),
    price_source_no: trim(price.source_document_no) || trim(price.source_key) || `PRICE:${price.id}`,
    price_source_date: dateText(price.effective_from), source_kind: trim(price.source_kind),
    source_document_id: price.source_document_id == null ? null : Number(price.source_document_id),
    source_document_no: trim(price.source_document_no) || null
  };
}

async function insertSalesPricingEvent(conn, pricingId, context, eventKind, before, after, reason, userId) {
  await conn.query(`INSERT INTO erp_customer_item_price_events
    (pricing_id,tenant_id,company_id,source_system,source_database,event_kind,before_json,after_json,reason,changed_by)
    VALUES(?,?,?,?,?,?,?,?,?,?)`, [
    pricingId, context.tenant_id, context.company_id, context.source_system, context.source_database,
    eventKind, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after),
    String(reason || eventKind).slice(0, 500), Number.isInteger(Number(userId)) ? Number(userId) : null
  ]);
}

function previousPricingDate(value) {
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

async function upsertSalesPriceFromDocument(conn, context, document, item, userId, reason = '銷售單據核准回寫客戶產品計價') {
  if (!['quotation', 'sales_order', 'shipment'].includes(String(document.document_kind))) return { action:'skipped', reason:'此單據類型不回寫客戶產品計價' };
  const customerCode = pricingText(document.customer_code, '客戶代號', 30, true);
  const itemCode = pricingText(item.item_code, '品號', 40, true);
  const pricingUnit = pricingText(item.unit, '計價單位', 20, true);
  const currencyCode = pricingText(document.currency_code, '幣別', 10, true);
  const effectiveFrom = pricingDate(document.document_date, '單據日期', true);
  const unitPrice = pricingNumber(item.unit_price, '單價', { required:true, min:0 });
  const [[customer]] = await conn.query(`SELECT id FROM erp_customers
    WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND customer_code=? LIMIT 1`, [
    context.tenant_id, context.company_id, context.source_system, context.source_database, customerCode
  ]);
  const [[erpItem]] = await conn.query(`SELECT id FROM erp_items
    WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND item_code=? LIMIT 1`, [
    context.tenant_id, context.company_id, context.source_system, context.source_database, itemCode
  ]);
  if (!customer) throw badRequest(`找不到目前公司別的客戶主檔：${customerCode}`);
  if (!erpItem) throw badRequest(`找不到目前公司別的品號主檔：${itemCode}`);
  const [[currency]] = await conn.query(`SELECT currency_code FROM erp_currencies
    WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND currency_code=? LIMIT 1`, [
    context.tenant_id, context.company_id, context.source_system, context.source_database, currencyCode
  ]);
  if (!currency) throw badRequest(`目前公司尚未建立幣別主檔：${currencyCode}`);
  const [[mapping]] = await conn.query(`SELECT id FROM erp_customer_item_mappings
    WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=?
      AND customer_code=? AND item_code=? AND is_active=1 AND effective_from<=?
      AND (effective_to IS NULL OR effective_to>=?) ORDER BY effective_from DESC,id DESC LIMIT 1`, [
    context.tenant_id, context.company_id, context.source_system, context.source_database,
    customerCode, itemCode, effectiveFrom, effectiveFrom
  ]);
  const [[latest]] = await conn.query(`SELECT * FROM erp_customer_item_prices
    WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=?
      AND customer_code=? AND item_code=? AND pricing_unit=? AND currency_code=?
      AND status='approved' AND is_active=1 AND effective_from<=?
      AND (effective_to IS NULL OR effective_to>=?)
    ORDER BY effective_from DESC,id DESC LIMIT 1 FOR UPDATE`, [
    context.tenant_id, context.company_id, context.source_system, context.source_database,
    customerCode, itemCode, pricingUnit, currencyCode, effectiveFrom, effectiveFrom
  ]);
  if (latest && dateText(latest.effective_from) >= effectiveFrom) {
    return { action:'skipped', reason:`單據日期 ${effectiveFrom} 不晚於既有生效版本 ${dateText(latest.effective_from)}，保留既有價格`, pricing_id:Number(latest.id) };
  }
  const [[sameDate]] = await conn.query(`SELECT * FROM erp_customer_item_prices
    WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=?
      AND customer_code=? AND item_code=? AND pricing_unit=? AND currency_code=? AND effective_from=?
    LIMIT 1 FOR UPDATE`, [
    context.tenant_id, context.company_id, context.source_system, context.source_database,
    customerCode, itemCode, pricingUnit, currencyCode, effectiveFrom
  ]);
  if (sameDate) return { action:'skipped', reason:`已有 ${effectiveFrom} 的計價版本（${sameDate.status}），不直接覆蓋既有紀錄`, pricing_id:Number(sameDate.id) };
  if (latest) {
    const before = salesPricingSnapshot(latest);
    const closedTo = previousPricingDate(effectiveFrom);
    await conn.query(`UPDATE erp_customer_item_prices SET effective_to=?,updated_by=?
      WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=?`, [
      closedTo, userId || null, latest.id, context.tenant_id, context.company_id, context.source_system, context.source_database
    ]);
    const [[afterPrevious]] = await conn.query('SELECT * FROM erp_customer_item_prices WHERE id=? FOR UPDATE', [latest.id]);
    await insertSalesPricingEvent(conn, latest.id, context, 'superseded', before, salesPricingSnapshot(afterPrevious), reason, userId);
  }
  const [result] = await conn.query(`INSERT INTO erp_customer_item_prices
    (tenant_id,company_id,source_system,source_database,customer_id,customer_code,mapping_id,item_id,item_code,
     pricing_unit,currency_code,unit_price,discount_rate,tax_included,quantity_pricing_flag,trade_condition,
     effective_from,effective_to,status,is_active,source_kind,source_document_id,source_document_no,source_document_type,
     source_table,source_key,note,created_by,updated_by,approved_by,approved_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    context.tenant_id, context.company_id, context.source_system, context.source_database,
    customer.id, customerCode, mapping?.id || null, erpItem.id, itemCode, pricingUnit, currencyCode, unitPrice, null,
    0, 0, '1', effectiveFrom, null, 'approved', 1, document.document_kind, document.id || null,
    document.document_no || null, document.document_type || null, 'sales_documents',
    `SALES:${document.id || 'NEW'}:${item.id || 'LINE'}`, reason, userId || null, userId || null, userId || null, new Date()
  ]);
  const id = Number(result.insertId);
  const [[after]] = await conn.query('SELECT * FROM erp_customer_item_prices WHERE id=? FOR UPDATE', [id]);
  await insertSalesPricingEvent(conn, id, context, 'created_from_document', null, salesPricingSnapshot(after), reason, userId);
  return { action:'created', pricing_id:id, effective_from:effectiveFrom, unit_price:unitPrice };
}

function registerSalesCustomerPricingRoutes(app) {
  const contextForRequest = req => salesPricingContextForDatabase(sourceDbFromRequest(req));
  const currentWhere = context => [
    'p.tenant_id=?', 'p.company_id=?', 'p.source_system=?', 'p.source_database=?'
  ];
  const contextParams = context => [context.tenant_id, context.company_id, context.source_system, context.source_database];
  const pricingInput = async (conn, context, body, current = null) => {
    const value = (key, fallback = null) => Object.prototype.hasOwnProperty.call(body, key) ? body[key] : current?.[key] ?? fallback;
    const customerCode = pricingText(value('customer_code'), '客戶代號', 30, true);
    const itemCode = pricingText(value('item_code'), '品號', 40, true);
    const pricingUnit = pricingText(value('pricing_unit', value('unit', 'PCS')), '計價單位', 20, true);
    const currencyCode = pricingText(value('currency_code', 'TWD'), '幣別', 10, true);
    const unitPrice = pricingNumber(value('unit_price'), '單價', { required:true, min:0 });
    const discountPercent = pricingNumber(value('discount_rate_pct', current?.discount_rate == null ? null : Number(current.discount_rate) * 100), '折扣率（%）', { min:0, max:100 });
    const discountRate = discountPercent === null ? null : discountPercent / 100;
    const effectiveFrom = pricingDate(value('effective_from'), '生效日', true);
    const effectiveTo = pricingDate(value('effective_to'), '失效日');
    if (effectiveTo && effectiveTo < effectiveFrom) throw badRequest('失效日不可早於生效日');
    const taxIncluded = pricingBoolean(value('tax_included', current?.tax_included ?? 0));
    const quantityPricing = pricingBoolean(value('quantity_pricing_flag', current?.quantity_pricing_flag ?? 0));
    const tradeCondition = pricingText(value('trade_condition', '1'), '交易條件', 10, true);
    const note = pricingText(value('note'), '備註', 500);
    const [[customer]] = await conn.query(`SELECT id,customer_code,customer_name FROM erp_customers
      WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND customer_code=? LIMIT 1`, [
      context.tenant_id, context.company_id, context.source_system, context.source_database, customerCode
    ]);
    const [[item]] = await conn.query(`SELECT id,item_code,item_name,specification,unit FROM erp_items
      WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND item_code=? LIMIT 1`, [
      context.tenant_id, context.company_id, context.source_system, context.source_database, itemCode
    ]);
    if (!customer) throw badRequest(`找不到目前公司別的客戶主檔：${customerCode}`);
    if (!item) throw badRequest(`找不到目前公司別的品號主檔：${itemCode}`);
    const [[currency]] = await conn.query(`SELECT currency_code FROM erp_currencies
      WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND currency_code=? LIMIT 1`, [
      context.tenant_id, context.company_id, context.source_system, context.source_database, currencyCode
    ]);
    if (!currency) throw badRequest(`目前公司尚未建立幣別主檔：${currencyCode}，請先維護幣別主檔`);
    let mappingId = Number(value('mapping_id') || 0) || null;
    if (mappingId) {
      const [[mapping]] = await conn.query(`SELECT id,customer_code,item_code FROM erp_customer_item_mappings
        WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? LIMIT 1`, [
        mappingId, context.tenant_id, context.company_id, context.source_system, context.source_database
      ]);
      if (!mapping || mapping.customer_code !== customerCode || mapping.item_code !== itemCode) throw badRequest('客戶品號對照必須屬於同公司、同客戶與同品號');
    } else {
      const [[mapping]] = await conn.query(`SELECT id FROM erp_customer_item_mappings
        WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=?
          AND customer_code=? AND item_code=? AND is_active=1 AND effective_from<=?
          AND (effective_to IS NULL OR effective_to>=?) ORDER BY effective_from DESC,id DESC LIMIT 1`, [
        context.tenant_id, context.company_id, context.source_system, context.source_database,
        customerCode, itemCode, effectiveFrom, effectiveFrom
      ]);
      mappingId = mapping?.id || null;
    }
    const rawTiers = value('tiers', []);
    if (rawTiers !== undefined && !Array.isArray(rawTiers)) throw badRequest('分量計價明細格式錯誤');
    const tiers = (rawTiers || []).map((tier, index) => {
      const quantityFrom = pricingNumber(tier.quantity_from, `第 ${index + 1} 筆數量以上`, { required:true, min:0 });
      const tierUnitPrice = pricingNumber(tier.unit_price, `第 ${index + 1} 筆分量單價`, { min:0 });
      const tierDiscountPercent = pricingNumber(tier.discount_rate_pct, `第 ${index + 1} 筆分量折扣率（%）`, { min:0, max:100 });
      if (tierUnitPrice === null && tierDiscountPercent === null) throw badRequest(`第 ${index + 1} 筆分量計價請輸入單價或折扣率`);
      return {
        line_no: index + 1, quantity_from: quantityFrom, unit_price: tierUnitPrice,
        discount_rate: tierDiscountPercent === null ? null : tierDiscountPercent / 100,
        note: pricingText(tier.note, `第 ${index + 1} 筆分量備註`, 500)
      };
    });
    const seen = new Set();
    for (const tier of tiers) {
      const key = String(tier.quantity_from);
      if (seen.has(key)) throw badRequest('分量計價的數量以上不可重複');
      seen.add(key);
    }
    if (!quantityPricing && tiers.length) throw badRequest('未啟用分量計價時不可輸入分量明細');
    if (quantityPricing && !tiers.length) throw badRequest('啟用分量計價時至少要有一筆分量明細');
    return { customer, item, customerCode, itemCode, pricingUnit, currencyCode, unitPrice, discountRate,
      taxIncluded, quantityPricing, tradeCondition, effectiveFrom, effectiveTo, note, mappingId, tiers };
  };
  const assertNoApprovedOverlap = async (conn, context, input, excludeId = null) => {
    const params = [context.tenant_id, context.company_id, context.source_system, context.source_database,
      input.customerCode, input.itemCode, input.pricingUnit, input.currencyCode, input.effectiveTo, input.effectiveFrom];
    let exclude = '';
    if (excludeId) { exclude = ' AND id<>?'; params.push(excludeId); }
    const [[row]] = await conn.query(`SELECT id,effective_from,effective_to FROM erp_customer_item_prices
      WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=?
        AND customer_code=? AND item_code=? AND pricing_unit=? AND currency_code=?
        AND status='approved' AND is_active=1
        AND effective_from<=COALESCE(?, '9999-12-31')
        AND COALESCE(effective_to,'9999-12-31')>=?${exclude}
      ORDER BY effective_from,id LIMIT 1 FOR UPDATE`, params);
    if (row) throw badRequest(`同一客戶／品號／計價單位／幣別的核准有效期間重疊（${dateText(row.effective_from)}～${dateText(row.effective_to) || '永久'}）`);
  };
  const loadPrice = async (conn, context, id, lock = false) => {
    const [[row]] = await conn.query(`SELECT p.* FROM erp_customer_item_prices p
      WHERE p.id=? AND p.tenant_id=? AND p.company_id=? AND p.source_system=? AND p.source_database=?
      LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [id, context.tenant_id, context.company_id, context.source_system, context.source_database]);
    if (!row) throw notFound('找不到目前公司別的客戶產品計價');
    const [tiers] = await conn.query('SELECT * FROM erp_customer_item_price_tiers WHERE pricing_id=? ORDER BY quantity_from,line_no,id', [id]);
    return { row, tiers };
  };

  app.get('/api/sales-workflow/customer-pricing/lookup', async (req, res, next) => {
    try {
      await ensureTargetSalesPricingSchema();
      const { sourceName, context } = contextForRequest(req);
      await syncCanonicalMaster(sourceName, 'currencies');
      const data = await lookupTargetSalesPrice(pool, context, req.query);
      res.json({ ok:true, data: data ? { ...data, company_id:context.company_id, source_database:context.source_database } : null,
        message: data ? '已找到目前公司有效計價' : '目前公司查無符合日期、客戶、品號、計價單位與幣別的核准計價' });
    } catch (error) { next(error); }
  });

  app.get('/api/sales-workflow/customer-pricing/source', async (req, res, next) => {
    try {
      const { sourceName, source } = contextForRequest(req);
      const sourcePool = getSourcePool(sourceName);
      const [tableRows] = await sourcePool.query(`SELECT LOWER(TABLE_NAME) table_name
        FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND LOWER(TABLE_NAME) IN ('copma','copmb','copmc','invmb')`);
      const tables = new Set(tableRows.map(row => String(row.table_name).toLowerCase()));
      if (!tables.has('copmb')) return res.json({ ok:true, data:{base:[],tiers:[]}, source:`${sourceName}.COPMB`, source_read_only:true, warning:'來源沒有 COPMB' });
      const companyCode = String(source.company_id || sourceName).trim();
      const customerCode = trim(req.query.customer_code), itemCode = trim(req.query.item_code), limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 300);
      const where = ['TRIM(b.COMPANY)=?'], params = [companyCode];
      if (customerCode) { where.push('TRIM(b.MB001) LIKE ?'); params.push(`%${customerCode}%`); }
      if (itemCode) { where.push('TRIM(b.MB002) LIKE ?'); params.push(`%${itemCode}%`); }
      const customerJoin = tables.has('copma') ? "LEFT JOIN copma c ON c.COMPANY=b.COMPANY AND TRIM(c.MA001)=TRIM(b.MB001)" : '';
      const itemJoin = tables.has('invmb') ? "LEFT JOIN invmb i ON i.COMPANY=b.COMPANY AND TRIM(i.MB001)=TRIM(b.MB002)" : '';
      const [base] = await sourcePool.query(`SELECT TRIM(b.MB001) customer_code,
          ${tables.has('copma') ? "COALESCE(NULLIF(TRIM(c.MA003),''),NULLIF(TRIM(c.MA002),''))" : 'NULL'} customer_name,
          TRIM(b.MB002) item_code,${tables.has('invmb') ? "NULLIF(TRIM(i.MB002),'')" : 'NULL'} item_name,
          ${tables.has('invmb') ? "NULLIF(TRIM(i.MB003),'')" : 'NULL'} specification,
          NULLIF(TRIM(b.MB003),'') pricing_unit,NULLIF(TRIM(b.MB004),'') currency_code,b.MB008 unit_price,
          NULLIF(TRIM(b.MB007),'') quantity_pricing_flag,NULLIF(TRIM(b.MB013),'') tax_included,
          NULLIF(TRIM(b.MB019),'') trade_condition,NULLIF(TRIM(b.MB017),'') effective_from,
          NULLIF(TRIM(b.MB018),'') effective_to,'COPMB' source_table,
          CONCAT(TRIM(b.COMPANY),':COPMB:',TRIM(b.MB001),':',TRIM(b.MB002),':',TRIM(b.MB017),':',TRIM(b.MB018),':',TRIM(b.CREATE_DATE),':',TRIM(b.CREATOR),':',b.FLAG) source_key
        FROM copmb b ${customerJoin} ${itemJoin} WHERE ${where.join(' AND ')}
        ORDER BY TRIM(b.MB001),TRIM(b.MB002),TRIM(b.MB017) DESC,b.FLAG DESC LIMIT ?`, [...params, limit]);
      let tiers = [];
      if (tables.has('copmc')) {
        const tierWhere = ['TRIM(MC001) LIKE ?'], tierParams = [customerCode ? `%${customerCode}%` : '%'];
        if (itemCode) { tierWhere.push('TRIM(MC002) LIKE ?'); tierParams.push(`%${itemCode}%`); }
        tierWhere.push('TRIM(COMPANY)=?'); tierParams.push(companyCode);
        [tiers] = await sourcePool.query(`SELECT TRIM(MC001) customer_code,TRIM(MC002) item_code,
          NULLIF(TRIM(MC003),'') pricing_unit,NULLIF(TRIM(MC004),'') currency_code,MC005 quantity_from,
          MC006 unit_price,MC007 note,MC008 discount_rate_percent,MC009 effective_from,
          'COPMC' source_table,CONCAT(TRIM(COMPANY),':COPMC:',TRIM(MC001),':',TRIM(MC002),':',TRIM(MC005),':',TRIM(MC009),':',TRIM(MC011)) source_key
          FROM copmc WHERE ${tierWhere.join(' AND ')} ORDER BY TRIM(MC001),TRIM(MC002),MC005 LIMIT ?`, [...tierParams, limit]);
      }
      res.json({ ok:true, data:{
        base:base.map(row => ({ ...row, source_database:sourceName, effective_from:dateText(row.effective_from) || null, effective_to:dateText(row.effective_to) || null })),
        tiers:tiers.map(row => ({ ...row, source_database:sourceName, effective_from:dateText(row.effective_from) || null, discount_rate_percent:row.discount_rate_percent == null ? null : Number(row.discount_rate_percent) }))
      }, source:`${sourceName}.COPMB/COPMC`, source_read_only:Boolean(source.read_only), target_database:source.target_database });
    } catch (error) { next(error); }
  });

  app.get('/api/sales-workflow/customer-pricing', async (req, res, next) => {
    try {
      await ensureTargetSalesPricingSchema();
      const { sourceName, source, context } = contextForRequest(req);
      const conditions = currentWhere(context), params = contextParams(context);
      const customerCode = trim(req.query.customer_code), itemCode = trim(req.query.item_code), currencyCode = trim(req.query.currency_code);
      const keyword = trim(req.query.keyword), status = trim(req.query.status), asOfDate = trim(req.query.as_of_date) ? validDate(req.query.as_of_date) : null;
      const activeOnly = String(req.query.active_only ?? '0') === '1';
      if (customerCode) { conditions.push('p.customer_code LIKE ?'); params.push(`%${customerCode}%`); }
      if (itemCode) { conditions.push('p.item_code LIKE ?'); params.push(`%${itemCode}%`); }
      if (currencyCode) { conditions.push('p.currency_code=?'); params.push(currencyCode); }
      if (status) { conditions.push('p.status=?'); params.push(status); }
      if (keyword) { conditions.push('CONCAT_WS(\' \',p.customer_code,p.item_code,p.pricing_unit,p.currency_code,p.source_kind,p.source_document_no,p.note) LIKE ?'); params.push(`%${keyword}%`); }
      if (activeOnly) conditions.push('p.is_active=1');
      if (asOfDate) { conditions.push("p.effective_from<=? AND (p.effective_to IS NULL OR p.effective_to>=?)"); params.push(asOfDate, asOfDate); }
      const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
      const [rows] = await pool.query(`SELECT p.*,c.customer_name,i.item_name,i.specification,
        (SELECT m.external_item_code FROM erp_customer_item_mappings m WHERE m.tenant_id=p.tenant_id AND m.company_id=p.company_id
          AND m.source_system=p.source_system AND m.source_database=p.source_database AND m.customer_code=p.customer_code AND m.item_code=p.item_code
          AND m.effective_from<=p.effective_from ORDER BY m.effective_from DESC,m.id DESC LIMIT 1) external_item_code,
        (SELECT COUNT(*) FROM erp_customer_item_price_tiers t WHERE t.pricing_id=p.id) tier_count,
        (SELECT COUNT(*) FROM erp_customer_item_price_events e WHERE e.pricing_id=p.id AND e.tenant_id=p.tenant_id AND e.company_id=p.company_id
          AND e.source_system=p.source_system AND e.source_database=p.source_database) event_count
        FROM erp_customer_item_prices p
        LEFT JOIN erp_customers c ON c.tenant_id=p.tenant_id AND c.company_id=p.company_id AND c.source_system=p.source_system
          AND c.source_database=p.source_database AND c.customer_code=p.customer_code
        LEFT JOIN erp_items i ON i.tenant_id=p.tenant_id AND i.company_id=p.company_id AND i.source_system=p.source_system
          AND i.source_database=p.source_database AND i.item_code=p.item_code
        WHERE ${conditions.join(' AND ')} ORDER BY p.customer_code,p.item_code,p.effective_from DESC,p.id DESC LIMIT ?`, [...params, limit]);
      res.json({ ok:true, data:rows.map(row => ({ ...row, source_database:sourceName, source_label:source.label, target_database:source.target_database,
        effective_from:dateText(row.effective_from), effective_to:dateText(row.effective_to) || null,
        effective_status:pricingEffectiveStatus(row, asOfDate), discount_rate_percent:row.discount_rate == null ? null : Number(row.discount_rate) * 100,
        record_type:'managed', source_read_only:Boolean(source.read_only) })) });
    } catch (error) { next(error); }
  });

  app.get('/api/sales-workflow/customer-pricing/:id', async (req, res, next) => {
    try {
      await ensureTargetSalesPricingSchema();
      const { context } = contextForRequest(req); const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) throw badRequest('客戶產品計價編號錯誤');
      const { row, tiers } = await loadPrice(pool, context, id);
      const [events] = await pool.query(`SELECT id,pricing_id,event_kind,before_json,after_json,reason,changed_by,created_at
        FROM erp_customer_item_price_events WHERE pricing_id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? ORDER BY id DESC`, [
        id, context.tenant_id, context.company_id, context.source_system, context.source_database
      ]);
      res.json({ ok:true, data:{ ...salesPricingSnapshot(row, tiers), events } });
    } catch (error) { next(error); }
  });

  app.post('/api/sales-workflow/customer-pricing', async (req, res, next) => {
    try {
      await ensureTargetSalesPricingSchema();
      const { sourceName, source, context } = contextForRequest(req); const body = req.body || {};
      await syncCanonicalMaster(sourceName, 'currencies');
      const reason = pricingText(body.reason, '異動原因', 500) || '建立客戶產品計價';
      const out = await tx(async conn => {
        const input = await pricingInput(conn, context, body);
        const [[same]] = await conn.query(`SELECT id FROM erp_customer_item_prices WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=?
          AND customer_code=? AND item_code=? AND pricing_unit=? AND currency_code=? AND effective_from=? LIMIT 1 FOR UPDATE`, [
          context.tenant_id, context.company_id, context.source_system, context.source_database, input.customerCode, input.itemCode,
          input.pricingUnit, input.currencyCode, input.effectiveFrom
        ]);
        if (same) throw badRequest(`同一客戶／品號／計價單位／幣別已有 ${input.effectiveFrom} 的計價版本，請修改草稿或使用新的生效日`);
        const [result] = await conn.query(`INSERT INTO erp_customer_item_prices
          (tenant_id,company_id,source_system,source_database,customer_id,customer_code,mapping_id,item_id,item_code,pricing_unit,currency_code,
           unit_price,discount_rate,tax_included,quantity_pricing_flag,trade_condition,effective_from,effective_to,status,is_active,source_kind,
           source_table,note,created_by,updated_by)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',1,'manual','manual',?,?,?)`, [
          context.tenant_id, context.company_id, context.source_system, context.source_database, input.customer.id, input.customerCode, input.mappingId,
          input.item.id, input.itemCode, input.pricingUnit, input.currencyCode, input.unitPrice, input.discountRate, input.taxIncluded,
          input.quantityPricing, input.tradeCondition, input.effectiveFrom, input.effectiveTo, input.note, req.auth?.id || null, req.auth?.id || null
        ]);
        const id = Number(result.insertId);
        await conn.query('UPDATE erp_customer_item_prices SET source_key=? WHERE id=?', [`MANUAL:${id}`, id]);
        for (const tier of input.tiers) await conn.query(`INSERT INTO erp_customer_item_price_tiers(pricing_id,line_no,quantity_from,unit_price,discount_rate,note) VALUES(?,?,?,?,?,?)`, [id, tier.line_no, tier.quantity_from, tier.unit_price, tier.discount_rate, tier.note]);
        const [[after]] = await conn.query('SELECT * FROM erp_customer_item_prices WHERE id=? FOR UPDATE', [id]);
        const [tiers] = await conn.query('SELECT * FROM erp_customer_item_price_tiers WHERE pricing_id=? ORDER BY quantity_from,line_no,id', [id]);
        await insertSalesPricingEvent(conn, id, context, 'created', null, salesPricingSnapshot(after, tiers), reason, req.auth?.id);
        return { id, pricing:salesPricingSnapshot(after, tiers) };
      });
      await recordAccessAudit({ actorUserId:req.auth?.id, targetUserId:req.auth?.id, actionCode:'CUSTOMER_PRICING_CREATED', entityType:'erp_customer_item_prices', entityId:String(out.id), sourceKey:sourceName, before:null, after:out.pricing, reason, ipAddress:req.ip, userAgent:req.get('user-agent') });
      res.status(201).json({ ok:true, data:{ ...out, target_database:source.target_database, company_id:source.company_id } });
    } catch (error) { next(error); }
  });

  app.put('/api/sales-workflow/customer-pricing/:id', async (req, res, next) => {
    try {
      await ensureTargetSalesPricingSchema();
      const { sourceName, source, context } = contextForRequest(req); const id = Number(req.params.id); if (!Number.isInteger(id) || id < 1) throw badRequest('客戶產品計價編號錯誤');
      await syncCanonicalMaster(sourceName, 'currencies');
      const body = req.body || {}; const reason = pricingText(body.reason, '異動原因', 500) || '修改客戶產品計價草稿';
      const out = await tx(async conn => {
        const { row:beforeRow, tiers:beforeTiers } = await loadPrice(conn, context, id, true);
        if (beforeRow.status !== 'draft') throw badRequest('核准／作廢後的計價不可直接修改，請建立新的生效版本');
        const input = await pricingInput(conn, context, body, beforeRow);
        const [[same]] = await conn.query(`SELECT id FROM erp_customer_item_prices WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=?
          AND customer_code=? AND item_code=? AND pricing_unit=? AND currency_code=? AND effective_from=? AND id<>? LIMIT 1 FOR UPDATE`, [
          context.tenant_id, context.company_id, context.source_system, context.source_database, input.customerCode, input.itemCode,
          input.pricingUnit, input.currencyCode, input.effectiveFrom, id
        ]);
        if (same) throw badRequest(`已有相同生效日的其他計價版本：${same.id}`);
        await conn.query(`UPDATE erp_customer_item_prices SET customer_id=?,customer_code=?,mapping_id=?,item_id=?,item_code=?,pricing_unit=?,currency_code=?,
          unit_price=?,discount_rate=?,tax_included=?,quantity_pricing_flag=?,trade_condition=?,effective_from=?,effective_to=?,note=?,updated_by=?
          WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=?`, [
          input.customer.id, input.customerCode, input.mappingId, input.item.id, input.itemCode, input.pricingUnit, input.currencyCode, input.unitPrice,
          input.discountRate, input.taxIncluded, input.quantityPricing, input.tradeCondition, input.effectiveFrom, input.effectiveTo, input.note,
          req.auth?.id || null, id, context.tenant_id, context.company_id, context.source_system, context.source_database
        ]);
        await conn.query('DELETE FROM erp_customer_item_price_tiers WHERE pricing_id=?', [id]);
        for (const tier of input.tiers) await conn.query(`INSERT INTO erp_customer_item_price_tiers(pricing_id,line_no,quantity_from,unit_price,discount_rate,note) VALUES(?,?,?,?,?,?)`, [id, tier.line_no, tier.quantity_from, tier.unit_price, tier.discount_rate, tier.note]);
        const [[after]] = await conn.query('SELECT * FROM erp_customer_item_prices WHERE id=? FOR UPDATE', [id]);
        const [tiers] = await conn.query('SELECT * FROM erp_customer_item_price_tiers WHERE pricing_id=? ORDER BY quantity_from,line_no,id', [id]);
        await insertSalesPricingEvent(conn, id, context, 'updated', salesPricingSnapshot(beforeRow, beforeTiers), salesPricingSnapshot(after, tiers), reason, req.auth?.id);
        return { id, before:salesPricingSnapshot(beforeRow, beforeTiers), pricing:salesPricingSnapshot(after, tiers) };
      });
      await recordAccessAudit({ actorUserId:req.auth?.id, targetUserId:req.auth?.id, actionCode:'CUSTOMER_PRICING_UPDATED', entityType:'erp_customer_item_prices', entityId:String(out.id), sourceKey:sourceName, before:out.before, after:out.pricing, reason, ipAddress:req.ip, userAgent:req.get('user-agent') });
      res.json({ ok:true, data:{ ...out, target_database:source.target_database, company_id:source.company_id } });
    } catch (error) { next(error); }
  });

  app.post('/api/sales-workflow/customer-pricing/:id/approve', async (req, res, next) => {
    try {
      await ensureTargetSalesPricingSchema();
      const { sourceName, source, context } = contextForRequest(req); const id = Number(req.params.id); if (!Number.isInteger(id) || id < 1) throw badRequest('客戶產品計價編號錯誤');
      await syncCanonicalMaster(sourceName, 'currencies');
      const reason = pricingText(req.body?.reason, '核准說明', 500) || '核准客戶產品計價';
      const out = await tx(async conn => {
        const { row:beforeRow, tiers } = await loadPrice(conn, context, id, true);
        if (beforeRow.status !== 'draft') throw badRequest('只有待核准草稿可以核准');
        await assertNoApprovedOverlap(conn, context, {
          customerCode: beforeRow.customer_code,
          itemCode: beforeRow.item_code,
          pricingUnit: beforeRow.pricing_unit,
          currencyCode: beforeRow.currency_code,
          effectiveFrom: dateText(beforeRow.effective_from),
          effectiveTo: dateText(beforeRow.effective_to) || null
        }, id);
        await conn.query(`UPDATE erp_customer_item_prices SET status='approved',is_active=1,approved_by=?,approved_at=NOW(),updated_by=?
          WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=?`, [req.auth?.id || null, req.auth?.id || null, id, context.tenant_id, context.company_id, context.source_system, context.source_database]);
        const [[after]] = await conn.query('SELECT * FROM erp_customer_item_prices WHERE id=? FOR UPDATE', [id]);
        await insertSalesPricingEvent(conn, id, context, 'approved', salesPricingSnapshot(beforeRow, tiers), salesPricingSnapshot(after, tiers), reason, req.auth?.id);
        return { id, pricing:salesPricingSnapshot(after, tiers) };
      });
      await recordAccessAudit({ actorUserId:req.auth?.id, targetUserId:req.auth?.id, actionCode:'CUSTOMER_PRICING_APPROVED', entityType:'erp_customer_item_prices', entityId:String(out.id), sourceKey:sourceName, before:null, after:out.pricing, reason, ipAddress:req.ip, userAgent:req.get('user-agent') });
      res.json({ ok:true, data:{ ...out, target_database:source.target_database, company_id:source.company_id } });
    } catch (error) { next(error); }
  });

  app.post('/api/sales-workflow/customer-pricing/:id/void', async (req, res, next) => {
    try {
      await ensureTargetSalesPricingSchema();
      const { sourceName, source, context } = contextForRequest(req); const id = Number(req.params.id); if (!Number.isInteger(id) || id < 1) throw badRequest('客戶產品計價編號錯誤');
      const reason = pricingText(req.body?.reason, '作廢說明', 500, true);
      const out = await tx(async conn => {
        const { row:beforeRow, tiers } = await loadPrice(conn, context, id, true);
        if (beforeRow.status === 'voided') throw badRequest('此計價已作廢');
        await conn.query(`UPDATE erp_customer_item_prices SET status='voided',is_active=0,voided_by=?,voided_at=NOW(),updated_by=?
          WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=?`, [req.auth?.id || null, req.auth?.id || null, id, context.tenant_id, context.company_id, context.source_system, context.source_database]);
        const [[after]] = await conn.query('SELECT * FROM erp_customer_item_prices WHERE id=? FOR UPDATE', [id]);
        await insertSalesPricingEvent(conn, id, context, 'voided', salesPricingSnapshot(beforeRow, tiers), salesPricingSnapshot(after, tiers), reason, req.auth?.id);
        return { id, pricing:salesPricingSnapshot(after, tiers) };
      });
      await recordAccessAudit({ actorUserId:req.auth?.id, targetUserId:req.auth?.id, actionCode:'CUSTOMER_PRICING_VOIDED', entityType:'erp_customer_item_prices', entityId:String(out.id), sourceKey:sourceName, before:null, after:out.pricing, reason, ipAddress:req.ip, userAgent:req.get('user-agent') });
      res.json({ ok:true, data:{ ...out, target_database:source.target_database, company_id:source.company_id, message:'計價已作廢，資料與歷程保留' } });
    } catch (error) { next(error); }
  });
}

// Resolve a sales line price only inside the current target-company context.
// A blank unit price means "look up the approved customer price" for a quote
// or order; an explicit number is treated as a manual document price.  When a
// document is converted, the source line's price lineage is carried forward
// instead of looking up another company or another currency by accident.
async function resolveSalesDocumentPrice(conn, context, document, itemInput, sourceItem = null) {
  const customerCode = pricingText(document.customer_code, '客戶代號', 30, true);
  const itemCode = pricingText(itemInput.item_code, '品號', 40, true);
  const pricingUnit = pricingText(itemInput.unit || sourceItem?.unit || 'PCS', '計價單位', 20, true);
  let currencyCode = pricingText(document.currency_code || sourceItem?.currency_code, '幣別', 10);
  if (!currencyCode) {
    const [[customer]] = await conn.query(`SELECT currency_code FROM erp_customers
      WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND customer_code=? LIMIT 1`, [
      context.tenant_id, context.company_id, context.source_system, context.source_database, customerCode
    ]);
    currencyCode = pricingText(customer?.currency_code, '幣別', 10) || 'TWD';
  }
  const hasExplicitUnitPrice = Object.prototype.hasOwnProperty.call(itemInput, 'unit_price')
    && String(itemInput.unit_price ?? '').trim() !== '';
  let pricing = null;
  if (!hasExplicitUnitPrice && ['quotation', 'sales_order'].includes(String(document.document_kind))) {
    pricing = await lookupTargetSalesPrice(conn, context, {
      customer_code: customerCode, item_code: itemCode, pricing_unit: pricingUnit,
      currency_code: currencyCode, document_date: document.document_date, quantity: itemInput.quantity ?? 0
    });
  }
  const explicitPrice = hasExplicitUnitPrice ? pricingNumber(itemInput.unit_price, '單價', { required:true, min:0 }) : null;
  const inheritedPrice = !hasExplicitUnitPrice && sourceItem ? pricingNumber(sourceItem.unit_price, '來源單價', { required:true, min:0 }) : null;
  const unitPrice = pricing?.unit_price ?? explicitPrice ?? inheritedPrice ?? 0;
  const lineage = pricing ? {
    price_source_kind: pricing.price_source_kind, price_source_id: pricing.price_source_id,
    price_source_no: pricing.price_source_no, price_source_date: pricing.price_source_date,
    price_rule_id: pricing.price_rule_id, price_tier_id: pricing.price_tier_id
  } : sourceItem?.price_source_kind ? {
    price_source_kind: sourceItem.price_source_kind, price_source_id: sourceItem.price_source_id,
    price_source_no: sourceItem.price_source_no, price_source_date: dateText(sourceItem.price_source_date) || null,
    price_rule_id: sourceItem.price_rule_id, price_tier_id: sourceItem.price_tier_id
  } : hasExplicitUnitPrice ? {
    price_source_kind: 'manual_document', price_source_id: null,
    price_source_no: document.document_no || null, price_source_date: document.document_date,
    price_rule_id: null, price_tier_id: null
  } : {
    price_source_kind: 'unpriced', price_source_id: null,
    price_source_no: null, price_source_date: null, price_rule_id: null, price_tier_id: null
  };
  return { customerCode, itemCode, pricingUnit, currencyCode, unitPrice, pricing, hasExplicitUnitPrice, ...lineage };
}

function registerSalesWorkflowRoutes(app){
  const ctx=db=>{const s=sourceDatabases[db];if(!s)throw badRequest(`找不到資料來源：${db}`);return{tenant_id:s.tenant_id||'default',company_id:s.company_id||db,source_system:s.source_system||s.adapter_code||'ism-sh',source_database:db};};
  const EPS=0.000001;

  async function recordSalesOrderVersion(conn, context, order, beforeItem, afterItem, details={}) {
    const [[last]] = await conn.query(`SELECT version_no FROM sales_order_versions
      WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND order_id=?
      ORDER BY version_no DESC LIMIT 1 FOR UPDATE`,
      [context.tenant_id,context.company_id,context.source_system,context.source_database,order.id]);
    const versionNo=Number(last?.version_no||0)+1;
    await conn.query(`INSERT INTO sales_order_versions(
      tenant_id,company_id,source_system,source_database,order_id,order_item_id,version_no,change_kind,
      source_kind,source_document_id,source_document_no,before_status,after_status,before_quantity,after_quantity,
      before_delivered_quantity,after_delivered_quantity,before_unit_price,after_unit_price,reason,changed_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[
      context.tenant_id,context.company_id,context.source_system,context.source_database,order.id,beforeItem?.id||null,
      versionNo,details.change_kind||'order_control',details.source_kind||null,details.source_document_id||null,
      details.source_document_no||null,order.status,details.after_status||order.status,Number(beforeItem?.quantity||0),
      Number(afterItem?.quantity??beforeItem?.quantity??0),Number(beforeItem?.related_quantity||0),
      Number(afterItem?.related_quantity??beforeItem?.related_quantity??0),Number(beforeItem?.unit_price||0),
      Number(afterItem?.unit_price??beforeItem?.unit_price??0),details.reason||'訂單受控變更',details.changed_by||null
    ]);
    return versionNo;
  }

  async function syncSalesReturnOrder(conn, document, item, userId) {
    const returnQuantity=Number(item.quantity||0);
    if (!item.source_item_id || returnQuantity<=EPS) return null;
    const [[chain]]=await conn.query(`SELECT
        ship.id shipment_item_id,ship.source_item_id order_item_id,
        order_item.document_id order_id
      FROM sales_document_items ship
      JOIN sales_document_items order_item ON order_item.id=ship.source_item_id
      JOIN sales_documents shipment ON shipment.id=ship.document_id AND shipment.document_kind='shipment'
      JOIN sales_documents order_doc ON order_doc.id=order_item.document_id AND order_doc.document_kind='sales_order'
      WHERE ship.id=? AND shipment.source_database=? AND order_doc.source_database=? FOR UPDATE`,
      [item.source_item_id,document.source_database,document.source_database]);
    if (!chain?.order_id) return null;
    const [[order]]=await conn.query(`SELECT * FROM sales_documents
      WHERE id=? AND source_database=? AND document_kind='sales_order' FOR UPDATE`,[chain.order_id,document.source_database]);
    const [[beforeItem]]=await conn.query('SELECT * FROM sales_document_items WHERE id=? FOR UPDATE',[chain.order_item_id]);
    if (!order || !beforeItem) return null;
    const beforeStatus=order.status;
    await conn.query('UPDATE sales_document_items SET related_quantity=GREATEST(related_quantity-?,0) WHERE id=?',[returnQuantity,beforeItem.id]);
    const [[afterItem]]=await conn.query('SELECT * FROM sales_document_items WHERE id=? FOR UPDATE',[beforeItem.id]);
    const [[totals]]=await conn.query(`SELECT COALESCE(SUM(quantity),0) order_quantity,
        COALESCE(SUM(related_quantity),0) delivered_quantity
      FROM sales_document_items WHERE document_id=? FOR UPDATE`,[order.id]);
    const orderQuantity=Number(totals.order_quantity||0),deliveredQuantity=Number(totals.delivered_quantity||0);
    const fullyDelivered=deliveredQuantity>=orderQuantity-EPS && orderQuantity>EPS;
    const afterStatus=fullyDelivered?(beforeStatus==='closed'?'closed':'completed'):(deliveredQuantity>EPS?'partial':'approved');
    const wasClosed=['completed','closed'].includes(beforeStatus);
    const reopened=wasClosed && !fullyDelivered;
    const note=reopened?`銷退 ${document.document_no} 回庫 ${returnQuantity}，訂單已交量回沖並受控解結／重開`:`銷退 ${document.document_no} 回沖已交量 ${returnQuantity}`;
    if (reopened) {
      await conn.query(`UPDATE sales_documents SET status=?,closed_by=NULL,closed_at=NULL,close_note=NULL,
        reopened_by=?,reopened_at=NOW(),reopen_note=?,note=TRIM(CONCAT(COALESCE(note,''),
        CASE WHEN COALESCE(note,'')='' THEN '' ELSE '；' END,?)) WHERE id=?`,
        [afterStatus,userId,note,note,order.id]);
    } else if (fullyDelivered) {
      await conn.query(`UPDATE sales_documents SET status=?,closed_by=COALESCE(closed_by,?),
        closed_at=COALESCE(closed_at,NOW()),close_note=COALESCE(close_note,'銷貨已全部交付，訂單結案') WHERE id=?`,
        [afterStatus,userId,order.id]);
    } else {
      await conn.query(`UPDATE sales_documents SET status=?,closed_by=NULL,closed_at=NULL,close_note=NULL WHERE id=?`,[afterStatus,order.id]);
    }
    const context=ctx(String(document.source_database).toUpperCase());
    const versionNo=await recordSalesOrderVersion(conn,context,order,beforeItem,afterItem,{
      change_kind:reopened?'sales_return_reopen':'sales_return_quantity_reversal',source_kind:'sales_return',
      source_document_id:document.id,source_document_no:document.document_no,after_status:afterStatus,
      reason:note,changed_by:userId
    });
    return {order_id:order.id,order_item_id:beforeItem.id,before_status:beforeStatus,after_status:afterStatus,
      before_delivered_quantity:Number(beforeItem.related_quantity||0),after_delivered_quantity:Number(afterItem.related_quantity||0),version_no:versionNo};
  }

  async function applySalesReturnFinance(conn, document, items, userId) {
    if(document.document_kind!=='sales_return')return;
    for(const item of items){
      const adjustment=await ensureSalesReturnAdjustment(conn,document,item,userId);
      if(adjustment)await syncSalesReturnAdjustment(conn,adjustment.id,userId);
    }
  }
  const defs=[['quotation','QT','報價單','QT'],['sales_order','SO','客戶訂單','SO'],['shipment','SA','銷貨單','SA'],['sales_return','SR','銷退折讓單','SR']];
  const ensure=async db=>{const c=ctx(db);for(const x of defs)await pool.query(`INSERT IGNORE INTO sales_document_types(tenant_id,company_id,source_system,document_kind,type_code,type_name,number_prefix,source_database) VALUES(?,?,?,?,?,?,?,?)`,[c.tenant_id,c.company_id,c.source_system,...x,db]);await pool.query("UPDATE sales_document_types SET source_database=? WHERE tenant_id=? AND company_id=? AND source_system=? AND (source_database IS NULL OR source_database='')",[db,c.tenant_id,c.company_id,c.source_system]);return c;};
  // 銷貨／銷退過帳前檢查會計期間與來源單據日期。
  app.use('/api/sales-workflow/documents/:id/post', async (req,res,next) => {
    try {
      await ensureTargetFinanceWorkflowSchema();
      const id=Number(req.params.id), db=String(req.body?.source_database||req.query.source_database||req.get('X-Source-Database')||'SH').toUpperCase();
      const [[d]]=await pool.query('SELECT * FROM sales_documents WHERE id=? AND source_database=?',[id,db]);
      if (d) await tx(async conn=>{
        const c=ctx(db);
        await assertOpenAccountingPeriod(conn,c,d.document_date);
        if (['shipment','sales_return'].includes(d.document_kind)) {
          const [[source]]=await conn.query(`SELECT MIN(parent.document_date) source_date
            FROM sales_document_items si
            JOIN sales_document_items oi ON oi.id=si.source_item_id
            JOIN sales_documents parent ON parent.id=oi.document_id
            WHERE si.document_id=?`,[id]);
          assertChronologicalDate(d.document_date,source?.source_date,'銷貨／銷退日期');
        }
      });
      next();
    } catch(e){next(e);}
  });
  app.get('/api/sales-workflow/document-types',async(req,res,next)=>{try{await ensureTargetSalesWorkflowSchema();const db=String(req.query.source_database||'SH').toUpperCase(),c=await ensure(db),sp=getSourcePool(db);await pool.query("UPDATE sales_document_types SET source_database=? WHERE tenant_id=? AND company_id=? AND source_system=? AND (source_database IS NULL OR source_database='')",[db,c.tenant_id,c.company_id,c.source_system]);for(const [kind,table,column] of [['sales_order','copta','TA001'],['shipment','coptg','TG001'],['sales_return','copti','TI001']]){try{const[types]=await sp.query(`SELECT DISTINCT t.${column} type_code,COALESCE(NULLIF(q.MQ002,''),t.${column}) type_name,q.MQ034 type_full_name,q.MQ003 nature_code,q.MQ004 numbering_method,q.MQ005 year_digits,q.MQ006 serial_digits,q.MQ024 item_input_method,q.MQ015 auto_confirm,q.MQ061 auto_confirm_on_edit,q.MQ018 update_customer_price,q.MQ019 require_sales_order,q.MQ020 settlement_mode,q.MQ021 ar_document_type,q.MQ060 is_default,q.MQ022 note FROM ${table} t LEFT JOIN cmsmq q ON q.COMPANY=t.COMPANY AND q.MQ001=t.${column} WHERE t.COMPANY=? AND t.${column}<>''`,[db]);for(const x of types){const yes=v=>['Y','y','1','true'].includes(String(v??'').trim()),map={'1':'daily','2':'monthly','3':'sequence','4':'manual'},settlement={'Y':'whole','y':'per_document','N':'batch'};await pool.query(`INSERT INTO sales_document_types(tenant_id,company_id,source_system,document_kind,type_code,type_name,type_full_name,nature_code,number_prefix,numbering_method,year_digits,serial_digits,requires_approval,auto_confirm,auto_confirm_on_edit,update_customer_price,require_sales_order,settlement_mode,ar_document_type,is_default,is_active,note,source_database,source_table) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE type_name=VALUES(type_name),type_full_name=VALUES(type_full_name),nature_code=VALUES(nature_code),numbering_method=VALUES(numbering_method),year_digits=VALUES(year_digits),serial_digits=VALUES(serial_digits),requires_approval=VALUES(requires_approval),auto_confirm=VALUES(auto_confirm),auto_confirm_on_edit=VALUES(auto_confirm_on_edit),update_customer_price=VALUES(update_customer_price),require_sales_order=VALUES(require_sales_order),settlement_mode=VALUES(settlement_mode),ar_document_type=VALUES(ar_document_type),is_default=VALUES(is_default),note=VALUES(note),source_database=VALUES(source_database),source_table=VALUES(source_table)`,[c.tenant_id,c.company_id,c.source_system,kind,String(x.type_code).trim(),String(x.type_name||x.type_code).trim(),String(x.type_full_name||'').trim()||null,String(x.nature_code||'').trim()||null,String(x.type_code).trim(),map[String(x.numbering_method||'').trim()]||'daily',Number(x.year_digits)||4,Number(x.serial_digits)||4,yes(x.auto_confirm)?0:1,yes(x.auto_confirm),yes(x.auto_confirm_on_edit),yes(x.update_customer_price),yes(x.require_sales_order),settlement[String(x.settlement_mode||'').trim()]||'batch',String(x.ar_document_type||'').trim()||null,yes(x.is_default),1,String(x.note||'').trim()||'由客戶舊 ERP CMSMQ 匯入',db,'cmsmq']);}}catch(_){}}const[rows]=await pool.query('SELECT * FROM sales_document_types WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? ORDER BY document_kind,type_code',[c.tenant_id,c.company_id,c.source_system,db]);res.json({ok:true,data:rows});}catch(e){next(e);}});
   app.post('/api/sales-workflow/document-types',async(req,res,next)=>{try{const b=req.body||{},db=sourceDbFromRequest(req),c=ctx(db);if(!defs.some(x=>x[0]===b.document_kind)||!trim(b.type_code)||!trim(b.type_name))throw badRequest('請輸入有效的銷售單據性質');const[r]=await pool.query('INSERT INTO sales_document_types(tenant_id,company_id,source_system,document_kind,type_code,type_name,number_prefix,requires_approval,note,source_database) VALUES(?,?,?,?,?,?,?,?,?,?)',[c.tenant_id,c.company_id,c.source_system,b.document_kind,trim(b.type_code),trim(b.type_name),trim(b.number_prefix)||trim(b.type_code),Number(b.requires_approval??1),trim(b.note),db]);res.status(201).json({ok:true,data:{id:r.insertId}});}catch(e){next(e);}});
   app.get('/api/sales-workflow/documents',async(req,res,next)=>{try{const db=String(req.query.source_database||'SH').toUpperCase(),kind=trim(req.query.document_kind),limit=Math.min(Math.max(Number(req.query.limit)||10,1),100),p=[db];let f='d.source_database=?';if(kind){f+=' AND d.document_kind=?';p.push(kind);}const[rows]=await pool.query(`SELECT d.*,i.id item_id,i.source_item_id,i.forecast_item_id,i.forecast_no,i.item_code,i.item_name,i.unit,i.warehouse_code,i.quantity,i.related_quantity,i.unit_price,i.unit_cost,i.expected_date,i.allowance_amount,i.price_source_kind,i.price_source_id,i.price_source_no,i.price_source_date,i.price_rule_id,i.price_tier_id FROM sales_documents d JOIN sales_document_items i ON i.document_id=d.id WHERE ${f} ORDER BY d.document_date DESC,d.id DESC LIMIT ?`,[...p,limit]);res.json({ok:true,data:rows});}catch(e){next(e);}});
  app.use('/api/sales-workflow/documents',async(req,res,next)=>{try{if(req.method!=='POST'||trim(req.body?.document_kind)!=='sales_return'||Number(req.body?.source_item_id||0)||!trim(req.body?.source_document_no))return next();const db=String(req.body.source_database||req.get('X-Source-Database')||'SH').toUpperCase(),documentNo=trim(req.body.source_document_no),customer=trim(req.body.customer_code),item=trim(req.body.item_code);const[[source]]=await pool.query(`SELECT i.id source_item_id,i.document_id,d.customer_code,d.status,d.document_kind FROM sales_document_items i JOIN sales_documents d ON d.id=i.document_id WHERE d.source_database=? AND d.document_kind='shipment' AND d.document_no=? AND d.customer_code=? AND i.item_code=? LIMIT 1`,[db,documentNo,customer,item]);if(!source)throw badRequest('找不到指定的原銷貨單，請確認公司別、客戶與品號');req.body={...req.body,source_item_id:source.source_item_id,source_document_id:source.document_id};next();}catch(e){next(e);}});
  app.post('/api/sales-workflow/documents',async(req,res,next)=>{
    try{
      await ensureTargetSalesPricingSchema();
      await ensureTargetSalesForecastSchema();
       const b=req.body||{},db=String(b.source_database||'SH').toUpperCase(),c=await ensure(db),kind=trim(b.document_kind),date=validDate(b.document_date),type=trim(b.document_type);
       await syncCanonicalMaster(db, 'currencies');
       const [[dt]]=await pool.query(`SELECT * FROM sales_document_types
         WHERE tenant_id=? AND company_id=? AND source_system=? AND document_kind=? AND type_code=?
           AND (source_database=? OR source_database IS NULL OR source_database='') AND is_active=1`,[
           c.tenant_id,c.company_id,c.source_system,kind,type,db
       ]);
      if(!dt)throw badRequest('請選擇目前公司啟用中的銷售單別');
      if(!['quotation','sales_order','shipment','sales_return'].includes(kind))throw badRequest('銷售單據類型錯誤');
      const qty=positiveNumber(b.quantity,'數量'),sourceItemId=Number(b.source_item_id||0)||null,returnType=kind==='sales_return'?(trim(b.return_type)||'return'):null;
      if(kind==='sales_return'&&!['return','allowance'].includes(returnType))throw badRequest('銷退方式錯誤');
      const allowance=Number(b.allowance_amount||0);if(!Number.isFinite(allowance)||allowance<0)throw badRequest('折讓金額不可為負數');
      if(kind==='sales_return'&&returnType==='allowance'&&allowance<=EPS)throw badRequest('折讓金額必須大於零');
      const out=await tx(async conn=>{
        let source=null;
        if(sourceItemId){
          const [[x]]=await conn.query(`SELECT i.*,d.customer_code,d.currency_code,d.status,d.inventory_status,d.document_kind,d.document_no,d.id document_id
            FROM sales_document_items i JOIN sales_documents d ON d.id=i.document_id
            WHERE i.id=? AND d.source_database=? FOR UPDATE`,[sourceItemId,db]);
          const validSource=kind==='sales_return'?x?.document_kind==='shipment'&&x?.status==='posted'&&x?.inventory_status==='posted':['approved','partial'].includes(x?.status);
          if(!x||!validSource)throw badRequest(kind==='sales_return'?'銷退來源必須是已完成庫存過帳的銷貨單':'來源單據尚未核準或已結案');
          if(trim(b.customer_code)&&trim(b.customer_code)!==String(x.customer_code))throw badRequest('銷退客戶必須與原銷貨一致');
          if(trim(b.item_code)&&trim(b.item_code)!==String(x.item_code))throw badRequest('銷退品號必須與原銷貨一致');
          if(kind!=='sales_return'&&qty>Number(x.quantity)-Number(x.related_quantity)+EPS)throw badRequest('數量超過來源未交量');
          if(kind==='sales_return'){
            const [[used]]=await conn.query(`SELECT
                COALESCE(SUM(CASE WHEN d.return_type='return' THEN i.quantity ELSE 0 END),0) returned_quantity,
                COALESCE(SUM(CASE WHEN d.return_type='allowance' THEN i.allowance_amount ELSE 0 END),0) allowance_amount
              FROM sales_document_items i JOIN sales_documents d ON d.id=i.document_id
              WHERE d.source_database=? AND d.document_kind='sales_return' AND d.status IN ('draft','approved','posted') AND i.source_item_id=?`,[db,sourceItemId]);
            if(returnType==='return'){
              const available=Math.max(Number(x.quantity)-Number(used.returned_quantity||0),0);
              if(qty>available+EPS)throw badRequest(`銷退數量超過原銷貨可退量 ${available}`);
              if(allowance>qty*Number(x.unit_price||0)-Number(used.allowance_amount||0)+EPS)throw badRequest('銷退折讓金額超過原銷貨剩餘可折讓金額');
            }else{
              const availableAmount=Math.max(Number(x.quantity)*Number(x.unit_price||0)-Number(used.allowance_amount||0),0);
              if(allowance>availableAmount+EPS)throw badRequest(`折讓金額超過原銷貨剩餘可折讓金額 ${availableAmount}`);
            }
          }
          source=x;
        }
        const customerCode=trim(b.customer_code)||source?.customer_code,itemCode=trim(b.item_code)||source?.item_code;
        if(!customerCode||!itemCode)throw badRequest('客戶與品號不可空白');
        assertConfiguredSource(dt,source?.document_kind,Boolean(source),'銷售單據');
        const no=trim(b.document_no)||await nextConfiguredDocumentNumber(conn,'sales_documents','document_no',dt,date),inventory=['shipment','sales_return'].includes(kind)?'pending':'not_applicable',status=documentTypeNeedsApproval(dt)?'draft':'approved';
        const document={document_kind:kind,document_type:type,document_no:no,document_date:date,customer_code:customerCode,currency_code:trim(b.currency_code)||source?.currency_code||null};
         const price=await resolveSalesDocumentPrice(conn,c,document,{item_code:itemCode,item_name:trim(b.item_name)||source?.item_name,specification:trim(b.specification)||source?.specification,unit:trim(b.unit)||source?.unit||'PCS',quantity:qty,unit_price:b.unit_price},source);
         const forecastLink=kind==='sales_order'?await resolveSalesForecastOrderLink(conn,c,{forecast_item_id:b.forecast_item_id,forecast_no:b.forecast_no,document_date:date,customer_code:customerCode,item_code:itemCode,warehouse_code:trim(b.warehouse_code)||source?.warehouse_code,quantity:qty}):null;
         const warehouseCode=forecastLink?.warehouse_code||trim(b.warehouse_code)||source?.warehouse_code||null;
         const [h]=await conn.query(`INSERT INTO sales_documents(tenant_id,company_id,source_system,source_database,document_kind,document_type,document_no,document_date,customer_code,currency_code,warehouse_code,salesperson_code,source_document_id,return_type,status,inventory_status,note,created_by,approved_by,approved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[c.tenant_id,c.company_id,c.source_system,db,kind,type,no,date,customerCode,price.currencyCode,warehouseCode,trim(b.salesperson_code),source?.document_id||Number(b.source_document_id||0)||null,returnType,status,inventory,trim(b.note),req.auth.id,documentTypeNeedsApproval(dt)?null:req.auth.id,documentTypeNeedsApproval(dt)?null:new Date()]);
        const [i]=await conn.query(`INSERT INTO sales_document_items(
           document_id,line_no,source_item_id,forecast_item_id,forecast_no,item_code,item_name,specification,unit,warehouse_code,
          quantity,unit_price,unit_cost,expected_date,allowance_amount,
          price_source_kind,price_source_id,price_source_no,price_source_date,price_rule_id,price_tier_id,note)
           VALUES(?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[h.insertId,sourceItemId,forecastLink?.forecast_item_id||Number(b.forecast_item_id||0)||null,forecastLink?.forecast_no||trim(b.forecast_no)||null,price.itemCode,trim(b.item_name)||source?.item_name,trim(b.specification)||source?.specification,price.pricingUnit,warehouseCode,qty,price.unitPrice,Number(b.unit_cost??source?.unit_cost??0),nullableDate(b.expected_date),allowance,price.price_source_kind,price.price_source_id,price.price_source_no,price.price_source_date,price.price_rule_id,price.price_tier_id,trim(b.item_note)]);
        let priceUpdate=null;
        if(status==='approved'&&Number(dt.update_customer_price)) {
          priceUpdate=await upsertSalesPriceFromDocument(conn,c,{...document,id:h.insertId,currency_code:price.currencyCode},{...price,unit:price.pricingUnit,item_code:price.itemCode,unit_price:price.unitPrice},req.auth.id);
        }
         if(status==='approved'&&forecastLink) await refreshSalesForecastMetrics(conn,c,forecastLink.forecast_id);
         return{id:h.insertId,item_id:i.insertId,document_no:no,status,forecast_item_id:forecastLink?.forecast_item_id||null,forecast_no:forecastLink?.forecast_no||null,price_source_kind:price.price_source_kind,price_rule_id:price.price_rule_id,price_tier_id:price.price_tier_id,price_update:priceUpdate};
      });
      res.status(201).json({ok:true,data:out});
    }catch(e){next(e);}
  });
  app.post('/api/sales-workflow/documents/:id/approve',async(req,res,next)=>{
    try{
      await ensureTargetSalesPricingSchema();
      await ensureTargetSalesForecastSchema();
      const id=Number(req.params.id),sourceDatabase=String(req.body?.source_database||req.query.source_database||'SH').toUpperCase();
       const c=ctx(sourceDatabase);
       await syncCanonicalMaster(sourceDatabase, 'currencies');
      const out=await tx(async conn=>{
        const [[document]]=await conn.query(`SELECT d.* FROM sales_documents d
          WHERE d.id=? AND d.source_database=? AND d.tenant_id=? AND d.company_id=? AND d.source_system=? AND d.status='draft' FOR UPDATE`,[
          id,sourceDatabase,c.tenant_id,c.company_id,c.source_system
        ]);
        if(!document)throw badRequest('只有目前公司別的草稿可以核準');
        const [[documentType]]=await conn.query(`SELECT * FROM sales_document_types
          WHERE tenant_id=? AND company_id=? AND source_system=? AND document_kind=? AND type_code=?
            AND (source_database=? OR source_database IS NULL OR source_database='') AND is_active=1 LIMIT 1`,[
          c.tenant_id,c.company_id,c.source_system,document.document_kind,document.document_type,sourceDatabase
        ]);
        if(!documentType)throw badRequest('找不到目前公司別啟用中的單據性質');
         const [items]=await conn.query('SELECT * FROM sales_document_items WHERE document_id=? ORDER BY line_no FOR UPDATE',[id]);
         if(!items.length)throw badRequest('單據沒有明細，無法核准');
         const forecastIds=new Set();
         if(document.document_kind==='sales_order') {
           for(const item of items) {
             if(!item.forecast_item_id&&!item.forecast_no) continue;
             const link=await resolveSalesForecastOrderLink(conn,c,{forecast_item_id:item.forecast_item_id,forecast_no:item.forecast_no,document_id:id,document_date:document.document_date,customer_code:document.customer_code,item_code:item.item_code,warehouse_code:item.warehouse_code||document.warehouse_code,quantity:item.quantity});
             if(link) forecastIds.add(Number(link.forecast_id));
           }
         }
         await conn.query(`UPDATE sales_documents SET status='approved',approved_by=?,approved_at=NOW()
          WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=?`,[
          req.auth.id,id,c.tenant_id,c.company_id,c.source_system,sourceDatabase
        ]);
        const priceUpdates=[];
         if(Number(documentType.update_customer_price)) {
           for(const item of items) priceUpdates.push(await upsertSalesPriceFromDocument(conn,c,document,item,req.auth.id));
         }
         for(const forecastId of forecastIds) await refreshSalesForecastMetrics(conn,c,forecastId);
         return {id,source_database:sourceDatabase,status:'approved',price_updates:priceUpdates};
      });
      res.json({ok:true,data:out});
    }catch(e){next(e);}
  });
  app.post('/api/sales-workflow/items/:id/convert', async (req,res,next) => {
    try {
      const id=Number(req.params.id), b=req.body||{}, db=sourceDbFromRequest(req);
      const [[s]]=await pool.query(`SELECT i.*,d.document_kind,d.customer_code,d.currency_code,d.document_no,d.document_type,d.source_database
        FROM sales_document_items i JOIN sales_documents d ON d.id=i.document_id
        WHERE i.id=? AND d.source_database=?`,[id,db]);
      if(!s)throw badRequest('找不到目前公司別的來源明細');
      const target=s.document_kind==='quotation'?'sales_order':s.document_kind==='sales_order'?'shipment':null;
      if(!target)throw badRequest('此單據不可轉下一階段');
      const documentType=trim(b.document_type);
      if(!documentType)throw badRequest(`請選擇目前公司要使用的${target==='sales_order'?'訂單':'銷貨'}單別`);
      req.body={...b,source_database:db,document_kind:target,document_type:documentType,document_date:b.document_date,
        customer_code:s.customer_code,source_item_id:id,item_code:s.item_code,item_name:s.item_name,unit:s.unit,
        currency_code:trim(b.currency_code)||s.currency_code,warehouse_code:b.warehouse_code||s.warehouse_code,
        quantity:b.quantity||Number(s.quantity)-Number(s.related_quantity),unit_price:String(b.unit_price??'').trim(),
        forecast_item_id:b.forecast_item_id||s.forecast_item_id||null,forecast_no:b.forecast_no||s.forecast_no||null};
      next();
    } catch(e){next(e);}
  }, async (req,res,next) => {
    try {
       await ensureTargetSalesPricingSchema();
       await ensureTargetSalesForecastSchema();
       const b=req.body,db=sourceDbFromRequest(req),c=await ensure(db),date=validDate(b.document_date),kind=b.document_kind;
       await syncCanonicalMaster(db, 'currencies');
      const [[dt]]=await pool.query(`SELECT * FROM sales_document_types
        WHERE tenant_id=? AND company_id=? AND source_system=? AND document_kind=? AND type_code=?
          AND (source_database=? OR source_database IS NULL OR source_database='') AND is_active=1`,[
        c.tenant_id,c.company_id,c.source_system,kind,b.document_type,db
      ]);
      if(!dt)throw badRequest('找不到目前公司啟用中的目標單別');
      const out=await tx(async conn=>{
        const [[s]]=await conn.query(`SELECT i.*,d.customer_code,d.currency_code,d.document_kind,d.document_no,d.document_type,d.id document_id
          FROM sales_document_items i JOIN sales_documents d ON d.id=i.document_id
          WHERE i.id=? AND d.source_database=? AND d.status IN ('approved','partial') FOR UPDATE`,[b.source_item_id,db]);
        const qty=positiveNumber(b.quantity,'轉單數量');
        if(!s||qty>Number(s.quantity)-Number(s.related_quantity)+SALES_PRICING_EPS)throw badRequest('轉單數量超過未交量');
        assertConfiguredSource(dt,s.document_kind,true,'銷售轉單');
        const no=await nextConfiguredDocumentNumber(conn,'sales_documents','document_no',dt,date),status=documentTypeNeedsApproval(dt)?'draft':'approved';
        const document={document_kind:kind,document_type:b.document_type,document_no:no,document_date:date,customer_code:s.customer_code,currency_code:b.currency_code||s.currency_code};
        const price=await resolveSalesDocumentPrice(conn,c,document,{item_code:s.item_code,item_name:s.item_name,specification:s.specification,unit:s.unit,quantity:qty,unit_price:b.unit_price},s);
        const forecastLink=kind==='sales_order'?await resolveSalesForecastOrderLink(conn,c,{forecast_item_id:b.forecast_item_id,forecast_no:b.forecast_no,document_date:date,customer_code:s.customer_code,item_code:s.item_code,warehouse_code:b.warehouse_code||s.warehouse_code,quantity:qty}):null;
        const warehouseCode=forecastLink?.warehouse_code||b.warehouse_code||s.warehouse_code||null;
        const [h]=await conn.query(`INSERT INTO sales_documents(
          tenant_id,company_id,source_system,source_database,document_kind,document_type,document_no,document_date,
          customer_code,currency_code,warehouse_code,status,inventory_status,created_by,approved_by,approved_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[
          c.tenant_id,c.company_id,c.source_system,db,kind,b.document_type,no,date,s.customer_code,price.currencyCode,
          warehouseCode,status,kind==='shipment'?'pending':'not_applicable',req.auth.id,
          documentTypeNeedsApproval(dt)?null:req.auth.id,documentTypeNeedsApproval(dt)?null:new Date()
        ]);
        const [i]=await conn.query(`INSERT INTO sales_document_items(
           document_id,line_no,source_item_id,forecast_item_id,forecast_no,item_code,item_name,specification,unit,warehouse_code,quantity,unit_price,
           unit_cost,expected_date,price_source_kind,price_source_id,price_source_no,price_source_date,price_rule_id,price_tier_id)
           VALUES(?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[
           h.insertId,b.source_item_id,forecastLink?.forecast_item_id||s.forecast_item_id||null,forecastLink?.forecast_no||s.forecast_no||null,price.itemCode,s.item_name,s.specification,price.pricingUnit,warehouseCode,
          qty,price.unitPrice,Number(b.unit_cost??s.unit_cost??0),nullableDate(b.expected_date),price.price_source_kind,
          price.price_source_id,price.price_source_no,price.price_source_date,price.price_rule_id,price.price_tier_id
        ]);
        await conn.query('UPDATE sales_document_items SET related_quantity=related_quantity+? WHERE id=?',[qty,b.source_item_id]);
        let priceUpdate=null;
        if(status==='approved'&&Number(dt.update_customer_price)) priceUpdate=await upsertSalesPriceFromDocument(conn,c,{...document,id:h.insertId},{...price,unit:price.pricingUnit},req.auth.id);
         if(status==='approved'&&forecastLink) await refreshSalesForecastMetrics(conn,c,forecastLink.forecast_id);
         return{id:h.insertId,item_id:i.insertId,document_no:no,status,forecast_item_id:forecastLink?.forecast_item_id||null,forecast_no:forecastLink?.forecast_no||null,price_source_kind:price.price_source_kind,price_rule_id:price.price_rule_id,price_tier_id:price.price_tier_id,price_update:priceUpdate};
      });
      res.status(201).json({ok:true,data:out});
    }catch(e){next(e);}
  });
  app.post('/api/sales-workflow/documents/:id/post',async(req,res,next)=>{
    try{
      await ensureTargetSalesWorkflowSchema();await ensureTargetFinanceWorkflowSchema();
      const id=Number(req.params.id),requestedDb=String(req.body?.source_database||req.query.source_database||'SH').toUpperCase();
      let orderResults=[];
      await tx(async conn=>{
        const [[d]]=await conn.query('SELECT * FROM sales_documents WHERE id=? AND source_database=? FOR UPDATE',[id,requestedDb]);
        const [items]=await conn.query('SELECT * FROM sales_document_items WHERE document_id=? ORDER BY line_no FOR UPDATE',[id]);
        if(!d||d.status!=='approved'||!['shipment','sales_return'].includes(d.document_kind))throw badRequest('只有已核準銷貨或銷退可以過帳');
        if(!items.length)throw badRequest('單據沒有明細，無法過帳');
        if(d.document_kind==='sales_return'&&d.return_type==='return'&&d.inventory_status!=='accepted')throw badRequest('銷退必須先完成驗收，驗收合格後才能回庫過帳');
        const c=ctx(String(d.source_database).toUpperCase());
        if(d.document_kind==='sales_return'){
          for(const item of items){
            if(!item.source_item_id)continue;
            const [[source]]=await conn.query(`SELECT si.id,si.document_id,si.item_code,si.quantity,sd.customer_code,sd.status,sd.inventory_status
              FROM sales_document_items si JOIN sales_documents sd ON sd.id=si.document_id
              WHERE si.id=? AND sd.source_database=? AND sd.document_kind='shipment' FOR UPDATE`,[item.source_item_id,d.source_database]);
            if(!source||source.status!=='posted'||source.inventory_status!=='posted')throw badRequest('銷退來源銷貨尚未完成過帳');
            if(String(source.item_code)!==String(item.item_code))throw badRequest('銷退品號與原銷貨不一致');
            if(String(source.customer_code)!==String(d.customer_code))throw badRequest('銷退客戶與原銷貨不一致');
            if(d.return_type==='return'){
              const [[used]]=await conn.query(`SELECT COALESCE(SUM(i.quantity),0) returned_quantity
                FROM sales_document_items i JOIN sales_documents rd ON rd.id=i.document_id
                WHERE rd.source_database=? AND rd.document_kind='sales_return' AND rd.return_type='return'
                  AND rd.status IN ('draft','approved','posted') AND rd.id<>? AND i.source_item_id=?`,[d.source_database,d.id,item.source_item_id]);
              const available=Math.max(Number(source.quantity)-Number(used.returned_quantity||0),0);
              if(Number(item.quantity)>available+EPS)throw badRequest(`銷退數量超過原銷貨可退量 ${available}`);
            }
          }
        }
        if(d.document_kind==='sales_return'&&d.return_type==='allowance'){
          await conn.query("UPDATE sales_documents SET status='posted',inventory_status='not_applicable',posted_by=?,posted_at=NOW() WHERE id=?",[req.auth.id,id]);
          await applySalesReturnFinance(conn,d,items,req.auth.id);
          return;
        }
        const sign=d.document_kind==='shipment'?-1:1;
        for(const item of items){
          const warehouse=item.warehouse_code||d.warehouse_code||'';if(!warehouse)throw badRequest(`第 ${item.line_no} 筆明細缺少庫別`);
          const qty=sign*Number(item.quantity),amount=qty*Number(item.unit_cost||0);
          const [[bal]]=await conn.query(`SELECT * FROM erp_inventory_balances WHERE tenant_id=? AND company_id=? AND source_system=? AND item_code=? AND warehouse_code=? AND location_code='' FOR UPDATE`,[c.tenant_id,c.company_id,c.source_system,item.item_code,warehouse]);
          const nq=Number(bal?.quantity_on_hand||0)+qty,na=Number(bal?.inventory_amount||0)+amount;if(nq<0)throw badRequest(`庫存不足：${item.item_code} / ${warehouse}`);
          await conn.query(`INSERT INTO erp_inventory_balances(tenant_id,company_id,source_system,item_code,warehouse_code,location_code,quantity_on_hand,unit_cost,inventory_amount,last_movement_at) VALUES(?,?,?,?,?,'',?,?,?,NOW()) ON DUPLICATE KEY UPDATE quantity_on_hand=VALUES(quantity_on_hand),unit_cost=VALUES(unit_cost),inventory_amount=VALUES(inventory_amount),last_movement_at=NOW()`,[c.tenant_id,c.company_id,c.source_system,item.item_code,warehouse,nq,nq?na/nq:0,na]);
          await conn.query(`INSERT INTO inventory_movement_ledger(tenant_id,company_id,source_system,document_id,document_no,document_type,movement_kind,movement_date,item_code,warehouse_code,location_code,lot_no,quantity_delta,unit_cost,amount_delta) VALUES(?,?,?,NULL,?,?,?,?,?,?,'','',?,?,?)`,[c.tenant_id,c.company_id,c.source_system,d.document_no,d.document_type,d.document_kind,d.document_date,item.item_code,warehouse,qty,item.unit_cost,amount]);
        }
        await conn.query("UPDATE sales_documents SET status='posted',inventory_status='posted',posted_by=?,posted_at=NOW() WHERE id=?",[req.auth.id,id]);
        await applySalesReturnFinance(conn,d,items,req.auth.id);
        if(d.document_kind==='sales_return'){
          for(const item of items)if(item.source_item_id){const result=await syncSalesReturnOrder(conn,d,item,req.auth.id);if(result)orderResults.push(result);}
        }else{
          for(const item of items.filter(x=>x.source_item_id)){
            await conn.query("UPDATE sales_documents sd JOIN sales_document_items si ON si.document_id=sd.id SET sd.status=IF(si.related_quantity>=si.quantity,'completed','partial'),sd.closed_at=IF(si.related_quantity>=si.quantity,COALESCE(sd.closed_at,NOW()),NULL),sd.close_note=IF(si.related_quantity>=si.quantity,'銷貨已全部交付，訂單結案',NULL) WHERE si.id=?",[item.source_item_id]);
          }
        }
      });
      res.json({ok:true,data:{id,status:'posted',order_results:orderResults}});
    }catch(e){next(e);}
  });
  app.get('/api/sales-workflow/statistics',async(req,res,next)=>{
    try{
      await ensureTargetSalesWorkflowSchema();
      const db=sourceDbFromRequest(req),context=ctx(db);
      const groupBy=trim(req.query.group_by||'customer_item').toLowerCase();
      const groupDefinitions={
        customer:{label:'依客戶',select:['d.customer_code AS customer_code','NULL AS item_code','NULL AS item_name','NULL AS salesperson_code','NULL AS period_code','NULL AS document_type','NULL AS document_no','NULL AS document_date'],group:['d.customer_code'],order:['d.customer_code']},
        item:{label:'依品號',select:['NULL AS customer_code','i.item_code AS item_code','i.item_name AS item_name','NULL AS salesperson_code','NULL AS period_code','NULL AS document_type','NULL AS document_no','NULL AS document_date'],group:['i.item_code','i.item_name'],order:['i.item_code']},
        salesperson:{label:'依業務員',select:['NULL AS customer_code','NULL AS item_code','NULL AS item_name','d.salesperson_code AS salesperson_code','NULL AS period_code','NULL AS document_type','NULL AS document_no','NULL AS document_date'],group:['d.salesperson_code'],order:['d.salesperson_code']},
        period:{label:'依期間（月）',select:["DATE_FORMAT(d.document_date,'%Y-%m') AS period_code",'NULL AS customer_code','NULL AS item_code','NULL AS item_name','NULL AS salesperson_code','NULL AS document_type','NULL AS document_no','NULL AS document_date'],group:["DATE_FORMAT(d.document_date,'%Y-%m')"],order:["DATE_FORMAT(d.document_date,'%Y-%m')"]},
        customer_item:{label:'依客戶／品號',select:['d.customer_code AS customer_code','i.item_code AS item_code','i.item_name AS item_name','NULL AS salesperson_code','NULL AS period_code','NULL AS document_type','NULL AS document_no','NULL AS document_date'],group:['d.customer_code','i.item_code','i.item_name'],order:['d.customer_code','i.item_code']},
        customer_salesperson:{label:'依客戶／業務員',select:['d.customer_code AS customer_code','NULL AS item_code','NULL AS item_name','d.salesperson_code AS salesperson_code','NULL AS period_code','NULL AS document_type','NULL AS document_no','NULL AS document_date'],group:['d.customer_code','d.salesperson_code'],order:['d.customer_code','d.salesperson_code']},
        item_salesperson:{label:'依品號／業務員',select:['NULL AS customer_code','i.item_code AS item_code','i.item_name AS item_name','d.salesperson_code AS salesperson_code','NULL AS period_code','NULL AS document_type','NULL AS document_no','NULL AS document_date'],group:['i.item_code','i.item_name','d.salesperson_code'],order:['i.item_code','d.salesperson_code']},
        period_customer:{label:'依期間／客戶',select:["DATE_FORMAT(d.document_date,'%Y-%m') AS period_code",'d.customer_code AS customer_code','NULL AS item_code','NULL AS item_name','NULL AS salesperson_code','NULL AS document_type','NULL AS document_no','NULL AS document_date'],group:["DATE_FORMAT(d.document_date,'%Y-%m')",'d.customer_code'],order:["DATE_FORMAT(d.document_date,'%Y-%m')",'d.customer_code']},
        period_item:{label:'依期間／品號',select:["DATE_FORMAT(d.document_date,'%Y-%m') AS period_code",'NULL AS customer_code','i.item_code AS item_code','i.item_name AS item_name','NULL AS salesperson_code','NULL AS document_type','NULL AS document_no','NULL AS document_date'],group:["DATE_FORMAT(d.document_date,'%Y-%m')",'i.item_code','i.item_name'],order:["DATE_FORMAT(d.document_date,'%Y-%m')",'i.item_code']},
        period_salesperson:{label:'依期間／業務員',select:["DATE_FORMAT(d.document_date,'%Y-%m') AS period_code",'NULL AS customer_code','NULL AS item_code','NULL AS item_name','d.salesperson_code AS salesperson_code','NULL AS document_type','NULL AS document_no','NULL AS document_date'],group:["DATE_FORMAT(d.document_date,'%Y-%m')",'d.salesperson_code'],order:["DATE_FORMAT(d.document_date,'%Y-%m')",'d.salesperson_code']},
        detail:{label:'明細（逐筆）',select:['d.customer_code AS customer_code','i.item_code AS item_code','i.item_name AS item_name','d.salesperson_code AS salesperson_code',"DATE_FORMAT(d.document_date,'%Y-%m') AS period_code",'d.document_type AS document_type','d.document_no AS document_no',"DATE_FORMAT(d.document_date,'%Y-%m-%d') AS document_date"],group:['d.id','i.id','d.customer_code','i.item_code','i.item_name','d.salesperson_code','d.document_date','d.document_type','d.document_no'],order:['d.document_date DESC','d.document_no','i.line_no']}
      };
      const definition=groupDefinitions[groupBy];
      if(!definition)throw badRequest('不支援的銷售統計彙總方式');
      const closure=trim(req.query.closure||'all').toLowerCase();
      if(!['open','closed','all'].includes(closure))throw badRequest('不支援的銷售統計結案篩選');
      const readDate=value=>{const text=trim(value);return text?validDate(text):null;};
      const fromDate=readDate(req.query.from_date||req.query.date_from),toDate=readDate(req.query.to_date||req.query.date_to);
      if(fromDate&&toDate&&fromDate>toDate)throw badRequest('銷售統計日期起日不可晚於迄日');
      const limit=Math.min(Math.max(Number(req.query.limit)||2000,1),5000);
      const where=['d.tenant_id=?','d.company_id=?','d.source_system=?','d.source_database=?',"d.document_kind='sales_order'"];
      const params=[context.tenant_id,context.company_id,context.source_system,db];
      if(closure==='open')where.push("d.status IN ('approved','partial')");
      else if(closure==='closed')where.push("d.status IN ('completed','closed')");
      else where.push("d.status NOT IN ('draft','voided')");
      if(fromDate){where.push('d.document_date>=?');params.push(fromDate);}
      if(toDate){where.push('d.document_date<=?');params.push(toDate);}
      const addEqual=(value,expression)=>{const text=trim(value);if(text){where.push(`${expression}=?`);params.push(text);}};
      const addRange=(from,to,expression)=>{const start=trim(from),end=trim(to);if(start){where.push(`${expression}>=?`);params.push(start);}if(end){where.push(`${expression}<=?`);params.push(end);}};
      addEqual(req.query.document_type||req.query.order_type,'d.document_type');
      addEqual(req.query.customer_code,'d.customer_code');
      addRange(req.query.customer_from,req.query.customer_to,'d.customer_code');
      addEqual(req.query.item_code,'i.item_code');
      addRange(req.query.item_from,req.query.item_to,'i.item_code');
      addEqual(req.query.salesperson_code,'d.salesperson_code');
      addRange(req.query.salesperson_from,req.query.salesperson_to,'d.salesperson_code');
      addEqual(req.query.warehouse_code,'COALESCE(i.warehouse_code,d.warehouse_code)');
      const quantityExpr='GREATEST(COALESCE(i.quantity,0),0)';
      const deliveredExpr=`LEAST(GREATEST(COALESCE(i.related_quantity,0),0),${quantityExpr})`;
      const remainingExpr=`GREATEST(${quantityExpr}-${deliveredExpr},0)`;
      const orderAmountExpr=`GREATEST((${quantityExpr}*COALESCE(i.unit_price,0))-COALESCE(i.allowance_amount,0),0)`;
      const deliveredAmountExpr=`(${deliveredExpr}*COALESCE(i.unit_price,0))`;
      const remainingAmountExpr=`GREATEST(${orderAmountExpr}-${deliveredAmountExpr},0)`;
      const metrics=[
        'COUNT(DISTINCT d.id) AS document_count','COUNT(*) AS line_count',
        `SUM(${quantityExpr}) AS order_quantity`,
        `SUM(${deliveredExpr}) AS delivered_quantity`,
        `SUM(${remainingExpr}) AS remaining_quantity`,
        `SUM(${orderAmountExpr}) AS order_amount`,
        `SUM(${deliveredAmountExpr}) AS delivered_amount`,
        `SUM(${remainingAmountExpr}) AS remaining_amount`,
        `SUM(CASE WHEN ${remainingExpr}>${EPS} OR d.status IN ('approved','partial') THEN 1 ELSE 0 END) AS open_line_count`,
        `SUM(CASE WHEN ${remainingExpr}<=${EPS} AND d.status IN ('completed','closed') THEN 1 ELSE 0 END) AS closed_line_count`,
        "GROUP_CONCAT(DISTINCT d.status ORDER BY d.status SEPARATOR ',') AS status_codes",
        `CASE WHEN SUM(CASE WHEN ${remainingExpr}>${EPS} OR d.status IN ('approved','partial') THEN 1 ELSE 0 END)>0 THEN 'open' ELSE 'closed' END AS progress_status`
      ];
      const fromSql='FROM sales_documents d JOIN sales_document_items i ON i.document_id=d.id';
      const whereSql=`WHERE ${where.join(' AND ')}`;
      const groupSql=[...definition.group,'d.currency_code'].join(',');
      const orderSql=definition===groupDefinitions.detail?definition.order.join(','):['remaining_amount DESC',...definition.order,'d.currency_code'].join(',');
      const [rows]=await pool.query(`SELECT ${definition.select.join(',')},d.currency_code AS currency_code,${metrics.join(',')} ${fromSql} ${whereSql} GROUP BY ${groupSql} ORDER BY ${orderSql} LIMIT ?`,[...params,limit]);
      const [[summaryRow]]=await pool.query(`SELECT COUNT(DISTINCT d.id) AS document_count,COUNT(*) AS line_count,
        COALESCE(SUM(${quantityExpr}),0) AS order_quantity,
        COALESCE(SUM(${deliveredExpr}),0) AS delivered_quantity,
        COALESCE(SUM(${remainingExpr}),0) AS remaining_quantity,
        COALESCE(SUM(${orderAmountExpr}),0) AS order_amount,
        COALESCE(SUM(${deliveredAmountExpr}),0) AS delivered_amount,
        COALESCE(SUM(${remainingAmountExpr}),0) AS remaining_amount,
        COALESCE(SUM(CASE WHEN ${remainingExpr}>${EPS} OR d.status IN ('approved','partial') THEN 1 ELSE 0 END),0) AS open_line_count,
        COALESCE(SUM(CASE WHEN ${remainingExpr}<=${EPS} AND d.status IN ('completed','closed') THEN 1 ELSE 0 END),0) AS closed_line_count
        ${fromSql} ${whereSql}` ,params);
      const numericKeys=['document_count','line_count','order_quantity','delivered_quantity','remaining_quantity','order_amount','delivered_amount','remaining_amount','open_line_count','closed_line_count'];
      const summary=Object.fromEntries(numericKeys.map(key=>[key,summaryRow?.[key]??0]));
      const outputRows=rows.map(row=>({...row,group_by:groupBy,group_label:definition.label}));
      res.json({ok:true,data:{report_code:'COPR20',report_name:'客戶接單／銷售統計彙總',source_database:db,company_id:context.company_id,target_database:sourceDatabases[db]?.target_database||null,from_date:fromDate,to_date:toDate,group_by:groupBy,group_label:definition.label,closure,limit,rows:outputRows,summary,excluded_statuses:['draft','voided'],reconciliation:'依目前公司別目標 ERP 的已核准／已完成訂單進度彙總；已交量沿用訂單明細已關聯量，草稿與作廢不列入；不同幣別分開彙總，接單／跟催仍可獨立查詢。'}});
    }catch(e){next(e);}
  });
  app.get('/api/sales-workflow/progress',async(req,res,next)=>{try{const db=String(req.query.source_database||'SH').toUpperCase(),limit=Math.min(Math.max(Number(req.query.limit)||10,1),100);const[rows]=await pool.query(`SELECT d.document_no,d.document_date,d.customer_code,d.status,i.item_code,i.item_name,i.quantity,i.related_quantity,i.quantity-i.related_quantity remaining_quantity,i.unit_price,(i.quantity-i.related_quantity)*i.unit_price remaining_amount,i.expected_date FROM sales_documents d JOIN sales_document_items i ON i.document_id=d.id WHERE d.source_database=? AND d.document_kind='sales_order' ORDER BY d.document_date DESC,d.id DESC LIMIT ?`,[db,limit]);res.json({ok:true,data:rows});}catch(e){next(e);}});
  app.get('/api/sales-workflow/orders-for-reopen',async(req,res,next)=>{try{await ensureTargetSalesWorkflowSchema();const db=String(req.query.source_database||'SH').toUpperCase(),limit=Math.min(Math.max(Number(req.query.limit)||100,1),500);const[rows]=await pool.query(`SELECT d.id order_id,d.document_no,d.document_date,d.customer_code,d.status order_status,
      i.id order_item_id,i.item_code,i.item_name,i.quantity,i.related_quantity,
      i.quantity-i.related_quantity remaining_quantity,
      CASE WHEN d.status IN ('completed','closed') AND i.related_quantity=0 AND NOT EXISTS(
        SELECT 1 FROM sales_document_items si JOIN sales_documents sd ON sd.id=si.document_id AND sd.document_kind='shipment' AND sd.status='posted'
        LEFT JOIN erp_reversal_documents rv ON rv.source_kind='sales_document' AND rv.source_document_id=sd.id AND rv.status='posted'
        WHERE si.source_item_id=i.id AND rv.id IS NULL
      ) THEN 1 ELSE 0 END reopen_ready,
      CASE WHEN d.status IN ('approved','partial') THEN 1 ELSE 0 END can_change
      FROM sales_documents d JOIN sales_document_items i ON i.document_id=d.id
      WHERE d.source_database=? AND d.document_kind='sales_order' AND d.status<>'voided'
      ORDER BY d.document_date DESC,d.id DESC,i.line_no LIMIT ?`,[db,limit]);res.json({ok:true,data:rows});}catch(e){next(e);}});
  app.post('/api/sales-workflow/orders/:id/reopen',async(req,res,next)=>{try{await ensureTargetSalesWorkflowSchema();const id=Number(req.params.id),db=String(req.body?.source_database||req.query.source_database||'SH').toUpperCase(),note=trim(req.body?.note)||'銷貨沖回完成，受控解結／重開訂單';await tx(async conn=>{const[[order]]=await conn.query("SELECT * FROM sales_documents WHERE id=? AND source_database=? AND document_kind='sales_order' FOR UPDATE",[id,db]);if(!order)throw badRequest('找不到指定訂單');if(!['completed','closed'].includes(order.status))throw badRequest('只有已結案訂單可以執行解結／重開');const[[remaining]]=await conn.query('SELECT COALESCE(SUM(related_quantity),0) quantity FROM sales_document_items WHERE document_id=?',[id]);if(Number(remaining.quantity)>0.000001)throw badRequest('訂單仍有已交量，請先完成銷貨沖回');const[[unreversed]]=await conn.query(`SELECT COUNT(*) count FROM sales_document_items si JOIN sales_documents sd ON sd.id=si.document_id AND sd.document_kind='shipment' AND sd.status='posted' LEFT JOIN erp_reversal_documents rv ON rv.source_kind='sales_document' AND rv.source_document_id=sd.id AND rv.status='posted' WHERE si.source_item_id IN (SELECT id FROM sales_document_items WHERE document_id=?) AND rv.id IS NULL`,[id]);if(Number(unreversed.count)>0)throw badRequest('仍有未沖回的已過帳銷貨單，不能解結');await conn.query(`UPDATE sales_documents SET status='approved',reopened_by=?,reopened_at=NOW(),reopen_note=?,closed_by=NULL,closed_at=NULL,close_note=NULL,note=TRIM(CONCAT(COALESCE(note,''),CASE WHEN COALESCE(note,'')='' THEN '' ELSE '；' END,?)) WHERE id=?`,[req.auth.id,note,note,id]);});res.json({ok:true,data:{id,status:'approved',message:'訂單已受控解結／重開，請建立變更草稿並重新核准'}});}catch(e){next(e);}});
  app.get('/api/sales-workflow/order-changes',async(req,res,next)=>{try{const db=String(req.query.source_database||'SH').toUpperCase(),c=ctx(db),limit=Math.min(Math.max(Number(req.query.limit)||10,1),100);const[rows]=await pool.query(`SELECT c.*,d.document_no,i.item_code,i.item_name FROM sales_order_changes c JOIN sales_document_items i ON i.id=c.order_item_id JOIN sales_documents d ON d.id=i.document_id WHERE c.tenant_id=? AND c.company_id=? AND c.source_system=? AND c.source_database=? ORDER BY c.change_date DESC,c.id DESC LIMIT ?`,[c.tenant_id,c.company_id,c.source_system,db,limit]);res.json({ok:true,data:rows});}catch(e){next(e);}});
  app.get('/api/sales-workflow/order-versions',async(req,res,next)=>{try{await ensureTargetSalesWorkflowSchema();const db=String(req.query.source_database||'SH').toUpperCase(),c=ctx(db),orderId=Number(req.query.order_id||0),limit=Math.min(Math.max(Number(req.query.limit)||100,1),500),where=['tenant_id=?','company_id=?','source_system=?','source_database=?'],params=[c.tenant_id,c.company_id,c.source_system,db];if(orderId){where.push('order_id=?');params.push(orderId);}const[rows]=await pool.query(`SELECT * FROM sales_order_versions WHERE ${where.join(' AND ')} ORDER BY order_id,version_no DESC LIMIT ?`,[...params,limit]);res.json({ok:true,data:rows});}catch(e){next(e);}});
  app.post('/api/sales-workflow/order-changes',async(req,res,next)=>{try{await ensureTargetSalesWorkflowSchema();const b=req.body||{},db=String(b.source_database||'SH').toUpperCase(),c=ctx(db),date=validDate(b.change_date),itemId=Number(b.order_item_id),reason=trim(b.reason);if(!reason)throw badRequest('請輸入訂單變更原因');const out=await tx(async conn=>{const[[i]]=await conn.query("SELECT i.*,d.id order_id,d.status order_status,d.source_database FROM sales_document_items i JOIN sales_documents d ON d.id=i.document_id WHERE i.id=? AND d.source_database=? AND d.document_kind='sales_order' FOR UPDATE",[itemId,db]);if(!i||!['approved','partial'].includes(i.order_status))throw badRequest('訂單尚未解結／重開，或已結案不可直接變更');const qty=positiveNumber(b.new_quantity,'變更數量');if(qty<Number(i.related_quantity))throw badRequest('變更數量不可小於已銷貨量');const no=trim(b.change_no)||await nextWorkflowNumber(conn,'sales_order_changes','change_no','OC',date),newPrice=Number(b.new_unit_price??i.unit_price),newExpectedDate=nullableDate(b.new_expected_date);const[r]=await conn.query(`INSERT INTO sales_order_changes(tenant_id,company_id,source_system,source_database,change_no,order_item_id,change_date,old_quantity,old_unit_price,old_expected_date,new_quantity,new_unit_price,new_expected_date,reason,status,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?)`,[c.tenant_id,c.company_id,c.source_system,db,no,itemId,date,Number(i.quantity),Number(i.unit_price),i.expected_date,qty,newPrice,newExpectedDate,reason,req.auth.id]);return{id:r.insertId,change_no:no,order_id:i.order_id};});res.status(201).json({ok:true,data:out});}catch(e){next(e);}});
  app.post('/api/sales-workflow/order-changes/:id/approve',async(req,res,next)=>{try{await ensureTargetSalesWorkflowSchema();const id=Number(req.params.id);let versionNo=null,appliedStatus=null;await tx(async conn=>{const[[c]]=await conn.query("SELECT c.*,i.id order_item_id,i.quantity old_quantity_current,i.related_quantity,i.unit_price old_unit_price_current,i.expected_date old_expected_date_current,i.document_id,d.id order_id,d.status order_status,d.source_database FROM sales_order_changes c JOIN sales_document_items i ON i.id=c.order_item_id JOIN sales_documents d ON d.id=i.document_id WHERE c.id=? AND c.status='draft' FOR UPDATE",[id]);if(!c)throw badRequest('找不到待核準變更單');if(!['approved','partial'].includes(c.order_status))throw badRequest('訂單尚未解結／重開，不能核准變更');if(Number(c.new_quantity)<Number(c.related_quantity))throw badRequest('變更數量不可小於已銷貨量');const context=ctx(String(c.source_database).toUpperCase()),order={id:c.order_id,status:c.order_status},beforeItem={id:c.order_item_id,quantity:c.old_quantity_current,related_quantity:c.related_quantity,unit_price:c.old_unit_price_current},afterItem={...beforeItem,quantity:c.new_quantity,unit_price:c.new_unit_price,expected_date:c.new_expected_date},delivered=Number(c.related_quantity||0),newQuantity=Number(c.new_quantity||0);appliedStatus=delivered<=EPS?'approved':delivered+EPS>=newQuantity?(c.order_status==='closed'?'closed':'completed'):'partial';await conn.query('UPDATE sales_document_items SET quantity=?,unit_price=?,expected_date=? WHERE id=?',[c.new_quantity,c.new_unit_price,c.new_expected_date,c.order_item_id]);if(['completed','closed'].includes(appliedStatus))await conn.query("UPDATE sales_documents SET status=?,closed_by=?,closed_at=NOW(),close_note='訂單變更核准後已全部交付，訂單結案',note=TRIM(CONCAT(COALESCE(note,''),CASE WHEN COALESCE(note,'')='' THEN '' ELSE '；' END,'訂單變更已核准')) WHERE id=?",[appliedStatus,req.auth.id,c.document_id]);else await conn.query("UPDATE sales_documents SET status=?,closed_by=NULL,closed_at=NULL,close_note=NULL,note=TRIM(CONCAT(COALESCE(note,''),CASE WHEN COALESCE(note,'')='' THEN '' ELSE '；' END,'訂單變更已核准，可重新建立／核准銷貨')) WHERE id=?",[appliedStatus,c.document_id]);versionNo=await recordSalesOrderVersion(conn,context,order,beforeItem,afterItem,{change_kind:'order_change',source_kind:'sales_order_change',source_document_id:id,source_document_no:c.change_no,after_status:appliedStatus,reason:c.reason,changed_by:req.auth.id});await conn.query("UPDATE sales_order_changes SET status='approved',version_no=?,applied_at=NOW(),approved_by=?,approved_at=NOW() WHERE id=?",[versionNo,req.auth.id,id]);});res.json({ok:true,data:{id,version_no:versionNo,status:appliedStatus,message:'訂單變更已核准，版本已保留'}});}catch(e){next(e);}});
  app.post('/api/sales-workflow/create',async(req,res,next)=>{
    try{
      await ensureTargetSalesPricingSchema();
      await ensureTargetSalesForecastSchema();
       const b=req.body||{},db=sourceDbFromRequest(req),c=await ensure(db),date=validDate(b.document_date),kind=trim(b.document_kind),customerCode=trim(b.customer_code),itemCode=trim(b.item_code);
       await syncCanonicalMaster(db, 'currencies');
      const [[dt]]=await pool.query(`SELECT * FROM sales_document_types
        WHERE tenant_id=? AND company_id=? AND source_system=? AND document_kind=? AND type_code=?
          AND (source_database=? OR source_database IS NULL OR source_database='') AND is_active=1`,[
        c.tenant_id,c.company_id,c.source_system,kind,trim(b.document_type),db
      ]);
      if(!dt||!customerCode||!itemCode)throw badRequest('單據性質、客戶與品號不可空白');
      assertConfiguredSource(dt,null,false,'銷售單據');
      const qty=positiveNumber(b.quantity,'數量');
      const out=await tx(async conn=>{
        const no=trim(b.document_no)||await nextConfiguredDocumentNumber(conn,'sales_documents','document_no',dt,date),inv=['shipment','sales_return'].includes(kind)?'pending':'not_applicable',status=documentTypeNeedsApproval(dt)?'draft':'approved';
        const document={document_kind:kind,document_type:dt.type_code,document_no:no,document_date:date,customer_code:customerCode,currency_code:trim(b.currency_code)||null};
         const price=await resolveSalesDocumentPrice(conn,c,document,{item_code:itemCode,item_name:trim(b.item_name),specification:trim(b.specification),unit:trim(b.unit)||'PCS',quantity:qty,unit_price:b.unit_price});
         const forecastLink=kind==='sales_order'?await resolveSalesForecastOrderLink(conn,c,{forecast_item_id:b.forecast_item_id,forecast_no:b.forecast_no,document_date:date,customer_code:customerCode,item_code:itemCode,warehouse_code:trim(b.warehouse_code),quantity:qty}):null;
         const warehouseCode=forecastLink?.warehouse_code||trim(b.warehouse_code)||null;
         const [h]=await conn.query(`INSERT INTO sales_documents(
          tenant_id,company_id,source_system,source_database,document_kind,document_type,document_no,document_date,
          customer_code,currency_code,warehouse_code,return_type,status,inventory_status,note,created_by,approved_by,approved_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[
          c.tenant_id,c.company_id,c.source_system,db,kind,dt.type_code,no,date,customerCode,price.currencyCode,warehouseCode,
          kind==='sales_return'?(trim(b.return_type)||'return'):null,status,inv,trim(b.note),req.auth.id,
          documentTypeNeedsApproval(dt)?null:req.auth.id,documentTypeNeedsApproval(dt)?null:new Date()
        ]);
        const [i]=await conn.query(`INSERT INTO sales_document_items(
           document_id,line_no,forecast_item_id,forecast_no,item_code,item_name,specification,unit,warehouse_code,quantity,unit_price,unit_cost,
           expected_date,allowance_amount,price_source_kind,price_source_id,price_source_no,price_source_date,price_rule_id,price_tier_id)
           VALUES(?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[
           h.insertId,forecastLink?.forecast_item_id||Number(b.forecast_item_id||0)||null,forecastLink?.forecast_no||trim(b.forecast_no)||null,price.itemCode,trim(b.item_name),trim(b.specification),price.pricingUnit,warehouseCode,qty,price.unitPrice,
          Number(b.unit_cost||0),nullableDate(b.expected_date),Number(b.allowance_amount||0),price.price_source_kind,price.price_source_id,
          price.price_source_no,price.price_source_date,price.price_rule_id,price.price_tier_id
        ]);
        let priceUpdate=null;
        if(status==='approved'&&Number(dt.update_customer_price)) priceUpdate=await upsertSalesPriceFromDocument(conn,c,{...document,id:h.insertId},{...price,unit:price.pricingUnit},req.auth.id);
         if(status==='approved'&&forecastLink) await refreshSalesForecastMetrics(conn,c,forecastLink.forecast_id);
         return{id:h.insertId,item_id:i.insertId,document_no:no,status,forecast_item_id:forecastLink?.forecast_item_id||null,forecast_no:forecastLink?.forecast_no||null,price_source_kind:price.price_source_kind,price_rule_id:price.price_rule_id,price_tier_id:price.price_tier_id,price_update:priceUpdate};
      });
      res.status(201).json({ok:true,data:out});
    }catch(e){next(e);}
  });
}

function registerSalesReturnInspectionRoutes(app) {
  app.post('/api/sales-workflow/documents/:id/inspect-return', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const sourceDatabase = String(req.body?.source_database || req.query.source_database || req.get('X-Source-Database') || 'SH').toUpperCase();
      const result = trim(req.body?.result || 'accepted');
      if (!['accepted', 'rejected'].includes(result)) throw badRequest('銷退驗收結果錯誤');
      await tx(async conn => {
        const [[document]] = await conn.query('SELECT * FROM sales_documents WHERE id=? AND source_database=? FOR UPDATE', [id, sourceDatabase]);
        if (!document || document.document_kind !== 'sales_return' || document.return_type !== 'return') throw badRequest('只有銷退類型的銷退單需要驗收');
        if (document.status !== 'approved' || document.inventory_status !== 'pending') throw badRequest('銷退必須先核准且尚未完成驗收');
        const note = `銷退驗收：${result === 'accepted' ? '合格，可辦理入庫' : '不合格，不入庫'}（${new Date().toISOString().slice(0, 10)}）`;
        await conn.query(`UPDATE sales_documents SET inventory_status=?,status=?,note=TRIM(CONCAT(COALESCE(note,''),CASE WHEN COALESCE(note,'')='' THEN '' ELSE '；' END,?)) WHERE id=?`, [result, result === 'accepted' ? 'approved' : 'voided', note, id]);
      });
      res.json({ ok: true, data: { id, inventory_status: result, status: result === 'accepted' ? 'approved' : 'voided' } });
    } catch (error) { next(error); }
  });

  app.use('/api/sales-workflow/documents/:id/post', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const sourceDatabase = String(req.body?.source_database || req.query.source_database || req.get('X-Source-Database') || 'SH').toUpperCase();
      const [[document]] = await pool.query('SELECT document_kind,return_type,status,inventory_status FROM sales_documents WHERE id=? AND source_database=?', [id, sourceDatabase]);
      if (document && document.document_kind === 'sales_return' && document.return_type === 'return' && (document.status !== 'approved' || document.inventory_status !== 'accepted')) throw badRequest('銷退必須先完成驗收，驗收合格後才能回庫過帳');
      next();
    } catch (error) { next(error); }
  });
}

function flowDateRange(query) {
  const today = new Date().toISOString().slice(0, 10);
  const from = validDate(query.from_date || query.date_from || '2000-01-01');
  const to = validDate(query.to_date || query.date_to || today);
  if (from > to) throw badRequest('日期起日不可晚於迄日');
  const asOf = validDate(query.as_of_date || query.as_of || to);
  return { from, to, asOf };
}

function flowAmount(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

const FLOW_AUDIT_EPSILON = 0.000001;

function flowDateValue(value) {
  if (!value) return null;
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function flowEarliestDate(...values) {
  return values.map(flowDateValue).filter(Boolean).sort()[0] || null;
}

function flowDaysLate(date, asOf) {
  const due = flowDateValue(date);
  const end = flowDateValue(asOf);
  if (!due || !end || due >= end) return 0;
  return Math.floor((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86400000);
}

function flowAgingBucket(days) {
  const value = Math.max(Number(days) || 0, 0);
  if (!value) return '未逾期';
  if (value <= 30) return '逾期 1–30 天';
  if (value <= 60) return '逾期 31–60 天';
  if (value <= 90) return '逾期 61–90 天';
  return '逾期 90 天以上';
}

function flowMergeText(...values) {
  return [...new Set(values.flatMap(value => String(value || '').split('、')).map(value => value.trim()).filter(Boolean))].join('、');
}

function flowAuditContext(sourceDatabase) {
  const source = sourceDatabases[String(sourceDatabase || '').toUpperCase()];
  if (!source) throw badRequest(`找不到資料來源：${sourceDatabase}`);
  return {
    tenant_id: source.tenant_id || 'default', company_id: source.company_id || source.key,
    source_system: source.source_system || source.adapter_code || 'iSM', source_database: String(source.key).toUpperCase()
  };
}

function salesReturnAmount(row) {
  const gross = flowAmount(row.return_quantity) * flowAmount(row.return_unit_price);
  const allowance = flowAmount(row.return_allowance_amount);
  return row.return_type === 'allowance' ? Math.max(allowance || gross, 0) : Math.max(gross - allowance, 0);
}

async function loadFinanceTraceMap(sourceDatabase, accountType, sourceKinds, sourceItemIds) {
  if (!sourceItemIds.length) return new Map();
  const [rows] = await pool.query(`
    SELECT vs.source_kind, vs.source_document_item_id,
      SUM(CASE WHEN v.status<>'voided' THEN vs.allocated_amount ELSE 0 END) billed_amount,
      SUM(CASE WHEN v.status<>'voided' AND oi.id IS NOT NULL AND v.total_amount<>0
        THEN oi.settled_amount * vs.allocated_amount / v.total_amount ELSE 0 END) collected_amount,
      GROUP_CONCAT(DISTINCT CASE WHEN v.status<>'voided' THEN v.voucher_no END ORDER BY v.voucher_date,v.id SEPARATOR '、') voucher_nos,
      GROUP_CONCAT(DISTINCT CASE WHEN v.status<>'voided' THEN v.status END ORDER BY v.status SEPARATOR '、') voucher_statuses,
      GROUP_CONCAT(DISTINCT CASE WHEN v.status<>'voided' THEN COALESCE(oi.status,'未立帳') END ORDER BY oi.status SEPARATOR '、') open_item_statuses,
      MIN(CASE WHEN v.status<>'voided' THEN oi.due_date END) due_date
    FROM finance_voucher_sources vs
    JOIN finance_vouchers v ON v.id=vs.voucher_id AND v.source_database=? AND v.account_type=?
    LEFT JOIN finance_open_items oi ON oi.source_kind='finance_voucher' AND oi.source_document_id=v.id
    WHERE vs.source_kind IN (?) AND vs.source_document_item_id IN (?)
    GROUP BY vs.source_kind,vs.source_document_item_id`,
    [sourceDatabase, accountType, sourceKinds, sourceItemIds]);
  const [settlements] = await pool.query(`
    SELECT vs.source_kind,vs.source_document_item_id,
      GROUP_CONCAT(DISTINCT s.settlement_no ORDER BY s.settlement_date,s.id SEPARATOR '、') settlement_nos,
      GROUP_CONCAT(DISTINCT s.status ORDER BY s.status SEPARATOR '、') settlement_statuses
    FROM finance_voucher_sources vs
    JOIN finance_vouchers v ON v.id=vs.voucher_id AND v.source_database=? AND v.account_type=? AND v.status<>'voided'
    JOIN finance_open_items oi ON oi.source_kind='finance_voucher' AND oi.source_document_id=v.id
    JOIN finance_allocations a ON a.open_item_id=oi.id
    JOIN finance_settlements s ON s.id=a.settlement_id
    WHERE vs.source_kind IN (?) AND vs.source_document_item_id IN (?)
    GROUP BY vs.source_kind,vs.source_document_item_id`,
    [sourceDatabase, accountType, sourceKinds, sourceItemIds]);
  const settlementMap=new Map(settlements.map(row=>[row.source_kind+':'+row.source_document_item_id,row]));
  const emptyTrace=()=>({
    billed:0,collected:0,due_date:null,voucher_nos:'',voucher_statuses:'',open_item_statuses:'',settlement_nos:'',settlement_statuses:'',
    return_amount:0,return_offset_amount:0,return_credit_amount:0,return_refund_amount:0,return_pending_amount:0,
    customer_credit_balance:0,customer_credit_original:0,customer_credit_applied:0,return_adjustment_statuses:''
  });
  const traceMap=new Map();
  const mergeList=(oldValue,newValue)=>{
    const values=[String(oldValue||''),String(newValue||'')].flatMap(value=>value.split('、')).map(value=>value.trim()).filter(Boolean);
    return [...new Set(values)].join('、');
  };
  for(const row of rows){
    const settlement=settlementMap.get(row.source_kind+':'+row.source_document_item_id)||{};
    traceMap.set(row.source_kind+':'+row.source_document_item_id,{
      ...emptyTrace(),
      billed:flowAmount(row.billed_amount),collected:flowAmount(row.collected_amount),
      voucher_nos:row.voucher_nos||'',voucher_statuses:row.voucher_statuses||'',
      open_item_statuses:row.open_item_statuses||'',due_date:flowDateValue(row.due_date),settlement_nos:settlement.settlement_nos||'',
      settlement_statuses:settlement.settlement_statuses||''
    });
  }
  if(sourceKinds.includes('shipment')){
    const context=salesReturnFinanceContext(sourceDatabase);
    const[directRows]=await pool.query(`SELECT si.id shipment_item_id,oi.id open_item_id,
        oi.original_amount,oi.settled_amount,oi.status,oi.due_date,
        CASE WHEN COALESCE(totals.total_amount,0)>0
          THEN GREATEST(si.quantity*si.unit_price-COALESCE(si.allowance_amount,0),0)/totals.total_amount ELSE 1 END line_ratio,
        GROUP_CONCAT(DISTINCT oi.document_no ORDER BY oi.document_date,oi.id SEPARATOR '、') direct_open_item_nos,
        GROUP_CONCAT(DISTINCT oi.status ORDER BY oi.status SEPARATOR '、') direct_open_item_statuses
      FROM finance_open_items oi
      JOIN sales_documents sd ON sd.id=oi.source_document_id AND sd.source_database=?
      JOIN sales_document_items si ON si.document_id=sd.id AND si.id IN (?)
      LEFT JOIN (
        SELECT document_id,SUM(GREATEST(quantity*unit_price-COALESCE(allowance_amount,0),0)) total_amount
        FROM sales_document_items GROUP BY document_id
      ) totals ON totals.document_id=si.document_id
      WHERE oi.tenant_id=? AND oi.company_id=? AND oi.source_system=? AND oi.source_database=?
        AND oi.account_type=? AND oi.source_kind='shipment'
        AND oi.status IN ('approved','open','partial','settled')
      GROUP BY si.id,oi.id,oi.original_amount,oi.settled_amount,oi.status,oi.due_date,totals.total_amount`,
      [sourceDatabase,sourceItemIds,context.tenant_id,context.company_id,context.source_system,sourceDatabase,accountType]);
    for(const row of directRows){
      const key='shipment:'+row.shipment_item_id,current=traceMap.get(key)||emptyTrace(),ratio=Number(row.line_ratio||1)||1;
      current.billed+=flowAmount(row.original_amount)*ratio;
      current.collected+=flowAmount(row.settled_amount)*ratio;
      current.voucher_nos=mergeList(current.voucher_nos,row.direct_open_item_nos);
      current.open_item_statuses=mergeList(current.open_item_statuses,row.direct_open_item_statuses);
      current.due_date=flowEarliestDate(current.due_date,row.due_date);
      traceMap.set(key,current);
    }
    const[directSettlements]=await pool.query(`SELECT si.id shipment_item_id,
        GROUP_CONCAT(DISTINCT s.settlement_no ORDER BY s.settlement_date,s.id SEPARATOR '、') settlement_nos,
        GROUP_CONCAT(DISTINCT s.status ORDER BY s.status SEPARATOR '、') settlement_statuses
      FROM finance_open_items oi
      JOIN sales_documents sd ON sd.id=oi.source_document_id AND sd.source_database=?
      JOIN sales_document_items si ON si.document_id=sd.id AND si.id IN (?)
      JOIN finance_allocations a ON a.open_item_id=oi.id
      JOIN finance_settlements s ON s.id=a.settlement_id
      WHERE oi.tenant_id=? AND oi.company_id=? AND oi.source_system=? AND oi.source_database=?
        AND oi.account_type=? AND oi.source_kind='shipment'
      GROUP BY si.id`,
      [sourceDatabase,sourceItemIds,context.tenant_id,context.company_id,context.source_system,sourceDatabase,accountType]);
    for(const row of directSettlements){
      const key='shipment:'+row.shipment_item_id,current=traceMap.get(key)||emptyTrace();
      current.settlement_nos=mergeList(current.settlement_nos,row.settlement_nos);
      current.settlement_statuses=mergeList(current.settlement_statuses,row.settlement_statuses);
      traceMap.set(key,current);
    }
  }
  const[returnRows]=await pool.query(`SELECT a.sales_return_item_id,a.shipment_item_id,
      SUM(a.return_amount) return_amount,SUM(a.receivable_offset_amount) return_offset_amount,
      SUM(a.customer_credit_amount) return_credit_amount,SUM(a.refund_amount) return_refund_amount,
      SUM(GREATEST(a.return_amount-a.receivable_offset_amount-a.customer_credit_amount,0)) return_pending_amount,
      COALESCE(SUM(cc.original_amount),0) customer_credit_original,
      COALESCE(SUM(cc.applied_amount),0) customer_credit_applied,
      COALESCE(SUM(cc.balance_amount),0) customer_credit_balance,
      GROUP_CONCAT(DISTINCT a.status ORDER BY a.status SEPARATOR '、') return_adjustment_statuses
    FROM finance_return_adjustments a
    LEFT JOIN finance_customer_credits cc ON cc.source_adjustment_id=a.id
    WHERE a.tenant_id=? AND a.company_id=? AND a.source_system=? AND a.source_database=?
      AND (a.sales_return_item_id IN (?) OR a.shipment_item_id IN (?))
    GROUP BY a.sales_return_item_id,a.shipment_item_id`,[salesReturnFinanceContext(sourceDatabase).tenant_id,salesReturnFinanceContext(sourceDatabase).company_id,salesReturnFinanceContext(sourceDatabase).source_system,sourceDatabase,sourceItemIds,sourceItemIds]);
  const mergeReturn=(key,row)=>{
    const current=traceMap.get(key)||emptyTrace();
    current.return_amount+=flowAmount(row.return_amount);
    current.return_offset_amount+=flowAmount(row.return_offset_amount);
    current.return_credit_amount+=flowAmount(row.return_credit_amount);
    current.return_refund_amount+=flowAmount(row.return_refund_amount);
    current.return_pending_amount+=flowAmount(row.return_pending_amount);
    current.customer_credit_original+=flowAmount(row.customer_credit_original);
    current.customer_credit_applied+=flowAmount(row.customer_credit_applied);
    current.customer_credit_balance+=flowAmount(row.customer_credit_balance);
    current.return_adjustment_statuses=mergeList(current.return_adjustment_statuses,row.return_adjustment_statuses);
    traceMap.set(key,current);
  };
  for(const row of returnRows){
    if(Number(row.sales_return_item_id||0))mergeReturn('sales_return:'+row.sales_return_item_id,row);
    if(Number(row.shipment_item_id||0))mergeReturn('shipment:'+row.shipment_item_id,row);
  }
  return traceMap;
}

function sumFlow(rows, field) {
  return rows.reduce((sum, row) => sum + flowAmount(row[field]), 0);
}

const inventoryAuditMovementNames = {
  issue: '其他出庫', return: '其他退料', adjust_in: '庫存增加調整', adjust_out: '庫存減少調整',
  scrap: '庫存報廢', cost_adjust: '庫存成本調整', transfer: '庫存轉撥', stocktake: '庫存盤點',
  temp_in: '暫入', temp_in_return: '暫入歸還', temp_out: '暫出', temp_out_return: '暫出歸還'
};

async function loadSupplementalInventoryAudit(sourceDatabase, from, to, limit) {
  const [documents] = await pool.query(`
    SELECT d.id document_id,d.document_no,d.document_type,d.movement_kind,d.document_date,d.status,
      d.counterparty,d.note,i.id item_id,i.item_code,i.item_name,i.unit,
      i.from_warehouse_code,i.to_warehouse_code,i.quantity,i.counted_quantity,i.unit_cost,
      i.amount_delta,i.reason
    FROM inventory_documents d
    JOIN inventory_document_items i ON i.document_id=d.id
    WHERE d.source_database=? AND d.document_date BETWEEN ? AND ?
    ORDER BY d.document_date DESC,d.id DESC,i.line_no
    LIMIT ?`, [sourceDatabase, from, to, limit]);
  return documents.map(row => {
    const name = inventoryAuditMovementNames[row.movement_kind] || row.movement_kind || '庫存補充單據';
    const quantity = row.movement_kind === 'stocktake' ? flowAmount(row.counted_quantity) : flowAmount(row.quantity);
    const status = String(row.status || 'draft');
    const nextStage = status === 'draft' ? '待核准補充單據' : status === 'approved' ? '待庫存過帳' : status === 'posted' ? '已完成庫存異動' : '已作廢';
    const exception = status === 'posted' || status === 'voided' ? '' : `補充單據尚未完成${status === 'draft' ? '核准' : '過帳'}`;
    return {
      root_kind: 'inventory_supplement', root_type: '合法補充／暫出入／轉撥起點', is_legal_root: 1, is_orphan: 0,
      source: `${name} ${row.document_no}`, document_no: row.document_no, document_type: row.document_type,
      source_kind: 'inventory_supplement', source_document_id: Number(row.document_id), source_document_item_id: Number(row.item_id),
      source_document_no: row.document_no, source_date: row.document_date, expected_date: null, due_date: null,
      document_date: row.document_date, item_code: row.item_code, item_name: row.item_name, unit: row.unit,
      warehouse_code: row.from_warehouse_code || row.to_warehouse_code || '', currency_code: 'TWD',
      movement_kind: row.movement_kind, movement_status: status, from_warehouse_code: row.from_warehouse_code || '',
      to_warehouse_code: row.to_warehouse_code || '', counterparty: row.counterparty || '', quantity,
      quantity_delta: row.movement_kind === 'transfer' ? 0 : ['return', 'adjust_in', 'temp_in', 'temp_out_return'].includes(row.movement_kind) ? quantity : -quantity,
      amount: row.movement_kind === 'cost_adjust' ? flowAmount(row.amount_delta) : quantity * flowAmount(row.unit_cost),
      remaining_quantity: 0, remaining_amount: 0, financial_impact: 0,
      next_stage: nextStage, exception_reason: exception,
      audit_status: exception ? `需處理：${exception}` : '流程完成', note: row.reason || row.note || ''
    };
  });
}

function flowRowSourceKey(row, flowKind) {
  const sourceKind = row.source_kind || row.root_kind || `${flowKind}_flow`;
  const sourceId = row.source_document_id || row.order_id || row.purchase_order_id || row.shipment_id || row.receipt_id || row.return_id || row.quote_id || row.requisition_id || row.document_id || '';
  const itemId = row.source_document_item_id || row.order_item_id || row.purchase_order_item_id || row.shipment_item_id || row.receipt_item_id || row.return_item_id || row.quote_item_id || row.requisition_item_id || row.item_id || '';
  return `${flowKind}:${sourceKind}:${sourceId || row.source_document_no || row.source || 'unknown'}:${itemId || row.item_code || ''}`;
}

function flowExpectedOverdue(row, asOf) {
  const pendingQuantity = flowAmount(row.remaining_quantity) > FLOW_AUDIT_EPSILON
    || flowAmount(row.pending_inspection_quantity) > FLOW_AUDIT_EPSILON
    || flowAmount(row.pending_inventory_quantity) > FLOW_AUDIT_EPSILON
    || flowAmount(row.quote_remaining_quantity) > FLOW_AUDIT_EPSILON
    || flowAmount(row.requisition_remaining_quantity) > FLOW_AUDIT_EPSILON
    || ['待轉訂單', '待轉採購', '待進貨', '待銷貨'].includes(row.next_stage);
  return pendingQuantity ? flowDaysLate(row.expected_date, asOf) : 0;
}

function flowFinancialImpact(row, flowKind) {
  if (flowKind === 'sales') {
    return Math.max(flowAmount(row.unbilled_amount), 0)
      + Math.max(flowAmount(row.uncollected_amount), 0)
      + Math.max(flowAmount(row.return_pending_amount), 0)
      + Math.max(flowAmount(row.customer_credit_balance), 0);
  }
  if (flowKind === 'procurement') {
    return Math.max(flowAmount(row.unbilled_amount), 0) + Math.max(flowAmount(row.unpaid_amount), 0);
  }
  return Math.abs(flowAmount(row.amount_delta ?? row.amount));
}

function enrichFlowAuditResult(result, flowKind, asOf) {
  const rows = [...(result.rows || []), ...(result.supplemental_rows || [])];
  for (const row of rows) {
    row.source_kind = row.source_kind || row.root_kind || `${flowKind}_flow`;
    row.source_document_id = row.source_document_id || row.order_id || row.purchase_order_id || row.shipment_id || row.receipt_id || row.return_id || row.quote_id || row.requisition_id || row.document_id || null;
    row.source_document_item_id = row.source_document_item_id || row.order_item_id || row.purchase_order_item_id || row.shipment_item_id || row.receipt_item_id || row.return_item_id || row.quote_item_id || row.requisition_item_id || row.item_id || null;
    row.source_document_no = row.source_document_no || row.order_no || row.purchase_order_no || row.shipment_no || row.receipt_no || row.return_no || row.quote_no || row.requisition_no || row.document_no || row.source || null;
    row.source_date = flowDateValue(row.source_date || row.order_date || row.document_date);
    row.expected_date = flowDateValue(row.expected_date || row.item_expected_date || row.order_expected_date || row.quote_expected_date);
    row.due_date = flowEarliestDate(row.due_date);
    row.currency_code = row.currency_code || row.order_currency_code || row.quote_currency_code || 'TWD';
    row.warehouse_code = row.warehouse_code || row.from_warehouse_code || row.to_warehouse_code || '';
    row.remaining_amount = flowAmount(row.remaining_amount);
    if (row.remaining_amount <= FLOW_AUDIT_EPSILON) {
      if (flowKind === 'sales' && flowAmount(row.order_amount) > FLOW_AUDIT_EPSILON) row.remaining_amount = Math.max(flowAmount(row.order_amount) - flowAmount(row.delivered_amount), 0);
      if (flowKind === 'procurement' && flowAmount(row.order_amount) > FLOW_AUDIT_EPSILON) row.remaining_amount = Math.max(flowAmount(row.order_amount) - flowAmount(row.received_amount), 0);
      if (flowKind === 'sales' && flowAmount(row.quote_amount) > FLOW_AUDIT_EPSILON) row.remaining_amount = flowAmount(row.quote_amount);
    }
    row.expected_overdue_days = flowExpectedOverdue(row, asOf);
    row.accounting_overdue_days = flowDaysLate(row.due_date, asOf);
    row.overdue_days = Math.max(row.expected_overdue_days, row.accounting_overdue_days);
    row.overdue = row.overdue_days > 0 ? 1 : 0;
    row.overdue_basis = row.expected_overdue_days && row.accounting_overdue_days ? '交期／帳款'
      : row.expected_overdue_days ? '交期／預計日' : row.accounting_overdue_days ? '帳款到期日' : '';
    const pendingFinancial = flowFinancialImpact(row, flowKind);
    row.financial_impact = flowAmount(row.financial_impact);
    if (row.financial_impact <= FLOW_AUDIT_EPSILON) row.financial_impact = pendingFinancial;
    row.aging_bucket = row.accounting_overdue_days || pendingFinancial > FLOW_AUDIT_EPSILON
      ? flowAgingBucket(row.accounting_overdue_days)
      : row.expected_overdue_days ? `交期逾期 ${row.expected_overdue_days} 天` : '無未結帳款';
    const reasons = [row.exception_reason].filter(Boolean);
    if (row.overdue_days > 0 && !reasons.some(value => String(value).includes('逾期'))) reasons.push(`${row.overdue_basis}逾期 ${row.overdue_days} 天`);
    if (pendingFinancial > FLOW_AUDIT_EPSILON && !row.due_date && !String(row.exception_reason || '').includes('到期日')) reasons.push('未設定帳款到期日');
    row.exception_reason = reasons.join('；');
    if (row.exception_reason) row.audit_status = `需處理：${row.exception_reason}`;
    row.source_key = flowRowSourceKey(row, flowKind);
  }
  const allRows = rows;
  const summary = result.summary || {};
  summary.overdue_count = allRows.filter(row => row.overdue).length;
  summary.overdue_quantity = allRows.filter(row => row.overdue).reduce((sum, row) => sum + flowRecommendationRemainingQuantity(row), 0);
  summary.overdue_amount = allRows.reduce((sum, row) => sum + (row.overdue ? flowAmount(row.financial_impact) : 0), 0);
  summary.financial_impact = sumFlow(allRows, 'financial_impact');
  summary.remaining_amount = sumFlow(allRows, 'remaining_amount');
  summary.aging = allRows.reduce((out, row) => {
    if (row.financial_impact > FLOW_AUDIT_EPSILON || row.overdue) out[row.aging_bucket] = (out[row.aging_bucket] || 0) + 1;
    return out;
  }, {});
  summary.next_stage = allRows.reduce((out, row) => { out[row.next_stage] = (out[row.next_stage] || 0) + 1; return out; }, {});
  summary.completed_count = allRows.filter(row => row.audit_status === '流程完成').length;
  summary.exception_count = allRows.filter(row => row.audit_status !== '流程完成').length;
  return { ...result, summary };
}

function flowNextStageSales(row) {
  const eps = 0.000001;
  if (row.remaining_quantity > eps) return '待銷貨';
  if (row.return_pending_amount > eps || row.return_unbilled_amount > eps) return '待同步應收沖帳';
  if (row.customer_credit_balance > eps) return '待退款／待抵';
  if (row.unbilled_amount > eps) return '待轉應收';
  if (row.billed_amount > eps && row.uncollected_amount > eps) return '待收款';
  if (row.returned_amount > eps && row.return_pending_amount <= eps && row.customer_credit_balance <= eps && row.uncollected_amount <= eps) return '已沖銷應收／已收款';
  if (row.over_collected_amount > eps) return '待退款／沖抵';
  if (row.billed_amount > eps && row.uncollected_amount <= eps) return '已收款';
  if (row.returned_amount > eps && row.delivered_amount > eps && row.returned_amount >= row.delivered_amount - eps) return '已沖銷應收';
  return '待銷售流程';
}

function flowNextStagePurchase(row) {
  const eps = 0.000001;
  if (row.pending_inspection_quantity > eps) return '待驗收';
  if (row.pending_inventory_quantity > eps) return '待入庫';
  if (row.remaining_quantity > eps) return '待進貨';
  if (row.unbilled_amount > eps) return '待轉應付';
  if (row.billed_amount > eps && row.unpaid_amount > eps) return '待付款';
  if (row.billed_amount > eps && row.unpaid_amount <= eps) return '已付款';
  return '待採購流程';
}

function flowExceptionSales(row) {
  const eps=0.000001;
  if (row.order_status==='draft') return '訂單尚未核准';
  if (row.remaining_quantity>eps && ['completed','closed'].includes(row.order_status)) return '訂單已結案但仍有未交量';
  if (row.remaining_quantity>eps) return `尚有 ${row.remaining_quantity} 未銷貨`;
  if (row.delivered_quantity>eps && !row.shipment_nos) return '已交量與銷貨單追蹤不一致';
  if (row.return_pending_amount>eps || row.return_unbilled_amount>eps) return `銷退／折讓尚有 ${row.return_pending_amount || row.return_unbilled_amount} 未同步應收沖帳`;
  if (row.customer_credit_balance>eps) return `客戶待抵尚有 ${row.customer_credit_balance} 未轉抵／退款`;
  if (row.unbilled_amount>eps) return `銷貨已完成但尚有 ${row.unbilled_amount} 未轉應收`;
  if (row.over_collected_amount>eps && row.returned_amount<=eps) return `應收收款超過立帳金額 ${row.over_collected_amount}，待退款／沖抵`;
  if (row.billed_amount>eps && row.uncollected_amount>eps) return `應收尚有 ${row.uncollected_amount} 未收款`;
  return '';
}

function flowExceptionPurchase(row) {
  const eps=0.000001;
  if (row.purchase_status==='draft') return '採購單尚未核准';
  if (row.remaining_quantity>eps && ['completed','closed'].includes(row.purchase_status)) return '採購單已結案但仍有未交量';
  if (row.pending_inspection_quantity>eps) return `尚有 ${row.pending_inspection_quantity} 待驗收`;
  if (row.pending_inventory_quantity>eps) return `尚有 ${row.pending_inventory_quantity} 待入庫過帳`;
  if (row.remaining_quantity>eps) return `尚有 ${row.remaining_quantity} 待進貨`;
  if (row.unbilled_amount>eps) return `進貨已完成但尚有 ${row.unbilled_amount} 未轉應付`;
  if (row.billed_amount>eps && row.unpaid_amount>eps) return `應付尚有 ${row.unpaid_amount} 未付款`;
  return '';
}

async function buildSalesFlowAudit(sourceDatabase, from, to, limit, asOf = to) {
  const [orders] = await pool.query(`
    SELECT d.id order_id,d.document_no order_no,d.document_type order_document_type,d.document_date order_date,d.customer_code,d.currency_code order_currency_code,
      d.status order_status,i.id order_item_id,i.line_no,i.item_code,i.item_name,i.unit,
      i.quantity order_quantity,i.related_quantity,i.unit_price,i.expected_date,i.warehouse_code,
      q.document_no quote_no,q.document_date quote_date,q.status quote_status
    FROM sales_documents d
    JOIN sales_document_items i ON i.document_id=d.id
    LEFT JOIN sales_document_items qi ON qi.id=i.source_item_id
    LEFT JOIN sales_documents q ON q.id=qi.document_id AND q.document_kind='quotation'
    WHERE d.source_database=? AND d.document_kind='sales_order' AND d.document_date BETWEEN ? AND ?
    ORDER BY d.document_date DESC,d.id DESC,i.line_no
    LIMIT ?`, [sourceDatabase, from, to, limit]);
  const [unconvertedQuotes] = await pool.query(`
    SELECT q.id quote_id,q.document_no quote_no,q.document_date quote_date,q.status quote_status,q.customer_code,q.currency_code quote_currency_code,
      qi.id quote_item_id,qi.item_code,qi.item_name,qi.unit,qi.quantity quote_quantity,qi.unit_price,qi.warehouse_code,qi.expected_date quote_expected_date,
      COALESCE((SELECT SUM(oi.quantity)
        FROM sales_document_items oi JOIN sales_documents od ON od.id=oi.document_id
        WHERE oi.source_item_id=qi.id AND od.source_database=? AND od.document_kind='sales_order'),0) linked_order_quantity
    FROM sales_documents q JOIN sales_document_items qi ON qi.document_id=q.id
    WHERE q.source_database=? AND q.document_kind='quotation' AND q.document_date BETWEEN ? AND ?
      AND COALESCE((SELECT SUM(oi.quantity)
        FROM sales_document_items oi JOIN sales_documents od ON od.id=oi.document_id
        WHERE oi.source_item_id=qi.id AND od.source_database=? AND od.document_kind='sales_order'),0)<qi.quantity
    ORDER BY q.document_date DESC,q.id DESC,qi.line_no
    LIMIT ?`, [sourceDatabase, sourceDatabase, from, to, sourceDatabase, limit]);
  const [standaloneShipments] = await pool.query(`
    SELECT d.id shipment_id,i.id shipment_item_id,i.source_item_id order_item_id,oi.id source_item_exists,od.id source_order_id,
      d.document_no shipment_no,
      d.document_type shipment_document_type,d.document_date shipment_date,d.status shipment_status,
      d.inventory_status shipment_inventory_status,d.customer_code,d.currency_code,
      i.item_code,i.item_name,i.unit,i.quantity shipment_quantity,i.unit_price shipment_unit_price,
      i.unit_cost shipment_unit_cost,i.warehouse_code,i.expected_date
    FROM sales_documents d
    JOIN sales_document_items i ON i.document_id=d.id
    LEFT JOIN sales_document_items oi ON oi.id=i.source_item_id
    LEFT JOIN sales_documents od ON od.id=oi.document_id AND od.document_kind='sales_order'
    WHERE d.source_database=? AND d.document_kind='shipment' AND d.document_date BETWEEN ? AND ?
      AND od.id IS NULL
    ORDER BY d.document_date DESC,d.id DESC,i.line_no
    LIMIT ?`, [sourceDatabase, from, to, limit]);
  const orderItemIds = orders.map(row => Number(row.order_item_id));
  const [shipments] = orderItemIds.length ? await pool.query(`
    SELECT d.id shipment_id,i.id shipment_item_id,i.source_item_id order_item_id,d.document_no shipment_no,
      d.document_date shipment_date,d.status shipment_status,i.quantity shipment_quantity,
      i.unit_price shipment_unit_price,i.warehouse_code,i.expected_date
    FROM sales_documents d JOIN sales_document_items i ON i.document_id=d.id
    WHERE d.source_database=? AND d.document_kind='shipment' AND i.source_item_id IN (?)
    ORDER BY d.document_date,d.id,i.line_no`, [sourceDatabase, orderItemIds]) : [[]];
  const shipmentItemIds = shipments.map(row => Number(row.shipment_item_id));
  const [returns] = shipmentItemIds.length ? await pool.query(`
    SELECT d.id return_id,i.id return_item_id,i.source_item_id shipment_item_id,d.document_no return_no,
      d.document_date return_date,d.status return_status,d.inventory_status return_inventory_status,d.return_type,i.quantity return_quantity,
      i.unit_price return_unit_price,i.allowance_amount return_allowance_amount,i.warehouse_code
    FROM sales_documents d JOIN sales_document_items i ON i.document_id=d.id
    WHERE d.source_database=? AND d.document_kind='sales_return' AND d.status='posted'
      AND i.source_item_id IN (?)
    ORDER BY d.document_date,d.id,i.line_no`, [sourceDatabase, shipmentItemIds]) : [[]];
  const [allReturnsInRange] = await pool.query(`
    SELECT d.id return_id,i.id return_item_id,i.source_item_id return_source_item_id,d.document_no return_no,d.document_date return_date,
      d.customer_code,d.return_type,d.status return_status,d.inventory_status return_inventory_status,i.item_code,i.item_name,i.quantity return_quantity,
      i.unit_price return_unit_price,i.allowance_amount return_allowance_amount,i.warehouse_code
    FROM sales_documents d JOIN sales_document_items i ON i.document_id=d.id
    WHERE d.source_database=? AND d.document_kind='sales_return'
      AND d.document_date BETWEEN ? AND ?
    ORDER BY d.document_date DESC,d.id DESC,i.line_no LIMIT ?`, [sourceDatabase, from, to, limit]);
  const allShipmentItemIds = [...new Set([...shipmentItemIds, ...standaloneShipments.map(row => Number(row.shipment_item_id))])];
  const allReturnItemIds = [...new Set([...returns.map(row => Number(row.return_item_id)), ...allReturnsInRange.map(row => Number(row.return_item_id))])];
  const finance = await loadFinanceTraceMap(sourceDatabase, 'AR', ['shipment','sales_return'], [...allShipmentItemIds, ...allReturnItemIds]);
  const byOrderItem = new Map();
  for (const shipment of shipments) {
    const key = Number(shipment.order_item_id);
    const list = byOrderItem.get(key) || [];
    list.push(shipment);
    byOrderItem.set(key, list);
  }
  const returnsByShipmentItem = new Map();
  for (const item of returns) {
    const key = Number(item.shipment_item_id);
    const list = returnsByShipmentItem.get(key) || [];
    list.push(item);
    returnsByShipmentItem.set(key, list);
  }
  const representedReturnIds = new Set(returns.map(row => Number(row.return_item_id)));
  const extraReturns = allReturnsInRange.filter(row => !representedReturnIds.has(Number(row.return_item_id)));
  const rows = orders.map(order => {
    const children = byOrderItem.get(Number(order.order_item_id)) || [];
    const returnChildren = children.flatMap(shipment => returnsByShipmentItem.get(Number(shipment.shipment_item_id)) || []);
    const delivered = children.filter(row => row.shipment_status === 'posted').reduce((sum, row) => sum + flowAmount(row.shipment_quantity), 0);
    const deliveredAmount = children.filter(row => row.shipment_status === 'posted').reduce((sum, row) => sum + flowAmount(row.shipment_quantity) * flowAmount(row.shipment_unit_price || order.unit_price), 0);
    const shipmentBilled = children.reduce((sum, row) => sum + flowAmount(finance.get(`shipment:${row.shipment_item_id}`)?.billed), 0);
    const shipmentCollected = children.reduce((sum, row) => sum + flowAmount(finance.get(`shipment:${row.shipment_item_id}`)?.collected), 0);
    const returnedAmount = returnChildren.reduce((sum, row) => sum + salesReturnAmount(row), 0);
    const returnBilled = returnChildren.reduce((sum, row) => sum + flowAmount(finance.get(`sales_return:${row.return_item_id}`)?.billed), 0);
    const returnTraces = returnChildren.map(row => finance.get(`sales_return:${row.return_item_id}`) || {});
    const returnOffset = returnTraces.reduce((sum, row) => sum + flowAmount(row.return_offset_amount), 0);
    const returnCredit = returnTraces.reduce((sum, row) => sum + flowAmount(row.return_credit_amount), 0);
    const returnRefund = returnTraces.reduce((sum, row) => sum + flowAmount(row.return_refund_amount), 0);
    const returnCreditBalance = returnTraces.reduce((sum, row) => sum + flowAmount(row.customer_credit_balance), 0);
    const returnCollected = returnTraces.reduce((sum, row) => sum + flowAmount(row.collected), 0);
    const returnUnbilled = returnChildren.reduce((sum, row) => {
      const trace = finance.get(`sales_return:${row.return_item_id}`);
      return sum + (trace && flowAmount(trace.return_amount) > 0
        ? flowAmount(trace.return_pending_amount)
        : Math.max(salesReturnAmount(row) - Math.abs(flowAmount(trace?.billed)), 0));
    }, 0);
    const billed = shipmentBilled + returnBilled - returnOffset - returnCredit;
    const collected = shipmentCollected + returnCollected;
    const trace = [...children.map(row => finance.get(`shipment:${row.shipment_item_id}`)), ...returnChildren.map(row => finance.get(`sales_return:${row.return_item_id}`))].filter(Boolean);
    const orderQuantity = flowAmount(order.order_quantity);
    const orderAmount = orderQuantity * flowAmount(order.unit_price);
    const row = {
      source: order.quote_no ? `報價 ${order.quote_no} → 訂單 ${order.order_no}` : ['2120'].includes(String(order.order_document_type)) ? `合約／專案訂單 ${order.order_no}` : `獨立訂單 ${order.order_no}`,
      root_kind: 'sales_order', root_type: order.quote_no ? '報價轉訂單' : ['2120'].includes(String(order.order_document_type)) ? '合約／專案訂單' : '獨立訂單',
      is_legal_root: 1, is_orphan: 0, trace_kind: order.quote_no ? '報價已轉訂單' : '合法獨立起點',
      source_kind: 'sales_order', source_document_id: Number(order.order_id), source_document_item_id: Number(order.order_item_id),
      source_document_no: order.order_no, source_date: order.order_date, expected_date: order.expected_date || null,
      due_date: flowEarliestDate(...trace.map(item => item.due_date)), party_code: order.customer_code || '',
      warehouse_code: order.warehouse_code || '', currency_code: order.order_currency_code || 'TWD',
      quote_no: order.quote_no || '', order_no: order.order_no, shipment_nos: children.map(x => x.shipment_no).join('、'),
      shipment_statuses: [...new Set(children.map(x => x.shipment_status).filter(Boolean))].join('、'),
      ar_voucher_nos: [...new Set(trace.flatMap(x => String(x.voucher_nos||'').split('、').filter(Boolean)))].join('、'),
      ar_voucher_statuses: [...new Set(trace.flatMap(x => String(x.voucher_statuses||'').split('、').filter(Boolean)))].join('、'),
      ar_open_item_statuses: [...new Set(trace.flatMap(x => String(x.open_item_statuses||'').split('、').filter(Boolean)))].join('、'),
      ar_settlement_nos: [...new Set(trace.flatMap(x => String(x.settlement_nos||'').split('、').filter(Boolean)))].join('、'),
      ar_settlement_statuses: [...new Set(trace.flatMap(x => String(x.settlement_statuses||'').split('、').filter(Boolean)))].join('、'),
      customer_code: order.customer_code, order_date: order.order_date, item_code: order.item_code, item_name: order.item_name,
      order_quantity: orderQuantity, delivered_quantity: delivered, returned_quantity: returnChildren.reduce((sum, row) => sum + (row.return_type === 'allowance' ? 0 : flowAmount(row.return_quantity)), 0), remaining_quantity: Math.max(orderQuantity - delivered, 0),
      order_amount: orderAmount, remaining_amount: Math.max(orderAmount - deliveredAmount, 0), delivered_amount: deliveredAmount, returned_amount: returnedAmount, billed_amount: billed, collected_amount: collected,
      unbilled_amount: Math.max(deliveredAmount - shipmentBilled, 0) + returnUnbilled, return_unbilled_amount: returnUnbilled,
      return_offset_amount: returnOffset, return_credit_amount: returnCredit, return_refund_amount: returnRefund,
      return_pending_amount: returnUnbilled, customer_credit_balance: returnCreditBalance,
      uncollected_amount: Math.max(billed - collected, 0), over_collected_amount: Math.max(collected - billed, 0),
      quote_status: order.quote_status || '', order_status: order.order_status, next_stage: '', exception_reason: ''
    };
    row.next_stage = flowNextStageSales(row);
    row.exception_reason = flowExceptionSales(row);
    row.audit_status = ['已收款','已沖銷應收','已沖銷應收／已收款'].includes(row.next_stage) && !row.exception_reason ? '流程完成' : `需處理：${row.exception_reason || row.next_stage}`;
    return row;
  });
  for (const shipment of standaloneShipments) {
    const trace = finance.get(`shipment:${shipment.shipment_item_id}`) || {};
    const delivered = shipment.shipment_status === 'posted' ? flowAmount(shipment.shipment_quantity) : 0;
    const deliveredAmount = delivered * flowAmount(shipment.shipment_unit_price || shipment.shipment_unit_cost);
    const returnedAmount = flowAmount(trace.return_amount), returnOffset = flowAmount(trace.return_offset_amount);
    const returnCredit = flowAmount(trace.return_credit_amount), returnPending = flowAmount(trace.return_pending_amount);
    const billed = flowAmount(trace.billed) - returnOffset - returnCredit, collected = flowAmount(trace.collected);
    const invalidSource = Number(shipment.order_item_id || 0) > 0 && !Number(shipment.source_order_id || 0);
    const row = {
      source: `${invalidSource ? '孤兒銷貨' : '獨立銷貨'} ${shipment.shipment_no}`, root_kind: invalidSource ? 'orphan_shipment' : 'standalone_shipment', root_type: invalidSource ? '銷貨來源無效／孤兒單據' : '合法獨立銷貨起點',
      is_legal_root: invalidSource ? 0 : 1, is_orphan: invalidSource ? 1 : 0, trace_kind: invalidSource ? '有來源項目但找不到有效訂單' : '合法獨立起點', quote_no: '', order_no: '', shipment_nos: shipment.shipment_no,
      source_kind: invalidSource ? 'orphan_shipment' : 'standalone_shipment', source_document_id: Number(shipment.shipment_id), source_document_item_id: Number(shipment.shipment_item_id),
      source_document_no: shipment.shipment_no, source_date: shipment.shipment_date, expected_date: shipment.expected_date || null,
      due_date: flowDateValue(trace.due_date), party_code: shipment.customer_code || '', warehouse_code: shipment.warehouse_code || '', currency_code: shipment.currency_code || 'TWD',
      shipment_statuses: shipment.shipment_status || '', ar_voucher_nos: trace.voucher_nos || '', ar_voucher_statuses: trace.voucher_statuses || '',
      ar_open_item_statuses: trace.open_item_statuses || '', ar_settlement_nos: trace.settlement_nos || '', ar_settlement_statuses: trace.settlement_statuses || '',
      customer_code: shipment.customer_code || '', order_date: shipment.shipment_date, item_code: shipment.item_code, item_name: shipment.item_name,
      order_quantity: 0, quote_quantity: 0, delivered_quantity: delivered, returned_quantity: Math.max(returnedAmount, 0), remaining_quantity: 0,
      order_amount: 0, remaining_amount: 0, delivered_amount: deliveredAmount, returned_amount: returnedAmount, billed_amount: billed, collected_amount: collected,
      unbilled_amount: Math.max(deliveredAmount - flowAmount(trace.billed), 0) + returnPending, return_unbilled_amount: returnPending,
      return_offset_amount: returnOffset, return_credit_amount: returnCredit, return_refund_amount: flowAmount(trace.return_refund_amount),
      return_pending_amount: returnPending, customer_credit_balance: flowAmount(trace.customer_credit_balance),
      uncollected_amount: Math.max(billed - collected, 0), over_collected_amount: Math.max(collected - billed, 0),
      quote_status: '', order_status: '', next_stage: '', exception_reason: ''
    };
    if (invalidSource) {
      row.next_stage = '待補有效訂單來源';
      row.exception_reason = '銷貨明細有來源項目，但來源不是有效訂單或已不存在';
    } else if (shipment.shipment_status !== 'posted') {
      row.next_stage = '待銷貨確認／過帳';
      row.exception_reason = `獨立銷貨尚未完成${shipment.shipment_status === 'draft' ? '核准／' : ''}過帳`;
    } else {
      row.next_stage = flowNextStageSales(row);
      row.exception_reason = flowExceptionSales(row);
    }
    row.audit_status = row.next_stage === '已收款' && !row.exception_reason ? '流程完成' : `需處理：${row.exception_reason || row.next_stage}`;
    rows.push(row);
  }
  for (const ret of extraReturns) {
    const returnedAmount = salesReturnAmount(ret);
    const isLinkedOutsideRange = Number(ret.return_source_item_id || 0) > 0;
    const trace = finance.get(`sales_return:${ret.return_item_id}`) || {};
    const returnBilled = flowAmount(trace.billed), returnCollected = flowAmount(trace.collected);
    const returnOffset = flowAmount(trace.return_offset_amount), returnCredit = flowAmount(trace.return_credit_amount);
    const returnRefund = flowAmount(trace.return_refund_amount), returnPending = flowAmount(trace.return_pending_amount);
    const customerCreditBalance = flowAmount(trace.customer_credit_balance);
    const hasReturnAdjustment = flowAmount(trace.return_amount) > 0;
    const effectiveReturnPending = hasReturnAdjustment ? returnPending : Math.max(returnedAmount - Math.abs(returnBilled), 0);
    const pendingStatus = !['posted'].includes(String(ret.return_status));
    const exception = pendingStatus ? `銷退／折讓尚未完成驗收／過帳（${ret.return_status || 'unknown'}）` : isLinkedOutsideRange ? '原銷貨／訂單不在目前日期範圍，銷退／折讓尚未併入流程列' : '銷退／折讓未關聯原銷貨，無法完整同步應收';
    rows.push({
      source: `銷退／折讓 ${ret.return_no}`, root_kind: 'sales_return', root_type: isLinkedOutsideRange ? '退回待追蹤' : '退回／折讓起點',
      is_legal_root: isLinkedOutsideRange ? 1 : 0, is_orphan: isLinkedOutsideRange ? 0 : 1, trace_kind: isLinkedOutsideRange ? '來源超出日期範圍' : '未關聯來源單據',
      source_kind: 'sales_return', source_document_id: Number(ret.return_id), source_document_item_id: Number(ret.return_item_id),
      source_document_no: ret.return_no, source_date: ret.return_date, expected_date: null, due_date: flowDateValue(trace.due_date),
      party_code: ret.customer_code || '', warehouse_code: ret.warehouse_code || '', currency_code: 'TWD',
      quote_no: '', order_no: '', shipment_nos: '', customer_code: ret.customer_code || '', order_date: ret.return_date,
      item_code: ret.item_code, item_name: ret.item_name, order_quantity: 0, delivered_quantity: 0,
      returned_quantity: ret.return_type === 'allowance' ? 0 : flowAmount(ret.return_quantity), remaining_quantity: 0,
      order_amount: 0, remaining_amount: 0, delivered_amount: 0, returned_amount: returnedAmount, billed_amount: returnBilled - returnOffset - returnCredit, collected_amount: returnCollected,
      unbilled_amount: effectiveReturnPending, return_unbilled_amount: effectiveReturnPending,
      return_offset_amount: returnOffset, return_credit_amount: returnCredit, return_refund_amount: returnRefund,
      return_pending_amount: effectiveReturnPending, customer_credit_balance: customerCreditBalance,
      uncollected_amount: Math.max(returnBilled - returnOffset - returnCredit - returnCollected, 0), over_collected_amount: Math.max(returnCollected - (returnBilled - returnOffset - returnCredit), 0),
      quote_status: '', order_status: '', shipment_statuses: '', ar_voucher_nos: '', ar_voucher_statuses: '',
      ar_open_item_statuses: trace.open_item_statuses || '', ar_settlement_nos: trace.settlement_nos || '', ar_settlement_statuses: trace.settlement_statuses || '', next_stage: pendingStatus ? '待銷退驗收／過帳' : effectiveReturnPending > 0 ? '待同步應收沖帳' : customerCreditBalance > 0 ? '待退款／待抵' : isLinkedOutsideRange ? '待追蹤原銷貨／應收' : '待關聯原銷貨／應收',
      exception_reason: exception, audit_status: `需處理：${exception}`
    });
  }
  for (const quote of unconvertedQuotes) {
    const quoted = flowAmount(quote.quote_quantity), linked = flowAmount(quote.linked_order_quantity), remaining = Math.max(quoted - linked, 0);
    rows.push({
    source: `報價 ${quote.quote_no}${linked > 0 ? '（部分轉訂單）' : ''}`, root_kind: 'unconverted_quotation', root_type: linked > 0 ? '部分轉訂單報價起點' : '未轉訂單報價起點', is_legal_root: 1, is_orphan: 0, trace_kind: '合法起點尚未轉單',
    source_kind: 'unconverted_quotation', source_document_id: Number(quote.quote_id), source_document_item_id: Number(quote.quote_item_id),
    source_document_no: quote.quote_no, source_date: quote.quote_date, expected_date: quote.quote_expected_date || null, due_date: null,
    party_code: quote.customer_code || '', warehouse_code: quote.warehouse_code || '', currency_code: quote.quote_currency_code || 'TWD',
    quote_no: quote.quote_no, order_no: '', shipment_nos: '', customer_code: quote.customer_code || '', order_date: quote.quote_date,
    item_code: quote.item_code, item_name: quote.item_name, order_quantity: 0, delivered_quantity: 0, remaining_quantity: 0, quote_ordered_quantity: linked, quote_remaining_quantity: remaining,
      order_amount: 0, remaining_amount: remaining * flowAmount(quote.unit_price), delivered_amount: 0, billed_amount: 0, collected_amount: 0, unbilled_amount: 0, uncollected_amount: 0, over_collected_amount: 0,
    quote_quantity: remaining, quote_amount: remaining * flowAmount(quote.unit_price),
    quote_status: quote.quote_status || '', order_status: '', shipment_statuses: '', ar_voucher_nos: '', ar_voucher_statuses: '', ar_open_item_statuses: '', ar_settlement_nos: '', ar_settlement_statuses: '', next_stage: '待轉訂單', exception_reason: `報價尚有 ${remaining} 未轉成訂單`, audit_status: `需處理：報價尚有 ${remaining} 未轉成訂單`, returned_amount: 0, return_unbilled_amount: 0, over_collected_amount: 0
    });
  }
  const quoteSummary = {};
  for (const row of rows) {
    if (!row.quote_no) continue;
    const item = quoteSummary[row.quote_no] || { quote_no: row.quote_no, order_count: 0, order_quantity: 0, ordered_amount: 0 };
    if (row.order_no) { item.order_count += 1; item.order_quantity += row.order_quantity; item.ordered_amount += row.order_amount; }
    quoteSummary[row.quote_no] = item;
  }
  const summary = {
    order_line_count: orders.length, unconverted_quote_count: unconvertedQuotes.length, standalone_shipment_count: standaloneShipments.length,
    legal_root_count: rows.filter(row => row.is_legal_root).length, orphan_count: rows.filter(row => row.is_orphan).length,
    order_count: new Set(rows.map(row => row.order_no).filter(Boolean)).size,
    quote_count: Object.keys(quoteSummary).length, order_quantity: sumFlow(rows, 'order_quantity'), delivered_quantity: sumFlow(rows, 'delivered_quantity'),
    remaining_quantity: sumFlow(rows, 'remaining_quantity'), order_amount: sumFlow(rows, 'order_amount'), delivered_amount: sumFlow(rows, 'delivered_amount'),
    returned_amount: sumFlow(rows, 'returned_amount'), return_offset_amount: sumFlow(rows, 'return_offset_amount'), return_credit_amount: sumFlow(rows, 'return_credit_amount'), return_refund_amount: sumFlow(rows, 'return_refund_amount'), return_pending_amount: sumFlow(rows, 'return_pending_amount'), customer_credit_balance: sumFlow(rows, 'customer_credit_balance'),
    billed_amount: sumFlow(rows, 'billed_amount'), collected_amount: sumFlow(rows, 'collected_amount'), unbilled_amount: sumFlow(rows, 'unbilled_amount'), uncollected_amount: sumFlow(rows, 'uncollected_amount'),
    completed_count: rows.filter(row => row.audit_status === '流程完成').length, exception_count: rows.filter(row => row.audit_status !== '流程完成').length,
    next_stage: rows.reduce((out, row) => { out[row.next_stage] = (out[row.next_stage] || 0) + 1; return out; }, {})
  };
  const supplemental_rows = await loadSupplementalInventoryAudit(sourceDatabase, from, to, limit);
  summary.supplemental_count = supplemental_rows.length;
  summary.next_stage = [...rows, ...supplemental_rows].reduce((out, row) => { out[row.next_stage] = (out[row.next_stage] || 0) + 1; return out; }, {});
  summary.completed_count = [...rows, ...supplemental_rows].filter(row => row.audit_status === '流程完成').length;
  summary.exception_count = [...rows, ...supplemental_rows].filter(row => row.audit_status !== '流程完成').length;
  return enrichFlowAuditResult({ rows, supplemental_rows, summary, quote_summary: Object.values(quoteSummary) }, 'sales', asOf);
}

async function buildPurchaseFlowAudit(sourceDatabase, from, to, limit, asOf = to) {
  const [orders] = await pool.query(`
    SELECT o.id purchase_order_id,o.purchase_order_no,o.document_type purchase_document_type,o.order_date,o.expected_date order_expected_date,o.supplier_code,o.status purchase_status,o.currency_code order_currency_code,
      i.id purchase_order_item_id,i.requisition_item_id,i.item_code,i.item_name,i.unit,
      i.qty_ordered,i.qty_received,i.qty_cancelled,i.unit_price,i.expected_date item_expected_date,i.warehouse_code,r.requisition_no,r.requisition_date,r.status requisition_status,
      ri.qty_requested,ri.qty_ordered req_qty_ordered
    FROM procurement_orders o JOIN procurement_order_items i ON i.purchase_order_id=o.id
    LEFT JOIN procurement_requisition_items ri ON ri.id=i.requisition_item_id
    LEFT JOIN procurement_requisitions r ON r.id=ri.requisition_id
    WHERE o.source_database=? AND o.order_date BETWEEN ? AND ?
    ORDER BY o.order_date DESC,o.id DESC,i.line_no
    LIMIT ?`, [sourceDatabase, from, to, limit]);
  const [unconvertedRequisitions] = await pool.query(`
    SELECT r.id requisition_id,r.requisition_no,r.requisition_date,r.requester_code,r.department_code,r.warehouse_code,r.status requisition_status,
      ri.id requisition_item_id,ri.item_code,ri.item_name,ri.unit,ri.qty_requested,ri.suggested_unit_price,ri.required_date,
      COALESCE(ordered.linked_order_quantity,0) linked_order_quantity
    FROM procurement_requisitions r
    JOIN procurement_requisition_items ri ON ri.requisition_id=r.id
    LEFT JOIN (
      SELECT poi.requisition_item_id,SUM(poi.qty_ordered) linked_order_quantity
      FROM procurement_order_items poi
      JOIN procurement_orders po ON po.id=poi.purchase_order_id AND po.source_database=?
      WHERE poi.requisition_item_id IS NOT NULL
      GROUP BY poi.requisition_item_id
    ) ordered ON ordered.requisition_item_id=ri.id
    WHERE r.source_database=? AND r.requisition_date BETWEEN ? AND ?
      AND COALESCE(ordered.linked_order_quantity,0)<COALESCE(ri.qty_requested,0)
    ORDER BY r.requisition_date DESC,r.id DESC,ri.line_no
    LIMIT ?`, [sourceDatabase, sourceDatabase, from, to, limit]);
  const orderItemIds = orders.map(row => Number(row.purchase_order_item_id));
  const [receipts] = orderItemIds.length ? await pool.query(`
    SELECT r.id receipt_id,i.id receipt_item_id,i.purchase_order_item_id,r.receipt_no,r.receipt_date,r.status receipt_status,
      r.document_type receipt_document_type,r.inventory_status,i.qty_received,i.qty_accepted,i.qty_rejected,
      i.qty_returned,i.unit_cost,i.warehouse_code
    FROM procurement_receipts r JOIN procurement_receipt_items i ON i.receipt_id=r.id
    WHERE r.source_database=? AND i.purchase_order_item_id IN (?)
    ORDER BY r.receipt_date,r.id,i.line_no`, [sourceDatabase, orderItemIds]) : [[]];
  const [standaloneReceipts] = await pool.query(`
    SELECT r.id receipt_id,i.id receipt_item_id,i.purchase_order_item_id,poi.id source_order_item_exists,po.id source_order_id,
      r.receipt_no,r.receipt_date,r.status receipt_status,
      r.document_type receipt_document_type,r.inventory_status,r.supplier_code,r.warehouse_code,
      i.item_code,i.item_name,i.unit,i.qty_received,i.qty_accepted,i.qty_rejected,i.qty_returned,i.unit_cost
    FROM procurement_receipts r
    JOIN procurement_receipt_items i ON i.receipt_id=r.id
    LEFT JOIN procurement_order_items poi ON poi.id=i.purchase_order_item_id
    LEFT JOIN procurement_orders po ON po.id=poi.purchase_order_id AND po.source_database=?
    WHERE r.source_database=? AND r.receipt_date BETWEEN ? AND ? AND po.id IS NULL
    ORDER BY r.receipt_date DESC,r.id DESC,i.line_no
    LIMIT ?`, [sourceDatabase, sourceDatabase, from, to, limit]);
  const receiptItemIds = [...new Set([...receipts, ...standaloneReceipts].map(row => Number(row.receipt_item_id)))];
  const [returns] = receiptItemIds.length ? await pool.query(`
    SELECT r.id return_id,i.id return_item_id,i.receipt_item_id,r.return_no,r.return_date,r.status return_status,
      r.document_type return_document_type,r.return_type,r.inventory_status,i.item_code,i.item_name,
      i.return_quantity,i.allowance_amount,i.unit_cost,i.warehouse_code
    FROM procurement_returns r JOIN procurement_return_items i ON i.return_id=r.id
    WHERE r.source_database=? AND i.receipt_item_id IN (?)
    ORDER BY r.return_date,r.id,i.line_no`, [sourceDatabase, receiptItemIds]) : [[]];
  const [allReturnsInRange] = await pool.query(`
    SELECT r.id return_id,i.id return_item_id,i.receipt_item_id,r.return_no,r.return_date,r.status return_status,
      r.document_type return_document_type,r.return_type,r.inventory_status,r.supplier_code,
      i.item_code,i.item_name,i.return_quantity,i.allowance_amount,i.unit_cost,i.warehouse_code
    FROM procurement_returns r JOIN procurement_return_items i ON i.return_id=r.id
    WHERE r.source_database=? AND r.return_date BETWEEN ? AND ?
    ORDER BY r.return_date DESC,r.id DESC,i.line_no LIMIT ?`, [sourceDatabase, from, to, limit]);
  const allReturnItemIds = [...new Set([...returns, ...allReturnsInRange].map(row => Number(row.return_item_id)))];
  const finance = await loadFinanceTraceMap(sourceDatabase, 'AP', ['purchase_receipt','purchase_return'], [...receiptItemIds, ...allReturnItemIds]);
  const byOrderItem = new Map();
  for (const receipt of receipts) {
    const key = Number(receipt.purchase_order_item_id);
    const list = byOrderItem.get(key) || []; list.push(receipt); byOrderItem.set(key, list);
  }
  const returnsByReceiptItem = new Map();
  for (const item of returns) {
    const key = Number(item.receipt_item_id);
    const list = returnsByReceiptItem.get(key) || []; list.push(item); returnsByReceiptItem.set(key, list);
  }
  const rows = orders.map(order => {
    const children = byOrderItem.get(Number(order.purchase_order_item_id)) || [];
    const accepted = children.reduce((sum, row) => sum + flowAmount(row.qty_accepted), 0);
    const pendingInspection = children.filter(row => ['pending_inspection','draft'].includes(row.receipt_status)).reduce((sum, row) => sum + Math.max(flowAmount(row.qty_received) - flowAmount(row.qty_accepted), 0), 0);
    const pendingInventory = children.filter(row => ['accepted','partially_accepted'].includes(row.receipt_status) && row.inventory_status === 'pending').reduce((sum, row) => sum + flowAmount(row.qty_accepted), 0);
    const billed = children.reduce((sum, row) => sum + flowAmount(finance.get(`purchase_receipt:${row.receipt_item_id}`)?.billed), 0);
    const paid = children.reduce((sum, row) => sum + flowAmount(finance.get(`purchase_receipt:${row.receipt_item_id}`)?.collected), 0);
    const trace = children.map(row => finance.get(`purchase_receipt:${row.receipt_item_id}`)).filter(Boolean);
    const returnChildren = children.flatMap(receipt => returnsByReceiptItem.get(Number(receipt.receipt_item_id)) || []);
    const returnedQuantity = returnChildren.filter(item => item.return_type === 'return' && item.return_status === 'posted').reduce((sum, item) => sum + flowAmount(item.return_quantity), 0);
    const returnedAmount = returnChildren.filter(item => ['posted','approved'].includes(String(item.return_status))).reduce((sum, item) => sum + flowAmount(item.return_quantity) * flowAmount(item.unit_cost) + flowAmount(item.allowance_amount), 0);
    const ordered = flowAmount(order.qty_ordered), cancelled = flowAmount(order.qty_cancelled), remaining = Math.max(ordered - cancelled - accepted, 0);
    const orderAmount = ordered * flowAmount(order.unit_price), receivedAmount = accepted * flowAmount(order.unit_price), unbilled = Math.max(receivedAmount - billed, 0);
    const row = {
      source: order.requisition_no ? `請購 ${order.requisition_no} → 採購 ${order.purchase_order_no}` : `獨立採購 ${order.purchase_order_no}`,
      root_kind: 'purchase_order', root_type: order.requisition_no ? '請購轉採購' : '獨立採購', is_legal_root: 1, is_orphan: 0,
      trace_kind: order.requisition_no ? '請購已轉採購' : '合法獨立起點',
      source_kind: 'purchase_order', source_document_id: Number(order.purchase_order_id), source_document_item_id: Number(order.purchase_order_item_id),
      source_document_no: order.purchase_order_no, source_date: order.order_date,
      expected_date: order.item_expected_date || order.order_expected_date || null,
      due_date: flowEarliestDate(...trace.map(item => item.due_date)), party_code: order.supplier_code || '',
      warehouse_code: order.warehouse_code || '', currency_code: order.order_currency_code || 'TWD',
      requisition_no: order.requisition_no || '', purchase_order_no: order.purchase_order_no, receipt_nos: children.map(x => x.receipt_no).join('、'),
      receipt_statuses: [...new Set(children.map(x => x.receipt_status).filter(Boolean))].join('、'),
      purchase_return_nos: [...new Set(returnChildren.map(x => x.return_no).filter(Boolean))].join('、'),
      purchase_return_statuses: [...new Set(returnChildren.map(x => x.return_status).filter(Boolean))].join('、'),
      ap_voucher_nos: [...new Set(trace.flatMap(x => String(x.voucher_nos||'').split('、').filter(Boolean)))].join('、'),
      ap_voucher_statuses: [...new Set(trace.flatMap(x => String(x.voucher_statuses||'').split('、').filter(Boolean)))].join('、'),
      ap_open_item_statuses: [...new Set(trace.flatMap(x => String(x.open_item_statuses||'').split('、').filter(Boolean)))].join('、'),
      ap_settlement_nos: [...new Set(trace.flatMap(x => String(x.settlement_nos||'').split('、').filter(Boolean)))].join('、'),
      ap_settlement_statuses: [...new Set(trace.flatMap(x => String(x.settlement_statuses||'').split('、').filter(Boolean)))].join('、'),
      supplier_code: order.supplier_code, order_date: order.order_date, item_code: order.item_code, item_name: order.item_name,
      order_quantity: ordered, accepted_quantity: accepted, remaining_quantity: remaining, pending_inspection_quantity: pendingInspection, pending_inventory_quantity: pendingInventory,
      order_amount: orderAmount, remaining_amount: Math.max(orderAmount - receivedAmount, 0), received_amount: receivedAmount, returned_quantity: returnedQuantity, returned_amount: returnedAmount, billed_amount: billed, paid_amount: paid, unbilled_amount: unbilled, unpaid_amount: Math.max(billed - paid, 0),
      requisition_status: order.requisition_status || '', purchase_status: order.purchase_status, next_stage: '', exception_reason: ''
    };
    row.next_stage = flowNextStagePurchase(row);
    row.exception_reason = flowExceptionPurchase(row);
    row.audit_status = row.next_stage === '已付款' && !row.exception_reason ? '流程完成' : `需處理：${row.exception_reason || row.next_stage}`;
    return row;
  });
  for (const req of unconvertedRequisitions) {
    const requested = flowAmount(req.qty_requested), linked = flowAmount(req.linked_order_quantity), remaining = Math.max(requested - linked, 0);
    const exception = req.requisition_status === 'draft' ? '請購尚未核准，尚有未轉採購數量' : `請購尚有 ${remaining} 未轉採購`;
    rows.push({
      source: `請購 ${req.requisition_no}${linked > 0 ? '（部分未轉採購）' : ''}`, root_kind: 'unconverted_requisition', root_type: linked > 0 ? '部分轉採購請購' : '未轉採購請購起點',
      is_legal_root: 1, is_orphan: 0, trace_kind: '合法起點尚未轉單', requisition_no: req.requisition_no, purchase_order_no: '', receipt_nos: '', receipt_statuses: '',
      source_kind: 'unconverted_requisition', source_document_id: Number(req.requisition_id), source_document_item_id: Number(req.requisition_item_id),
      source_document_no: req.requisition_no, source_date: req.requisition_date, expected_date: req.required_date || null, due_date: null,
      party_code: '', warehouse_code: req.warehouse_code || '', currency_code: 'TWD',
      purchase_return_nos: '', purchase_return_statuses: '', ap_voucher_nos: '', ap_voucher_statuses: '', ap_open_item_statuses: '', ap_settlement_nos: '', ap_settlement_statuses: '',
      supplier_code: '', order_date: req.requisition_date, item_code: req.item_code, item_name: req.item_name, order_quantity: 0, requisition_requested_quantity: requested,
      requisition_ordered_quantity: linked, requisition_remaining_quantity: remaining, accepted_quantity: 0, remaining_quantity: 0, pending_inspection_quantity: 0, pending_inventory_quantity: 0,
      order_amount: 0, remaining_amount: remaining * flowAmount(req.suggested_unit_price), received_amount: 0, returned_amount: 0, billed_amount: 0, paid_amount: 0, unbilled_amount: 0, unpaid_amount: 0,
      requisition_status: req.requisition_status || '', purchase_status: '', next_stage: req.requisition_status === 'draft' ? '待核准請購' : '待轉採購', exception_reason: exception,
      audit_status: `需處理：${exception}`
    });
  }
  for (const receipt of standaloneReceipts) {
    const trace = finance.get(`purchase_receipt:${receipt.receipt_item_id}`) || {};
    const returnChildren = returnsByReceiptItem.get(Number(receipt.receipt_item_id)) || [];
    const returnedQuantity = returnChildren.filter(item => item.return_type === 'return' && ['posted','approved'].includes(String(item.return_status))).reduce((sum, item) => sum + flowAmount(item.return_quantity), 0);
    const returnedAmount = returnChildren.filter(item => ['posted','approved'].includes(String(item.return_status))).reduce((sum, item) => sum + flowAmount(item.return_quantity) * flowAmount(item.unit_cost) + flowAmount(item.allowance_amount), 0);
    const accepted = ['accepted','partially_accepted'].includes(String(receipt.receipt_status)) ? flowAmount(receipt.qty_accepted) : 0;
    const pendingInspection = ['pending_inspection','draft'].includes(String(receipt.receipt_status)) ? Math.max(flowAmount(receipt.qty_received) - flowAmount(receipt.qty_accepted), 0) : 0;
    const pendingInventory = ['accepted','partially_accepted'].includes(String(receipt.receipt_status)) && receipt.inventory_status === 'pending' ? accepted : 0;
    const receivedAmount = accepted * flowAmount(receipt.unit_cost), billed = flowAmount(trace.billed), paid = flowAmount(trace.collected);
    const invalidSource = Number(receipt.purchase_order_item_id || 0) > 0 && !Number(receipt.source_order_id || 0);
    const row = {
      source: `${invalidSource ? '孤兒進貨' : '獨立進貨'} ${receipt.receipt_no}`, root_kind: invalidSource ? 'orphan_receipt' : 'standalone_receipt', root_type: invalidSource ? '進貨來源無效／孤兒單據' : '合法獨立進貨起點', is_legal_root: invalidSource ? 0 : 1, is_orphan: invalidSource ? 1 : 0, trace_kind: invalidSource ? '有來源項目但找不到有效採購單' : '合法獨立起點',
      source_kind: invalidSource ? 'orphan_receipt' : 'standalone_receipt', source_document_id: Number(receipt.receipt_id), source_document_item_id: Number(receipt.receipt_item_id),
      source_document_no: receipt.receipt_no, source_date: receipt.receipt_date, expected_date: receipt.expected_date || null, due_date: flowDateValue(trace.due_date),
      party_code: receipt.supplier_code || '', warehouse_code: receipt.warehouse_code || '', currency_code: 'TWD',
      requisition_no: '', purchase_order_no: '', receipt_nos: receipt.receipt_no, receipt_statuses: receipt.receipt_status || '', purchase_return_nos: [...new Set(returnChildren.map(x => x.return_no).filter(Boolean))].join('、'), purchase_return_statuses: [...new Set(returnChildren.map(x => x.return_status).filter(Boolean))].join('、'),
      ap_voucher_nos: trace.voucher_nos || '', ap_voucher_statuses: trace.voucher_statuses || '', ap_open_item_statuses: trace.open_item_statuses || '', ap_settlement_nos: trace.settlement_nos || '', ap_settlement_statuses: trace.settlement_statuses || '',
      supplier_code: receipt.supplier_code || '', order_date: receipt.receipt_date, item_code: receipt.item_code, item_name: receipt.item_name, order_quantity: 0, accepted_quantity: accepted,
      remaining_quantity: 0, pending_inspection_quantity: pendingInspection, pending_inventory_quantity: pendingInventory, order_amount: 0, remaining_amount: 0, received_amount: receivedAmount, returned_quantity: returnedQuantity, returned_amount: returnedAmount,
      billed_amount: billed, paid_amount: paid, unbilled_amount: Math.max(receivedAmount - billed, 0), unpaid_amount: Math.max(billed - paid, 0), requisition_status: '', purchase_status: '', next_stage: '', exception_reason: ''
    };
    if (invalidSource) { row.next_stage = '待補有效採購來源'; row.exception_reason = '進貨明細有來源項目，但來源不是有效採購單或已不存在'; }
    else if (pendingInspection > 0) { row.next_stage = '待驗收'; row.exception_reason = '獨立進貨尚未完成驗收'; }
    else if (pendingInventory > 0) { row.next_stage = '待入庫'; row.exception_reason = '獨立進貨驗收合格但尚未入庫過帳'; }
    else if (row.unbilled_amount > 0) { row.next_stage = '待轉應付'; row.exception_reason = `獨立進貨尚有 ${row.unbilled_amount} 未轉應付`; }
    else if (row.unpaid_amount > 0) { row.next_stage = '待付款'; row.exception_reason = `應付尚有 ${row.unpaid_amount} 未付款`; }
    else { row.next_stage = '已付款'; }
    row.audit_status = row.next_stage === '已付款' && !row.exception_reason ? '流程完成' : `需處理：${row.exception_reason || row.next_stage}`;
    rows.push(row);
  }
  const representedReturnIds = new Set(returns.map(row => Number(row.return_item_id)));
  for (const ret of allReturnsInRange.filter(row => !representedReturnIds.has(Number(row.return_item_id)))) {
    const trace = finance.get(`purchase_return:${ret.return_item_id}`) || {};
    const linkedOutsideRange = Number(ret.receipt_item_id || 0) > 0;
    const pendingStatus = !['posted','approved'].includes(String(ret.return_status));
    const amount = flowAmount(ret.return_quantity) * flowAmount(ret.unit_cost) + flowAmount(ret.allowance_amount);
    const exception = pendingStatus ? `採購退貨／折讓尚未完成核准／過帳（${ret.return_status || 'unknown'}）` : linkedOutsideRange ? '原進貨／採購不在目前日期範圍，退貨／折讓待追蹤' : '採購退貨／折讓未關聯原進貨，無法完整同步應付';
    rows.push({
      source: `採購退貨／折讓 ${ret.return_no}`, root_kind: 'purchase_return', root_type: linkedOutsideRange ? '退回待追蹤' : '退回／折讓起點',
      is_legal_root: linkedOutsideRange ? 1 : 0, is_orphan: linkedOutsideRange ? 0 : 1, trace_kind: linkedOutsideRange ? '來源超出日期範圍' : '未關聯來源單據',
      source_kind: 'purchase_return', source_document_id: Number(ret.return_id), source_document_item_id: Number(ret.return_item_id),
      source_document_no: ret.return_no, source_date: ret.return_date, expected_date: null, due_date: flowDateValue(trace.due_date),
      party_code: ret.supplier_code || '', warehouse_code: ret.warehouse_code || '', currency_code: 'TWD',
      requisition_no: '', purchase_order_no: '', receipt_nos: '', receipt_statuses: '', purchase_return_nos: ret.return_no, purchase_return_statuses: ret.return_status || '',
      ap_voucher_nos: trace.voucher_nos || '', ap_voucher_statuses: trace.voucher_statuses || '', ap_open_item_statuses: trace.open_item_statuses || '', ap_settlement_nos: trace.settlement_nos || '', ap_settlement_statuses: trace.settlement_statuses || '',
      supplier_code: ret.supplier_code || '', order_date: ret.return_date, item_code: ret.item_code, item_name: ret.item_name, order_quantity: 0, accepted_quantity: 0,
      remaining_quantity: 0, pending_inspection_quantity: 0, pending_inventory_quantity: 0, order_amount: 0, received_amount: 0, returned_quantity: ret.return_type === 'return' ? flowAmount(ret.return_quantity) : 0,
      returned_amount: amount, billed_amount: flowAmount(trace.billed), paid_amount: flowAmount(trace.collected), unbilled_amount: 0, unpaid_amount: 0, remaining_amount: 0,
      requisition_status: '', purchase_status: '', next_stage: pendingStatus ? '待退貨／折讓核准過帳' : linkedOutsideRange ? '待追蹤原進貨／應付' : '待關聯原進貨／應付', exception_reason: exception,
      audit_status: `需處理：${exception}`
    });
  }
  const summary = {
    purchase_order_line_count: orders.length, purchase_order_count: new Set(orders.map(row => row.purchase_order_no)).size,
    requisition_count: new Set(rows.filter(row => row.requisition_no).map(row => row.requisition_no)).size,
    unconverted_requisition_count: unconvertedRequisitions.length, unconverted_requisition_quantity: sumFlow(rows, 'requisition_remaining_quantity'),
    standalone_receipt_count: standaloneReceipts.length, purchase_return_count: allReturnsInRange.length,
    legal_root_count: rows.filter(row => row.is_legal_root).length, orphan_count: rows.filter(row => row.is_orphan).length,
    order_quantity: sumFlow(rows, 'order_quantity'), accepted_quantity: sumFlow(rows, 'accepted_quantity'), remaining_quantity: sumFlow(rows, 'remaining_quantity'),
    pending_inspection_quantity: sumFlow(rows, 'pending_inspection_quantity'), pending_inventory_quantity: sumFlow(rows, 'pending_inventory_quantity'),
    order_amount: sumFlow(rows, 'order_amount'), received_amount: sumFlow(rows, 'received_amount'), billed_amount: sumFlow(rows, 'billed_amount'), paid_amount: sumFlow(rows, 'paid_amount'),
    unbilled_amount: sumFlow(rows, 'unbilled_amount'), unpaid_amount: sumFlow(rows, 'unpaid_amount'),
    completed_count: rows.filter(row => row.audit_status === '流程完成').length, exception_count: rows.filter(row => row.audit_status !== '流程完成').length,
    next_stage: rows.reduce((out, row) => { out[row.next_stage] = (out[row.next_stage] || 0) + 1; return out; }, {})
  };
  const supplemental_rows = await loadSupplementalInventoryAudit(sourceDatabase, from, to, limit);
  summary.supplemental_count = supplemental_rows.length;
  summary.next_stage = [...rows, ...supplemental_rows].reduce((out, row) => { out[row.next_stage] = (out[row.next_stage] || 0) + 1; return out; }, {});
  summary.completed_count = [...rows, ...supplemental_rows].filter(row => row.audit_status === '流程完成').length;
  summary.exception_count = [...rows, ...supplemental_rows].filter(row => row.audit_status !== '流程完成').length;
  return enrichFlowAuditResult({ rows, supplemental_rows, summary }, 'procurement', asOf);
}

function flowAuditHealthResult(sourceDatabase, range, sales, procurement) {
  const supplemental = (sales.supplemental_rows || []).map(row => ({ ...row, flow: '庫存補充' }));
  const alerts = [
    ...(sales.rows || []).map(row => ({ ...row, flow: '銷售' })),
    ...(procurement.rows || []).map(row => ({ ...row, flow: '採購' })),
    ...supplemental
  ].filter(row => row.audit_status !== '流程完成')
    .sort((a, b) => (Number(b.overdue_days || 0) - Number(a.overdue_days || 0)) || String(a.next_stage).localeCompare(String(b.next_stage)));
  const inventory = {
    document_count: supplemental.length,
    legal_root_count: supplemental.filter(row => row.is_legal_root).length,
    orphan_count: supplemental.filter(row => row.is_orphan).length,
    exception_count: supplemental.filter(row => row.audit_status !== '流程完成').length,
    quantity_delta: sumFlow(supplemental, 'quantity_delta'),
    amount_delta: sumFlow(supplemental, 'amount'),
    financial_impact: 0
  };
  const financial = {
    sales_pending: flowAmount(sales.summary?.financial_impact),
    procurement_pending: flowAmount(procurement.summary?.financial_impact),
    total_pending: flowAmount(sales.summary?.financial_impact) + flowAmount(procurement.summary?.financial_impact)
  };
  const context = flowAuditContext(sourceDatabase);
  return {
    source_database: context.source_database, company_id: context.company_id, tenant_id: context.tenant_id,
    source_system: context.source_system, ...range,
    sales: sales.summary, procurement: procurement.summary, inventory, financial,
    alerts: alerts.slice(0, 200)
  };
}

async function buildFlowAuditBundle(kind, sourceDatabase, range, limit) {
  const db = String(sourceDatabase || '').toUpperCase();
  flowAuditContext(db);
  if (kind === 'sales') return await buildSalesFlowAudit(db, range.from, range.to, limit, range.asOf);
  if (kind === 'procurement') return await buildPurchaseFlowAudit(db, range.from, range.to, limit, range.asOf);
  const [sales, procurement] = await Promise.all([
    buildSalesFlowAudit(db, range.from, range.to, limit, range.asOf),
    buildPurchaseFlowAudit(db, range.from, range.to, limit, range.asOf)
  ]);
  return { health: flowAuditHealthResult(db, range, sales, procurement), sales, procurement };
}

function flowRecommendationRemainingQuantity(row) {
  return Math.max(
    flowAmount(row.remaining_quantity), flowAmount(row.quote_remaining_quantity),
    flowAmount(row.requisition_remaining_quantity)
  );
}

function flowRecommendationParty(row) {
  return row.party_code || row.customer_code || row.supplier_code || null;
}

function makeFlowRecommendation(flowKind, row, issueCode, reason, proposedAction, amount) {
  const remainingQuantity = flowRecommendationRemainingQuantity(row);
  const sourceKey = flowRowSourceKey(row, flowKind).slice(0, 255);
  const financialImpact = flowAmount(amount) || flowAmount(row.financial_impact);
  return {
    flow_kind: flowKind, issue_code: issueCode,
    source_kind: row.source_kind || row.root_kind || `${flowKind}_flow`, source_key: sourceKey,
    source_id: row.source_document_id || row.order_id || row.purchase_order_id || row.shipment_id || row.receipt_id || row.return_id || row.quote_id || row.requisition_id || row.document_id || null,
    source_item_id: row.source_document_item_id || row.order_item_id || row.purchase_order_item_id || row.shipment_item_id || row.receipt_item_id || row.return_item_id || row.quote_item_id || row.requisition_item_id || row.item_id || null,
    source_document_no: row.source_document_no || row.order_no || row.purchase_order_no || row.shipment_no || row.receipt_no || row.return_no || row.quote_no || row.requisition_no || row.document_no || row.source || null,
    source_date: flowDateValue(row.source_date || row.order_date || row.document_date),
    expected_date: flowDateValue(row.expected_date), due_date: flowDateValue(row.due_date),
    party_code: flowRecommendationParty(row), item_code: row.item_code || null, warehouse_code: row.warehouse_code || null,
    currency_code: row.currency_code || 'TWD', overdue_days: Number(row.overdue_days || 0),
    expected_overdue_days: Number(row.expected_overdue_days || 0), aging_bucket: row.aging_bucket || null,
    remaining_quantity: remainingQuantity, remaining_amount: flowAmount(row.remaining_amount),
    financial_impact: financialImpact, reason: String(reason || '流程稽核發現異常').slice(0, 1000),
    proposed_action: String(proposedAction || '請核對來源與下一階段，建立受控更正作業。').slice(0, 1000),
    payload_json: JSON.stringify({ ...row, flow_kind: flowKind, as_of_date: row.as_of_date || null })
  };
}

function flowRecommendationCandidates(flowKind, row, asOf) {
  const candidates = [];
  const source = row.source || row.source_document_no || '未命名來源';
  const exception = row.exception_reason || (row.audit_status !== '流程完成' ? '跨模組資料尚未完成' : '');
  const add = (code, reason, action, amount) => candidates.push(makeFlowRecommendation(flowKind, row, code, `${source}：${reason}`, action, amount));
  if (row.is_orphan) add('ORPHAN_SOURCE', `來源關聯不存在或不合法（${exception}）`, '補正目標 ERP 的來源關聯或建立合法補充單據；不得直接修改 SH／SC 原始資料。', row.financial_impact);
  if (['unconverted_quotation', 'unconverted_requisition'].includes(String(row.root_kind))) {
    const quantity = flowRecommendationRemainingQuantity(row);
    add('UNCONVERTED_SOURCE', `尚有 ${quantity} 未轉下一階段（${exception}）`, '確認業務需求後補轉下一階段，或建立受控取消／結案紀錄並保留原單版本。', row.remaining_amount || row.financial_impact);
  }
  if (Number(row.overdue_days || 0) > 0) {
    add('OVERDUE', `截至 ${asOf} ${row.overdue_basis || '預計日／帳款'} 已逾期 ${row.overdue_days} 天（${exception}）`, '核對實際交付、驗收、開立帳款與收付款；確認後才建立受控更正建議。', row.financial_impact);
  }
  if (flowAmount(row.pending_inspection_quantity) > FLOW_AUDIT_EPSILON) add('PENDING_INSPECTION', `尚有 ${row.pending_inspection_quantity} 待驗收`, '完成驗收或驗退，合格量才可進入庫存過帳；保留驗收人員與日期。', row.financial_impact);
  if (flowAmount(row.pending_inventory_quantity) > FLOW_AUDIT_EPSILON) add('PENDING_INVENTORY_POSTING', `尚有 ${row.pending_inventory_quantity} 合格量未入庫過帳`, '核對驗收合格量、庫別與期間後完成受控入庫過帳。', row.financial_impact);
  if (flowRecommendationRemainingQuantity(row) > FLOW_AUDIT_EPSILON && !['unconverted_quotation', 'unconverted_requisition'].includes(String(row.root_kind))) {
    add('UNFULFILLED', `尚有 ${flowRecommendationRemainingQuantity(row)} 未完成交付／進貨`, '核對分批子單、取消量與結案狀態；需要更正時建立沖回／重作或受控解結，不直接改原單。', row.remaining_amount || row.financial_impact);
  }
  if (flowAmount(row.unbilled_amount) > FLOW_AUDIT_EPSILON) add(flowKind === 'sales' ? 'DELIVERED_UNBILLED' : 'RECEIVED_UNBILLED', `${flowKind === 'sales' ? '已銷貨' : '已進貨'}但尚有 ${row.unbilled_amount} 未立帳`, '依公司別單據性質與會計期間補建立或核對應收／應付，保留原始來源與核准紀錄。', row.unbilled_amount);
  if (flowKind === 'sales' && flowAmount(row.uncollected_amount) > FLOW_AUDIT_EPSILON) add('AR_UNCOLLECTED', `已立應收但尚有 ${row.uncollected_amount} 未收款`, '核對到期日、收款沖銷與票據狀態，必要時列入帳齡與資金預估後再受控處理。', row.uncollected_amount);
  if (flowKind === 'procurement' && flowAmount(row.unpaid_amount) > FLOW_AUDIT_EPSILON) add('AP_UNPAID', `已立應付但尚有 ${row.unpaid_amount} 未付款`, '核對到期日、付款沖銷、票據與銀行資金；需更正時建立受控更正紀錄。', row.unpaid_amount);
  if (flowAmount(row.return_pending_amount) > FLOW_AUDIT_EPSILON || flowAmount(row.return_unbilled_amount) > FLOW_AUDIT_EPSILON) add('RETURN_FINANCE_PENDING', `退回／折讓尚有 ${flowAmount(row.return_pending_amount) || flowAmount(row.return_unbilled_amount)} 未同步財務`, '核對銷退／退貨驗收、回庫、負向應收／應付、待抵或退款，完成沖帳鏈後再核准。', row.return_pending_amount || row.return_unbilled_amount);
  if (flowKind === 'sales' && flowAmount(row.customer_credit_balance) > FLOW_AUDIT_EPSILON) add('CUSTOMER_CREDIT_PENDING', `客戶待抵尚有 ${row.customer_credit_balance} 未轉抵／退款`, '依同公司、同客戶、同幣別分批轉抵或登錄退款，保留對應分錄與核准紀錄。', row.customer_credit_balance);
  if (!candidates.length && exception) add('FLOW_EXCEPTION', exception, '由權責人員核對異常原因，建立受控更正建議；核准前不修改來源單據。', row.financial_impact);
  return candidates;
}

function flowRecommendationRows(kind, bundle) {
  if (kind === 'sales') return (bundle.rows || []).map(row => ({ flow_kind: 'sales', row }));
  if (kind === 'procurement') return (bundle.rows || []).map(row => ({ flow_kind: 'procurement', row }));
  return [
    ...(bundle.sales?.rows || []).map(row => ({ flow_kind: 'sales', row })),
    ...(bundle.procurement?.rows || []).map(row => ({ flow_kind: 'procurement', row })),
    ...(bundle.sales?.supplemental_rows || []).map(row => ({ flow_kind: 'inventory', row }))
  ];
}

async function generateFlowAuditRecommendations(sourceDatabase, range, kind, limit, userId, generationKey) {
  const context = flowAuditContext(sourceDatabase);
  const bundle = await buildFlowAuditBundle(kind === 'all' ? 'health' : kind, sourceDatabase, range, limit);
  const candidates = flowRecommendationRows(kind, bundle)
    .flatMap(({ flow_kind, row }) => flowRecommendationCandidates(flow_kind, row, range.asOf))
    .slice(0, 5000);
  let created = 0, refreshed = 0;
  for (const candidate of candidates) {
    const [result] = await pool.query(`INSERT INTO flow_audit_recommendations(
      tenant_id,company_id,source_system,source_database,generation_key,flow_kind,issue_code,source_kind,source_key,
      source_id,source_item_id,source_document_no,source_date,expected_date,due_date,party_code,item_code,warehouse_code,
      currency_code,overdue_days,expected_overdue_days,aging_bucket,remaining_quantity,remaining_amount,financial_impact,
      reason,proposed_action,status,payload_json,created_by
    ) VALUES(${Array(30).fill('?').join(',')})
    ON DUPLICATE KEY UPDATE
      generation_key=VALUES(generation_key), source_id=VALUES(source_id), source_item_id=VALUES(source_item_id),
      source_document_no=VALUES(source_document_no), source_date=VALUES(source_date), expected_date=VALUES(expected_date),
      due_date=VALUES(due_date), party_code=VALUES(party_code), item_code=VALUES(item_code), warehouse_code=VALUES(warehouse_code),
      currency_code=VALUES(currency_code), overdue_days=VALUES(overdue_days), expected_overdue_days=VALUES(expected_overdue_days),
      aging_bucket=VALUES(aging_bucket), remaining_quantity=VALUES(remaining_quantity), remaining_amount=VALUES(remaining_amount),
      financial_impact=VALUES(financial_impact), reason=IF(status='pending',VALUES(reason),reason),
      proposed_action=IF(status='pending',VALUES(proposed_action),proposed_action), payload_json=IF(status='pending',VALUES(payload_json),payload_json),
      updated_at=CURRENT_TIMESTAMP`, [
      context.tenant_id, context.company_id, context.source_system, context.source_database, generationKey || null,
      candidate.flow_kind, candidate.issue_code, candidate.source_kind, candidate.source_key,
      candidate.source_id, candidate.source_item_id, candidate.source_document_no, candidate.source_date,
      candidate.expected_date, candidate.due_date, candidate.party_code, candidate.item_code, candidate.warehouse_code,
      candidate.currency_code, candidate.overdue_days, candidate.expected_overdue_days, candidate.aging_bucket,
      candidate.remaining_quantity, candidate.remaining_amount, candidate.financial_impact, candidate.reason, candidate.proposed_action,
      'pending', candidate.payload_json, userId || null
    ]);
    let id = Number(result.insertId || 0);
    if (id) {
      created += 1;
      await pool.query(`INSERT INTO flow_audit_recommendation_events
        (recommendation_id,tenant_id,company_id,source_system,source_database,event_kind,from_status,to_status,note,actor_id)
        VALUES(?,?,?,?,?,'generated',NULL,'pending',?,?)`, [id, context.tenant_id, context.company_id, context.source_system, context.source_database, '由流程稽核產生待核准更正建議', userId || null]);
    } else {
      const [[existing]] = await pool.query(`SELECT id FROM flow_audit_recommendations
        WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND source_key=? AND issue_code=?`,
        [context.tenant_id, context.company_id, context.source_system, context.source_database, candidate.source_key, candidate.issue_code]);
      if (existing) { id = Number(existing.id); refreshed += 1; }
    }
  }
  return { source_database: context.source_database, company_id: context.company_id, generation_key: generationKey || null, flow_kind: kind, candidate_count: candidates.length, created_count: created, refreshed_count: refreshed };
}

function registerFlowAuditRoutes(app) {
  app.get('/api/flow-audit/sales', async (req, res, next) => {
    try {
      const db = String(req.query.source_database || 'SH').toUpperCase(), range = flowDateRange(req.query), limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
      flowAuditContext(db);
      res.json({ ok: true, data: await buildFlowAuditBundle('sales', db, range, limit), source_database: db, ...range });
    } catch (error) { next(error); }
  });
  app.get('/api/flow-audit/procurement', async (req, res, next) => {
    try {
      const db = String(req.query.source_database || 'SH').toUpperCase(), range = flowDateRange(req.query), limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
      flowAuditContext(db);
      res.json({ ok: true, data: await buildFlowAuditBundle('procurement', db, range, limit), source_database: db, ...range });
    } catch (error) { next(error); }
  });
  app.get('/api/flow-audit/health', async (req, res, next) => {
    try {
      const db = String(req.query.source_database || 'SH').toUpperCase(), range = flowDateRange(req.query), limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
      const bundle = await buildFlowAuditBundle('health', db, range, limit);
      res.json({ ok: true, data: bundle.health });
    } catch (error) { next(error); }
  });
  app.get('/api/flow-audit/recommendations', async (req, res, next) => {
    try {
      await ensureTargetFinanceWorkflowSchema();
      const db = String(req.query.source_database || 'SH').toUpperCase(), range = flowDateRange(req.query), context = flowAuditContext(db);
      const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000), conditions = [
        'tenant_id=?', 'company_id=?', 'source_system=?', 'source_database=?', 'source_date BETWEEN ? AND ?'
      ], params = [context.tenant_id, context.company_id, context.source_system, context.source_database, range.from, range.to];
      const flowKind = String(req.query.flow_kind || '').trim().toLowerCase();
      const status = String(req.query.status || '').trim().toLowerCase();
      const generationKey = trim(req.query.generation_key);
      if (flowKind && !['all', 'health'].includes(flowKind)) { conditions.push('flow_kind=?'); params.push(flowKind); }
      if (status && ['pending', 'approved', 'rejected', 'applied', 'voided'].includes(status)) { conditions.push('status=?'); params.push(status); }
      if (generationKey) { conditions.push('generation_key=?'); params.push(generationKey); }
      const [rows] = await pool.query(`SELECT * FROM flow_audit_recommendations WHERE ${conditions.join(' AND ')}
        ORDER BY FIELD(status,'pending','approved','rejected','applied','voided'),overdue_days DESC,source_date DESC,id DESC LIMIT ?`, [...params, limit]);
      res.json({ ok: true, data: rows, source_database: context.source_database, company_id: context.company_id, ...range, flow_kind: flowKind || 'all', status: status || 'all' });
    } catch (error) { next(error); }
  });
  app.post('/api/flow-audit/recommendations/generate', async (req, res, next) => {
    try {
      await ensureTargetFinanceWorkflowSchema();
      const body = req.body || {}, db = String(body.source_database || 'SH').toUpperCase(), range = flowDateRange(body);
      const kind = String(body.flow_kind || 'all').toLowerCase();
      if (!['sales', 'procurement', 'all'].includes(kind)) throw badRequest('稽核建議流程類別錯誤');
      const limit = Math.min(Math.max(Number(body.limit) || 500, 1), 1000);
      const rawGenerationKey = trim(body.generation_key);
      if (rawGenerationKey && !/^[A-Za-z0-9_-]{1,80}$/.test(rawGenerationKey)) throw badRequest('稽核批次代號格式錯誤');
      const generationKey = rawGenerationKey || `${kind}-${db}-${range.from}-${range.to}-${range.asOf}`.slice(0, 80);
      res.status(201).json({ ok: true, data: await generateFlowAuditRecommendations(db, range, kind, limit, req.auth.id, generationKey) });
    } catch (error) { next(error); }
  });
  app.get('/api/flow-audit/recommendations/:id', async (req, res, next) => {
    try {
      await ensureTargetFinanceWorkflowSchema();
      const db = String(req.query.source_database || 'SH').toUpperCase(), context = flowAuditContext(db), id = Number(req.params.id);
      const [[recommendation]] = await pool.query(`SELECT * FROM flow_audit_recommendations
        WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=?`, [id, context.tenant_id, context.company_id, context.source_system, context.source_database]);
      if (!recommendation) throw badRequest('找不到流程稽核更正建議');
      const [events] = await pool.query('SELECT * FROM flow_audit_recommendation_events WHERE recommendation_id=? ORDER BY created_at,id', [id]);
      res.json({ ok: true, data: { recommendation, events } });
    } catch (error) { next(error); }
  });
  const decideRecommendation = (nextStatus, eventKind, defaultNote) => async (req, res, next) => {
    try {
      if (!['ADMIN', 'FINANCE'].includes(req.auth?.role_code)) throw Object.assign(new Error('只有系統管理員或財務人員可以核准／駁回更正建議'), { status: 403 });
      await ensureTargetFinanceWorkflowSchema();
      const db = String(req.body?.source_database || req.query.source_database || 'SH').toUpperCase(), context = flowAuditContext(db), id = Number(req.params.id), note = trim(req.body?.note) || defaultNote;
      await tx(async conn => {
        const [[recommendation]] = await conn.query(`SELECT * FROM flow_audit_recommendations
          WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? FOR UPDATE`, [id, context.tenant_id, context.company_id, context.source_system, context.source_database]);
        if (!recommendation) throw badRequest('找不到流程稽核更正建議');
        if (recommendation.status !== 'pending') throw badRequest(`只有待核准建議可以${nextStatus === 'approved' ? '核准' : '駁回'}`);
        await conn.query(`UPDATE flow_audit_recommendations SET status=?,decision_note=?,approved_by=IF(?='approved',?,approved_by),approved_at=IF(?='approved',NOW(),approved_at) WHERE id=?`, [nextStatus, note, nextStatus, req.auth.id, nextStatus, id]);
        await conn.query(`INSERT INTO flow_audit_recommendation_events
          (recommendation_id,tenant_id,company_id,source_system,source_database,event_kind,from_status,to_status,note,actor_id)
          VALUES(?,?,?,?,?,?,?,?,?,?)`, [id, context.tenant_id, context.company_id, context.source_system, context.source_database, eventKind, recommendation.status, nextStatus, note, req.auth.id]);
      });
      res.json({ ok: true, data: { id, status: nextStatus, message: nextStatus === 'approved' ? '更正建議已核准，請由受控更正作業執行；未直接修改來源資料' : '更正建議已駁回，保留異常警示與歷程' } });
    } catch (error) { next(error); }
  };
  app.post('/api/flow-audit/recommendations/:id/approve', decideRecommendation('approved', 'approved', '已核對異常，准予建立受控更正案件'));
  app.post('/api/flow-audit/recommendations/:id/reject', decideRecommendation('rejected', 'rejected', '現階段保留警示，不建立更正案件'));
}

function registerFinanceWorkflowRoutes(app){
  const ctx=db=>{const s=sourceDatabases[db];if(!s)throw badRequest(`找不到資料來源：${db}`);return{tenant_id:s.tenant_id||'default',company_id:s.company_id||db,source_system:s.source_system||s.adapter_code||'ism-sh',source_database:db};};
  // 財務流程沿用統一的公司／來源範圍解析；舊路由使用 contextFor 名稱，保留別名避免核准與過帳路由漏掉來源隔離。
  const contextFor = ctx;
  const ensureFinance=()=>ensureTargetFinanceWorkflowSchema();
  const closingDate=(referenceDate,day)=>{const d=new Date(`${referenceDate}T00:00:00Z`),target=Math.min(Math.max(Number(day)||31,1),31);let y=d.getUTCFullYear(),m=d.getUTCMonth();if(d.getUTCDate()>target){m++;if(m>11){m=0;y++;}}const last=new Date(Date.UTC(y,m+1,0)).getUTCDate();return `${y}-${String(m+1).padStart(2,'0')}-${String(Math.min(target,last)).padStart(2,'0')}`;};
  async function financeRate(conn,currency,date,c){if(!currency||currency==='TWD')return 1;const key=String(date).replaceAll('-','');const[[r]]=await conn.query('SELECT COALESCE(NULLIF(customs_sell_rate,0),NULLIF(bank_sell_rate,0),1) rate FROM erp_currency_rates WHERE tenant_id=? AND company_id=? AND source_system=? AND currency_code=? AND effective_date<=? ORDER BY effective_date DESC LIMIT 1',[c.tenant_id,c.company_id,c.source_system,currency,key]);return Number(r?.rate||1);}
  async function writeInvoiceEvent(conn, voucher, eventKind, next, reason, userId) {
    await conn.query(`INSERT INTO finance_invoice_events(
      tenant_id,company_id,source_system,source_database,voucher_id,event_kind,
      before_invoice_no,before_invoice_date,before_invoice_type,before_tax_id,before_invoice_status,
      after_invoice_no,after_invoice_date,after_invoice_type,after_tax_id,after_invoice_status,
      reason,created_by
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      voucher.tenant_id, voucher.company_id, voucher.source_system, voucher.source_database, voucher.id, eventKind,
      voucher.invoice_no || null, voucher.invoice_date || null, voucher.invoice_type || null, voucher.tax_id || null, voucher.invoice_status || 'none',
      next.invoice_no || null, next.invoice_date || null, next.invoice_type || null, next.tax_id || null, next.invoice_status || 'none',
      reason || null, userId || null,
    ]);
  }
  const financeAccounts = [
    ['1001','銀行存款','asset'], ['1101','應收帳款','asset'], ['1121','應收票據','asset'],
    ['1122','應收票據託收','asset'], ['1131','預付貨款','asset'], ['1201','商品存貨','asset'], ['2101','應付帳款','liability'], ['2201','客戶預收款','liability'],
    ['2141','應付票據','liability'], ['4101','銷貨收入','revenue'], ['5101','銷貨成本','expense'],
    ['7161','兌換利益','revenue'], ['7162','兌換損失','expense']
  ];
  async function seedFinanceAccounts(conn, context) {
    for (const [code, name, type] of financeAccounts) await conn.query(
      `INSERT IGNORE INTO accounting_accounts
        (tenant_id,company_id,source_system,account_code,account_name,account_type)
       VALUES(?,?,?,?,?,?)`, [context.tenant_id, context.company_id, context.source_system, code, name, type]
    );
  }
  async function normalizeFinanceLines(conn, rawLines, context) {
    if (!Array.isArray(rawLines) || rawLines.length < 2) throw badRequest('票據／銀行分錄至少需要兩筆明細');
    await seedFinanceAccounts(conn, context);
    const lines = rawLines.map((raw, index) => {
      const debit = Number(raw?.debit_amount || 0);
      const credit = Number(raw?.credit_amount || 0);
      const accountCode = trim(raw?.account_code);
      if (!accountCode || !Number.isFinite(debit) || !Number.isFinite(credit) || debit < 0 || credit < 0 || ((debit > 0) + (credit > 0)) !== 1) {
        throw badRequest(`票據／銀行分錄第 ${index + 1} 行借貸金額格式錯誤`);
      }
      return {
        line_no: Number(raw?.line_no || index + 1), account_code: accountCode,
        debit_amount: debit, credit_amount: credit, party_code: trim(raw?.party_code) || null,
        description: trim(raw?.description) || null
      };
    });
    const debitTotal = lines.reduce((sum, line) => sum + line.debit_amount, 0);
    const creditTotal = lines.reduce((sum, line) => sum + line.credit_amount, 0);
    if (debitTotal <= 0 || Math.abs(debitTotal - creditTotal) > 0.000001) throw badRequest('票據／銀行分錄借貸不平衡');
    const codes = [...new Set(lines.map(line => line.account_code))];
    const [accounts] = await conn.query(
      `SELECT account_code,account_name FROM accounting_accounts
       WHERE tenant_id=? AND company_id=? AND source_system=? AND is_active=1
         AND account_code IN (${codes.map(() => '?').join(',')})`,
      [context.tenant_id, context.company_id, context.source_system, ...codes]
    );
    const accountMap = new Map(accounts.map(row => [String(row.account_code), row]));
    for (const line of lines) if (!accountMap.has(line.account_code)) throw badRequest(`科目不存在或已停用：${line.account_code}`);
    return { lines: lines.map(line => ({ ...line, account_name: accountMap.get(line.account_code).account_name })), debitTotal, creditTotal };
  }
  async function insertFinanceDraft(conn, { context, date, sourceKind, sourceId, sourceDocumentNo, accountType, partyCode, memo, lines, userId }) {
    const checked = await normalizeFinanceLines(conn, lines, context);
    const firstDebit = checked.lines.find(line => line.debit_amount > 0) || checked.lines[0];
    const firstCredit = checked.lines.find(line => line.credit_amount > 0) || checked.lines[1] || checked.lines[0];
    const draftNo = await nextWorkflowNumber(conn, 'accounting_drafts', 'draft_no', 'AD', date);
    const [header] = await conn.query(`INSERT INTO accounting_drafts
      (tenant_id,company_id,source_system,source_database,draft_no,draft_date,source_kind,source_id,source_document_no,account_type,party_code,
       debit_account_code,debit_account_name,credit_account_code,credit_account_name,amount,status,memo,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?)`, [
      context.tenant_id, context.company_id, context.source_system, context.source_database, draftNo, date,
      sourceKind, sourceId || null, sourceDocumentNo || null, accountType || null, partyCode || null,
      firstDebit.account_code, firstDebit.account_name, firstCredit.account_code, firstCredit.account_name,
      checked.debitTotal, memo || null, userId || null
    ]);
    for (const line of checked.lines) await conn.query(`INSERT INTO accounting_draft_lines
      (draft_id,line_no,account_code,account_name,debit_amount,credit_amount,party_code,description)
      VALUES(?,?,?,?,?,?,?,?)`, [header.insertId, line.line_no, line.account_code, line.account_name, line.debit_amount, line.credit_amount, line.party_code, line.description]);
    await conn.query(`INSERT INTO accounting_draft_events(draft_id,event_kind,before_status,after_status,reason,user_id)
      VALUES(?,'generated',NULL,'draft',?,?)`, [header.insertId, memo || '銀行／票據異動產生分錄底稿', userId || null]);
    return { id: header.insertId, draft_no: draftNo, debit_total: checked.debitTotal, credit_total: checked.creditTotal, line_count: checked.lines.length };
  }
  const FINANCE_EPS = 0.000001;
  function financeRateValue(value) {
    const rate = Number(value === undefined || value === null || value === '' ? 1 : value);
    if (!Number.isFinite(rate) || rate <= 0) throw badRequest('匯率必須大於 0');
    return rate;
  }
  function financeRulePair(rule, debitAmount, creditAmount, debitParty = null, creditParty = debitParty, description = null) {
    const memo = description || rule.note || rule.entry_role;
    return [
      { line_no: 1, account_code: rule.debit_account_code, account_name: rule.debit_account_name, debit_amount: Number(debitAmount), credit_amount: 0, party_code: debitParty, description: memo },
      { line_no: 2, account_code: rule.credit_account_code, account_name: rule.credit_account_name, debit_amount: 0, credit_amount: Number(creditAmount), party_code: creditParty, description: memo }
    ];
  }
  function appendFinanceExchangeLine(lines, debitBase, creditBase, partyCode, description) {
    const difference = Number(debitBase) - Number(creditBase);
    if (difference > FINANCE_EPS) lines.push({ line_no: lines.length + 1, account_code: '7161', account_name: '兌換利益', debit_amount: 0, credit_amount: difference, party_code: partyCode || null, description: description || '匯兌利益' });
    else if (difference < -FINANCE_EPS) lines.push({ line_no: lines.length + 1, account_code: '7162', account_name: '兌換損失', debit_amount: Math.abs(difference), credit_amount: 0, party_code: partyCode || null, description: description || '匯兌損失' });
    return difference;
  }
  async function insertFinanceRuleDraft(conn, { context, date, moduleCode, documentKind, documentType = '*', entryRole = 'main', debitAmount, creditAmount, debitParty = null, creditParty = debitParty, partyCode = null, sourceKind, sourceId, sourceDocumentNo, accountType = null, memo, userId }) {
    if (sourceId) {
      const [[existing]] = await conn.query(`SELECT id,draft_no,debit_account_code,debit_account_name,credit_account_code,credit_account_name,amount,status
        FROM accounting_drafts WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND source_kind=? AND source_id=? AND status<>'restored' LIMIT 1`,
        [context.tenant_id, context.company_id, context.source_system, context.source_database, sourceKind, sourceId]);
      if (existing) return { ...existing, line_count: null, debit_total: Number(existing.amount || 0), credit_total: Number(existing.amount || 0) };
    }
    await seedAccountingAutoRules(conn, context, userId || null);
    const rule = await findAccountingAutoRule(conn, context, moduleCode, documentKind, documentType, entryRole);
    const lines = financeRulePair(rule, debitAmount, creditAmount, debitParty, creditParty, memo || rule.note);
    appendFinanceExchangeLine(lines, debitAmount, creditAmount, partyCode, '匯兌差額');
    return insertFinanceDraft(conn, { context, date, sourceKind, sourceId, sourceDocumentNo, accountType, partyCode, memo, lines, userId });
  }
  async function validateAdvanceSourceSettlement(conn, advance, context) {
    const settlementId = Number(advance.source_settlement_id || 0);
    if (!settlementId) return null;
    const [[settlement]] = await conn.query(`SELECT * FROM finance_settlements
      WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND status='posted' FOR UPDATE`,
      [settlementId, context.tenant_id, context.company_id, context.source_system, context.source_database]);
    if (!settlement) throw badRequest('預收／預付來源必須是目前公司已過帳的收付款單');
    const settlementCurrency = String(settlement.currency_code || 'TWD').toUpperCase();
    if (String(settlement.account_type) !== String(advance.account_type) || String(settlement.party_code) !== String(advance.party_code) || settlementCurrency !== String(advance.currency_code || 'TWD').toUpperCase()) {
      throw badRequest('預收／預付來源收付款單必須符合同公司、同類別、同對象及同幣別');
    }
    assertChronologicalDate(advance.advance_date, settlement.settlement_date, '預收／預付日期');
    const [[allocated]] = await conn.query(`SELECT COALESCE(SUM(a.allocated_amount),0) used_amount
      FROM finance_allocations a JOIN finance_settlements s ON s.id=a.settlement_id
      WHERE a.settlement_id=? AND s.status<>'voided'`, [settlementId]);
    const [[reserved]] = await conn.query(`SELECT COALESCE(SUM(original_amount),0) reserved_amount FROM finance_advances
      WHERE source_settlement_id=? AND status<>'voided' AND id<>?`, [settlementId, Number(advance.id || 0)]);
    const available = Number(settlement.amount || 0) - Number(allocated?.used_amount || 0) - Number(reserved?.reserved_amount || 0);
    if (Number(advance.original_amount) > available + FINANCE_EPS) throw badRequest(`來源收付款單可轉預收／預付餘額不足（可用 ${Math.max(available, 0)}）`);
    return settlement;
  }
  async function findPartyRelationship(conn, context, customerCode, supplierCode) {
    const [[relationship]] = await conn.query(`SELECT * FROM finance_party_links
      WHERE id IS NOT NULL AND tenant_id=? AND company_id=? AND source_system=? AND source_database=?
        AND customer_code=? AND supplier_code=? AND is_active=1 LIMIT 1`,
      [context.tenant_id, context.company_id, context.source_system, context.source_database, customerCode, supplierCode]);
    if (!relationship) throw badRequest('客戶兼廠商對沖前，必須先建立同公司、同來源的有效關係');
    return relationship;
  }
  function scopedFinanceStatus(balance, fullStatus) {
    return Number(balance) <= FINANCE_EPS ? fullStatus : 'partial';
  }
  function financeStatusLines(note, fromStatus, toStatus, bankTransactionDirection = null) {
    const amount = Number(note.amount);
    const pair = (debit, credit, description) => [
      { account_code: debit, debit_amount: amount, credit_amount: 0, party_code: note.party_code, description },
      { account_code: credit, debit_amount: 0, credit_amount: amount, party_code: note.party_code, description }
    ];
    if (note.account_type === 'AR') {
      if (toStatus === 'deposited') return pair('1122', '1121', '應收票據託收');
      if (toStatus === 'cashed') return pair('1001', fromStatus === 'deposited' ? '1122' : '1121', '應收票據兌現');
      if (toStatus === 'dishonored' && fromStatus === 'deposited') return pair('1121', '1122', '應收票據託收退票');
      if (toStatus === 'dishonored' && fromStatus === 'cashed') return pair('1121', '1001', '應收票據兌現退票');
      if (toStatus === 'voided' && fromStatus === 'deposited') return pair('1121', '1122', '應收票據託收註銷');
    } else {
      if (toStatus === 'honored') return pair('2141', '1001', '應付票據兌現／付款');
      if (toStatus === 'dishonored' && fromStatus === 'issued') return pair('2101', '2141', '應付票據退票');
      if (toStatus === 'dishonored' && fromStatus === 'honored') return pair('1001', '2141', '應付票據付款退票');
      if (toStatus === 'voided' && fromStatus === 'issued') return pair('2141', '2101', '應付票據註銷');
    }
    return [];
  }
  async function recordNoteEvent(conn, note, fromStatus, toStatus, eventDate, bankTransactionId, accountingDraftId, reason, userId) {
    await conn.query(`INSERT INTO finance_note_events
      (tenant_id,company_id,source_system,source_database,note_id,from_status,to_status,event_date,bank_transaction_id,accounting_draft_id,reason,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, [
      note.tenant_id, note.company_id, note.source_system, note.source_database, note.id,
      fromStatus || null, toStatus, eventDate, bankTransactionId || null, accountingDraftId || null, reason || null, userId || null
    ]);
  }
  async function recordBankTransactionEvent(conn, transaction, eventKind, beforeStatus, afterStatus, reversalTransactionId, accountingDraftId, reason, userId) {
    await conn.query(`INSERT INTO finance_bank_transaction_events
      (tenant_id,company_id,source_system,source_database,transaction_id,event_kind,before_status,after_status,reversal_transaction_id,accounting_draft_id,reason,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, [
      transaction.tenant_id, transaction.company_id, transaction.source_system, transaction.source_database, transaction.id,
      eventKind, beforeStatus || null, afterStatus || null, reversalTransactionId || null, accountingDraftId || null, reason || null, userId || null
    ]);
  }
  app.get('/api/finance-workflow/closing-settings',async(req,res,next)=>{try{await ensureFinance();const db=String(req.query.source_database||'SH').toUpperCase(),type=String(req.query.account_type||'AR').toUpperCase(),c=ctx(db);await pool.query(`INSERT IGNORE INTO finance_closing_settings(tenant_id,company_id,source_system,source_database,account_type) VALUES(?,?,?,?,?)`,[c.tenant_id,c.company_id,c.source_system,db,type]);const[[row]]=await pool.query('SELECT * FROM finance_closing_settings WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND account_type=?',[c.tenant_id,c.company_id,c.source_system,db,type]);res.json({ok:true,data:row});}catch(e){next(e);}});
  app.put('/api/finance-workflow/closing-settings',async(req,res,next)=>{try{await ensureFinance();const b=req.body||{},db=String(b.source_database||'SH').toUpperCase(),type=String(b.account_type||'AR').toUpperCase(),c=ctx(db),day=Math.min(Math.max(Number(b.unified_closing_day)||31,1),31);await pool.query(`INSERT INTO finance_closing_settings(tenant_id,company_id,source_system,source_database,account_type,unified_closing_day,base_currency_code,exchange_gain_account_code,exchange_gain_account_name,exchange_loss_account_code,exchange_loss_account_name,auto_generate,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE unified_closing_day=VALUES(unified_closing_day),base_currency_code=VALUES(base_currency_code),exchange_gain_account_code=VALUES(exchange_gain_account_code),exchange_gain_account_name=VALUES(exchange_gain_account_name),exchange_loss_account_code=VALUES(exchange_loss_account_code),exchange_loss_account_name=VALUES(exchange_loss_account_name),auto_generate=VALUES(auto_generate),note=VALUES(note)`,[c.tenant_id,c.company_id,c.source_system,db,type,day,trim(b.base_currency_code)||'TWD',trim(b.exchange_gain_account_code)||'7161',trim(b.exchange_gain_account_name)||'兌換利益',trim(b.exchange_loss_account_code)||'7162',trim(b.exchange_loss_account_name)||'兌換損失',Number(b.auto_generate||0),trim(b.note),req.auth.id]);res.json({ok:true,data:{source_database:db,account_type:type}});}catch(e){next(e);}});
  app.get('/api/finance-workflow/closing-suggestion',async(req,res,next)=>{try{await ensureFinance();const db=String(req.query.source_database||'SH').toUpperCase(),type=String(req.query.account_type||'AR').toUpperCase(),party=trim(req.query.party_code),basis=trim(req.query.closing_basis)||'customer',reference=validDate(req.query.reference_date),c=ctx(db);const table=type==='AR'?'erp_customers':'erp_suppliers',code=type==='AR'?'customer_code':'supplier_code';let master=null;if(party){const[rows]=await pool.query(`SELECT * FROM ${table} WHERE tenant_id=? AND company_id=? AND source_system=? AND ${code}=? LIMIT 1`,[c.tenant_id,c.company_id,c.source_system,party]);master=rows[0]||null;}const[[setting]]=await pool.query('SELECT * FROM finance_closing_settings WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND account_type=?',[c.tenant_id,c.company_id,c.source_system,db,type]);const day=basis==='unified'?setting?.unified_closing_day:master?.closing_day;const date=closingDate(reference,day||31),currency=master?.currency_code||setting?.base_currency_code||'TWD';const rate=await tx(conn=>financeRate(conn,currency,date,c));res.json({ok:true,data:{closing_basis:basis,voucher_date:date,due_date:date,party_code:party,currency_code:currency,invoice_type:master?.invoice_type||'',tax_id:master?.tax_id||'',exchange_rate:rate,closing_day:Number(day)||31}});}catch(e){next(e);}});
  app.get('/api/finance-workflow/return-adjustments',async(req,res,next)=>{
    try{
      await ensureFinance();
      const db=String(req.query.source_database||'SH').toUpperCase(),c=ctx(db);
      const limit=Math.min(Math.max(Number(req.query.limit)||200,1),500);
      const[rows]=await pool.query(`SELECT a.*,d.document_no sales_return_no,d.document_date sales_return_date,
        d.customer_code,d.currency_code,d.return_type,d.status sales_return_status,i.item_code,i.item_name,i.quantity return_quantity,
        (SELECT GROUP_CONCAT(DISTINCT oi.document_no ORDER BY oi.document_date,oi.id SEPARATOR '、')
          FROM finance_return_adjustment_allocations aa JOIN finance_open_items oi ON oi.id=aa.open_item_id
          WHERE aa.adjustment_id=a.id) open_item_nos,
        (SELECT COUNT(*) FROM finance_return_adjustment_allocations aa WHERE aa.adjustment_id=a.id) allocation_count,
        COALESCE((SELECT cc.original_amount FROM finance_customer_credits cc WHERE cc.source_adjustment_id=a.id LIMIT 1),0) credit_original_amount,
        COALESCE((SELECT cc.applied_amount FROM finance_customer_credits cc WHERE cc.source_adjustment_id=a.id LIMIT 1),0) credit_applied_amount,
        COALESCE((SELECT cc.refunded_amount FROM finance_customer_credits cc WHERE cc.source_adjustment_id=a.id LIMIT 1),0) credit_refunded_amount,
        COALESCE((SELECT cc.balance_amount FROM finance_customer_credits cc WHERE cc.source_adjustment_id=a.id LIMIT 1),0) credit_balance_amount,
        COALESCE((SELECT cc.status FROM finance_customer_credits cc WHERE cc.source_adjustment_id=a.id LIMIT 1),'') credit_status
      FROM finance_return_adjustments a
      JOIN sales_documents d ON d.id=a.sales_return_id AND d.source_database=a.source_database
      JOIN sales_document_items i ON i.id=a.sales_return_item_id
      WHERE a.tenant_id=? AND a.company_id=? AND a.source_system=? AND a.source_database=?
      ORDER BY a.adjustment_date DESC,a.id DESC LIMIT ?`,[c.tenant_id,c.company_id,c.source_system,db,limit]);
      res.json({ok:true,data:rows});
    }catch(e){next(e);}
  });
  app.post('/api/finance-workflow/return-adjustments/:id/sync',async(req,res,next)=>{
    try{
      await ensureFinance();
      const db=String(req.body?.source_database||req.query.source_database||'SH').toUpperCase(),c=ctx(db),id=Number(req.params.id);
      const result=await tx(async conn=>{
        const[[row]]=await conn.query('SELECT id FROM finance_return_adjustments WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? FOR UPDATE',[id,c.tenant_id,c.company_id,c.source_system,db]);
        if(!row)throw notFound('找不到目前公司別的銷退應收處理紀錄');
        return syncSalesReturnAdjustment(conn,id,req.auth.id);
      });
      res.json({ok:true,data:result});
    }catch(e){next(e);}
  });
  app.get('/api/finance-workflow/return-adjustments/:id/events',async(req,res,next)=>{
    try{
      await ensureFinance();
      const db=String(req.query.source_database||'SH').toUpperCase(),c=ctx(db),id=Number(req.params.id);
      const[[adjustment]]=await pool.query('SELECT id FROM finance_return_adjustments WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=?',[id,c.tenant_id,c.company_id,c.source_system,db]);
      if(!adjustment)throw notFound('找不到目前公司別的銷退應收處理紀錄');
      const[rows]=await pool.query(`SELECT e.*,oi.document_no open_item_no
        FROM finance_return_adjustment_events e
        LEFT JOIN finance_open_items oi ON oi.id=e.open_item_id
        WHERE e.adjustment_id=? AND e.tenant_id=? AND e.company_id=? AND e.source_system=? AND e.source_database=?
        ORDER BY e.created_at,e.id`,[id,c.tenant_id,c.company_id,c.source_system,db]);
      res.json({ok:true,data:rows});
    }catch(e){next(e);}
  });
  app.get('/api/finance-workflow/customer-credits',async(req,res,next)=>{try{await ensureFinance();const db=String(req.query.source_database||'SH').toUpperCase(),c=ctx(db);const[rows]=await pool.query(`SELECT c.*,a.sales_return_id,a.return_amount,a.receivable_offset_amount,a.refund_amount,a.status adjustment_status,d.document_no sales_return_no FROM finance_customer_credits c JOIN finance_return_adjustments a ON a.id=c.source_adjustment_id JOIN sales_documents d ON d.id=a.sales_return_id WHERE c.tenant_id=? AND c.company_id=? AND c.source_system=? AND c.source_database=? ORDER BY c.credit_date DESC,c.id DESC LIMIT 100`,[c.tenant_id,c.company_id,c.source_system,db]);res.json({ok:true,data:rows});}catch(e){next(e);}});
  // 立沖／預收預付：所有資料均以目前公司、來源系統與來源資料庫作為查詢及寫入範圍。
  app.get('/api/finance-workflow/advances', async (req,res,next) => {
    try {
      await ensureFinance();
      const db=String(req.query.source_database||'SH').toUpperCase(), type=String(req.query.account_type||'').toUpperCase(), c=ctx(db);
      const conditions=['a.tenant_id=?','a.company_id=?','a.source_system=?','a.source_database=?'];
      const params=[c.tenant_id,c.company_id,c.source_system,db];
      if(['AR','AP'].includes(type)){conditions.push('a.account_type=?');params.push(type);}
      const [rows]=await pool.query(`SELECT a.*,d.draft_no AS accounting_draft_no,d.status AS accounting_draft_status,
          (SELECT COUNT(*) FROM finance_advance_movements m WHERE m.advance_id=a.id) movement_count,
          (SELECT COALESCE(SUM(CASE WHEN m.movement_kind IN ('apply','offset') THEN m.amount ELSE 0 END),0) FROM finance_advance_movements m WHERE m.advance_id=a.id) used_amount,
          (SELECT COALESCE(SUM(CASE WHEN m.movement_kind='refund' THEN m.amount ELSE 0 END),0) FROM finance_advance_movements m WHERE m.advance_id=a.id) movement_refunded_amount
        FROM finance_advances a LEFT JOIN accounting_drafts d ON d.id=a.accounting_draft_id
        WHERE ${conditions.join(' AND ')} ORDER BY a.advance_date DESC,a.id DESC LIMIT 200`,params);
      res.json({ok:true,data:rows});
    } catch(e){next(e);}
  });
  app.get('/api/finance-workflow/advances/:id/movements', async (req,res,next) => {
    try {
      await ensureFinance();
      const db=String(req.query.source_database||'SH').toUpperCase(), c=ctx(db), id=Number(req.params.id);
      const [[advance]]=await pool.query('SELECT * FROM finance_advances WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=?',[id,c.tenant_id,c.company_id,c.source_system,db]);
      if(!advance)throw notFound('找不到目前公司的立沖資料');
      const [rows]=await pool.query(`SELECT m.*,o.document_no AS open_item_no,r.advance_no AS related_advance_no,
          d.draft_no AS accounting_draft_no,d.status AS accounting_draft_status
        FROM finance_advance_movements m LEFT JOIN finance_open_items o ON o.id=m.open_item_id
        LEFT JOIN finance_advances r ON r.id=m.related_advance_id
        LEFT JOIN accounting_drafts d ON d.id=m.accounting_draft_id
        WHERE m.advance_id=? ORDER BY m.movement_date,m.id`,[id]);
      res.json({ok:true,data:{rows,advance}});
    } catch(e){next(e);}
  });
  app.get('/api/finance-workflow/cross-offsets', async (req,res,next) => {
    try {
      await ensureFinance();
      const db=String(req.query.source_database||'SH').toUpperCase(), kind=String(req.query.offset_kind||'').toLowerCase(), c=ctx(db);
      const conditions=['o.tenant_id=?','o.company_id=?','o.source_system=?','o.source_database=?'];
      const params=[c.tenant_id,c.company_id,c.source_system,db];
      if(['open_items','advances'].includes(kind)){conditions.push('o.offset_kind=?');params.push(kind);}
      if(req.query.from_date){conditions.push('o.offset_date>=?');params.push(validDate(req.query.from_date));}
      if(req.query.to_date){conditions.push('o.offset_date<=?');params.push(validDate(req.query.to_date));}
      const [rows]=await pool.query(`SELECT o.*,d.draft_no AS accounting_draft_no,d.status AS accounting_draft_status,
          pl.relationship_type
        FROM finance_cross_offsets o LEFT JOIN accounting_drafts d ON d.id=o.accounting_draft_id
        LEFT JOIN finance_party_links pl ON pl.id=o.relationship_id
        WHERE ${conditions.join(' AND ')} ORDER BY o.offset_date DESC,o.id DESC LIMIT 200`,params);
      res.json({ok:true,data:rows});
    } catch(e){next(e);}
  });
  app.post('/api/finance-workflow/advances', async (req,res,next) => {
    try {
      await ensureFinance();
      const b=req.body||{}, db=String(b.source_database||'SH').toUpperCase(), type=String(b.account_type||'AR').toUpperCase(), kind=String(b.advance_kind||'prepayment').toLowerCase(), c=ctx(db);
      const date=validDate(b.advance_date), amount=positiveNumber(b.original_amount,'金額'), party=trim(b.party_code), currency=(trim(b.currency_code)||'TWD').toUpperCase(), rate=financeRateValue(b.exchange_rate);
      if(!['AR','AP'].includes(type)||!['prepayment','overpayment'].includes(kind)||!party)throw badRequest('預收／預付類別、類型與對象不可空白');
      const sourceSettlementId=trim(b.source_settlement_id)?Number(b.source_settlement_id):0;
      if(sourceSettlementId&&!Number.isInteger(sourceSettlementId))throw badRequest('來源收付款單代號不正確');
      const out=await tx(async conn=>{
        await assertOpenAccountingPeriod(conn,c,date);
        const no=trim(b.advance_no)||await nextWorkflowNumber(conn,'finance_advances','advance_no',type==='AR'?'ARADV':'APADV',date);
        const advance={id:0,account_type:type,advance_kind:kind,advance_no:no,advance_date:date,party_code:party,currency_code:currency,exchange_rate:rate,original_amount:amount,source_settlement_id:sourceSettlementId||null};
        if(sourceSettlementId)await validateAdvanceSourceSettlement(conn,advance,c);
        const [r]=await conn.query(`INSERT INTO finance_advances
          (tenant_id,company_id,source_system,source_database,account_type,advance_kind,advance_no,advance_date,party_code,currency_code,exchange_rate,original_amount,balance_amount,source_settlement_id,source_document_no,status,note,created_by)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'draft',?,?)`,
          [c.tenant_id,c.company_id,c.source_system,db,type,kind,no,date,party,currency,rate,amount,amount,sourceSettlementId||null,trim(b.source_document_no)||null,trim(b.note)||null,req.auth.id]);
        return{id:r.insertId,advance_no:no,status:'draft',source_settlement_id:sourceSettlementId||null};
      });
      res.status(201).json({ok:true,data:out});
    } catch(e){next(e);}
  });
  app.post('/api/finance-workflow/advances/:id/approve', async (req,res,next) => {
    try {
      await ensureFinance();
      const db=String(req.body?.source_database||req.query.source_database||'SH').toUpperCase(), c=ctx(db), id=Number(req.params.id);
      const out=await tx(async conn=>{
        const [[advance]]=await conn.query(`SELECT * FROM finance_advances WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND status='draft' FOR UPDATE`,[id,c.tenant_id,c.company_id,c.source_system,db]);
        if(!advance)throw badRequest('只有目前公司的預收／預付草稿可以核准');
        await assertOpenAccountingPeriod(conn,c,advance.advance_date);
        const settlement=await validateAdvanceSourceSettlement(conn,advance,c);
        const base=Number(advance.original_amount)*financeRateValue(advance.exchange_rate);
        const draft=await insertFinanceRuleDraft(conn,{context:c,date:dateText(advance.advance_date),moduleCode:advance.account_type,documentKind:'advance_create',entryRole:settlement?'reclass':'main',debitAmount:base,creditAmount:base,partyCode:advance.party_code,debitParty:advance.party_code,creditParty:advance.party_code,sourceKind:'finance_advance',sourceId:advance.id,sourceDocumentNo:advance.advance_no,accountType:advance.account_type,memo:settlement?'收付款轉預收／預付':'建立預收／預付與溢收／溢付',userId:req.auth.id});
        await conn.query("UPDATE finance_advances SET status='available',accounting_draft_id=?,approved_by=?,approved_at=NOW() WHERE id=?",[draft.id,req.auth.id,id]);
        return{id,advance_no:advance.advance_no,status:'available',accounting_draft_id:draft.id,draft_no:draft.draft_no,source_settlement_id:advance.source_settlement_id||null};
      });
      res.json({ok:true,data:out});
    } catch(e){next(e);}
  });
  app.post('/api/finance-workflow/advances/:id/apply', async (req,res,next) => {
    try {
      await ensureFinance();
      const db=String(req.body?.source_database||req.query.source_database||'SH').toUpperCase(), c=ctx(db), id=Number(req.params.id), openId=Number(req.body?.open_item_id), amount=positiveNumber(req.body?.amount,'轉抵金額'), date=validDate(req.body?.movement_date);
      if(!Number.isInteger(id)||id<1||!Number.isInteger(openId)||openId<1)throw badRequest('立沖或帳款代號不正確');
      const out=await tx(async conn=>{
        const [[advance]]=await conn.query(`SELECT * FROM finance_advances WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND status IN ('available','partial') FOR UPDATE`,[id,c.tenant_id,c.company_id,c.source_system,db]);
        const [[item]]=await conn.query(`SELECT * FROM finance_open_items WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND status IN ('open','partial') FOR UPDATE`,[openId,c.tenant_id,c.company_id,c.source_system,db]);
        if(!advance||!item||advance.account_type!==item.account_type||String(advance.party_code)!==String(item.party_code)||String(advance.currency_code||'TWD').toUpperCase()!==String(item.currency_code||'TWD').toUpperCase())throw badRequest('預收／預付與帳款必須屬於同公司、同來源、同類別、同對象及同幣別');
        assertChronologicalDate(date,advance.advance_date,'轉抵日期');
        assertChronologicalDate(date,item.document_date,'轉抵日期');
        await assertOpenAccountingPeriod(conn,c,date);
        if(amount>Number(advance.balance_amount)+FINANCE_EPS||amount>Number(item.balance_amount)+FINANCE_EPS)throw badRequest('轉抵金額超過可用餘額');
        const advanceRate=financeRateValue(advance.exchange_rate), itemRate=financeRateValue(item.exchange_rate), advanceBase=amount*advanceRate, itemBase=amount*itemRate;
        const advanceBalance=Math.max(Number(advance.balance_amount)-amount,0), itemBalance=Math.max(Number(item.balance_amount)-amount,0);
        const itemBaseBalance=Math.max((Number(item.base_balance_amount||0)>FINANCE_EPS?Number(item.base_balance_amount):Number(item.balance_amount)*itemRate)-itemBase,0);
        await conn.query("UPDATE finance_advances SET applied_amount=applied_amount+?,balance_amount=?,status=? WHERE id=?",[amount,advanceBalance,scopedFinanceStatus(advanceBalance,'applied'),id]);
        await conn.query("UPDATE finance_open_items SET settled_amount=settled_amount+?,base_settled_amount=base_settled_amount+?,balance_amount=?,base_balance_amount=?,status=? WHERE id=?",[amount,itemBase,itemBalance,itemBaseBalance,scopedFinanceStatus(itemBalance,'settled'),openId]);
        const [movement]=await conn.query(`INSERT INTO finance_advance_movements
          (advance_id,movement_date,movement_kind,amount,base_amount,exchange_difference,open_item_id,reference_no,note,created_by)
          VALUES(?,?, 'apply',?,?,?,?,?,?,?)`,[id,date,amount,advanceBase,advanceBase-itemBase,openId,trim(req.body?.reference_no),trim(req.body?.note),req.auth.id]);
        const debitBase=advance.account_type==='AR'?advanceBase:itemBase, creditBase=advance.account_type==='AR'?itemBase:advanceBase;
        const draft=await insertFinanceRuleDraft(conn,{context:c,date,moduleCode:advance.account_type,documentKind:'advance_apply',debitAmount:debitBase,creditAmount:creditBase,partyCode:advance.party_code,debitParty:advance.party_code,creditParty:advance.party_code,sourceKind:'finance_advance_movement',sourceId:movement.insertId,sourceDocumentNo:`${advance.advance_no}/${item.document_no}`.slice(0,80),accountType:advance.account_type,memo:'預收／預付分批轉抵應收／應付',userId:req.auth.id});
        await conn.query('UPDATE finance_advance_movements SET accounting_draft_id=? WHERE id=?',[draft.id,movement.insertId]);
        return{id,open_item_id:openId,movement_id:movement.insertId,applied_amount:amount,advance_balance_amount:advanceBalance,open_item_balance_amount:itemBalance,advance_base_amount:advanceBase,open_item_base_amount:itemBase,exchange_difference:advanceBase-itemBase,accounting_draft_id:draft.id,draft_no:draft.draft_no};
      });
      res.json({ok:true,data:out});
    } catch(e){next(e);}
  });
  app.post('/api/finance-workflow/advances/:id/refund', async (req,res,next) => {
    try {
      await ensureFinance();
      const db=String(req.body?.source_database||req.query.source_database||'SH').toUpperCase(), c=ctx(db), id=Number(req.params.id), amount=positiveNumber(req.body?.amount,'退款／退回金額'), date=validDate(req.body?.movement_date);
      const out=await tx(async conn=>{
        const [[advance]]=await conn.query(`SELECT * FROM finance_advances WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND status IN ('available','partial') FOR UPDATE`,[id,c.tenant_id,c.company_id,c.source_system,db]);
        if(!advance||amount>Number(advance.balance_amount)+FINANCE_EPS)throw badRequest('退款／退回金額超過預收／預付可用餘額');
        assertChronologicalDate(date,advance.advance_date,'退款／退回日期');
        await assertOpenAccountingPeriod(conn,c,date);
        const balance=Math.max(Number(advance.balance_amount)-amount,0), base=amount*financeRateValue(advance.exchange_rate);
        await conn.query("UPDATE finance_advances SET refunded_amount=refunded_amount+?,balance_amount=?,status=? WHERE id=?",[amount,balance,scopedFinanceStatus(balance,'refunded'),id]);
        const [movement]=await conn.query(`INSERT INTO finance_advance_movements
          (advance_id,movement_date,movement_kind,amount,base_amount,exchange_difference,reference_no,note,created_by)
          VALUES(?,?, 'refund',?,?,?,?,?,?)`,[id,date,amount,base,0,trim(req.body?.reference_no),trim(req.body?.note),req.auth.id]);
        const draft=await insertFinanceRuleDraft(conn,{context:c,date,moduleCode:advance.account_type,documentKind:'advance_refund',debitAmount:base,creditAmount:base,partyCode:advance.party_code,debitParty:advance.party_code,creditParty:advance.party_code,sourceKind:'finance_advance_movement',sourceId:movement.insertId,sourceDocumentNo:`${advance.advance_no}/退款`.slice(0,80),accountType:advance.account_type,memo:'預收／預付與溢收／溢付退款',userId:req.auth.id});
        await conn.query('UPDATE finance_advance_movements SET accounting_draft_id=? WHERE id=?',[draft.id,movement.insertId]);
        return{id,movement_id:movement.insertId,refunded_amount:amount,balance_amount:balance,accounting_draft_id:draft.id,draft_no:draft.draft_no};
      });
      res.json({ok:true,data:out});
    } catch(e){next(e);}
  });
  app.post('/api/finance-workflow/cross-offsets', async (req,res,next) => {
    try {
      await ensureFinance();
      const b=req.body||{}, db=String(b.source_database||'SH').toUpperCase(), c=ctx(db), kind=String(b.offset_kind||'open_items').toLowerCase(), date=validDate(b.offset_date||b.movement_date), amount=positiveNumber(b.amount,'對沖金額'), currency=(trim(b.currency_code)||'TWD').toUpperCase();
      if(!['open_items','advances'].includes(kind))throw badRequest('對沖類型只能是應收／應付帳款或預收／預付');
      const arId=Number(kind==='open_items'?(b.ar_open_item_id||b.ar_id):(b.ar_advance_id||b.ar_id)), apId=Number(kind==='open_items'?(b.ap_open_item_id||b.ap_id):(b.ap_advance_id||b.ap_id));
      if(!Number.isInteger(arId)||arId<1||!Number.isInteger(apId)||apId<1)throw badRequest('對沖必須同時指定應收端與應付端');
      const out=await tx(async conn=>{
        let ar,ap,relationship;
        if(kind==='open_items'){
          [[ar]]=await conn.query(`SELECT * FROM finance_open_items WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND account_type='AR' AND status IN ('open','partial') FOR UPDATE`,[arId,c.tenant_id,c.company_id,c.source_system,db]);
          [[ap]]=await conn.query(`SELECT * FROM finance_open_items WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND account_type='AP' AND status IN ('open','partial') FOR UPDATE`,[apId,c.tenant_id,c.company_id,c.source_system,db]);
        } else {
          [[ar]]=await conn.query(`SELECT * FROM finance_advances WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND account_type='AR' AND status IN ('available','partial') FOR UPDATE`,[arId,c.tenant_id,c.company_id,c.source_system,db]);
          [[ap]]=await conn.query(`SELECT * FROM finance_advances WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND account_type='AP' AND status IN ('available','partial') FOR UPDATE`,[apId,c.tenant_id,c.company_id,c.source_system,db]);
        }
        if(!ar||!ap)throw badRequest('對沖來源不存在、已結清或不屬於目前公司');
        if(String(ar.currency_code||'TWD').toUpperCase()!==String(ap.currency_code||'TWD').toUpperCase()||String(ar.currency_code||'TWD').toUpperCase()!==currency)throw badRequest('對沖必須使用同一公司、同一來源及同一幣別');
        relationship=await findPartyRelationship(conn,c,String(ar.party_code),String(ap.party_code));
        assertChronologicalDate(date,kind==='open_items'?ar.document_date:ar.advance_date,'對沖日期');
        assertChronologicalDate(date,kind==='open_items'?ap.document_date:ap.advance_date,'對沖日期');
        await assertOpenAccountingPeriod(conn,c,date);
        if(amount>Number(ar.balance_amount)+FINANCE_EPS||amount>Number(ap.balance_amount)+FINANCE_EPS)throw badRequest('對沖金額超過應收／應付可用餘額');
        const arRate=financeRateValue(ar.exchange_rate), apRate=financeRateValue(ap.exchange_rate), arBase=amount*arRate, apBase=amount*apRate;
        const no=trim(b.offset_no)||await nextWorkflowNumber(conn,'finance_cross_offsets','offset_no','OFF',date);
        const [header]=await conn.query(`INSERT INTO finance_cross_offsets
          (tenant_id,company_id,source_system,source_database,offset_no,offset_date,offset_kind,customer_code,supplier_code,currency_code,amount,ar_base_amount,ap_base_amount,exchange_difference,ar_open_item_id,ap_open_item_id,ar_advance_id,ap_advance_id,relationship_id,reference_no,note,status,created_by)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[c.tenant_id,c.company_id,c.source_system,db,no,date,kind,String(ar.party_code),String(ap.party_code),currency,amount,arBase,apBase,apBase-arBase,kind==='open_items'?ar.id:null,kind==='open_items'?ap.id:null,kind==='advances'?ar.id:null,kind==='advances'?ap.id:null,relationship.id,trim(b.reference_no),trim(b.note),'posted',req.auth.id]);
        let movementIds=[];
        if(kind==='open_items'){
          const arBalance=Math.max(Number(ar.balance_amount)-amount,0),apBalance=Math.max(Number(ap.balance_amount)-amount,0);
          const arBaseBalance=Math.max((Number(ar.base_balance_amount||0)>FINANCE_EPS?Number(ar.base_balance_amount):Number(ar.balance_amount)*arRate)-arBase,0),apBaseBalance=Math.max((Number(ap.base_balance_amount||0)>FINANCE_EPS?Number(ap.base_balance_amount):Number(ap.balance_amount)*apRate)-apBase,0);
          await conn.query("UPDATE finance_open_items SET settled_amount=settled_amount+?,base_settled_amount=base_settled_amount+?,balance_amount=?,base_balance_amount=?,status=? WHERE id=?",[amount,arBase,arBalance,arBaseBalance,scopedFinanceStatus(arBalance,'settled'),ar.id]);
          await conn.query("UPDATE finance_open_items SET settled_amount=settled_amount+?,base_settled_amount=base_settled_amount+?,balance_amount=?,base_balance_amount=?,status=? WHERE id=?",[amount,apBase,apBalance,apBaseBalance,scopedFinanceStatus(apBalance,'settled'),ap.id]);
        } else {
          const arBalance=Math.max(Number(ar.balance_amount)-amount,0),apBalance=Math.max(Number(ap.balance_amount)-amount,0);
          await conn.query("UPDATE finance_advances SET applied_amount=applied_amount+?,balance_amount=?,status=? WHERE id=?",[amount,arBalance,scopedFinanceStatus(arBalance,'applied'),ar.id]);
          await conn.query("UPDATE finance_advances SET applied_amount=applied_amount+?,balance_amount=?,status=? WHERE id=?",[amount,apBalance,scopedFinanceStatus(apBalance,'applied'),ap.id]);
          const [arMovement]=await conn.query(`INSERT INTO finance_advance_movements
            (advance_id,movement_date,movement_kind,amount,base_amount,exchange_difference,related_advance_id,relationship_id,reference_no,note,created_by)
            VALUES(?,?, 'offset',?,?,?,?,?,?,?,?)`,[ar.id,date,amount,arBase,arBase-apBase,ap.id,relationship.id,no,trim(b.note),req.auth.id]);
          const [apMovement]=await conn.query(`INSERT INTO finance_advance_movements
            (advance_id,movement_date,movement_kind,amount,base_amount,exchange_difference,related_advance_id,relationship_id,reference_no,note,created_by)
            VALUES(?,?, 'offset',?,?,?,?,?,?,?,?)`,[ap.id,date,amount,apBase,apBase-arBase,ar.id,relationship.id,no,trim(b.note),req.auth.id]);
          movementIds=[arMovement.insertId,apMovement.insertId];
        }
        const draft=await insertFinanceRuleDraft(conn,{context:c,date,moduleCode:'FIN',documentKind:'cross_offset',documentType:kind,debitAmount:apBase,creditAmount:arBase,debitParty:String(ap.party_code),creditParty:String(ar.party_code),sourceKind:'finance_cross_offset',sourceId:header.insertId,sourceDocumentNo:no,accountType:'FIN',memo:kind==='open_items'?'客戶兼廠商應收／應付帳款對沖':'客戶兼廠商預收／預付對沖',userId:req.auth.id});
        await conn.query('UPDATE finance_cross_offsets SET accounting_draft_id=? WHERE id=?',[draft.id,header.insertId]);
        if(movementIds.length)await conn.query(`UPDATE finance_advance_movements SET accounting_draft_id=? WHERE id IN (${movementIds.map(()=>'?').join(',')})`,[draft.id,...movementIds]);
        return{id:header.insertId,offset_no:no,offset_kind:kind,amount,customer_code:ar.party_code,supplier_code:ap.party_code,relationship_id:relationship.id,accounting_draft_id:draft.id,draft_no:draft.draft_no,exchange_difference:apBase-arBase};
      });
      res.status(201).json({ok:true,data:out});
    } catch(e){next(e);}
  });
  app.get('/api/finance-workflow/party-links',async(req,res,next)=>{try{await ensureFinance();const db=String(req.query.source_database||'SH').toUpperCase(),c=ctx(db);const[rows]=await pool.query('SELECT * FROM finance_party_links WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND is_active=1 ORDER BY customer_code,supplier_code',[c.tenant_id,c.company_id,c.source_system,db]);res.json({ok:true,data:rows});}catch(e){next(e);}});
  app.post('/api/finance-workflow/party-links',async(req,res,next)=>{try{await ensureFinance();const b=req.body||{},db=String(b.source_database||'SH').toUpperCase(),c=ctx(db);if(!trim(b.customer_code)||!trim(b.supplier_code))throw badRequest('客戶代號與廠商代號不可空白');await pool.query('INSERT INTO finance_party_links(tenant_id,company_id,source_system,source_database,customer_code,supplier_code,relationship_type,note,created_by) VALUES(?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE is_active=1,relationship_type=VALUES(relationship_type),note=VALUES(note)',[c.tenant_id,c.company_id,c.source_system,db,trim(b.customer_code),trim(b.supplier_code),trim(b.relationship_type)||'customer_supplier',trim(b.note),req.auth.id]);res.status(201).json({ok:true});}catch(e){next(e);}});
  app.post('/api/finance-workflow/customer-credits/:id/apply',async(req,res,next)=>{
    try{
      await ensureFinance();
      const id=Number(req.params.id),openItemId=Number(req.body?.open_item_id),date=validDate(req.body?.movement_date),requested=positiveNumber(req.body?.amount,'轉抵金額'),db=String(req.body?.source_database||req.query.source_database||'SH').toUpperCase(),c=ctx(db);
      const out=await tx(async conn=>{
        const[[credit]]=await conn.query("SELECT * FROM finance_customer_credits WHERE id=? AND status IN ('available','partial') FOR UPDATE",[id]);
        const[[item]]=await conn.query("SELECT * FROM finance_open_items WHERE id=? AND account_type='AR' AND status IN ('open','partial') FOR UPDATE",[openItemId]);
        if(!credit||!item||credit.tenant_id!==item.tenant_id||credit.company_id!==item.company_id||credit.source_system!==item.source_system||credit.source_database!==item.source_database||credit.party_code!==item.party_code||credit.currency_code!==item.currency_code)throw badRequest('待抵與應收帳款必須屬於同公司、同來源、客戶及幣別');
        if(credit.source_database!==c.source_database)throw badRequest('待抵資料庫來源與目前公司別不一致');
        await assertOpenAccountingPeriod(conn,c,date);
        const amount=Math.min(requested,Number(credit.balance_amount),Number(item.balance_amount));
        if(amount<=0||amount+SALES_RETURN_FINANCE_EPS<requested)throw badRequest('轉抵金額超過待抵或應收未沖餘額');
        const creditBalance=Number(credit.balance_amount)-amount,itemBalance=Number(item.balance_amount)-amount,rate=Number(item.exchange_rate||1)||1;
        const newAdjustment=Number(item.adjustment_amount||0)+amount,newBaseAdjustment=Number(item.base_adjustment_amount||0)+amount*rate;
        const newBaseBalance=Math.max((Number(item.base_balance_amount||0)||Number(item.balance_amount)*rate)-amount*rate,0);
        const[[adjustment]]=await conn.query('SELECT * FROM finance_return_adjustments WHERE id=? FOR UPDATE',[credit.source_adjustment_id]);
        await conn.query("UPDATE finance_customer_credits SET applied_amount=applied_amount+?,balance_amount=?,status=CASE WHEN ?<=0.000001 THEN 'applied' ELSE 'partial' END WHERE id=?",[amount,creditBalance,creditBalance,id]);
        await conn.query("UPDATE finance_open_items SET adjustment_amount=?,base_adjustment_amount=?,balance_amount=?,base_balance_amount=?,status=CASE WHEN ?<=0.000001 THEN 'settled' ELSE 'partial' END WHERE id=?",[newAdjustment,newBaseAdjustment,itemBalance,newBaseBalance,itemBalance,openItemId]);
        await conn.query("INSERT INTO finance_customer_credit_movements(credit_id,movement_date,movement_kind,amount,open_item_id,reference_no,note,created_by) VALUES(?,?,'apply',?,?,?,?,?)",[id,date,amount,openItemId,trim(req.body?.reference_no),trim(req.body?.note),req.auth.id]);
        if(adjustment)await recordSalesReturnAdjustmentEvent(conn,adjustment,'credit_apply',adjustment.status,adjustment.status,openItemId,amount,'客戶待抵轉入其他應收',req.auth.id);
        return{id,applied_amount:amount,balance_amount:creditBalance,status:creditBalance<=SALES_RETURN_FINANCE_EPS?'applied':'partial'};
      });
      res.json({ok:true,data:out});
    }catch(e){next(e);}
  });
  app.post('/api/finance-workflow/customer-credits/:id/refund',async(req,res,next)=>{
    try{
      await ensureFinance();
      const id=Number(req.params.id),date=validDate(req.body?.movement_date),amount=positiveNumber(req.body?.amount,'退款金額'),db=String(req.body?.source_database||req.query.source_database||'SH').toUpperCase(),c=ctx(db);
      const out=await tx(async conn=>{
        const[[credit]]=await conn.query("SELECT * FROM finance_customer_credits WHERE id=? AND status IN ('available','partial') FOR UPDATE",[id]);
        if(!credit||credit.source_database!==c.source_database||amount>Number(credit.balance_amount)+SALES_RETURN_FINANCE_EPS)throw badRequest('退款金額超過目前公司別的客戶待抵餘額');
        await assertOpenAccountingPeriod(conn,c,date);
        const balance=Number(credit.balance_amount)-amount;
        const[[adjustment]]=await conn.query('SELECT * FROM finance_return_adjustments WHERE id=? FOR UPDATE',[credit.source_adjustment_id]);
        await conn.query("UPDATE finance_customer_credits SET refunded_amount=refunded_amount+?,balance_amount=?,status=CASE WHEN ?<=0.000001 THEN 'refunded' ELSE 'partial' END WHERE id=?",[amount,balance,balance,id]);
        await conn.query('UPDATE finance_return_adjustments SET refund_amount=refund_amount+?,processed_by=?,processed_at=NOW() WHERE id=?',[amount,req.auth.id,credit.source_adjustment_id]);
        await conn.query("INSERT INTO finance_customer_credit_movements(credit_id,movement_date,movement_kind,amount,reference_no,note,created_by) VALUES(?,?,'refund',?,?,?,?)",[id,date,amount,trim(req.body?.reference_no),trim(req.body?.note)||'退款已登錄，請依付款／銀行作業完成實際退款',req.auth.id]);
        if(adjustment)await recordSalesReturnAdjustmentEvent(conn,adjustment,'credit_refund',adjustment.status,adjustment.status,null,amount,'客戶待抵登錄退款；實際出款由銀行／付款作業完成',req.auth.id);
        return{id,refunded_amount:amount,balance_amount:balance,status:balance<=SALES_RETURN_FINANCE_EPS?'refunded':'partial'};
      });
      res.json({ok:true,data:out});
    }catch(e){next(e);}
  });
  app.get('/api/finance-workflow/customer-credits/:id/movements',async(req,res,next)=>{
    try{
      await ensureFinance();
      const id=Number(req.params.id),db=String(req.query.source_database||'SH').toUpperCase(),c=ctx(db);
      const[rows]=await pool.query(`SELECT m.*,c.party_code,c.currency_code,a.sales_return_id,d.document_no sales_return_no
        FROM finance_customer_credit_movements m
        JOIN finance_customer_credits c ON c.id=m.credit_id
        JOIN finance_return_adjustments a ON a.id=c.source_adjustment_id
        JOIN sales_documents d ON d.id=a.sales_return_id
        WHERE m.credit_id=? AND c.tenant_id=? AND c.company_id=? AND c.source_system=? AND c.source_database=?
        ORDER BY m.movement_date,m.id`,[id,c.tenant_id,c.company_id,c.source_system,db]);
      res.json({ok:true,data:rows});
    }catch(e){next(e);}
  });
  async function getFinanceSourceLine(conn, type, db, row) {
    const id=Number(row.source_document_id||0), itemId=Number(row.source_document_item_id||0);
    if (!id || !itemId) throw badRequest('財務來源必須指定單據與明細');
    let result;
    if (type==='AR') {
      [[result]]=await conn.query(`SELECT d.id source_document_id,i.id source_document_item_id,d.document_kind source_kind,d.document_type source_document_type,
        d.document_no source_document_no,d.document_date,d.customer_code party_code,d.currency_code,i.item_code,i.quantity,i.unit_price,
        i.allowance_amount,CASE WHEN d.document_kind='sales_return' THEN -1*CASE WHEN d.return_type='allowance' THEN COALESCE(NULLIF(i.allowance_amount,0),i.quantity*i.unit_price) ELSE (i.quantity*i.unit_price-COALESCE(i.allowance_amount,0)) END ELSE (i.quantity*i.unit_price-COALESCE(i.allowance_amount,0)) END source_amount
        FROM sales_documents d JOIN sales_document_items i ON i.document_id=d.id
        WHERE d.source_database=? AND d.status='posted' AND d.document_kind IN ('shipment','sales_return') AND d.id=? AND i.id=?`,[db,id,itemId]);
    } else if (String(row.source_kind)==='purchase_return') {
      [[result]]=await conn.query(`SELECT r.id source_document_id,i.id source_document_item_id,'purchase_return' source_kind,r.document_type source_document_type,
        r.return_no source_document_no,r.return_date document_date,r.supplier_code party_code,'TWD' currency_code,i.item_code,
        CASE WHEN r.return_type='return' THEN COALESCE(i.priced_quantity,0) ELSE 0 END quantity,i.unit_cost unit_price,
        CASE WHEN r.return_type='allowance' THEN -COALESCE(i.allowance_amount,0)
          ELSE -(COALESCE(i.priced_quantity,0)*i.unit_cost+
            (COALESCE(ri.freight_amount,0)+COALESCE(ri.insurance_amount,0)+COALESCE(ri.other_expense_amount,0))*COALESCE(i.priced_quantity,0)/NULLIF(ri.qty_accepted,0)) END source_amount,
        i.return_quantity,COALESCE(i.priced_quantity,0) priced_quantity,i.allowance_amount
        FROM procurement_returns r JOIN procurement_return_items i ON i.return_id=r.id
        LEFT JOIN procurement_receipt_items ri ON ri.id=i.receipt_item_id
        WHERE r.source_database=? AND ((r.return_type='return' AND r.status='posted' AND r.inventory_status='posted') OR (r.return_type='allowance' AND r.status='approved' AND r.inventory_status='not_applicable')) AND r.id=? AND i.id=?`,[db,id,itemId]);
    } else {
      [[result]]=await conn.query(`SELECT r.id source_document_id,i.id source_document_item_id,'purchase_receipt' source_kind,r.document_type source_document_type,
        r.receipt_no source_document_no,r.receipt_date document_date,r.supplier_code party_code,'TWD' currency_code,i.item_code,
        COALESCE(i.qty_priced,0) quantity,i.unit_cost unit_price,
        (COALESCE(i.qty_priced,0)*i.unit_cost+(i.freight_amount+i.insurance_amount+i.other_expense_amount)*COALESCE(i.qty_priced,0)/NULLIF(i.qty_accepted,0)) source_amount,
        i.qty_accepted qty_received,COALESCE(i.qty_priced,0) qty_priced,
        (i.freight_amount+i.insurance_amount+i.other_expense_amount) expense_amount
        FROM procurement_receipts r JOIN procurement_receipt_items i ON i.receipt_id=r.id
        WHERE r.source_database=? AND r.inventory_status='posted' AND r.status IN ('accepted','partially_accepted','posted') AND r.id=? AND i.id=?`,[db,id,itemId]);
    }
    if (!result) throw badRequest('來源單據不存在、尚未完成或尚未庫存過帳');
    return result;
  }
  async function listFinanceSourceCandidates(conn, type, db, options={}) {
    const partyCode=trim(options.partyCode),limit=Number(options.limit||0),hasLimit=Number.isFinite(limit)&&limit>0;
    if (type==='AR') {
      const [rows]=await conn.query(`SELECT d.id source_document_id,i.id source_document_item_id,d.document_kind source_kind,d.document_type source_document_type,
        d.document_no source_document_no,d.document_date,d.customer_code party_code,d.currency_code,i.item_code,i.item_name,i.quantity,i.unit,i.unit_price,
        CASE WHEN d.document_kind='sales_return' THEN -1*CASE WHEN d.return_type='allowance' THEN COALESCE(NULLIF(i.allowance_amount,0),i.quantity*i.unit_price) ELSE (i.quantity*i.unit_price-COALESCE(i.allowance_amount,0)) END ELSE (i.quantity*i.unit_price-COALESCE(i.allowance_amount,0)) END amount,
        COALESCE((SELECT SUM(vs.allocated_amount) FROM finance_voucher_sources vs JOIN finance_vouchers v ON v.id=vs.voucher_id WHERE v.status<>'voided' AND vs.source_kind=d.document_kind AND vs.source_document_id=d.id AND COALESCE(vs.source_document_item_id,0)=i.id),0) allocated_amount
        FROM sales_documents d JOIN sales_document_items i ON i.document_id=d.id
        WHERE d.source_database=? AND d.status='posted' AND d.document_kind IN ('shipment','sales_return') ${partyCode?'AND d.customer_code=?':''}
        ORDER BY d.document_date,d.id,i.id${hasLimit?' LIMIT ?':''}`,[...(partyCode?[db,partyCode]:[db]),...(hasLimit?[limit]:[])]);
      return rows.map(x=>({...x,remaining_amount:Number(x.amount)-Number(x.allocated_amount||0)})).filter(x=>Math.abs(x.remaining_amount)>0.000001);
    }
    const [receipts]=await conn.query(`SELECT r.id source_document_id,i.id source_document_item_id,'purchase_receipt' source_kind,r.document_type source_document_type,
      r.receipt_no source_document_no,r.receipt_date document_date,r.supplier_code party_code,'TWD' currency_code,i.item_code,i.item_name,
      COALESCE(i.qty_priced,0) quantity,i.unit,i.unit_cost unit_price,COALESCE(i.qty_accepted,0) qty_accepted,
      COALESCE(i.qty_returned,0) qty_returned,COALESCE(i.qty_returned_priced,0) qty_returned_priced,
      (i.freight_amount+i.insurance_amount+i.other_expense_amount) expense_amount,
      (COALESCE(i.qty_priced,0)*i.unit_cost+(i.freight_amount+i.insurance_amount+i.other_expense_amount)*COALESCE(i.qty_priced,0)/NULLIF(i.qty_accepted,0)) amount,
      COALESCE((SELECT SUM(vs.allocated_amount) FROM finance_voucher_sources vs JOIN finance_vouchers v ON v.id=vs.voucher_id WHERE v.status<>'voided' AND vs.source_kind='purchase_receipt' AND vs.source_document_id=r.id AND COALESCE(vs.source_document_item_id,0)=i.id),0) allocated_amount
      FROM procurement_receipts r JOIN procurement_receipt_items i ON i.receipt_id=r.id
      WHERE r.source_database=? AND r.inventory_status='posted' AND r.status IN ('accepted','partially_accepted','posted') AND COALESCE(i.qty_priced,0)>0 ${partyCode?'AND r.supplier_code=?':''}
      ORDER BY r.receipt_date,r.id,i.id${hasLimit?' LIMIT ?':''}`,[...(partyCode?[db,partyCode]:[db]),...(hasLimit?[limit]:[])]);
    const [returns]=await conn.query(`SELECT r.id source_document_id,i.id source_document_item_id,'purchase_return' source_kind,r.document_type source_document_type,
      r.return_no source_document_no,r.return_date document_date,r.supplier_code party_code,'TWD' currency_code,i.item_code,i.item_name,
      CASE WHEN r.return_type='return' THEN COALESCE(i.priced_quantity,0) ELSE 0 END quantity,i.unit,i.unit_cost unit_price,
      CASE WHEN r.return_type='allowance' THEN -COALESCE(i.allowance_amount,0)
        ELSE -(COALESCE(i.priced_quantity,0)*i.unit_cost+(COALESCE(ri.freight_amount,0)+COALESCE(ri.insurance_amount,0)+COALESCE(ri.other_expense_amount,0))*COALESCE(i.priced_quantity,0)/NULLIF(ri.qty_accepted,0)) END amount,
      i.return_quantity,COALESCE(i.priced_quantity,0) priced_quantity,i.allowance_amount,
      COALESCE((SELECT SUM(vs.allocated_amount) FROM finance_voucher_sources vs JOIN finance_vouchers v ON v.id=vs.voucher_id WHERE v.status<>'voided' AND vs.source_kind='purchase_return' AND vs.source_document_id=r.id AND COALESCE(vs.source_document_item_id,0)=i.id),0) allocated_amount
      FROM procurement_returns r JOIN procurement_return_items i ON i.return_id=r.id
      LEFT JOIN procurement_receipt_items ri ON ri.id=i.receipt_item_id
      WHERE r.source_database=? AND ((r.return_type='return' AND r.status='posted' AND r.inventory_status='posted' AND COALESCE(i.priced_quantity,0)>0) OR (r.return_type='allowance' AND r.status='approved' AND r.inventory_status='not_applicable' AND COALESCE(i.allowance_amount,0)>0)) ${partyCode?'AND r.supplier_code=?':''}
      ORDER BY r.return_date,r.id,i.id${hasLimit?' LIMIT ?':''}`,[...(partyCode?[db,partyCode]:[db]),...(hasLimit?[limit]:[])]);
    return [...receipts,...returns].map(x=>({...x,remaining_amount:Number(x.amount)-Number(x.allocated_amount||0)})).filter(x=>Math.abs(x.remaining_amount)>0.000001);
  }
  app.get('/api/finance-workflow/source-documents',async(req,res,next)=>{try{await ensureFinance();const db=String(req.query.source_database||'SH').toUpperCase(),type=String(req.query.account_type||'AR').toUpperCase(),limit=Math.min(Math.max(Number(req.query.limit)||20,1),100);if(!['AR','AP'].includes(type))throw badRequest('財務類別錯誤');let rows=[];if(type==='AR'){
      const [sales]=await pool.query(`SELECT d.id source_document_id,i.id source_document_item_id,d.document_kind source_kind,d.document_type source_document_type,d.document_no source_document_no,d.document_date,d.customer_code party_code,d.currency_code,i.item_code,i.item_name,i.quantity,i.unit,i.unit_price,i.allowance_amount,
        CASE WHEN d.document_kind='sales_return' THEN -1*CASE WHEN d.return_type='allowance' THEN COALESCE(NULLIF(i.allowance_amount,0),i.quantity*i.unit_price) ELSE (i.quantity*i.unit_price-COALESCE(i.allowance_amount,0)) END ELSE (i.quantity*i.unit_price-COALESCE(i.allowance_amount,0)) END amount,
        COALESCE((SELECT SUM(vs.allocated_amount) FROM finance_voucher_sources vs JOIN finance_vouchers v ON v.id=vs.voucher_id WHERE v.status<>'voided' AND vs.source_kind=d.document_kind AND vs.source_document_id=d.id AND COALESCE(vs.source_document_item_id,0)=i.id),0) allocated_amount
        FROM sales_documents d JOIN sales_document_items i ON i.document_id=d.id
        WHERE d.source_database=? AND d.status='posted' AND d.document_kind IN ('shipment','sales_return')
        ORDER BY d.document_date DESC,d.id DESC,i.id DESC LIMIT ?`,[db,limit]);
      rows=sales.map(x=>({...x,remaining_amount:Number(x.amount)-Number(x.allocated_amount||0)})).filter(x=>Math.abs(x.remaining_amount)>0.000001);
    } else {
      const [receipts]=await pool.query(`SELECT r.id source_document_id,i.id source_document_item_id,'purchase_receipt' source_kind,r.document_type source_document_type,r.receipt_no source_document_no,r.receipt_date document_date,r.supplier_code party_code,'TWD' currency_code,i.item_code,i.item_name,
        COALESCE(i.qty_priced,0) quantity,i.unit,i.unit_cost unit_price,COALESCE(i.qty_accepted,0) qty_accepted,COALESCE(i.qty_returned,0) qty_returned,
        COALESCE(i.qty_returned_priced,0) qty_returned_priced,i.freight_amount,i.insurance_amount,i.other_expense_amount,
        (COALESCE(i.qty_priced,0)*i.unit_cost+(i.freight_amount+i.insurance_amount+i.other_expense_amount)*COALESCE(i.qty_priced,0)/NULLIF(i.qty_accepted,0)) amount,
        COALESCE((SELECT SUM(vs.allocated_amount) FROM finance_voucher_sources vs JOIN finance_vouchers v ON v.id=vs.voucher_id WHERE v.status<>'voided' AND vs.source_kind='purchase_receipt' AND vs.source_document_id=r.id AND COALESCE(vs.source_document_item_id,0)=i.id),0) allocated_amount
        FROM procurement_receipts r JOIN procurement_receipt_items i ON i.receipt_id=r.id
        WHERE r.source_database=? AND r.inventory_status='posted' AND r.status IN ('accepted','partially_accepted','posted') AND COALESCE(i.qty_priced,0)>0
        ORDER BY r.receipt_date DESC,r.id DESC,i.id DESC LIMIT ?`,[db,limit]);
      const [returns]=await pool.query(`SELECT r.id source_document_id,i.id source_document_item_id,'purchase_return' source_kind,r.document_type source_document_type,r.return_no source_document_no,r.return_date document_date,r.supplier_code party_code,'TWD' currency_code,i.item_code,i.item_name,
        CASE WHEN r.return_type='return' THEN COALESCE(i.priced_quantity,0) ELSE 0 END quantity,i.unit,i.unit_cost unit_price,
        CASE WHEN r.return_type='allowance' THEN -COALESCE(i.allowance_amount,0)
          ELSE -(COALESCE(i.priced_quantity,0)*i.unit_cost+(COALESCE(ri.freight_amount,0)+COALESCE(ri.insurance_amount,0)+COALESCE(ri.other_expense_amount,0))*COALESCE(i.priced_quantity,0)/NULLIF(ri.qty_accepted,0)) END amount,
        i.return_quantity,COALESCE(i.priced_quantity,0) priced_quantity,i.allowance_amount,
        COALESCE((SELECT SUM(vs.allocated_amount) FROM finance_voucher_sources vs JOIN finance_vouchers v ON v.id=vs.voucher_id WHERE v.status<>'voided' AND vs.source_kind='purchase_return' AND vs.source_document_id=r.id AND COALESCE(vs.source_document_item_id,0)=i.id),0) allocated_amount
        FROM procurement_returns r JOIN procurement_return_items i ON i.return_id=r.id
        LEFT JOIN procurement_receipt_items ri ON ri.id=i.receipt_item_id
        WHERE r.source_database=? AND ((r.return_type='return' AND r.status='posted' AND r.inventory_status='posted' AND COALESCE(i.priced_quantity,0)>0) OR (r.return_type='allowance' AND r.status='approved' AND r.inventory_status='not_applicable' AND COALESCE(i.allowance_amount,0)>0))
        ORDER BY r.return_date DESC,r.id DESC LIMIT ?`,[db,limit]);
      rows=[...receipts,...returns].map(x=>({...x,remaining_amount:Number(x.amount)-Number(x.allocated_amount||0)})).filter(x=>Math.abs(x.remaining_amount)>0.000001).sort((a,b)=>String(b.document_date).localeCompare(String(a.document_date))||Number(b.source_document_id)-Number(a.source_document_id)).slice(0,limit);
    }res.json({ok:true,data:rows});}catch(e){next(e);}});
  app.get('/api/finance-workflow/vouchers',async(req,res,next)=>{try{await ensureFinance();const db=String(req.query.source_database||'SH').toUpperCase(),type=String(req.query.account_type||'AR').toUpperCase(),limit=Math.min(Math.max(Number(req.query.limit)||20,1),100);const[rows]=await pool.query(`SELECT v.*,oi.document_no open_item_no,COUNT(vs.id) source_count FROM finance_vouchers v LEFT JOIN finance_open_items oi ON oi.source_kind='finance_voucher' AND oi.source_document_id=v.id LEFT JOIN finance_voucher_sources vs ON vs.voucher_id=v.id WHERE v.source_database=? AND v.account_type=? GROUP BY v.id,oi.document_no ORDER BY v.voucher_date DESC,v.id DESC LIMIT ?`,[db,type,limit]);res.json({ok:true,data:rows});}catch(e){next(e);}});
  app.post(['/api/finance-workflow/vouchers-enhanced','/api/finance-workflow/vouchers'],async(req,res,next)=>{try{
    await ensureFinance();const b=req.body||{},db=String(b.source_database||'SH').toUpperCase(),type=String(b.account_type||'AR').toUpperCase(),c=ctx(db);
    const date=validDate(b.voucher_date||b.document_date),due=nullableDate(b.due_date),documentType=trim(b.document_type),mode=trim(b.settlement_mode)||'direct',sourceRows=Array.isArray(b.source_rows)?b.source_rows:[],invoiceNo=trim(b.invoice_no),invoiceDate=nullableDate(b.invoice_date);
    if(!['AR','AP'].includes(type)||!documentType||!['direct','manual','batch'].includes(mode)||(!trim(b.party_code)&&!sourceRows.length))throw badRequest('請輸入有效的結帳／應付憑單資料');
    if(mode==='direct'&&sourceRows.length!==1)throw badRequest('直接結帳必須只選一筆來源單據');if(mode==='batch'&&!sourceRows.length)throw badRequest('整批／月結至少要選擇一筆來源單據');if(mode==='manual'&&sourceRows.length)throw badRequest('來源 9 其他不可帶入來源單據');
    if(invoiceNo&&!invoiceDate)throw badRequest('隨貨附發票／發票補登必須同時輸入發票日期');
    const out=await tx(async conn=>{const lines=[];for(const raw of sourceRows){const line=await getFinanceSourceLine(conn,type,db,raw);const[[used]]=await conn.query(`SELECT COALESCE(SUM(vs.allocated_amount),0) used_amount FROM finance_voucher_sources vs JOIN finance_vouchers v ON v.id=vs.voucher_id WHERE v.status<>'voided' AND vs.source_kind=? AND vs.source_document_id=? AND COALESCE(vs.source_document_item_id,0)=COALESCE(?,0)`,[line.source_kind,line.source_document_id,line.source_document_item_id]);const sourceAmount=Number(line.source_amount),remaining=sourceAmount-Number(used.used_amount||0),requested=raw.allocated_amount===''||raw.allocated_amount==null?remaining:Number(raw.allocated_amount);if(!Number.isFinite(requested)||Math.abs(requested)<0.000001||Math.abs(requested)>Math.abs(remaining)+0.000001||Math.sign(requested)!==Math.sign(remaining))throw badRequest(`來源 ${line.source_document_no} 可立帳金額不足或方向錯誤`);assertChronologicalDate(date,line.document_date,'結帳日期');lines.push({...line,allocated_amount:requested,source_amount:sourceAmount});}
      const party=trim(b.party_code)||lines[0]?.party_code;if(!party)throw badRequest('對象不可空白');if(lines.some(x=>String(x.party_code)!==party))throw badRequest('同一張憑單不可混合不同客戶或廠商');const currency=trim(b.currency_code)||lines[0]?.currency_code||'TWD';if(lines.some(x=>String(x.currency_code||'TWD')!==currency))throw badRequest('同一張單據不可混合不同幣別');
      const total=lines.length?lines.reduce((sum,x)=>sum+Number(x.allocated_amount),0):Number(b.total_amount),tax=Number(b.tax_amount||0),net=Number(b.net_amount??(total-tax));if(!Number.isFinite(total)||total===0)throw badRequest('結帳／應付憑單金額不可為零');const rate=Number(b.exchange_rate)||await financeRate(conn,currency,date,c);if(rate<=0)throw badRequest('匯率必須大於零');
      const prefix=type==='AR'?'ARV':'APV',no=trim(b.voucher_no)||await nextWorkflowNumber(conn,'finance_vouchers','voucher_no',prefix,date),sourceCode=mode==='manual'?'9':'1';
      const[h]=await conn.query(`INSERT INTO finance_vouchers(tenant_id,company_id,source_system,source_database,account_type,document_type,voucher_no,voucher_date,due_date,party_code,currency_code,settlement_mode,closing_basis,source_code,invoice_no,invoice_date,invoice_type,tax_id,invoice_status,exchange_rate,net_amount,tax_amount,total_amount,base_net_amount,base_tax_amount,base_total_amount,status,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?)`,[c.tenant_id,c.company_id,c.source_system,db,type,documentType,no,date,due,party,currency,mode,trim(b.closing_basis)||'manual',sourceCode,trim(b.invoice_no)||null,nullableDate(b.invoice_date),trim(b.invoice_type)||null,trim(b.tax_id)||null,trim(b.invoice_no)?(type==='AR'?'issued':'received'):'none',rate,net,tax,total,net*rate,tax*rate,total*rate,trim(b.note),req.auth.id]);
      for(const line of lines)await conn.query(`INSERT INTO finance_voucher_sources(voucher_id,source_kind,source_document_id,source_document_item_id,source_document_type,source_document_no,source_line_no,source_date,item_code,quantity,unit_price,source_amount,tax_amount,allocated_amount) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[h.insertId,line.source_kind,line.source_document_id,line.source_document_item_id,line.source_document_type,line.source_document_no,line.line_no||null,line.document_date,line.item_code,line.quantity,line.unit_price,line.source_amount,0,line.allocated_amount]);return{id:h.insertId,voucher_no:no,total_amount:total,base_total_amount:total*rate,exchange_rate:rate,source_count:lines.length,status:'draft'};});res.status(201).json({ok:true,data:out});
   }catch(e){next(e);}});
   app.post('/api/finance-workflow/vouchers/auto',async(req,res,next)=>{try{
     await ensureFinance();
     const b=req.body||{},db=String(b.source_database||'SH').toUpperCase(),type=String(b.account_type||'AR').toUpperCase(),basis=trim(b.closing_basis)||'customer',reference=validDate(b.reference_date||b.voucher_date||new Date().toISOString().slice(0,10)),documentType=trim(b.document_type),partyFilter=trim(b.party_code),c=ctx(db),invoiceNo=trim(b.invoice_no),invoiceDate=nullableDate(b.invoice_date);
     if(!['AR','AP'].includes(type)||!['unified','customer'].includes(basis)||!documentType)throw badRequest('自動結帳必須指定 AR／AP、公司統一／客戶結帳日與單別');
     if(invoiceNo&&!invoiceDate)throw badRequest('隨貨附發票／發票補登必須同時輸入發票日期');
     const out=await tx(async conn=>{
       await conn.query('INSERT IGNORE INTO finance_closing_settings(tenant_id,company_id,source_system,source_database,account_type) VALUES(?,?,?,?,?)',[c.tenant_id,c.company_id,c.source_system,db,type]);
       const[[setting]]=await conn.query('SELECT * FROM finance_closing_settings WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND account_type=? FOR UPDATE',[c.tenant_id,c.company_id,c.source_system,db,type]);
       const masterTable=type==='AR'?'erp_customers':'erp_suppliers',masterCode=type==='AR'?'customer_code':'supplier_code';
       const[masters]=await conn.query(`SELECT ${masterCode} party_code,closing_day,currency_code,invoice_type,tax_id FROM ${masterTable} WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=?`,[c.tenant_id,c.company_id,c.source_system,db]);
       const masterMap=new Map(masters.map(row=>[String(row.party_code),row]));
       const candidates=await listFinanceSourceCandidates(conn,type,db,{partyCode:partyFilter}),groups=new Map();
       for(const row of candidates){
         if(partyFilter&&String(row.party_code)!==partyFilter)continue;
         const master=masterMap.get(String(row.party_code)),day=basis==='unified'?setting?.unified_closing_day:(master?.closing_day||setting?.unified_closing_day||31),voucherDate=closingDate(reference,day||31),sourceDate=dateText(row.document_date);
         if(sourceDate>voucherDate)continue;
         const key=[row.party_code,row.currency_code||'TWD',voucherDate].join('|');
         if(!groups.has(key))groups.set(key,{party_code:row.party_code,currency_code:row.currency_code||'TWD',voucher_date:voucherDate,master,rows:[]});
         groups.get(key).rows.push(row);
       }
       const created=[];
       for(const group of groups.values()){
         const lines=[];
         for(const raw of group.rows){
           const line=await getFinanceSourceLine(conn,type,db,raw),[[used]]=await conn.query(`SELECT COALESCE(SUM(vs.allocated_amount),0) used_amount FROM finance_voucher_sources vs JOIN finance_vouchers v ON v.id=vs.voucher_id WHERE v.status<>'voided' AND vs.source_kind=? AND vs.source_document_id=? AND COALESCE(vs.source_document_item_id,0)=COALESCE(?,0)`,[line.source_kind,line.source_document_id,line.source_document_item_id]);
           const sourceAmount=Number(line.source_amount),remaining=sourceAmount-Number(used.used_amount||0),requested=remaining;
           if(!Number.isFinite(requested)||Math.abs(requested)<=0.000001)continue;
           assertChronologicalDate(group.voucher_date,line.document_date,'自動結帳日期');
           lines.push({...line,allocated_amount:requested,source_amount:sourceAmount});
         }
         if(!lines.length)continue;
         const total=lines.reduce((sum,line)=>sum+Number(line.allocated_amount),0),rate=Number(b.exchange_rate)||await financeRate(conn,group.currency_code,group.voucher_date,c),net=total,tax=0;
         if(!Number.isFinite(total)||Math.abs(total)<=0.000001)continue;
         const no=await nextWorkflowNumber(conn,'finance_vouchers','voucher_no',type==='AR'?'ARV':'APV',group.voucher_date),invoiceStatus=invoiceNo?(type==='AR'?'issued':'received'):'none',invoiceType=trim(b.invoice_type)||group.master?.invoice_type||null,taxId=trim(b.tax_id)||group.master?.tax_id||null;
         const[h]=await conn.query(`INSERT INTO finance_vouchers(tenant_id,company_id,source_system,source_database,account_type,document_type,voucher_no,voucher_date,due_date,party_code,currency_code,settlement_mode,closing_basis,source_code,invoice_no,invoice_date,invoice_type,tax_id,invoice_status,exchange_rate,net_amount,tax_amount,total_amount,base_net_amount,base_tax_amount,base_total_amount,status,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?)`,[c.tenant_id,c.company_id,c.source_system,db,type,documentType,no,group.voucher_date,group.voucher_date,group.party_code,group.currency_code,'batch',basis,'1',invoiceNo||null,invoiceDate,invoiceType,taxId,invoiceStatus,rate,net,tax,total,net*rate,tax*rate,total*rate,trim(b.note)||'依結帳日自動產生',req.auth.id]);
         for(const line of lines)await conn.query(`INSERT INTO finance_voucher_sources(voucher_id,source_kind,source_document_id,source_document_item_id,source_document_type,source_document_no,source_line_no,source_date,item_code,quantity,unit_price,source_amount,tax_amount,allocated_amount) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[h.insertId,line.source_kind,line.source_document_id,line.source_document_item_id,line.source_document_type,line.source_document_no,line.line_no||null,line.document_date,line.item_code,line.quantity,line.unit_price,line.source_amount,0,line.allocated_amount]);
         created.push({id:h.insertId,voucher_no:no,party_code:group.party_code,currency_code:group.currency_code,voucher_date:group.voucher_date,closing_basis:basis,total_amount:total,base_total_amount:total*rate,exchange_rate:rate,source_count:lines.length,status:'draft'});
       }
       return {reference_date:reference,closing_basis:basis,vouchers:created};
     });
     res.status(201).json({ok:true,data:out});
   }catch(e){next(e);}});
   app.get('/api/finance-workflow/vouchers/:id/invoice-events',async(req,res,next)=>{try{
     await ensureFinance();
     const id=Number(req.params.id),db=String(req.query.source_database||'SH').toUpperCase(),c=ctx(db);
     const[[voucher]]=await pool.query('SELECT id FROM finance_vouchers WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=?',[id,c.tenant_id,c.company_id,c.source_system,db]);
     if(!voucher)throw notFound('找不到目前公司／資料來源的結帳憑單');
     const[rows]=await pool.query('SELECT * FROM finance_invoice_events WHERE voucher_id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? ORDER BY id DESC',[id,c.tenant_id,c.company_id,c.source_system,db]);
     res.json({ok:true,data:rows});
   }catch(e){next(e);}});
   app.put('/api/finance-workflow/vouchers/:id/invoice',async(req,res,next)=>{try{
     await ensureFinance();
     const b=req.body||{},id=Number(req.params.id),db=String(b.source_database||req.query.source_database||'SH').toUpperCase(),c=ctx(db),invoiceNo=trim(b.invoice_no),invoiceDate=nullableDate(b.invoice_date);
     if(!invoiceNo||!invoiceDate)throw badRequest('補登發票必須輸入發票號碼與發票日期');
     const out=await tx(async conn=>{
       const[[voucher]]=await conn.query("SELECT * FROM finance_vouchers WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND status<>'voided' FOR UPDATE",[id,c.tenant_id,c.company_id,c.source_system,db]);
       if(!voucher)throw notFound('找不到可補登發票的目前公司憑單');
       if(voucher.invoice_status==='voided')throw badRequest('已作廢發票請使用作廢重開，不能直接補登覆蓋');
       const next={invoice_no:invoiceNo,invoice_date:invoiceDate,invoice_type:trim(b.invoice_type)||voucher.invoice_type||null,tax_id:trim(b.tax_id)||voucher.tax_id||null,invoice_status:voucher.account_type==='AR'?'issued':'received'};
       await conn.query('UPDATE finance_vouchers SET invoice_no=?,invoice_date=?,invoice_type=?,tax_id=?,invoice_status=? WHERE id=?',[next.invoice_no,next.invoice_date,next.invoice_type,next.tax_id,next.invoice_status,id]);
       await writeInvoiceEvent(conn,voucher,voucher.invoice_no?'update':'supplement',next,trim(b.reason)|| (voucher.invoice_no?'發票資料更新':'發票補登'),req.auth.id);
       return{id,invoice_status:next.invoice_status,invoice_no:next.invoice_no,invoice_date:next.invoice_date};
     });
     res.json({ok:true,data:out});
   }catch(e){next(e);}});
   app.post('/api/finance-workflow/vouchers/:id/invoice-void',async(req,res,next)=>{try{
     await ensureFinance();
     const b=req.body||{},id=Number(req.params.id),db=String(b.source_database||req.query.source_database||'SH').toUpperCase(),c=ctx(db),reason=trim(b.reason);
     if(!reason)throw badRequest('發票作廢必須輸入原因');
     const out=await tx(async conn=>{
       const[[voucher]]=await conn.query("SELECT * FROM finance_vouchers WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND status<>'voided' FOR UPDATE",[id,c.tenant_id,c.company_id,c.source_system,db]);
       if(!voucher)throw notFound('找不到可作廢發票的目前公司憑單');
       if(!['issued','received'].includes(voucher.invoice_status)||!voucher.invoice_no)throw badRequest('只有已有有效發票的憑單可以作廢');
       const next={invoice_no:voucher.invoice_no,invoice_date:voucher.invoice_date,invoice_type:voucher.invoice_type,tax_id:voucher.tax_id,invoice_status:'voided'};
       await conn.query("UPDATE finance_vouchers SET invoice_status='voided' WHERE id=?",[id]);
       await writeInvoiceEvent(conn,voucher,'void',next,reason,req.auth.id);
       return{id,invoice_status:'voided',invoice_no:voucher.invoice_no};
     });
     res.json({ok:true,data:out});
   }catch(e){next(e);}});
   app.post('/api/finance-workflow/vouchers/:id/invoice-reopen',async(req,res,next)=>{try{
     await ensureFinance();
     const b=req.body||{},id=Number(req.params.id),db=String(b.source_database||req.query.source_database||'SH').toUpperCase(),c=ctx(db),invoiceNo=trim(b.invoice_no),invoiceDate=nullableDate(b.invoice_date),reason=trim(b.reason);
     if(!invoiceNo||!invoiceDate)throw badRequest('發票重開必須輸入新發票號碼與日期');
     if(!reason)throw badRequest('發票重開必須輸入原因');
     const out=await tx(async conn=>{
       const[[voucher]]=await conn.query("SELECT * FROM finance_vouchers WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND status<>'voided' FOR UPDATE",[id,c.tenant_id,c.company_id,c.source_system,db]);
       if(!voucher)throw notFound('找不到可重開發票的目前公司憑單');
       if(voucher.invoice_status!=='voided')throw badRequest('只有已作廢發票可以重開');
       const next={invoice_no:invoiceNo,invoice_date:invoiceDate,invoice_type:trim(b.invoice_type)||voucher.invoice_type||null,tax_id:trim(b.tax_id)||voucher.tax_id||null,invoice_status:voucher.account_type==='AR'?'issued':'received'};
       await conn.query('UPDATE finance_vouchers SET invoice_no=?,invoice_date=?,invoice_type=?,tax_id=?,invoice_status=? WHERE id=?',[next.invoice_no,next.invoice_date,next.invoice_type,next.tax_id,next.invoice_status,id]);
       await writeInvoiceEvent(conn,voucher,'reopen',next,reason,req.auth.id);
       return{id,invoice_status:next.invoice_status,invoice_no:next.invoice_no,invoice_date:next.invoice_date};
     });
     res.json({ok:true,data:out});
   }catch(e){next(e);}});
  app.post(['/api/finance-workflow/vouchers/:id/approve-enhanced','/api/finance-workflow/vouchers/:id/approve'],async(req,res,next)=>{
    try{
      await ensureFinance();
      const id=Number(req.params.id);
      const out=await tx(async conn=>{
        const[[v]]=await conn.query("SELECT * FROM finance_vouchers WHERE id=? AND status='draft' FOR UPDATE",[id]);
        if(!v)throw badRequest('只有草稿結帳／應付憑單可以核准');
        await assertOpenAccountingPeriod(conn,contextFor(String(v.source_database).toUpperCase()),v.voucher_date);
        const[[existing]]=await conn.query("SELECT id FROM finance_open_items WHERE source_kind='finance_voucher' AND source_document_id=? LIMIT 1",[id]);
        if(existing)throw badRequest('此憑單已建立帳款');
        const[r]=await conn.query(`INSERT INTO finance_open_items(tenant_id,company_id,source_system,source_database,account_type,document_no,document_date,due_date,party_code,currency_code,exchange_rate,source_kind,source_document_id,source_document_no,original_amount,balance_amount,base_original_amount,base_balance_amount,status,note,created_by,approved_by,approved_at,posted_by,posted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?,?,NOW(),?,NOW())`,[v.tenant_id,v.company_id,v.source_system,v.source_database,v.account_type,v.voucher_no,v.voucher_date,v.due_date,v.party_code,v.currency_code,v.exchange_rate,'finance_voucher',id,v.voucher_no,v.total_amount,v.total_amount,v.base_total_amount,v.base_total_amount,v.note,req.auth.id,req.auth.id,req.auth.id]);
        await conn.query("UPDATE finance_vouchers SET status='approved',approved_by=?,approved_at=NOW() WHERE id=?",[req.auth.id,id]);
        const synced=await syncPendingSalesReturnAdjustmentsForOpenItem(conn,r.insertId,req.auth.id);
        return{id,voucher_no:v.voucher_no,open_item_id:r.insertId,status:'approved',synced_return_adjustments:synced};
      });
      res.json({ok:true,data:out});
    }catch(e){next(e);}
  });
  app.post('/api/finance-workflow/vouchers',async(req,res,next)=>{try{await ensureFinance();const b=req.body||{},db=String(b.source_database||'SH').toUpperCase(),type=String(b.account_type||'AR').toUpperCase(),c=ctx(db),date=validDate(b.voucher_date||b.document_date),due=nullableDate(b.due_date),documentType=trim(b.document_type),mode=trim(b.settlement_mode)||'direct',sourceRows=Array.isArray(b.source_rows)?b.source_rows:[];if(!['AR','AP'].includes(type)||!documentType||!['direct','manual','batch'].includes(mode)||!trim(b.party_code)&&!sourceRows.length)throw badRequest('請輸入有效的結帳／應付憑單資料');if(mode==='direct'&&sourceRows.length!==1)throw badRequest('直接結帳必須只選一筆來源單據');if(mode==='batch'&&!sourceRows.length)throw badRequest('整批／月結至少要選擇一筆來源單據');if(mode==='manual'&&sourceRows.length)throw badRequest('手動結帳不可帶入來源單據，請直接輸入對象與金額');const out=await tx(async conn=>{const lines=[];for(const raw of sourceRows){const line=await getFinanceSourceLine(conn,type,db,raw);const usedParams=[line.source_kind,line.source_document_id,line.source_document_item_id];const [[used]]=await conn.query(`SELECT COALESCE(SUM(vs.allocated_amount),0) used_amount FROM finance_voucher_sources vs JOIN finance_vouchers v ON v.id=vs.voucher_id WHERE v.status<>'voided' AND vs.source_kind=? AND vs.source_document_id=? AND COALESCE(vs.source_document_item_id,0)=COALESCE(?,0)`,usedParams);const sourceAmount=Number(line.source_amount),remaining=sourceAmount-Number(used.used_amount||0),requested=raw.allocated_amount===''||raw.allocated_amount==null?remaining:Number(raw.allocated_amount);if(!Number.isFinite(requested)||Math.abs(requested)<0.000001||Math.abs(requested)>Math.abs(remaining)+0.000001||Math.sign(requested)!==Math.sign(remaining))throw badRequest(`來源 ${line.source_document_no} 可立帳金額不足或方向錯誤`);assertChronologicalDate(date,line.document_date,'結帳日期');lines.push({...line,allocated_amount:requested,source_amount:sourceAmount});}const party=trim(b.party_code)||lines[0]?.party_code;if(!party)throw badRequest('對象不可空白');if(lines.some(x=>String(x.party_code)!==party))throw badRequest('同一張結帳／應付憑單不可混合不同客戶或廠商');const currency=trim(b.currency_code)||lines[0]?.currency_code||'TWD';if(lines.some(x=>String(x.currency_code||'TWD')!==currency))throw badRequest('同一張單據不可混合不同幣別');const total=lines.length?lines.reduce((sum,x)=>sum+Number(x.allocated_amount),0):Number(b.total_amount);const tax=Number(b.tax_amount||0);if(!Number.isFinite(total)||total===0)throw badRequest('結帳／應付憑單金額不可為零');const net=Number(b.net_amount??(total-tax));const prefix=type==='AR'?'ARV':'APV';const no=trim(b.voucher_no)||await nextWorkflowNumber(conn,'finance_vouchers','voucher_no',prefix,date);const[h]=await conn.query(`INSERT INTO finance_vouchers(tenant_id,company_id,source_system,source_database,account_type,document_type,voucher_no,voucher_date,due_date,party_code,currency_code,settlement_mode,invoice_no,invoice_date,net_amount,tax_amount,total_amount,status,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?)`,[c.tenant_id,c.company_id,c.source_system,db,type,documentType,no,date,due,party,currency,mode,trim(b.invoice_no)||null,nullableDate(b.invoice_date),net,tax,total,trim(b.note),req.auth.id]);for(const line of lines)await conn.query(`INSERT INTO finance_voucher_sources(voucher_id,source_kind,source_document_id,source_document_item_id,source_document_type,source_document_no,source_line_no,source_date,item_code,quantity,unit_price,source_amount,tax_amount,allocated_amount) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[h.insertId,line.source_kind,line.source_document_id,line.source_document_item_id,line.source_document_type,line.source_document_no,line.line_no||null,line.document_date,line.item_code,line.quantity,line.unit_price,line.source_amount,0,line.allocated_amount]);return{id:h.insertId,voucher_no:no,total_amount:total,source_count:lines.length,status:'draft'};});res.status(201).json({ok:true,data:out});}catch(e){next(e);}});
  app.post('/api/finance-workflow/vouchers/:id/approve',async(req,res,next)=>{try{await ensureFinance();const id=Number(req.params.id);const out=await tx(async conn=>{const[[v]]=await conn.query("SELECT * FROM finance_vouchers WHERE id=? AND status='draft' FOR UPDATE",[id]);if(!v)throw badRequest('只有草稿結帳／應付憑單可以核准');await assertOpenAccountingPeriod(conn,contextFor(String(v.source_database).toUpperCase()),v.voucher_date);const[[existing]]=await conn.query("SELECT id FROM finance_open_items WHERE source_kind='finance_voucher' AND source_document_id=? LIMIT 1",[id]);if(existing)throw badRequest('此憑單已建立帳款');const no=v.voucher_no;const[r]=await conn.query(`INSERT INTO finance_open_items(tenant_id,company_id,source_system,source_database,account_type,document_no,document_date,due_date,party_code,currency_code,source_kind,source_document_id,source_document_no,original_amount,balance_amount,status,note,created_by,approved_by,approved_at,posted_by,posted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?,?,NOW(),?,NOW())`,[v.tenant_id,v.company_id,v.source_system,v.source_database,v.account_type,no,v.voucher_date,v.due_date,v.party_code,v.currency_code,'finance_voucher',id,no,v.total_amount,v.total_amount,v.note,req.auth.id,req.auth.id,req.auth.id]);await conn.query("UPDATE finance_vouchers SET status='approved',approved_by=?,approved_at=NOW() WHERE id=?",[req.auth.id,id]);return{id,voucher_no:no,open_item_id:r.insertId,status:'approved'};});res.json({ok:true,data:out});}catch(e){next(e);}});
  app.post('/api/finance-workflow/vouchers/:id/void',async(req,res,next)=>{try{await ensureFinance();const id=Number(req.params.id);await tx(async conn=>{const[[v]]=await conn.query("SELECT * FROM finance_vouchers WHERE id=? AND status<>'voided' FOR UPDATE",[id]);if(!v)throw badRequest('找不到可作廢的憑單');const[[o]]=await conn.query("SELECT id,status FROM finance_open_items WHERE source_kind='finance_voucher' AND source_document_id=? FOR UPDATE",[id]);if(o&&['settled','partial'].includes(o.status))throw badRequest('已沖銷的帳款不可作廢，請走沖銷更正流程');if(o)await conn.query("UPDATE finance_open_items SET status='voided' WHERE id=?",[o.id]);await conn.query("UPDATE finance_vouchers SET status='voided' WHERE id=?",[id]);});res.json({ok:true,data:{id,status:'voided'}});}catch(e){next(e);}});
  app.post('/api/finance-workflow/open-items',async(req,res,next)=>{try{const b=req.body||{},db=String(b.source_database||'SH').toUpperCase(),type=String(b.account_type||'AR').toUpperCase(),c=ctx(db),date=validDate(b.document_date),amount=Number(b.original_amount);if(!['AR','AP'].includes(type)||!trim(b.party_code)||!Number.isFinite(amount)||amount===0)throw badRequest('立帳類別、對象與金額不可空白');const prefix=type==='AR'?'AR':'AP',out=await tx(async conn=>{const no=trim(b.document_no)||await nextWorkflowNumber(conn,'finance_open_items','document_no',prefix,date);const[r]=await conn.query(`INSERT INTO finance_open_items(tenant_id,company_id,source_system,source_database,account_type,document_no,document_date,due_date,party_code,currency_code,source_kind,source_document_id,source_document_no,original_amount,balance_amount,status,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?)`,[c.tenant_id,c.company_id,c.source_system,db,type,no,date,nullableDate(b.due_date),trim(b.party_code),trim(b.currency_code)||'TWD',trim(b.source_kind)||'manual',Number(b.source_document_id)||null,trim(b.source_document_no),amount,amount,trim(b.note),req.auth.id]);return{id:r.insertId,document_no:no};});res.status(201).json({ok:true,data:out});}catch(e){next(e);}});
  app.post('/api/finance-workflow/open-items/:id/approve',async(req,res,next)=>{
    try{
      await ensureFinance();
      const id=Number(req.params.id);
      const synced=await tx(async conn=>{
        const[[f]]=await conn.query("SELECT * FROM finance_open_items WHERE id=? AND status='draft' FOR UPDATE",[id]);
        if(!f)throw badRequest('只有草稿可以立帳');
        await assertOpenAccountingPeriod(conn,contextFor(String(f.source_database).toUpperCase()),f.document_date);
        await conn.query("UPDATE finance_open_items SET status='open',approved_by=?,approved_at=NOW(),posted_by=?,posted_at=NOW() WHERE id=?",[req.auth.id,req.auth.id,id]);
        return syncPendingSalesReturnAdjustmentsForOpenItem(conn,id,req.auth.id);
      });
      res.json({ok:true,data:{id,synced_return_adjustments:synced}});
    }catch(e){next(e);}
  });
  app.get('/api/finance-workflow/open-items',async(req,res,next)=>{try{await ensureFinance();const db=String(req.query.source_database||'SH').toUpperCase(),type=String(req.query.account_type||'AR').toUpperCase(),limit=Math.min(Math.max(Number(req.query.limit)||100,1),200),c=ctx(db);const conditions=['tenant_id=?','company_id=?','source_system=?','source_database=?','account_type=?','status IN (\'open\',\'partial\')'];const params=[c.tenant_id,c.company_id,c.source_system,db,type];if(req.query.party_code){conditions.push('party_code=?');params.push(trim(req.query.party_code));}if(req.query.currency_code){conditions.push('currency_code=?');params.push(String(req.query.currency_code).toUpperCase());}const[rows]=await pool.query(`SELECT * FROM finance_open_items WHERE ${conditions.join(' AND ')} ORDER BY document_date DESC,id DESC LIMIT ?`,[...params,limit]);res.json({ok:true,data:rows});}catch(e){next(e);}});
   app.post(['/api/finance-workflow/settlements-enhanced','/api/finance-workflow/settlements'],async(req,res,next)=>{try{await ensureFinance();const b=req.body||{},date=validDate(b.settlement_date),selectedType=trim(b.document_type),raw=Array.isArray(b.allocations)?b.allocations:[{open_item_id:b.open_item_id,allocated_amount:b.amount}];if(!selectedType)throw badRequest('請選擇收付款單別');const allocations=raw.map(x=>({open_item_id:Number(x.open_item_id),allocated_amount:positiveNumber(x.allocated_amount??x.amount,'沖銷金額')})).filter(x=>x.open_item_id);if(!allocations.length)throw badRequest('至少選擇一筆未沖帳款');const out=await tx(async conn=>{const items=[];for(const a of allocations){const[[o]]=await conn.query("SELECT * FROM finance_open_items WHERE id=? AND status IN ('open','partial') FOR UPDATE",[a.open_item_id]);if(!o||a.allocated_amount>Number(o.balance_amount))throw badRequest('收付金額超過未沖餘額');items.push(o);}const first=items[0];if(items.some(o=>o.account_type!==first.account_type||o.party_code!==first.party_code||o.currency_code!==first.currency_code||o.source_database!==first.source_database))throw badRequest('不可混合不同對象、幣別或公司來源');const amount=allocations.reduce((s,x)=>s+x.allocated_amount,0),rate=Number(b.exchange_rate)||1,baseAmount=amount*rate;const no=trim(b.settlement_no)||await nextWorkflowNumber(conn,'finance_settlements','settlement_no',selectedType,date);let expectedBase=0;for(let i=0;i<items.length;i++)expectedBase+=allocations[i].allocated_amount*Number(items[i].exchange_rate||1);const diff=(first.account_type==='AR'?1:-1)*(baseAmount-expectedBase);const[r]=await conn.query(`INSERT INTO finance_settlements(tenant_id,company_id,source_system,source_database,account_type,settlement_no,settlement_date,party_code,currency_code,exchange_rate,base_amount,exchange_difference,payment_method,bank_code,reference_no,amount,status,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?)`,[first.tenant_id,first.company_id,first.source_system,first.source_database,first.account_type,no,date,first.party_code,first.currency_code,rate,baseAmount,diff,trim(b.payment_method),trim(b.bank_code),trim(b.reference_no),amount,trim(b.note),req.auth.id]);for(let i=0;i<allocations.length;i++){const a=allocations[i],base=a.allocated_amount*rate,lineDiff=(first.account_type==='AR'?1:-1)*(base-a.allocated_amount*Number(items[i].exchange_rate||1));await conn.query('INSERT INTO finance_allocations(settlement_id,open_item_id,allocated_amount,base_allocated_amount,exchange_difference) VALUES(?,?,?,?,?)',[r.insertId,a.open_item_id,a.allocated_amount,base,lineDiff]);}return{id:r.insertId,settlement_no:no,amount,base_amount:baseAmount,exchange_difference:diff};});res.status(201).json({ok:true,data:out});}catch(e){next(e);}});
   app.post(['/api/finance-workflow/settlements/:id/post-enhanced','/api/finance-workflow/settlements/:id/post'],async(req,res,next)=>{try{await ensureFinance();const id=Number(req.params.id);await tx(async conn=>{const[[s]]=await conn.query("SELECT * FROM finance_settlements WHERE id=? AND status='draft' FOR UPDATE",[id]);if(!s)throw badRequest('找不到待過帳收付款單');await assertOpenAccountingPeriod(conn,contextFor(String(s.source_database).toUpperCase()),s.settlement_date);const[rows]=await conn.query('SELECT a.*,o.document_no,o.document_date,o.balance_amount,o.base_balance_amount FROM finance_allocations a JOIN finance_open_items o ON o.id=a.open_item_id WHERE a.settlement_id=? FOR UPDATE',[id]);for(const a of rows){assertChronologicalDate(s.settlement_date,a.document_date,'收付款日期');const balance=Number(a.balance_amount)-Number(a.allocated_amount),baseBalance=Number(a.base_balance_amount)-Number(a.allocated_amount)*(Number(a.base_balance_amount)/Math.max(Number(a.balance_amount),0.000001));await conn.query("UPDATE finance_open_items SET settled_amount=settled_amount+?,base_settled_amount=base_settled_amount+?,balance_amount=?,base_balance_amount=?,status=? WHERE id=?",[a.allocated_amount,a.base_allocated_amount,balance,Math.max(baseBalance,0),Math.abs(balance)<0.000001?'settled':'partial',a.open_item_id]);}await refreshProcurementPaidQuantities(conn,id);await conn.query("UPDATE finance_settlements SET status='posted',approved_by=?,approved_at=NOW(),posted_by=?,posted_at=NOW() WHERE id=?",[req.auth.id,req.auth.id,id]);});res.json({ok:true,data:{id,status:'posted'}});}catch(e){next(e);}});
  app.post('/api/finance-workflow/settlements',async(req,res,next)=>{try{const b=req.body||{},date=validDate(b.settlement_date),selectedType=trim(b.document_type),rawAllocations=Array.isArray(b.allocations)?b.allocations:[{open_item_id:b.open_item_id,allocated_amount:b.amount}];if(!selectedType)throw badRequest('請選擇收付款單別');const allocations=rawAllocations.map(x=>({open_item_id:Number(x.open_item_id),allocated_amount:positiveNumber(x.allocated_amount??x.amount,'沖銷金額')})).filter(x=>x.open_item_id);if(!allocations.length)throw badRequest('至少選擇一筆未沖帳款');const out=await tx(async conn=>{const items=[];for(const a of allocations){const[[o]]=await conn.query("SELECT * FROM finance_open_items WHERE id=? AND status IN ('open','partial') FOR UPDATE",[a.open_item_id]);if(!o||a.allocated_amount>Number(o.balance_amount))throw badRequest('收付金額超過未沖餘額');items.push(o);}const first=items[0];if(items.some(o=>o.account_type!==first.account_type||o.party_code!==first.party_code||o.currency_code!==first.currency_code||o.source_database!==first.source_database))throw badRequest('同一張收付款單不可混合不同對象、幣別或公司來源');const amount=allocations.reduce((sum,x)=>sum+x.allocated_amount,0);const no=trim(b.settlement_no)||await nextWorkflowNumber(conn,'finance_settlements','settlement_no',selectedType,date);const[r]=await conn.query(`INSERT INTO finance_settlements(tenant_id,company_id,source_system,source_database,account_type,settlement_no,settlement_date,party_code,payment_method,bank_code,reference_no,amount,status,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'draft',?,?)`,[first.tenant_id,first.company_id,first.source_system,first.source_database,first.account_type,no,date,first.party_code,trim(b.payment_method),trim(b.bank_code),trim(b.reference_no),amount,trim(b.note),req.auth.id]);for(const a of allocations)await conn.query('INSERT INTO finance_allocations(settlement_id,open_item_id,allocated_amount) VALUES(?,?,?)',[r.insertId,a.open_item_id,a.allocated_amount]);return{id:r.insertId,settlement_no:no,allocation_count:allocations.length,amount};});res.status(201).json({ok:true,data:out});}catch(e){next(e);}});
  app.post('/api/finance-workflow/settlements/:id/post',async(req,res,next)=>{try{await ensureFinance();const id=Number(req.params.id);await tx(async conn=>{const[[s]]=await conn.query("SELECT * FROM finance_settlements WHERE id=? AND status='draft' FOR UPDATE",[id]);if(!s)throw badRequest('找不到待過帳收付款單');await assertOpenAccountingPeriod(conn,contextFor(String(s.source_database).toUpperCase()),s.settlement_date);const[allocations]=await conn.query('SELECT a.*,o.* FROM finance_allocations a JOIN finance_open_items o ON o.id=a.open_item_id WHERE a.settlement_id=? FOR UPDATE',[id]);if(!allocations.length)throw badRequest('收付款單沒有沖銷明細');const total=allocations.reduce((sum,a)=>sum+Number(a.allocated_amount),0);if(Math.abs(total-Number(s.amount))>0.000001)throw badRequest('收付款單總額與沖銷明細不一致');for(const a of allocations){assertChronologicalDate(s.settlement_date,a.document_date,'收付款日期');if(Number(a.allocated_amount)>Number(a.balance_amount))throw badRequest(`帳款 ${a.document_no} 沖銷金額超過未沖餘額`);const balance=Number(a.balance_amount)-Number(a.allocated_amount);await conn.query("UPDATE finance_open_items SET settled_amount=settled_amount+?,balance_amount=?,status=? WHERE id=?",[a.allocated_amount,balance,balance===0?'settled':'partial',a.open_item_id]);}await conn.query("UPDATE finance_settlements SET status='posted',approved_by=?,approved_at=NOW(),posted_by=?,posted_at=NOW() WHERE id=?",[req.auth.id,req.auth.id,id]);});res.json({ok:true,data:{id}});}catch(e){next(e);}});
  app.get('/api/finance-workflow/settlements',async(req,res,next)=>{try{const db=String(req.query.source_database||'SH').toUpperCase(),type=String(req.query.account_type||'AR').toUpperCase(),limit=Math.min(Math.max(Number(req.query.limit)||10,1),100);const[rows]=await pool.query(`SELECT s.*,GROUP_CONCAT(DISTINCT o.document_no ORDER BY o.document_no SEPARATOR '、') open_document_no,COUNT(a.id) allocation_count FROM finance_settlements s LEFT JOIN finance_allocations a ON a.settlement_id=s.id LEFT JOIN finance_open_items o ON o.id=a.open_item_id WHERE s.source_database=? AND s.account_type=? GROUP BY s.id ORDER BY s.settlement_date DESC,s.id DESC LIMIT ?`,[db,type,limit]);res.json({ok:true,data:rows});}catch(e){next(e);}});
  app.get('/api/finance-workflow/document-types',async(req,res,next)=>{try{const db=String(req.query.source_database||'SH').toUpperCase(),type=String(req.query.account_type||'AR').toUpperCase(),kind=String(req.query.document_kind||'settlement');const sourcePool=getSourcePool(db);const spec=type==='AR'?(kind==='open_item'?['acrta','TA001']:['acrtc','TC001']):(kind==='open_item'?['acpta','TA001']:['acptc','TC001']);const[rows]=await sourcePool.query(`SELECT DISTINCT t.${spec[1]} type_code,COALESCE(NULLIF(q.MQ002,''),t.${spec[1]}) type_name FROM ${spec[0]} t LEFT JOIN cmsmq q ON q.COMPANY=t.COMPANY AND q.MQ001=t.${spec[1]} WHERE t.COMPANY=? AND t.${spec[1]}<>'' ORDER BY t.${spec[1]}`,[db]);res.json({ok:true,data:rows});}catch(e){next(e);}});
   app.get('/api/finance-workflow/notes',async(req,res,next)=>{try{await ensureFinance();const db=String(req.query.source_database||'SH').toUpperCase(),type=String(req.query.account_type||'AR').toUpperCase(),c=ctx(db),outstanding=String(req.query.outstanding||'')==='1';const conditions=['n.tenant_id=?','n.company_id=?','n.source_system=?','n.source_database=?','n.account_type=?'];const params=[c.tenant_id,c.company_id,c.source_system,db,type];if(outstanding)conditions.push(type==='AR'?`n.status IN ('received','deposited')`:`n.status IN ('issued')`);const[rows]=await pool.query(`SELECT n.*,s.settlement_no,ba.bank_name,ba.account_no,
      (SELECT COUNT(*) FROM finance_note_events ne WHERE ne.note_id=n.id) event_count,
      (SELECT COUNT(*) FROM finance_note_events ne WHERE ne.note_id=n.id AND ne.accounting_draft_id IS NOT NULL) draft_count,
      (SELECT MAX(ne.event_date) FROM finance_note_events ne WHERE ne.note_id=n.id) last_event_date
      FROM finance_notes n LEFT JOIN finance_settlements s ON s.id=n.settlement_id LEFT JOIN finance_bank_accounts ba ON ba.id=n.bank_account_id
      WHERE ${conditions.join(' AND ')} ORDER BY n.issue_date DESC,n.id DESC LIMIT 100`,params);res.json({ok:true,data:rows});}catch(e){next(e);}});
   app.get('/api/finance-workflow/notes/:id/events',async(req,res,next)=>{try{await ensureFinance();const id=Number(req.params.id),db=String(req.query.source_database||'SH').toUpperCase(),c=ctx(db);const[[note]]=await pool.query('SELECT id FROM finance_notes WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=?',[id,c.tenant_id,c.company_id,c.source_system,db]);if(!note)throw badRequest('找不到目前公司票據');const[rows]=await pool.query(`SELECT e.*,ad.draft_no,bt.transaction_no FROM finance_note_events e LEFT JOIN accounting_drafts ad ON ad.id=e.accounting_draft_id LEFT JOIN finance_bank_transactions bt ON bt.id=e.bank_transaction_id WHERE e.note_id=? ORDER BY e.event_date,e.id`,[id]);res.json({ok:true,data:rows});}catch(e){next(e);}});
   app.post('/api/finance-workflow/notes',async(req,res,next)=>{try{await ensureFinance();const b=req.body||{},db=String(b.source_database||'SH').toUpperCase(),c=ctx(db),settlementId=Number(b.settlement_id||0),type=String(b.account_type||'AR').toUpperCase(),issueDate=validDate(b.issue_date),dueDate=validDate(b.due_date),amount=positiveNumber(b.amount,'票據金額');if(!['AR','AP'].includes(type))throw badRequest('票據類別錯誤');const out=await tx(async conn=>{const[[s]]=await conn.query(`SELECT s.*,(SELECT COALESCE(SUM(n.amount),0) FROM finance_notes n WHERE n.settlement_id=s.id AND n.status<>'voided') note_amount FROM finance_settlements s WHERE s.id=? AND s.account_type=? AND s.status='posted' AND s.tenant_id=? AND s.company_id=? AND s.source_system=? AND s.source_database=? FOR UPDATE`,[settlementId,type,c.tenant_id,c.company_id,c.source_system,db]);if(!s)throw badRequest('票據必須關聯目前公司已過帳的收款或付款單');if(Number(s.note_amount||0)+amount>Number(s.amount)+0.000001)throw badRequest('票據累計金額不可超過收付款單金額');const bankAccountId=Number(b.bank_account_id||0)||null;if(bankAccountId){const[[ba]]=await conn.query('SELECT id FROM finance_bank_accounts WHERE id=? AND source_database=? AND tenant_id=? AND company_id=? AND source_system=? AND is_active=1 FOR UPDATE',[bankAccountId,s.source_database,s.tenant_id,s.company_id,s.source_system]);if(!ba)throw badRequest('票據指定的銀行帳戶不存在或不屬於目前公司');}const prefix=type==='AR'?'ARN':'APN',no=trim(b.note_no)||await nextWorkflowNumber(conn,'finance_notes','note_no',prefix,issueDate),status=type==='AR'?'received':'issued';const[r]=await conn.query(`INSERT INTO finance_notes(tenant_id,company_id,source_system,source_database,account_type,note_no,note_type,issue_date,due_date,party_code,bank_code,bank_account,bank_account_id,amount,settlement_id,status,status_date,status_by,memo,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[s.tenant_id,s.company_id,s.source_system,s.source_database,type,no,trim(b.note_type)||'check',issueDate,dueDate,s.party_code,trim(b.bank_code),trim(b.bank_account),bankAccountId,amount,settlementId,status,issueDate,req.auth.id,trim(b.memo),req.auth.id]);const note={...s,id:r.insertId,note_no:no,amount,status,party_code:s.party_code,account_type:type};await recordNoteEvent(conn,note,null,status,issueDate,null,null,'票據建立',req.auth.id);return{id:r.insertId,note_no:no,status,event_count:1};});res.status(201).json({ok:true,data:out});}catch(e){next(e);}});
   async function postBankTransaction(conn, note, bankAccountId, transactionDate, transactionType, delta, memo, referenceId, userId) {
    const accountId=Number(bankAccountId||note.bank_account_id||0);if(!accountId)throw badRequest('此票據狀態需要指定銀行帳戶');
    const[[account]]=await conn.query('SELECT * FROM finance_bank_accounts WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND is_active=1 FOR UPDATE',[accountId,note.tenant_id,note.company_id,note.source_system,note.source_database]);
    if(!account)throw badRequest('銀行帳戶不存在、已停用或不屬於目前公司');
     const amount=Math.abs(Number(delta));if(!amount) return {accountId,transactionId:null};
    const direction=Number(delta)>0?'in':'out';
    const no=await nextWorkflowNumber(conn,'finance_bank_transactions','transaction_no',direction==='in'?'BIN':'BOUT',transactionDate);
     const [result]=await conn.query(`INSERT INTO finance_bank_transactions(tenant_id,company_id,source_system,source_database,bank_account_id,transaction_no,transaction_date,transaction_type,direction,amount,reference_type,reference_id,reference_no,counterparty,memo,status,created_by,posted_by,posted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'posted',?,?,NOW())`,[note.tenant_id,note.company_id,note.source_system,note.source_database,accountId,no,transactionDate,transactionType,direction,amount,'finance_note',referenceId,note.note_no,note.party_code,memo,userId,userId]);
     await conn.query('UPDATE finance_bank_accounts SET current_balance=current_balance+? WHERE id=?',[Number(delta),accountId]);
     return {accountId,transactionId:result.insertId};
   }
   app.post('/api/finance-workflow/notes/:id/status',async(req,res,next)=>{try{await ensureFinance();const id=Number(req.params.id),nextStatus=trim(req.body?.status),statusDate=validDate(req.body?.status_date||new Date().toISOString().slice(0,10));const transitions={received:['deposited','cashed','voided'],deposited:['cashed','dishonored','voided'],issued:['honored','dishonored','voided'],cashed:['dishonored'],honored:['dishonored'],dishonored:[],voided:[]};const out=await tx(async conn=>{const db=String(req.query.source_database||req.body?.source_database||'SH').toUpperCase(),c=ctx(db);const[[note]]=await conn.query('SELECT * FROM finance_notes WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? FOR UPDATE',[id,c.tenant_id,c.company_id,c.source_system,db]);if(!note)throw badRequest('找不到目前公司票據');if(!(transitions[note.status]||[]).includes(nextStatus))throw badRequest(`票據不可由 ${note.status} 變更為 ${nextStatus}`);await assertOpenAccountingPeriod(conn,c,statusDate);let bankAccountId=note.bank_account_id||Number(req.body?.bank_account_id||0)||null;const existing=[...(await conn.query(`SELECT * FROM finance_bank_transactions WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND reference_type='finance_note' AND reference_id=? AND status='posted' FOR UPDATE`,[note.tenant_id,note.company_id,note.source_system,note.source_database,id]))[0]];const net=existing.reduce((sum,x)=>sum+(x.direction==='in'?1:-1)*Number(x.amount),0);let bankResult={accountId:bankAccountId,transactionId:null};if(['cashed','honored'].includes(nextStatus)){const delta=note.account_type==='AR'?Number(note.amount):-Number(note.amount);bankResult=await postBankTransaction(conn,note,bankAccountId,statusDate,note.account_type==='AR'?'note_cashed':'note_honored',delta,'票據兌現／付款',id,req.auth.id);bankAccountId=bankResult.accountId;}else if(nextStatus==='dishonored'&&Math.abs(net)>0.000001){bankResult=await postBankTransaction(conn,note,bankAccountId,statusDate,'note_dishonored',-net,'票據退票沖回',id,req.auth.id);bankAccountId=bankResult.accountId;}const lines=financeStatusLines(note,note.status,nextStatus);let draft=null;if(lines.length){draft=await insertFinanceDraft(conn,{context:c,date:statusDate,sourceKind:'finance_note_status',sourceId:id,sourceDocumentNo:`${note.note_no}/${nextStatus}`,accountType:note.account_type,partyCode:note.party_code,memo:`票據狀態：${note.status}→${nextStatus}`,lines,userId:req.auth.id});}if(bankResult.transactionId){const[[bankTransaction]]=await conn.query('SELECT * FROM finance_bank_transactions WHERE id=? FOR UPDATE',[bankResult.transactionId]);await conn.query('UPDATE finance_bank_transactions SET accounting_draft_id=? WHERE id=?',[draft?.id||null,bankResult.transactionId]);await recordBankTransactionEvent(conn,bankTransaction,'posted','draft','posted',null,draft?.id||null,'票據狀態異動產生銀行交易',req.auth.id);}await conn.query('UPDATE finance_notes SET status=?,status_date=?,status_by=?,bank_account_id=COALESCE(?,bank_account_id),status_note=? WHERE id=?',[nextStatus,statusDate,req.auth.id,bankAccountId,trim(req.body?.status_note)||`${note.status}→${nextStatus}`,id]);await recordNoteEvent(conn,note,note.status,nextStatus,statusDate,bankResult.transactionId,draft?.id||null,trim(req.body?.status_note)||'票據狀態異動',req.auth.id);return{id,status:nextStatus,bank_account_id:bankAccountId,bank_transaction_id:bankResult.transactionId,accounting_draft_id:draft?.id||null};});res.json({ok:true,data:out});}catch(e){next(e);}});

  app.get('/api/finance-workflow/banks/accounts',async(req,res,next)=>{try{await ensureFinance();const db=String(req.query.source_database||'SH').toUpperCase(),c=ctx(db);const[rows]=await pool.query('SELECT * FROM finance_bank_accounts WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? ORDER BY is_active DESC,bank_code,account_no',[c.tenant_id,c.company_id,c.source_system,db]);res.json({ok:true,data:rows});}catch(e){next(e);}});
  app.post('/api/finance-workflow/banks/accounts',async(req,res,next)=>{try{await ensureFinance();const b=req.body||{},db=String(b.source_database||'SH').toUpperCase(),c=ctx(db),bankCode=trim(b.bank_code),bankName=trim(b.bank_name),accountNo=trim(b.account_no),opening=Number(b.opening_balance||0);if(!bankCode||!bankName||!accountNo||!Number.isFinite(opening))throw badRequest('銀行代號、銀行名稱、帳號與期初餘額不可空白');const[r]=await pool.query('INSERT INTO finance_bank_accounts(tenant_id,company_id,source_system,source_database,bank_code,bank_name,account_no,currency_code,opening_balance,current_balance,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[c.tenant_id,c.company_id,c.source_system,db,bankCode,bankName,accountNo,trim(b.currency_code)||'TWD',opening,opening,trim(b.note),req.auth.id]);res.status(201).json({ok:true,data:{id:r.insertId}});}catch(e){next(e);}});
  app.put('/api/finance-workflow/banks/accounts/:id',async(req,res,next)=>{try{await ensureFinance();const id=Number(req.params.id),b=req.body||{},db=String(b.source_database||req.query.source_database||'SH').toUpperCase(),c=ctx(db);const[r]=await pool.query('UPDATE finance_bank_accounts SET bank_name=?,currency_code=?,is_active=?,note=? WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=?',[trim(b.bank_name),trim(b.currency_code)||'TWD',Number(b.is_active??1),trim(b.note),id,c.tenant_id,c.company_id,c.source_system,db]);if(!r.affectedRows)throw badRequest('找不到目前公司的銀行帳戶');res.json({ok:true,data:{id}});}catch(e){next(e);}});
  app.get('/api/finance-workflow/banks/transactions',async(req,res,next)=>{try{await ensureFinance();const db=String(req.query.source_database||'SH').toUpperCase(),c=ctx(db),limit=Math.min(Math.max(Number(req.query.limit)||50,1),200);const conditions=['t.tenant_id=?','t.company_id=?','t.source_system=?','t.source_database=?'];const params=[c.tenant_id,c.company_id,c.source_system,db];if(req.query.bank_account_id){conditions.push('t.bank_account_id=?');params.push(Number(req.query.bank_account_id));}if(req.query.from_date){conditions.push('t.transaction_date>=?');params.push(validDate(req.query.from_date));}if(req.query.to_date){conditions.push('t.transaction_date<=?');params.push(validDate(req.query.to_date));}if(String(req.query.unreconciled_only||'')==='1')conditions.push("t.status='posted' AND t.reconciled=0");const[rows]=await pool.query(`SELECT t.*,a.bank_code,a.bank_name,a.account_no,(SELECT COUNT(*) FROM finance_bank_transaction_events e WHERE e.transaction_id=t.id) event_count,(SELECT COUNT(*) FROM finance_bank_transactions r WHERE r.reversal_of_id=t.id) reversal_count FROM finance_bank_transactions t JOIN finance_bank_accounts a ON a.id=t.bank_account_id AND a.tenant_id=t.tenant_id AND a.company_id=t.company_id AND a.source_system=t.source_system AND a.source_database=t.source_database WHERE ${conditions.join(' AND ')} ORDER BY t.transaction_date DESC,t.id DESC LIMIT ?`,[...params,limit]);res.json({ok:true,data:rows});}catch(e){next(e);}});
  app.post('/api/finance-workflow/banks/transactions',async(req,res,next)=>{try{await ensureFinance();const b=req.body||{},db=String(b.source_database||'SH').toUpperCase(),date=validDate(b.transaction_date),amount=positiveNumber(b.amount,'銀行交易金額'),direction=trim(b.direction);if(!['in','out'].includes(direction))throw badRequest('銀行交易方向錯誤');const c=ctx(db),accountId=Number(b.bank_account_id);if(!accountId)throw badRequest('請選擇銀行帳戶');const out=await tx(async conn=>{const[[a]]=await conn.query('SELECT * FROM finance_bank_accounts WHERE id=? AND source_database=? AND tenant_id=? AND company_id=? AND source_system=? AND is_active=1 FOR UPDATE',[accountId,db,c.tenant_id,c.company_id,c.source_system]);if(!a)throw badRequest('銀行帳戶不存在或不屬於目前公司');const no=trim(b.transaction_no)||await nextWorkflowNumber(conn,'finance_bank_transactions','transaction_no',direction==='in'?'BIN':'BOUT',date);const[r]=await conn.query(`INSERT INTO finance_bank_transactions(tenant_id,company_id,source_system,source_database,bank_account_id,transaction_no,transaction_date,transaction_type,direction,amount,reference_type,reference_no,counterparty,counter_account_code,counter_account_name,memo,status,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[c.tenant_id,c.company_id,c.source_system,db,accountId,no,date,trim(b.transaction_type)||(direction==='in'?'deposit':'withdrawal'),direction,amount,trim(b.reference_type)||'manual',trim(b.reference_no),trim(b.counterparty),trim(b.counter_account_code)||null,trim(b.counter_account_name)||null,trim(b.memo),'draft',req.auth.id]);const transaction={id:r.insertId,tenant_id:c.tenant_id,company_id:c.company_id,source_system:c.source_system,source_database:db};await recordBankTransactionEvent(conn,transaction,'created',null,'draft',null,null,trim(b.memo)||'建立銀行交易草稿',req.auth.id);return{id:r.insertId,transaction_no:no,status:'draft'};});res.status(201).json({ok:true,data:out});}catch(e){next(e);}});
  app.post('/api/finance-workflow/banks/transactions/:id/post',async(req,res,next)=>{try{await ensureFinance();const id=Number(req.params.id),out=await tx(async conn=>{const db=String(req.body?.source_database||req.query.source_database||'SH').toUpperCase(),c=ctx(db);const[[t]]=await conn.query("SELECT * FROM finance_bank_transactions WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND status='draft' FOR UPDATE",[id,c.tenant_id,c.company_id,c.source_system,db]);if(!t)throw badRequest('找不到目前公司的銀行交易草稿');await assertOpenAccountingPeriod(conn,c,t.transaction_date);const[[a]]=await conn.query('SELECT * FROM finance_bank_accounts WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? FOR UPDATE',[t.bank_account_id,c.tenant_id,c.company_id,c.source_system,db]);if(!a)throw badRequest('銀行帳戶不存在');const counterCode=trim(t.counter_account_code)||(t.direction==='in'?'1101':'2101');const counterName=trim(t.counter_account_name)||(t.direction==='in'?'應收帳款':'應付帳款');const lines=t.direction==='in'?[{line_no:1,account_code:'1001',debit_amount:Number(t.amount),credit_amount:0,description:t.memo||'銀行存入'},{line_no:2,account_code:counterCode,debit_amount:0,credit_amount:Number(t.amount),description:t.memo||'銀行存入'}]:[{line_no:1,account_code:counterCode,debit_amount:Number(t.amount),credit_amount:0,description:t.memo||'銀行提出'},{line_no:2,account_code:'1001',debit_amount:0,credit_amount:Number(t.amount),description:t.memo||'銀行提出'}];lines.find(line=>line.account_code===counterCode).account_name=counterName;lines.find(line=>line.account_code==='1001').account_name='銀行存款';const draft=await insertFinanceDraft(conn,{context:c,date:t.transaction_date,sourceKind:'finance_bank_transaction',sourceId:t.id,sourceDocumentNo:t.transaction_no,accountType:t.direction==='in'?'AR':'AP',partyCode:t.counterparty,memo:t.memo||'銀行存提款分錄底稿',lines,userId:req.auth.id});const delta=t.direction==='in'?Number(t.amount):-Number(t.amount);await conn.query('UPDATE finance_bank_accounts SET current_balance=current_balance+? WHERE id=?',[delta,t.bank_account_id]);await conn.query("UPDATE finance_bank_transactions SET status='posted',accounting_draft_id=?,posted_by=?,posted_at=NOW() WHERE id=?",[draft.id,req.auth.id,id]);await recordBankTransactionEvent(conn,t,'posted','draft','posted',null,draft.id,'銀行交易過帳並產生分錄底稿',req.auth.id);return{id,status:'posted',accounting_draft_id:draft.id,draft_no:draft.draft_no,current_balance:Number(a.current_balance)+delta};});res.json({ok:true,data:out});}catch(e){next(e);}});
  app.post('/api/finance-workflow/banks/transactions/:id/void',async(req,res,next)=>{try{await ensureFinance();const id=Number(req.params.id),out=await tx(async conn=>{const db=String(req.body?.source_database||req.query.source_database||'SH').toUpperCase(),c=ctx(db);const[[t]]=await conn.query("SELECT * FROM finance_bank_transactions WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND status='draft' FOR UPDATE",[id,c.tenant_id,c.company_id,c.source_system,db]);if(!t)throw badRequest('只有目前公司的草稿銀行交易可以註銷');await conn.query("UPDATE finance_bank_transactions SET status='voided' WHERE id=?",[id]);await recordBankTransactionEvent(conn,t,'voided','draft','voided',null,null,trim(req.body?.reason)||'註銷銀行交易草稿',req.auth.id);return{id,status:'voided'};});res.json({ok:true,data:out});}catch(e){next(e);}});
  app.post('/api/finance-workflow/banks/transactions/:id/reverse',async(req,res,next)=>{try{await ensureFinance();const id=Number(req.params.id),date=validDate(req.body?.reversal_date||new Date().toISOString().slice(0,10)),reason=trim(req.body?.reason)||'銀行交易沖回';const out=await tx(async conn=>{const db=String(req.body?.source_database||req.query.source_database||'SH').toUpperCase(),c=ctx(db);const[[t]]=await conn.query("SELECT * FROM finance_bank_transactions WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND status='posted' FOR UPDATE",[id,c.tenant_id,c.company_id,c.source_system,db]);if(!t)throw badRequest('只有目前公司已過帳的銀行交易可以沖回');if(t.reversal_of_id)throw badRequest('沖回交易不可再次沖回');if(Number(t.reconciled))throw badRequest('已對帳交易不可直接沖回，請先依對帳更正流程處理');const[[existing]]=await conn.query('SELECT id FROM finance_bank_transactions WHERE reversal_of_id=? LIMIT 1',[id]);if(existing)throw badRequest('此銀行交易已建立沖回');await assertOpenAccountingPeriod(conn,c,date);const[[a]]=await conn.query('SELECT * FROM finance_bank_accounts WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? FOR UPDATE',[t.bank_account_id,c.tenant_id,c.company_id,c.source_system,db]);if(!a)throw badRequest('銀行帳戶不存在');const direction=t.direction==='in'?'out':'in',counterCode=trim(t.counter_account_code)||(t.direction==='in'?'1101':'2101'),counterName=trim(t.counter_account_name)||(t.direction==='in'?'應收帳款':'應付帳款');const lines=direction==='in'?[{line_no:1,account_code:'1001',debit_amount:Number(t.amount),credit_amount:0,description:`沖回 ${t.transaction_no}`},{line_no:2,account_code:counterCode,debit_amount:0,credit_amount:Number(t.amount),description:`沖回 ${t.transaction_no}`}]:[{line_no:1,account_code:counterCode,debit_amount:Number(t.amount),credit_amount:0,description:`沖回 ${t.transaction_no}`},{line_no:2,account_code:'1001',debit_amount:0,credit_amount:Number(t.amount),description:`沖回 ${t.transaction_no}`}];lines.find(line=>line.account_code===counterCode).account_name=counterName;lines.find(line=>line.account_code==='1001').account_name='銀行存款';const no=await nextWorkflowNumber(conn,'finance_bank_transactions','transaction_no',direction==='in'?'BIN':'BOUT',date);const draft=await insertFinanceDraft(conn,{context:c,date,sourceKind:'finance_bank_reversal',sourceId:t.id,sourceDocumentNo:t.transaction_no,accountType:t.direction==='in'?'AR':'AP',partyCode:t.counterparty,memo:`${reason}（${t.transaction_no}）`,lines,userId:req.auth.id});const[r]=await conn.query(`INSERT INTO finance_bank_transactions(tenant_id,company_id,source_system,source_database,bank_account_id,transaction_no,transaction_date,transaction_type,direction,amount,reference_type,reference_id,reference_no,counterparty,counter_account_code,counter_account_name,memo,status,accounting_draft_id,created_by,posted_by,posted_at,reversal_of_id,reversal_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'posted',?,?,?,NOW(),?,?)`,[c.tenant_id,c.company_id,c.source_system,db,t.bank_account_id,no,date,'reversal',direction,t.amount,'bank_reversal',t.id,t.transaction_no,t.counterparty,counterCode,counterName,reason,draft.id,req.auth.id,req.auth.id,t.id,reason]);const delta=direction==='in'?Number(t.amount):-Number(t.amount);await conn.query('UPDATE finance_bank_accounts SET current_balance=current_balance+? WHERE id=?',[delta,t.bank_account_id]);const reversal={...t,id:r.insertId,transaction_no:no,direction,status:'posted'};await recordBankTransactionEvent(conn,t,'reversed','posted','posted',r.insertId,draft.id,reason,req.auth.id);await recordBankTransactionEvent(conn,reversal,'reversal_created','draft','posted',null,draft.id,reason,req.auth.id);return{id,reversal_transaction_id:r.insertId,reversal_transaction_no:no,accounting_draft_id:draft.id,draft_no:draft.draft_no,current_balance:Number(a.current_balance)+delta};});res.json({ok:true,data:out});}catch(e){next(e);}});
  app.get('/api/finance-workflow/banks/reconciliations',async(req,res,next)=>{try{await ensureFinance();const db=String(req.query.source_database||'SH').toUpperCase(),c=ctx(db);const[rows]=await pool.query(`SELECT r.*,a.bank_code,a.bank_name,a.account_no,(SELECT COUNT(*) FROM finance_bank_reconciliation_items i WHERE i.reconciliation_id=r.id) matched_count,(SELECT COUNT(*) FROM finance_bank_reconciliation_items i WHERE i.reconciliation_id=r.id AND i.status='unmatched') unmatched_count FROM finance_bank_reconciliations r JOIN finance_bank_accounts a ON a.id=r.bank_account_id AND a.tenant_id=r.tenant_id AND a.company_id=r.company_id AND a.source_system=r.source_system AND a.source_database=r.source_database WHERE r.tenant_id=? AND r.company_id=? AND r.source_system=? AND r.source_database=? ORDER BY r.reconciliation_date DESC,r.id DESC LIMIT 100`,[c.tenant_id,c.company_id,c.source_system,db]);res.json({ok:true,data:rows});}catch(e){next(e);}});
  app.get('/api/finance-workflow/banks/reconciliations/:id/items',async(req,res,next)=>{try{await ensureFinance();const id=Number(req.params.id),db=String(req.query.source_database||'SH').toUpperCase(),c=ctx(db);const[[header]]=await pool.query('SELECT id FROM finance_bank_reconciliations WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=?',[id,c.tenant_id,c.company_id,c.source_system,db]);if(!header)throw badRequest('找不到目前公司的對帳單');const[rows]=await pool.query(`SELECT i.id,i.reconciliation_id,i.bank_transaction_id,i.matched_amount,i.statement_date,i.statement_reference_no,i.status AS item_status,i.note,i.created_at,t.transaction_no,t.transaction_date,t.transaction_type,t.direction,t.amount,t.status AS transaction_status,t.reconciled,t.reference_no,t.memo FROM finance_bank_reconciliation_items i JOIN finance_bank_transactions t ON t.id=i.bank_transaction_id WHERE i.reconciliation_id=? ORDER BY t.transaction_date,t.id`,[id]);res.json({ok:true,data:rows});}catch(e){next(e);}});
  app.post('/api/finance-workflow/banks/reconciliations',async(req,res,next)=>{try{await ensureFinance();const b=req.body||{},db=String(b.source_database||'SH').toUpperCase(),date=validDate(b.reconciliation_date),statement=Number(b.statement_balance),accountId=Number(b.bank_account_id);if(!accountId||!Number.isFinite(statement))throw badRequest('請選擇銀行帳戶並輸入對帳單餘額');const c=ctx(db),rawItems=Array.isArray(b.items)?b.items:((Array.isArray(b.transaction_ids)?b.transaction_ids:[]).map(id=>({bank_transaction_id:id})));const out=await tx(async conn=>{const[[a]]=await conn.query('SELECT * FROM finance_bank_accounts WHERE id=? AND source_database=? AND tenant_id=? AND company_id=? AND source_system=? FOR UPDATE',[accountId,db,c.tenant_id,c.company_id,c.source_system]);if(!a)throw badRequest('銀行帳戶不存在或不屬於目前公司');const[[bookRow]]=await conn.query("SELECT ?+COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0) book_balance FROM finance_bank_transactions WHERE bank_account_id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND status='posted' AND transaction_date<=?",[Number(a.opening_balance),accountId,c.tenant_id,c.company_id,c.source_system,db,date]);const book=Number(bookRow.book_balance||0),difference=statement-book;const[r]=await conn.query('INSERT INTO finance_bank_reconciliations(tenant_id,company_id,source_system,source_database,bank_account_id,reconciliation_date,statement_balance,book_balance,difference_amount,status,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,\'draft\',?,?)',[c.tenant_id,c.company_id,c.source_system,db,accountId,date,statement,book,difference,trim(b.note),req.auth.id]);const seen=new Set();for(const raw of rawItems){const transactionId=Number(raw?.bank_transaction_id||raw?.id);if(!transactionId||seen.has(transactionId))throw badRequest('逐筆對帳明細含有無效或重複交易');seen.add(transactionId);const[[t]]=await conn.query("SELECT * FROM finance_bank_transactions WHERE id=? AND bank_account_id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND status='posted' FOR UPDATE",[transactionId,accountId,c.tenant_id,c.company_id,c.source_system,db]);if(!t)throw badRequest('對帳明細必須是同公司同銀行帳戶的已過帳交易');if(Number(t.reconciled))throw badRequest(`交易 ${t.transaction_no} 已完成對帳`);const[[used]]=await conn.query(`SELECT r.id,r.status FROM finance_bank_reconciliation_items i JOIN finance_bank_reconciliations r ON r.id=i.reconciliation_id WHERE i.bank_transaction_id=? AND r.status IN ('completed','difference') LIMIT 1`,[transactionId]);if(used)throw badRequest(`交易 ${t.transaction_no} 已存在於完成對帳 ${used.id}`);const matched=raw?.matched_amount==null||raw.matched_amount===''?Number(t.amount):Number(raw.matched_amount);if(!Number.isFinite(matched)||matched<0||matched>Number(t.amount)+0.000001)throw badRequest(`交易 ${t.transaction_no} 對帳金額錯誤`);await conn.query(`INSERT INTO finance_bank_reconciliation_items(reconciliation_id,bank_transaction_id,matched_amount,statement_date,statement_reference_no,status,note,created_by) VALUES(?,?,?,?,?,?,'',?)`,[r.insertId,transactionId,matched,raw?.statement_date?validDate(raw.statement_date):null,trim(raw?.statement_reference_no),matched>0?'matched':'unmatched',req.auth.id]);}return{id:r.insertId,book_balance:book,difference_amount:difference,matched_count:seen.size,status:'draft'};});res.status(201).json({ok:true,data:out});}catch(e){next(e);}});
  app.post('/api/finance-workflow/banks/reconciliations/:id/complete',async(req,res,next)=>{try{await ensureFinance();const id=Number(req.params.id),out=await tx(async conn=>{const db=String(req.body?.source_database||req.query.source_database||'SH').toUpperCase(),c=ctx(db);const[[r]]=await conn.query("SELECT * FROM finance_bank_reconciliations WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND status='draft' FOR UPDATE",[id,c.tenant_id,c.company_id,c.source_system,db]);if(!r)throw badRequest('找不到目前公司的待完成對帳單');await assertOpenAccountingPeriod(conn,c,r.reconciliation_date);const[items]=await conn.query('SELECT i.id,i.bank_transaction_id,i.matched_amount,i.status AS item_status,t.transaction_no,t.status AS transaction_status,t.reconciled FROM finance_bank_reconciliation_items i JOIN finance_bank_transactions t ON t.id=i.bank_transaction_id WHERE i.reconciliation_id=? FOR UPDATE',[id]);if(!items.length)throw badRequest('完成對帳前至少要選擇一筆交易');for(const item of items){if(item.transaction_status!=='posted')throw badRequest(`交易 ${item.transaction_no} 尚未過帳，不能對帳`);if(item.item_status==='matched'&&Number(item.matched_amount)>0&&Number(item.reconciled))continue;const[[used]]=await conn.query(`SELECT r.id FROM finance_bank_reconciliation_items i JOIN finance_bank_reconciliations r ON r.id=i.reconciliation_id WHERE i.bank_transaction_id=? AND r.status IN ('completed','difference') AND r.id<>? LIMIT 1`,[item.bank_transaction_id,id]);if(used)throw badRequest(`交易 ${item.transaction_no} 已在其他對帳單完成`);}const matchedIds=items.filter(item=>item.item_status==='matched'&&Number(item.matched_amount)>0).map(item=>item.bank_transaction_id);if(matchedIds.length)await conn.query(`UPDATE finance_bank_transactions SET reconciled=1,reconciled_at=NOW() WHERE id IN (${matchedIds.map(()=>'?').join(',')}) AND reconciled=0`,matchedIds);const status=Math.abs(Number(r.difference_amount))<0.000001?'completed':'difference';await conn.query('UPDATE finance_bank_reconciliations SET status=?,completed_by=?,completed_at=NOW() WHERE id=?',[status,req.auth.id,id]);return{id,status,matched_count:matchedIds.length,difference_amount:Number(r.difference_amount)};});res.json({ok:true,data:out});}catch(e){next(e);}});
}

const defaultAccountingAutoRules = [
  ['AR-SHIPMENT-MAIN','AR','shipment','*','main','1101','應收帳款','4101','銷貨收入','銷貨立帳'],
  ['AR-RETURN-MAIN','AR','sales_return','*','main','4101','銷貨收入','1101','應收帳款','銷退沖減應收'],
  ['AR-SHIPMENT-COST','AR','shipment','*','cost','5101','銷貨成本','1201','商品存貨','銷貨出庫成本'],
  ['AR-RETURN-COST','AR','sales_return','*','cost','1201','商品存貨','5101','銷貨成本','銷退回庫成本'],
  ['AP-RECEIPT-MAIN','AP','purchase_receipt','*','main','1201','商品存貨','2101','應付帳款','進貨立帳'],
  ['AP-RETURN-MAIN','AP','purchase_return','*','main','2101','應付帳款','1201','商品存貨','採購退貨沖減應付'],
  ['AR-SETTLEMENT-MAIN','AR','settlement','*','main','1001','銀行存款','1101','應收帳款','收款沖銷'],
  ['AP-SETTLEMENT-MAIN','AP','settlement','*','main','2101','應付帳款','1001','銀行存款','付款沖銷'],
  ['AR-ADVANCE-CREATE','AR','advance_create','*','main','1001','銀行存款','2201','客戶預收款','建立客戶預收／溢收'],
  ['AP-ADVANCE-CREATE','AP','advance_create','*','main','1131','預付貨款','1001','銀行存款','建立廠商預付／溢付'],
  ['AR-ADVANCE-CREATE-RECLASS','AR','advance_create','*','reclass','1101','應收帳款','2201','客戶預收款','收款轉預收／溢收'],
  ['AP-ADVANCE-CREATE-RECLASS','AP','advance_create','*','reclass','1131','預付貨款','2101','應付帳款','付款轉預付／溢付'],
  ['AR-ADVANCE-APPLY','AR','advance_apply','*','main','2201','客戶預收款','1101','應收帳款','預收／溢收轉抵應收'],
  ['AP-ADVANCE-APPLY','AP','advance_apply','*','main','2101','應付帳款','1131','預付貨款','預付／溢付轉抵應付'],
  ['AR-ADVANCE-REFUND','AR','advance_refund','*','main','2201','客戶預收款','1001','銀行存款','客戶預收／溢收退款'],
  ['AP-ADVANCE-REFUND','AP','advance_refund','*','main','1001','銀行存款','1131','預付貨款','廠商預付／溢付退款'],
  ['FIN-CROSS-OPEN','FIN','cross_offset','open_items','main','2101','應付帳款','1101','應收帳款','客戶兼廠商帳款對沖'],
  ['FIN-CROSS-ADVANCE','FIN','cross_offset','advances','main','2201','客戶預收款','1131','預付貨款','客戶兼廠商預收預付對沖']
];

async function seedAccountingAutoRules(conn, context, userId = null) {
  for (const [ruleCode,moduleCode,documentKind,documentType,entryRole,debitCode,debitName,creditCode,creditName,note] of defaultAccountingAutoRules) {
    await conn.query(`INSERT IGNORE INTO accounting_auto_rules
      (tenant_id,company_id,source_system,source_database,rule_code,module_code,document_kind,document_type,entry_role,debit_account_code,debit_account_name,credit_account_code,credit_account_name,is_active,note,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
      [context.tenant_id,context.company_id,context.source_system,context.source_database,ruleCode, moduleCode,documentKind,documentType,entryRole,debitCode,debitName,creditCode,creditName,note,userId]);
  }
}

async function findAccountingAutoRule(conn, context, moduleCode, documentKind, documentType, entryRole) {
  const [[rule]] = await conn.query(`SELECT * FROM accounting_auto_rules
    WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=?
      AND module_code=? AND entry_role=? AND is_active=1
      AND document_kind IN (?, '*') AND document_type IN (?, '*')
    ORDER BY (document_kind=? ) DESC,(document_type=? ) DESC,id
    LIMIT 1`,
    [context.tenant_id,context.company_id,context.source_system,context.source_database,moduleCode,entryRole,documentKind,documentType||'*',documentKind,documentType||'*']);
  if (!rule) throw badRequest(`尚未設定自動分錄規則：${moduleCode}／${documentKind}／${entryRole}`);
  return rule;
}

function accountingRuleLines(rule, amount, partyCode, description) {
  const value=Number(amount),memo=description || rule.note || rule.entry_role;
  return [[rule.debit_account_code,rule.debit_account_name,value,0,partyCode,memo],[rule.credit_account_code,rule.credit_account_name,0,value,partyCode,memo]];
}

// 收付款傳票以本位幣平衡：原帳款先用原立帳匯率換算，實際收／付款
// 用當日匯率換算，差額只能進兌換利益／損失科目，不能直接改寫原帳款。
function accountingSettlementLines(rule, settlement, partyCode, description) {
  const baseAmount=Number(settlement.base_amount||0)||Number(settlement.amount||0);
  const difference=Number(settlement.exchange_difference||0);
  if(!Number.isFinite(baseAmount)||baseAmount<=0) return [];
  const expectedBase=settlement.account_type==='AR' ? baseAmount-difference : baseAmount+difference;
  const debitAmount=settlement.account_type==='AR' ? baseAmount : expectedBase;
  const creditAmount=settlement.account_type==='AR' ? expectedBase : baseAmount;
  const memo=description || rule.note || '收付款沖銷';
  return [
    [rule.debit_account_code,rule.debit_account_name,Math.max(debitAmount,0),0,partyCode,memo],
    [rule.credit_account_code,rule.credit_account_name,0,Math.max(creditAmount,0),partyCode,memo],
  ].filter(line=>Math.abs(Number(line[2]))>0.000001||Math.abs(Number(line[3]))>0.000001);
}

function registerAccountingWorkflowRoutes(app) {
  const accounts = [
    ['1001','銀行存款','asset'],['1101','應收帳款','asset'],['1121','應收票據','asset'],['1122','應收票據託收','asset'],['1131','預付貨款','asset'],['1201','商品存貨','asset'],['2101','應付帳款','liability'],['2141','應付票據','liability'],['2201','客戶預收款','liability'],
    ['3200','期初餘額調整','equity'],['3201','保留盈餘','equity'],['4101','銷貨收入','revenue'],['5101','銷貨成本','expense'],['7161','兌換利益','revenue'],['7162','兌換損失','expense']
  ];
  const ACCOUNTING_EPS = 0.000001;
  const contextFor = db => {
    const source = sourceDatabases[db];
    if (!source) throw badRequest(`找不到資料來源：${db}`);
    return { tenant_id:source.tenant_id||'default', company_id:source.company_id||db, source_system:source.source_system||source.adapter_code||'ism-sh', source_database:db };
  };
  async function seedAccounts(conn, row) {
    for (const [code,name,type] of accounts) await conn.query(`INSERT IGNORE INTO accounting_accounts
      (tenant_id,company_id,source_system,account_code,account_name,account_type) VALUES(?,?,?,?,?,?)`,
      [row.tenant_id,row.company_id,row.source_system,code,name,type]);
  }
  const requestDatabase = req => String(req.body?.source_database || req.query.source_database || req.headers['x-source-database'] || 'SH').toUpperCase();
  const openingKind = value => {
    const key=String(value||'').trim().toLowerCase();
    const aliases={bank:'bank',bank_balance:'bank',ar:'ar',ar_open_item:'ar',receivable:'ar',ap:'ap',ap_open_item:'ap',payable:'ap',ar_note:'ar_note',receivable_note:'ar_note',ap_note:'ap_note',payable_note:'ap_note',gl:'gl',general_ledger:'gl',accounting:'gl'};
    const result=aliases[key];
    if(!result) throw badRequest('期初項目類型只能是銀行、應收、應付、應收票據、應付票據或總帳');
    return result;
  };
  const nonNegativeNumber = (value,label) => {
    const number=Number(value);
    if(!Number.isFinite(number)||number<0) throw badRequest(`${label}不可小於 0`);
    return number;
  };
  function normalizeOpeningInput(raw={}, index, date) {
    const entryKind=openingKind(raw.entry_kind||raw.kind||raw.type);
    const currencyCode=trim(raw.currency_code)||'TWD';
    const documentDate=nullableDate(raw.document_date)||date;
    const common={entry_kind:entryKind,account_type:null,account_code:null,account_name:null,party_code:trim(raw.party_code)||null,currency_code:currencyCode,amount:0,debit_amount:0,credit_amount:0,document_no:trim(raw.document_no)||null,document_date:documentDate,due_date:nullableDate(raw.due_date),source_document_no:trim(raw.source_document_no)||null,bank_code:trim(raw.bank_code)||null,bank_name:trim(raw.bank_name)||null,bank_account_no:trim(raw.bank_account_no||raw.account_no)||null,note_no:trim(raw.note_no)||null,note_type:trim(raw.note_type)||null,note_status:trim(raw.note_status||raw.status)||null};
    if(entryKind==='bank'){
      common.amount=nonNegativeNumber(raw.amount??raw.opening_balance??0,'銀行期初餘額');
      if(!common.bank_code||!common.bank_account_no)throw badRequest(`第 ${index+1} 筆銀行期初資料必須填銀行代號與帳號`);
      common.bank_name=common.bank_name||common.bank_code;
      common.account_code='1001'; common.account_name='銀行存款';
      common.debit_amount=common.amount;
    } else if(entryKind==='ar'||entryKind==='ap'){
      common.amount=positiveNumber(raw.amount??raw.original_amount,entryKind==='ar'?'應收期初金額':'應付期初金額');
      common.account_type=entryKind==='ar'?'AR':'AP';
      if(!common.party_code)throw badRequest(`第 ${index+1} 筆${entryKind==='ar'?'應收':'應付'}期初資料必須填客戶／廠商`);
      common.account_code=entryKind==='ar'?'1101':'2101'; common.account_name=entryKind==='ar'?'應收帳款':'應付帳款';
      if(entryKind==='ar')common.debit_amount=common.amount;else common.credit_amount=common.amount;
    } else if(entryKind==='ar_note'||entryKind==='ap_note'){
      common.amount=positiveNumber(raw.amount,'期初票據金額');
      common.account_type=entryKind==='ar_note'?'AR':'AP';
      if(!common.party_code||!common.note_no)throw badRequest(`第 ${index+1} 筆${entryKind==='ar_note'?'應收':'應付'}票據必須填對象與票據號碼`);
      if(!common.due_date)throw badRequest(`第 ${index+1} 筆票據必須填到期日`);
      common.note_status=entryKind==='ar_note'?(common.note_status||'received'):(common.note_status||'issued');
      const allowed=entryKind==='ar_note'?['received','deposited']:['issued'];
      if(!allowed.includes(common.note_status))throw badRequest(`第 ${index+1} 筆票據狀態不符合期初規則`);
      common.note_type=common.note_type||'check';
      common.account_code=entryKind==='ar_note'?(common.note_status==='deposited'?'1122':'1121'):'2141';
      common.account_name=entryKind==='ar_note'?(common.note_status==='deposited'?'應收票據託收':'應收票據'):'應付票據';
      if(entryKind==='ar_note')common.debit_amount=common.amount;else common.credit_amount=common.amount;
    } else {
      const debit=nonNegativeNumber(raw.debit_amount??raw.debit??0,'總帳期初借方');
      const credit=nonNegativeNumber(raw.credit_amount??raw.credit??0,'總帳期初貸方');
      if((debit>ACCOUNTING_EPS)+(credit>ACCOUNTING_EPS)!==1)throw badRequest(`第 ${index+1} 筆總帳期初資料必須單邊填借方或貸方`);
      if(!trim(raw.account_code))throw badRequest(`第 ${index+1} 筆總帳期初資料必須填會計科目`);
      common.account_code=trim(raw.account_code); common.amount=debit+credit; common.debit_amount=debit; common.credit_amount=credit;
    }
    if(!common.document_no)common.document_no=`L${index+1}`;
    return common;
  }
  async function loadOpeningBatch(conn,id,context,status=null,forUpdate=false){
    const statusClause=status?' AND status=?':'';const params=[id,context.tenant_id,context.company_id,context.source_system,context.source_database];if(status)params.push(status);
    const [[batch]]=await conn.query(`SELECT * FROM accounting_opening_batches WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=?${statusClause}${forUpdate?' FOR UPDATE':''}`,params);
    return batch;
  }
  async function validateOpeningBatch(conn,batch,userId,{persist=true}={}){
    await assertOpenAccountingPeriod(conn,{tenant_id:batch.tenant_id,company_id:batch.company_id,source_system:batch.source_system,source_database:batch.source_database},batch.opening_date);
    await seedAccounts(conn,batch);
    const [rows]=await conn.query('SELECT * FROM accounting_opening_lines WHERE batch_id=? ORDER BY line_no',[batch.id]);
    if(!rows.length)throw badRequest('期初導入批次至少要有一筆明細');
    const codes=[...new Set(rows.map(row=>trim(row.account_code)).filter(Boolean))];
    const [accountRows]=codes.length?await conn.query(`SELECT account_code,account_name,account_type FROM accounting_accounts WHERE tenant_id=? AND company_id=? AND source_system=? AND is_active=1 AND account_code IN (${codes.map(()=>'?').join(',')})`,[batch.tenant_id,batch.company_id,batch.source_system,...codes]):[[]];
    const accountMap=new Map(accountRows.map(row=>[String(row.account_code),row]));
    const seenBank=new Set(),seenNote=new Set(),seenDocument=new Set(),normalized=[];
    const totals={bank_total:0,ar_total:0,ap_total:0,ar_note_total:0,ap_note_total:0,gl_debit_total:0,gl_credit_total:0};
    for(const row of rows){
      const kind=openingKind(row.entry_kind),amount=nonNegativeNumber(row.amount,`期初明細 ${row.line_no} 金額`),lineNo=Number(row.line_no),docNo=trim(row.document_no)||`${batch.batch_no}-L${lineNo}`;
      if(seenDocument.has(docNo)&&kind!=='gl')throw badRequest(`期初單號重複：${docNo}`);if(kind!=='gl')seenDocument.add(docNo);
      const line={...row,entry_kind:kind,document_no:docNo,amount,document_date:dateText(row.document_date)||dateText(batch.opening_date),due_date:row.due_date?dateText(row.due_date):null,source_document_no:trim(row.source_document_no)||null,party_code:trim(row.party_code)||null,currency_code:trim(row.currency_code)||'TWD',bank_code:trim(row.bank_code)||null,bank_name:trim(row.bank_name)||null,bank_account_no:trim(row.bank_account_no)||null,note_no:trim(row.note_no)||null,note_type:trim(row.note_type)||null,note_status:trim(row.note_status)||null};
      if(kind==='bank'){
        if(!line.bank_code||!line.bank_account_no)throw badRequest(`期初銀行 ${lineNo} 缺少銀行代號或帳號`);
        const bankKey=`${line.bank_code}|${line.bank_account_no}`;if(seenBank.has(bankKey))throw badRequest(`同一批次不可重複匯入銀行帳戶：${bankKey}`);seenBank.add(bankKey);totals.bank_total+=amount;line.account_code='1001';line.account_name='銀行存款';line.debit_amount=amount;line.credit_amount=0;
        const [[existing]]=await conn.query('SELECT id,opening_balance,current_balance,opening_batch_id FROM finance_bank_accounts WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND bank_code=? AND account_no=? FOR UPDATE',[batch.tenant_id,batch.company_id,batch.source_system,batch.source_database,line.bank_code,line.bank_account_no]);
        if(existing&&(existing.opening_batch_id&&Number(existing.opening_batch_id)!==Number(batch.id)||Math.abs(Number(existing.opening_balance))>ACCOUNTING_EPS||Math.abs(Number(existing.current_balance))>ACCOUNTING_EPS))throw badRequest(`銀行帳戶 ${bankKey} 已有期初或交易餘額，不能重複導入`);
      } else if(kind==='ar'||kind==='ap'){
        if(!line.party_code)throw badRequest(`期初明細 ${lineNo} 缺少客戶／廠商`);if(amount<=ACCOUNTING_EPS)throw badRequest(`期初明細 ${lineNo} 金額必須大於 0`);line.account_type=kind==='ar'?'AR':'AP';line.account_code=kind==='ar'?'1101':'2101';line.account_name=kind==='ar'?'應收帳款':'應付帳款';line.debit_amount=kind==='ar'?amount:0;line.credit_amount=kind==='ap'?amount:0;totals[kind==='ar'?'ar_total':'ap_total']+=amount;
        const [[existing]]=await conn.query('SELECT id FROM finance_open_items WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND account_type=? AND document_no=? LIMIT 1',[batch.tenant_id,batch.company_id,batch.source_system,batch.source_database,line.account_type,line.document_no]);if(existing)throw badRequest(`期初帳款單號已存在：${line.document_no}`);
      } else if(kind==='ar_note'||kind==='ap_note'){
        if(!line.party_code||!line.note_no||!line.due_date)throw badRequest(`期初票據 ${lineNo} 缺少對象、票號或到期日`);if(amount<=ACCOUNTING_EPS)throw badRequest(`期初票據 ${lineNo} 金額必須大於 0`);line.account_type=kind==='ar_note'?'AR':'AP';line.note_status=line.note_status||(kind==='ar_note'?'received':'issued');const allowed=kind==='ar_note'?['received','deposited']:['issued'];if(!allowed.includes(line.note_status))throw badRequest(`期初票據 ${lineNo} 狀態錯誤`);line.note_type=line.note_type||'check';line.account_code=kind==='ar_note'?(line.note_status==='deposited'?'1122':'1121'):'2141';line.account_name=kind==='ar_note'?(line.note_status==='deposited'?'應收票據託收':'應收票據'):'應付票據';line.debit_amount=kind==='ar_note'?amount:0;line.credit_amount=kind==='ap_note'?amount:0;totals[kind==='ar_note'?'ar_note_total':'ap_note_total']+=amount;
        const noteKey=`${line.account_type}|${line.note_no}`;if(seenNote.has(noteKey))throw badRequest(`期初票據號碼重複：${line.note_no}`);seenNote.add(noteKey);const [[existing]]=await conn.query('SELECT id FROM finance_notes WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND account_type=? AND note_no=? LIMIT 1',[batch.tenant_id,batch.company_id,batch.source_system,batch.source_database,line.account_type,line.note_no]);if(existing)throw badRequest(`票據號碼已存在：${line.note_no}`);
      } else {
        const account=accountMap.get(line.account_code);if(!account)throw badRequest(`總帳期初科目不存在或已停用：${line.account_code}`);const debit=Number(row.debit_amount||0),credit=Number(row.credit_amount||0);if(!Number.isFinite(debit)||!Number.isFinite(credit)||debit<0||credit<0||((debit>ACCOUNTING_EPS)+(credit>ACCOUNTING_EPS)!==1))throw badRequest(`總帳期初明細 ${lineNo} 借貸金額錯誤`);line.account_name=account.account_name;line.account_type=account.account_type;line.amount=debit+credit;line.debit_amount=debit;line.credit_amount=credit;totals.gl_debit_total+=debit;totals.gl_credit_total+=credit;
      }
      line.validation_status='ready';line.validation_message=null;normalized.push(line);
    }
    const updateTotals={...totals,line_count:normalized.length};
    if(persist){
      for(const line of normalized)await conn.query(`UPDATE accounting_opening_lines SET entry_kind=?,account_type=?,account_code=?,account_name=?,party_code=?,currency_code=?,amount=?,debit_amount=?,credit_amount=?,document_no=?,document_date=?,due_date=?,source_document_no=?,bank_code=?,bank_name=?,bank_account_no=?,note_no=?,note_type=?,note_status=?,validation_status='ready',validation_message=NULL WHERE id=?`,[line.entry_kind,line.account_type,line.account_code,line.account_name,line.party_code,line.currency_code,line.amount,line.debit_amount,line.credit_amount,line.document_no,line.document_date,line.due_date,line.source_document_no,line.bank_code,line.bank_name,line.bank_account_no,line.note_no,line.note_type,line.note_status,line.id]);
      await conn.query(`UPDATE accounting_opening_batches SET bank_total=?,ar_total=?,ap_total=?,ar_note_total=?,ap_note_total=?,gl_debit_total=?,gl_credit_total=?,line_count=?,status='validated',validated_by=?,validated_at=NOW() WHERE id=?`,[totals.bank_total,totals.ar_total,totals.ap_total,totals.ar_note_total,totals.ap_note_total,totals.gl_debit_total,totals.gl_credit_total,normalized.length,userId,batch.id]);
    }
    return {rows:normalized,totals:updateTotals};
  }
  async function queryTrialRows(conn,context,from,to){
    const [rows]=await conn.query(`SELECT l.account_code,MAX(l.account_name) account_name,MAX(a.account_type) account_type,
        COALESCE(SUM(CASE WHEN j.journal_date<? THEN l.debit_amount ELSE 0 END),0) opening_debit,
        COALESCE(SUM(CASE WHEN j.journal_date<? THEN l.credit_amount ELSE 0 END),0) opening_credit,
        COALESCE(SUM(CASE WHEN j.journal_date BETWEEN ? AND ? THEN l.debit_amount ELSE 0 END),0) period_debit,
        COALESCE(SUM(CASE WHEN j.journal_date BETWEEN ? AND ? THEN l.credit_amount ELSE 0 END),0) period_credit
      FROM accounting_journals j JOIN accounting_journal_lines l ON l.journal_id=j.id
      LEFT JOIN accounting_accounts a ON a.tenant_id=? AND a.company_id=? AND a.source_system=? AND a.account_code=l.account_code
      WHERE j.tenant_id=? AND j.company_id=? AND j.source_system=? AND j.source_database=? AND j.status='posted' AND j.journal_date<=?
      GROUP BY l.account_code ORDER BY l.account_code`,[from,from,from,to,from,to,context.tenant_id,context.company_id,context.source_system,context.tenant_id,context.company_id,context.source_system,context.source_database,to]);
    return rows.map(row=>{const openingDebit=Number(row.opening_debit||0),openingCredit=Number(row.opening_credit||0),periodDebit=Number(row.period_debit||0),periodCredit=Number(row.period_credit||0);return {...row,opening_debit:openingDebit,opening_credit:openingCredit,period_debit:periodDebit,period_credit:periodCredit,opening_balance:openingDebit-openingCredit,period_balance:periodDebit-periodCredit,ending_debit:openingDebit+periodDebit,ending_credit:openingCredit+periodCredit,ending_balance:openingDebit+periodDebit-openingCredit-periodCredit};});
  }
  async function queryLedgerDetails(conn,context,from,to,account,limit){
    const conditions=['j.tenant_id=?','j.company_id=?','j.source_system=?','j.source_database=?',"j.status='posted'",'j.journal_date BETWEEN ? AND ?'];const params=[context.tenant_id,context.company_id,context.source_system,context.source_database,from,to];if(account){conditions.push('l.account_code=?');params.push(account);}const [opening]=await conn.query(`SELECT l.account_code,COALESCE(SUM(l.debit_amount-l.credit_amount),0) opening_balance FROM accounting_journals j JOIN accounting_journal_lines l ON l.journal_id=j.id WHERE j.tenant_id=? AND j.company_id=? AND j.source_system=? AND j.source_database=? AND j.status='posted' AND j.journal_date<?${account?' AND l.account_code=?':''} GROUP BY l.account_code`,[context.tenant_id,context.company_id,context.source_system,context.source_database,from,...(account?[account]:[])]);
    const [rows]=await conn.query(`SELECT j.id journal_id,j.journal_no,j.journal_date,j.source_kind,j.source_document_no,j.memo,l.line_no,l.account_code,l.account_name,l.debit_amount,l.credit_amount,l.party_code,l.description FROM accounting_journals j JOIN accounting_journal_lines l ON l.journal_id=j.id WHERE ${conditions.join(' AND ')} ORDER BY j.journal_date,j.id,l.line_no LIMIT ?`,[...params,limit]);
    const running=new Map(opening.map(row=>[String(row.account_code),Number(row.opening_balance||0)]));const details=rows.map(row=>{const key=String(row.account_code);const next=(running.get(key)||0)+Number(row.debit_amount||0)-Number(row.credit_amount||0);running.set(key,next);return {...row,debit_amount:Number(row.debit_amount||0),credit_amount:Number(row.credit_amount||0),running_balance:next};});return {opening_balances:opening.map(row=>({...row,opening_balance:Number(row.opening_balance||0)})),rows:details};
  }
  async function queryFinancialReconciliation(conn,context,asOf){
    const trial=await queryTrialRows(conn,context,'1900-01-01',asOf);const byCode=new Map(trial.map(row=>[String(row.account_code),row]));
    const [[ar]] = await conn.query("SELECT COALESCE(SUM(CASE WHEN status IN ('open','partial') THEN balance_amount ELSE 0 END),0) amount FROM finance_open_items WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND account_type='AR' AND document_date<=?",[context.tenant_id,context.company_id,context.source_system,context.source_database,asOf]);
    const [[ap]] = await conn.query("SELECT COALESCE(SUM(CASE WHEN status IN ('open','partial') THEN balance_amount ELSE 0 END),0) amount FROM finance_open_items WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND account_type='AP' AND document_date<=?",[context.tenant_id,context.company_id,context.source_system,context.source_database,asOf]);
    const [[notes]] = await conn.query("SELECT COALESCE(SUM(CASE WHEN account_type='AR' AND status IN ('received','deposited') THEN amount ELSE 0 END),0) ar_outstanding,COALESCE(SUM(CASE WHEN account_type='AP' AND status='issued' THEN amount ELSE 0 END),0) ap_outstanding FROM finance_notes WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND issue_date<=?",[context.tenant_id,context.company_id,context.source_system,context.source_database,asOf]);
    const [banks]=await conn.query(`SELECT a.id,a.bank_code,a.bank_name,a.account_no,a.opening_balance,a.current_balance,COALESCE(a.opening_balance,0)+COALESCE(SUM(CASE WHEN t.status='posted' AND t.transaction_date<=? AND t.direction='in' THEN t.amount WHEN t.status='posted' AND t.transaction_date<=? AND t.direction='out' THEN -t.amount ELSE 0 END),0) book_balance FROM finance_bank_accounts a LEFT JOIN finance_bank_transactions t ON t.bank_account_id=a.id AND t.tenant_id=a.tenant_id AND t.company_id=a.company_id AND t.source_system=a.source_system AND t.source_database=a.source_database WHERE a.tenant_id=? AND a.company_id=? AND a.source_system=? AND a.source_database=? GROUP BY a.id ORDER BY a.bank_code,a.account_no`,[asOf,asOf,context.tenant_id,context.company_id,context.source_system,context.source_database]);
    const controls=[{account_code:'1101',label:'應收帳款',gl_balance:Number(byCode.get('1101')?.ending_balance||0),subledger_balance:Number(ar.amount||0),difference:Number(byCode.get('1101')?.ending_balance||0)-Number(ar.amount||0)},{account_code:'2101',label:'應付帳款',gl_balance:Number(byCode.get('2101')?.ending_balance||0),subledger_balance:-Number(ap.amount||0),difference:Number(byCode.get('2101')?.ending_balance||0)+Number(ap.amount||0)},{account_code:'1121/1122',label:'未兌現應收票據',gl_balance:Number(byCode.get('1121')?.ending_balance||0)+Number(byCode.get('1122')?.ending_balance||0),subledger_balance:Number(notes.ar_outstanding||0),difference:Number(byCode.get('1121')?.ending_balance||0)+Number(byCode.get('1122')?.ending_balance||0)-Number(notes.ar_outstanding||0)},{account_code:'2141',label:'未兌現應付票據',gl_balance:Number(byCode.get('2141')?.ending_balance||0),subledger_balance:-Number(notes.ap_outstanding||0),difference:Number(byCode.get('2141')?.ending_balance||0)+Number(notes.ap_outstanding||0)}];
    const bankRows=banks.map(row=>({...row,opening_balance:Number(row.opening_balance||0),current_balance:Number(row.current_balance||0),book_balance:Number(row.book_balance||0),difference:Number(row.current_balance||0)-Number(row.book_balance||0)}));
    return {as_of_date:asOf,trial_totals:{debit:trial.reduce((s,r)=>s+r.ending_debit,0),credit:trial.reduce((s,r)=>s+r.ending_credit,0)},controls,banks:bankRows,notes:{ar_outstanding:Number(notes.ar_outstanding||0),ap_outstanding:Number(notes.ap_outstanding||0)},balanced:controls.every(row=>Math.abs(row.difference)<=ACCOUNTING_EPS)&&bankRows.every(row=>Math.abs(row.difference)<=ACCOUNTING_EPS)};
  }
  async function periodBlockers(conn,period){
    const checks=[
      ['accounting_drafts',`tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND draft_date BETWEEN ? AND ? AND status IN ('draft','approved')`,'會計分錄底稿'],
      ['accounting_journals',`tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND journal_date BETWEEN ? AND ? AND status='draft'`,'草稿傳票'],
      ['finance_vouchers',`tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND voucher_date BETWEEN ? AND ? AND status IN ('draft','approved')`,'應收／應付憑單'],
      ['finance_settlements',`tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND settlement_date BETWEEN ? AND ? AND status IN ('draft','approved')`,'收付款單'],
      ['finance_bank_transactions',`tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND transaction_date BETWEEN ? AND ? AND status='draft'`,'銀行交易草稿'],
      ['finance_notes',`tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND issue_date BETWEEN ? AND ? AND status='draft'`,'票據草稿'],
      ['finance_opening_balances',`tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND opening_date BETWEEN ? AND ? AND status IN ('draft','approved')`,'單筆期初帳款'],
      ['accounting_opening_batches',`tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND opening_date BETWEEN ? AND ? AND status IN ('draft','validated','approved')`,'期初導入批次'],
      ['inventory_documents',`tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND document_date BETWEEN ? AND ? AND status IN ('draft','approved')`,'庫存異動草稿'],
      ['sales_documents',`tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND document_date BETWEEN ? AND ? AND document_kind IN ('shipment','sales_return') AND status IN ('draft','approved')`,'銷貨／銷退草稿'],
      ['procurement_receipts',`source_database=? AND receipt_date BETWEEN ? AND ? AND status IN ('draft','pending_inspection','accepted','partially_accepted')`,'進貨驗收／入庫待處理'],
      ['procurement_returns',`source_database=? AND return_date BETWEEN ? AND ? AND (status='draft' OR inventory_status='pending')`,'採購退貨待處理']
    ];
    const blockers=[];const scoped=[period.tenant_id,period.company_id,period.source_system,period.source_database,period.start_date,period.end_date];
    for(const [table,condition,label] of checks){
      const params=table.startsWith('procurement_')?[period.source_database,period.start_date,period.end_date]:scoped;
      const [[row]]=await conn.query(`SELECT COUNT(*) count FROM ${table} WHERE ${condition}`,params);if(Number(row.count))blockers.push({table,label,count:Number(row.count)});
    }
    return blockers;
  }
  function nextPeriodCode(periodCode){
    const [year,month]=String(periodCode).split('-').map(Number);if(!year||!month)return null;return month===12?`${year+1}-01`:`${year}-${String(month+1).padStart(2,'0')}`;
  }
  const sourceAmountOf = row => {
    const baseBalance = row?.base_balance_amount === null || row?.base_balance_amount === undefined || row?.base_balance_amount === '' ? null : Number(row.base_balance_amount);
    const balance = row?.balance_amount === null || row?.balance_amount === undefined || row?.balance_amount === '' ? null : Number(row.balance_amount);
    if (Number.isFinite(baseBalance) && Math.abs(baseBalance) > 0.000001) return baseBalance;
    if (Number.isFinite(balance) && Math.abs(balance) > 0.000001) return balance;
    if (baseBalance !== null || balance !== null) return 0;
    for (const key of ['base_original_amount','original_amount']) {
      if (row?.[key] === null || row?.[key] === undefined || row?.[key] === '') continue;
      const amount = Number(row[key]);
      if (Number.isFinite(amount)) return amount;
    }
    return 0;
  };
  function sourceReferencesFromBody(body = {}) {
    const raw = Array.isArray(body.source_refs) ? body.source_refs : [];
    if (!raw.length && body.open_item_id) raw.push({ source_kind:'finance_open_item', source_id:body.open_item_id });
    const ids = raw.map(value => Number(typeof value === 'object' ? (value.source_id ?? value.id) : value));
    if (ids.some(id => !Number.isInteger(id) || id < 1)) throw badRequest('來源帳款代號不正確');
    const unique = [...new Set(ids)];
    if (!unique.length) throw badRequest('請至少選擇一筆來源帳款');
    if (unique.length !== ids.length) throw badRequest('來源帳款不可重複選取');
    return unique;
  }
  async function normalizeDraftLines(conn, rawLines, options = {}) {
    const { preserveLineNo = false, context = null } = options;
    if (!Array.isArray(rawLines) || rawLines.length < 2) throw badRequest('底稿至少需要兩筆分錄');
    if (!context) throw badRequest('底稿缺少公司別範圍');
    await seedAccounts(conn, context);
    const lines = rawLines.map((raw, index) => {
      const debit = Number(raw?.debit_amount ?? raw?.debit ?? 0);
      const credit = Number(raw?.credit_amount ?? raw?.credit ?? 0);
      const accountCode = trim(raw?.account_code);
      if (!accountCode || !Number.isFinite(debit) || !Number.isFinite(credit) || debit < 0 || credit < 0 || ((debit > 0) + (credit > 0)) !== 1) {
        throw badRequest(`第 ${index + 1} 筆底稿科目或借貸金額不正確`);
      }
      const lineNo = preserveLineNo ? Number(raw?.line_no) : index + 1;
      if (preserveLineNo && (!Number.isInteger(lineNo) || lineNo < 1)) throw badRequest(`第 ${index + 1} 筆底稿行次不正確`);
      return {
        line_no: lineNo,
        account_code: accountCode,
        debit_amount: debit,
        credit_amount: credit,
        party_code: trim(raw?.party_code) || null,
        description: trim(raw?.description) || null,
        required_clearing: Number(raw?.required_clearing || 0) ? 1 : 0,
        clearing_type: trim(raw?.clearing_type) || null,
        clearing_ref: trim(raw?.clearing_ref) || null
      };
    });
    const codes = [...new Set(lines.map(line => line.account_code))];
    const [accountRows] = await conn.query(`SELECT account_code,account_name FROM accounting_accounts
      WHERE tenant_id=? AND company_id=? AND source_system=? AND is_active=1 AND account_code IN (${codes.map(() => '?').join(',')})`,
      [context.tenant_id, context.company_id, context.source_system, ...codes]);
    const accountMap = new Map(accountRows.map(row => [String(row.account_code), row]));
    for (const line of lines) {
      const account = accountMap.get(line.account_code);
      if (!account) throw badRequest(`科目不存在或已停用：${line.account_code}`);
      line.account_name = account.account_name;
      if (line.required_clearing && (!line.party_code || !line.clearing_type || !line.clearing_ref)) {
        throw badRequest(`科目 ${line.account_code} 需要填寫對象、立沖類型與立沖來源`);
      }
    }
    const debitTotal = lines.reduce((sum, line) => sum + line.debit_amount, 0);
    const creditTotal = lines.reduce((sum, line) => sum + line.credit_amount, 0);
    if (debitTotal <= 0 || Math.abs(debitTotal - creditTotal) > 0.000001) throw badRequest('底稿借貸不平衡，不能保存');
    if (preserveLineNo && new Set(lines.map(line => line.line_no)).size !== lines.length) throw badRequest('底稿行次不可重複');
    return { lines, debitTotal, creditTotal };
  }
  function summarizeDraftLines(lines) {
    const groups = new Map();
    for (const line of lines) {
      const side = line.debit_amount > 0 ? 'D' : 'C';
      const key = [line.account_code, side, line.party_code || '', line.required_clearing ? 1 : 0, line.clearing_type || ''].join('|');
      let group = groups.get(key);
      if (!group) {
        group = { ...line, debit_amount:0, credit_amount:0, clearingRefs:new Set(), descriptions:new Set() };
        groups.set(key, group);
      }
      group.debit_amount += line.debit_amount;
      group.credit_amount += line.credit_amount;
      if (line.clearing_ref) group.clearingRefs.add(line.clearing_ref);
      if (line.description) group.descriptions.add(line.description);
    }
    return [...groups.values()].map((line, index) => ({
      line_no:index + 1,
      account_code:line.account_code,
      account_name:line.account_name,
      debit_amount:line.debit_amount,
      credit_amount:line.credit_amount,
      party_code:line.party_code,
      description:[...line.descriptions].join('；').slice(0, 500) || null,
      required_clearing:line.required_clearing,
      clearing_type:line.clearing_type,
      clearing_ref:[...line.clearingRefs].join(',').slice(0, 255) || null
    }));
  }
  async function loadOpenItemsForDraft(conn, ids, context) {
    const [rows] = await conn.query(`SELECT * FROM finance_open_items
      WHERE id IN (${ids.map(() => '?').join(',')}) AND tenant_id=? AND company_id=? AND source_system=? AND source_database=?
        AND status IN ('open','partial') FOR UPDATE`,
      [...ids, context.tenant_id, context.company_id, context.source_system, context.source_database]);
    const byId = new Map(rows.map(row => [Number(row.id), row]));
    if (rows.length !== ids.length) throw badRequest('來源帳款不存在、未立帳或不屬於目前公司');
    const result = ids.map(id => byId.get(id));
    const accountTypes = new Set(result.map(row => row.account_type));
    if (accountTypes.size > 1) throw badRequest('同一份會計底稿不可混合應收與應付來源');
    for (const row of result) {
      if (Math.abs(sourceAmountOf(row)) <= 0.000001) throw badRequest(`來源帳款 ${row.document_no} 已無可立帳餘額`);
      const journalKind = `finance_${String(row.account_type).toLowerCase()}`;
      const [[journal]] = await conn.query(`SELECT id,journal_no,status FROM accounting_journals
        WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND source_kind=? AND source_id=? AND status<>'voided' LIMIT 1`,
        [context.tenant_id,context.company_id,context.source_system,context.source_database,journalKind,row.id]);
      if (journal) throw badRequest(`來源帳款 ${row.document_no} 已有會計傳票 ${journal.journal_no}`);
      const [[locked]] = await conn.query(`SELECT d.id,d.draft_no,d.status FROM accounting_draft_sources s
        JOIN accounting_drafts d ON d.id=s.draft_id
        WHERE s.source_kind='finance_open_item' AND s.source_id=? AND d.status IN ('draft','approved','posted') LIMIT 1`, [row.id]);
      if (locked) throw badRequest(`來源帳款 ${row.document_no} 已鎖定於底稿 ${locked.draft_no}（${locked.status}）`);
    }
    return result;
  }
  async function autoDraftLines(conn, context, items) {
    const groups = [];
    const costGroups = [];
    const addGroup = (accountType, flowKind, flowType, amount, partyCode, source, entryRole = 'main') => {
      const value = Number(amount);
      if (!Number.isFinite(value) || Math.abs(value) <= 0.000001) return;
      const sign = value < 0 ? 'negative' : 'positive';
      const key = [entryRole,accountType,flowKind,flowType || '*',sign,partyCode || ''].join('|');
      const target = entryRole === 'cost' ? costGroups : groups;
      let current = target.find(row => row.key === key);
      if (!current) {
        current = { key, accountType, flowKind, flowType:flowType || '*', amount:0, partyCode, entryRole, refs:new Set(), sourceRows:[] };
        target.push(current);
      }
      current.amount += value;
      if (source) {
        current.refs.add(String(source.document_no || source.source_document_no || source.id));
        current.sourceRows.push(source);
      }
    };
    for (const item of items) {
      let voucherRows = [];
      if (item.source_kind === 'finance_voucher' && item.source_document_id) {
        [voucherRows] = await conn.query(`SELECT source_kind,source_document_type,source_document_id,source_document_item_id,
          source_amount,allocated_amount,source_document_no FROM finance_voucher_sources WHERE voucher_id=? ORDER BY id`, [item.source_document_id]);
      }
      if (voucherRows.length) {
        for (const row of voucherRows) addGroup(item.account_type,row.source_kind,row.source_document_type || '*',row.allocated_amount || row.source_amount,item.party_code,item);
      } else {
        addGroup(item.account_type,item.account_type === 'AR' ? 'shipment' : 'purchase_receipt','*',sourceAmountOf(item),item.party_code,item);
      }
      if (item.account_type === 'AR') {
        const costRows = voucherRows.length ? voucherRows : [{ source_kind:'shipment', source_document_id:item.source_document_id, source_document_item_id:null, source_amount:sourceAmountOf(item), allocated_amount:sourceAmountOf(item) }];
        for (const row of costRows) {
          if (!['shipment','sales_return'].includes(row.source_kind) || !row.source_document_id) continue;
          const itemFilter = row.source_document_item_id ? ' AND id=?' : '';
          const params = row.source_document_item_id ? [row.source_document_id,row.source_document_item_id] : [row.source_document_id];
          const [[cost]] = await conn.query(`SELECT COALESCE(SUM(quantity*unit_cost),0) amount FROM sales_document_items WHERE document_id=?${itemFilter}`, params);
          const ratio = Number(row.source_amount) && Math.abs(Number(row.source_amount)) > 0 ? Math.min(1, Math.abs(Number(row.allocated_amount || 0) / Number(row.source_amount))) : 1;
          const amount = Math.abs(Number(cost?.amount || 0)) * ratio;
          if (amount > 0.000001) addGroup('AR',row.source_kind,row.source_document_type || '*',row.allocated_amount < 0 ? -amount : amount,item.party_code,item,'cost');
        }
      }
    }
    const rawLines = [];
    await seedAccountingAutoRules(conn,context,null);
    const toLines = async group => {
      const rule = await findAccountingAutoRule(conn,context,group.accountType,group.flowKind,group.flowType,group.entryRole);
      const refs = [...group.refs].join(',').slice(0,255);
      const controlCode = group.accountType === 'AR'
        ? (group.flowKind === 'sales_return' ? rule.credit_account_code : rule.debit_account_code)
        : (group.flowKind === 'purchase_return' ? rule.debit_account_code : rule.credit_account_code);
      for (const row of accountingRuleLines(rule,Math.abs(group.amount),group.partyCode,rule.note || '自動分錄')) {
        const requiresClearing = group.entryRole === 'main' && row[0] === controlCode;
        rawLines.push({account_code:row[0],account_name:row[1],debit_amount:row[2],credit_amount:row[3],party_code:row[4],description:row[5],required_clearing:requiresClearing ? 1 : 0,clearing_type:requiresClearing ? group.accountType : null,clearing_ref:requiresClearing ? refs : null});
      }
    };
    for (const group of groups) await toLines(group);
    for (const group of costGroups) await toLines(group);
    return summarizeDraftLines(rawLines);
  }
  async function assertDraftSourcesLocked(conn, draft, { forUpdate = true } = {}) {
    const [sources] = await conn.query(`SELECT s.*,f.document_no,f.status source_status,f.account_type,
        f.original_amount,f.balance_amount,f.base_balance_amount
      FROM accounting_draft_sources s LEFT JOIN finance_open_items f ON f.id=s.source_id
      WHERE s.draft_id=? ORDER BY s.id${forUpdate ? ' FOR UPDATE' : ''}`, [draft.id]);
    for (const source of sources) {
      if (!source.document_no || !['open','partial'].includes(String(source.source_status))) throw badRequest(`底稿來源 ${source.source_id} 已不存在、已結清或已作廢`);
      const currentAmount = sourceAmountOf(source);
      if (Math.abs(currentAmount) <= 0.000001) throw badRequest(`底稿來源 ${source.document_no} 已無可立帳餘額`);
      if (Math.abs(currentAmount - Number(source.locked_amount || 0)) > 0.000001) throw badRequest(`底稿來源 ${source.document_no} 餘額已變動，請還原後重新產生`);
      const journalKind = `finance_${String(source.account_type).toLowerCase()}`;
      const [[journal]] = await conn.query(`SELECT journal_no FROM accounting_journals
        WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND source_kind=? AND source_id=? AND status<>'voided' LIMIT 1`,
        [draft.tenant_id,draft.company_id,draft.source_system,draft.source_database,journalKind,source.source_id]);
      if (journal) throw badRequest(`底稿來源 ${source.document_no} 已拋轉傳票 ${journal.journal_no}`);
      const [[other]] = await conn.query(`SELECT d.draft_no,d.status FROM accounting_draft_sources s JOIN accounting_drafts d ON d.id=s.draft_id
        WHERE s.source_kind='finance_open_item' AND s.source_id=? AND d.id<>? AND d.status IN ('draft','approved','posted') LIMIT 1`, [source.source_id,draft.id]);
      if (other) throw badRequest(`底稿來源 ${source.document_no} 已被其他底稿 ${other.draft_no} 鎖定`);
    }
    return sources;
  }
  async function assertDraftClearingBalances(conn, draft, lines) {
    const requiredLines = lines.filter(line => Number(line.required_clearing) === 1);
    if (!draft.source_locked) return;
    if (!requiredLines.length) throw badRequest('有鎖定來源的底稿至少要有一筆立沖分錄');
    const [sources] = await conn.query(`SELECT s.source_document_no,s.locked_amount,f.account_type,f.party_code
      FROM accounting_draft_sources s JOIN finance_open_items f ON f.id=s.source_id
      WHERE s.draft_id=? ORDER BY s.id FOR UPDATE`, [draft.id]);
    if (!sources.length) throw badRequest('底稿來源鎖定資料不存在，請還原後重新產生');
    const sourceMap = new Map(sources.map(source => [String(source.source_document_no), source]));
    const referenced = new Set();
    let clearingTotal = 0;
    for (const line of requiredLines) {
      const clearingType = String(line.clearing_type || '').toUpperCase();
      if (!['AR','AP'].includes(clearingType)) throw badRequest(`科目 ${line.account_code} 的立沖類型只能是 AR 或 AP`);
      if (draft.account_type && clearingType !== String(draft.account_type).toUpperCase()) throw badRequest('立沖類型不可與來源帳款類別不同');
      const refs = String(line.clearing_ref || '').split(/[,，]/).map(value => value.trim()).filter(Boolean);
      if (!refs.length) throw badRequest(`科目 ${line.account_code} 缺少立沖來源`);
      clearingTotal += Number(line.debit_amount) + Number(line.credit_amount);
      for (const ref of refs) {
        const source = sourceMap.get(ref);
        if (!source) throw badRequest(`立沖來源 ${ref} 不在本底稿鎖定來源內`);
        if (String(source.account_type).toUpperCase() !== clearingType) throw badRequest(`立沖來源 ${ref} 的類別不一致`);
        if (line.party_code && source.party_code && String(line.party_code) !== String(source.party_code)) throw badRequest(`立沖來源 ${ref} 的對象不一致`);
        referenced.add(ref);
      }
    }
    if (referenced.size !== sources.length) throw badRequest('立沖來源未涵蓋本底稿全部鎖定帳款');
    const available = sources.reduce((sum, source) => sum + Math.abs(Number(source.locked_amount || 0)), 0);
    if (clearingTotal - available > 0.000001) throw badRequest(`立沖金額超過來源可用餘額（可用 ${available}）`);
  }
  async function insertDraft(conn, { context, date, sourceKind = 'manual', sourceId = null, sourceDocumentNo = null, accountType = null, partyCode = null, memo = null, lines, sources = [], userId }) {
    const firstDebit = lines.find(line => line.debit_amount > 0) || lines[0];
    const firstCredit = lines.find(line => line.credit_amount > 0) || lines[1] || lines[0];
    const debitTotal = lines.reduce((sum,line) => sum + Number(line.debit_amount),0);
    const draftNo = await nextWorkflowNumber(conn,'accounting_drafts','draft_no','AD',date);
    const [header] = await conn.query(`INSERT INTO accounting_drafts
      (tenant_id,company_id,source_system,source_database,draft_no,draft_date,source_kind,source_id,source_document_no,account_type,party_code,
       debit_account_code,debit_account_name,credit_account_code,credit_account_name,amount,status,source_locked,source_locked_at,source_locked_by,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?,?)`,
      [context.tenant_id,context.company_id,context.source_system,context.source_database,draftNo,date,sourceKind,sourceId,sourceDocumentNo,accountType,partyCode,
        firstDebit.account_code,firstDebit.account_name,firstCredit.account_code,firstCredit.account_name,debitTotal,sources.length ? 1 : 0,sources.length ? new Date() : null,sources.length ? userId : null,userId]);
    for (const line of lines) await conn.query(`INSERT INTO accounting_draft_lines
      (draft_id,line_no,account_code,account_name,debit_amount,credit_amount,party_code,description,required_clearing,clearing_type,clearing_ref)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [header.insertId,line.line_no,line.account_code,line.account_name,line.debit_amount,line.credit_amount,line.party_code,line.description,line.required_clearing,line.clearing_type,line.clearing_ref]);
    for (const source of sources) await conn.query(`INSERT INTO accounting_draft_sources
      (draft_id,source_kind,source_id,source_document_no,source_amount,locked_amount) VALUES(?,?,?,?,?,?)`,
      [header.insertId,source.source_kind || 'finance_open_item',source.source_id,source.document_no,source.original_amount,source.locked_amount]);
    await conn.query(`INSERT INTO accounting_draft_events(draft_id,event_kind,before_status,after_status,reason,user_id)
      VALUES(?,'generated',NULL,'draft',?,?)`, [header.insertId,memo || '產生會計分錄底稿',userId]);
    await assertDraftClearingBalances(conn,{id:header.insertId,source_locked:sources.length ? 1 : 0,account_type:accountType},lines);
    return { id:header.insertId, draft_no:draftNo, draft_date:date, status:'draft', source_locked:Boolean(sources.length), source_count:sources.length, line_count:lines.length, debit_total:debitTotal, credit_total:debitTotal };
  }
  async function loadDraftHeader(conn, id, context, status = null, forUpdate = false) {
    const statusClause = status ? ' AND status=?' : '';
    const params = [id,context.tenant_id,context.company_id,context.source_system,context.source_database];
    if (status) params.push(status);
    const [[draft]] = await conn.query(`SELECT * FROM accounting_drafts WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=?${statusClause}${forUpdate ? ' FOR UPDATE' : ''}`, params);
    return draft;
  }
  async function validateStoredDraft(conn, draft, context) {
    await assertOpenAccountingPeriod(conn,context,draft.draft_date);
    const [stored] = await conn.query('SELECT * FROM accounting_draft_lines WHERE draft_id=? ORDER BY line_no', [draft.id]);
    const checked = await normalizeDraftLines(conn,stored,{preserveLineNo:true,context});
    if (draft.source_locked) await assertDraftSourcesLocked(conn,draft);
    await assertDraftClearingBalances(conn,draft,checked.lines);
    return checked;
  }
  app.get('/api/accounting/drafts', async (req,res,next)=>{try{await ensureTargetFinanceWorkflowSchema();const db=requestDatabase(req),c=contextFor(db);const[rows]=await pool.query(`SELECT d.*,
      (SELECT COUNT(*) FROM accounting_draft_lines l WHERE l.draft_id=d.id) line_count,
      (SELECT COALESCE(SUM(l.debit_amount),0) FROM accounting_draft_lines l WHERE l.draft_id=d.id) debit_total,
      (SELECT COALESCE(SUM(l.credit_amount),0) FROM accounting_draft_lines l WHERE l.draft_id=d.id) credit_total,
      (SELECT COUNT(*) FROM accounting_draft_sources s WHERE s.draft_id=d.id) source_count
      FROM accounting_drafts d WHERE d.tenant_id=? AND d.company_id=? AND d.source_system=? AND d.source_database=? ORDER BY d.draft_date DESC,d.id DESC LIMIT 200`,[c.tenant_id,c.company_id,c.source_system,db]);res.json({ok:true,data:rows});}catch(e){next(e);}});
   app.get('/api/accounting/drafts/:id', async (req,res,next)=>{try{await ensureTargetFinanceWorkflowSchema();const db=requestDatabase(req),c=contextFor(db),id=Number(req.params.id);const draft=await loadDraftHeader(pool,id,c);if(!draft)throw notFound('找不到目前公司底稿');const[lines]=await pool.query('SELECT * FROM accounting_draft_lines WHERE draft_id=? ORDER BY line_no',[id]);const[sources]=await pool.query('SELECT * FROM accounting_draft_sources WHERE draft_id=? ORDER BY id',[id]);const[events]=await pool.query('SELECT * FROM accounting_draft_events WHERE draft_id=? ORDER BY created_at,id',[id]);res.json({ok:true,data:{...draft,lines,sources,events}});}catch(e){next(e);}});
   app.get('/api/accounting/opening-batches',async(req,res,next)=>{try{await ensureTargetFinanceWorkflowSchema();const db=requestDatabase(req),c=contextFor(db);const[rows]=await pool.query(`SELECT b.*,(SELECT COUNT(*) FROM accounting_opening_lines l WHERE l.batch_id=b.id) line_count,(SELECT COUNT(*) FROM accounting_opening_lines l WHERE l.batch_id=b.id AND l.validation_status='ready') ready_line_count FROM accounting_opening_batches b WHERE b.tenant_id=? AND b.company_id=? AND b.source_system=? AND b.source_database=? ORDER BY b.opening_date DESC,b.id DESC LIMIT 200`,[c.tenant_id,c.company_id,c.source_system,db]);res.json({ok:true,data:rows});}catch(e){next(e);}});
   app.get('/api/accounting/opening-batches/:id',async(req,res,next)=>{try{await ensureTargetFinanceWorkflowSchema();const db=requestDatabase(req),c=contextFor(db),id=Number(req.params.id),batch=await loadOpeningBatch(pool,id,c);if(!batch)throw notFound('找不到目前公司的期初導入批次');const[lines]=await pool.query('SELECT * FROM accounting_opening_lines WHERE batch_id=? ORDER BY line_no',[id]);const[events]=await pool.query('SELECT * FROM accounting_opening_events WHERE batch_id=? ORDER BY created_at,id',[id]);res.json({ok:true,data:{...batch,lines,events}});}catch(e){next(e);}});
   app.post('/api/accounting/opening-batches',async(req,res,next)=>{try{await ensureTargetFinanceWorkflowSchema();const b=req.body||{},db=requestDatabase(req),c=contextFor(db),date=validDate(b.opening_date||new Date().toISOString().slice(0,10)),rawLines=Array.isArray(b.lines)?b.lines:[];if(!rawLines.length)throw badRequest('期初導入至少要有一筆項目');const out=await tx(async conn=>{const batchNo=trim(b.batch_no)||await nextWorkflowNumber(conn,'accounting_opening_batches','batch_no','OB',date),lines=rawLines.map((raw,index)=>{const line=normalizeOpeningInput(raw,index,date);line.document_no=trim(raw?.document_no)||`${batchNo}-L${index+1}`;return line;});if(lines.every(line=>Math.abs(Number(line.amount||0))<=ACCOUNTING_EPS))throw badRequest('期初導入金額不可全部為 0');const totals={bank_total:lines.filter(x=>x.entry_kind==='bank').reduce((s,x)=>s+x.amount,0),ar_total:lines.filter(x=>x.entry_kind==='ar').reduce((s,x)=>s+x.amount,0),ap_total:lines.filter(x=>x.entry_kind==='ap').reduce((s,x)=>s+x.amount,0),ar_note_total:lines.filter(x=>x.entry_kind==='ar_note').reduce((s,x)=>s+x.amount,0),ap_note_total:lines.filter(x=>x.entry_kind==='ap_note').reduce((s,x)=>s+x.amount,0),gl_debit_total:lines.reduce((s,x)=>s+x.debit_amount,0),gl_credit_total:lines.reduce((s,x)=>s+x.credit_amount,0)};const[r]=await conn.query(`INSERT INTO accounting_opening_batches(tenant_id,company_id,source_system,source_database,batch_no,opening_date,source_label,note,status,bank_total,ar_total,ap_total,ar_note_total,ap_note_total,gl_debit_total,gl_credit_total,line_count,created_by) VALUES(?,?,?,?,?,?,?,?, 'draft',?,?,?,?,?,?,?,?,?)`,[c.tenant_id,c.company_id,c.source_system,db,batchNo,date,trim(b.source_label)||null,trim(b.note)||null,totals.bank_total,totals.ar_total,totals.ap_total,totals.ar_note_total,totals.ap_note_total,totals.gl_debit_total,totals.gl_credit_total,lines.length,req.auth.id]);for(const line of lines)await conn.query(`INSERT INTO accounting_opening_lines(batch_id,line_no,entry_kind,account_type,account_code,account_name,party_code,currency_code,amount,debit_amount,credit_amount,document_no,document_date,due_date,source_document_no,bank_code,bank_name,bank_account_no,note_no,note_type,note_status,validation_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`,[r.insertId,line.line_no||lines.indexOf(line)+1,line.entry_kind,line.account_type,line.account_code,line.account_name,line.party_code,line.currency_code,line.amount,line.debit_amount,line.credit_amount,line.document_no,line.document_date,line.due_date,line.source_document_no,line.bank_code,line.bank_name,line.bank_account_no,line.note_no,line.note_type,line.note_status]);await conn.query(`INSERT INTO accounting_opening_events(tenant_id,company_id,source_system,source_database,batch_id,event_kind,before_status,after_status,reason,user_id) VALUES(?,?,?,?,?,'created',NULL,'draft',?,?)`,[c.tenant_id,c.company_id,c.source_system,db,r.insertId,trim(b.note)||'建立期初導入批次',req.auth.id]);return{id:r.insertId,batch_no:batchNo,opening_date:date,status:'draft',line_count:lines.length};});res.status(201).json({ok:true,data:out});}catch(e){next(e);}});
   app.post('/api/accounting/opening-batches/:id/validate',async(req,res,next)=>{try{await ensureTargetFinanceWorkflowSchema();const db=requestDatabase(req),c=contextFor(db),id=Number(req.params.id);const out=await tx(async conn=>{const batch=await loadOpeningBatch(conn,id,c,null,true);if(!batch||!['draft','validated'].includes(batch.status))throw badRequest('只有草稿或已檢核的期初批次可以檢核');const result=await validateOpeningBatch(conn,batch,req.auth.id);await conn.query(`INSERT INTO accounting_opening_events(tenant_id,company_id,source_system,source_database,batch_id,event_kind,before_status,after_status,reason,user_id) VALUES(?,?,?,?,?,'validated',?,'validated',?,?)`,[c.tenant_id,c.company_id,c.source_system,db,id,batch.status,trim(req.body?.reason)||'期初導入檢核完成',req.auth.id]);return{id,batch_no:batch.batch_no,status:'validated',line_count:result.totals.line_count,totals:result.totals};});res.json({ok:true,data:out});}catch(e){next(e);}});
   app.post('/api/accounting/opening-batches/:id/approve',async(req,res,next)=>{try{await ensureTargetFinanceWorkflowSchema();const db=requestDatabase(req),c=contextFor(db),id=Number(req.params.id);const out=await tx(async conn=>{const batch=await loadOpeningBatch(conn,id,c,'validated',true);if(!batch)throw badRequest('只有已檢核的期初導入批次可以核准');const result=await validateOpeningBatch(conn,batch,req.auth.id);await conn.query("UPDATE accounting_opening_batches SET status='approved',approved_by=?,approved_at=NOW() WHERE id=?",[req.auth.id,id]);await conn.query(`INSERT INTO accounting_opening_events(tenant_id,company_id,source_system,source_database,batch_id,event_kind,before_status,after_status,reason,user_id) VALUES(?,?,?,?,?,'approved','validated','approved',?,?)`,[c.tenant_id,c.company_id,c.source_system,db,id,trim(req.body?.reason)||'核准期初導入',req.auth.id]);return{id,batch_no:batch.batch_no,status:'approved',line_count:result.totals.line_count};});res.json({ok:true,data:out});}catch(e){next(e);}});
   app.post('/api/accounting/opening-batches/:id/post',async(req,res,next)=>{try{await ensureTargetFinanceWorkflowSchema();const db=requestDatabase(req),c=contextFor(db),id=Number(req.params.id);const out=await tx(async conn=>{const batch=await loadOpeningBatch(conn,id,c,'approved',true);if(!batch)throw badRequest('只有已核准的期初導入批次可以過帳');const result=await validateOpeningBatch(conn,batch,req.auth.id);await seedAccounts(conn,batch);const journalLines=[];const bankIds=new Map();for(const line of result.rows.filter(x=>x.entry_kind==='bank')){const key=`${line.bank_code}|${line.bank_account_no}`;let[[account]]=await conn.query('SELECT * FROM finance_bank_accounts WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND bank_code=? AND account_no=? FOR UPDATE',[batch.tenant_id,batch.company_id,batch.source_system,batch.source_database,line.bank_code,line.bank_account_no]);if(!account){const[r]=await conn.query('INSERT INTO finance_bank_accounts(tenant_id,company_id,source_system,source_database,bank_code,bank_name,account_no,currency_code,opening_balance,current_balance,is_active,note,created_by,opening_batch_id,opening_date) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)',[batch.tenant_id,batch.company_id,batch.source_system,batch.source_database,line.bank_code,line.bank_name||line.bank_code,line.bank_account_no,line.currency_code,line.amount,line.amount,line.source_document_no||'期初銀行餘額',req.auth.id,batch.id,batch.opening_date]);account={id:r.insertId,current_balance:line.amount};}else{await conn.query('UPDATE finance_bank_accounts SET opening_balance=?,current_balance=current_balance+?,opening_batch_id=?,opening_date=?,note=COALESCE(?,note) WHERE id=?',[line.amount,line.amount,batch.id,batch.opening_date,line.source_document_no||null,account.id]);account.current_balance=Number(account.current_balance||0)+line.amount;}bankIds.set(key,account.id);await conn.query('UPDATE accounting_opening_lines SET created_target_id=? WHERE id=?',[account.id,line.id]);if(Math.abs(line.amount)>ACCOUNTING_EPS)journalLines.push({account_code:'1001',account_name:'銀行存款',debit_amount:line.amount,credit_amount:0,party_code:null,description:`期初銀行餘額 ${line.bank_code}/${line.bank_account_no}`});}
        for(const line of result.rows.filter(x=>['ar','ap'].includes(x.entry_kind))){const openingNo=line.document_no;const[r]=await conn.query(`INSERT INTO finance_opening_balances(tenant_id,company_id,source_system,source_database,account_type,opening_no,opening_date,due_date,party_code,source_document_no,currency_code,original_amount,status,note,created_by,approved_by,approved_at,posted_by,posted_at,opening_batch_id,opening_line_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'posted',?,?,?,NOW(),?,NOW(),?,?)`,[batch.tenant_id,batch.company_id,batch.source_system,batch.source_database,line.account_type,openingNo,line.document_date,line.due_date,line.party_code,line.source_document_no,line.currency_code,line.amount,`期初導入 ${batch.batch_no}`,req.auth.id,req.auth.id,req.auth.id,batch.id,line.id]);const[open]=await conn.query(`INSERT INTO finance_open_items(tenant_id,company_id,source_system,source_database,account_type,document_no,document_date,due_date,party_code,currency_code,source_kind,source_document_id,source_document_no,original_amount,settled_amount,balance_amount,status,note,created_by,approved_by,approved_at,posted_by,posted_at,base_original_amount,base_settled_amount,base_balance_amount,exchange_rate) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,'open',?,?,?,NOW(),?,NOW(),?,?,?,1)`,[batch.tenant_id,batch.company_id,batch.source_system,batch.source_database,line.account_type,openingNo,line.document_date,line.due_date,line.party_code,line.currency_code,'opening_balance',r.insertId,line.source_document_no,line.amount,line.amount,`期初導入 ${batch.batch_no}`,req.auth.id,req.auth.id,req.auth.id,line.amount,0,line.amount]);await conn.query('UPDATE accounting_opening_lines SET created_target_id=? WHERE id=?',[open.insertId,line.id]);journalLines.push({account_code:line.account_code,account_name:line.account_name,debit_amount:line.debit_amount,credit_amount:line.credit_amount,party_code:line.party_code,description:`期初${line.account_type==='AR'?'應收':'應付'} ${openingNo}`});}
       for(const line of result.rows.filter(x=>['ar_note','ap_note'].includes(x.entry_kind))){let bankAccountId=null;if(line.bank_code&&line.bank_account_no){const[[bank]]=await conn.query('SELECT id FROM finance_bank_accounts WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND bank_code=? AND account_no=?',[batch.tenant_id,batch.company_id,batch.source_system,batch.source_database,line.bank_code,line.bank_account_no]);if(!bank)throw badRequest(`票據 ${line.note_no} 指定的銀行帳戶不存在`);bankAccountId=bank.id;}const[r]=await conn.query(`INSERT INTO finance_notes(tenant_id,company_id,source_system,source_database,account_type,note_no,note_type,issue_date,due_date,party_code,bank_code,bank_account,amount,settlement_id,status,memo,created_by,bank_account_id,status_date,status_by,status_note,opening_batch_id,opening_line_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?)`,[batch.tenant_id,batch.company_id,batch.source_system,batch.source_database,line.account_type,line.note_no,line.note_type,line.document_date,line.due_date,line.party_code,line.bank_code,line.bank_account_no,line.amount,line.note_status,`期初導入 ${batch.batch_no}`,req.auth.id,bankAccountId,batch.opening_date,req.auth.id,'期初票據導入',batch.id,line.id]);await conn.query(`INSERT INTO finance_note_events(tenant_id,company_id,source_system,source_database,note_id,from_status,to_status,event_date,reason,created_by) VALUES(?,?,?,?,?,NULL,?,?,?,?)`,[batch.tenant_id,batch.company_id,batch.source_system,batch.source_database,r.insertId,line.note_status,batch.opening_date,`期初票據導入 ${batch.batch_no}`,req.auth.id]);await conn.query('UPDATE accounting_opening_lines SET created_target_id=? WHERE id=?',[r.insertId,line.id]);journalLines.push({account_code:line.account_code,account_name:line.account_name,debit_amount:line.debit_amount,credit_amount:line.credit_amount,party_code:line.party_code,description:`期初${line.entry_kind==='ar_note'?'應收':'應付'}票據 ${line.note_no}`});}
       for(const line of result.rows.filter(x=>x.entry_kind==='gl'))journalLines.push({account_code:line.account_code,account_name:line.account_name,debit_amount:Number(line.debit_amount),credit_amount:Number(line.credit_amount),party_code:line.party_code,description:line.source_document_no||`期初總帳 ${line.document_no}`});
        let debitTotal=journalLines.reduce((s,x)=>s+x.debit_amount,0),creditTotal=journalLines.reduce((s,x)=>s+x.credit_amount,0);if(Math.abs(debitTotal-creditTotal)>ACCOUNTING_EPS){const difference=Math.abs(debitTotal-creditTotal);journalLines.push({account_code:'3200',account_name:'期初餘額調整',debit_amount:creditTotal>debitTotal?difference:0,credit_amount:debitTotal>creditTotal?difference:0,party_code:null,description:'期初導入自動平衡調整'});debitTotal=journalLines.reduce((s,x)=>s+x.debit_amount,0);creditTotal=journalLines.reduce((s,x)=>s+x.credit_amount,0);}if(journalLines.length<2||Math.abs(debitTotal-creditTotal)>ACCOUNTING_EPS)throw badRequest('期初導入無法形成借貸平衡傳票');const journalNo=await nextWorkflowNumber(conn,'accounting_journals','journal_no','OBJ',batch.opening_date);const[journal]=await conn.query(`INSERT INTO accounting_journals(tenant_id,company_id,source_system,source_database,journal_no,journal_date,source_kind,source_id,source_document_no,status,memo,created_by,posted_by,posted_at) VALUES(?,?,?,?,?,?,?,?,?,'posted',?,?,?,NOW())`,[batch.tenant_id,batch.company_id,batch.source_system,batch.source_database,journalNo,batch.opening_date,'opening_batch',batch.id,batch.batch_no,`期初導入 ${batch.batch_no}`,req.auth.id,req.auth.id]);for(let i=0;i<journalLines.length;i++){const line=journalLines[i];await conn.query('INSERT INTO accounting_journal_lines(journal_id,line_no,account_code,account_name,debit_amount,credit_amount,party_code,description) VALUES(?,?,?,?,?,?,?,?)',[journal.insertId,i+1,line.account_code,line.account_name,line.debit_amount,line.credit_amount,line.party_code,line.description]);}await conn.query("UPDATE accounting_opening_batches SET status='posted',journal_id=?,posted_by=?,posted_at=NOW() WHERE id=?",[journal.insertId,req.auth.id,id]);await conn.query('UPDATE finance_opening_balances SET journal_id=? WHERE opening_batch_id=?',[journal.insertId,id]);await conn.query(`INSERT INTO accounting_opening_events(tenant_id,company_id,source_system,source_database,batch_id,event_kind,before_status,after_status,reason,user_id) VALUES(?,?,?,?,?,'posted','approved','posted',?,?)`,[c.tenant_id,c.company_id,c.source_system,db,id,'期初資料已建立銀行、票據、應收／應付與總帳過帳',req.auth.id]);return{id,batch_no:batch.batch_no,status:'posted',journal_id:journal.insertId,journal_no:journalNo,line_count:journalLines.length,debit_total:debitTotal,credit_total:creditTotal};});res.json({ok:true,data:out});}catch(e){next(e);}});
   app.get('/api/accounting/trial-balance',async(req,res,next)=>{try{await ensureTargetFinanceWorkflowSchema();const db=requestDatabase(req),from=validDate(req.query.date_from||'2000-01-01'),to=validDate(req.query.date_to||new Date().toISOString().slice(0,10)),c=contextFor(db),rows=await queryTrialRows(pool,c,from,to),totals={opening_debit:rows.reduce((s,r)=>s+r.opening_debit,0),opening_credit:rows.reduce((s,r)=>s+r.opening_credit,0),period_debit:rows.reduce((s,r)=>s+r.period_debit,0),period_credit:rows.reduce((s,r)=>s+r.period_credit,0),ending_debit:rows.reduce((s,r)=>s+r.ending_debit,0),ending_credit:rows.reduce((s,r)=>s+r.ending_credit,0)};res.json({ok:true,data:{date_from:from,date_to:to,rows,totals,balanced:Math.abs(totals.period_debit-totals.period_credit)<=ACCOUNTING_EPS}});}catch(e){next(e);}});
   app.get('/api/accounting/account-balances',async(req,res,next)=>{try{await ensureTargetFinanceWorkflowSchema();const db=requestDatabase(req),asOf=validDate(req.query.as_of_date||req.query.date_to||new Date().toISOString().slice(0,10)),c=contextFor(db),rows=await queryTrialRows(pool,c,'1900-01-01',asOf);res.json({ok:true,data:{as_of_date:asOf,rows:rows.map(row=>({...row,balance_amount:row.ending_balance})),balanced:Math.abs(rows.reduce((s,r)=>s+r.ending_debit,0)-rows.reduce((s,r)=>s+r.ending_credit,0))<=ACCOUNTING_EPS}});}catch(e){next(e);}});
   app.get('/api/accounting/ledger-details',async(req,res,next)=>{try{await ensureTargetFinanceWorkflowSchema();const db=requestDatabase(req),from=validDate(req.query.date_from||'2000-01-01'),to=validDate(req.query.date_to||new Date().toISOString().slice(0,10)),account=trim(req.query.account_code),limit=Math.min(Math.max(Number(req.query.limit)||500,1),2000),c=contextFor(db),data=await queryLedgerDetails(pool,c,from,to,account,limit);res.json({ok:true,data:{date_from:from,date_to:to,account_code:account||null,...data}});}catch(e){next(e);}});
   app.get('/api/accounting/reconciliation',async(req,res,next)=>{try{await ensureTargetFinanceWorkflowSchema();const db=requestDatabase(req),asOf=validDate(req.query.as_of_date||new Date().toISOString().slice(0,10)),c=contextFor(db),data=await queryFinancialReconciliation(pool,c,asOf);res.json({ok:true,data});}catch(e){next(e);}});
   app.get('/api/accounting/month-closings',async(req,res,next)=>{try{await ensureTargetFinanceWorkflowSchema();const db=requestDatabase(req),c=contextFor(db);const[rows]=await pool.query(`SELECT m.*,(SELECT COUNT(*) FROM accounting_month_closing_lines l WHERE l.closing_id=m.id) line_count FROM accounting_month_closings m WHERE m.tenant_id=? AND m.company_id=? AND m.source_system=? AND m.source_database=? ORDER BY m.close_date DESC,m.id DESC`,[c.tenant_id,c.company_id,c.source_system,db]);res.json({ok:true,data:rows});}catch(e){next(e);}});
   app.get('/api/accounting/month-closings/:id',async(req,res,next)=>{try{await ensureTargetFinanceWorkflowSchema();const db=requestDatabase(req),c=contextFor(db),id=Number(req.params.id),[[header]]=await pool.query('SELECT * FROM accounting_month_closings WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=?',[id,c.tenant_id,c.company_id,c.source_system,db]);if(!header)throw notFound('找不到目前公司的月底結轉');const[lines]=await pool.query('SELECT * FROM accounting_month_closing_lines WHERE closing_id=? ORDER BY line_no',[id]);res.json({ok:true,data:{...header,lines}});}catch(e){next(e);}});
   app.post('/api/accounting/month-closings',async(req,res,next)=>{try{await ensureTargetFinanceWorkflowSchema();const b=req.body||{},db=requestDatabase(req),c=contextFor(db),date=validDate(b.close_date),period=trim(b.period_code)||date.slice(0,7);const out=await tx(async conn=>{const[[p]]=await conn.query("SELECT * FROM accounting_periods WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND period_code=? FOR UPDATE",[c.tenant_id,c.company_id,c.source_system,db,period]);if(!p)throw badRequest(`找不到會計期間 ${period}`);if(p.status!=='closed')throw badRequest('會計期間尚未關帳，不能月底結轉');if(date<p.start_date||date>p.end_date)throw badRequest('月底結轉日期必須落在該會計期間內');const[rows]=await conn.query(`SELECT id,status FROM accounting_month_closings WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND period_code=? FOR UPDATE`,[c.tenant_id,c.company_id,c.source_system,db,period]);if(rows[0]?.status==='closed')throw badRequest(`期間 ${period} 已完成月底結轉，如需重作請先重新開帳`);const blockers=await periodBlockers(conn,p);if(blockers.length)throw badRequest(`期間仍有未完成資料：${blockers.map(x=>`${x.label} ${x.count} 筆`).join('、')}`);const trial=await queryTrialRows(conn,c,p.start_date,p.end_date),periodDebit=trial.reduce((s,r)=>s+r.period_debit,0),periodCredit=trial.reduce((s,r)=>s+r.period_credit,0),reconciliationStatus=Math.abs(periodDebit-periodCredit)<=ACCOUNTING_EPS?'balanced':'difference';let closingId=rows[0]?.id;if(closingId){await conn.query('DELETE FROM accounting_month_closing_lines WHERE closing_id=?',[closingId]);await conn.query('UPDATE accounting_month_closings SET close_date=?,status=\'closed\',note=?,line_count=?,total_debit=?,total_credit=?,reconciliation_status=?,next_period_code=?,closed_by=?,closed_at=NOW() WHERE id=?',[date,trim(b.note)||null,trial.length,periodDebit,periodCredit,reconciliationStatus,nextPeriodCode(period),req.auth.id,closingId]);}else{const[r]=await conn.query(`INSERT INTO accounting_month_closings(tenant_id,company_id,source_system,source_database,period_code,close_date,status,note,line_count,total_debit,total_credit,reconciliation_status,next_period_code,created_by,closed_by,closed_at) VALUES(?,?,?,?,? ,?,'closed',?,?,?,?,?,?,?, ?,NOW())`,[c.tenant_id,c.company_id,c.source_system,db,period,date,trim(b.note)||null,trial.length,periodDebit,periodCredit,reconciliationStatus,nextPeriodCode(period),req.auth.id,req.auth.id]);closingId=r.insertId;}for(let i=0;i<trial.length;i++){const row=trial[i];await conn.query(`INSERT INTO accounting_month_closing_lines(closing_id,line_no,account_code,account_name,account_type,opening_debit,opening_credit,period_debit,period_credit,ending_debit,ending_credit,ending_balance,line_kind) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,[closingId,i+1,row.account_code,row.account_name,row.account_type,row.opening_debit,row.opening_credit,row.period_debit,row.period_credit,row.ending_debit,row.ending_credit,row.ending_balance,'balance']);}return{id:closingId,period_code:period,status:'closed',line_count:trial.length,total_debit:periodDebit,total_credit:periodCredit,reconciliation_status:reconciliationStatus,next_period_code:nextPeriodCode(period)};});res.status(201).json({ok:true,data:out});}catch(e){next(e);}});
  app.post('/api/accounting/drafts', async(req,res,next)=>{try{await ensureTargetFinanceWorkflowSchema();const b=req.body||{},db=requestDatabase(req),c=contextFor(db),date=validDate(b.draft_date);const out=await tx(async conn=>{let sources=[];let rawLines=b.lines;let accountType=trim(b.account_type)||null;let partyCode=trim(b.party_code)||null;let sourceKind=trim(b.source_kind)||'manual';let sourceId=Number(b.source_id)||null;let sourceDocumentNo=trim(b.source_document_no)||null;if(!Array.isArray(rawLines)){const amount=positiveNumber(b.amount,'分錄金額');if(!trim(b.debit_account_code)||!trim(b.credit_account_code)||trim(b.debit_account_code)===trim(b.credit_account_code))throw badRequest('借方與貸方科目不可空白或相同');rawLines=[{line_no:1,account_code:b.debit_account_code,debit_amount:amount,credit_amount:0,party_code,description:b.memo},{line_no:2,account_code:b.credit_account_code,debit_amount:0,credit_amount:amount,party_code,description:b.memo}];}if(b.source_refs?.length||b.open_item_id){const items=await loadOpenItemsForDraft(conn,sourceReferencesFromBody(b),c);sources=items.map(row=>({source_kind:'finance_open_item',source_id:row.id,document_no:row.document_no,original_amount:row.original_amount,locked_amount:sourceAmountOf(row)}));accountType=accountType||items[0].account_type;partyCode=partyCode||items[0].party_code;sourceKind='finance_open_item';sourceId=items[0].id;sourceDocumentNo=items.map(row=>row.document_no).join(',').slice(0,80);}await seedAccounts(conn,c);const checked=await normalizeDraftLines(conn,rawLines,{context:c});const lines=summarizeDraftLines(checked.lines);const normalized=await normalizeDraftLines(conn,lines,{context:c});return insertDraft(conn,{context:c,date,sourceKind,sourceId,sourceDocumentNo,accountType,partyCode,memo:trim(b.memo),lines:normalized.lines,sources,userId:req.auth.id});});res.status(201).json({ok:true,data:out});}catch(e){next(e);}});
  app.post('/api/accounting/drafts/generate', async(req,res,next)=>{try{await ensureTargetFinanceWorkflowSchema();const b=req.body||{},db=requestDatabase(req),c=contextFor(db),ids=sourceReferencesFromBody(b),out=await tx(async conn=>{const items=await loadOpenItemsForDraft(conn,ids,c);const date=validDate(b.draft_date||dateText(items[0].document_date)||new Date().toISOString().slice(0,10));for(const item of items)assertChronologicalDate(date,item.document_date,'底稿日期');await assertOpenAccountingPeriod(conn,c,date);const lines=await autoDraftLines(conn,c,items);if(!lines.length)throw badRequest('來源帳款沒有可產生的自動分錄');const checked=await normalizeDraftLines(conn,lines,{context:c});const sources=items.map(row=>({source_kind:'finance_open_item',source_id:row.id,document_no:row.document_no,original_amount:row.original_amount,locked_amount:sourceAmountOf(row)}));const out=await insertDraft(conn,{context:c,date,sourceKind:'finance_open_item',sourceId:items[0].id,sourceDocumentNo:items.map(row=>row.document_no).join(',').slice(0,80),accountType:items[0].account_type,partyCode:items[0].party_code,memo:trim(b.memo)||'自動產生會計分錄底稿',lines:checked.lines,sources,userId:req.auth.id});return out;});res.status(201).json({ok:true,data:out});}catch(e){next(e);}});
  app.put('/api/accounting/drafts/:id', async(req,res,next)=>{try{await ensureTargetFinanceWorkflowSchema();const db=requestDatabase(req),c=contextFor(db),id=Number(req.params.id),b=req.body||{};const out=await tx(async conn=>{const draft=await loadDraftHeader(conn,id,c,'draft',true);if(!draft)throw badRequest('只有草稿底稿可以維護');const[existing]=await conn.query('SELECT line_no,required_clearing,clearing_type FROM accounting_draft_lines WHERE draft_id=? ORDER BY line_no',[id]);if(!Array.isArray(b.lines)||b.lines.length!==existing.length)throw badRequest('底稿只能維護既有明細，不可新增或刪除行次');const existingNos=existing.map(row=>Number(row.line_no)).sort((a,z)=>a-z);const existingMap=new Map(existing.map(row=>[Number(row.line_no),row]));const enforcedLines=b.lines.map(raw=>{const original=existingMap.get(Number(raw?.line_no));if(!original||!Number(original.required_clearing))return raw;return {...(raw||{}),required_clearing:1,clearing_type:original.clearing_type||raw?.clearing_type};});const checked=await normalizeDraftLines(conn,enforcedLines,{preserveLineNo:true,context:c});const incomingNos=checked.lines.map(line=>line.line_no).sort((a,z)=>a-z);if(existingNos.join(',')!==incomingNos.join(','))throw badRequest('底稿只能維護既有行次，不可新增或刪除行次');await assertOpenAccountingPeriod(conn,c,draft.draft_date);if(draft.source_locked){await assertDraftSourcesLocked(conn,draft);await assertDraftClearingBalances(conn,draft,checked.lines);}for(const line of checked.lines)await conn.query(`UPDATE accounting_draft_lines SET account_code=?,account_name=?,debit_amount=?,credit_amount=?,party_code=?,description=?,required_clearing=?,clearing_type=?,clearing_ref=? WHERE draft_id=? AND line_no=?`,[line.account_code,line.account_name,line.debit_amount,line.credit_amount,line.party_code,line.description,line.required_clearing,line.clearing_type,line.clearing_ref,id,line.line_no]);const debit=checked.debitTotal,firstDebit=checked.lines.find(line=>line.debit_amount>0)||checked.lines[0],firstCredit=checked.lines.find(line=>line.credit_amount>0)||checked.lines[1]||checked.lines[0];await conn.query('UPDATE accounting_drafts SET debit_account_code=?,debit_account_name=?,credit_account_code=?,credit_account_name=?,amount=? WHERE id=?',[firstDebit.account_code,firstDebit.account_name,firstCredit.account_code,firstCredit.account_name,debit,id]);await conn.query(`INSERT INTO accounting_draft_events(draft_id,event_kind,before_status,after_status,reason,user_id) VALUES(?,'updated','draft','draft',?,?)`,[id,trim(b.reason)||'維護底稿',req.auth.id]);return{id,status:'draft',line_count:checked.lines.length,debit_total:debit,credit_total:checked.creditTotal};});res.json({ok:true,data:out});}catch(e){next(e);}});
  app.post('/api/accounting/drafts/:id/approve', async(req,res,next)=>{try{await ensureTargetFinanceWorkflowSchema();const db=requestDatabase(req),c=contextFor(db),id=Number(req.params.id);const out=await tx(async conn=>{const draft=await loadDraftHeader(conn,id,c,'draft',true);if(!draft)throw badRequest('只有草稿底稿可以核准');const checked=await validateStoredDraft(conn,draft,c);await conn.query("UPDATE accounting_drafts SET status='approved',approved_by=?,approved_at=NOW() WHERE id=?",[req.auth.id,id]);await conn.query(`INSERT INTO accounting_draft_events(draft_id,event_kind,before_status,after_status,reason,user_id) VALUES(?,'approved','draft','approved',?,?)`,[id,trim(req.body?.reason)||'核准底稿',req.auth.id]);return{id,status:'approved',line_count:checked.lines.length,debit_total:checked.debitTotal,credit_total:checked.creditTotal};});res.json({ok:true,data:out});}catch(e){next(e);}});
  app.post('/api/accounting/drafts/:id/restore', async(req,res,next)=>{try{await ensureTargetFinanceWorkflowSchema();const db=requestDatabase(req),c=contextFor(db),id=Number(req.params.id),reason=trim(req.body?.reason)||'底稿還原';const out=await tx(async conn=>{const draft=await loadDraftHeader(conn,id,c,null,true);if(!draft||!['draft','approved'].includes(draft.status))throw badRequest('只有未拋轉底稿可以還原，已過帳請建立沖回單');await conn.query("UPDATE accounting_drafts SET status='restored',source_locked=0,restore_reason=?,restored_by=?,restored_at=NOW() WHERE id=?",[reason,req.auth.id,id]);await conn.query(`INSERT INTO accounting_draft_events(draft_id,event_kind,before_status,after_status,reason,user_id) VALUES(?, 'restored', ?, 'restored', ?, ?)`,[id,draft.status,reason,req.auth.id]);return{id,status:'restored',source_locked:false};});res.json({ok:true,data:out});}catch(e){next(e);}});
  app.post('/api/accounting/drafts/:id/post', async(req,res,next)=>{try{await ensureTargetFinanceWorkflowSchema();const db=requestDatabase(req),c=contextFor(db),id=Number(req.params.id);const out=await tx(async conn=>{const draft=await loadDraftHeader(conn,id,c,'approved',true);if(!draft)throw badRequest('只有已核准底稿可以拋轉');const checked=await validateStoredDraft(conn,draft,c);const[[existing]]=await conn.query("SELECT id,journal_no FROM accounting_journals WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND source_kind='accounting_draft' AND source_id=? LIMIT 1",[draft.tenant_id,draft.company_id,draft.source_system,draft.source_database,id]);if(existing)throw badRequest(`此底稿已拋轉傳票 ${existing.journal_no}`);const no=await nextWorkflowNumber(conn,'accounting_journals','journal_no','JV',draft.draft_date);const[journal]=await conn.query(`INSERT INTO accounting_journals(tenant_id,company_id,source_system,source_database,journal_no,journal_date,source_kind,source_id,source_document_no,status,memo,created_by,posted_by,posted_at) VALUES(?,?,?,?,?,?,?,?,?,'posted',?,?,?,NOW())`,[draft.tenant_id,draft.company_id,draft.source_system,draft.source_database,no,draft.draft_date,'accounting_draft',id,draft.source_document_no||draft.draft_no,trim(req.body?.memo)||'底稿拋轉正式傳票',req.auth.id,req.auth.id]);for(const line of checked.lines)await conn.query(`INSERT INTO accounting_journal_lines(journal_id,line_no,account_code,account_name,debit_amount,credit_amount,party_code,description) VALUES(?,?,?,?,?,?,?,?)`,[journal.insertId,line.line_no,line.account_code,line.account_name,line.debit_amount,line.credit_amount,line.party_code,line.description]);await conn.query("UPDATE accounting_drafts SET status='posted',posted_by=?,posted_at=NOW() WHERE id=?",[req.auth.id,id]);await conn.query(`INSERT INTO accounting_draft_events(draft_id,event_kind,before_status,after_status,reason,user_id) VALUES(?,'posted','approved','posted',?,?)`,[id,'拋轉正式傳票',req.auth.id]);return{id,journal_id:journal.insertId,journal_no:no,status:'posted',line_count:checked.lines.length,debit_total:checked.debitTotal,credit_total:checked.creditTotal};});res.json({ok:true,data:out});}catch(e){next(e);}});
  app.get('/api/accounting/periods', async (req,res,next) => { try {
    await ensureTargetFinanceWorkflowSchema();
    const db=String(req.query.source_database||'SH').toUpperCase();
    const c=contextFor(db);
    const [rows]=await pool.query(`SELECT * FROM accounting_periods WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? ORDER BY start_date DESC`,[c.tenant_id,c.company_id,c.source_system,db]);
    res.json({ok:true,data:rows});
  } catch(e){next(e);} });
  app.post('/api/accounting/periods', async (req,res,next) => { try {
    await ensureTargetFinanceWorkflowSchema();
    const b=req.body||{},db=String(b.source_database||'SH').toUpperCase(),c=contextFor(db);
    const start=validDate(b.start_date),end=validDate(b.end_date);
    if(start>end)throw badRequest('會計期間起日不可晚於迄日');
    const code=trim(b.period_code)||start.slice(0,7);
    const [r]=await pool.query(`INSERT INTO accounting_periods(tenant_id,company_id,source_system,source_database,period_code,start_date,end_date,status,note)
      VALUES(?,?,?,?,?,?,?,'open',?) ON DUPLICATE KEY UPDATE start_date=VALUES(start_date),end_date=VALUES(end_date),note=VALUES(note),status=IF(status='closed',status,'open')`,[c.tenant_id,c.company_id,c.source_system,db,code,start,end,trim(b.note)||null]);
    res.status(201).json({ok:true,data:{id:r.insertId||null,period_code:code,status:'open'}});
  } catch(e){next(e);} });
   app.post('/api/accounting/periods/:id/close', async (req,res,next) => { try {
     await ensureTargetFinanceWorkflowSchema();
     const id=Number(req.params.id),db=requestDatabase(req),c=contextFor(db);
     if(!Number.isInteger(id)||id<1)throw badRequest('會計期間代號不正確');
     await tx(async conn=>{
       const [[p]]=await conn.query("SELECT * FROM accounting_periods WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND status='open' FOR UPDATE",[id,c.tenant_id,c.company_id,c.source_system,db]);
       if(!p)throw badRequest('找不到開放中的會計期間');
       const blockers=await periodBlockers(conn,p);
       if(blockers.length)throw badRequest(`期間內仍有未完成資料：${blockers.map(x=>`${x.label} ${x.count} 筆`).join('、')}`);
       const reason=trim(req.body?.reason||req.body?.note)||'完成期間關帳檢核';
       await conn.query("UPDATE accounting_periods SET status='closed',closed_by=?,closed_at=NOW(),note=? WHERE id=?",[req.auth.id,reason,id]);
       await conn.query(`INSERT INTO accounting_period_events(tenant_id,company_id,source_system,source_database,period_id,event_kind,before_status,after_status,reason,user_id) VALUES(?,?,?,?,?,'closed','open','closed',?,?)`,[c.tenant_id,c.company_id,c.source_system,db,id,reason,req.auth.id]);
     });
     res.json({ok:true,data:{id,status:'closed',source_database:db}});
   } catch(e){next(e);} });
   app.post('/api/accounting/periods/:id/reopen', async (req,res,next) => { try {
     await ensureTargetFinanceWorkflowSchema();
     const id=Number(req.params.id),db=requestDatabase(req),c=contextFor(db),reason=trim(req.body?.reason||req.body?.note);
     if(!Number.isInteger(id)||id<1)throw badRequest('會計期間代號不正確');
     if(!reason)throw badRequest('重新開帳必須填寫原因');
     const out=await tx(async conn=>{const[[p]]=await conn.query("SELECT * FROM accounting_periods WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND status='closed' FOR UPDATE",[id,c.tenant_id,c.company_id,c.source_system,db]);if(!p)throw badRequest('只有目前公司已關帳期間可以重新開帳');const[[yearClose]]=await conn.query("SELECT id,closing_no FROM accounting_year_closings WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND fiscal_year=? AND status='posted' LIMIT 1",[c.tenant_id,c.company_id,c.source_system,db,String(p.period_code).slice(0,4)]);if(yearClose)throw badRequest(`年度 ${p.period_code.slice(0,4)} 已結轉（${yearClose.closing_no}），需先依年度結轉更正流程處理`);await conn.query("UPDATE accounting_periods SET status='open',reopened_by=?,reopened_at=NOW(),note=? WHERE id=?",[req.auth.id,reason,id]);await conn.query(`UPDATE accounting_month_closings SET status='reopened',note=? WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND period_code=? AND status='closed'`,[reason,c.tenant_id,c.company_id,c.source_system,db,p.period_code]);await conn.query(`INSERT INTO accounting_period_events(tenant_id,company_id,source_system,source_database,period_id,event_kind,before_status,after_status,reason,user_id) VALUES(?,?,?,?,?,'reopened','closed','open',?,?)`,[c.tenant_id,c.company_id,c.source_system,db,id,reason,req.auth.id]);return{id,status:'open',source_database:db,reason};});
     res.json({ok:true,data:out});
   } catch(e){next(e);} });
  app.get('/api/accounting/clearing', async (req,res,next) => { try {
    await ensureTargetFinanceWorkflowSchema();
    const db=String(req.query.source_database||'SH').toUpperCase(),type=String(req.query.account_type||'').toUpperCase(),party=trim(req.query.party_code),limit=Math.min(Math.max(Number(req.query.limit)||200,1),500),c=contextFor(db);
    const from=req.query.from_date?validDate(req.query.from_date):'1900-01-01',to=req.query.to_date?validDate(req.query.to_date):'2999-12-31';
    if(from>to)throw badRequest('立沖查詢起日不可晚於迄日');
    const allocationConditions=['s.tenant_id=?','s.company_id=?','s.source_system=?','s.source_database=?','s.settlement_date BETWEEN ? AND ?'];const allocationParams=[c.tenant_id,c.company_id,c.source_system,db,from,to];
    if(['AR','AP'].includes(type)){allocationConditions.push('s.account_type=?');allocationParams.push(type);}if(party){allocationConditions.push('s.party_code=?');allocationParams.push(party);}
    const [allocationRows]=await pool.query(`SELECT 'settlement' row_kind,a.id row_id,a.allocated_amount amount,s.account_type,s.settlement_no document_no,s.settlement_date movement_date,s.party_code,s.amount source_amount,s.status source_status,o.document_no related_document_no,o.document_date related_date,o.original_amount,o.settled_amount,o.balance_amount,o.status related_status,NULL movement_kind,NULL accounting_draft_id
      FROM finance_allocations a JOIN finance_settlements s ON s.id=a.settlement_id JOIN finance_open_items o ON o.id=a.open_item_id
      WHERE ${allocationConditions.join(' AND ')} ORDER BY s.settlement_date DESC,a.id DESC LIMIT ?`,[...allocationParams,limit]);
    const advanceConditions=['a.tenant_id=?','a.company_id=?','a.source_system=?','a.source_database=?','m.movement_date BETWEEN ? AND ?'];const advanceParams=[c.tenant_id,c.company_id,c.source_system,db,from,to];
    if(['AR','AP'].includes(type)){advanceConditions.push('a.account_type=?');advanceParams.push(type);}if(party){advanceConditions.push('a.party_code=?');advanceParams.push(party);}
    const [advanceRows]=await pool.query(`SELECT 'advance' row_kind,m.id row_id,m.amount,m.base_amount,m.exchange_difference,a.account_type,a.advance_no document_no,m.movement_date,a.party_code,a.original_amount,a.applied_amount,a.refunded_amount,a.balance_amount,a.status related_status,m.movement_kind,m.reference_no related_document_no,d.id accounting_draft_id,d.draft_no accounting_draft_no
      FROM finance_advance_movements m JOIN finance_advances a ON a.id=m.advance_id LEFT JOIN accounting_drafts d ON d.id=m.accounting_draft_id
      WHERE ${advanceConditions.join(' AND ')} ORDER BY m.movement_date DESC,m.id DESC LIMIT ?`,[...advanceParams,limit]);
    const creditConditions=['c.tenant_id=?','c.company_id=?','c.source_system=?','c.source_database=?','m.movement_date BETWEEN ? AND ?'];const creditParams=[c.tenant_id,c.company_id,c.source_system,db,from,to];
    if(party){creditConditions.push('c.party_code=?');creditParams.push(party);}
    const [creditRows]=await pool.query(`SELECT 'customer_credit' row_kind,m.id row_id,m.amount,c.party_code,c.credit_date movement_date,c.original_amount,c.applied_amount,c.refunded_amount,c.balance_amount,c.status related_status,m.movement_kind,m.reference_no,c.source_adjustment_id,NULL accounting_draft_id,NULL accounting_draft_no
      FROM finance_customer_credit_movements m JOIN finance_customer_credits c ON c.id=m.credit_id
      WHERE ${creditConditions.join(' AND ')} ORDER BY m.movement_date DESC,m.id DESC LIMIT ?`,[...creditParams,limit]);
    const crossConditions=['o.tenant_id=?','o.company_id=?','o.source_system=?','o.source_database=?','o.offset_date BETWEEN ? AND ?'];const crossParams=[c.tenant_id,c.company_id,c.source_system,db,from,to];
    if(party){crossConditions.push('(o.customer_code=? OR o.supplier_code=?)');crossParams.push(party,party);}
    const [crossRows]=await pool.query(`SELECT 'cross_offset' row_kind,o.id row_id,o.amount,o.ar_base_amount,o.ap_base_amount,o.exchange_difference,'FIN' account_type,o.offset_no document_no,o.offset_date movement_date,o.customer_code,o.supplier_code,o.currency_code,o.offset_kind,o.status related_status,o.reference_no,o.note,d.id accounting_draft_id,d.draft_no accounting_draft_no
      FROM finance_cross_offsets o LEFT JOIN accounting_drafts d ON d.id=o.accounting_draft_id
      WHERE ${crossConditions.join(' AND ')} ORDER BY o.offset_date DESC,o.id DESC LIMIT ?`,[...crossParams,limit]);
    const rows=[...allocationRows,...advanceRows,...creditRows,...crossRows].sort((a,b)=>String(b.movement_date||'').localeCompare(String(a.movement_date||''))||Number(b.row_id||0)-Number(a.row_id||0)).slice(0,limit);
    const openConditions=['o.tenant_id=?','o.company_id=?','o.source_system=?','o.source_database=?','o.document_date<=?','o.status IN (\'open\',\'partial\')'];const openParams=[c.tenant_id,c.company_id,c.source_system,db,to];
    if(['AR','AP'].includes(type)){openConditions.push('o.account_type=?');openParams.push(type);}if(party){openConditions.push('o.party_code=?');openParams.push(party);}
    const [openSummary]=await pool.query(`SELECT o.account_type,o.party_code,COUNT(*) open_item_count,COALESCE(SUM(o.balance_amount),0) open_balance FROM finance_open_items o WHERE ${openConditions.join(' AND ')} GROUP BY o.account_type,o.party_code`,openParams);
    const [allocationSummary]=await pool.query(`SELECT s.account_type,s.party_code,COALESCE(SUM(a.allocated_amount),0) allocated_amount FROM finance_allocations a JOIN finance_settlements s ON s.id=a.settlement_id WHERE ${allocationConditions.join(' AND ')} AND s.status='posted' GROUP BY s.account_type,s.party_code`,allocationParams);
    const summaryMap=new Map();for(const row of openSummary)summaryMap.set(`${row.account_type}|${row.party_code}`,{account_type:row.account_type,party_code:row.party_code,open_item_count:Number(row.open_item_count||0),open_balance:Number(row.open_balance||0),allocated_amount:0});for(const row of allocationSummary){const key=`${row.account_type}|${row.party_code}`;const current=summaryMap.get(key)||{account_type:row.account_type,party_code:row.party_code,open_item_count:0,open_balance:0,allocated_amount:0};current.allocated_amount=Number(row.allocated_amount||0);summaryMap.set(key,current);}
    const advanceSummaryConditions=['a.tenant_id=?','a.company_id=?','a.source_system=?','a.source_database=?','a.advance_date<=?'];const advanceSummaryParams=[c.tenant_id,c.company_id,c.source_system,db,to];if(['AR','AP'].includes(type)){advanceSummaryConditions.push('a.account_type=?');advanceSummaryParams.push(type);}if(party){advanceSummaryConditions.push('a.party_code=?');advanceSummaryParams.push(party);}
    const [advanceSummary]=await pool.query(`SELECT a.account_type,a.party_code,COUNT(*) advance_count,COALESCE(SUM(a.original_amount),0) original_amount,COALESCE(SUM(a.applied_amount),0) used_amount,COALESCE(SUM(a.refunded_amount),0) refunded_amount,COALESCE(SUM(a.balance_amount),0) remaining_amount FROM finance_advances a WHERE ${advanceSummaryConditions.join(' AND ')} GROUP BY a.account_type,a.party_code`,advanceSummaryParams);
    const [creditSummary]=await pool.query(`SELECT c.party_code,COUNT(*) credit_count,COALESCE(SUM(c.original_amount),0) original_amount,COALESCE(SUM(c.applied_amount),0) used_amount,COALESCE(SUM(c.refunded_amount),0) refunded_amount,COALESCE(SUM(c.balance_amount),0) remaining_amount FROM finance_customer_credits c WHERE c.tenant_id=? AND c.company_id=? AND c.source_system=? AND c.source_database=? AND c.credit_date<=?${party?' AND c.party_code=?':''} GROUP BY c.party_code`,[c.tenant_id,c.company_id,c.source_system,db,to,...(party?[party]:[])]);
    const [crossSummary]=await pool.query(`SELECT offset_kind,COUNT(*) offset_count,COALESCE(SUM(amount),0) offset_amount,COALESCE(SUM(exchange_difference),0) exchange_difference FROM finance_cross_offsets o WHERE o.tenant_id=? AND o.company_id=? AND o.source_system=? AND o.source_database=? AND o.offset_date BETWEEN ? AND ?${party?' AND (o.customer_code=? OR o.supplier_code=?)':''} GROUP BY offset_kind`,[c.tenant_id,c.company_id,c.source_system,db,from,to,...(party?[party,party]:[])]);
    res.json({ok:true,data:{rows,summary:[...summaryMap.values()].sort((a,b)=>`${a.account_type}${a.party_code}`.localeCompare(`${b.account_type}${b.party_code}`)),advance_summary:advanceSummary,credit_summary:creditSummary,cross_summary:crossSummary},source_database:db,from_date:from,to_date:to});
  } catch(e){next(e);} });
  app.get('/api/accounting/opening-balances', async (req,res,next) => { try {
    await ensureTargetFinanceWorkflowSchema();const db=String(req.query.source_database||'SH').toUpperCase(),type=String(req.query.account_type||'').toUpperCase(),c=contextFor(db);const conditions=['tenant_id=?','company_id=?','source_system=?','source_database=?'];const params=[c.tenant_id,c.company_id,c.source_system,db];if(['AR','AP'].includes(type)){conditions.push('account_type=?');params.push(type);}const[rows]=await pool.query(`SELECT * FROM finance_opening_balances WHERE ${conditions.join(' AND ')} ORDER BY opening_date DESC,id DESC LIMIT 200`,params);res.json({ok:true,data:rows});
  } catch(e){next(e);} });
  app.post('/api/accounting/opening-balances', async (req,res,next) => { try {
    await ensureTargetFinanceWorkflowSchema();const b=req.body||{},db=String(b.source_database||'SH').toUpperCase(),type=String(b.account_type||'AR').toUpperCase(),c=contextFor(db),date=validDate(b.opening_date),amount=positiveNumber(b.original_amount,'期初未結帳款金額');if(!['AR','AP'].includes(type)||!trim(b.party_code))throw badRequest('期初未結帳款類別與對象不可空白');const out=await tx(async conn=>{const prefix=type==='AR'?'AROPEN':'APOPEN',no=trim(b.opening_no)||await nextWorkflowNumber(conn,'finance_opening_balances','opening_no',prefix,date);const[r]=await conn.query(`INSERT INTO finance_opening_balances(tenant_id,company_id,source_system,source_database,account_type,opening_no,opening_date,due_date,party_code,source_document_no,currency_code,original_amount,status,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'draft',?,?)`,[c.tenant_id,c.company_id,c.source_system,db,type,no,date,nullableDate(b.due_date),trim(b.party_code),trim(b.source_document_no),trim(b.currency_code)||'TWD',amount,trim(b.note),req.auth.id]);return{id:r.insertId,opening_no:no,status:'draft'};});res.status(201).json({ok:true,data:out});
  } catch(e){next(e);} });
   app.post('/api/accounting/opening-balances/:id/approve', async (req,res,next) => { try {
     await ensureTargetFinanceWorkflowSchema();const id=Number(req.params.id),db=requestDatabase(req),c=contextFor(db);
     await tx(async conn=>{const[[row]]=await conn.query("SELECT * FROM finance_opening_balances WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND status='draft' FOR UPDATE",[id,c.tenant_id,c.company_id,c.source_system,db]);if(!row)throw badRequest('只有目前公司期初未結帳款草稿可以核准');await assertOpenAccountingPeriod(conn,c,row.opening_date);await conn.query("UPDATE finance_opening_balances SET status='approved',approved_by=?,approved_at=NOW() WHERE id=?",[req.auth.id,id]);});
     res.json({ok:true,data:{id,status:'approved',source_database:db}});
   }catch(e){next(e);}});
   app.post('/api/accounting/opening-balances/:id/post', async (req,res,next) => { try {
     await ensureTargetFinanceWorkflowSchema();const id=Number(req.params.id),db=requestDatabase(req),c=contextFor(db);const out=await tx(async conn=>{const[[row]]=await conn.query("SELECT * FROM finance_opening_balances WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND status='approved' FOR UPDATE",[id,c.tenant_id,c.company_id,c.source_system,db]);if(!row)throw badRequest('只有目前公司已核准的期初未結帳款可以過帳');await assertOpenAccountingPeriod(conn,c,row.opening_date);const[[existing]]=await conn.query("SELECT id,document_no FROM finance_open_items WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND source_kind='opening_balance' AND source_document_id=? FOR UPDATE",[c.tenant_id,c.company_id,c.source_system,db,id]);if(existing)return{id,open_item_id:existing.id,document_no:existing.document_no,status:'posted'};await seedAccounts(conn,c);const[journalExisting]=await conn.query("SELECT id,journal_no FROM accounting_journals WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND source_kind='opening_balance' AND source_id=? LIMIT 1",[c.tenant_id,c.company_id,c.source_system,db,id]);let journalId=journalExisting[0]?.id,journalNo=journalExisting[0]?.journal_no;if(!journalId){journalNo=await nextWorkflowNumber(conn,'accounting_journals','journal_no','OBJ',row.opening_date);const[journal]=await conn.query(`INSERT INTO accounting_journals(tenant_id,company_id,source_system,source_database,journal_no,journal_date,source_kind,source_id,source_document_no,status,memo,created_by,posted_by,posted_at) VALUES(?,?,?,?,?,?,?,?,?,'posted',?,?,?,NOW())`,[c.tenant_id,c.company_id,c.source_system,db,journalNo,row.opening_date,'opening_balance',id,row.opening_no,`期初${row.account_type==='AR'?'應收':'應付'}導入`,req.auth.id,req.auth.id]);journalId=journal.insertId;const lines=row.account_type==='AR'?[['1101','應收帳款',row.original_amount,0,row.party_code,'期初應收'],['3200','期初餘額調整',0,row.original_amount,row.party_code,'期初平衡']]:[['3200','期初餘額調整',row.original_amount,0,row.party_code,'期初平衡'],['2101','應付帳款',0,row.original_amount,row.party_code,'期初應付']];for(let i=0;i<lines.length;i++)await conn.query('INSERT INTO accounting_journal_lines(journal_id,line_no,account_code,account_name,debit_amount,credit_amount,party_code,description) VALUES(?,?,?,?,?,?,?,?)',[journalId,i+1,...lines[i]]);}const[open]=await conn.query(`INSERT INTO finance_open_items(tenant_id,company_id,source_system,source_database,account_type,document_no,document_date,due_date,party_code,currency_code,source_kind,source_document_id,source_document_no,original_amount,settled_amount,balance_amount,status,note,created_by,approved_by,approved_at,posted_by,posted_at,base_original_amount,base_settled_amount,base_balance_amount,exchange_rate) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,'open',?,?,?,NOW(),?,NOW(),?,?,?,1)`,[row.tenant_id,row.company_id,row.source_system,row.source_database,row.account_type,row.opening_no,row.opening_date,row.due_date,row.party_code,row.currency_code,'opening_balance',id,row.source_document_no,row.original_amount,row.original_amount,row.note,req.auth.id,req.auth.id,req.auth.id,row.original_amount,0,row.original_amount]);await conn.query("UPDATE finance_opening_balances SET status='posted',journal_id=?,posted_by=?,posted_at=NOW() WHERE id=?",[journalId,id]);return{id,open_item_id:open.insertId,journal_id:journalId,journal_no:journalNo,status:'posted'};});res.json({ok:true,data:out});
   }catch(e){next(e);}});
  app.get('/api/accounting/year-closings', async (req,res,next) => { try {await ensureTargetFinanceWorkflowSchema();const db=String(req.query.source_database||'SH').toUpperCase(),c=contextFor(db);const[rows]=await pool.query('SELECT * FROM accounting_year_closings WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? ORDER BY fiscal_year DESC',[c.tenant_id,c.company_id,c.source_system,db]);res.json({ok:true,data:rows});}catch(e){next(e);}});
  app.post('/api/accounting/year-closings', async (req,res,next) => { try {await ensureTargetFinanceWorkflowSchema();const b=req.body||{},db=String(b.source_database||'SH').toUpperCase(),c=contextFor(db),year=trim(b.fiscal_year);if(!/^\d{4}$/.test(year))throw badRequest('會計年度必須是四碼');const date=validDate(b.close_date||`${year}-12-31`);if(!date.startsWith(year))throw badRequest('結轉日期必須在指定會計年度內');const out=await tx(async conn=>{const no=trim(b.closing_no)||await nextWorkflowNumber(conn,'accounting_year_closings','closing_no','YCL',date);const[r]=await conn.query(`INSERT INTO accounting_year_closings(tenant_id,company_id,source_system,source_database,fiscal_year,closing_no,close_date,retained_earnings_account_code,retained_earnings_account_name,status,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,'draft',?,?)`,[c.tenant_id,c.company_id,c.source_system,db,year,no,date,trim(b.retained_earnings_account_code)||'3201',trim(b.retained_earnings_account_name)||'保留盈餘',trim(b.note),req.auth.id]);return{id:r.insertId,closing_no:no,status:'draft'};});res.status(201).json({ok:true,data:out});}catch(e){next(e);}});
   app.get('/api/accounting/year-closings/:id',async(req,res,next)=>{try{await ensureTargetFinanceWorkflowSchema();const db=requestDatabase(req),c=contextFor(db),id=Number(req.params.id),[[header]]=await pool.query('SELECT * FROM accounting_year_closings WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=?',[id,c.tenant_id,c.company_id,c.source_system,db]);if(!header)throw notFound('找不到目前公司的年度結轉');const[lines]=await pool.query('SELECT * FROM accounting_year_closing_lines WHERE closing_id=? ORDER BY line_no',[id]);res.json({ok:true,data:{...header,lines}});}catch(e){next(e);}});
   app.post('/api/accounting/year-closings/:id/post', async (req,res,next) => { try {
     await ensureTargetFinanceWorkflowSchema();const id=Number(req.params.id),db=requestDatabase(req),c=contextFor(db);
     const out=await tx(async conn=>{
       const[[closing]]=await conn.query("SELECT * FROM accounting_year_closings WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND status='draft' FOR UPDATE",[id,c.tenant_id,c.company_id,c.source_system,db]);
       if(!closing)throw badRequest('只有目前公司年度結轉草稿可以過帳');
       const year=String(closing.fiscal_year),start=`${year}-01-01`,end=`${year}-12-31`;
       const[periodRows]=await conn.query("SELECT period_code,status,start_date,end_date FROM accounting_periods WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND period_code LIKE ? ORDER BY period_code",[c.tenant_id,c.company_id,c.source_system,db,`${year}-%`]);
       const requiredMonths=Array.from({length:12},(_,i)=>`${year}-${String(i+1).padStart(2,'0')}`),periodMap=new Map(periodRows.map(row=>[String(row.period_code),row])),missing=requiredMonths.filter(code=>!periodMap.has(code)),open=requiredMonths.filter(code=>periodMap.get(code)?.status!=='closed');
       if(missing.length||open.length)throw badRequest(`年度 ${year} 必須先完成 12 個月份關帳；缺少：${missing.join('、')||'無'}；未關帳：${open.join('、')||'無'}`);
        const[monthRows]=await conn.query("SELECT period_code,status FROM accounting_month_closings WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND period_code LIKE ? AND status='closed'",[c.tenant_id,c.company_id,c.source_system,db,`${year}-%`]);const monthSet=new Set(monthRows.map(row=>String(row.period_code)));const missingMonths=requiredMonths.filter(code=>!monthSet.has(code));if(missingMonths.length)throw badRequest(`年度 ${year} 尚有月份未完成月底結轉：${missingMonths.join('、')}`);
       await seedAccounts(conn,closing);await conn.query('INSERT IGNORE INTO accounting_accounts(tenant_id,company_id,source_system,account_code,account_name,account_type) VALUES(?,?,?,?,?,\'equity\')',[c.tenant_id,c.company_id,c.source_system,closing.retained_earnings_account_code,closing.retained_earnings_account_name]);
       const trial=await queryTrialRows(conn,c,start,end),profitRows=trial.filter(row=>['revenue','expense'].includes(String(row.account_type))),lines=[],carryLines=[];let netIncome=0;
       for(const row of profitRows){const isRevenue=String(row.account_type)==='revenue',balance=isRevenue?row.period_credit-row.period_debit:row.period_debit-row.period_credit;if(isRevenue)netIncome+=balance;else netIncome-=balance;if(Math.abs(balance)>ACCOUNTING_EPS)lines.push({account_code:row.account_code,account_name:row.account_name,debit_amount:isRevenue?(balance>0?balance:0):(balance<0?Math.abs(balance):0),credit_amount:isRevenue?(balance<0?Math.abs(balance):0):(balance>0?balance:0),description:'年度損益結轉'});}
       if(netIncome>ACCOUNTING_EPS)lines.push({account_code:closing.retained_earnings_account_code,account_name:closing.retained_earnings_account_name,debit_amount:0,credit_amount:netIncome,description:'年度結轉後保留盈餘'});else if(netIncome<-ACCOUNTING_EPS)lines.push({account_code:closing.retained_earnings_account_code,account_name:closing.retained_earnings_account_name,debit_amount:Math.abs(netIncome),credit_amount:0,description:'年度結轉後待彌補損失'});
       if(!lines.length)throw badRequest(`年度 ${year} 沒有可結轉的收入／費用傳票`);const closeDebit=lines.reduce((s,row)=>s+row.debit_amount,0),closeCredit=lines.reduce((s,row)=>s+row.credit_amount,0);if(Math.abs(closeDebit-closeCredit)>ACCOUNTING_EPS)throw badRequest('年度損益結轉傳票借貸不平衡');
       for(const row of trial){if(['revenue','expense'].includes(String(row.account_type)))continue;let balance=row.ending_balance;if(String(row.account_code)===String(closing.retained_earnings_account_code))balance-=netIncome;const carryDebit=balance>ACCOUNTING_EPS?balance:0,carryCredit=balance<-ACCOUNTING_EPS?Math.abs(balance):0;if(Math.abs(balance)>ACCOUNTING_EPS||row.account_code===closing.retained_earnings_account_code)carryLines.push({account_code:row.account_code,account_name:row.account_name,account_type:row.account_type,opening_debit:row.opening_debit,opening_credit:row.opening_credit,period_debit:row.period_debit,period_credit:row.period_credit,ending_debit:row.ending_debit,ending_credit:row.ending_credit,carry_forward_debit:carryDebit,carry_forward_credit:carryCredit,balance_amount:balance,line_kind:'balance'});}
       if(!carryLines.some(row=>String(row.account_code)===String(closing.retained_earnings_account_code))&&Math.abs(netIncome)>ACCOUNTING_EPS)carryLines.push({account_code:closing.retained_earnings_account_code,account_name:closing.retained_earnings_account_name,account_type:'equity',opening_debit:0,opening_credit:0,period_debit:0,period_credit:0,ending_debit:netIncome<0?Math.abs(netIncome):0,ending_credit:netIncome>0?netIncome:0,carry_forward_debit:netIncome<0?Math.abs(netIncome):0,carry_forward_credit:netIncome>0?netIncome:0,balance_amount:-netIncome,line_kind:'carry_forward'});
       const journalNo=await nextWorkflowNumber(conn,'accounting_journals','journal_no','YJV',closing.close_date);const[journal]=await conn.query(`INSERT INTO accounting_journals(tenant_id,company_id,source_system,source_database,journal_no,journal_date,source_kind,source_id,source_document_no,status,memo,created_by,posted_by,posted_at) VALUES(?,?,?,?,?,?,?,?,?,'posted',?,?,?,NOW())`,[c.tenant_id,c.company_id,c.source_system,db,journalNo,closing.close_date,'year_close',id,closing.closing_no,`年度 ${year} 損益結轉`,req.auth.id,req.auth.id]);for(let i=0;i<lines.length;i++){const line=lines[i];await conn.query('INSERT INTO accounting_journal_lines(journal_id,line_no,account_code,account_name,debit_amount,credit_amount,party_code,description) VALUES(?,?,?,?,?,?,?,?)',[journal.insertId,i+1,line.account_code,line.account_name,line.debit_amount,line.credit_amount,null,line.description]);}
       await conn.query('DELETE FROM accounting_year_closing_lines WHERE closing_id=?',[id]);for(let i=0;i<carryLines.length;i++){const row=carryLines[i];await conn.query(`INSERT INTO accounting_year_closing_lines(closing_id,line_no,account_code,account_name,account_type,opening_debit,opening_credit,period_debit,period_credit,ending_debit,ending_credit,carry_forward_debit,carry_forward_credit,balance_amount,line_kind) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[id,i+1,row.account_code,row.account_name,row.account_type,row.opening_debit,row.opening_credit,row.period_debit,row.period_credit,row.ending_debit,row.ending_credit,row.carry_forward_debit,row.carry_forward_credit,row.balance_amount,row.line_kind]);}
       const reconciliationStatus=Math.abs(closeDebit-closeCredit)<=ACCOUNTING_EPS?'balanced':'difference';await conn.query("UPDATE accounting_year_closings SET status='posted',net_income=?,journal_id=?,line_count=?,carry_forward_count=?,total_debit=?,total_credit=?,reconciliation_status=?,next_fiscal_year=?,posted_by=?,posted_at=NOW() WHERE id=?",[netIncome,journal.insertId,carryLines.length,carryLines.length,closeDebit,closeCredit,reconciliationStatus,String(Number(year)+1),req.auth.id,id]);return{id,closing_no:closing.closing_no,status:'posted',journal_id:journal.insertId,journal_no:journalNo,net_income:netIncome,line_count:carryLines.length,carry_forward_count:carryLines.length,total_debit:closeDebit,total_credit:closeCredit,next_fiscal_year:String(Number(year)+1),reconciliation_status:reconciliationStatus};
     });res.json({ok:true,data:out});
   }catch(e){next(e);}});
  app.get('/api/accounting/auto-rules', async (req,res,next) => { try {
    await ensureTargetFinanceWorkflowSchema();
    const db=String(req.query.source_database||'SH').toUpperCase(),c=contextFor(db);
    await tx(async conn=>seedAccountingAutoRules(conn,c,req.auth?.id||null));
    const [rows]=await pool.query(`SELECT * FROM accounting_auto_rules WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? ORDER BY module_code,document_kind,entry_role,rule_code`,[c.tenant_id,c.company_id,c.source_system,db]);
    res.json({ok:true,data:rows});
  } catch(e){next(e);} });
  app.post('/api/accounting/auto-rules', async (req,res,next) => { try {
    await ensureTargetFinanceWorkflowSchema();
    const b=req.body||{},db=String(b.source_database||'SH').toUpperCase(),c=contextFor(db);
    const values=[trim(b.rule_code),trim(b.module_code).toUpperCase(),trim(b.document_kind)||'*',trim(b.document_type)||'*',trim(b.entry_role)||'main',trim(b.debit_account_code),trim(b.debit_account_name),trim(b.credit_account_code),trim(b.credit_account_name)];
    if(values.some(x=>!x))throw badRequest('分錄規則代號、模組、分錄角色與借貸科目不可空白');
    const [r]=await pool.query(`INSERT INTO accounting_auto_rules(tenant_id,company_id,source_system,source_database,rule_code,module_code,document_kind,document_type,entry_role,debit_account_code,debit_account_name,credit_account_code,credit_account_name,is_active,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,[c.tenant_id,c.company_id,c.source_system,db,...values,trim(b.note),req.auth.id]);
    res.status(201).json({ok:true,data:{id:r.insertId}});
  } catch(e){next(e);} });
  app.put('/api/accounting/auto-rules/:id', async (req,res,next) => { try {
    const id=Number(req.params.id),b=req.body||{},db=String(b.source_database||req.query.source_database||'SH').toUpperCase(),c=contextFor(db);
    const [r]=await pool.query(`UPDATE accounting_auto_rules SET document_kind=?,document_type=?,entry_role=?,debit_account_code=?,debit_account_name=?,credit_account_code=?,credit_account_name=?,is_active=?,note=? WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=?`,[trim(b.document_kind)||'*',trim(b.document_type)||'*',trim(b.entry_role)||'main',trim(b.debit_account_code),trim(b.debit_account_name),trim(b.credit_account_code),trim(b.credit_account_name),Number(b.is_active??1)?1:0,trim(b.note),id,c.tenant_id,c.company_id,c.source_system,db]);
    if(!r.affectedRows)throw badRequest('找不到自動分錄規則');
    res.json({ok:true,data:{id}});
  } catch(e){next(e);} });
  app.delete('/api/accounting/auto-rules/:id', async (req,res,next) => { try {
    const id=Number(req.params.id),db=String(req.query.source_database||'SH').toUpperCase(),c=contextFor(db);const [r]=await pool.query('UPDATE accounting_auto_rules SET is_active=0 WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=?',[id,c.tenant_id,c.company_id,c.source_system,db]);
    if(!r.affectedRows)throw badRequest('找不到自動分錄規則');res.json({ok:true,data:{id,is_active:0}});
  } catch(e){next(e);} });
  app.get('/api/accounting/sources', async (req,res,next) => { try {
    await ensureTargetFinanceWorkflowSchema();
    const db=requestDatabase(req),c=contextFor(db),limit=Math.min(Math.max(Number(req.query.limit)||20,1),100);
    const [rows]=await pool.query(`SELECT f.id,f.account_type,f.document_no,f.document_date,f.party_code,f.original_amount,
        COALESCE(NULLIF(f.base_balance_amount,0),f.balance_amount,f.original_amount) remaining_amount,
        f.source_kind,f.source_document_no,f.status
      FROM finance_open_items f
      LEFT JOIN accounting_journals j ON j.tenant_id=f.tenant_id AND j.company_id=f.company_id AND j.source_system=f.source_system
        AND j.source_database=f.source_database AND j.source_kind=CONCAT('finance_',LOWER(f.account_type)) AND j.source_id=f.id AND j.status<>'voided'
      LEFT JOIN accounting_draft_sources ds ON ds.source_kind='finance_open_item' AND ds.source_id=f.id
      LEFT JOIN accounting_drafts d ON d.id=ds.draft_id AND d.status IN ('draft','approved','posted')
      WHERE f.tenant_id=? AND f.company_id=? AND f.source_system=? AND f.source_database=?
        AND f.status IN ('open','partial') AND COALESCE(NULLIF(f.base_balance_amount,0),f.balance_amount,f.original_amount)<>0
        AND j.id IS NULL AND d.id IS NULL
      ORDER BY f.document_date DESC,f.id DESC LIMIT ?`,[c.tenant_id,c.company_id,c.source_system,db,limit]);
    res.json({ok:true,data:rows});
  } catch(e){next(e);} });
  app.get('/api/accounting/accounts', async (req,res,next) => { try {
    await ensureTargetFinanceWorkflowSchema();
    const db=String(req.query.source_database||'SH').toUpperCase(),c=contextFor(db);
    await tx(async conn=>seedAccounts(conn,c));
    const [rows]=await pool.query(`SELECT account_code,account_name,account_type,is_active
      FROM accounting_accounts WHERE tenant_id=? AND company_id=? AND source_system=? AND is_active=1
      ORDER BY account_code`,[c.tenant_id,c.company_id,c.source_system]);
    res.json({ok:true,data:rows});
  } catch(e){next(e);} });
  app.post('/api/accounting/journals', async (req,res,next) => { try {
    await ensureTargetFinanceWorkflowSchema();
    const b=req.body||{},db=String(b.source_database||'SH').toUpperCase(),c=contextFor(db);
    const date=validDate(b.journal_date),memo=trim(b.memo),rawLines=Array.isArray(b.lines)?b.lines:[];
    if(rawLines.length<2)throw badRequest('傳票至少需要兩筆分錄');
    const lines=rawLines.map((line,index)=>{
      const debit=Number(line.debit_amount||0),credit=Number(line.credit_amount||0);
      if(!trim(line.account_code)||!Number.isFinite(debit)||!Number.isFinite(credit)||debit<0||credit<0||((debit>0)+(credit>0))!==1)throw badRequest(`第 ${index+1} 筆分錄的科目或借貸金額不正確`);
      return {account_code:trim(line.account_code),debit_amount:debit,credit_amount:credit,party_code:trim(line.party_code)||null,description:trim(line.description)||null};
    });
    const debitTotal=lines.reduce((sum,line)=>sum+line.debit_amount,0),creditTotal=lines.reduce((sum,line)=>sum+line.credit_amount,0);
    if(debitTotal<=0||Math.abs(debitTotal-creditTotal)>0.000001)throw badRequest('傳票借貸不平衡，不能建立草稿');
    const out=await tx(async conn=>{
      await seedAccounts(conn,c);
      const codes=[...new Set(lines.map(line=>line.account_code))];
      const [accountRows]=await conn.query(`SELECT account_code,account_name FROM accounting_accounts
        WHERE tenant_id=? AND company_id=? AND source_system=? AND is_active=1 AND account_code IN (${codes.map(()=>'?').join(',')})`,[c.tenant_id,c.company_id,c.source_system,...codes]);
      const accountMap=new Map(accountRows.map(row=>[String(row.account_code),row]));
      for(const line of lines)if(!accountMap.has(line.account_code))throw badRequest(`科目不存在或已停用：${line.account_code}`);
      const journalNo=await nextWorkflowNumber(conn,'accounting_journals','journal_no','JV',date);
      const [header]=await conn.query(`INSERT INTO accounting_journals
        (tenant_id,company_id,source_system,source_database,journal_no,journal_date,source_kind,source_id,source_document_no,status,memo,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,'draft',?,?)`,[c.tenant_id,c.company_id,c.source_system,db,journalNo,date,'manual_journal',0,journalNo,memo||'手動建立傳票',req.auth.id]);
      await conn.query('UPDATE accounting_journals SET source_id=? WHERE id=?',[header.insertId,header.insertId]);
      for(let i=0;i<lines.length;i++){const line=lines[i],account=accountMap.get(line.account_code);await conn.query(`INSERT INTO accounting_journal_lines
        (journal_id,line_no,account_code,account_name,debit_amount,credit_amount,party_code,description) VALUES(?,?,?,?,?,?,?,?)`,[header.insertId,i+1,line.account_code,account.account_name,line.debit_amount,line.credit_amount,line.party_code,line.description]);}
      return {id:header.insertId,journal_no:journalNo,journal_date:date,debit_total:debitTotal,credit_total:creditTotal,status:'draft'};
    });
    res.status(201).json({ok:true,data:out});
  } catch(e){next(e);} });
  app.post('/api/accounting/journals/transfer', async (req,res,next) => { try {
    await ensureTargetFinanceWorkflowSchema();
    const openItemId=Number(req.body?.open_item_id||0),settlementId=Number(req.body?.settlement_id||0),memo=trim(req.body?.memo);
    if ((openItemId>0)+(settlementId>0)!==1) throw badRequest('請指定一筆應收／應付帳款或一筆已過帳收付款單');
    const out=await tx(async conn=>{
      let record,context,sourceKind,sourceId,sourceDocumentNo,journalDate,sourceRows=[],settlement=null,settlementConfig=null;
      const groups=[];
      const addGroup=(accountType,flowKind,flowType,amount,partyCode,entryRole='main')=>{
        const value=Number(amount); if(!Number.isFinite(value)||Math.abs(value)<=0.000001)return;
        const sign=value<0?'negative':'positive';
        const key=[entryRole,accountType,flowKind,flowType||'*',sign].join('|');
        const current=groups.find(row=>row.key===key);
        if(current)current.amount+=value;
        else groups.push({key,accountType,flowKind,flowType:flowType||'*',amount:value,partyCode,entryRole});
      };
      if (settlementId) {
        [[settlement]]=await conn.query("SELECT * FROM finance_settlements WHERE id=? AND status='posted' FOR UPDATE",[settlementId]);
        if(!settlement)throw badRequest('只有已過帳收付款單可以拋轉會計');
        record=settlement;context=contextFor(String(settlement.source_database).toUpperCase());sourceKind='finance_settlement';sourceId=settlement.id;sourceDocumentNo=settlement.settlement_no;journalDate=settlement.settlement_date;
        addGroup(settlement.account_type,'settlement','*',settlement.amount,settlement.party_code);
        if(Math.abs(Number(settlement.exchange_difference||0))>0.000001){
          [[settlementConfig]]=await conn.query('SELECT * FROM finance_closing_settings WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND account_type=? FOR UPDATE',[settlement.tenant_id,settlement.company_id,settlement.source_system,settlement.source_database,settlement.account_type]);
        }
      } else {
        const [[openItem]]=await conn.query(`SELECT * FROM finance_open_items WHERE id=? AND status IN ('open','partial','settled') FOR UPDATE`,[openItemId]);
        if(!openItem)throw badRequest('只有已立帳的應收／應付可以拋轉會計');
        record=openItem;context=contextFor(String(openItem.source_database).toUpperCase());sourceKind=`finance_${String(openItem.account_type).toLowerCase()}`;sourceId=openItem.id;sourceDocumentNo=openItem.document_no;journalDate=openItem.document_date;
        if(openItem.source_kind==='finance_voucher'&&openItem.source_document_id){
          [sourceRows]=await conn.query(`SELECT source_kind,source_document_type,source_document_id,source_document_item_id,source_amount,allocated_amount FROM finance_voucher_sources WHERE voucher_id=? ORDER BY id`,[openItem.source_document_id]);
        }
        if(sourceRows.length) for(const row of sourceRows) addGroup(openItem.account_type,row.source_kind,row.source_document_type||'*',row.allocated_amount,openItem.party_code);
        else addGroup(openItem.account_type,openItem.account_type==='AR'?'shipment':'purchase_receipt','*',openItem.original_amount,openItem.party_code);
      }
      await assertOpenAccountingPeriod(conn,context,journalDate);
      await seedAccounts(conn,record);
      await seedAccountingAutoRules(conn,context,req.auth?.id||null);
      const [[lockedDraft]]=await conn.query(`SELECT d.draft_no,d.status FROM accounting_draft_sources s JOIN accounting_drafts d ON d.id=s.draft_id
        WHERE s.source_kind='finance_open_item' AND s.source_id=? AND d.status IN ('draft','approved','posted') LIMIT 1`,[openItemId>0?sourceId:0]);
      if(lockedDraft)throw badRequest(`來源已鎖定於會計底稿 ${lockedDraft.draft_no}（${lockedDraft.status}），請完成底稿鏈後再拋轉`);
      const [[existing]]=await conn.query('SELECT id,journal_no,status FROM accounting_journals WHERE tenant_id=? AND company_id=? AND source_system=? AND source_kind=? AND source_id=?',[record.tenant_id,record.company_id,record.source_system,sourceKind,sourceId]);
      if(existing)return existing;
      const normalizedDate=journalDate instanceof Date
        ? `${journalDate.getFullYear()}-${String(journalDate.getMonth()+1).padStart(2,'0')}-${String(journalDate.getDate()).padStart(2,'0')}`
        : validDate(journalDate);
      const journalNo=await nextWorkflowNumber(conn,'accounting_journals','journal_no','JV',normalizedDate);
      const [header]=await conn.query(`INSERT INTO accounting_journals
        (tenant_id,company_id,source_system,source_database,journal_no,journal_date,source_kind,source_id,source_document_no,status,memo,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,'draft',?,?)`,[record.tenant_id,record.company_id,record.source_system,record.source_database,journalNo,normalizedDate,sourceKind,sourceId,sourceDocumentNo,memo||`由${record.account_type} ${sourceDocumentNo}拋轉`,req.auth.id]);
      const lines=[];
      for(const group of groups){
        const rule=await findAccountingAutoRule(conn,context,group.accountType,group.flowKind,group.flowType,group.entryRole);
        if(settlementId&&group.flowKind==='settlement')lines.push(...accountingSettlementLines(rule,settlement,group.partyCode,rule.note||'收付款沖銷'));
        else lines.push(...accountingRuleLines(rule,Math.abs(group.amount),group.partyCode,rule.note||'自動分錄'));
      }
      if(settlementId&&settlementConfig&&Math.abs(Number(settlement.exchange_difference||0))>0.000001){
        const difference=Number(settlement.exchange_difference),isGain=difference>0,accountCode=isGain?(settlementConfig.exchange_gain_account_code||'7161'):(settlementConfig.exchange_loss_account_code||'7162'),accountName=isGain?(settlementConfig.exchange_gain_account_name||'兌換利益'):(settlementConfig.exchange_loss_account_name||'兌換損失'),accountType=isGain?'revenue':'expense';
        await conn.query('INSERT IGNORE INTO accounting_accounts(tenant_id,company_id,source_system,account_code,account_name,account_type) VALUES(?,?,?,?,?,?)',[record.tenant_id,record.company_id,record.source_system,accountCode,accountName,accountType]);
        lines.push([accountCode,accountName,isGain?0:Math.abs(difference),isGain?Math.abs(difference):0,record.party_code,isGain?'匯兌利益':'匯兌損失']);
      }
      if (!settlementId && record.account_type==='AR') {
        const costGroups=[];
        const costRows=sourceRows.length?sourceRows:[{source_kind:groups[0]?.flowKind||'shipment',source_document_type:'*',source_document_id:record.source_document_id,source_document_item_id:null,source_amount:record.original_amount,allocated_amount:record.original_amount}];
        for(const row of costRows){
          if(!['shipment','sales_return'].includes(row.source_kind)||!row.source_document_id)continue;
          const itemFilter=row.source_document_item_id?' AND id=?':'';
          const params=row.source_document_item_id?[row.source_document_id,row.source_document_item_id]:[row.source_document_id];
          const [[cost]]=await conn.query(`SELECT COALESCE(SUM(quantity*unit_cost),0) amount FROM sales_document_items WHERE document_id=?${itemFilter}`,params);
          const ratio=Number(row.source_amount)&&Math.abs(Number(row.source_amount))>0?Math.min(1,Math.abs(Number(row.allocated_amount||0)/Number(row.source_amount))):1;
          const amount=Math.abs(Number(cost?.amount||0))*ratio;if(amount<=0.000001)continue;
          const sign=Number(row.allocated_amount)<0?'negative':'positive',key=[row.source_kind,row.source_document_type||'*',sign].join('|');
          const current=costGroups.find(x=>x.key===key);if(current)current.amount+=amount;else costGroups.push({key,flowKind:row.source_kind,flowType:row.source_document_type||'*',amount});
        }
        for(const group of costGroups){const rule=await findAccountingAutoRule(conn,context,'AR',group.flowKind,group.flowType,'cost');lines.push(...accountingRuleLines(rule,group.amount,record.party_code,rule.note||'存貨成本'));}
      }
      if(!lines.length)throw badRequest('找不到可產生的自動分錄');
      for(let i=0;i<lines.length;i++)await conn.query(`INSERT INTO accounting_journal_lines
        (journal_id,line_no,account_code,account_name,debit_amount,credit_amount,party_code,description) VALUES(?,?,?,?,?,?,?,?)`,[header.insertId,i+1,...lines[i]]);
      return{id:header.insertId,journal_no:journalNo,status:'draft',line_count:lines.length};
    });
    res.status(201).json({ok:true,data:out});
  } catch(e){if(e.code==='ER_DUP_ENTRY')e=badRequest('此帳款或收付款單已拋轉會計');next(e);} });
  app.post('/api/accounting/journals/:id/post', async (req,res,next) => { try {
    await ensureTargetFinanceWorkflowSchema();
    const id=Number(req.params.id);
    await tx(async conn=>{
      // 傳票過帳必須以目前公司別的完整資料範圍鎖定；不能只靠全域 id，
      // 否則不同公司共用資料庫時，可能誤操作另一公司的草稿傳票。
      const requestedDb=requestDatabase(req);
      const requestedContext=contextFor(requestedDb);
      const [[j]]=await conn.query(`SELECT * FROM accounting_journals
        WHERE id=? AND tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND status='draft'
        FOR UPDATE`,[id,requestedContext.tenant_id,requestedContext.company_id,requestedContext.source_system,requestedContext.source_database]);
      if(!j)throw badRequest('只有草稿傳票可以過帳');
      await assertOpenAccountingPeriod(conn,contextFor(String(j.source_database).toUpperCase()),j.journal_date);
      const [[sum]]=await conn.query('SELECT COALESCE(SUM(debit_amount),0) debit,COALESCE(SUM(credit_amount),0) credit,COUNT(*) line_count FROM accounting_journal_lines WHERE journal_id=?',[id]);
      if(Number(sum.line_count)<2||Math.abs(Number(sum.debit)-Number(sum.credit))>0.000001)throw badRequest('傳票借貸不平衡，無法過帳');
      const [[invalidAccount]]=await conn.query(`SELECT l.account_code FROM accounting_journal_lines l
        LEFT JOIN accounting_accounts a ON a.tenant_id=? AND a.company_id=? AND a.source_system=? AND a.account_code=l.account_code AND a.is_active=1
        WHERE l.journal_id=? AND a.id IS NULL LIMIT 1`,[j.tenant_id,j.company_id,j.source_system,id]);
      if(invalidAccount)throw badRequest(`傳票含不存在或停用科目：${invalidAccount.account_code}`);
      await conn.query("UPDATE accounting_journals SET status='posted',posted_by=?,posted_at=NOW() WHERE id=?",[req.auth.id,id]);
    });
    res.json({ok:true,data:{id,status:'posted'}});
  } catch(e){next(e);} });
   app.get('/api/accounting/journals', async (req,res,next) => { try {
     const db=requestDatabase(req),c=contextFor(db),limit=Math.min(Math.max(Number(req.query.limit)||20,1),100);
     const [rows]=await pool.query(`SELECT j.id,j.journal_no,j.journal_date,j.source_kind,j.source_document_no,j.status,j.memo,
       l.line_no,l.account_code,l.account_name,l.debit_amount,l.credit_amount,l.party_code,l.description
      FROM accounting_journals j JOIN accounting_journal_lines l ON l.journal_id=j.id
      WHERE j.tenant_id=? AND j.company_id=? AND j.source_system=? AND j.source_database=? ORDER BY j.journal_date DESC,j.id DESC,l.line_no LIMIT ?`,[c.tenant_id,c.company_id,c.source_system,db,limit*4]);
     res.json({ok:true,data:rows});
   } catch(e){next(e);} });
   app.get('/api/accounting/ledger', async (req,res,next) => { try {
     await ensureTargetFinanceWorkflowSchema();
     const db=requestDatabase(req),c=contextFor(db),from=validDate(req.query.from_date||'1900-01-01'),to=validDate(req.query.to_date||new Date().toISOString().slice(0,10)),account=trim(req.query.account_code),limit=Math.min(Math.max(Number(req.query.limit)||100,1),500),trial=await queryTrialRows(pool,c,from,to),rows=account?trial.filter(row=>String(row.account_code)===account):trial;
     const conditions=['j.tenant_id=?','j.company_id=?','j.source_system=?','j.source_database=?',"j.status='posted'",'j.journal_date BETWEEN ? AND ?'];const params=[c.tenant_id,c.company_id,c.source_system,db,from,to];if(account){conditions.push('l.account_code=?');params.push(account);}const[[summary]]=await pool.query(`SELECT COUNT(DISTINCT j.id) journal_count,COALESCE(SUM(l.debit_amount),0) debit_amount,COALESCE(SUM(l.credit_amount),0) credit_amount FROM accounting_journals j JOIN accounting_journal_lines l ON l.journal_id=j.id WHERE ${conditions.join(' AND ')}`,params);const details=await queryLedgerDetails(pool,c,from,to,account,limit);const reconciliation=await queryFinancialReconciliation(pool,c,to);res.json({ok:true,data:{date_from:from,date_to:to,rows:rows.slice(0,limit),summary:{...summary,debit_amount:Number(summary.debit_amount||0),credit_amount:Number(summary.credit_amount||0)},details:details.rows,opening_balances:details.opening_balances,totals:{opening_debit:rows.reduce((s,r)=>s+r.opening_debit,0),opening_credit:rows.reduce((s,r)=>s+r.opening_credit,0),period_debit:rows.reduce((s,r)=>s+r.period_debit,0),period_credit:rows.reduce((s,r)=>s+r.period_credit,0),ending_debit:rows.reduce((s,r)=>s+r.ending_debit,0),ending_credit:rows.reduce((s,r)=>s+r.ending_credit,0)},reconciliation}});
   } catch(e){next(e);} });
}

function registerInventoryWorkflowRoutes(app) {
  const contextFor = sourceDatabase => {
    const source=sourceDatabases[sourceDatabase];
    if(!source) throw badRequest(`找不到資料來源：${sourceDatabase}`);
    return {tenant_id:source.tenant_id||'default',company_id:source.company_id||sourceDatabase,source_system:source.source_system||source.adapter_code||'ism-sh',source_database:sourceDatabase};
  };
  app.use('/api/inventory-workflow/documents/:id/post', async (req,res,next) => {
    try {
      await ensureTargetFinanceWorkflowSchema();
      const id=Number(req.params.id);
      const [[d]]=await pool.query('SELECT document_date,source_database FROM inventory_documents WHERE id=?',[id]);
      if (d) await tx(async conn=>assertOpenAccountingPeriod(conn,contextFor(String(d.source_database||'SH').toUpperCase()),d.document_date));
      next();
    } catch(e){next(e);}
  });
  app.get('/api/inventory-workflow/availability',async(req,res,next)=>{try{
    const db=String(req.query.source_database||'SH').toUpperCase(),c=contextFor(db),limit=Math.min(Math.max(Number(req.query.limit)||200,1),1000);
    const[rows]=await pool.query(`
      SELECT x.item_code,COALESCE(MAX(p.name),'') item_name,COALESCE(MAX(p.unit),'PCS') unit,
        x.warehouse_code,COALESCE(MAX(p.safety_stock),0) safety_stock,
        SUM(x.on_hand_quantity) on_hand_quantity,SUM(x.ordered_quantity) ordered_quantity,
        SUM(x.pending_shipment_quantity) pending_shipment_quantity,SUM(x.pending_receipt_quantity) pending_receipt_quantity,
        SUM(x.on_hand_quantity)+SUM(x.pending_receipt_quantity)-SUM(x.pending_shipment_quantity) available_before_safety,
        SUM(x.on_hand_quantity)+SUM(x.pending_receipt_quantity)-SUM(x.pending_shipment_quantity)-COALESCE(MAX(p.safety_stock),0) available_quantity
      FROM (
        SELECT item_code,warehouse_code,SUM(quantity_on_hand) on_hand_quantity,0 ordered_quantity,0 pending_shipment_quantity,0 pending_receipt_quantity
        FROM erp_inventory_balances
        WHERE tenant_id=? AND company_id=? AND source_system=?
        GROUP BY item_code,warehouse_code
        UNION ALL
        SELECT i.item_code,COALESCE(NULLIF(i.warehouse_code,''),NULLIF(d.warehouse_code,''),''),0,SUM(i.quantity),SUM(GREATEST(i.quantity-i.related_quantity,0)),0
        FROM sales_documents d JOIN sales_document_items i ON i.document_id=d.id
        WHERE d.source_database=? AND d.document_kind='sales_order' AND d.status IN ('approved','partial')
        GROUP BY i.item_code,COALESCE(NULLIF(i.warehouse_code,''),NULLIF(d.warehouse_code,''),'')
        UNION ALL
        SELECT i.item_code,COALESCE(i.warehouse_code,''),0,0,0,SUM(GREATEST(i.qty_ordered-i.qty_received-i.qty_cancelled,0))
        FROM procurement_orders o JOIN procurement_order_items i ON i.purchase_order_id=o.id
        WHERE o.source_database=? AND o.status NOT IN ('cancelled','closed')
        GROUP BY i.item_code,COALESCE(i.warehouse_code,'')
      ) x LEFT JOIN products p ON p.sku=x.item_code
      GROUP BY x.item_code,x.warehouse_code
      HAVING SUM(x.on_hand_quantity)<>0 OR SUM(x.ordered_quantity)<>0 OR SUM(x.pending_receipt_quantity)<>0
      ORDER BY x.item_code,x.warehouse_code
      LIMIT ?`,[c.tenant_id,c.company_id,c.source_system,db,db,limit]);
    res.json({ok:true,data:rows,meta:{formula:'可用量＝現有量＋待進貨量－待出貨量－安全庫存',source_database:db,company_id:c.company_id}});
  }catch(e){next(e);}});
  const defaults=[['IS','其他領料','issue','IS'],['RT','其他退料','return','RT'],['AI','庫存增加調整','adjust_in','AI'],['AO','庫存減少調整','adjust_out','AO'],['SC','庫存報廢','scrap','SC'],['CA','庫存成本調整','cost_adjust','CA'],['TR','庫存轉撥','transfer','TR'],['TI','暫入','temp_in','TI'],['TIR','暫入歸還','temp_in_return','TIR'],['TO','暫出','temp_out','TO'],['TOR','暫出歸還','temp_out_return','TOR'],['ST','盤點調整','stocktake','ST']];
  async function ensureTypes(sourceDatabase){
    const c=contextFor(sourceDatabase);
    for(const row of defaults) await pool.query(`INSERT IGNORE INTO inventory_document_types(tenant_id,company_id,source_system,type_code,type_name,movement_kind,number_prefix) VALUES(?,?,?,?,?,?,?)`,[c.tenant_id,c.company_id,c.source_system,...row]);
    return c;
  }
  app.get('/api/inventory-workflow/document-types',async(req,res,next)=>{try{const db=String(req.query.source_database||'SH').toUpperCase(),c=await ensureTypes(db);const [rows]=await pool.query('SELECT * FROM inventory_document_types WHERE tenant_id=? AND company_id=? AND source_system=? ORDER BY movement_kind,type_code',[c.tenant_id,c.company_id,c.source_system]);res.json({ok:true,data:rows});}catch(e){next(e);}});
  app.post('/api/inventory-workflow/document-types',async(req,res,next)=>{try{const b=req.body||{},db=String(b.source_database||'SH').toUpperCase(),c=contextFor(db),kind=trim(b.movement_kind);if(!defaults.some(x=>x[2]===kind)||!trim(b.type_code)||!trim(b.type_name))throw badRequest('請輸入有效的單據性質');const [r]=await pool.query(`INSERT INTO inventory_document_types(tenant_id,company_id,source_system,type_code,type_name,movement_kind,number_prefix,requires_approval,allow_negative,note) VALUES(?,?,?,?,?,?,?,?,?,?)`,[c.tenant_id,c.company_id,c.source_system,trim(b.type_code),trim(b.type_name),kind,trim(b.number_prefix)||trim(b.type_code),Number(b.requires_approval??1),Number(b.allow_negative||0),trim(b.note)]);res.status(201).json({ok:true,data:{id:r.insertId}});}catch(e){if(e.code==='ER_DUP_ENTRY')e=badRequest('單據性質代號已存在');next(e);}});
  app.get('/api/inventory-workflow/documents',async(req,res,next)=>{try{const db=String(req.query.source_database||'SH').toUpperCase(),kind=trim(req.query.movement_kind),params=[db];let filter='d.source_database=?';if(kind){filter+=' AND d.movement_kind=?';params.push(kind);}const [rows]=await pool.query(`SELECT d.*,i.id item_id,i.item_code,i.item_name,i.unit,i.from_warehouse_code,i.to_warehouse_code,i.quantity,i.counted_quantity,i.unit_cost,i.amount_delta,i.reason FROM inventory_documents d JOIN inventory_document_items i ON i.document_id=d.id WHERE ${filter} ORDER BY d.document_date DESC,d.id DESC LIMIT 100`,params);res.json({ok:true,data:rows});}catch(e){next(e);}});
  app.get('/api/inventory-workflow/temporary-open',async(req,res,next)=>{try{await ensureTargetReceiptWorkflowSchema();const db=String(req.query.source_database||'SH').toUpperCase(),c=contextFor(db);const[rows]=await pool.query(`SELECT d.id,d.document_no,d.document_date,d.movement_kind,d.counterparty,i.item_code,i.item_name,i.unit,i.from_warehouse_code,i.to_warehouse_code,i.quantity,i.unit_cost,
    COALESCE((SELECT SUM(ri.quantity) FROM inventory_documents rd JOIN inventory_document_items ri ON ri.document_id=rd.id WHERE rd.related_document_id=d.id AND rd.status IN ('draft','approved','posted')),0) returned_quantity,
    GREATEST(i.quantity-COALESCE((SELECT SUM(ri.quantity) FROM inventory_documents rd JOIN inventory_document_items ri ON ri.document_id=rd.id WHERE rd.related_document_id=d.id AND rd.status IN ('draft','approved','posted')),0),0) remaining_quantity
    FROM inventory_documents d JOIN inventory_document_items i ON i.document_id=d.id
    WHERE d.tenant_id=? AND d.company_id=? AND d.source_system=? AND d.source_database=? AND d.status='posted' AND d.movement_kind IN ('temp_in','temp_out')
    HAVING remaining_quantity>0 ORDER BY d.document_date DESC,d.id DESC`,[c.tenant_id,c.company_id,c.source_system,db]);res.json({ok:true,data:rows});}catch(e){next(e);}});
  app.post('/api/inventory-workflow/documents', async (req,res,next) => { try {
    await ensureTargetReceiptWorkflowSchema();
    const b=req.body||{}, db=String(b.source_database||'SH').toUpperCase(), c=await ensureTypes(db);
    const date=validDate(b.document_date), type=trim(b.document_type);
    const [[dt]]=await pool.query('SELECT * FROM inventory_document_types WHERE tenant_id=? AND company_id=? AND source_system=? AND type_code=? AND is_active=1',[c.tenant_id,c.company_id,c.source_system,type]);
    if(!dt) throw badRequest('找不到啟用中的庫存單據性質');
    if(!trim(b.item_code)) throw badRequest('品號不可空白');
    const qty=Number(b.quantity||0), counted=b.counted_quantity===''||b.counted_quantity==null?null:Number(b.counted_quantity);
    if(dt.movement_kind!=='cost_adjust'&&dt.movement_kind!=='stocktake'&&qty<=0) throw badRequest('數量必須大於 0');
    if(dt.movement_kind==='stocktake'&&!Number.isFinite(counted)) throw badRequest('盤點單必須輸入實盤數量');
    if(dt.movement_kind==='transfer'&&(!trim(b.from_warehouse_code)||!trim(b.to_warehouse_code)||trim(b.from_warehouse_code)===trim(b.to_warehouse_code))) throw badRequest('轉出與轉入庫別必須不同');
    const result=await tx(async conn=>{
      let related=null; const relatedId=Number(b.related_document_id||0);
      if(['temp_in_return','temp_out_return'].includes(dt.movement_kind)) {
        if(!relatedId) throw badRequest('暫入／暫出歸還必須選擇原始暫入／暫出單');
        const expected=dt.movement_kind==='temp_in_return'?'temp_in':'temp_out';
        [[related]]=await conn.query(`SELECT d.*,i.item_code,i.from_warehouse_code,i.to_warehouse_code,i.quantity,i.unit_cost
          FROM inventory_documents d JOIN inventory_document_items i ON i.document_id=d.id
          WHERE d.id=? AND d.tenant_id=? AND d.company_id=? AND d.source_system=? AND d.source_database=? AND d.movement_kind=? AND d.status='posted' FOR UPDATE`,[relatedId,c.tenant_id,c.company_id,c.source_system,db,expected]);
        if(!related) throw badRequest('找不到可歸還的原始暫出入單');
        if(related.item_code!==trim(b.item_code)) throw badRequest('歸還品號必須與原暫出入單相同');
        const [[used]]=await conn.query(`SELECT COALESCE(SUM(i.quantity),0) quantity FROM inventory_documents d JOIN inventory_document_items i ON i.document_id=d.id
          WHERE d.related_document_id=? AND d.movement_kind=? AND d.status IN ('draft','approved','posted') FOR UPDATE`,[relatedId,dt.movement_kind]);
        if(qty>Number(related.quantity)-Number(used.quantity||0)) throw badRequest(`歸還數量不可超過未歸還量 ${Number(related.quantity)-Number(used.quantity||0)}`);
      }
      const no=trim(b.document_no)||await nextWorkflowNumber(conn,'inventory_documents','document_no',dt.number_prefix,date);
      const [h]=await conn.query(`INSERT INTO inventory_documents
        (tenant_id,company_id,source_system,source_database,document_no,document_type,movement_kind,document_date,department_code,employee_code,counterparty,related_document_id,related_document_no,status,note,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?)`,[c.tenant_id,c.company_id,c.source_system,db,no,type,dt.movement_kind,date,trim(b.department_code),trim(b.employee_code),trim(b.counterparty)||related?.counterparty||null,related?.id||null,related?.document_no||null,trim(b.note),req.auth.id]);
      await conn.query(`INSERT INTO inventory_document_items(document_id,line_no,item_code,item_name,specification,unit,from_warehouse_code,to_warehouse_code,location_code,lot_no,quantity,counted_quantity,unit_cost,amount_delta,reason)
        VALUES(?,1,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[h.insertId,trim(b.item_code),trim(b.item_name),trim(b.specification),trim(b.unit)||'PCS',trim(b.from_warehouse_code)||related?.from_warehouse_code||null,trim(b.to_warehouse_code)||related?.to_warehouse_code||null,trim(b.location_code),trim(b.lot_no),qty,counted,Number(b.unit_cost||related?.unit_cost||0),Number(b.amount_delta||0),trim(b.reason)]);
      return {id:h.insertId,document_no:no,related_document_no:related?.document_no||null};
    });
    res.status(201).json({ok:true,data:result});
  } catch(e){next(e);} });
  app.post('/api/inventory-workflow/documents/:id/approve',async(req,res,next)=>{try{const id=Number(req.params.id),db=String(req.body?.source_database||req.query.source_database||'SH').toUpperCase();const [r]=await pool.query("UPDATE inventory_documents SET status='approved',approved_by=?,approved_at=NOW() WHERE id=? AND source_database=? AND status='draft'",[req.auth.id,id,db]);if(!r.affectedRows)throw badRequest('只有目前公司別的草稿可以核準');res.json({ok:true,data:{id,status:'approved'}});}catch(e){next(e);}});
  app.post('/api/inventory-workflow/documents/:id/post',async(req,res,next)=>{try{const id=Number(req.params.id),db=String(req.body?.source_database||req.query.source_database||'SH').toUpperCase();await tx(async conn=>{const [[d]]=await conn.query(`SELECT d.*,i.*,d.id document_id,dt.allow_negative FROM inventory_documents d JOIN inventory_document_items i ON i.document_id=d.id JOIN inventory_document_types dt ON dt.tenant_id=d.tenant_id AND dt.company_id=d.company_id AND dt.source_system=d.source_system AND dt.type_code=d.document_type WHERE d.id=? AND d.source_database=? FOR UPDATE`,[id,db]);if(!d||d.status!=='approved')throw badRequest('只有目前公司別已核準單據可以過帳');const getBalance=async wh=>{const [[r]]=await conn.query(`SELECT * FROM erp_inventory_balances WHERE tenant_id=? AND company_id=? AND source_system=? AND item_code=? AND warehouse_code=? AND location_code=? FOR UPDATE`,[d.tenant_id,d.company_id,d.source_system,d.item_code,wh,d.location_code||'']);return r||{quantity_on_hand:0,inventory_amount:0,unit_cost:0};};const apply=async(wh,qtyDelta,amountDelta)=>{if(!wh)throw badRequest('庫別不可空白');const bal=await getBalance(wh),newQty=Number(bal.quantity_on_hand)+qtyDelta,newAmount=Number(bal.inventory_amount)+amountDelta;if(newQty<0&&!Number(d.allow_negative))throw badRequest(`庫存不足：${d.item_code} / ${wh}`);const newCost=newQty===0?0:newAmount/newQty;await conn.query(`INSERT INTO erp_inventory_balances(tenant_id,company_id,source_system,item_code,warehouse_code,location_code,quantity_on_hand,unit_cost,inventory_amount,last_movement_at) VALUES(?,?,?,?,?,?,?,?,?,NOW()) ON DUPLICATE KEY UPDATE quantity_on_hand=VALUES(quantity_on_hand),unit_cost=VALUES(unit_cost),inventory_amount=VALUES(inventory_amount),last_movement_at=NOW()`,[d.tenant_id,d.company_id,d.source_system,d.item_code,wh,d.location_code||'',newQty,newCost,newAmount]);await conn.query(`INSERT INTO inventory_movement_ledger(tenant_id,company_id,source_system,document_id,document_no,document_type,movement_kind,movement_date,item_code,warehouse_code,location_code,lot_no,quantity_delta,unit_cost,amount_delta) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[d.tenant_id,d.company_id,d.source_system,d.document_id,d.document_no,d.document_type,d.movement_kind,d.document_date,d.item_code,wh,d.location_code||'',d.lot_no||'',qtyDelta,d.unit_cost,amountDelta]);};const cost=Number(d.unit_cost||0);if(d.movement_kind==='transfer'){await apply(d.from_warehouse_code,-Number(d.quantity),-Number(d.quantity)*cost);await apply(d.to_warehouse_code,Number(d.quantity),Number(d.quantity)*cost);}else if(d.movement_kind==='stocktake'){const bal=await getBalance(d.to_warehouse_code||d.from_warehouse_code),delta=Number(d.counted_quantity)-Number(bal.quantity_on_hand);await apply(d.to_warehouse_code||d.from_warehouse_code,delta,delta*cost);}else if(d.movement_kind==='cost_adjust'){await apply(d.to_warehouse_code||d.from_warehouse_code,0,Number(d.amount_delta));}else{const positive=['return','adjust_in','temp_in','temp_out_return'].includes(d.movement_kind),qty=(positive?1:-1)*Number(d.quantity);await apply(d.to_warehouse_code||d.from_warehouse_code,qty,qty*cost);}await conn.query("UPDATE inventory_documents SET status='posted',posted_by=?,posted_at=NOW() WHERE id=?",[req.auth.id,id]);});res.json({ok:true,data:{id,status:'posted'}});}catch(e){next(e);}});
  app.get('/api/inventory-workflow/procurement-pending',async(req,res,next)=>{try{await ensureTargetReceiptWorkflowSchema();const db=String(req.query.source_database||'SH').toUpperCase();const [receipts]=await pool.query(`SELECT 'receipt' source_kind,r.id,r.receipt_no document_no,r.receipt_date document_date,r.supplier_code,i.item_code,i.item_name,i.warehouse_code,i.unit,i.qty_accepted quantity,i.unit_cost,r.inventory_status FROM procurement_receipts r JOIN procurement_receipt_items i ON i.receipt_id=r.id WHERE r.source_database=? AND r.status IN ('accepted','partially_accepted') AND r.inventory_status='pending'`,[db]);const [returns]=await pool.query(`SELECT 'return' source_kind,r.id,r.return_no document_no,r.return_date document_date,r.supplier_code,i.item_code,i.item_name,i.warehouse_code,i.unit,i.return_quantity quantity,i.unit_cost,r.inventory_status FROM procurement_returns r JOIN procurement_return_items i ON i.return_id=r.id WHERE r.source_database=? AND r.return_type='return' AND r.status='approved' AND r.inventory_status='pending'`,[db]);res.json({ok:true,data:[...receipts,...returns]});}catch(e){next(e);}});
  app.post('/api/inventory-workflow/procurement/:kind/:id/post',async(req,res,next)=>{try{const kind=req.params.kind,id=Number(req.params.id),requestedDb=String(req.body?.source_database||req.query.source_database||'SH').toUpperCase();if(!['receipt','return'].includes(kind))throw badRequest('不支援的採購庫存來源');await tx(async conn=>{let header,items;if(kind==='receipt')[[header]]=await conn.query(`SELECT * FROM procurement_receipts WHERE id=? AND source_database=? FOR UPDATE`,[id,requestedDb]);else [[header]]=await conn.query(`SELECT * FROM procurement_returns WHERE id=? AND source_database=? FOR UPDATE`,[id,requestedDb]);if(!header||header.inventory_status!=='pending')throw badRequest('此單據已過帳或不可過帳');if(kind==='receipt'&&!['accepted','partially_accepted'].includes(header.status))throw badRequest('進貨尚未驗收完成');if(kind==='return'&&(header.status!=='approved'||header.return_type!=='return'))throw badRequest('退貨尚未核準');if(kind==='receipt')[items]=await conn.query(`SELECT * FROM procurement_receipt_items WHERE receipt_id=? ORDER BY line_no FOR UPDATE`,[id]);else[items]=await conn.query(`SELECT i.*,ri.purchase_order_item_id FROM procurement_return_items i JOIN procurement_receipt_items ri ON ri.id=i.receipt_item_id WHERE i.return_id=? ORDER BY i.line_no FOR UPDATE`,[id]);if(!items.length)throw badRequest('單據沒有明細，無法過帳');const c=contextFor(requestedDb);for(const item of items){const quantity=(kind==='receipt'?1:-1)*Number(kind==='receipt'?item.qty_accepted:item.return_quantity);if(!quantity)continue;const warehouse=item.warehouse_code||header.warehouse_code||'';if(!warehouse)throw badRequest(`第 ${item.line_no} 筆明細缺少庫別`);const amount=quantity*Number(item.unit_cost||0);const [[bal]]=await conn.query(`SELECT * FROM erp_inventory_balances WHERE tenant_id=? AND company_id=? AND source_system=? AND item_code=? AND warehouse_code=? AND location_code='' FOR UPDATE`,[c.tenant_id,c.company_id,c.source_system,item.item_code,warehouse]);const newQty=Number(bal?.quantity_on_hand||0)+quantity,newAmount=Number(bal?.inventory_amount||0)+amount;if(newQty<0)throw badRequest(`庫存不足：${item.item_code} / ${warehouse}`);await conn.query(`INSERT INTO erp_inventory_balances(tenant_id,company_id,source_system,item_code,warehouse_code,location_code,quantity_on_hand,unit_cost,inventory_amount,last_movement_at) VALUES(?,?,?,?,?,'',?,?,?,NOW()) ON DUPLICATE KEY UPDATE quantity_on_hand=VALUES(quantity_on_hand),unit_cost=VALUES(unit_cost),inventory_amount=VALUES(inventory_amount),last_movement_at=NOW()`,[c.tenant_id,c.company_id,c.source_system,item.item_code,warehouse,newQty,newQty?newAmount/newQty:0,newAmount]);const no=kind==='receipt'?header.receipt_no:header.return_no,date=kind==='receipt'?header.receipt_date:header.return_date;await conn.query(`INSERT INTO inventory_movement_ledger(tenant_id,company_id,source_system,document_id,document_no,document_type,movement_kind,movement_date,item_code,warehouse_code,location_code,lot_no,quantity_delta,unit_cost,amount_delta) VALUES(?,?,?,NULL,?,?,?,?,?,?,'','',?,?,?)`,[c.tenant_id,c.company_id,c.source_system,no,kind==='receipt'?'GR':'PR',kind==='receipt'?'purchase_receipt':'purchase_return',date,item.item_code,warehouse,quantity,item.unit_cost,amount]);}if(kind==='receipt')await conn.query("UPDATE procurement_receipts SET inventory_status='posted',inventory_posted_by=?,inventory_posted_at=NOW() WHERE id=?",[req.auth.id,id]);else {for(const item of items){await conn.query('UPDATE procurement_receipt_items SET qty_returned=qty_returned+?,qty_returned_priced=qty_returned_priced+? WHERE id=?',[item.return_quantity,Number(item.priced_quantity||0),item.receipt_item_id]);if(item.purchase_order_item_id){await conn.query('UPDATE procurement_order_items SET qty_received=GREATEST(qty_received-?,0) WHERE id=?',[item.return_quantity,item.purchase_order_item_id]);const[[orderLine]]=await conn.query('SELECT purchase_order_id FROM procurement_order_items WHERE id=?',[item.purchase_order_item_id]);const[[remaining]]=await conn.query('SELECT COUNT(*) count FROM procurement_order_items WHERE purchase_order_id=? AND qty_ordered>qty_received+qty_cancelled',[orderLine.purchase_order_id]);await conn.query("UPDATE procurement_orders SET status=CASE WHEN status='closed' THEN 'partial_received' WHEN ?>0 THEN 'partial_received' ELSE 'received' END WHERE id=?",[Number(remaining.count),orderLine.purchase_order_id]);}}await conn.query("UPDATE procurement_returns SET status='posted',inventory_status='posted' WHERE id=?",[id]);}});res.json({ok:true,data:{id,kind,status:'posted'}});}catch(e){next(e);}});
  app.get('/api/inventory-workflow/balances',async(req,res,next)=>{try{const db=String(req.query.source_database||'SH').toUpperCase(),c=contextFor(db);const [rows]=await pool.query('SELECT * FROM erp_inventory_balances WHERE tenant_id=? AND company_id=? AND source_system=? ORDER BY warehouse_code,item_code',[c.tenant_id,c.company_id,c.source_system]);res.json({ok:true,data:rows});}catch(e){next(e);}});
  app.get('/api/inventory-workflow/ledger',async(req,res,next)=>{try{const db=String(req.query.source_database||'SH').toUpperCase(),c=contextFor(db);const [rows]=await pool.query('SELECT * FROM inventory_movement_ledger WHERE tenant_id=? AND company_id=? AND source_system=? ORDER BY movement_date DESC,id DESC LIMIT 200',[c.tenant_id,c.company_id,c.source_system]);res.json({ok:true,data:rows});}catch(e){next(e);}});
}

function registerReversalRoutes(app) {
  const contextFor = sourceDatabase => {
    const source = sourceDatabases[sourceDatabase];
    if (!source) throw badRequest(`找不到資料來源：${sourceDatabase}`);
    return { tenant_id: source.tenant_id || 'default', company_id: source.company_id || sourceDatabase, source_system: source.source_system || source.adapter_code || 'ism-sh', source_database: sourceDatabase };
  };
  app.use('/api/reversals/:id/post', async (req,res,next) => {
    try {
      await ensureTargetFinanceWorkflowSchema();
      const id=Number(req.params.id);
      const [[r]]=await pool.query('SELECT reversal_date,source_date,source_database FROM erp_reversal_documents WHERE id=?',[id]);
      if (r) await tx(async conn=>{
        const c=contextFor(String(r.source_database||'SH').toUpperCase());
        await assertOpenAccountingPeriod(conn,c,r.reversal_date);
        assertChronologicalDate(r.reversal_date,r.source_date,'沖回日期');
      });
      next();
    } catch(e){next(e);}
  });

  async function sourceBundle(conn, sourceKind, sourceId, sourceDatabase, lock = false) {
    const c = contextFor(sourceDatabase);
    const suffix = lock ? ' FOR UPDATE' : '';
    let header;
    let ledgerSql;
    let ledgerParams;
    if (sourceKind === 'inventory_document') {
      [[header]] = await conn.query(`SELECT d.id,d.source_database,d.document_no,d.document_type,d.document_date,d.status,d.movement_kind
        FROM inventory_documents d WHERE d.id=? AND d.source_database=? AND d.tenant_id=? AND d.company_id=? AND d.source_system=?${suffix}`,
        [sourceId, sourceDatabase, c.tenant_id, c.company_id, c.source_system]);
      ledgerSql = 'SELECT * FROM inventory_movement_ledger WHERE tenant_id=? AND company_id=? AND source_system=? AND document_id=? ORDER BY id';
      ledgerParams = [c.tenant_id, c.company_id, c.source_system, sourceId];
    } else if (sourceKind === 'purchase_receipt') {
      [[header]] = await conn.query(`SELECT r.id,r.source_database,r.receipt_no document_no,r.document_type,r.receipt_date document_date,r.status,r.inventory_status
        FROM procurement_receipts r WHERE r.id=? AND r.source_database=? AND r.tenant_id=? AND r.company_id=? AND r.source_system=?${suffix}`,
        [sourceId, sourceDatabase, c.tenant_id, c.company_id, c.source_system]);
      ledgerSql = `SELECT * FROM inventory_movement_ledger WHERE tenant_id=? AND company_id=? AND source_system=?
        AND document_no=? AND document_type='GR' AND movement_kind='purchase_receipt' ORDER BY id`;
      ledgerParams = [c.tenant_id, c.company_id, c.source_system, header?.document_no];
    } else if (sourceKind === 'purchase_return') {
      [[header]] = await conn.query(`SELECT r.id,r.source_database,r.return_no document_no,r.document_type,r.return_date document_date,r.status,r.inventory_status
        FROM procurement_returns r WHERE r.id=? AND r.source_database=? AND r.tenant_id=? AND r.company_id=? AND r.source_system=?${suffix}`,
        [sourceId, sourceDatabase, c.tenant_id, c.company_id, c.source_system]);
      ledgerSql = `SELECT * FROM inventory_movement_ledger WHERE tenant_id=? AND company_id=? AND source_system=?
        AND document_no=? AND document_type='PR' AND movement_kind='purchase_return' ORDER BY id`;
      ledgerParams = [c.tenant_id, c.company_id, c.source_system, header?.document_no];
    } else if (sourceKind === 'sales_document') {
      [[header]] = await conn.query(`SELECT d.id,d.source_database,d.document_no,d.document_type,d.document_date,d.status,d.document_kind,r.return_type,d.inventory_status
        FROM sales_documents d LEFT JOIN sales_documents r ON r.id=d.id
        WHERE d.id=? AND d.source_database=? AND d.tenant_id=? AND d.company_id=? AND d.source_system=?${suffix}`,
        [sourceId, sourceDatabase, c.tenant_id, c.company_id, c.source_system]);
      ledgerSql = `SELECT * FROM inventory_movement_ledger WHERE tenant_id=? AND company_id=? AND source_system=?
        AND document_no=? AND document_type=? AND movement_kind=? ORDER BY id`;
      ledgerParams = [c.tenant_id, c.company_id, c.source_system, header?.document_no, header?.document_type, header?.document_kind];
    } else {
      throw badRequest('不支援的沖回來源單據');
    }
    if (!header) return { context: c, header: null, items: [] };
    if (sourceKind === 'inventory_document' && header.status !== 'posted') return { context: c, header, items: [] };
    if (sourceKind === 'purchase_receipt' && header.inventory_status !== 'posted') return { context: c, header, items: [] };
    if (sourceKind === 'purchase_return' && header.inventory_status !== 'posted') return { context: c, header, items: [] };
    if (sourceKind === 'sales_document' && (header.inventory_status !== 'posted' || !['shipment','sales_return'].includes(header.document_kind) || (header.document_kind === 'sales_return' && header.return_type !== 'return'))) return { context: c, header, items: [] };
    const [items] = await conn.query(ledgerSql, ledgerParams);
    return { context: c, header, items };
  }

  app.get('/api/reversals/candidates', async (req, res, next) => {
    try {
      await ensureTargetReversalSchema();
      const sourceDatabase = String(req.query.source_database || 'SH').toUpperCase();
      const c = contextFor(sourceDatabase);
      const params = [c.tenant_id, c.company_id, c.source_system, sourceDatabase];
      const [inventory] = await pool.query(`SELECT 'inventory_document' source_kind,d.id source_id,d.document_no,d.document_type,d.document_date,d.movement_kind,
        COUNT(m.id) line_count,COALESCE(SUM(m.quantity_delta),0) quantity_delta,COALESCE(SUM(m.amount_delta),0) amount_delta
        FROM inventory_documents d JOIN inventory_movement_ledger m ON m.document_id=d.id AND m.tenant_id=? AND m.company_id=? AND m.source_system=?
        WHERE d.source_database=? AND d.status='posted' AND NOT EXISTS(SELECT 1 FROM erp_reversal_documents x WHERE x.tenant_id=d.tenant_id AND x.company_id=d.company_id AND x.source_system=d.source_system AND x.source_kind='inventory_document' AND x.source_document_id=d.id AND x.status IN ('draft','approved','posted'))
        GROUP BY d.id ORDER BY d.document_date DESC,d.id DESC LIMIT 100`, params);
      const [receipts] = await pool.query(`SELECT 'purchase_receipt' source_kind,r.id source_id,r.receipt_no document_no,r.document_type,r.receipt_date document_date,'purchase_receipt' movement_kind,
        COUNT(m.id) line_count,COALESCE(SUM(m.quantity_delta),0) quantity_delta,COALESCE(SUM(m.amount_delta),0) amount_delta
        FROM procurement_receipts r JOIN inventory_movement_ledger m ON m.tenant_id=r.tenant_id AND m.company_id=r.company_id AND m.source_system=r.source_system AND m.document_no=r.receipt_no AND m.document_type='GR' AND m.movement_kind='purchase_receipt'
        WHERE r.source_database=? AND r.inventory_status='posted' AND NOT EXISTS(SELECT 1 FROM erp_reversal_documents x WHERE x.tenant_id=r.tenant_id AND x.company_id=r.company_id AND x.source_system=r.source_system AND x.source_kind='purchase_receipt' AND x.source_document_id=r.id AND x.status IN ('draft','approved','posted'))
        GROUP BY r.id ORDER BY r.receipt_date DESC,r.id DESC LIMIT 100`, [sourceDatabase]);
      const [returns] = await pool.query(`SELECT 'purchase_return' source_kind,r.id source_id,r.return_no document_no,r.document_type,r.return_date document_date,'purchase_return' movement_kind,
        COUNT(m.id) line_count,COALESCE(SUM(m.quantity_delta),0) quantity_delta,COALESCE(SUM(m.amount_delta),0) amount_delta
        FROM procurement_returns r JOIN inventory_movement_ledger m ON m.tenant_id=r.tenant_id AND m.company_id=r.company_id AND m.source_system=r.source_system AND m.document_no=r.return_no AND m.document_type='PR' AND m.movement_kind='purchase_return'
        WHERE r.source_database=? AND r.inventory_status='posted' AND NOT EXISTS(SELECT 1 FROM erp_reversal_documents x WHERE x.tenant_id=r.tenant_id AND x.company_id=r.company_id AND x.source_system=r.source_system AND x.source_kind='purchase_return' AND x.source_document_id=r.id AND x.status IN ('draft','approved','posted'))
        GROUP BY r.id ORDER BY r.return_date DESC,r.id DESC LIMIT 100`, [sourceDatabase]);
      const [sales] = await pool.query(`SELECT 'sales_document' source_kind,d.id source_id,d.document_no,d.document_type,d.document_date,d.document_kind movement_kind,
        COUNT(m.id) line_count,COALESCE(SUM(m.quantity_delta),0) quantity_delta,COALESCE(SUM(m.amount_delta),0) amount_delta
        FROM sales_documents d JOIN inventory_movement_ledger m ON m.tenant_id=d.tenant_id AND m.company_id=d.company_id AND m.source_system=d.source_system AND m.document_no=d.document_no AND m.document_type=d.document_type AND m.movement_kind=d.document_kind
        WHERE d.source_database=? AND d.status='posted' AND d.inventory_status='posted' AND d.document_kind IN ('shipment','sales_return') AND (d.document_kind<>'sales_return' OR d.return_type='return')
          AND NOT EXISTS(SELECT 1 FROM erp_reversal_documents x WHERE x.tenant_id=d.tenant_id AND x.company_id=d.company_id AND x.source_system=d.source_system AND x.source_kind='sales_document' AND x.source_document_id=d.id AND x.status IN ('draft','approved','posted'))
        GROUP BY d.id ORDER BY d.document_date DESC,d.id DESC LIMIT 100`, [sourceDatabase]);
      const labels = { inventory_document:'庫存異動', purchase_receipt:'進貨', purchase_return:'採購退貨', sales_document:'銷貨／銷退' };
      const data = [...inventory,...receipts,...returns,...sales].map(row => ({...row, source_label: labels[row.source_kind] || row.source_kind})).sort((a,b) => String(b.document_date).localeCompare(String(a.document_date)) || Number(b.source_id)-Number(a.source_id)).slice(0, 100);
      res.json({ ok:true, data });
    } catch (error) { next(error); }
  });

  app.get('/api/reversals', async (req, res, next) => {
    try {
      await ensureTargetReversalSchema();
      const sourceDatabase = String(req.query.source_database || 'SH').toUpperCase();
      const [rows] = await pool.query(`SELECT * FROM erp_reversal_documents WHERE source_database=? ORDER BY reversal_date DESC,id DESC LIMIT 100`, [sourceDatabase]);
      res.json({ ok:true, data:rows });
    } catch (error) { next(error); }
  });

  app.post('/api/reversals', async (req, res, next) => {
    try {
      await ensureTargetReversalSchema();
      const body = req.body || {};
      const sourceDatabase = String(body.source_database || 'SH').toUpperCase();
      const sourceKind = trim(body.source_kind);
      const sourceId = Number(body.source_id);
      const reversalDate = validDate(body.reversal_date);
      const reason = trim(body.reason);
      if (!sourceKind || !Number.isInteger(sourceId) || sourceId < 1 || !reason) throw badRequest('來源單據、沖回日期與原因不可空白');
      const result = await tx(async conn => {
        const bundle = await sourceBundle(conn, sourceKind, sourceId, sourceDatabase, true);
        if (!bundle.header || !bundle.items.length) throw badRequest('來源單據不存在、尚未過帳或找不到原始庫存台帳');
        const [[existing]] = await conn.query("SELECT reversal_no,status FROM erp_reversal_documents WHERE tenant_id=? AND company_id=? AND source_system=? AND source_kind=? AND source_document_id=? AND status IN ('draft','approved','posted') FOR UPDATE", [bundle.context.tenant_id,bundle.context.company_id,bundle.context.source_system,sourceKind,sourceId]);
        if (existing) throw badRequest(`此單據已建立沖回紀錄 ${existing.reversal_no}（${existing.status}）`);
        const reversalNo = await nextWorkflowNumber(conn, 'erp_reversal_documents', 'reversal_no', 'RV', reversalDate);
        const [header] = await conn.query(`INSERT INTO erp_reversal_documents
          (tenant_id,company_id,source_system,source_database,reversal_no,source_kind,source_document_id,source_document_no,source_document_type,source_date,reversal_date,reason,replacement_note,status,created_by)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?)`, [bundle.context.tenant_id,bundle.context.company_id,bundle.context.source_system,sourceDatabase,reversalNo,sourceKind,sourceId,bundle.header.document_no,bundle.header.document_type || bundle.header.movement_kind,bundle.header.document_date,reversalDate,reason,trim(body.replacement_note)||null,req.auth.id]);
        for (const item of bundle.items) await conn.query(`INSERT INTO erp_reversal_items
          (reversal_id,source_ledger_id,item_code,warehouse_code,location_code,lot_no,quantity_delta,unit_cost,amount_delta,note)
          VALUES(?,?,?,?,?,?,?,?,?,?)`, [header.insertId,item.id,item.item_code,item.warehouse_code,item.location_code||'',item.lot_no||'',item.quantity_delta,item.unit_cost,item.amount_delta,trim(body.replacement_note)||null]);
        return { id:header.insertId,reversal_no:reversalNo,status:'draft',source_document_no:bundle.header.document_no,line_count:bundle.items.length };
      });
      res.status(201).json({ok:true,data:result});
    } catch (error) { next(error); }
  });

  app.post('/api/reversals/:id/approve', async (req, res, next) => {
    try {
      await ensureTargetReversalSchema();
      const id = Number(req.params.id);
      const [result] = await pool.query("UPDATE erp_reversal_documents SET status='approved',approved_by=?,approved_at=NOW() WHERE id=? AND status='draft'", [req.auth.id,id]);
      if (!result.affectedRows) throw badRequest('只有沖回草稿可以核准');
      res.json({ok:true,data:{id,status:'approved'}});
    } catch (error) { next(error); }
  });

  app.post('/api/reversals/:id/post', async (req, res, next) => {
    try {
      await ensureTargetReversalSchema();
      await ensureTargetSalesWorkflowSchema();
      const id = Number(req.params.id);
      await tx(async conn => {
        const [[reversal]] = await conn.query("SELECT * FROM erp_reversal_documents WHERE id=? AND status='approved' FOR UPDATE", [id]);
        if (!reversal) throw badRequest('只有已核准沖回單可以過帳');
        const [items] = await conn.query('SELECT * FROM erp_reversal_items WHERE reversal_id=? ORDER BY id FOR UPDATE', [id]);
        if (!items.length) throw badRequest('沖回單沒有明細');
        for (const item of items) {
          const [[balance]] = await conn.query(`SELECT * FROM erp_inventory_balances WHERE tenant_id=? AND company_id=? AND source_system=? AND item_code=? AND warehouse_code=? AND location_code=? FOR UPDATE`, [reversal.tenant_id,reversal.company_id,reversal.source_system,item.item_code,item.warehouse_code,item.location_code||'']);
          const quantity = -Number(item.quantity_delta), amount = -Number(item.amount_delta);
          const newQuantity = Number(balance?.quantity_on_hand || 0) + quantity;
          const newAmount = Number(balance?.inventory_amount || 0) + amount;
          if (newQuantity < -0.000001) throw badRequest(`目前庫存不足以沖回 ${item.item_code}／${item.warehouse_code}，請先處理後續異動`);
          await conn.query(`INSERT INTO erp_inventory_balances(tenant_id,company_id,source_system,item_code,warehouse_code,location_code,quantity_on_hand,unit_cost,inventory_amount,last_movement_at)
            VALUES(?,?,?,?,?,?,?,?,?,NOW()) ON DUPLICATE KEY UPDATE quantity_on_hand=VALUES(quantity_on_hand),unit_cost=VALUES(unit_cost),inventory_amount=VALUES(inventory_amount),last_movement_at=NOW()`, [reversal.tenant_id,reversal.company_id,reversal.source_system,item.item_code,item.warehouse_code,item.location_code||'',newQuantity,newQuantity?newAmount/newQuantity:0,newAmount]);
          await conn.query(`INSERT INTO inventory_movement_ledger(tenant_id,company_id,source_system,document_id,document_no,document_type,movement_kind,movement_date,item_code,warehouse_code,location_code,lot_no,quantity_delta,unit_cost,amount_delta)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [reversal.tenant_id,reversal.company_id,reversal.source_system,reversal.id,reversal.reversal_no,'RV','reversal',reversal.reversal_date,item.item_code,item.warehouse_code,item.location_code||'',item.lot_no||'',quantity,item.unit_cost,amount]);
        }
        // A posted sales shipment may have fulfilled an order line.  The
        // reversal restores the order's delivered quantity, but the order
        // remains completed/closed until an explicit controlled reopen.
        if (reversal.source_kind === 'sales_document') {
          const [[sourceDocument]] = await conn.query("SELECT id,document_kind,source_database FROM sales_documents WHERE id=? FOR UPDATE", [reversal.source_document_id]);
          if (sourceDocument?.document_kind === 'shipment') {
            const [shipmentItems] = await conn.query('SELECT source_item_id,quantity FROM sales_document_items WHERE document_id=? AND source_item_id IS NOT NULL FOR UPDATE', [sourceDocument.id]);
            const orderIds = new Set();
            for (const shipmentItem of shipmentItems) {
              const [[orderItem]] = await conn.query('SELECT document_id FROM sales_document_items WHERE id=? FOR UPDATE', [shipmentItem.source_item_id]);
              if (!orderItem) continue;
              await conn.query('UPDATE sales_document_items SET related_quantity=GREATEST(related_quantity-?,0) WHERE id=?', [Number(shipmentItem.quantity), shipmentItem.source_item_id]);
              orderIds.add(Number(orderItem.document_id));
            }
            for (const orderId of orderIds) {
              await conn.query("UPDATE sales_documents SET note=TRIM(CONCAT(COALESCE(note,''),CASE WHEN COALESCE(note,'')='' THEN '' ELSE '；' END,'銷貨沖回完成，待受控解結／重開')) WHERE id=? AND document_kind='sales_order'", [orderId]);
            }
          }
        }
        await conn.query("UPDATE erp_reversal_documents SET status='posted',posted_by=?,posted_at=NOW() WHERE id=?", [req.auth.id,id]);
      });
      res.json({ok:true,data:{id,status:'posted'}});
    } catch (error) { next(error); }
  });

  app.post('/api/reversals/:id/rework', async (req, res, next) => {
    try {
      await ensureTargetReversalSchema();
      const id = Number(req.params.id);
      const body = req.body || {};
      if (!trim(body.replacement_kind) || !trim(body.replacement_document_no)) throw badRequest('請輸入重作單據類型與單號');
      const [result] = await pool.query(`UPDATE erp_reversal_documents SET replacement_kind=?,replacement_document_id=?,replacement_document_no=? WHERE id=? AND status='posted'`, [trim(body.replacement_kind),Number(body.replacement_document_id)||null,trim(body.replacement_document_no),id]);
      if (!result.affectedRows) throw badRequest('只有已過帳沖回單可以登錄重作單據');
      res.json({ok:true,data:{id,replacement_document_no:trim(body.replacement_document_no)}});
    } catch (error) { next(error); }
  });
}

function normalizedAccessSourceKeys(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => trim(value).toUpperCase()).filter(Boolean))];
}

function normalizedDepartmentCodes(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => trim(value).toUpperCase()).filter(value => /^[A-Z0-9_.-]{1,30}$/.test(value)))];
}

async function accessUserSnapshot(userId) {
  const [[user]] = await pool.query(`SELECT u.id,u.username,u.employee_code,u.display_name,u.role_id,u.is_active,
    r.role_code,r.role_name
    FROM access_users u JOIN access_roles r ON r.id=u.role_id WHERE u.id=?`, [Number(userId)]);
  if (!user) return null;
  const [companies] = await pool.query(`SELECT source_key,department_scope_mode
    FROM access_user_companies WHERE user_id=? ORDER BY source_key`, [Number(userId)]);
  const [departments] = await pool.query(`SELECT source_key,department_code
    FROM access_user_departments WHERE user_id=? ORDER BY source_key,department_code`, [Number(userId)]);
  return { user, companies, departments };
}

function compactAccessSnapshot(snapshot) {
  if (!snapshot) return null;
  return {
    user:snapshot.user,
    companies:snapshot.companies,
    departments:snapshot.departments
  };
}

async function accessDepartmentOptions(sourceKey) {
  const key = trim(sourceKey).toUpperCase();
  const source = sourceDatabases[key];
  if (!source) throw badRequest('指定的公司別不存在或未啟用');
  return runWithTargetDatabase(key, async () => {
    try {
      // erp_departments 是既有標準主檔，原結構沒有 is_active 欄位；
      // 部門範圍選項沿用現有主檔資料，不自行擴充或改寫客戶來源表。
      const [rows] = await pool.query(`SELECT department_code,department_name,note
        FROM erp_departments WHERE source_database=? ORDER BY department_code`, [key]);
      return rows;
    } catch (error) {
      if (error.code === 'ER_NO_SUCH_TABLE') return [];
      throw error;
    }
  });
}

function registerAccessControlRoutes(app) {
  app.get('/api/access-users', async (req, res, next) => {
    try {
      if (req.auth?.role_code !== 'ADMIN') throw Object.assign(new Error('僅系統管理員可管理帳號'), { status:403 });
      await ensureProcurementSchema();
      const [rows] = await pool.query(`SELECT u.id, u.username, u.employee_code, u.display_name, u.role_id, u.is_active,
        u.force_password_change, r.role_name, r.role_code,
        COALESCE((SELECT GROUP_CONCAT(auc.source_key ORDER BY auc.source_key SEPARATOR ',')
          FROM access_user_companies auc WHERE auc.user_id=u.id), '') AS allowed_sources
        ,COALESCE((SELECT GROUP_CONCAT(CONCAT(auc.source_key,':',auc.department_scope_mode) ORDER BY auc.source_key SEPARATOR ',')
          FROM access_user_companies auc WHERE auc.user_id=u.id), '') AS company_scope_modes
        ,COALESCE((SELECT GROUP_CONCAT(CONCAT(aud.source_key,':',aud.department_code) ORDER BY aud.source_key,aud.department_code SEPARATOR ',')
          FROM access_user_departments aud WHERE aud.user_id=u.id), '') AS department_scopes
        FROM access_users u JOIN access_roles r ON r.id=u.role_id ORDER BY u.username`);
      res.json({ ok:true, data:rows });
    } catch (error) { next(error); }
  });

  app.post('/api/access-users', async (req, res, next) => {
    try {
      if (req.auth?.role_code !== 'ADMIN') throw Object.assign(new Error('僅系統管理員可建立帳號'), { status:403 });
      await ensureProcurementSchema();
      const body = req.body || {}; const username = trim(body.username); const displayName = trim(body.display_name); const password = String(body.password || '');
      const roleId = Number(body.role_id);
      if (!/^[A-Za-z0-9_.-]{3,60}$/.test(username) || !displayName || password.length < 8 || !Number.isInteger(roleId)) throw badRequest('帳號、姓名、角色與至少 8 碼初始密碼為必填');
      const [[role]] = await pool.query('SELECT id,role_code FROM access_roles WHERE id=?', [roleId]); if (!role) throw badRequest('角色不存在');
      const sourceKeys = [...new Set((Array.isArray(body.source_keys) ? body.source_keys : []).map(x => trim(x).toUpperCase()).filter(Boolean))];
      if (role.role_code !== 'ADMIN' && !sourceKeys.length) throw badRequest('非管理員帳號至少要指定一個可進入的公司別');
      const result = await tx(async conn => {
        if (sourceKeys.length) {
          const [valid] = await conn.query('SELECT source_key FROM erp_data_sources WHERE enabled=1 AND source_key IN (?)', [sourceKeys]);
          if (valid.length !== sourceKeys.length) throw badRequest('指定的公司別不存在或未啟用');
        }
        const [created] = await conn.query(`INSERT INTO access_users
          (username, employee_code, display_name, password_hash, role_id, is_active, force_password_change)
          VALUES (?, ?, ?, ?, ?, 1, 1)`, [username, trim(body.employee_code) || null, displayName, hashPassword(password), roleId]);
        for (const sourceKey of sourceKeys) await conn.query('INSERT INTO access_user_companies(user_id,source_key) VALUES(?,?)', [created.insertId, sourceKey]);
        return created;
      });
      await recordAccessAudit({
        actorUserId:req.auth.id, targetUserId:result.insertId, actionCode:'USER_CREATED', entityType:'access_user', entityId:result.insertId,
        after:compactAccessSnapshot(await accessUserSnapshot(result.insertId)), reason:'建立登入帳號', ipAddress:req.ip, userAgent:req.get('user-agent')
      });
      res.status(201).json({ ok:true, data:{ id:result.insertId } });
    } catch (error) { if (error.code === 'ER_DUP_ENTRY') error = badRequest('帳號已存在'); next(error); }
  });

  app.put('/api/access-users/:id', async (req, res, next) => {
    try {
      if (req.auth?.role_code !== 'ADMIN') throw Object.assign(new Error('僅系統管理員可修改帳號'), { status:403 });
      const userId = Number(req.params.id); const body = req.body || {};
      const displayName = trim(body.display_name); const roleId = Number(body.role_id); const isActive = Number(Boolean(body.is_active));
      if (!Number.isInteger(userId) || userId < 1 || !displayName || !Number.isInteger(roleId)) throw badRequest('帳號資料不完整');
      const [[role]] = await pool.query('SELECT id,role_code FROM access_roles WHERE id=?', [roleId]);
      const [[target]] = await pool.query('SELECT id FROM access_users WHERE id=?', [userId]);
      if (!role || !target) throw badRequest('帳號或角色不存在');
      if (userId === Number(req.auth.id) && (!isActive || role.role_code !== 'ADMIN')) throw badRequest('不可停用自己的帳號或移除自己的系統管理員角色');
      const sourceKeys = [...new Set((Array.isArray(body.source_keys) ? body.source_keys : []).map(x => trim(x).toUpperCase()).filter(Boolean))];
      if (role.role_code !== 'ADMIN' && !sourceKeys.length) throw badRequest('非管理員帳號至少要指定一個可進入的公司別');
      const before = await accessUserSnapshot(userId);
      await tx(async conn => {
        if (sourceKeys.length) {
          const [valid] = await conn.query('SELECT source_key FROM erp_data_sources WHERE enabled=1 AND source_key IN (?)', [sourceKeys]);
          if (valid.length !== sourceKeys.length) throw badRequest('指定的公司別不存在或未啟用');
        }
        await conn.query('UPDATE access_users SET employee_code=?,display_name=?,role_id=?,is_active=? WHERE id=?', [trim(body.employee_code) || null, displayName, roleId, isActive, userId]);
        await conn.query('DELETE FROM access_user_companies WHERE user_id=?', [userId]);
        for (const sourceKey of sourceKeys) await conn.query('INSERT INTO access_user_companies(user_id,source_key) VALUES(?,?)', [userId, sourceKey]);
        if (sourceKeys.length) {
          await conn.query('DELETE FROM access_user_departments WHERE user_id=? AND source_key NOT IN (?)', [userId, sourceKeys]);
        } else {
          await conn.query('DELETE FROM access_user_departments WHERE user_id=?', [userId]);
        }
      });
      if (!isActive) await pool.query('DELETE FROM access_sessions WHERE user_id=?', [userId]);
      await recordAccessAudit({
        actorUserId:req.auth.id, targetUserId:userId, actionCode:'USER_ACCESS_UPDATED', entityType:'access_user', entityId:userId,
        before:compactAccessSnapshot(before), after:compactAccessSnapshot(await accessUserSnapshot(userId)), reason:'修改帳號角色、啟用狀態或公司範圍', ipAddress:req.ip, userAgent:req.get('user-agent')
      });
      res.json({ ok:true, data:{ id:userId } });
    } catch (error) { next(error); }
  });

  // 後台使用者可查詢所有公司已設定的部門範圍；不接受前端傳入的公司上下文，
  // 避免管理畫面因目前工作階段公司而漏掉另一家公司的權限設定。
  app.get('/api/access-departments', async (req, res, next) => {
    try {
      if (req.auth?.role_code !== 'ADMIN') throw Object.assign(new Error('僅系統管理員可查詢部門範圍'), { status:403 });
      await ensureProcurementSchema();
      const userId = req.query.user_id ? Number(req.query.user_id) : null;
      if (userId != null && (!Number.isInteger(userId) || userId < 1)) throw badRequest('帳號代號不正確');
      const params = userId == null ? [] : [userId, userId];
      const [rows] = await pool.query(`SELECT auc.user_id,auc.source_key,auc.department_scope_mode,
        COALESCE(GROUP_CONCAT(aud.department_code ORDER BY aud.department_code SEPARATOR ','),'') AS department_codes
        FROM access_user_companies auc
        LEFT JOIN access_user_departments aud
          ON aud.user_id=auc.user_id AND aud.source_key=auc.source_key
        WHERE (? IS NULL OR auc.user_id=?)
        GROUP BY auc.user_id,auc.source_key,auc.department_scope_mode
        ORDER BY auc.user_id,auc.source_key`, params.length ? params : [null, null]);
      res.json({ ok:true, data:rows.map(row => ({
        ...row, user_id:Number(row.user_id),
        department_codes:String(row.department_codes || '').split(',').filter(Boolean)
      })) });
    } catch (error) { next(error); }
  });

  app.get('/api/access-departments/options', async (req, res, next) => {
    try {
      if (req.auth?.role_code !== 'ADMIN') throw Object.assign(new Error('僅系統管理員可查詢部門選項'), { status:403 });
      await ensureProcurementSchema();
      const sourceKey = trim(req.query.source_key).toUpperCase();
      const rows = await accessDepartmentOptions(sourceKey);
      res.json({ ok:true, data:rows });
    } catch (error) { next(error); }
  });

  app.put('/api/access-departments/:userId', async (req, res, next) => {
    try {
      if (req.auth?.role_code !== 'ADMIN') throw Object.assign(new Error('僅系統管理員可修改部門範圍'), { status:403 });
      await ensureProcurementSchema();
      const userId = Number(req.params.userId);
      const sourceKey = trim(req.body?.source_key).toUpperCase();
      const mode = trim(req.body?.mode || 'all').toLowerCase();
      const rawCodes = Array.isArray(req.body?.department_codes) ? req.body.department_codes.map(value => trim(value).toUpperCase()).filter(Boolean) : [];
      const departmentCodes = normalizedDepartmentCodes(rawCodes);
      if (!Number.isInteger(userId) || userId < 1 || !sourceKey || !['all','selected'].includes(mode)) throw badRequest('帳號、公司別與部門範圍設定不完整');
      if (rawCodes.some(code => !/^[A-Z0-9_.-]{1,30}$/.test(code))) throw badRequest('部門代號只能使用英文字母、數字、底線、連字號或句點');
      if (mode === 'selected' && !departmentCodes.length) throw badRequest('指定部門模式至少要選擇一個部門');
      const [[target]] = await pool.query('SELECT id,role_id FROM access_users WHERE id=?', [userId]);
      if (!target || !sourceDatabases[sourceKey]) throw badRequest('帳號或公司別不存在');
      const [[companyAccess]] = await pool.query('SELECT user_id FROM access_user_companies WHERE user_id=? AND source_key=?', [userId, sourceKey]);
      if (!companyAccess) throw badRequest('請先在帳號資料設定此使用者可進入的公司別');
      const available = await accessDepartmentOptions(sourceKey);
      const availableCodes = new Set(available.map(row => trim(row.department_code).toUpperCase()));
      if (mode === 'selected' && availableCodes.size && departmentCodes.some(code => !availableCodes.has(code))) {
        throw badRequest('指定的部門不在目前公司部門主檔中，請重新整理選項');
      }
      const before = await accessUserSnapshot(userId);
      await tx(async conn => {
        await conn.query('UPDATE access_user_companies SET department_scope_mode=? WHERE user_id=? AND source_key=?', [mode, userId, sourceKey]);
        await conn.query('DELETE FROM access_user_departments WHERE user_id=? AND source_key=?', [userId, sourceKey]);
        if (mode === 'selected') {
          for (const departmentCode of departmentCodes) {
            await conn.query(`INSERT INTO access_user_departments(user_id,source_key,department_code,created_by,updated_by)
              VALUES(?,?,?,?,?)`, [userId, sourceKey, departmentCode, req.auth.id, req.auth.id]);
          }
        }
      });
      const after = await accessUserSnapshot(userId);
      await recordAccessAudit({
        actorUserId:req.auth.id, targetUserId:userId, actionCode:'DEPARTMENT_SCOPE_UPDATED', entityType:'user_department_scope',
        entityId:`${userId}:${sourceKey}`, sourceKey, before:compactAccessSnapshot(before), after:compactAccessSnapshot(after),
        reason:trim(req.body?.reason) || `設定${sourceKey}部門範圍：${mode === 'all' ? '全部部門' : departmentCodes.join('、')}`,
        ipAddress:req.ip, userAgent:req.get('user-agent')
      });
      res.json({ ok:true, data:{ user_id:userId, source_key:sourceKey, mode, department_codes:departmentCodes } });
    } catch (error) { next(error); }
  });

  app.get('/api/access-audit', async (req, res, next) => {
    try {
      if (req.auth?.role_code !== 'ADMIN') throw Object.assign(new Error('僅系統管理員可查詢權限異動歷程'), { status:403 });
      await ensureProcurementSchema();
      const conditions = [];
      const params = [];
      const userId = req.query.target_user_id ? Number(req.query.target_user_id) : null;
      const sourceKey = trim(req.query.source_key).toUpperCase();
      const actionCode = trim(req.query.action_code);
      if (userId != null) { if (!Number.isInteger(userId) || userId < 1) throw badRequest('目標帳號代號不正確'); conditions.push('a.target_user_id=?'); params.push(userId); }
      if (sourceKey) { conditions.push('a.source_key=?'); params.push(sourceKey); }
      if (actionCode) { conditions.push('a.action_code=?'); params.push(actionCode); }
      if (req.query.from_date) { conditions.push('a.created_at>=?'); params.push(`${validDate(req.query.from_date)} 00:00:00`); }
      if (req.query.to_date) { conditions.push('a.created_at<?'); const date = new Date(`${validDate(req.query.to_date)}T00:00:00Z`); date.setUTCDate(date.getUTCDate()+1); params.push(`${date.toISOString().slice(0,10)} 00:00:00`); }
      const limit = Math.min(Math.max(Number(req.query.limit || 200), 1), 500);
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const [rows] = await pool.query(`SELECT a.id,a.actor_user_id,a.target_user_id,a.action_code,a.entity_type,a.entity_id,
        a.source_key,a.department_code,a.before_json,a.after_json,a.reason,a.ip_address,a.user_agent,a.created_at,
        actor.username actor_username,actor.display_name actor_display_name,
        target.username target_username,target.display_name target_display_name
        FROM access_audit_log a
        LEFT JOIN access_users actor ON actor.id=a.actor_user_id
        LEFT JOIN access_users target ON target.id=a.target_user_id
        ${where} ORDER BY a.id DESC LIMIT ${limit}`, params);
      res.json({ ok:true, data:rows });
    } catch (error) { next(error); }
  });

  app.get('/api/access-roles', async (_req, res, next) => {
    try {
      if (_req.auth?.role_code !== 'ADMIN') throw Object.assign(new Error('僅系統管理員可管理系統權限'), { status:403 });
      await ensureProcurementSchema();
      const [roles] = await pool.query('SELECT id, role_code, role_name, description, is_system FROM access_roles ORDER BY role_code');
      const [permissions] = await pool.query(`SELECT role_id, feature_code, can_view, can_create, can_update, can_delete, can_approve
        FROM access_role_permissions ORDER BY role_id, feature_code`);
      res.json({ ok: true, data: { roles, permissions } });
    } catch (error) { next(error); }
  });

  app.post('/api/access-roles', async (req, res, next) => {
    try {
      if (req.auth?.role_code !== 'ADMIN') throw Object.assign(new Error('僅系統管理員可建立角色'), { status:403 });
      const roleCode = trim(req.body?.role_code).toUpperCase(); const roleName = trim(req.body?.role_name); const description = trim(req.body?.description);
      if (!/^[A-Z0-9_-]{2,30}$/.test(roleCode) || !roleName) throw badRequest('角色代號與角色名稱不可空白');
      const [result] = await pool.query('INSERT INTO access_roles(role_code,role_name,description,is_system) VALUES(?,?,?,0)', [roleCode, roleName, description || null]);
      await recordAccessAudit({
        actorUserId:req.auth.id, actionCode:'ROLE_CREATED', entityType:'access_role', entityId:result.insertId,
        after:{id:result.insertId,role_code:roleCode,role_name:roleName,description:description||null}, reason:'建立角色',
        ipAddress:req.ip, userAgent:req.get('user-agent')
      });
      res.status(201).json({ ok:true, data:{ id:result.insertId } });
    } catch (error) { if (error.code === 'ER_DUP_ENTRY') error = badRequest('角色代號已存在'); next(error); }
  });

  app.put('/api/access-roles/:id/permissions', async (req, res, next) => {
    try {
      if (req.auth?.role_code !== 'ADMIN') throw Object.assign(new Error('僅系統管理員可修改系統權限'), { status:403 });
      await ensureProcurementSchema();
      const roleId = Number(req.params.id);
      const rows = Array.isArray(req.body?.permissions) ? req.body.permissions : null;
      if (!Number.isInteger(roleId) || roleId < 1 || !rows) throw badRequest('Invalid role permission payload');
      const [[roleInfo]] = await pool.query('SELECT id,role_code,role_name FROM access_roles WHERE id=?', [roleId]);
      if (!roleInfo) throw notFound('Role not found');
      const [beforePermissions] = await pool.query(`SELECT feature_code,can_view,can_create,can_update,can_delete,can_approve
        FROM access_role_permissions WHERE role_id=? ORDER BY feature_code`, [roleId]);
      await tx(async (conn) => {
        const [[role]] = await conn.query('SELECT id FROM access_roles WHERE id=? FOR UPDATE', [roleId]);
        if (!role) throw notFound('Role not found');
        await conn.query('DELETE FROM access_role_permissions WHERE role_id=?', [roleId]);
        for (const row of rows) {
          const featureCode = trim(row.feature_code);
          if (!/^[a-z0-9-]{2,80}$/i.test(featureCode)) throw badRequest('Invalid feature code');
          await conn.query(`INSERT INTO access_role_permissions
            (role_id, feature_code, can_view, can_create, can_update, can_delete, can_approve)
            VALUES (?, ?, ?, ?, ?, ?, ?)`, [
            roleId, featureCode, Number(Boolean(row.can_view)), Number(Boolean(row.can_create)),
            Number(Boolean(row.can_update)), Number(Boolean(row.can_delete)), Number(Boolean(row.can_approve))
          ]);
        }
      });
      await recordAccessAudit({
        actorUserId:req.auth.id, actionCode:'ROLE_PERMISSIONS_UPDATED', entityType:'access_role_permissions', entityId:roleId,
        before:{role:roleInfo,permissions:beforePermissions}, after:{role:roleInfo,permissions:rows.map(row => ({
          feature_code:trim(row.feature_code),can_view:Number(Boolean(row.can_view)),can_create:Number(Boolean(row.can_create)),
          can_update:Number(Boolean(row.can_update)),can_delete:Number(Boolean(row.can_delete)),can_approve:Number(Boolean(row.can_approve))
        }))}, reason:'修改角色作業權限', ipAddress:req.ip, userAgent:req.get('user-agent')
      });
      res.json({ ok: true, data: { roleId } });
    } catch (error) { next(error); }
  });
}

function trim(value) { return String(value ?? '').trim(); }
function nullableDate(value) { return value ? validDate(value) : null; }
function validDate(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw badRequest('請輸入有效日期');
  return text;
}
function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw badRequest(`${label}必須大於 0`);
  return number;
}
