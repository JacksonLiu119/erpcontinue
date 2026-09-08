import { pool, sourceDatabases, ensureTargetFinanceWorkflowSchema } from './db.js';

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

function validDate(value) {
  const result = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw badRequest(`日期格式錯誤：${result}`);
  const parsed = new Date(`${result}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) throw badRequest(`日期不存在：${result}`);
  return result;
}

function dateOnly(value) {
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  const result = text(value);
  return /^\d{8}$/.test(result)
    ? `${result.slice(0, 4)}-${result.slice(4, 6)}-${result.slice(6, 8)}`
    : result.slice(0, 10);
}

function contextFor(sourceDatabase) {
  const source = sourceDatabases[sourceDatabase];
  if (!source) throw badRequest(`找不到資料來源：${sourceDatabase}`);
  return {
    tenant_id: source.tenant_id || 'default',
    company_id: source.company_id || sourceDatabase,
    source_system: source.source_system || source.adapter_code || 'ism-sh',
    source_database: sourceDatabase,
  };
}

function isCashAccount(accountCode, accountName) {
  const code = text(accountCode).replaceAll(' ', '');
  const name = text(accountName);
  if (/(應收|應付|票據|借款|貸款)/.test(name)) return false;
  return code === '1001' || /^111[1-3]/.test(code) || /(現金|銀行|活存|甲存|定存|存款|零用金)/.test(name);
}

function classifyCashCounterpart(accountCode, accountName) {
  const code = text(accountCode);
  const name = text(accountName);
  if (!code && !name) return 'unclassified';
  if (['1101', '1121', '1122', '1131', '1201', '2101', '2201', '4101', '5101', '7161', '7162'].includes(code)) return 'operating';
  if (/(固定資產|設備|土地|房屋|建築|機器|車輛|長期投資|無形資產|專利|工程款|在建工程)/.test(name) || /^(14|15|16)/.test(code)) return 'investing';
  if (/(借款|股本|資本|股東|股利|長期負債|租賃負債)/.test(name) || /^(21[1-6]|22|23|24|31|32)/.test(code)) return 'financing';
  if (isCashAccount(code, name)) return 'unclassified';
  return 'operating';
}

function categoryName(category) {
  return {
    operating: '營業活動',
    investing: '投資活動',
    financing: '籌資活動',
    unclassified: '未分類／待對照',
  }[category] || category;
}

function sourceKey(sourceDatabase, row, accountCode = '') {
  const sourceKind = text(row?.source_kind) || 'journal';
  const sourceId = number(row?.source_id);
  return `${sourceDatabase}:accounting_journals:${sourceKind}:${sourceId || '0'}${accountCode ? `:${accountCode}` : ''}`;
}

function normalizeLine(row) {
  const accountCode = text(row.account_code);
  const accountName = text(row.master_account_name) || text(row.line_account_name) || '未命名科目';
  return {
    journal_id: number(row.journal_id),
    journal_no: text(row.journal_no),
    journal_date: dateOnly(row.journal_date),
    source_kind: text(row.source_kind),
    source_id: number(row.source_id),
    source_document_no: text(row.source_document_no),
    status: text(row.status),
    memo: text(row.memo),
    line_no: number(row.line_no),
    account_code: accountCode,
    account_name: accountName,
    account_type: text(row.account_type).toLowerCase() || 'other',
    debit_amount: number(row.debit_amount),
    credit_amount: number(row.credit_amount),
    party_code: text(row.party_code),
    description: text(row.description),
  };
}

function groupJournals(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.journal_id)) groups.set(row.journal_id, []);
    groups.get(row.journal_id).push(row);
  }
  return groups;
}

function journalCheck(rows) {
  const groups = groupJournals(rows);
  const unbalanced = [];
  for (const [journalId, lines] of groups) {
    const debit = lines.reduce((sum, line) => sum + line.debit_amount, 0);
    const credit = lines.reduce((sum, line) => sum + line.credit_amount, 0);
    if (lines.length < 2 || Math.abs(debit - credit) > EPS) {
      unbalanced.push({
        journal_id: journalId,
        journal_no: lines[0]?.journal_no || '',
        debit_amount: debit,
        credit_amount: credit,
        difference: debit - credit,
      });
    }
  }
  return { groups, unbalanced };
}

function sumDirection(rows) {
  return {
    debit: rows.reduce((sum, row) => sum + row.debit_amount, 0),
    credit: rows.reduce((sum, row) => sum + row.credit_amount, 0),
  };
}

function buildProfitAndLoss(rows, sourceDatabase) {
  const grouped = new Map();
  for (const row of rows) {
    if (!['revenue', 'expense'].includes(row.account_type)) continue;
    const key = `${row.account_type}|${row.account_code}`;
    const current = grouped.get(key) || {
      line_kind: row.account_type,
      account_code: row.account_code,
      account_name: row.account_name,
      debit_amount: 0,
      credit_amount: 0,
      voucher_ids: new Set(),
      source_kind: row.source_kind,
      source_id: row.source_id,
    };
    current.debit_amount += row.debit_amount;
    current.credit_amount += row.credit_amount;
    current.voucher_ids.add(row.journal_id);
    grouped.set(key, current);
  }
  const resultRows = [...grouped.values()].map(row => ({
    line_kind: row.line_kind,
    account_code: row.account_code,
    account_name: row.account_name,
    debit_amount: row.debit_amount,
    credit_amount: row.credit_amount,
    report_amount: row.line_kind === 'revenue' ? row.credit_amount - row.debit_amount : row.debit_amount - row.credit_amount,
    voucher_count: row.voucher_ids.size,
    source_table: 'accounting_journals／accounting_journal_lines／accounting_accounts',
    source_key: sourceKey(sourceDatabase, row, row.account_code),
  })).sort((a, b) => a.line_kind.localeCompare(b.line_kind) || a.account_code.localeCompare(b.account_code));
  const revenue = resultRows.filter(row => row.line_kind === 'revenue').reduce((sum, row) => sum + row.report_amount, 0);
  const expense = resultRows.filter(row => row.line_kind === 'expense').reduce((sum, row) => sum + row.report_amount, 0);
  return {
    rows: resultRows,
    totals: { revenue, expense, net_income: revenue - expense, row_count: resultRows.length },
  };
}

function buildBalanceSheet(allRows, periodRows, fromDate, sourceDatabase) {
  const grouped = new Map();
  for (const row of allRows) {
    if (!['asset', 'liability', 'equity'].includes(row.account_type)) continue;
    const key = `${row.account_type}|${row.account_code}`;
    const current = grouped.get(key) || {
      account_type: row.account_type,
      account_code: row.account_code,
      account_name: row.account_name,
      opening_debit: 0,
      opening_credit: 0,
      period_debit: 0,
      period_credit: 0,
      ending_debit: 0,
      ending_credit: 0,
      voucher_ids: new Set(),
      source_kind: row.source_kind,
      source_id: row.source_id,
    };
    if (row.journal_date < fromDate) {
      current.opening_debit += row.debit_amount;
      current.opening_credit += row.credit_amount;
    }
    current.ending_debit += row.debit_amount;
    current.ending_credit += row.credit_amount;
    current.voucher_ids.add(row.journal_id);
    grouped.set(key, current);
  }
  for (const row of periodRows) {
    const key = `${row.account_type}|${row.account_code}`;
    const current = grouped.get(key);
    if (!current) continue;
    current.period_debit += row.debit_amount;
    current.period_credit += row.credit_amount;
  }
  const rows = [...grouped.values()].map(row => {
    const section = row.account_type === 'asset' ? 'assets' : row.account_type === 'liability' ? 'liabilities' : 'equity';
    const balance = (debit, credit) => section === 'assets' ? debit - credit : credit - debit;
    return {
      section,
      account_type: row.account_type,
      account_code: row.account_code,
      account_name: row.account_name,
      opening_debit: row.opening_debit,
      opening_credit: row.opening_credit,
      opening_balance: balance(row.opening_debit, row.opening_credit),
      period_debit: row.period_debit,
      period_credit: row.period_credit,
      period_balance: balance(row.period_debit, row.period_credit),
      ending_debit: row.ending_debit,
      ending_credit: row.ending_credit,
      ending_balance: balance(row.ending_debit, row.ending_credit),
      voucher_count: row.voucher_ids.size,
      source_table: 'accounting_journals／accounting_journal_lines／accounting_accounts',
      source_key: sourceKey(sourceDatabase, row, row.account_code),
    };
  }).sort((a, b) => a.section.localeCompare(b.section) || a.account_code.localeCompare(b.account_code));
  const total = section => rows.filter(row => row.section === section).reduce((sum, row) => sum + row.ending_balance, 0);
  const assets = total('assets');
  const liabilities = total('liabilities');
  const equity = total('equity');
  return { rows, totals: { assets, liabilities, equity, other: 0, row_count: rows.length } };
}

function buildCashFlow(allRows, periodRows, fromDate, toDate, sourceDatabase, detailLimit) {
  const categoryKeys = ['operating', 'investing', 'financing', 'unclassified'];
  const categories = Object.fromEntries(categoryKeys.map(category => [category, {
    category,
    category_name: categoryName(category),
    inflow: 0,
    outflow: 0,
    net: 0,
    voucher_count: 0,
  }]));
  const groups = groupJournals(periodRows);
  const details = [];
  const categoryVoucherIds = Object.fromEntries(categoryKeys.map(category => [category, new Set()]));
  let internalTransferCount = 0;
  let unclassifiedVoucherCount = 0;
  for (const rows of groups.values()) {
    const cashRows = rows.filter(row => isCashAccount(row.account_code, row.account_name));
    if (!cashRows.length) continue;
    const cashNet = cashRows.reduce((sum, row) => sum + row.debit_amount - row.credit_amount, 0);
    if (Math.abs(cashNet) <= EPS) {
      internalTransferCount += 1;
      continue;
    }
    const counterpartRows = rows.filter(row => !isCashAccount(row.account_code, row.account_name));
    const counterpartTotal = counterpartRows.reduce((sum, row) => sum + Math.abs(row.debit_amount - row.credit_amount), 0);
    const allocations = counterpartTotal > EPS
      ? counterpartRows.map(row => ({ row, category: classifyCashCounterpart(row.account_code, row.account_name), ratio: Math.abs(row.debit_amount - row.credit_amount) / counterpartTotal }))
      : [{ row: null, category: 'unclassified', ratio: 1 }];
    if (allocations.some(item => item.category === 'unclassified')) unclassifiedVoucherCount += 1;
    for (const allocation of allocations) {
      const category = categories[allocation.category] || categories.unclassified;
      const net = cashNet * allocation.ratio;
      category.net += net;
      if (net >= 0) category.inflow += net;
      else category.outflow += Math.abs(net);
      categoryVoucherIds[category.category].add(rows[0].journal_id);
      const first = rows[0];
      details.push({
        category: category.category,
        category_name: category.category_name,
        document_date: first.journal_date,
        document_type: first.source_kind || 'journal',
        document_no: first.source_document_no || first.journal_no,
        journal_no: first.journal_no,
        counterpart_account_code: allocation.row?.account_code || '',
        counterpart_account_name: allocation.row?.account_name || '無對應科目',
        inflow: net >= 0 ? net : 0,
        outflow: net < 0 ? Math.abs(net) : 0,
        net,
        source_table: 'accounting_journals／accounting_journal_lines',
        source_key: sourceKey(sourceDatabase, first, allocation.row?.account_code || ''),
      });
    }
  }
  for (const category of categoryKeys) categories[category].voucher_count = categoryVoucherIds[category].size;
  const cashRowsBefore = allRows.filter(row => row.journal_date < fromDate && isCashAccount(row.account_code, row.account_name));
  const cashRowsThrough = allRows.filter(row => row.journal_date <= toDate && isCashAccount(row.account_code, row.account_name));
  const openingCash = cashRowsBefore.reduce((sum, row) => sum + row.debit_amount - row.credit_amount, 0);
  const endingCash = cashRowsThrough.reduce((sum, row) => sum + row.debit_amount - row.credit_amount, 0);
  const cashChange = endingCash - openingCash;
  const classificationNet = categoryKeys.reduce((sum, category) => sum + categories[category].net, 0);
  const trimmedDetails = details.sort((a, b) => String(b.document_date).localeCompare(String(a.document_date)) || String(b.document_no).localeCompare(String(a.document_no))).slice(0, detailLimit);
  return {
    categories: categoryKeys.map(category => categories[category]),
    details: trimmedDetails,
    detail_count: details.length,
    cash_account_count: new Set(allRows.filter(row => isCashAccount(row.account_code, row.account_name)).map(row => row.account_code)).size,
    cash_voucher_count: groups.size,
    internal_transfer_count: internalTransferCount,
    unclassified_voucher_count: unclassifiedVoucherCount,
    opening_cash: openingCash,
    ending_cash: endingCash,
    cash_change: cashChange,
    classification_net: classificationNet,
    reconciliation_difference: cashChange - classificationNet,
    classification_method: '依目標 ERP 已過帳傳票的現金／銀行科目與對方科目推導；應收、應付、存貨、收入與成本列營業活動，固定資產列投資活動，借款／資本列籌資活動。',
  };
}

export function registerTargetFinancialStatementRoutes(app) {
  app.get('/api/accounting/financial-statements', async (req, res, next) => {
    try {
      await ensureTargetFinanceWorkflowSchema();
      const sourceDatabase = String(req.erpContext?.source_database || req.query.source_database || 'SH').toUpperCase();
      const source = sourceDatabases[sourceDatabase];
      if (!source) throw badRequest(`找不到資料來源：${sourceDatabase}`);
      const toDate = validDate(req.query.to_date || req.query.date_to || new Date().toISOString().slice(0, 10));
      const fromDate = validDate(req.query.from_date || req.query.date_from || `${toDate.slice(0, 4)}-01-01`);
      if (fromDate > toDate) throw badRequest('日期起日不可晚於迄日');
      const detailLimit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
      const context = contextFor(sourceDatabase);
      const [rawRows] = await pool.query(`
        SELECT j.id journal_id,j.journal_no,j.journal_date,j.source_kind,j.source_id,j.source_document_no,j.status,j.memo,
          l.line_no,l.account_code,l.account_name line_account_name,l.debit_amount,l.credit_amount,l.party_code,l.description,
          a.account_name master_account_name,a.account_type
        FROM accounting_journals j
        JOIN accounting_journal_lines l ON l.journal_id=j.id
        LEFT JOIN accounting_accounts a
          ON a.tenant_id=j.tenant_id AND a.company_id=j.company_id AND a.source_system=j.source_system
         AND a.account_code=l.account_code AND a.is_active=1
        WHERE j.tenant_id=? AND j.company_id=? AND j.source_system=? AND j.source_database=?
          AND j.status='posted' AND j.journal_date<=?
        ORDER BY j.journal_date,j.id,l.line_no`,
      [context.tenant_id, context.company_id, context.source_system, sourceDatabase, toDate]);
      const allRows = rawRows.map(normalizeLine);
      const periodRows = allRows.filter(row => row.journal_date >= fromDate && row.journal_date <= toDate);
      const allCheck = journalCheck(allRows);
      const periodCheck = journalCheck(periodRows);
      const allTotals = sumDirection(allRows);
      const periodTotals = sumDirection(periodRows);
      const pnl = buildProfitAndLoss(periodRows, sourceDatabase);
      const cumulativePnl = buildProfitAndLoss(allRows, sourceDatabase);
      const balanceSheet = buildBalanceSheet(allRows, periodRows, fromDate, sourceDatabase);
      const balanceTotals = {
        ...balanceSheet.totals,
        current_profit: cumulativePnl.totals.net_income,
        equity_including_current_profit: balanceSheet.totals.equity + cumulativePnl.totals.net_income,
      };
      balanceTotals.balance_difference = balanceTotals.assets + balanceTotals.other - balanceTotals.liabilities - balanceTotals.equity - balanceTotals.current_profit;
      balanceSheet.totals = balanceTotals;
      const cashFlow = buildCashFlow(allRows, periodRows, fromDate, toDate, sourceDatabase, detailLimit);
      const unknownAccounts = [...new Set(allRows.filter(row => row.account_type === 'other').map(row => `${row.account_code} ${row.account_name}`))];
      const warnings = [];
      if (!allCheck.groups.size) warnings.push('截至日以前沒有目標 ERP 已過帳傳票，三大財報尚未具備可驗證資料。');
      if (allCheck.unbalanced.length) warnings.push(`發現 ${allCheck.unbalanced.length} 筆借貸不平衡傳票。`);
      if (unknownAccounts.length) warnings.push(`有 ${unknownAccounts.length} 個傳票科目尚未在目前公司科目主檔分類：${unknownAccounts.slice(0, 10).join('、')}`);
      if (cashFlow.unclassified_voucher_count) warnings.push(`有 ${cashFlow.unclassified_voucher_count} 筆現金傳票無法完整分類。`);
      const checks = {
        journals_balanced: allCheck.groups.size > 0 && allCheck.unbalanced.length === 0,
        period_journals_balanced: periodCheck.unbalanced.length === 0,
        balance_sheet_balanced: allCheck.groups.size > 0 && Math.abs(balanceTotals.balance_difference) <= EPS,
        cash_flow_reconciled: Math.abs(cashFlow.reconciliation_difference) <= EPS,
        cash_flow_classification_complete: cashFlow.unclassified_voucher_count === 0,
        complete: allCheck.groups.size > 0 && allCheck.unbalanced.length === 0 && periodCheck.unbalanced.length === 0
          && Math.abs(balanceTotals.balance_difference) <= EPS && Math.abs(cashFlow.reconciliation_difference) <= EPS
          && cashFlow.unclassified_voucher_count === 0 && unknownAccounts.length === 0,
      };
      const availablePeriods = [...new Set(allRows.map(row => row.journal_date.slice(0, 7)))].sort();
      res.json({ ok: true, data: {
        report_name: `${source.label || sourceDatabase} 目標 ERP 三大財務報表`,
        company_code: context.company_id,
        source_database: sourceDatabase,
        target_database: source.target_database || process.env.DB_NAME || 'inventory_erp',
        source_read_only: true,
        target_write_enabled: true,
        statement_basis: '目標 ERP accounting_journals 已過帳傳票／accounting_accounts 科目分類；SH 原始資料庫維持唯讀，不直接混入。',
        date_from: fromDate,
        date_to: toDate,
        available_periods: availablePeriods,
        source_tables: [
          { table_name: 'accounting_journals', purpose: '目標 ERP 已過帳傳票表頭', key_rule: 'tenant_id + company_id + source_system + source_database + source_kind + source_id' },
          { table_name: 'accounting_journal_lines', purpose: '目標 ERP 傳票借貸明細', key_rule: 'journal_id + line_no' },
          { table_name: 'accounting_accounts', purpose: '目前公司會計科目與資產／負債／權益／收入／費用分類', key_rule: 'tenant_id + company_id + source_system + account_code' },
        ],
        source_check: {
          valid_voucher_count: allCheck.groups.size,
          line_count: allRows.length,
          debit_amount: allTotals.debit,
          credit_amount: allTotals.credit,
          difference: allTotals.debit - allTotals.credit,
          period_voucher_count: periodCheck.groups.size,
          period_line_count: periodRows.length,
          period_debit_amount: periodTotals.debit,
          period_credit_amount: periodTotals.credit,
          period_difference: periodTotals.debit - periodTotals.credit,
          unbalanced_vouchers: allCheck.unbalanced,
          unmapped_line_count: unknownAccounts.length,
        },
        profit_and_loss: { ...pnl, cumulative_totals: cumulativePnl.totals },
        balance_sheet: balanceSheet,
        cash_flow: cashFlow,
        checks,
        warnings,
        generated_at: new Date().toISOString(),
      } });
    } catch (error) { next(error); }
  });
}
