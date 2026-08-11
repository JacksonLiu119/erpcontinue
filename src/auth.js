import crypto from 'node:crypto';
import { pool, ensureProcurementSchema } from './db.js';

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

export async function authMiddleware(req, _res, next) {
  try {
    if (req.path === '/auth/login') return next();
    const token = tokenFrom(req);
    if (!token) throw unauthorized();
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const [[user]] = await pool.query(`SELECT u.id, u.username, u.employee_code, u.display_name, u.role_id, u.is_active,
      r.role_code, r.role_name, s.id AS session_id
      FROM access_sessions s JOIN access_users u ON u.id=s.user_id JOIN access_roles r ON r.id=u.role_id
      WHERE s.token_hash=? AND s.expires_at>NOW()`, [hash]);
    if (!user || !user.is_active) throw unauthorized('登入已失效，請重新登入');
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
  [/^\/import\//, 'import-monitor'],
  [/^\/inventory-opening/, 'inventory-opening'],
  [/^\/sales-workflow\/document-types/, 'sales-document-types'],
  [/^\/sales-workflow\/order-changes/, 'sales-order-changes'],
  [/^\/sales-workflow\/progress/, 'sales-progress'],
  [/^\/sales-workflow\/documents/, 'sales-orders'], [/^\/sales-workflow\/items/, 'sales-orders'],
  [/^\/finance-workflow\//, 'finance-workflow'],
  [/^\/inventory-workflow\/document-types/, 'inventory-document-types'],
  [/^\/inventory-workflow\/procurement/, 'inventory-posting'],
  [/^\/inventory-workflow\/documents\/\d+\/(approve|post)/, 'inventory-posting'],
  [/^\/inventory-workflow\/documents/, 'inventory-transactions'],
  [/^\/inventory-workflow\/balances/, 'inventory-new-balance'], [/^\/inventory-workflow\/ledger/, 'inventory-new-ledger'],
  [/^\/sh\/basic-data/, 'basicdata'], [/^\/sh\/warehouses/, 'warehouses'], [/^\/sh\/departments/, 'departments'],
  [/^\/sh\/employees/, 'employees'], [/^\/sh\/customers/, 'source-customers'], [/^\/sh\/suppliers/, 'source-suppliers'],
  [/^\/sh\/inventory-details/, 'inventory-detail'], [/^\/sh\/inventory-ledger/, 'inventory-ledger'],
  [/^\/sh\/inventory-balance/, 'inventory-balance'], [/^\/sh\/inventory-movement-stats/, 'inventory-movement-stats'],
  [/^\/sh\/department-movement-stats/, 'department-movement-stats'], [/^\/sh\/purchase-receipts/, 'purchase-receipts'],
  [/^\/procurement\/document-types/, 'procurement-document-types'],
  [/^\/procurement\/(requisition-maintenance|requisition-lines\/\d+\/(maintenance|convert))/, 'requisition-maintenance'],
  [/^\/procurement\/order-changes/, 'purchase-order-changes'],
  [/^\/procurement\/(pending-inspections|receipts\/\d+\/inspect)/, 'receipt-inspection'],
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
    const action = /\/(approve|post)$/.test(req.path) ? 'can_approve' : req.method === 'GET' ? 'can_view' : req.method === 'POST' ? 'can_create' : req.method === 'PUT' || req.method === 'PATCH' ? 'can_update' : req.method === 'DELETE' ? 'can_delete' : 'can_view';
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
      const token = crypto.randomBytes(48).toString('base64url');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      await pool.query('DELETE FROM access_sessions WHERE expires_at <= NOW() OR user_id=?', [user.id]);
      await pool.query('INSERT INTO access_sessions (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))', [user.id, tokenHash, SESSION_HOURS]);
      res.json({ ok: true, data: { token, user: { id:user.id, username:user.username, display_name:user.display_name, employee_code:user.employee_code, role_id:user.role_id, role_code:user.role_code, role_name:user.role_name, force_password_change:Boolean(user.force_password_change) } } });
    } catch (error) { next(error); }
  });

  app.get('/api/auth/me', (req, res) => res.json({ ok:true, data:req.auth }));
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
      res.json({ ok:true, data:{ id:userId } });
    } catch (error) { next(error); }
  });

  app.post('/api/auth/logout', async (req, res, next) => {
    try { await pool.query('DELETE FROM access_sessions WHERE id=?', [req.auth.session_id]); res.json({ ok:true, data:{} }); } catch (error) { next(error); }
  });
}

export { hashPassword };
