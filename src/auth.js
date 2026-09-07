import crypto from 'node:crypto';
import { pool, controlPool, ensureProcurementSchema, sourceDatabases } from './db.js';

const SESSION_HOURS = 12;

function badRequest(message) { const error = new Error(message); error.status = 400; return error; }
function unauthorized(message = '請先登入系統') { const error = new Error(message); error.status = 401; return error; }
function forbidden(message = '您沒有此作業權限') { const error = new Error(message); error.status = 403; return error; }

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const digest = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${digest}`;
}

function verifyPassword(password, stored) {
  const [algorithm, salt, digest] = String(stored || '').split('$');
  if (algorithm !== 'scrypt' || !salt || !digest) return false;
  const actual = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(digest, 'hex'));
}

function tokenFrom(req) {
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function normalizeSourceKey(value) {
  const key = String(value ?? '').trim().toUpperCase();
  return key || null;
}

function normalizeDepartmentCode(value) {
  const code = String(value ?? '').trim().toUpperCase();
  return code || null;
}

export async function getDepartmentScope(userId, sourceKey) {
  const key = normalizeSourceKey(sourceKey);
  if (!key || !Number.isInteger(Number(userId))) return { source_key:key, mode:'none', department_codes:[] };
  const [rows] = await pool.query(`
    SELECT auc.department_scope_mode, aud.department_code
    FROM access_user_companies auc
    LEFT JOIN access_user_departments aud
      ON aud.user_id=auc.user_id AND aud.source_key=auc.source_key
    WHERE auc.user_id=? AND auc.source_key=?
    ORDER BY aud.department_code`, [Number(userId), key]);
  if (!rows.length) return { source_key:key, mode:'none', department_codes:[] };
  const mode = ['all','selected'].includes(String(rows[0].department_scope_mode)) ? String(rows[0].department_scope_mode) : 'all';
  const departmentCodes = [...new Set(rows.map(row => normalizeDepartmentCode(row.department_code)).filter(Boolean))];
  return { source_key:key, mode, department_codes:departmentCodes };
}

export async function getUserAccessScope(userId, roleCode) {
  if (String(roleCode || '').toUpperCase() === 'ADMIN') {
    return { allowed_sources:['*'], department_scopes:[] };
  }
  const [companies] = await pool.query(`
    SELECT source_key, department_scope_mode
    FROM access_user_companies
    WHERE user_id=? ORDER BY source_key`, [Number(userId)]);
  const departmentScopes = [];
  for (const company of companies) {
    const scope = await getDepartmentScope(userId, company.source_key);
    departmentScopes.push({ source_key:scope.source_key, mode:scope.mode, department_codes:scope.department_codes });
  }
  return {
    allowed_sources:companies.map(row => String(row.source_key).toUpperCase()),
    department_scopes:departmentScopes
  };
}

export async function hasDepartmentAccess(userId, roleCode, sourceKey, departmentCode) {
  if (String(roleCode || '').toUpperCase() === 'ADMIN') return true;
  const scope = await getDepartmentScope(userId, sourceKey);
  if (scope.mode === 'all') return true;
  const code = normalizeDepartmentCode(departmentCode);
  if (!code) return false;
  return scope.mode === 'all' || (scope.mode === 'selected' && scope.department_codes.includes(code));
}

export async function recordAccessAudit({
  actorUserId = null, targetUserId = null, actionCode, entityType, entityId = null,
  sourceKey = null, departmentCode = null, before = null, after = null,
  reason = null, ipAddress = null, userAgent = null
} = {}) {
  if (!actionCode || !entityType) return;
  const json = value => value == null ? null : JSON.stringify(value);
  // 權限／存取稽核屬於控制平面，不能隨目前 ERP 目標公司連線切換。
  await controlPool.query(`INSERT INTO access_audit_log
    (actor_user_id,target_user_id,action_code,entity_type,entity_id,source_key,department_code,before_json,after_json,reason,ip_address,user_agent)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, [
    Number.isInteger(Number(actorUserId)) ? Number(actorUserId) : null,
    Number.isInteger(Number(targetUserId)) ? Number(targetUserId) : null,
    String(actionCode).slice(0,60), String(entityType).slice(0,60), entityId == null ? null : String(entityId).slice(0,100),
    normalizeSourceKey(sourceKey), normalizeDepartmentCode(departmentCode), json(before), json(after),
    reason == null ? null : String(reason).slice(0,500), ipAddress == null ? null : String(ipAddress).slice(0,64),
    userAgent == null ? null : String(userAgent).slice(0,255)
  ]);
}

async function hasSourceAccess(userId, roleCode, sourceKey) {
  const key = normalizeSourceKey(sourceKey);
  if (!key) return false;
  const [[row]] = await pool.query(`
    SELECT 1 AS allowed
    FROM erp_data_sources s
    WHERE s.source_key=? AND s.enabled=1
      AND (?='ADMIN' OR EXISTS(
        SELECT 1 FROM access_user_companies auc
        WHERE auc.user_id=? AND auc.source_key=s.source_key
      ))
    LIMIT 1`, [key, roleCode, userId]);
  return Boolean(row);
}

async function defaultSourceForUser(user) {
  const [[row]] = await pool.query(`
    SELECT s.source_key
    FROM erp_data_sources s
    WHERE s.enabled=1
      AND (?='ADMIN' OR EXISTS(
        SELECT 1 FROM access_user_companies auc
        WHERE auc.user_id=? AND auc.source_key=s.source_key
      ))
    ORDER BY CASE WHEN s.source_key='SH' THEN 0 ELSE 1 END, s.sort_order, s.source_key
    LIMIT 1`, [user.role_code, user.id]);
  return normalizeSourceKey(row?.source_key);
}

async function synchronizeSessionContext(user) {
  const requested = normalizeSourceKey(user.current_source_key);
  const current = requested && await hasSourceAccess(user.id, user.role_code, requested)
    ? requested
    : await defaultSourceForUser(user);
  if (current !== requested) {
    await pool.query('UPDATE access_sessions SET current_source_key=?, context_changed_at=NOW() WHERE id=? AND user_id=?', [current, user.session_id, user.id]);
  }
  return current;
}

export async function authMiddleware(req, _res, next) {
  try {
    if (req.path === '/auth/login') return next();
    const token = tokenFrom(req);
    if (!token) throw unauthorized();
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const [[user]] = await pool.query(`SELECT u.id, u.username, u.employee_code, u.display_name, u.role_id, u.is_active,
      r.role_code, r.role_name, s.id AS session_id, s.current_source_key
      FROM access_sessions s JOIN access_users u ON u.id=s.user_id JOIN access_roles r ON r.id=u.role_id
      WHERE s.token_hash=? AND s.expires_at>NOW()`, [hash]);
    if (!user || !user.is_active) throw unauthorized('登入已失效，請重新登入');
    user.current_source_key = await synchronizeSessionContext(user);
    user.current_company_id = sourceDatabases[user.current_source_key]?.company_id || null;
    req.auth = user;
    next();
  } catch (error) { next(error); }
}

const routeCapability = [
  [/^\/access-roles/, 'access-control'], [/^\/access-users/, 'access-control'],
  [/^\/master\/warehouses/, 'warehouses'], [/^\/master\/departments/, 'departments'], [/^\/master\/employees/, 'employees'],
  [/^\/master\/customers/, 'source-customers'], [/^\/master\/suppliers/, 'source-suppliers'],
  [/^\/master\/companies/, 'basicdata'], [/^\/master\/code-rules/, 'basicdata'], [/^\/master\/common-parameters/, 'basicdata'],
  [/^\/master\/(job-categories|job-category-employees|currencies|currency-rates|payment-terms|calendars|calendar-days)/, 'basicdata'],
  [/^\/master\/item-categories/, 'item-categories'], [/^\/master\/items/, 'items'],
  [/^\/import\/data-quality(?:\/|$)/, 'data-quality'], [/^\/import\//, 'import-monitor'],
  [/^\/reports\/operations(?:\/|$)/, 'operations-reports'],
  [/^\/flow-audit\/sales(?:\/|$)/, 'sales-flow-audit'],
  [/^\/flow-audit\/procurement(?:\/|$)/, 'purchase-flow-audit'],
  [/^\/flow-audit\/health(?:\/|$)/, 'operations-health'],
  [/^\/flow-audit\/recommendations(?:\/|$)/, 'flow-audit-recommendations'],
  [/^\/inventory-opening/, 'inventory-opening'],
  [/^\/sales-workflow\/document-types/, 'sales-document-types'],
  [/^\/sales-workflow\/customer-item(?:s|-mappings)(?:\/|$)/, 'sales-customer-items'],
  [/^\/sales-workflow\/customer-pricing(?:\/|$)/, 'sales-customer-pricing'],
  [/^\/sales-workflow\/forecasts(?:\/|$)/, 'sales-forecast'],
  [/^\/sales-workflow\/order-changes/, 'sales-order-changes'],
  [/^\/sales-workflow\/orders-for-reopen/, 'sales-order-changes'],
  [/^\/sales-workflow\/orders\/\d+\/reopen/, 'sales-order-changes'],
  [/^\/sales-workflow\/statistics(?:\/|$)/, 'sales-statistics'],
  [/^\/sales-workflow\/progress/, 'sales-progress'],
  [/^\/sales-workflow\/documents/, 'sales-orders'], [/^\/sales-workflow\/items/, 'sales-orders'],
  [/^\/finance-workflow\/banks\/reconciliations(?:\/|$)/, 'finance-reconcile'],
  [/^\/finance-workflow\/banks\/transactions\/\d+\/(?:post|reverse|void)/, 'finance-cash'],
  [/^\/finance-workflow\/banks\/transactions(?:\/|$)/, 'finance-cash'],
  [/^\/finance-workflow\/banks\/accounts\/\d+/, 'finance-cash'],
  [/^\/finance-workflow\/banks\/accounts(?:\/|$)/, 'finance-bookkeeping'],
  [/^\/finance-workflow\/notes(?:\/|$)/, 'finance-cash'],
  [/^\/finance-workflow\//, 'finance-workflow'],
  [/^\/accounting\/(periods)/, 'accounting-periods'],
  [/^\/accounting\/(auto-rules)/, 'accounting-auto-rules'],
  [/^\/accounting\/clearing/, 'accounting-clearing'],
  [/^\/accounting\/(opening-batches)/, 'accounting-opening-balances'],
  [/^\/accounting\/opening-balances/, 'accounting-opening-balances'],
  [/^\/accounting\/(month-closings)/, 'accounting-periods'],
  [/^\/accounting\/(trial-balance|account-balances|ledger-details|reconciliation|source-financial-preview)/, 'accounting-general-ledger'],
  [/^\/accounting\/year-closings/, 'accounting-year-close'],
  [/^\/accounting\/(drafts|sources)/, 'accounting-drafts'],
  [/^\/accounting\/(accounts|ledger)/, 'accounting-general-ledger'],
  [/^\/accounting\/journals/, 'accounting-general-ledger'],
  [/^\/inventory-workflow\/document-types/, 'inventory-document-types'],
  [/^\/inventory-workflow\/procurement/, 'inventory-posting'],
  [/^\/inventory-workflow\/documents\/\d+\/(approve|post)/, 'inventory-posting'],
  [/^\/inventory-workflow\/documents/, 'inventory-transactions'],
  [/^\/reversals/, 'inventory-reversals'],
  [/^\/inventory-workflow\/(availability|balances)/, 'inventory-new-balance'], [/^\/inventory-workflow\/ledger/, 'inventory-new-ledger'],
  [/^\/sh\/basic-data/, 'basicdata'], [/^\/sh\/warehouses/, 'warehouses'], [/^\/sh\/departments/, 'departments'],
  [/^\/sh\/employees/, 'employees'], [/^\/sh\/customers/, 'source-customers'], [/^\/sh\/suppliers/, 'source-suppliers'],
  [/^\/sh\/inventory-details/, 'inventory-detail'], [/^\/sh\/inventory-ledger/, 'inventory-ledger'],
  [/^\/sh\/inventory-balance/, 'inventory-balance'], [/^\/sh\/inventory-movement-stats/, 'inventory-movement-stats'],
  [/^\/sh\/department-movement-stats/, 'department-movement-stats'], [/^\/sh\/purchase-receipts/, 'purchase-receipts'],
  [/^\/procurement\/document-types/, 'procurement-document-types'],
  [/^\/procurement\/(requisition-maintenance|requisition-lines\/\d+\/(maintenance|convert))/, 'requisition-maintenance'],
  [/^\/procurement\/order-changes/, 'purchase-order-changes'],
  [/^\/procurement\/(pending-inspections|receipts\/\d+\/inspect)/, 'receipt-inspection'],
  [/^\/procurement\/(rejected-items|rejected-returns|receipts\/\d+\/rejected-return)/, 'receipt-rejected-return'],
  [/^\/procurement\/(returns|returnable-receipts)/, 'purchase-returns'],
  [/^\/procurement\/progress/, 'purchase-progress'], [/^\/procurement\/open-orders/, 'open-purchase-orders'],
  [/^\/sh\/purchase-documents\/requisitions/, 'requisition-entry'], [/^\/sh\/purchase-documents\/orders/, 'purchase-order-entry'],
  [/^\/sh\/purchase-documents\/receipts/, 'receipt-entry'], [/^\/procurement\/requisition/, 'requisition-entry'],
  [/^\/procurement\/documents\/requisitions/, 'requisition-entry'], [/^\/procurement\/order/, 'purchase-order-entry'],
  [/^\/procurement\/documents\/orders/, 'purchase-order-entry'], [/^\/procurement\/receipt/, 'receipt-entry'],
  [/^\/procurement\/documents\/receipts/, 'receipt-entry']
];

export async function authorizationMiddleware(req, _res, next) {
  try {
    if (req.path.startsWith('/auth/')) return next();
    const match = routeCapability.find(([pattern]) => pattern.test(req.path));
    if (!match || req.auth.role_code === 'ADMIN') return next();
    const featureCode = match[1];
    const action = /\/(approve|reject|post|close|reopen|restore|complete|reverse|validate|void|scan|acknowledge|correction|resolve|ignore)$/.test(req.path) ? 'can_approve' : req.method === 'GET' ? 'can_view' : req.method === 'POST' ? 'can_create' : req.method === 'PUT' || req.method === 'PATCH' ? 'can_update' : req.method === 'DELETE' ? 'can_delete' : 'can_view';
    // 管帳角色可以查詢票據／銀行明細，但不能建立、過帳、沖回或變更資金。
    // 寫入仍由 finance-cash／finance-reconcile 的權限單獨控管。
    if (req.method === 'GET' && /^\/finance-workflow\/(notes|banks\/transactions)(?:\/|$)/.test(req.path)) {
      const [[permission]] = await pool.query(`SELECT MAX(can_view) AS allowed
        FROM access_role_permissions WHERE role_id=? AND feature_code IN ('finance-bookkeeping','finance-cash')`, [req.auth.role_id]);
      if (!permission || !Number(permission.allowed)) throw forbidden();
      return next();
    }
    // 同一份近期進貨 API 同時供「進貨建立作業」及唯讀的「進貨入庫明細」使用。
    // GET 允許具備任一畫面查詢權限的角色；新增進貨仍由 receipt-entry 的 can_create 控制。
    if (req.method === 'GET' && /^\/procurement\/documents\/receipts(?:\/|$)/.test(req.path)) {
      const [[permission]] = await pool.query(`SELECT MAX(can_view) AS allowed
        FROM access_role_permissions
        WHERE role_id=? AND feature_code IN ('receipt-entry','purchase-receipts')`, [req.auth.role_id]);
      if (!permission || !Number(permission.allowed)) throw forbidden();
      return next();
    }
    if (req.method === 'GET' && req.path === '/procurement/order-lines') {
      const [[permission]] = await pool.query(`SELECT MAX(can_view) AS allowed FROM access_role_permissions
        WHERE role_id=? AND feature_code IN ('purchase-order-entry','receipt-arrival','receipt-entry')`, [req.auth.role_id]);
      if (!permission || !Number(permission.allowed)) throw forbidden();
      return next();
    }
    // 銷售統計正式報表與接單／跟催畫面共用訂單查詢權限；具備其中一項查詢權限即可讀取。
    if (req.method === 'GET' && (req.path === '/sales-workflow/progress' || req.path === '/sales-workflow/statistics')) {
      const [[permission]] = await pool.query("SELECT MAX(can_view) AS allowed FROM access_role_permissions WHERE role_id=? AND feature_code IN ('sales-progress','sales-open-orders','sales-statistics','sales-forecast','sales-analysis')", [req.auth.role_id]);
      if (!permission || !Number(permission.allowed)) throw forbidden();
      return next();
    }
    if (/^\/inventory-workflow\/procurement(?:-|\/)/.test(req.path)) {
      const [[permission]] = await pool.query(`SELECT MAX(${action}) AS allowed FROM access_role_permissions
        WHERE role_id=? AND feature_code IN ('inventory-posting','receipt-posting')`, [req.auth.role_id]);
      if (!permission || !Number(permission.allowed)) throw forbidden();
      return next();
    }
    const [[permission]] = await pool.query(`SELECT ${action} AS allowed FROM access_role_permissions WHERE role_id=? AND feature_code=?`, [req.auth.role_id, featureCode]);
    if (!permission || !Number(permission.allowed)) throw forbidden();
    next();
  } catch (error) { next(error); }
}

export function registerAuthRoutes(app) {
  app.post('/api/auth/login', async (req, res, next) => {
    try {
      await ensureProcurementSchema();
      const username = String(req.body?.username || '').trim();
      const password = String(req.body?.password || '');
      if (!username || !password) throw badRequest('請輸入帳號與密碼');
      const [[user]] = await pool.query(`SELECT u.*, r.role_code, r.role_name FROM access_users u JOIN access_roles r ON r.id=u.role_id WHERE u.username=?`, [username]);
      if (!user || !user.is_active || !verifyPassword(password, user.password_hash)) throw unauthorized('帳號或密碼錯誤');
      const currentSource = await defaultSourceForUser(user);
      const token = crypto.randomBytes(48).toString('base64url');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      // 僅清除過期連線；允許同一使用者同時開啟多個 ERP 分頁，
      // 避免重新登入或另一分頁登入時，讓既有分頁突然失效並顯示空資料。
      await pool.query('DELETE FROM access_sessions WHERE expires_at <= NOW()');
      await pool.query('INSERT INTO access_sessions (user_id, token_hash, expires_at, current_source_key) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR), ?)', [user.id, tokenHash, SESSION_HOURS, currentSource]);
      res.json({ ok: true, data: { token, user: { id:user.id, username:user.username, display_name:user.display_name, employee_code:user.employee_code, role_id:user.role_id, role_code:user.role_code, role_name:user.role_name, current_source_key:currentSource, force_password_change:Boolean(user.force_password_change) } } });
    } catch (error) { next(error); }
  });

  app.get('/api/auth/me', (req, res) => res.json({ ok:true, data:req.auth }));
  app.post('/api/auth/context', async (req, res, next) => {
    try {
      const sourceKey = normalizeSourceKey(req.body?.source_key || req.body?.source_database);
      const source = sourceKey ? sourceDatabases[sourceKey] : null;
      if (!source || !source.enabled) throw badRequest('指定的公司別／資料來源不存在或尚未啟用');
      if (!(await hasSourceAccess(req.auth.id, req.auth.role_code, sourceKey))) {
        throw forbidden('您沒有此公司別的存取權限');
      }
      await pool.query('UPDATE access_sessions SET current_source_key=?, context_changed_at=NOW() WHERE id=? AND user_id=?', [sourceKey, req.auth.session_id, req.auth.id]);
      await recordAccessAudit({
        actorUserId:req.auth.id, targetUserId:req.auth.id, actionCode:'COMPANY_CONTEXT_SWITCHED', entityType:'session',
        entityId:req.auth.session_id, sourceKey, before:{source_key:req.auth.current_source_key||null},
        after:{source_key:sourceKey}, reason:'登入工作階段正式切換公司別', ipAddress:req.ip, userAgent:req.get('user-agent')
      });
      req.auth.current_source_key = sourceKey;
      req.auth.current_company_id = source.company_id || null;
      res.json({ ok:true, data:{
        context_key:sourceKey, source_database:sourceKey, tenant_id:source.tenant_id,
        company_id:source.company_id, source_system:source.source_system,
        target_database:source.target_database, label:source.label, read_only:source.read_only
      } });
    } catch (error) { next(error); }
  });
  app.get('/api/auth/access', async (req, res, next) => {
    try {
      if (req.auth.role_code === 'ADMIN') return res.json({ ok:true, data:{ is_admin:true, permissions:[], allowed_sources:['*'], department_scopes:[] } });
      const [permissions] = await pool.query(`SELECT feature_code,can_view,can_create,can_update,can_delete,can_approve
        FROM access_role_permissions WHERE role_id=?`, [req.auth.role_id]);
      const scope = await getUserAccessScope(req.auth.id, req.auth.role_code);
      res.json({ ok:true, data:{ is_admin:false, permissions, ...scope } });
    } catch (error) { next(error); }
  });
  app.post('/api/auth/admin-reset-password', async (req, res, next) => {
    try {
      if (req.auth?.role_code !== 'ADMIN') throw forbidden('僅系統管理員可重設密碼');
      const userId = Number(req.body?.user_id);
      const newPassword = String(req.body?.new_password || '');
      if (!Number.isInteger(userId) || userId < 1 || newPassword.length < 8) {
        throw badRequest('請選擇帳號並輸入至少 8 碼的新密碼');
      }
      const [[target]] = await pool.query('SELECT id FROM access_users WHERE id=? AND is_active=1', [userId]);
      if (!target) throw badRequest('指定帳號不存在或已停用');
      await pool.query(`UPDATE access_users SET password_hash=?, force_password_change=1 WHERE id=?`, [hashPassword(newPassword), userId]);
      await pool.query('DELETE FROM access_sessions WHERE user_id=? AND id<>?', [userId, req.auth.session_id]);
      await pool.query(`UPDATE access_password_reset_requests
        SET status='completed', completed_at=NOW(), completed_by=?
        WHERE user_id=? AND status='pending'`, [req.auth.id, userId]);
      await recordAccessAudit({
        actorUserId:req.auth.id, targetUserId:userId, actionCode:'PASSWORD_RESET', entityType:'access_user', entityId:userId,
        reason:'系統管理員重設登入密碼', ipAddress:req.ip, userAgent:req.get('user-agent')
      });
      res.json({ ok:true, data:{ id:userId } });
    } catch (error) { next(error); }
  });

  app.post('/api/auth/logout', async (req, res, next) => {
    try { await pool.query('DELETE FROM access_sessions WHERE id=?', [req.auth.session_id]); res.json({ ok:true, data:{} }); } catch (error) { next(error); }
  });
}

export { hashPassword };
