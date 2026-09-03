import crypto from 'node:crypto';
import { pool, sourceDatabases } from './db.js';

function unauthorized(message = 'n8n API 金鑰不正確') {
  const error = new Error(message);
  error.status = 401;
  return error;
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function apiKeyFrom(req) {
  const headerKey = String(req.headers['x-n8n-api-key'] || '').trim();
  const authorization = String(req.headers.authorization || '');
  return headerKey || (authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '');
}

function safeEqual(actual, expected) {
  const left = Buffer.from(String(actual));
  const right = Buffer.from(String(expected));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function taipeiDate(offsetDays = 0) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date()).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  const taipeiTodayUtc = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`);
  taipeiTodayUtc.setUTCDate(taipeiTodayUtc.getUTCDate() + offsetDays);
  return taipeiTodayUtc.toISOString().slice(0, 10);
}

function reportRange(query) {
  const period = String(query.period || 'daily').toLowerCase();
  const today = taipeiDate();
  const yesterday = taipeiDate(-1);
  let dateFrom;
  let dateTo;
  if (period === 'year') {
    dateFrom = `${today.slice(0, 4)}-01-01`;
    dateTo = today;
  } else if (period === 'weekly') {
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay() || 7;
    dateFrom = taipeiDate(-(weekday - 1));
    dateTo = yesterday < dateFrom ? today : yesterday;
  } else if (period === 'daily') {
    dateFrom = String(query.date || yesterday);
    dateTo = dateFrom;
  } else if (period === 'custom') {
    dateFrom = String(query.date_from || '');
    dateTo = String(query.date_to || '');
  } else {
    throw badRequest('period 必須是 daily、weekly、year 或 custom');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    throw badRequest('日期必須是 YYYY-MM-DD');
  }
  if (dateFrom > dateTo) throw badRequest('date_from 不可晚於 date_to');
  return { period, dateFrom, dateTo, label: dateFrom === dateTo ? dateFrom : `${dateFrom} ～ ${dateTo}` };
}

function number(value) { return Number(value || 0); }
function money(value) { return number(value).toLocaleString('zh-TW', { maximumFractionDigits: 2 }); }
function quantity(value) { return number(value).toLocaleString('zh-TW', { maximumFractionDigits: 3 }); }

function htmlReport(data) {
  const { report_label: date, company, summary } = data;
  const row = (label, count, amount, amountLabel = '金額') =>
    `<tr><td>${label}</td><td style="text-align:right">${count.toLocaleString('zh-TW')}</td><td style="text-align:right">${amountLabel} ${money(amount)}</td></tr>`;
  return `<!doctype html><html lang="zh-Hant"><body style="font-family:Arial,'Microsoft JhengHei',sans-serif;color:#172033">
    <h2>${company.name}｜ERP 營運報表</h2>
    <p>報表日期：${date}（Asia/Taipei）</p>
    <table style="border-collapse:collapse;min-width:560px" border="1" cellpadding="8">
      <thead style="background:#eef3f8"><tr><th>項目</th><th>筆數</th><th>數量／金額</th></tr></thead>
      <tbody>
        ${row('銷售出貨', summary.sales.count, summary.sales.amount)}
        ${row('採購入庫', summary.purchases.count, summary.purchases.amount)}
        ${row('庫存異動', summary.inventory.movements, summary.inventory.quantity_delta, '淨異動量')}
        ${row('負庫存項目', summary.inventory.negative_items, summary.inventory.negative_quantity, '負庫存量')}
        ${row('未結應收', summary.finance.ar.count, summary.finance.ar.balance)}
        ${row('未結應付', summary.finance.ap.count, summary.finance.ap.balance)}
      </tbody>
    </table>
    <p style="color:#64748b;font-size:12px">本信由 ERP → n8n 自動產生；資料來源：${company.source_database}。</p>
  </body></html>`;
}

async function dailyReport(sourceDatabase, range) {
  const source = sourceDatabases[sourceDatabase];
  if (!source) throw badRequest(`找不到或未啟用資料來源：${sourceDatabase}`);
  const context = [source.tenant_id, source.company_id, source.source_system, sourceDatabase];
  const [salesRows, purchaseRows, movementRows, negativeRows, financeRows, companyRows] = await Promise.all([
    pool.query(`SELECT COUNT(DISTINCT d.id) count, COALESCE(SUM(i.quantity * i.unit_price - i.allowance_amount),0) amount
      FROM sales_documents d JOIN sales_document_items i ON i.document_id=d.id
      WHERE d.tenant_id=? AND d.company_id=? AND d.source_system=? AND d.source_database=?
        AND d.document_kind='shipment' AND d.document_date BETWEEN ? AND ? AND d.status NOT IN ('draft','voided')`, [...context, range.dateFrom, range.dateTo]),
    pool.query(`SELECT COUNT(DISTINCT r.id) count, COALESCE(SUM(i.qty_accepted * i.unit_cost),0) amount
      FROM procurement_receipts r JOIN procurement_receipt_items i ON i.receipt_id=r.id
      WHERE r.tenant_id=? AND r.company_id=? AND r.source_system=? AND r.source_database=?
        AND r.receipt_date BETWEEN ? AND ? AND r.status NOT IN ('draft','voided','rejected')`, [...context, range.dateFrom, range.dateTo]),
    pool.query(`SELECT COUNT(*) movements, COALESCE(SUM(quantity_delta),0) quantity_delta
      FROM inventory_movement_ledger WHERE tenant_id=? AND company_id=? AND source_system=? AND movement_date BETWEEN ? AND ?`,
      [source.tenant_id, source.company_id, source.source_system, range.dateFrom, range.dateTo]),
    pool.query(`SELECT COUNT(*) negative_items, COALESCE(SUM(quantity_on_hand),0) negative_quantity
      FROM erp_inventory_balances WHERE tenant_id=? AND company_id=? AND source_system=? AND quantity_on_hand<0`,
      [source.tenant_id, source.company_id, source.source_system]),
    pool.query(`SELECT account_type, COUNT(*) count, COALESCE(SUM(balance_amount),0) balance
      FROM finance_open_items WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=?
        AND status IN ('approved','open','partial') GROUP BY account_type`, context),
    pool.query(`SELECT company_name, short_name FROM erp_companies
      WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? ORDER BY id LIMIT 1`, context)
  ]);
  const finance = Object.fromEntries(financeRows[0].map(row => [row.account_type, row]));
  const company = companyRows[0][0];
  const data = {
    period: range.period,
    date_from: range.dateFrom,
    date_to: range.dateTo,
    report_label: range.label,
    timezone: 'Asia/Taipei',
    generated_at: new Date().toISOString(),
    company: {
      source_database: sourceDatabase,
      company_id: source.company_id,
      name: company?.company_name || company?.short_name || source.label
    },
    summary: {
      sales: { count: number(salesRows[0][0].count), amount: number(salesRows[0][0].amount) },
      purchases: { count: number(purchaseRows[0][0].count), amount: number(purchaseRows[0][0].amount) },
      inventory: {
        movements: number(movementRows[0][0].movements), quantity_delta: number(movementRows[0][0].quantity_delta),
        negative_items: number(negativeRows[0][0].negative_items), negative_quantity: number(negativeRows[0][0].negative_quantity)
      },
      finance: {
        ar: { count: number(finance.AR?.count), balance: number(finance.AR?.balance) },
        ap: { count: number(finance.AP?.count), balance: number(finance.AP?.balance) }
      }
    }
  };
  return { ...data, subject: `[ERP營運報表] ${data.company.name} ${range.label}`, html: htmlReport(data) };
}

export function registerN8nRoutes(app) {
  app.get('/api/integrations/n8n/daily-report', async (req, res, next) => {
    try {
      const expected = String(process.env.N8N_API_KEY || '').trim();
      if (!expected) throw unauthorized('伺服器尚未設定 N8N_API_KEY');
      if (!safeEqual(apiKeyFrom(req), expected)) throw unauthorized();
      const sourceDatabase = String(req.query.source_database || 'SH').trim().toUpperCase();
      res.json({ ok: true, data: await dailyReport(sourceDatabase, reportRange(req.query)) });
    } catch (error) { next(error); }
  });
}
