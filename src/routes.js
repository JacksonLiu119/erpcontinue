import { pool, getSourcePool, sourceDatabases, reloadSourceDatabases, tx, ensureProcurementSchema } from './db.js';
import { hashPassword } from './auth.js';

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

export function registerApi(app) {
  // 公司別與來源資料庫必須成對驗證。來源資料庫本身仍維持唯讀，
  // 所有新 ERP 查詢／寫入都只能使用目前來源所對應的 company_id。
  app.use((req, res, next) => {
    const sourceName = String(
      req.query.source_database || req.query.db || req.body?.source_database || req.headers['x-source-database'] || ''
    ).trim().toUpperCase();
    const requestedCompanyId = String(
      req.query.company_id || req.body?.company_id || req.headers['x-company-id'] || ''
    ).trim();
    const source = sourceName ? sourceDatabases[sourceName] : null;
    if (source && requestedCompanyId && requestedCompanyId !== String(source.company_id || sourceName)) {
      return res.status(409).json({ ok:false, error:'公司別與資料庫來源不一致，為避免資料混用已拒絕此請求。' });
    }
    next();
  });
  app.use('/api/sh', (req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      return res.status(410).json({ ok:false, error:'客戶來源資料庫已設定為唯讀，請使用新 ERP 主檔作業。' });
    }
    next();
  });
  registerCanonicalMasterRoutes(app);
  registerInventoryOpeningRoutes(app);
  app.get('/api/company-contexts', async (_req, res, next) => {
    try {
      await ensureProcurementSchema();
      const [rows] = await pool.query(`
        SELECT s.source_key AS context_key, s.source_key AS source_database,
          s.tenant_id, s.company_id, s.source_system, s.database_name,
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
        ORDER BY s.sort_order, s.source_key`);
      res.json({ ok:true, data:rows });
    } catch (error) { next(error); }
  });
  app.get('/api/source-databases', async (_req, res, next) => {
    try {
      const [rows] = await pool.query('SELECT SCHEMA_NAME AS schema_name FROM information_schema.SCHEMATA');
      const existing = new Set(rows.map(row => String(row.schema_name).toLowerCase()));
      const data = await Promise.all(Object.entries(sourceDatabases).map(async ([key, source]) => {
        const exists = existing.has(source.database.toLowerCase());
        let tableCount = 0;
        if (exists) {
          const [[count]] = await pool.query('SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [source.database]);
          tableCount = Number(count.count);
        }
        return { key, label: source.label, database: source.database, tenant_id: source.tenant_id, company_id: source.company_id, source_system: source.source_system, exists, tableCount };
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
      await pool.query(`INSERT INTO erp_data_sources
        (source_key, label, adapter_code, host, port, database_name, username, password_env, tenant_id, company_id, source_system, enabled, read_only, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        sourceKey, label, adapterCode, String(body.host || '127.0.0.1'), Number(body.port || 3306),
        databaseName, String(body.username || 'root'), String(body.password_env || '') || null,
        String(body.tenant_id || sourceKey).trim(), String(body.company_id || sourceKey).trim(), String(body.source_system || 'iSM').trim(),
        body.enabled === false ? 0 : 1, body.read_only === false ? 0 : 1, Number(body.sort_order || 100)
      ]);
      await reloadSourceDatabases();
      res.status(201).json({ ok:true, data:{ source_key:sourceKey } });
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
      await pool.query(`UPDATE erp_data_sources SET label=?, adapter_code=?, host=?, port=?, database_name=?,
        username=?, password_env=?, tenant_id=?, company_id=?, source_system=?, enabled=?, read_only=?, sort_order=? WHERE source_key=?`, [
        label, adapterCode, String(body.host || '127.0.0.1'), Number(body.port || 3306), databaseName,
        String(body.username || 'root'), String(body.password_env || '') || null,
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
  registerProcurementWorkflowRoutes(app);
  registerSalesWorkflowRoutes(app);
  registerFinanceWorkflowRoutes(app);
  registerInventoryWorkflowRoutes(app);
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

function notFound(message) {
  const error = new Error(message);
  error.status = 404;
  return error;
}

function sourceDbFromRequest(req) {
  const requested = String(req.query.db || req.headers['x-source-database'] || 'SH').toUpperCase();
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
    fields: ['item_code', 'item_name', 'specification', 'unit', 'category_1', 'category_2', 'category_3'],
    select: 'item_code, item_name, specification, unit, category_1, category_2, category_3',
    sourceSelect: 'MB001 AS item_code, MB002 AS item_name, MB003 AS specification, MB004 AS unit, MB005 AS category_1, MB006 AS category_2, MB007 AS category_3', trackImport: true
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
  const datePart = String(date).replaceAll('-', '');
  const like = `${prefix}-${datePart}-%`;
  const [[row]] = await conn.query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} LIKE ?`, [like]);
  return `${prefix}-${datePart}-${String(Number(row.count) + 1).padStart(4, '0')}`;
}

function registerProcurementWorkflowRoutes(app) {
  const contextFor = sourceDatabase => {
    const source = sourceDatabases[sourceDatabase] || {};
    return { tenant_id:source.tenant_id || sourceDatabase, company_id:source.company_id || sourceDatabase, source_system:source.source_system || 'iSM' };
  };
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
      const sourceDatabase = String(req.query.source_database || 'SH').toUpperCase();
      const [rows] = await pool.query(`
        SELECT i.id, o.purchase_order_no, o.order_date, o.supplier_code, o.currency_code,
               i.line_no, i.item_code, i.item_name, i.specification, i.warehouse_code, i.unit,
               i.qty_ordered, i.qty_received, (i.qty_ordered - i.qty_received) AS remaining_quantity,
               i.unit_price, i.expected_date, i.note
        FROM procurement_order_items i
        JOIN procurement_orders o ON o.id = i.purchase_order_id
        WHERE o.source_database = ? AND o.status NOT IN ('cancelled', 'closed') AND i.qty_ordered > i.qty_received
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
        const documentNo = String(body.requisition_no || '').trim() || await nextWorkflowNumber(conn, 'procurement_requisitions', 'requisition_no', documentType.number_prefix, date);
        const [header] = await conn.query(`INSERT INTO procurement_requisitions
          (tenant_id, company_id, source_system, document_type, requisition_no, requisition_date, requester_code, department_code, warehouse_code, status, note, source_database)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`, [context.tenant_id, context.company_id, context.source_system, trim(body.document_type) || 'RQ', documentNo, date, trim(body.requester_code), trim(body.department_code), trim(body.warehouse_code), trim(body.note), sourceDatabase]);
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
        if (sourceLineId) {
          const [[row]] = await conn.query(`SELECT i.*, r.id AS header_id FROM procurement_requisition_items i JOIN procurement_requisitions r ON r.id=i.requisition_id WHERE i.id=? AND r.source_database=? FOR UPDATE`, [sourceLineId, sourceDatabase]);
          if (!row) throw notFound('請購來源明細不存在');
          if (Number(row.qty_requested) - Number(row.qty_ordered) < quantity) throw badRequest('採購數量不可超過請購未轉量');
          sourceLine = row;
        }
        const documentNo = trim(body.purchase_order_no) || await nextWorkflowNumber(conn, 'procurement_orders', 'purchase_order_no', documentType.number_prefix, date);
        const [header] = await conn.query(`INSERT INTO procurement_orders
          (tenant_id, company_id, source_system, document_type, purchase_order_no, supplier_code, order_date, expected_date, currency_code, status, note, source_database)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`, [context.tenant_id, context.company_id, context.source_system, trim(body.document_type) || 'PO', documentNo, supplierCode, date, nullableDate(body.expected_date), trim(body.currency_code) || 'TWD', trim(body.note), sourceDatabase]);
        await conn.query(`INSERT INTO procurement_order_items
          (purchase_order_id, requisition_item_id, line_no, item_code, item_name, specification, warehouse_code, unit, qty_ordered, unit_price, expected_date, note)
          VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [header.insertId, sourceLineId, itemCode, trim(body.item_name) || sourceLine?.item_name || '', trim(body.specification) || sourceLine?.specification || '', trim(body.warehouse_code) || sourceLine?.warehouse_code || '', trim(body.unit) || sourceLine?.unit || 'PCS', quantity, Number(body.unit_price || 0), nullableDate(body.expected_date) || sourceLine?.required_date || null, trim(body.item_note)]);
        if (sourceLine) {
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
      const body = req.body || {};
      const sourceDatabase = String(body.source_database || 'SH').toUpperCase();
      const date = validDate(body.receipt_date);
      const sourceLineId = Number(body.purchase_order_item_id || 0) || null;
      const itemCode = trim(body.item_code);
      const quantity = positiveNumber(body.qty_received, '進貨數量');
      const accepted = Number(body.qty_accepted ?? quantity);
      if (accepted < 0 || accepted > quantity) throw badRequest('驗收數量必須介於 0 與進貨數量之間');
      const context = contextFor(sourceDatabase); const typeCode = trim(body.document_type);
      const [[documentType]] = await pool.query(`SELECT * FROM procurement_document_types WHERE tenant_id=? AND company_id=? AND source_system=? AND document_kind='receipt' AND type_code=? AND is_active=1`,[context.tenant_id,context.company_id,context.source_system,typeCode]);
      if (!documentType) throw badRequest('請選擇有效的進貨單別');
      const result = await tx(async (conn) => {
        let sourceLine = null;
        if (sourceLineId) {
          const [[row]] = await conn.query(`SELECT i.*, o.id AS header_id, o.supplier_code FROM procurement_order_items i JOIN procurement_orders o ON o.id=i.purchase_order_id WHERE i.id=? AND o.source_database=? FOR UPDATE`, [sourceLineId, sourceDatabase]);
          if (!row) throw notFound('採購來源明細不存在');
          if (Number(row.qty_ordered) - Number(row.qty_received) < quantity) throw badRequest('進貨數量不可超過採購未交量');
          sourceLine = row;
        }
        const supplierCode = trim(body.supplier_code) || sourceLine?.supplier_code || '';
        if (!supplierCode || !itemCode) throw badRequest('供應廠商與品號不可空白');
        const documentNo = trim(body.receipt_no) || await nextWorkflowNumber(conn, 'procurement_receipts', 'receipt_no', documentType.number_prefix, date);
        const [header] = await conn.query(`INSERT INTO procurement_receipts
          (tenant_id, company_id, source_system, document_type, receipt_no, supplier_code, receipt_date, warehouse_code, status, note, source_database)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_inspection', ?, ?)`, [context.tenant_id, context.company_id, context.source_system, trim(body.document_type) || 'GR', documentNo, supplierCode, date, trim(body.warehouse_code) || sourceLine?.warehouse_code || '', trim(body.note), sourceDatabase]);
        await conn.query(`INSERT INTO procurement_receipt_items
          (receipt_id, purchase_order_item_id, line_no, item_code, item_name, specification, warehouse_code, unit, qty_received, qty_accepted, unit_cost, lot_no, note)
          VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`, [header.insertId, sourceLineId, itemCode, trim(body.item_name) || sourceLine?.item_name || '', trim(body.specification) || sourceLine?.specification || '', trim(body.warehouse_code) || sourceLine?.warehouse_code || '', trim(body.unit) || sourceLine?.unit || 'PCS', quantity, Number(body.unit_cost || sourceLine?.unit_price || 0), trim(body.lot_no), trim(body.item_note)]);
        // 採購已進貨量須等驗收完成後才更新，避免待驗或驗退數量被算入正式進貨。
        return { id: header.insertId, documentNo };
      });
      res.status(201).json({ ok: true, ...result });
    } catch (error) { next(error); }
  });

  app.get('/api/procurement/documents/:kind', async (req, res, next) => {
    try {
      await ensureProcurementSchema();
      const sourceDatabase = String(req.query.source_database || 'SH').toUpperCase();
      const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
      let sql = '';
      if (req.params.kind === 'requisitions') sql = `SELECT r.id, r.requisition_no AS document_no, r.requisition_date AS document_date, r.requester_code, r.department_code, r.warehouse_code, r.status, r.note, i.item_code, i.item_name, i.specification, i.unit, i.qty_requested AS quantity, i.qty_ordered AS related_quantity, i.required_date, i.note AS item_note FROM procurement_requisitions r JOIN procurement_requisition_items i ON i.requisition_id=r.id WHERE r.source_database=? ORDER BY r.requisition_date DESC, r.id DESC LIMIT ?`;
      else if (req.params.kind === 'orders') sql = `SELECT o.id, o.purchase_order_no AS document_no, o.order_date AS document_date, o.supplier_code, o.currency_code, o.status, o.note, i.requisition_item_id AS source_line_id, i.item_code, i.item_name, i.specification, i.warehouse_code, i.unit, i.qty_ordered AS quantity, i.qty_received AS related_quantity, i.unit_price, i.expected_date, i.note AS item_note FROM procurement_orders o JOIN procurement_order_items i ON i.purchase_order_id=o.id WHERE o.source_database=? ORDER BY o.order_date DESC, o.id DESC LIMIT ?`;
      else if (req.params.kind === 'receipts') sql = `SELECT r.id, r.receipt_no AS document_no, r.receipt_date AS document_date, r.supplier_code, r.warehouse_code, r.status, r.note, i.purchase_order_item_id AS source_line_id, i.item_code, i.item_name, i.specification, i.unit, i.qty_received AS quantity, i.qty_accepted, i.unit_cost, i.lot_no, i.note AS item_note FROM procurement_receipts r JOIN procurement_receipt_items i ON i.receipt_id=r.id WHERE r.source_database=? ORDER BY r.receipt_date DESC, r.id DESC LIMIT ?`;
      else throw badRequest(`未知的採購單據類型：${req.params.kind}`);
      const [rows] = await pool.query(sql, [sourceDatabase, limit]);
      res.json({ ok: true, data: rows });
    } catch (error) { next(error); }
  });

  app.post('/api/procurement/documents/:kind/:id/approve', async (req, res, next) => {
    try {
      await ensureProcurementSchema();
      const kind = req.params.kind; const id = Number(req.params.id);
      const table = { requisitions:'procurement_requisitions', orders:'procurement_orders', receipts:'procurement_receipts' }[kind];
      if (!table || !Number.isInteger(id) || id < 1) throw badRequest('Invalid document for approval');
      const [[document]] = await pool.query(`SELECT id FROM ${table} WHERE id=?`, [id]);
      if (!document) throw notFound('Document not found');
      await pool.query(`INSERT INTO procurement_document_approvals
        (document_kind, document_id, approval_status, approved_by, note)
        VALUES (?, ?, 'approved', ?, ?)
        ON DUPLICATE KEY UPDATE approval_status='approved', approved_by=VALUES(approved_by), approved_at=NOW(), note=VALUES(note)`, [kind, id, req.auth.id, trim(req.body?.note)]);
      if (kind === 'requisitions') await pool.query("UPDATE procurement_requisitions SET status='approved' WHERE id=?", [id]);
      if (kind === 'orders') await pool.query("UPDATE procurement_orders SET status='confirmed' WHERE id=?", [id]);
      res.json({ ok:true, data:{ id, kind, approval_status:'approved' } });
    } catch (error) { next(error); }
  });

  app.put('/api/procurement/documents/:kind/:id', async (req, res, next) => {
    try {
      await ensureProcurementSchema();
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
          const [[row]] = await conn.query('SELECT i.id AS item_id, i.requisition_item_id, i.qty_ordered, i.qty_received FROM procurement_orders o JOIN procurement_order_items i ON i.purchase_order_id=o.id WHERE o.id=? AND o.source_database=? FOR UPDATE', [id, sourceDatabase]);
          if (!row) throw notFound('採購單不存在');
          const quantity = positiveNumber(body.qty_ordered, '採購數量');
          if (quantity < Number(row.qty_received)) throw badRequest('採購數量不可小於已進貨量');
          if (row.requisition_item_id && quantity !== Number(row.qty_ordered)) throw badRequest('已參考請購單的採購數量不可直接修改，請另開採購單或修改請購來源');
          await conn.query('UPDATE procurement_orders SET supplier_code=?, order_date=?, expected_date=?, currency_code=?, note=? WHERE id=?', [trim(body.supplier_code), validDate(body.order_date), nullableDate(body.expected_date), trim(body.currency_code) || 'TWD', trim(body.note), id]);
          await conn.query('UPDATE procurement_order_items SET item_code=?, item_name=?, specification=?, warehouse_code=?, unit=?, qty_ordered=?, unit_price=?, expected_date=?, note=? WHERE id=?', [trim(body.item_code), trim(body.item_name), trim(body.specification), trim(body.warehouse_code), trim(body.unit) || 'PCS', quantity, Number(body.unit_price || 0), nullableDate(body.expected_date), trim(body.item_note), row.item_id]);
        } else if (kind === 'receipts') {
          const [[row]] = await conn.query('SELECT i.id AS item_id, i.purchase_order_item_id, i.qty_received FROM procurement_receipts r JOIN procurement_receipt_items i ON i.receipt_id=r.id WHERE r.id=? AND r.source_database=? FOR UPDATE', [id, sourceDatabase]);
          if (!row) throw notFound('進貨單不存在');
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
      const sourceDatabase = String(req.query.source_database || 'SH').toUpperCase();
      const context = contextFor(sourceDatabase);
      const defaultTypes = [
        ['requisition','RQ','一般請購','RQ'],['purchase_order','PO','一般採購','PO'],
        ['receipt','GR','一般進貨','GR'],['purchase_return','PR','採購退貨／折讓','PR']
      ];
      for (const row of defaultTypes) {
        await pool.query(`INSERT IGNORE INTO procurement_document_types
          (tenant_id,company_id,source_system,document_kind,type_code,type_name,number_prefix,requires_approval,allow_overage,is_active)
          VALUES(?,?,?,?,?,?,?,1,0,1)`, [context.tenant_id,context.company_id,context.source_system,...row]);
      }
      const sourcePool = getSourcePool(sourceDatabase);
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
      const [rows] = await pool.query(`SELECT id, document_kind, type_code, type_name, number_prefix,
        requires_approval, allow_overage, is_active, note FROM procurement_document_types
        WHERE tenant_id=? AND company_id=? AND source_system=? ORDER BY document_kind, type_code`, [context.tenant_id, context.company_id, context.source_system]);
      res.json({ ok:true, data:rows });
    } catch (error) { next(error); }
  });

  app.post('/api/procurement/document-types', async (req, res, next) => {
    try {
      await ensureProcurementSchema();
      const body = req.body || {}; const sourceDatabase = String(body.source_database || 'SH').toUpperCase();
      const context = contextFor(sourceDatabase); const kind = trim(body.document_kind); const code = trim(body.type_code);
      if (!['requisition','purchase_order','receipt','purchase_return'].includes(kind) || !code || !trim(body.type_name)) throw badRequest('請輸入正確的單據類別、單別與名稱');
      await pool.query(`INSERT INTO procurement_document_types
        (tenant_id, company_id, source_system, document_kind, type_code, type_name, number_prefix, requires_approval, allow_overage, is_active, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [context.tenant_id, context.company_id, context.source_system, kind, code, trim(body.type_name), trim(body.number_prefix) || code, Number(body.requires_approval ?? 1), Number(body.allow_overage || 0), Number(body.is_active ?? 1), trim(body.note)]);
      res.status(201).json({ ok:true, data:{ type_code:code } });
    } catch (error) { if (error.code === 'ER_DUP_ENTRY') error = badRequest('此單據性質已存在'); next(error); }
  });

  app.put('/api/procurement/document-types/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id); const body = req.body || {};
      const [result] = await pool.query(`UPDATE procurement_document_types SET type_name=?, number_prefix=?, requires_approval=?, allow_overage=?, is_active=?, note=? WHERE id=?`,
        [trim(body.type_name), trim(body.number_prefix), Number(body.requires_approval ?? 1), Number(body.allow_overage || 0), Number(body.is_active ?? 1), trim(body.note), id]);
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
        const documentNo = trim(body.purchase_order_no) || await nextWorkflowNumber(conn, 'procurement_orders', 'purchase_order_no', 'PO', date);
        const [header] = await conn.query(`INSERT INTO procurement_orders
          (tenant_id,company_id,source_system,document_type,purchase_order_no,supplier_code,order_date,expected_date,currency_code,status,note,source_database)
          VALUES (?,?,?,?,?,?,?,?,?,'draft',?,?)`, [context.tenant_id,context.company_id,context.source_system,trim(body.document_type)||'PO',documentNo,supplierCode,date,nullableDate(body.expected_date)||row.required_date,trim(body.currency_code)||'TWD',trim(body.note),sourceDatabase]);
        await conn.query(`INSERT INTO procurement_order_items
          (purchase_order_id,requisition_item_id,line_no,item_code,item_name,specification,warehouse_code,unit,qty_ordered,unit_price,expected_date,note)
          VALUES (?,?,1,?,?,?,?,?,?,?,?,?)`, [header.insertId,lineId,row.item_code,row.item_name,row.specification,row.warehouse_code,row.unit,quantity,Number(body.unit_price ?? row.suggested_unit_price ?? 0),nullableDate(body.expected_date)||row.required_date,trim(body.item_note)||row.note]);
        await conn.query('UPDATE procurement_requisition_items SET qty_ordered=qty_ordered+? WHERE id=?',[quantity,lineId]);
        const [[remaining]] = await conn.query('SELECT COUNT(*) count FROM procurement_requisition_items WHERE requisition_id=? AND qty_requested>qty_ordered',[row.header_id]);
        await conn.query('UPDATE procurement_requisitions SET status=? WHERE id=?',[Number(remaining.count)?'approved':'converted',row.header_id]);
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
      const id=Number(req.params.id); const body=req.body||{};
      await tx(async conn=>{
        const [[row]]=await conn.query(`SELECT r.id receipt_id,r.status,i.id item_id,i.purchase_order_item_id,i.qty_received,i.qty_accepted
          FROM procurement_receipts r JOIN procurement_receipt_items i ON i.receipt_id=r.id WHERE r.id=? FOR UPDATE`,[id]);
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

  app.get('/api/procurement/returnable-receipts',async(req,res,next)=>{
    try{
      const sourceDatabase=String(req.query.source_database||'SH').toUpperCase();
      const [rows]=await pool.query(`SELECT i.id receipt_item_id,r.receipt_no,r.receipt_date,r.supplier_code,
        i.item_code,i.item_name,i.warehouse_code,i.unit,i.qty_accepted,i.qty_returned,
        i.qty_accepted-i.qty_returned returnable_quantity,i.unit_cost
        FROM procurement_receipts r JOIN procurement_receipt_items i ON i.receipt_id=r.id
        WHERE r.source_database=? AND r.status IN ('accepted','partially_accepted') AND i.qty_accepted>i.qty_returned
        ORDER BY r.receipt_date DESC,r.id DESC`,[sourceDatabase]);
      res.json({ok:true,data:rows});
    }catch(error){next(error);}
  });

  app.get('/api/procurement/returns',async(req,res,next)=>{
    try{
      const sourceDatabase=String(req.query.source_database||'SH').toUpperCase();
      const [rows]=await pool.query(`SELECT r.id,r.return_no,r.return_date,r.return_type,r.supplier_code,r.status,r.inventory_status,r.note,
        i.receipt_item_id,i.item_code,i.item_name,i.warehouse_code,i.unit,i.return_quantity,i.allowance_amount,i.unit_cost,i.reason
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
        if(receiptItemId){ const [[row]]=await conn.query(`SELECT i.*,r.supplier_code FROM procurement_receipt_items i JOIN procurement_receipts r ON r.id=i.receipt_id WHERE i.id=? AND r.source_database=? FOR UPDATE`,[receiptItemId,sourceDatabase]); if(!row) throw notFound('進貨來源明細不存在'); source=row; }
        const quantity=Number(body.return_quantity||0),allowance=Number(body.allowance_amount||0);
        if(returnType==='return' && (!source || quantity<=0 || quantity>Number(source.qty_accepted)-Number(source.qty_returned))) throw badRequest('退貨數量不可超過可退合格數量');
        if(returnType==='allowance' && allowance<=0) throw badRequest('折讓金額必須大於零');
        const supplier=trim(body.supplier_code)||source?.supplier_code; const itemCode=trim(body.item_code)||source?.item_code; if(!supplier||!itemCode) throw badRequest('廠商與品號不可空白');
        const date=validDate(body.return_date); const context=contextFor(sourceDatabase); const typeCode=trim(body.document_type);
        const [[documentType]]=await conn.query(`SELECT * FROM procurement_document_types WHERE tenant_id=? AND company_id=? AND source_system=? AND document_kind='purchase_return' AND type_code=? AND is_active=1`,[context.tenant_id,context.company_id,context.source_system,typeCode]);
        if(!documentType) throw badRequest('請選擇有效的退貨／折讓單別');
        const no=trim(body.return_no)||await nextWorkflowNumber(conn,'procurement_returns','return_no',documentType.number_prefix,date);
        const [header]=await conn.query(`INSERT INTO procurement_returns (tenant_id,company_id,source_system,document_type,return_no,supplier_code,return_date,return_type,status,inventory_status,note,source_database,created_by) VALUES (?,?,?,?,?,?,?,?,'draft',?,?,?,?)`,[context.tenant_id,context.company_id,context.source_system,trim(body.document_type)||'PR',no,supplier,date,returnType,returnType==='return'?'pending':'not_applicable',trim(body.note),sourceDatabase,req.auth.id]);
        await conn.query(`INSERT INTO procurement_return_items (return_id,receipt_item_id,line_no,item_code,item_name,warehouse_code,unit,return_quantity,allowance_amount,unit_cost,reason) VALUES (?,?,1,?,?,?,?,?,?,?,?)`,[header.insertId,receiptItemId,itemCode,trim(body.item_name)||source?.item_name,trim(body.warehouse_code)||source?.warehouse_code,trim(body.unit)||source?.unit||'PCS',quantity,allowance,Number(body.unit_cost??source?.unit_cost??0),trim(body.reason)]);
        return {id:header.insertId,return_no:no};
      });
      res.status(201).json({ok:true,data:result});
    }catch(error){next(error);}
  });

  app.post('/api/procurement/returns/:id/approve',async(req,res,next)=>{
    try{
      const id=Number(req.params.id);
      await tx(async conn=>{
        const [[row]]=await conn.query(`SELECT r.status,r.return_type,i.receipt_item_id,i.return_quantity,ri.qty_accepted,ri.qty_returned
          FROM procurement_returns r JOIN procurement_return_items i ON i.return_id=r.id LEFT JOIN procurement_receipt_items ri ON ri.id=i.receipt_item_id WHERE r.id=? FOR UPDATE`,[id]);
        if(!row||row.status!=='draft') throw badRequest('只有草稿退貨／折讓單可以核準');
        if(row.return_type==='return'){ if(Number(row.return_quantity)>Number(row.qty_accepted)-Number(row.qty_returned)) throw badRequest('退貨數量超過目前可退量'); await conn.query('UPDATE procurement_receipt_items SET qty_returned=qty_returned+? WHERE id=?',[row.return_quantity,row.receipt_item_id]); }
        await conn.query("UPDATE procurement_returns SET status='approved',approved_by=?,approved_at=NOW() WHERE id=?",[req.auth.id,id]);
      });
      res.json({ok:true,data:{id,status:'approved'}});
    }catch(error){next(error);}
  });

  app.get('/api/procurement/progress',async(req,res,next)=>{
    try{
      const sourceDatabase=String(req.query.source_database||'SH').toUpperCase();
      const limit=Math.min(Math.max(Number(req.query.limit)||10,1),100);
      const [rows]=await pool.query(`SELECT o.id,o.purchase_order_no,o.order_date,o.expected_date,o.supplier_code,o.status,
        i.item_code,i.item_name,i.unit,i.qty_ordered,i.qty_received,i.qty_cancelled,
        GREATEST(i.qty_ordered-i.qty_received-i.qty_cancelled,0) remaining_quantity,
        CASE WHEN i.qty_ordered-i.qty_received-i.qty_cancelled<=0 THEN 'completed'
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

function registerSalesWorkflowRoutes(app){
  const ctx=db=>{const s=sourceDatabases[db];if(!s)throw badRequest(`找不到資料來源：${db}`);return{tenant_id:s.tenant_id||'default',company_id:s.company_id||db,source_system:s.source_system||s.adapter_code||'ism-sh'};};
  const defs=[['quotation','QT','報價單','QT'],['sales_order','SO','客戶訂單','SO'],['shipment','SA','銷貨單','SA'],['sales_return','SR','銷退折讓單','SR']];
  const ensure=async db=>{const c=ctx(db);for(const x of defs)await pool.query(`INSERT IGNORE INTO sales_document_types(tenant_id,company_id,source_system,document_kind,type_code,type_name,number_prefix) VALUES(?,?,?,?,?,?,?)`,[c.tenant_id,c.company_id,c.source_system,...x]);return c;};
  app.get('/api/sales-workflow/document-types',async(req,res,next)=>{try{const db=String(req.query.source_database||'SH').toUpperCase(),c=await ensure(db),sp=getSourcePool(db);for(const [kind,table,column] of [['sales_order','copta','TA001'],['shipment','coptg','TG001'],['sales_return','copti','TI001']]){try{const[types]=await sp.query(`SELECT DISTINCT t.${column} type_code,COALESCE(NULLIF(q.MQ002,''),t.${column}) type_name FROM ${table} t LEFT JOIN cmsmq q ON q.COMPANY=t.COMPANY AND q.MQ001=t.${column} WHERE t.COMPANY=? AND t.${column}<>''`,[db]);for(const x of types)await pool.query(`INSERT IGNORE INTO sales_document_types(tenant_id,company_id,source_system,document_kind,type_code,type_name,number_prefix,requires_approval,note) VALUES(?,?,?,?,?,?,?,1,'由客戶舊 ERP 單據性質匯入')`,[c.tenant_id,c.company_id,c.source_system,kind,x.type_code,x.type_name,x.type_code]);}catch(_){}}const[rows]=await pool.query('SELECT * FROM sales_document_types WHERE tenant_id=? AND company_id=? AND source_system=? ORDER BY document_kind,type_code',[c.tenant_id,c.company_id,c.source_system]);res.json({ok:true,data:rows});}catch(e){next(e);}});
  app.post('/api/sales-workflow/document-types',async(req,res,next)=>{try{const b=req.body||{},db=String(b.source_database||'SH').toUpperCase(),c=ctx(db);if(!defs.some(x=>x[0]===b.document_kind)||!trim(b.type_code)||!trim(b.type_name))throw badRequest('請輸入有效的銷售單據性質');const[r]=await pool.query('INSERT INTO sales_document_types(tenant_id,company_id,source_system,document_kind,type_code,type_name,number_prefix,requires_approval,note) VALUES(?,?,?,?,?,?,?,?,?)',[c.tenant_id,c.company_id,c.source_system,b.document_kind,trim(b.type_code),trim(b.type_name),trim(b.number_prefix)||trim(b.type_code),Number(b.requires_approval??1),trim(b.note)]);res.status(201).json({ok:true,data:{id:r.insertId}});}catch(e){next(e);}});
  app.get('/api/sales-workflow/documents',async(req,res,next)=>{try{const db=String(req.query.source_database||'SH').toUpperCase(),kind=trim(req.query.document_kind),limit=Math.min(Math.max(Number(req.query.limit)||10,1),100),p=[db];let f='d.source_database=?';if(kind){f+=' AND d.document_kind=?';p.push(kind);}const[rows]=await pool.query(`SELECT d.*,i.id item_id,i.source_item_id,i.item_code,i.item_name,i.unit,i.warehouse_code,i.quantity,i.related_quantity,i.unit_price,i.unit_cost,i.expected_date,i.allowance_amount FROM sales_documents d JOIN sales_document_items i ON i.document_id=d.id WHERE ${f} ORDER BY d.document_date DESC,d.id DESC LIMIT ?`,[...p,limit]);res.json({ok:true,data:rows});}catch(e){next(e);}});
  app.post('/api/sales-workflow/documents',async(req,res,next)=>{try{const b=req.body||{},db=String(b.source_database||'SH').toUpperCase(),c=await ensure(db),kind=trim(b.document_kind),date=validDate(b.document_date),type=trim(b.document_type);const[[dt]]=await pool.query('SELECT * FROM sales_document_types WHERE tenant_id=? AND company_id=? AND source_system=? AND document_kind=? AND type_code=?',[c.tenant_id,c.company_id,c.source_system,kind,type]);if(!dt)throw badRequest('找不到銷售單據性質');if(!trim(b.customer_code)||!trim(b.item_code))throw badRequest('客戶與品號不可空白');const qty=positiveNumber(b.quantity,'數量'),sourceItemId=Number(b.source_item_id||0)||null;const out=await tx(async conn=>{let source=null;if(sourceItemId){const[[x]]=await conn.query('SELECT i.*,d.customer_code,d.status,d.document_kind FROM sales_document_items i JOIN sales_documents d ON d.id=i.document_id WHERE i.id=? FOR UPDATE',[sourceItemId]);if(!x||!['approved','partial'].includes(x.status))throw badRequest('來源單據尚未核準或已結案');if(qty>Number(x.quantity)-Number(x.related_quantity))throw badRequest('數量超過來源未交量');source=x;}const no=trim(b.document_no)||await nextWorkflowNumber(conn,'sales_documents','document_no',dt.number_prefix,date),inventory=['shipment','sales_return'].includes(kind)?'pending':'not_applicable';const[h]=await conn.query(`INSERT INTO sales_documents(tenant_id,company_id,source_system,source_database,document_kind,document_type,document_no,document_date,customer_code,currency_code,warehouse_code,salesperson_code,source_document_id,return_type,status,inventory_status,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'draft',?,?,?)`,[c.tenant_id,c.company_id,c.source_system,db,kind,type,no,date,trim(b.customer_code)||source?.customer_code,trim(b.currency_code)||'TWD',trim(b.warehouse_code),trim(b.salesperson_code),source?.document_id||null,kind==='sales_return'?(trim(b.return_type)||'return'):null,inventory,trim(b.note),req.auth.id]);const[i]=await conn.query(`INSERT INTO sales_document_items(document_id,line_no,source_item_id,item_code,item_name,specification,unit,warehouse_code,quantity,unit_price,unit_cost,expected_date,allowance_amount,note) VALUES(?,1,?,?,?,?,?,?,?,?,?,?,?,?)`,[h.insertId,sourceItemId,trim(b.item_code),trim(b.item_name)||source?.item_name,trim(b.specification),trim(b.unit)||source?.unit||'PCS',trim(b.warehouse_code)||source?.warehouse_code,qty,Number(b.unit_price??source?.unit_price??0),Number(b.unit_cost||0),nullableDate(b.expected_date),Number(b.allowance_amount||0),trim(b.item_note)]);return{id:h.insertId,item_id:i.insertId,document_no:no};});res.status(201).json({ok:true,data:out});}catch(e){next(e);}});
  app.post('/api/sales-workflow/documents/:id/approve',async(req,res,next)=>{try{const id=Number(req.params.id);const[r]=await pool.query("UPDATE sales_documents SET status='approved',approved_by=?,approved_at=NOW() WHERE id=? AND status='draft'",[req.auth.id,id]);if(!r.affectedRows)throw badRequest('只有草稿可以核準');res.json({ok:true,data:{id}});}catch(e){next(e);}});
  app.post('/api/sales-workflow/items/:id/convert',async(req,res,next)=>{try{const id=Number(req.params.id),b=req.body||{};const[[s]]=await pool.query('SELECT i.*,d.document_kind,d.customer_code,d.source_database FROM sales_document_items i JOIN sales_documents d ON d.id=i.document_id WHERE i.id=?',[id]);if(!s)throw badRequest('找不到來源明細');const target=s.document_kind==='quotation'?'sales_order':s.document_kind==='sales_order'?'shipment':null;if(!target)throw badRequest('此單據不可轉下一階段');req.body={...b,source_database:s.source_database,document_kind:target,document_type:target==='sales_order'?'SO':'SA',document_date:b.document_date,customer_code:s.customer_code,source_item_id:id,item_code:s.item_code,item_name:s.item_name,unit:s.unit,warehouse_code:b.warehouse_code||s.warehouse_code,quantity:b.quantity||Number(s.quantity)-Number(s.related_quantity),unit_price:s.unit_price};next();}catch(e){next(e);}},async(req,res,next)=>{try{const b=req.body,db=String(b.source_database).toUpperCase(),c=await ensure(db),date=validDate(b.document_date),kind=b.document_kind;const[[dt]]=await pool.query('SELECT * FROM sales_document_types WHERE tenant_id=? AND company_id=? AND source_system=? AND document_kind=? AND type_code=?',[c.tenant_id,c.company_id,c.source_system,kind,b.document_type]);const out=await tx(async conn=>{const[[s]]=await conn.query('SELECT i.*,d.customer_code FROM sales_document_items i JOIN sales_documents d ON d.id=i.document_id WHERE i.id=? AND d.status IN (\'approved\',\'partial\') FOR UPDATE',[b.source_item_id]);const qty=Number(b.quantity);if(!s||qty<=0||qty>Number(s.quantity)-Number(s.related_quantity))throw badRequest('轉單數量超過未交量');const no=await nextWorkflowNumber(conn,'sales_documents','document_no',dt.number_prefix,date);const[h]=await conn.query(`INSERT INTO sales_documents(tenant_id,company_id,source_system,source_database,document_kind,document_type,document_no,document_date,customer_code,warehouse_code,status,inventory_status,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,'draft',?,?)`,[c.tenant_id,c.company_id,c.source_system,db,kind,b.document_type,no,date,s.customer_code,b.warehouse_code,kind==='shipment'?'pending':'not_applicable',req.auth.id]);const[i]=await conn.query('INSERT INTO sales_document_items(document_id,line_no,source_item_id,item_code,item_name,unit,warehouse_code,quantity,unit_price,unit_cost,expected_date) VALUES(?,1,?,?,?,?,?,?,?,?,?)',[h.insertId,b.source_item_id,s.item_code,s.item_name,s.unit,b.warehouse_code||s.warehouse_code,qty,s.unit_price,Number(b.unit_cost||0),nullableDate(b.expected_date)]);await conn.query('UPDATE sales_document_items SET related_quantity=related_quantity+? WHERE id=?',[qty,b.source_item_id]);return{id:h.insertId,item_id:i.insertId,document_no:no};});res.status(201).json({ok:true,data:out});}catch(e){next(e);}});
  app.post('/api/sales-workflow/documents/:id/post',async(req,res,next)=>{try{const id=Number(req.params.id);await tx(async conn=>{const[[d]]=await conn.query(`SELECT d.*,i.item_code,i.warehouse_code,i.quantity,i.unit_cost,i.source_item_id FROM sales_documents d JOIN sales_document_items i ON i.document_id=d.id WHERE d.id=? FOR UPDATE`,[id]);if(!d||d.status!=='approved'||!['shipment','sales_return'].includes(d.document_kind))throw badRequest('只有已核準銷貨或銷退可以過帳');if(d.document_kind==='sales_return'&&d.return_type==='allowance'){await conn.query("UPDATE sales_documents SET status='posted',inventory_status='not_applicable',posted_by=?,posted_at=NOW() WHERE id=?",[req.auth.id,id]);return;}const c=ctx(d.source_database),sign=d.document_kind==='shipment'?-1:1,qty=sign*Number(d.quantity),amount=qty*Number(d.unit_cost||0);const[[bal]]=await conn.query(`SELECT * FROM erp_inventory_balances WHERE tenant_id=? AND company_id=? AND source_system=? AND item_code=? AND warehouse_code=? AND location_code='' FOR UPDATE`,[c.tenant_id,c.company_id,c.source_system,d.item_code,d.warehouse_code]);const nq=Number(bal?.quantity_on_hand||0)+qty,na=Number(bal?.inventory_amount||0)+amount;if(nq<0)throw badRequest(`庫存不足：${d.item_code} / ${d.warehouse_code}`);await conn.query(`INSERT INTO erp_inventory_balances(tenant_id,company_id,source_system,item_code,warehouse_code,location_code,quantity_on_hand,unit_cost,inventory_amount,last_movement_at) VALUES(?,?,?,?,?,'',?,?,?,NOW()) ON DUPLICATE KEY UPDATE quantity_on_hand=VALUES(quantity_on_hand),unit_cost=VALUES(unit_cost),inventory_amount=VALUES(inventory_amount),last_movement_at=NOW()`,[c.tenant_id,c.company_id,c.source_system,d.item_code,d.warehouse_code,nq,nq?na/nq:0,na]);await conn.query(`INSERT INTO inventory_movement_ledger(tenant_id,company_id,source_system,document_id,document_no,document_type,movement_kind,movement_date,item_code,warehouse_code,location_code,lot_no,quantity_delta,unit_cost,amount_delta) VALUES(?,?,?,NULL,?,?,?,?,?,?,'','',?,?,?)`,[c.tenant_id,c.company_id,c.source_system,d.document_no,d.document_type,d.document_kind,d.document_date,d.item_code,d.warehouse_code,qty,d.unit_cost,amount]);await conn.query("UPDATE sales_documents SET status='posted',inventory_status='posted',posted_by=?,posted_at=NOW() WHERE id=?",[req.auth.id,id]);if(d.source_item_id)await conn.query("UPDATE sales_documents sd JOIN sales_document_items si ON si.document_id=sd.id SET sd.status=IF(si.related_quantity>=si.quantity,'completed','partial') WHERE si.id=?",[d.source_item_id]);});res.json({ok:true,data:{id}});}catch(e){next(e);}});
  app.get('/api/sales-workflow/progress',async(req,res,next)=>{try{const db=String(req.query.source_database||'SH').toUpperCase(),limit=Math.min(Math.max(Number(req.query.limit)||10,1),100);const[rows]=await pool.query(`SELECT d.document_no,d.document_date,d.customer_code,d.status,i.item_code,i.item_name,i.quantity,i.related_quantity,i.quantity-i.related_quantity remaining_quantity,i.unit_price,(i.quantity-i.related_quantity)*i.unit_price remaining_amount,i.expected_date FROM sales_documents d JOIN sales_document_items i ON i.document_id=d.id WHERE d.source_database=? AND d.document_kind='sales_order' ORDER BY d.document_date DESC,d.id DESC LIMIT ?`,[db,limit]);res.json({ok:true,data:rows});}catch(e){next(e);}});
  app.get('/api/sales-workflow/order-changes',async(req,res,next)=>{try{const db=String(req.query.source_database||'SH').toUpperCase(),limit=Math.min(Math.max(Number(req.query.limit)||10,1),100);const[rows]=await pool.query(`SELECT c.*,d.document_no,i.item_code,i.item_name FROM sales_order_changes c JOIN sales_document_items i ON i.id=c.order_item_id JOIN sales_documents d ON d.id=i.document_id WHERE c.source_database=? ORDER BY c.change_date DESC,c.id DESC LIMIT ?`,[db,limit]);res.json({ok:true,data:rows});}catch(e){next(e);}});
  app.post('/api/sales-workflow/order-changes',async(req,res,next)=>{try{const b=req.body||{},db=String(b.source_database||'SH').toUpperCase(),c=ctx(db),date=validDate(b.change_date),itemId=Number(b.order_item_id);const out=await tx(async conn=>{const[[i]]=await conn.query("SELECT i.*,d.status FROM sales_document_items i JOIN sales_documents d ON d.id=i.document_id WHERE i.id=? AND d.document_kind='sales_order' FOR UPDATE",[itemId]);if(!i||!['approved','partial'].includes(i.status))throw badRequest('只有已核準未結案訂單可以變更');const qty=positiveNumber(b.new_quantity,'變更數量');if(qty<Number(i.related_quantity))throw badRequest('變更數量不可小於已銷貨量');const no=trim(b.change_no)||await nextWorkflowNumber(conn,'sales_order_changes','change_no','OC',date);const[r]=await conn.query(`INSERT INTO sales_order_changes(tenant_id,company_id,source_system,source_database,change_no,order_item_id,change_date,new_quantity,new_unit_price,new_expected_date,reason,status,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,'draft',?)`,[c.tenant_id,c.company_id,c.source_system,db,no,itemId,date,qty,Number(b.new_unit_price??i.unit_price),nullableDate(b.new_expected_date),trim(b.reason),req.auth.id]);return{id:r.insertId,change_no:no};});res.status(201).json({ok:true,data:out});}catch(e){next(e);}});
  app.post('/api/sales-workflow/order-changes/:id/approve',async(req,res,next)=>{try{const id=Number(req.params.id);await tx(async conn=>{const[[c]]=await conn.query("SELECT * FROM sales_order_changes WHERE id=? AND status='draft' FOR UPDATE",[id]);if(!c)throw badRequest('找不到待核準變更單');await conn.query('UPDATE sales_document_items SET quantity=?,unit_price=?,expected_date=? WHERE id=?',[c.new_quantity,c.new_unit_price,c.new_expected_date,c.order_item_id]);await conn.query("UPDATE sales_order_changes SET status='approved',approved_by=?,approved_at=NOW() WHERE id=?",[req.auth.id,id]);});res.json({ok:true,data:{id}});}catch(e){next(e);}});
  app.post('/api/sales-workflow/create',async(req,res,next)=>{try{const b=req.body||{},db=String(b.source_database||'SH').toUpperCase(),c=await ensure(db),date=validDate(b.document_date),kind=trim(b.document_kind);const[[dt]]=await pool.query('SELECT * FROM sales_document_types WHERE tenant_id=? AND company_id=? AND source_system=? AND document_kind=? AND type_code=?',[c.tenant_id,c.company_id,c.source_system,kind,trim(b.document_type)]);if(!dt||!trim(b.customer_code)||!trim(b.item_code))throw badRequest('單據性質、客戶與品號不可空白');const qty=positiveNumber(b.quantity,'數量'),out=await tx(async conn=>{const no=await nextWorkflowNumber(conn,'sales_documents','document_no',dt.number_prefix,date),inv=['shipment','sales_return'].includes(kind)?'pending':'not_applicable';const[h]=await conn.query(`INSERT INTO sales_documents(tenant_id,company_id,source_system,source_database,document_kind,document_type,document_no,document_date,customer_code,currency_code,warehouse_code,return_type,status,inventory_status,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?)`,[c.tenant_id,c.company_id,c.source_system,db,kind,dt.type_code,no,date,trim(b.customer_code),trim(b.currency_code)||'TWD',trim(b.warehouse_code),kind==='sales_return'?(trim(b.return_type)||'return'):null,inv,trim(b.note),req.auth.id]);const[i]=await conn.query(`INSERT INTO sales_document_items(document_id,line_no,item_code,item_name,unit,warehouse_code,quantity,unit_price,unit_cost,expected_date,allowance_amount) VALUES(?,1,?,?,?,?,?,?,?,?,?,?)`,[h.insertId,trim(b.item_code),trim(b.item_name),trim(b.unit)||'PCS',trim(b.warehouse_code),qty,Number(b.unit_price||0),Number(b.unit_cost||0),nullableDate(b.expected_date),Number(b.allowance_amount||0)]);return{id:h.insertId,item_id:i.insertId,document_no:no};});res.status(201).json({ok:true,data:out});}catch(e){next(e);}});
}

function registerFinanceWorkflowRoutes(app){
  const ctx=db=>{const s=sourceDatabases[db];if(!s)throw badRequest(`找不到資料來源：${db}`);return{tenant_id:s.tenant_id||'default',company_id:s.company_id||db,source_system:s.source_system||s.adapter_code||'ism-sh'};};
  app.get('/api/finance-workflow/source-documents',async(req,res,next)=>{try{const db=String(req.query.source_database||'SH').toUpperCase(),type=String(req.query.account_type||'AR').toUpperCase(),limit=Math.min(Math.max(Number(req.query.limit)||10,1),100);let rows;if(type==='AR')[rows]=await pool.query(`SELECT d.id source_document_id,d.document_kind source_kind,d.document_no source_document_no,d.document_date,d.customer_code party_code,d.currency_code,i.quantity*i.unit_price amount FROM sales_documents d JOIN sales_document_items i ON i.document_id=d.id LEFT JOIN finance_open_items f ON f.account_type='AR' AND f.source_kind=d.document_kind AND f.source_document_id=d.id WHERE d.source_database=? AND d.status='posted' AND f.id IS NULL ORDER BY d.document_date DESC,d.id DESC LIMIT ?`,[db,limit]);else[rows]=await pool.query(`SELECT r.id source_document_id,'purchase_receipt' source_kind,r.receipt_no source_document_no,r.receipt_date document_date,r.supplier_code party_code,'TWD' currency_code,i.qty_accepted*i.unit_cost amount FROM procurement_receipts r JOIN procurement_receipt_items i ON i.receipt_id=r.id LEFT JOIN finance_open_items f ON f.account_type='AP' AND f.source_kind='purchase_receipt' AND f.source_document_id=r.id WHERE r.source_database=? AND r.inventory_status='posted' AND f.id IS NULL ORDER BY r.receipt_date DESC,r.id DESC LIMIT ?`,[db,limit]);res.json({ok:true,data:rows});}catch(e){next(e);}});
  app.post('/api/finance-workflow/open-items',async(req,res,next)=>{try{const b=req.body||{},db=String(b.source_database||'SH').toUpperCase(),type=String(b.account_type||'AR').toUpperCase(),c=ctx(db),date=validDate(b.document_date),amount=Number(b.original_amount);if(!['AR','AP'].includes(type)||!trim(b.party_code)||!Number.isFinite(amount)||amount===0)throw badRequest('立帳類別、對象與金額不可空白');const prefix=type==='AR'?'AR':'AP',out=await tx(async conn=>{const no=trim(b.document_no)||await nextWorkflowNumber(conn,'finance_open_items','document_no',prefix,date);const[r]=await conn.query(`INSERT INTO finance_open_items(tenant_id,company_id,source_system,source_database,account_type,document_no,document_date,due_date,party_code,currency_code,source_kind,source_document_id,source_document_no,original_amount,balance_amount,status,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?)`,[c.tenant_id,c.company_id,c.source_system,db,type,no,date,nullableDate(b.due_date),trim(b.party_code),trim(b.currency_code)||'TWD',trim(b.source_kind)||'manual',Number(b.source_document_id)||null,trim(b.source_document_no),amount,amount,trim(b.note),req.auth.id]);return{id:r.insertId,document_no:no};});res.status(201).json({ok:true,data:out});}catch(e){next(e);}});
  app.post('/api/finance-workflow/open-items/:id/approve',async(req,res,next)=>{try{const id=Number(req.params.id);const[r]=await pool.query("UPDATE finance_open_items SET status='open',approved_by=?,approved_at=NOW(),posted_by=?,posted_at=NOW() WHERE id=? AND status='draft'",[req.auth.id,req.auth.id,id]);if(!r.affectedRows)throw badRequest('只有草稿可以立帳');res.json({ok:true,data:{id}});}catch(e){next(e);}});
  app.get('/api/finance-workflow/open-items',async(req,res,next)=>{try{const db=String(req.query.source_database||'SH').toUpperCase(),type=String(req.query.account_type||'AR').toUpperCase(),limit=Math.min(Math.max(Number(req.query.limit)||10,1),100);const[rows]=await pool.query('SELECT * FROM finance_open_items WHERE source_database=? AND account_type=? ORDER BY document_date DESC,id DESC LIMIT ?',[db,type,limit]);res.json({ok:true,data:rows});}catch(e){next(e);}});
  app.post('/api/finance-workflow/settlements',async(req,res,next)=>{try{const b=req.body||{},id=Number(b.open_item_id),amount=positiveNumber(b.amount,'收付金額'),date=validDate(b.settlement_date),selectedType=trim(b.document_type);if(!selectedType)throw badRequest('請選擇收付款單別');const out=await tx(async conn=>{const[[o]]=await conn.query("SELECT * FROM finance_open_items WHERE id=? AND status IN ('open','partial') FOR UPDATE",[id]);if(!o||amount>Number(o.balance_amount))throw badRequest('收付金額超過未沖餘額');const no=trim(b.settlement_no)||await nextWorkflowNumber(conn,'finance_settlements','settlement_no',selectedType,date);const[r]=await conn.query(`INSERT INTO finance_settlements(tenant_id,company_id,source_system,source_database,account_type,settlement_no,settlement_date,party_code,payment_method,bank_code,reference_no,amount,status,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'draft',?,?)`,[o.tenant_id,o.company_id,o.source_system,o.source_database,o.account_type,no,date,o.party_code,trim(b.payment_method),trim(b.bank_code),trim(b.reference_no),amount,trim(b.note),req.auth.id]);await conn.query('INSERT INTO finance_allocations(settlement_id,open_item_id,allocated_amount) VALUES(?,?,?)',[r.insertId,id,amount]);return{id:r.insertId,settlement_no:no};});res.status(201).json({ok:true,data:out});}catch(e){next(e);}});
  app.post('/api/finance-workflow/settlements/:id/post',async(req,res,next)=>{try{const id=Number(req.params.id);await tx(async conn=>{const[[s]]=await conn.query("SELECT s.*,a.open_item_id,a.allocated_amount FROM finance_settlements s JOIN finance_allocations a ON a.settlement_id=s.id WHERE s.id=? AND s.status='draft' FOR UPDATE",[id]);if(!s)throw badRequest('找不到待過帳收付款單');const[[o]]=await conn.query('SELECT * FROM finance_open_items WHERE id=? FOR UPDATE',[s.open_item_id]);if(Number(s.allocated_amount)>Number(o.balance_amount))throw badRequest('沖銷金額超過未沖餘額');const balance=Number(o.balance_amount)-Number(s.allocated_amount);await conn.query("UPDATE finance_open_items SET settled_amount=settled_amount+?,balance_amount=?,status=? WHERE id=?",[s.allocated_amount,balance,balance===0?'settled':'partial',o.id]);await conn.query("UPDATE finance_settlements SET status='posted',approved_by=?,approved_at=NOW(),posted_by=?,posted_at=NOW() WHERE id=?",[req.auth.id,req.auth.id,id]);});res.json({ok:true,data:{id}});}catch(e){next(e);}});
  app.get('/api/finance-workflow/settlements',async(req,res,next)=>{try{const db=String(req.query.source_database||'SH').toUpperCase(),type=String(req.query.account_type||'AR').toUpperCase(),limit=Math.min(Math.max(Number(req.query.limit)||10,1),100);const[rows]=await pool.query('SELECT s.*,a.open_item_id,a.allocated_amount,o.document_no open_document_no FROM finance_settlements s LEFT JOIN finance_allocations a ON a.settlement_id=s.id LEFT JOIN finance_open_items o ON o.id=a.open_item_id WHERE s.source_database=? AND s.account_type=? ORDER BY s.settlement_date DESC,s.id DESC LIMIT ?',[db,type,limit]);res.json({ok:true,data:rows});}catch(e){next(e);}});
  app.get('/api/finance-workflow/document-types',async(req,res,next)=>{try{const db=String(req.query.source_database||'SH').toUpperCase(),type=String(req.query.account_type||'AR').toUpperCase(),kind=String(req.query.document_kind||'settlement');const sourcePool=getSourcePool(db);const spec=type==='AR'?(kind==='open_item'?['acrta','TA001']:['acrtc','TC001']):(kind==='open_item'?['acpta','TA001']:['acptc','TC001']);const[rows]=await sourcePool.query(`SELECT DISTINCT t.${spec[1]} type_code,COALESCE(NULLIF(q.MQ002,''),t.${spec[1]}) type_name FROM ${spec[0]} t LEFT JOIN cmsmq q ON q.COMPANY=t.COMPANY AND q.MQ001=t.${spec[1]} WHERE t.COMPANY=? AND t.${spec[1]}<>'' ORDER BY t.${spec[1]}`,[db]);res.json({ok:true,data:rows});}catch(e){next(e);}});
  app.get('/api/finance-workflow/notes',async(req,res,next)=>{try{const db=String(req.query.source_database||'SH').toUpperCase(),type=String(req.query.account_type||'AR').toUpperCase();const[rows]=await pool.query(`SELECT n.*,s.settlement_no FROM finance_notes n LEFT JOIN finance_settlements s ON s.id=n.settlement_id WHERE n.source_database=? AND n.account_type=? ORDER BY n.issue_date DESC,n.id DESC LIMIT 100`,[db,type]);res.json({ok:true,data:rows});}catch(e){next(e);}});
  app.post('/api/finance-workflow/notes',async(req,res,next)=>{try{const b=req.body||{},settlementId=Number(b.settlement_id||0),type=String(b.account_type||'AR').toUpperCase(),issueDate=validDate(b.issue_date),dueDate=validDate(b.due_date),amount=positiveNumber(b.amount,'票據金額');if(!['AR','AP'].includes(type))throw badRequest('票據類別錯誤');const out=await tx(async conn=>{const[[s]]=await conn.query(`SELECT * FROM finance_settlements WHERE id=? AND account_type=? AND status='posted' FOR UPDATE`,[settlementId,type]);if(!s)throw badRequest('票據必須關聯已過帳的收款或付款單');if(amount>Number(s.amount))throw badRequest('票據金額不可超過收付款金額');const prefix=type==='AR'?'ARN':'APN',no=trim(b.note_no)||await nextWorkflowNumber(conn,'finance_notes','note_no',prefix,issueDate),status=type==='AR'?'received':'issued';const[r]=await conn.query(`INSERT INTO finance_notes(tenant_id,company_id,source_system,source_database,account_type,note_no,note_type,issue_date,due_date,party_code,bank_code,bank_account,amount,settlement_id,status,memo,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[s.tenant_id,s.company_id,s.source_system,s.source_database,type,no,trim(b.note_type)||'check',issueDate,dueDate,s.party_code,trim(b.bank_code),trim(b.bank_account),amount,settlementId,status,trim(b.memo),req.auth.id]);return{id:r.insertId,note_no:no,status};});res.status(201).json({ok:true,data:out});}catch(e){next(e);}});
  app.post('/api/finance-workflow/notes/:id/status',async(req,res,next)=>{try{const id=Number(req.params.id),status=trim(req.body?.status),allowed=['deposited','cashed','honored','dishonored','voided'];if(!allowed.includes(status))throw badRequest('票據狀態錯誤');const[r]=await pool.query(`UPDATE finance_notes SET status=? WHERE id=? AND status NOT IN ('cashed','honored','voided')`,[status,id]);if(!r.affectedRows)throw badRequest('票據不存在或已結案');res.json({ok:true,data:{id,status}});}catch(e){next(e);}});
}

function registerInventoryWorkflowRoutes(app) {
  const contextFor = sourceDatabase => {
    const source=sourceDatabases[sourceDatabase];
    if(!source) throw badRequest(`找不到資料來源：${sourceDatabase}`);
    return {tenant_id:source.tenant_id||'default',company_id:source.company_id||sourceDatabase,source_system:source.source_system||source.adapter_code||'ism-sh'};
  };
  const defaults=[['IS','其他領料','issue','IS'],['RT','其他退料','return','RT'],['AI','庫存增加調整','adjust_in','AI'],['AO','庫存減少調整','adjust_out','AO'],['SC','庫存報廢','scrap','SC'],['CA','庫存成本調整','cost_adjust','CA'],['TR','庫存轉撥','transfer','TR'],['TI','暫入','temp_in','TI'],['TIR','暫入歸還','temp_in_return','TIR'],['TO','暫出','temp_out','TO'],['TOR','暫出歸還','temp_out_return','TOR'],['ST','盤點調整','stocktake','ST']];
  async function ensureTypes(sourceDatabase){
    const c=contextFor(sourceDatabase);
    for(const row of defaults) await pool.query(`INSERT IGNORE INTO inventory_document_types(tenant_id,company_id,source_system,type_code,type_name,movement_kind,number_prefix) VALUES(?,?,?,?,?,?,?)`,[c.tenant_id,c.company_id,c.source_system,...row]);
    return c;
  }
  app.get('/api/inventory-workflow/document-types',async(req,res,next)=>{try{const db=String(req.query.source_database||'SH').toUpperCase(),c=await ensureTypes(db);const [rows]=await pool.query('SELECT * FROM inventory_document_types WHERE tenant_id=? AND company_id=? AND source_system=? ORDER BY movement_kind,type_code',[c.tenant_id,c.company_id,c.source_system]);res.json({ok:true,data:rows});}catch(e){next(e);}});
  app.post('/api/inventory-workflow/document-types',async(req,res,next)=>{try{const b=req.body||{},db=String(b.source_database||'SH').toUpperCase(),c=contextFor(db),kind=trim(b.movement_kind);if(!defaults.some(x=>x[2]===kind)||!trim(b.type_code)||!trim(b.type_name))throw badRequest('請輸入有效的單據性質');const [r]=await pool.query(`INSERT INTO inventory_document_types(tenant_id,company_id,source_system,type_code,type_name,movement_kind,number_prefix,requires_approval,allow_negative,note) VALUES(?,?,?,?,?,?,?,?,?,?)`,[c.tenant_id,c.company_id,c.source_system,trim(b.type_code),trim(b.type_name),kind,trim(b.number_prefix)||trim(b.type_code),Number(b.requires_approval??1),Number(b.allow_negative||0),trim(b.note)]);res.status(201).json({ok:true,data:{id:r.insertId}});}catch(e){if(e.code==='ER_DUP_ENTRY')e=badRequest('單據性質代號已存在');next(e);}});
  app.get('/api/inventory-workflow/documents',async(req,res,next)=>{try{const db=String(req.query.source_database||'SH').toUpperCase(),kind=trim(req.query.movement_kind),params=[db];let filter='d.source_database=?';if(kind){filter+=' AND d.movement_kind=?';params.push(kind);}const [rows]=await pool.query(`SELECT d.*,i.id item_id,i.item_code,i.item_name,i.unit,i.from_warehouse_code,i.to_warehouse_code,i.quantity,i.counted_quantity,i.unit_cost,i.amount_delta,i.reason FROM inventory_documents d JOIN inventory_document_items i ON i.document_id=d.id WHERE ${filter} ORDER BY d.document_date DESC,d.id DESC LIMIT 100`,params);res.json({ok:true,data:rows});}catch(e){next(e);}});
  app.post('/api/inventory-workflow/documents',async(req,res,next)=>{try{const b=req.body||{},db=String(b.source_database||'SH').toUpperCase(),c=await ensureTypes(db),date=validDate(b.document_date),type=trim(b.document_type);const [[dt]]=await pool.query('SELECT * FROM inventory_document_types WHERE tenant_id=? AND company_id=? AND source_system=? AND type_code=? AND is_active=1',[c.tenant_id,c.company_id,c.source_system,type]);if(!dt)throw badRequest('找不到啟用中的庫存單據性質');if(!trim(b.item_code))throw badRequest('品號不可空白');const qty=Number(b.quantity||0),counted=b.counted_quantity===''||b.counted_quantity==null?null:Number(b.counted_quantity);if(dt.movement_kind!=='cost_adjust'&&dt.movement_kind!=='stocktake'&&qty<=0)throw badRequest('數量必須大於 0');if(dt.movement_kind==='stocktake'&&!Number.isFinite(counted))throw badRequest('盤點單必須輸入實盤數量');if(dt.movement_kind==='transfer'&&(!trim(b.from_warehouse_code)||!trim(b.to_warehouse_code)||trim(b.from_warehouse_code)===trim(b.to_warehouse_code)))throw badRequest('轉出與轉入庫別必須不同');const result=await tx(async conn=>{const no=trim(b.document_no)||await nextWorkflowNumber(conn,'inventory_documents','document_no',dt.number_prefix,date);const [h]=await conn.query(`INSERT INTO inventory_documents(tenant_id,company_id,source_system,source_database,document_no,document_type,movement_kind,document_date,department_code,employee_code,counterparty,status,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,'draft',?,?)`,[c.tenant_id,c.company_id,c.source_system,db,no,type,dt.movement_kind,date,trim(b.department_code),trim(b.employee_code),trim(b.counterparty),trim(b.note),req.auth.id]);await conn.query(`INSERT INTO inventory_document_items(document_id,line_no,item_code,item_name,specification,unit,from_warehouse_code,to_warehouse_code,location_code,lot_no,quantity,counted_quantity,unit_cost,amount_delta,reason) VALUES(?,1,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[h.insertId,trim(b.item_code),trim(b.item_name),trim(b.specification),trim(b.unit)||'PCS',trim(b.from_warehouse_code)||null,trim(b.to_warehouse_code)||null,trim(b.location_code),trim(b.lot_no),qty,counted,Number(b.unit_cost||0),Number(b.amount_delta||0),trim(b.reason)]);return{id:h.insertId,document_no:no};});res.status(201).json({ok:true,data:result});}catch(e){next(e);}});
  app.post('/api/inventory-workflow/documents/:id/approve',async(req,res,next)=>{try{const id=Number(req.params.id);const [r]=await pool.query("UPDATE inventory_documents SET status='approved',approved_by=?,approved_at=NOW() WHERE id=? AND status='draft'",[req.auth.id,id]);if(!r.affectedRows)throw badRequest('只有草稿可以核準');res.json({ok:true,data:{id,status:'approved'}});}catch(e){next(e);}});
  app.post('/api/inventory-workflow/documents/:id/post',async(req,res,next)=>{try{const id=Number(req.params.id);await tx(async conn=>{const [[d]]=await conn.query(`SELECT d.*,i.*,d.id document_id,dt.allow_negative FROM inventory_documents d JOIN inventory_document_items i ON i.document_id=d.id JOIN inventory_document_types dt ON dt.tenant_id=d.tenant_id AND dt.company_id=d.company_id AND dt.source_system=d.source_system AND dt.type_code=d.document_type WHERE d.id=? FOR UPDATE`,[id]);if(!d||d.status!=='approved')throw badRequest('只有已核準單據可以過帳');const getBalance=async wh=>{const [[r]]=await conn.query(`SELECT * FROM erp_inventory_balances WHERE tenant_id=? AND company_id=? AND source_system=? AND item_code=? AND warehouse_code=? AND location_code=? FOR UPDATE`,[d.tenant_id,d.company_id,d.source_system,d.item_code,wh,d.location_code||'']);return r||{quantity_on_hand:0,inventory_amount:0,unit_cost:0};};const apply=async(wh,qtyDelta,amountDelta)=>{if(!wh)throw badRequest('庫別不可空白');const bal=await getBalance(wh),newQty=Number(bal.quantity_on_hand)+qtyDelta,newAmount=Number(bal.inventory_amount)+amountDelta;if(newQty<0&&!Number(d.allow_negative))throw badRequest(`庫存不足：${d.item_code} / ${wh}`);const newCost=newQty===0?0:newAmount/newQty;await conn.query(`INSERT INTO erp_inventory_balances(tenant_id,company_id,source_system,item_code,warehouse_code,location_code,quantity_on_hand,unit_cost,inventory_amount,last_movement_at) VALUES(?,?,?,?,?,?,?,?,?,NOW()) ON DUPLICATE KEY UPDATE quantity_on_hand=VALUES(quantity_on_hand),unit_cost=VALUES(unit_cost),inventory_amount=VALUES(inventory_amount),last_movement_at=NOW()`,[d.tenant_id,d.company_id,d.source_system,d.item_code,wh,d.location_code||'',newQty,newCost,newAmount]);await conn.query(`INSERT INTO inventory_movement_ledger(tenant_id,company_id,source_system,document_id,document_no,document_type,movement_kind,movement_date,item_code,warehouse_code,location_code,lot_no,quantity_delta,unit_cost,amount_delta) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[d.tenant_id,d.company_id,d.source_system,d.document_id,d.document_no,d.document_type,d.movement_kind,d.document_date,d.item_code,wh,d.location_code||'',d.lot_no||'',qtyDelta,d.unit_cost,amountDelta]);};const cost=Number(d.unit_cost||0);if(d.movement_kind==='transfer'){await apply(d.from_warehouse_code,-Number(d.quantity),-Number(d.quantity)*cost);await apply(d.to_warehouse_code,Number(d.quantity),Number(d.quantity)*cost);}else if(d.movement_kind==='stocktake'){const bal=await getBalance(d.to_warehouse_code||d.from_warehouse_code),delta=Number(d.counted_quantity)-Number(bal.quantity_on_hand);await apply(d.to_warehouse_code||d.from_warehouse_code,delta,delta*cost);}else if(d.movement_kind==='cost_adjust'){await apply(d.to_warehouse_code||d.from_warehouse_code,0,Number(d.amount_delta));}else{const positive=['return','adjust_in','temp_in','temp_out_return'].includes(d.movement_kind),qty=(positive?1:-1)*Number(d.quantity);await apply(d.to_warehouse_code||d.from_warehouse_code,qty,qty*cost);}await conn.query("UPDATE inventory_documents SET status='posted',posted_by=?,posted_at=NOW() WHERE id=?",[req.auth.id,id]);});res.json({ok:true,data:{id,status:'posted'}});}catch(e){next(e);}});
  app.get('/api/inventory-workflow/procurement-pending',async(req,res,next)=>{try{const db=String(req.query.source_database||'SH').toUpperCase();const [receipts]=await pool.query(`SELECT 'receipt' source_kind,r.id,r.receipt_no document_no,r.receipt_date document_date,r.supplier_code,i.item_code,i.item_name,i.warehouse_code,i.unit,i.qty_accepted quantity,i.unit_cost,r.inventory_status FROM procurement_receipts r JOIN procurement_receipt_items i ON i.receipt_id=r.id WHERE r.source_database=? AND r.status IN ('accepted','partially_accepted') AND r.inventory_status='pending'`,[db]);const [returns]=await pool.query(`SELECT 'return' source_kind,r.id,r.return_no document_no,r.return_date document_date,r.supplier_code,i.item_code,i.item_name,i.warehouse_code,i.unit,i.return_quantity quantity,i.unit_cost,r.inventory_status FROM procurement_returns r JOIN procurement_return_items i ON i.return_id=r.id WHERE r.source_database=? AND r.return_type='return' AND r.status='approved' AND r.inventory_status='pending'`,[db]);res.json({ok:true,data:[...receipts,...returns]});}catch(e){next(e);}});
  app.post('/api/inventory-workflow/procurement/:kind/:id/post',async(req,res,next)=>{try{const kind=req.params.kind,id=Number(req.params.id);if(!['receipt','return'].includes(kind))throw badRequest('不支援的採購庫存來源');await tx(async conn=>{let row;if(kind==='receipt')[[row]]=await conn.query(`SELECT r.*,i.item_code,i.warehouse_code,i.qty_accepted quantity,i.unit_cost FROM procurement_receipts r JOIN procurement_receipt_items i ON i.receipt_id=r.id WHERE r.id=? FOR UPDATE`,[id]);else [[row]]=await conn.query(`SELECT r.*,i.item_code,i.warehouse_code,i.return_quantity quantity,i.unit_cost FROM procurement_returns r JOIN procurement_return_items i ON i.return_id=r.id WHERE r.id=? FOR UPDATE`,[id]);if(!row||row.inventory_status!=='pending')throw badRequest('此單據已過帳或不可過帳');if(kind==='receipt'&&!['accepted','partially_accepted'].includes(row.status))throw badRequest('進貨尚未驗收完成');if(kind==='return'&&(row.status!=='approved'||row.return_type!=='return'))throw badRequest('退貨尚未核準');const c=contextFor(String(row.source_database).toUpperCase()),qty=(kind==='receipt'?1:-1)*Number(row.quantity),amount=qty*Number(row.unit_cost||0);const [[bal]]=await conn.query(`SELECT * FROM erp_inventory_balances WHERE tenant_id=? AND company_id=? AND source_system=? AND item_code=? AND warehouse_code=? AND location_code='' FOR UPDATE`,[c.tenant_id,c.company_id,c.source_system,row.item_code,row.warehouse_code]);const newQty=Number(bal?.quantity_on_hand||0)+qty,newAmount=Number(bal?.inventory_amount||0)+amount;if(newQty<0)throw badRequest(`庫存不足：${row.item_code} / ${row.warehouse_code}`);await conn.query(`INSERT INTO erp_inventory_balances(tenant_id,company_id,source_system,item_code,warehouse_code,location_code,quantity_on_hand,unit_cost,inventory_amount,last_movement_at) VALUES(?,?,?,?,?,'',?,?,?,NOW()) ON DUPLICATE KEY UPDATE quantity_on_hand=VALUES(quantity_on_hand),unit_cost=VALUES(unit_cost),inventory_amount=VALUES(inventory_amount),last_movement_at=NOW()`,[c.tenant_id,c.company_id,c.source_system,row.item_code,row.warehouse_code,newQty,newQty?newAmount/newQty:0,newAmount]);const no=kind==='receipt'?row.receipt_no:row.return_no,date=kind==='receipt'?row.receipt_date:row.return_date;await conn.query(`INSERT INTO inventory_movement_ledger(tenant_id,company_id,source_system,document_id,document_no,document_type,movement_kind,movement_date,item_code,warehouse_code,location_code,lot_no,quantity_delta,unit_cost,amount_delta) VALUES(?,?,?,NULL,?,?,?,?,?,?,'','',?,?,?)`,[c.tenant_id,c.company_id,c.source_system,no,kind==='receipt'?'GR':'PR',kind==='receipt'?'purchase_receipt':'purchase_return',date,row.item_code,row.warehouse_code,qty,row.unit_cost,amount]);if(kind==='receipt')await conn.query("UPDATE procurement_receipts SET inventory_status='posted',inventory_posted_by=?,inventory_posted_at=NOW() WHERE id=?",[req.auth.id,id]);else await conn.query("UPDATE procurement_returns SET inventory_status='posted' WHERE id=?",[id]);});res.json({ok:true,data:{id,kind,status:'posted'}});}catch(e){next(e);}});
  app.get('/api/inventory-workflow/balances',async(req,res,next)=>{try{const db=String(req.query.source_database||'SH').toUpperCase(),c=contextFor(db);const [rows]=await pool.query('SELECT * FROM erp_inventory_balances WHERE tenant_id=? AND company_id=? AND source_system=? ORDER BY warehouse_code,item_code',[c.tenant_id,c.company_id,c.source_system]);res.json({ok:true,data:rows});}catch(e){next(e);}});
  app.get('/api/inventory-workflow/ledger',async(req,res,next)=>{try{const db=String(req.query.source_database||'SH').toUpperCase(),c=contextFor(db);const [rows]=await pool.query('SELECT * FROM inventory_movement_ledger WHERE tenant_id=? AND company_id=? AND source_system=? ORDER BY movement_date DESC,id DESC LIMIT 200',[c.tenant_id,c.company_id,c.source_system]);res.json({ok:true,data:rows});}catch(e){next(e);}});
}

function registerAccessControlRoutes(app) {
  app.get('/api/access-users', async (req, res, next) => {
    try {
      if (req.auth?.role_code !== 'ADMIN') throw Object.assign(new Error('僅系統管理員可管理帳號'), { status:403 });
      await ensureProcurementSchema();
      const [rows] = await pool.query(`SELECT u.id, u.username, u.employee_code, u.display_name, u.role_id, u.is_active,
        u.force_password_change, r.role_name FROM access_users u JOIN access_roles r ON r.id=u.role_id ORDER BY u.username`);
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
      const [[role]] = await pool.query('SELECT id FROM access_roles WHERE id=?', [roleId]); if (!role) throw badRequest('角色不存在');
      const [result] = await pool.query(`INSERT INTO access_users
        (username, employee_code, display_name, password_hash, role_id, is_active, force_password_change)
        VALUES (?, ?, ?, ?, ?, 1, 1)`, [username, trim(body.employee_code) || null, displayName, hashPassword(password), roleId]);
      res.status(201).json({ ok:true, data:{ id:result.insertId } });
    } catch (error) { if (error.code === 'ER_DUP_ENTRY') error = badRequest('帳號已存在'); next(error); }
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

  app.put('/api/access-roles/:id/permissions', async (req, res, next) => {
    try {
      if (req.auth?.role_code !== 'ADMIN') throw Object.assign(new Error('僅系統管理員可修改系統權限'), { status:403 });
      await ensureProcurementSchema();
      const roleId = Number(req.params.id);
      const rows = Array.isArray(req.body?.permissions) ? req.body.permissions : null;
      if (!Number.isInteger(roleId) || roleId < 1 || !rows) throw badRequest('Invalid role permission payload');
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
