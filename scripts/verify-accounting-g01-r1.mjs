import 'dotenv/config';

const baseUrl = String(process.env.ERP_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const apiBase = `${baseUrl}/api`;
const username = process.env.ERP_VERIFY_USER || 'admin';
const password = process.env.ERP_VERIFY_PASSWORD || '12345678';
const expectedRules = ['MC001','MC002','MC003','CURRENT_PROFIT_ACCOUNT','PRIOR_PROFIT_ACCOUNT'];

const assert = (condition, message, details) => {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
};

async function readJson(response) {
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { error:text }; }
  return { response, payload, data:payload.data ?? payload };
}

async function login() {
  const result = await readJson(await fetch(`${apiBase}/auth/login`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ username, password })
  }));
  assert(result.response.ok && result.payload.ok !== false, `管理員登入失敗：${result.payload.error || result.response.status}`, result.payload);
  return result.data?.token || result.payload.token;
}

function makeRequest(token, source) {
  return async (path, method='GET', body) => {
    const headers = {
      Authorization:`Bearer ${token}`,
      'Content-Type':'application/json',
      'X-ERP-Context-Key':source,
      'X-Source-Database':source
    };
    return readJson(await fetch(`${apiBase}${path}`, {
      method, headers, body:body === undefined ? undefined : JSON.stringify(body)
    }));
  };
}

function expectOk(result, label) {
  assert(result.response.ok && result.payload.ok !== false, `${label} 失敗：${result.payload.error || result.response.status}`, result.payload);
  return result.data;
}

const token = await login();
let availableSources = [];
const checked = [];
let crossCompanyRejected = false;
try {
  const baseRequest = makeRequest(token, 'SH');
  const contexts = expectOk(await baseRequest('/company-contexts'), '取得公司上下文');
  availableSources = contexts.map(row => String(row.source_database || '').toUpperCase()).filter(source => ['SH','SC','DEMO'].includes(source));
  assert(availableSources.includes('SH'), '找不到 SH 公司上下文', contexts);

  // 以登入工作階段正式切換公司；每個公司各自檢查同一份 ACTI01 規則目錄。
  for (const source of availableSources) {
    const request = makeRequest(token, source);
    expectOk(await request('/auth/context', 'POST', { source_key:source }), `${source} 切換公司`);
    const catalog = expectOk(await request(`/accounting/g01/catalog?source_database=${source}`), `${source} 取得 G01 目錄`);
    assert(catalog.source_database === source && catalog.read_only === true, `${source} G01 目錄公司／唯讀標記不正確`, catalog);
    assert(catalog.source_document === 'iSM-會計總帳管理系統.pdf', `${source} G01 未保留來源文件`, catalog);
    assert(Array.isArray(catalog.existing_tables) && catalog.existing_tables.includes('accounting_system_parameters') && catalog.existing_tables.includes('accounting_accounts'), `${source} G01 既有資料表對照不完整`, catalog);
    assert(catalog.catalog.length === expectedRules.length && expectedRules.every(code => catalog.catalog.some(rule => rule.code === code)), `${source} G01 文件規則目錄不完整`, catalog.catalog);

    const audit = expectOk(await request(`/accounting/g01/audit?source_database=${source}&as_of_date=2026-08-31`), `${source} G01 稽核`);
    assert(audit.source_database === source && audit.as_of_date === '2026-08-31', `${source} G01 稽核公司／基準日不正確`, audit);
    assert(Array.isArray(audit.rule_results) && audit.rule_results.length === expectedRules.length, `${source} G01 五項規則稽核結果不完整`, audit);
    assert(expectedRules.every(code => audit.rule_results.some(rule => rule.code === code)), `${source} G01 稽核缺少文件規則`, audit.rule_results);
    assert(Number.isInteger(Number(audit.summary?.required_count)) && Number(audit.summary.required_count) === expectedRules.length, `${source} G01 必要項目統計不正確`, audit.summary);

    // 驗證已知文件代碼的型態／選項攔截；這些請求應在寫入前被拒絕，不會建立測試資料。
    const wrongType = await request('/accounting/g01/parameters', 'POST', {
      source_database:source, parameter_code:'MC001', parameter_name:'測試錯誤型態', data_type:'number', parameter_value:'1'
    });
    assert(wrongType.response.status === 400, `${source} MC001 錯誤型態未被攔截`, wrongType.payload);
    const wrongOption = await request('/accounting/g01/parameters', 'POST', {
      source_database:source, parameter_code:'MC001', parameter_name:'測試錯誤選項', data_type:'text', parameter_value:'3'
    });
    assert(wrongOption.response.status === 400, `${source} MC001 錯誤選項未被攔截`, wrongOption.payload);
    const wrongBooleanType = await request('/accounting/g01/parameters', 'POST', {
      source_database:source, parameter_code:'MC003', parameter_name:'測試錯誤型態', data_type:'text', parameter_value:'1'
    });
    assert(wrongBooleanType.response.status === 400, `${source} MC003 錯誤型態未被攔截`, wrongBooleanType.payload);
    checked.push({ source, configured_count:Number(audit.summary?.configured_count || 0), missing_count:Number(audit.summary?.missing_count || 0), issue_count:Number(audit.summary?.issue_count || 0), healthy:Boolean(audit.summary?.healthy) });
  }

  // 目前工作階段停在最後一家時，仍不得藉 query／header 讀另一家公司。
  const currentSource = availableSources.at(-1) || 'SH';
  const currentRequest = makeRequest(token, currentSource);
  const otherSource = availableSources.find(source => source !== currentSource);
  if (otherSource) {
    const cross = await currentRequest(`/accounting/g01/catalog?source_database=${otherSource}`);
    crossCompanyRejected = cross.response.status === 409;
    assert(crossCompanyRejected, `${currentSource} 上下文查詢 ${otherSource} 未被拒絕`, cross.payload);
  }

  console.log(JSON.stringify({
    ok:true, read_only:true, checked, available_sources:availableSources,
    cross_company_rejected:crossCompanyRejected,
    writes_created:0,
    message:'已逐家公司完成 ACTI01 五項文件規則目錄、基準日稽核、型態／選項攔截與公司隔離檢查；測試請求均在寫入前拒絕。'
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok:false, error:error.message, details:error.details, checked }, null, 2));
  process.exitCode = 1;
} finally {
  try { await fetch(`${apiBase}/auth/logout`, { method:'POST', headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' } }); } catch (_) { /* 回歸結果不因登出失敗改變 */ }
}
