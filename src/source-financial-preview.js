import { getSourcePool, sourceDatabases } from './db.js';

const EPS = 0.000001;

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function text(value) {
  return String(value ?? '').trim();
}

function number(value) {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function validDate(value, fallback) {
  const result = text(value) || fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw badRequest(`日期格式錯誤：${result}`);
  const parsed = new Date(`${result}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) throw badRequest(`日期不存在：${result}`);
  return result;
}

function periodRange(value) {
  const period = text(value);
  if (!period) return null;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw badRequest(`會計期間格式錯誤：${period}`);
  const [year, month] = period.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { period, from: `${year}-${String(month).padStart(2, '0')}-01`, to: `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}` };
}

function statementMonthRange(fromDate, toDate) {
  const from = new Date(`${fromDate}T00:00:00Z`);
  const to = new Date(`${toDate}T00:00:00Z`);
  const lastDay = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() + 1, 0)).getUTCDate();
  if (from.getUTCFullYear() !== to.getUTCFullYear() || from.getUTCDate() !== 1 || to.getUTCDate() !== lastDay) return null;
  const fromMonth = String(from.getUTCMonth() + 1).padStart(2, '0');
  const toMonth = String(to.getUTCMonth() + 1).padStart(2, '0');
  const previousMonth = String(Math.max(from.getUTCMonth(), 0)).padStart(2, '0');
  return { year: String(from.getUTCFullYear()), fromMonth, toMonth, previousMonth };
}

function sourceCompany(sourceName) {
  return text(sourceDatabases[sourceName]?.company_id || sourceName).toUpperCase();
}

function sourceDate(value) {
  const valueText = text(value);
  return /^\d{8}$/.test(valueText) ? `${valueText.slice(0, 4)}-${valueText.slice(4, 6)}-${valueText.slice(6, 8)}` : valueText;
}

function sourceKey(company, documentType, documentNo, lineNo = '') {
  const voucher = `ACTTA:${company}:${documentType}/${documentNo}`;
  return lineNo ? `${voucher}|ACTTB:${company}:${documentType}/${documentNo}/${lineNo}` : voucher;
}

function isCashAccount(accountCode, accountName) {
  const code = text(accountCode).replaceAll(' ', '');
  const name = text(accountName);
  if (/(應收|應付|票據|借款|貸款)/.test(name)) return false;
  return /^111[1-3]/.test(code) || /(現金|銀行|活存|甲存|定存|存款|零用金)/.test(name);
}

function classifyCashCounterpart(row) {
  const name = text(row.account_name);
  const code = text(row.account_code);
  if (!name && !code) return 'unclassified';
  if (/(固定資產|設備|土地|房屋|建築|機器|車輛|長期投資|無形資產|專利|工程款|在建工程)/.test(name) || /^(14|15|16)/.test(code)) return 'investing';
  if (/(借款|股本|資本|股東|股利|長期負債|租賃負債|應付票據)/.test(name) || /^(21[1-6]|22)/.test(code)) return 'financing';
  if (/(現金|銀行|存款|活存|甲存|定存)/.test(name)) return 'unclassified';
  return 'operating';
}

async function assertSourceTables(connection) {
  const [rows] = await connection.query(`
    SELECT LOWER(TABLE_NAME) AS table_name
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND LOWER(TABLE_NAME) IN ('actma','actta','acttb')
  `);
  const found = new Set(rows.map(row => String(row.table_name).toLowerCase()));
  const missing = ['actma', 'actta', 'acttb'].filter(table => !found.has(table));
  if (missing.length) throw badRequest(`來源資料庫缺少會計總帳必要資料表：${missing.join('、')}`);
  return found;
}

function accountStatementRow(row) {
  const direction = text(row.report_direction) === '-1' ? -1 : 1;
  const debit = number(row.debit_amount);
  const credit = number(row.credit_amount);
  const reportAmount = direction === -1 ? credit - debit : debit - credit;
  return {
    account_code: text(row.account_code),
    account_name: text(row.account_name) || '未命名科目',
    parent_code: text(row.parent_code),
    account_nature: text(row.account_nature),
    statement_class: text(row.statement_class),
    report_direction: direction === -1 ? 'credit' : 'debit',
    debit_amount: debit,
    credit_amount: credit,
    report_amount: reportAmount,
    line_kind: direction === -1 ? 'revenue' : 'expense',
    voucher_count: Number(row.voucher_count || 0),
    source_table: text(row.source_table) || 'ACTMA／ACTTA／ACTTB',
    source_key: text(row.source_key) || `ACTMA:${text(row.company)}:${text(row.account_code)}`,
  };
}

function balanceSheetRow(row) {
  const direction = text(row.report_direction) === '-1' ? -1 : 1;
  const accountCode = text(row.account_code);
  const section = accountCode.startsWith('1') ? 'assets' : accountCode.startsWith('2') ? 'liabilities' : accountCode.startsWith('3') ? 'equity' : 'other';
  const values = ['opening', 'period', 'ending'].reduce((out, key) => {
    const debit = number(row[`${key}_debit`]);
    const credit = number(row[`${key}_credit`]);
    out[`${key}_debit`] = debit;
    out[`${key}_credit`] = credit;
    // 資產表上的資產以借餘為正、負債／權益以貸餘為正；
    // 因此資產類的備抵科目仍會以負數呈現，不會把貸方備抵加成資產。
    out[`${key}_balance`] = section === 'assets' ? debit - credit : credit - debit;
    out[`${key}_signed_balance`] = debit - credit;
    return out;
  }, {});
  return {
    account_code: accountCode,
    account_name: text(row.account_name) || '未命名科目',
    parent_code: text(row.parent_code),
    account_nature: text(row.account_nature),
    statement_class: text(row.statement_class),
    report_direction: direction === -1 ? 'credit' : 'debit',
    section,
    ...values,
    voucher_count: Number(row.voucher_count || 0),
    source_table: text(row.source_table) || 'ACTMA／ACTTA／ACTTB',
    source_key: text(row.source_key) || `ACTMA:${text(row.company)}:${accountCode}`,
  };
}

function summarizeProfitAndLoss(rows) {
  const revenue = rows.filter(row => row.line_kind === 'revenue').reduce((sum, row) => sum + row.report_amount, 0);
  const expense = rows.filter(row => row.line_kind === 'expense').reduce((sum, row) => sum + row.report_amount, 0);
  return { revenue, expense, net_income: revenue - expense, row_count: rows.length };
}

function summarizeBalanceSheet(rows) {
  const total = section => rows.filter(row => row.section === section).reduce((sum, row) => sum + row.ending_balance, 0);
  const assets = total('assets');
  const liabilities = total('liabilities');
  const equity = total('equity');
  const other = total('other');
  return { assets, liabilities, equity, other, balance_difference: assets - liabilities - equity, row_count: rows.length };
}

function buildCashFlow(lineRows, cashBalanceRows, company) {
  const categoryNames = { operating: '營業活動', investing: '投資活動', financing: '籌資活動', unclassified: '未分類／待對照' };
  const categories = Object.fromEntries(Object.keys(categoryNames).map(key => [key, { category: key, category_name: categoryNames[key], inflow: 0, outflow: 0, net: 0, voucher_count: 0 }]));
  const groups = new Map();
  for (const row of lineRows) {
    const key = `${text(row.doc_type)}|${text(row.doc_no)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const details = [];
  let internalTransferCount = 0;
  let unclassifiedVoucherCount = 0;
  let cashVoucherCount = 0;
  for (const rows of groups.values()) {
    const cashRows = rows.filter(row => isCashAccount(row.account_code, row.account_name));
    if (!cashRows.length) continue;
    cashVoucherCount += 1;
    const counterpartRows = rows.filter(row => !isCashAccount(row.account_code, row.account_name));
    const inflow = cashRows.reduce((sum, row) => sum + (text(row.dc) === '1' ? number(row.amount) : 0), 0);
    const outflow = cashRows.reduce((sum, row) => sum + (text(row.dc) === '-1' ? number(row.amount) : 0), 0);
    if (!counterpartRows.length && inflow > EPS && outflow > EPS) {
      internalTransferCount += 1;
      continue;
    }
    const counterpartTotal = counterpartRows.reduce((sum, row) => sum + number(row.amount), 0);
    const allocations = counterpartTotal > EPS
      ? counterpartRows.map(row => ({ row, category: classifyCashCounterpart(row), ratio: number(row.amount) / counterpartTotal }))
      : [{ row: null, category: 'unclassified', ratio: 1 }];
    const allocationCategories = new Set(allocations.map(item => item.category));
    if (allocationCategories.has('unclassified')) unclassifiedVoucherCount += 1;
    for (const allocation of allocations) {
      const category = categories[allocation.category] || categories.unclassified;
      const allocatedInflow = inflow * allocation.ratio;
      const allocatedOutflow = outflow * allocation.ratio;
      category.inflow += allocatedInflow;
      category.outflow += allocatedOutflow;
      category.net += allocatedInflow - allocatedOutflow;
      category.voucher_count += 1;
      const first = rows[0];
      details.push({
        category: category.category,
        category_name: category.category_name,
        document_date: sourceDate(first.doc_date),
        document_type: text(first.doc_type),
        document_no: text(first.doc_no),
        counterpart_account_code: text(allocation.row?.account_code),
        counterpart_account_name: text(allocation.row?.account_name) || '無對應科目',
        inflow: allocatedInflow,
        outflow: allocatedOutflow,
        net: allocatedInflow - allocatedOutflow,
        source_table: 'ACTTA／ACTTB',
        source_key: sourceKey(company, allocation.row?.doc_type || first.doc_type, allocation.row?.doc_no || first.doc_no, allocation.row?.line_no || first.line_no),
        source_document_key: sourceKey(company, first.doc_type, first.doc_no),
      });
    }
  }
  const cashAccounts = cashBalanceRows.filter(row => isCashAccount(row.account_code, row.account_name));
  const openingCash = cashAccounts.reduce((sum, row) => sum + number(row.opening_balance), 0);
  const endingCash = cashAccounts.reduce((sum, row) => sum + number(row.ending_balance), 0);
  const cashChange = endingCash - openingCash;
  const classifiedNetChange = Object.values(categories).filter(row => row.category !== 'unclassified').reduce((sum, row) => sum + row.net, 0);
  const totalNetChange = Object.values(categories).reduce((sum, row) => sum + row.net, 0);
  return {
    categories: Object.values(categories),
    details: details.sort((a, b) => String(b.document_date).localeCompare(String(a.document_date)) || String(b.document_no).localeCompare(String(a.document_no))),
    cash_account_count: cashAccounts.length,
    cash_voucher_count: cashVoucherCount,
    internal_transfer_count: internalTransferCount,
    unclassified_voucher_count: unclassifiedVoucherCount,
    opening_cash: openingCash,
    ending_cash: endingCash,
    cash_change: cashChange,
    classified_net_change: classifiedNetChange,
    unclassified_net_change: totalNetChange - classifiedNetChange,
    classification_difference: cashChange - classifiedNetChange,
    reconciliation_difference: cashChange - totalNetChange,
    classification_method: '依現金／銀行科目與對方科目名稱／科目代號推導；未設定正式現金流量性質的項目列入未分類／待對照。',
  };
}

function sumRows(rows, key) {
  return rows.reduce((sum, row) => sum + number(row[key]), 0);
}

export function registerSourceFinancialPreviewRoutes(app) {
  app.get('/api/accounting/source-financial-preview', async (req, res, next) => {
    try {
      const sourceName = text(req.query.source_database || req.get('X-Source-Database') || 'SC').toUpperCase();
      const source = sourceDatabases[sourceName];
      if (!source) throw badRequest(`找不到資料來源：${sourceName}`);
      const sourceCompanyCode = sourceCompany(sourceName);
      const selectedPeriod = periodRange(req.query.period);
      const fromDate = selectedPeriod?.from || validDate(req.query.from_date, '2025-01-01');
      const toDate = selectedPeriod?.to || validDate(req.query.to_date, '2025-12-31');
      if (fromDate > toDate) throw badRequest('日期起日不可晚於迄日');
      const currencyCode = text(req.query.currency_code).toUpperCase();
      const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
      const connection = getSourcePool(sourceName);
      await assertSourceTables(connection);
      const fromKey = fromDate.replaceAll('-', '');
      const toKey = toDate.replaceAll('-', '');
      const amountExpression = 'ABS(COALESCE(NULLIF(b.TB015,0),b.TB007,0))';
      const validHeader = `t.COMPANY=? AND t.TA003 REGEXP '^[0-9]{8}$' AND t.TA003 BETWEEN ? AND ? AND TRIM(COALESCE(t.TA010,''))='Y' AND TRIM(COALESCE(t.TA011,''))='Y' AND COALESCE(NULLIF(TRIM(t.TA016),''),'N')<>'Y'`;
      const currencyFilter = currencyCode ? ' AND TRIM(COALESCE(b.TB013,\'\'))=?' : '';
      const currencyParams = currencyCode ? [currencyCode] : [];
      const monthlyScope = sourceTables.has('actmb') ? statementMonthRange(fromDate, toDate) : null;
      const monthlyCurrencyFilter = currencyCode ? ' AND TRIM(COALESCE(m.MB008,\'\'))=?' : '';
      const monthlyCurrencyParams = currencyCode ? [currencyCode] : [];
      const profitQuery = monthlyScope
        ? [
          `SELECT m.COMPANY company,m.MB002 fiscal_year,a.MA001 account_code,MAX(a.MA002) parent_code,MAX(a.MA003) account_name,MAX(a.MA005) account_nature,MAX(a.MA006) statement_class,MAX(a.MA007) report_direction,COALESCE(SUM(COALESCE(m.MB006,0)+COALESCE(m.MB007,0)),0) voucher_count,COALESCE(SUM(m.MB004),0) debit_amount,COALESCE(SUM(m.MB005),0) credit_amount,'ACTMA／ACTMB' source_table,CONCAT('ACTMB:',TRIM(m.COMPANY),':',TRIM(m.MB002),':',TRIM(a.MA001)) source_key FROM actmb m JOIN actma a ON a.COMPANY=m.COMPANY AND a.MA001=m.MB001 WHERE m.COMPANY=? AND m.MB002=? AND m.MB003 BETWEEN '${monthlyScope.fromMonth}' AND '${monthlyScope.toMonth}'${monthlyCurrencyFilter} AND TRIM(a.MA006)='2' AND TRIM(a.MA008) IN ('2','3') GROUP BY m.COMPANY,m.MB002,a.MA001 ORDER BY a.MA001`,
          [sourceCompanyCode, monthlyScope.year, ...monthlyCurrencyParams],
        ]
        : [
          `SELECT a.COMPANY company, a.MA001 account_code,MAX(a.MA002) parent_code,MAX(a.MA003) account_name,MAX(a.MA005) account_nature,MAX(a.MA006) statement_class,MAX(a.MA007) report_direction,COUNT(DISTINCT CONCAT(TRIM(t.TA001),'/',TRIM(t.TA002))) voucher_count,COALESCE(SUM(CASE WHEN TRIM(b.TB004)='1' THEN ${amountExpression} ELSE 0 END),0) debit_amount,COALESCE(SUM(CASE WHEN TRIM(b.TB004)='-1' THEN ${amountExpression} ELSE 0 END),0) credit_amount FROM actma a JOIN acttb b ON b.COMPANY=a.COMPANY AND b.TB005=a.MA001 JOIN actta t ON t.COMPANY=b.COMPANY AND t.TA001=b.TB001 AND t.TA002=b.TB002 WHERE ${validHeader}${currencyFilter} AND TRIM(a.MA006)='2' GROUP BY a.COMPANY,a.MA001 ORDER BY a.MA001`,
          [sourceCompanyCode, fromKey, toKey, ...currencyParams],
        ];
      const balanceQuery = monthlyScope
        ? [
          `SELECT m.COMPANY company,m.MB002 fiscal_year,a.MA001 account_code,MAX(a.MA002) parent_code,MAX(a.MA003) account_name,MAX(a.MA005) account_nature,MAX(a.MA006) statement_class,MAX(a.MA007) report_direction,COALESCE(SUM(CASE WHEN m.MB003 BETWEEN '${monthlyScope.fromMonth}' AND '${monthlyScope.toMonth}' THEN COALESCE(m.MB006,0)+COALESCE(m.MB007,0) ELSE 0 END),0) voucher_count,COALESCE(SUM(CASE WHEN m.MB003='00' OR m.MB003 BETWEEN '01' AND '${monthlyScope.previousMonth}' THEN m.MB004 ELSE 0 END),0) opening_debit,COALESCE(SUM(CASE WHEN m.MB003='00' OR m.MB003 BETWEEN '01' AND '${monthlyScope.previousMonth}' THEN m.MB005 ELSE 0 END),0) opening_credit,COALESCE(SUM(CASE WHEN m.MB003 BETWEEN '${monthlyScope.fromMonth}' AND '${monthlyScope.toMonth}' THEN m.MB004 ELSE 0 END),0) period_debit,COALESCE(SUM(CASE WHEN m.MB003 BETWEEN '${monthlyScope.fromMonth}' AND '${monthlyScope.toMonth}' THEN m.MB005 ELSE 0 END),0) period_credit,COALESCE(SUM(CASE WHEN m.MB003='00' OR m.MB003 BETWEEN '01' AND '${monthlyScope.toMonth}' THEN m.MB004 ELSE 0 END),0) ending_debit,COALESCE(SUM(CASE WHEN m.MB003='00' OR m.MB003 BETWEEN '01' AND '${monthlyScope.toMonth}' THEN m.MB005 ELSE 0 END),0) ending_credit,'ACTMA／ACTMB' source_table,CONCAT('ACTMB:',TRIM(m.COMPANY),':',TRIM(m.MB002),':',TRIM(a.MA001)) source_key FROM actmb m JOIN actma a ON a.COMPANY=m.COMPANY AND a.MA001=m.MB001 WHERE m.COMPANY=? AND m.MB002=? AND (m.MB003='00' OR m.MB003 BETWEEN '01' AND '${monthlyScope.toMonth}')${monthlyCurrencyFilter} AND TRIM(a.MA006)='1' AND TRIM(a.MA008) IN ('2','3') GROUP BY m.COMPANY,m.MB002,a.MA001 ORDER BY a.MA001`,
          [sourceCompanyCode, monthlyScope.year, ...monthlyCurrencyParams],
        ]
        : [
          `SELECT a.COMPANY company,a.MA001 account_code,MAX(a.MA002) parent_code,MAX(a.MA003) account_name,MAX(a.MA005) account_nature,MAX(a.MA006) statement_class,MAX(a.MA007) report_direction,COUNT(DISTINCT CONCAT(TRIM(t.TA001),'/',TRIM(t.TA002))) voucher_count,
            COALESCE(SUM(CASE WHEN t.TA003<? AND TRIM(b.TB004)='1' THEN ${amountExpression} ELSE 0 END),0) opening_debit,
            COALESCE(SUM(CASE WHEN t.TA003<? AND TRIM(b.TB004)='-1' THEN ${amountExpression} ELSE 0 END),0) opening_credit,
            COALESCE(SUM(CASE WHEN t.TA003 BETWEEN ? AND ? AND TRIM(b.TB004)='1' THEN ${amountExpression} ELSE 0 END),0) period_debit,
            COALESCE(SUM(CASE WHEN t.TA003 BETWEEN ? AND ? AND TRIM(b.TB004)='-1' THEN ${amountExpression} ELSE 0 END),0) period_credit,
            COALESCE(SUM(CASE WHEN t.TA003<=? AND TRIM(b.TB004)='1' THEN ${amountExpression} ELSE 0 END),0) ending_debit,
            COALESCE(SUM(CASE WHEN t.TA003<=? AND TRIM(b.TB004)='-1' THEN ${amountExpression} ELSE 0 END),0) ending_credit
          FROM actma a JOIN acttb b ON b.COMPANY=a.COMPANY AND b.TB005=a.MA001 JOIN actta t ON t.COMPANY=b.COMPANY AND t.TA001=b.TB001 AND t.TA002=b.TB002
          WHERE t.COMPANY=? AND t.TA003 REGEXP '^[0-9]{8}$' AND t.TA003<=? AND TRIM(COALESCE(t.TA010,''))='Y' AND TRIM(COALESCE(t.TA011,''))='Y' AND COALESCE(NULLIF(TRIM(t.TA016),''),'N')<>'Y'${currencyCode ? ' AND TRIM(COALESCE(b.TB013,\'\'))=?' : ''} AND TRIM(a.MA006)='1'
          GROUP BY a.COMPANY,a.MA001 ORDER BY a.MA001`,
          [fromKey, fromKey, fromKey, toKey, fromKey, toKey, toKey, toKey, sourceCompanyCode, toKey, ...currencyParams],
        ];
      const [headerResult, lineResult, lineResultAll, profitResult, balanceResult, sourceLinesResult, cashBalanceResult, periodResult, currencyResult] = await Promise.all([
        connection.query(`SELECT COUNT(*) valid_voucher_count,COALESCE(SUM(t.TA007),0) header_debit,COALESCE(SUM(t.TA008),0) header_credit FROM actta t WHERE ${validHeader}`, [sourceCompanyCode, fromKey, toKey]),
        connection.query(`SELECT COUNT(*) line_count,COUNT(DISTINCT CONCAT(TRIM(b.TB001),'/',TRIM(b.TB002))) voucher_count,COALESCE(SUM(CASE WHEN TRIM(b.TB004)='1' THEN ${amountExpression} ELSE 0 END),0) debit_amount,COALESCE(SUM(CASE WHEN TRIM(b.TB004)='-1' THEN ${amountExpression} ELSE 0 END),0) credit_amount FROM actta t JOIN acttb b ON b.COMPANY=t.COMPANY AND b.TB001=t.TA001 AND b.TB002=t.TA002 WHERE ${validHeader}${currencyFilter}`, [sourceCompanyCode, fromKey, toKey, ...currencyParams]),
        connection.query(`SELECT COUNT(*) line_count,COUNT(DISTINCT CONCAT(TRIM(b.TB001),'/',TRIM(b.TB002))) voucher_count,COALESCE(SUM(CASE WHEN TRIM(b.TB004)='1' THEN ${amountExpression} ELSE 0 END),0) debit_amount,COALESCE(SUM(CASE WHEN TRIM(b.TB004)='-1' THEN ${amountExpression} ELSE 0 END),0) credit_amount FROM actta t JOIN acttb b ON b.COMPANY=t.COMPANY AND b.TB001=t.TA001 AND b.TB002=t.TA002 WHERE ${validHeader}`, [sourceCompanyCode, fromKey, toKey]),
        connection.query(profitQuery[0], profitQuery[1]),
        connection.query(balanceQuery[0], balanceQuery[1]),
        connection.query(`SELECT TRIM(t.TA001) doc_type,TRIM(t.TA002) doc_no,TRIM(t.TA003) doc_date,TRIM(b.TB003) line_no,TRIM(b.TB005) account_code,TRIM(a.MA003) account_name,TRIM(a.MA006) statement_class,TRIM(a.MA007) report_direction,TRIM(b.TB004) dc,${amountExpression} amount,TRIM(b.TB013) currency_code,TRIM(b.TB014) exchange_rate FROM actta t JOIN acttb b ON b.COMPANY=t.COMPANY AND b.TB001=t.TA001 AND b.TB002=t.TA002 LEFT JOIN actma a ON a.COMPANY=b.COMPANY AND a.MA001=b.TB005 WHERE ${validHeader}${currencyFilter} ORDER BY t.TA003,t.TA001,t.TA002,b.TB003`, [sourceCompanyCode, fromKey, toKey, ...currencyParams]),
        connection.query(`SELECT TRIM(b.TB005) account_code,MAX(TRIM(a.MA003)) account_name,COALESCE(SUM(CASE WHEN t.TA003<? AND TRIM(b.TB004)='1' THEN ${amountExpression} WHEN t.TA003<? AND TRIM(b.TB004)='-1' THEN -${amountExpression} ELSE 0 END),0) opening_balance,COALESCE(SUM(CASE WHEN t.TA003<=? AND TRIM(b.TB004)='1' THEN ${amountExpression} WHEN t.TA003<=? AND TRIM(b.TB004)='-1' THEN -${amountExpression} ELSE 0 END),0) ending_balance FROM actta t JOIN acttb b ON b.COMPANY=t.COMPANY AND b.TB001=t.TA001 AND b.TB002=t.TA002 LEFT JOIN actma a ON a.COMPANY=b.COMPANY AND a.MA001=b.TB005 WHERE ${validHeader.replace('t.TA003 BETWEEN ? AND ?', 't.TA003<=?')} ${currencyCode ? ' AND TRIM(COALESCE(b.TB013,\'\'))=?' : ''} GROUP BY b.TB005`, [fromKey, fromKey, toKey, toKey, sourceCompanyCode, toKey, ...currencyParams]),
        connection.query(`SELECT DISTINCT CONCAT(LEFT(TRIM(TA003),4),'-',SUBSTRING(TRIM(TA003),5,2)) period_code FROM actta WHERE COMPANY=? AND TA003 REGEXP '^[0-9]{8}$' ORDER BY period_code`, [sourceCompanyCode]),
        connection.query(`SELECT DISTINCT TRIM(b.TB013) currency_code FROM actta t JOIN acttb b ON b.COMPANY=t.COMPANY AND b.TB001=t.TA001 AND b.TB002=t.TA002 WHERE ${validHeader} AND TRIM(COALESCE(b.TB013,''))<>'' ORDER BY currency_code`, [sourceCompanyCode, fromKey, toKey]),
      ]);
      const header = headerResult[0][0] || {};
      const line = lineResult[0][0] || {};
      const lineAll = lineResultAll[0][0] || {};
      const profitLoss = profitResult[0].map(accountStatementRow);
      const balanceSheet = balanceResult[0].map(balanceSheetRow);
      const sourceLines = sourceLinesResult[0];
      const cashFlow = buildCashFlow(sourceLines, cashBalanceResult[0], sourceCompanyCode);
      const sourceDebit = number(line.debit_amount);
      const sourceCredit = number(line.credit_amount);
      const sourceHeaderDebit = number(header.header_debit);
      const sourceHeaderCredit = number(header.header_credit);
      const lineDifference = sourceDebit - sourceCredit;
      const headerDifference = sourceHeaderDebit - sourceHeaderCredit;
      const pnlTotals = summarizeProfitAndLoss(profitLoss);
      const bsTotals = summarizeBalanceSheet(balanceSheet);
      const openingEnding = {
        opening_debit: sumRows(balanceSheet, 'opening_debit'), opening_credit: sumRows(balanceSheet, 'opening_credit'),
        period_debit: sumRows(balanceSheet, 'period_debit'), period_credit: sumRows(balanceSheet, 'period_credit'),
        ending_debit: sumRows(balanceSheet, 'ending_debit'), ending_credit: sumRows(balanceSheet, 'ending_credit'),
      };
      openingEnding.opening_difference = openingEnding.opening_debit - openingEnding.opening_credit;
      openingEnding.period_difference = openingEnding.period_debit - openingEnding.period_credit;
      openingEnding.ending_difference = openingEnding.ending_debit - openingEnding.ending_credit;
      const availablePeriods = periodResult[0].map(row => text(row.period_code)).filter(Boolean);
      const availableCurrencies = currencyResult[0].map(row => text(row.currency_code)).filter(Boolean);
      res.json({ ok: true, data: {
        report_name: 'SC 2025 只讀財報預覽',
        source_database: sourceName,
        source_schema: source.database,
        company_code: sourceCompanyCode,
        source_read_only: Boolean(source.read_only),
        date_from: fromDate,
        date_to: toDate,
        accounting_period: selectedPeriod?.period || null,
        currency_code: currencyCode || 'ALL',
        available_periods: availablePeriods,
        available_currencies: availableCurrencies,
        source_tables: [
          { table_name: 'ACTMA', purpose: '會計科目主檔／報表分類', key_rule: 'COMPANY + MA001' },
          { table_name: 'ACTTA', purpose: '傳票表頭／日期／核准／過帳狀態', key_rule: 'COMPANY + TA001 + TA002' },
          { table_name: 'ACTTB', purpose: '傳票借貸明細／幣別／匯率', key_rule: 'COMPANY + TB001 + TB002 + TB003' },
        ],
        source_check: {
          valid_voucher_count: Number(header.valid_voucher_count || line.voucher_count || 0),
          line_count: Number(line.line_count || 0),
          debit_amount: sourceDebit,
          credit_amount: sourceCredit,
          difference: lineDifference,
          balanced: Math.abs(lineDifference) <= EPS,
          header_debit_amount: sourceHeaderDebit,
          header_credit_amount: sourceHeaderCredit,
          header_difference: headerDifference,
          header_line_difference: currencyCode ? null : sourceHeaderDebit - number(lineAll.debit_amount),
          header_scope: currencyCode ? '表頭總額為全幣別；目前借貸檢核依所選幣別明細' : '全幣別',
          unmapped_line_count: sourceLines.filter(row => !text(row.account_code) || !text(row.account_name)).length,
        },
        profit_and_loss: { rows: profitLoss, totals: pnlTotals },
        balance_sheet: { rows: balanceSheet, totals: bsTotals },
        cash_flow: cashFlow,
        opening_ending_check: openingEnding,
        checks: {
          source_balanced: Math.abs(lineDifference) <= EPS,
          balance_sheet_balanced: Math.abs(bsTotals.balance_difference) <= EPS && Math.abs(bsTotals.other) <= EPS,
          cash_flow_reconciled: Math.abs(cashFlow.reconciliation_difference) <= EPS,
          cash_flow_classification_complete: Math.abs(cashFlow.classification_difference) <= EPS,
          opening_ending_balanced: Math.abs(openingEnding.ending_difference) <= EPS,
        },
        generated_at: new Date().toISOString(),
      }});
    } catch (error) {
      next(error);
    }
  });
}
