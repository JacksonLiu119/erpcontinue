import 'dotenv/config';
import mysql from 'mysql2/promise';

const baseUrl=String(process.env.ERP_BASE_URL||'http://127.0.0.1:3000').replace(/\/$/,'');
const apiBase=`${baseUrl}/api`,source='SH',stamp=String(Date.now()),budgetCode=`V_G03_R1_${stamp}`,accountCode=`9${stamp}`;
const dbConfig={host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER||'root',password:process.env.DB_PASSWORD||'',database:process.env.DB_NAME||'inventory_erp'};
const assert=(condition,message,details)=>{if(!condition){const error=new Error(message);error.details=details;throw error;}};
async function readJson(response){const text=await response.text();let payload;try{payload=JSON.parse(text);}catch{payload={error:text};}return{response,payload,data:payload.data??payload};}
async function login(){const result=await readJson(await fetch(`${apiBase}/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:process.env.ERP_VERIFY_USER||'admin',password:process.env.ERP_VERIFY_PASSWORD||'12345678'})}));assert(result.response.ok&&result.payload.ok!==false,`管理員登入失敗：${result.payload.error||result.response.status}`,result.payload);return result.data?.token||result.payload.token;}
function makeRequest(token,requestSource=source){return async(path,method='GET',body)=>{const response=await fetch(`${apiBase}${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-ERP-Context-Key':requestSource,'X-Source-Database':requestSource},body:body===undefined?undefined:JSON.stringify(body)});return readJson(response);};}
function expectOk(result,label){assert(result.response.ok&&result.payload.ok!==false,`${label} 失敗：${result.payload.error||result.response.status}`,result.payload);return result.data;}
async function deleteIds(db,table,column,ids){const list=[...new Set(ids.map(Number).filter(Boolean))];if(list.length)await db.query(`DELETE FROM ${table} WHERE ${column} IN (?)`,[list]);}

const budgetIds=[],journalIds=[],accountIds=[];const db=await mysql.createConnection(dbConfig);let token='';
try{
  token=await login();const request=makeRequest(token);
  expectOk(await request('/auth/context','POST',{source_key:source}),'切換 SH 公司');
  const account=expectOk(await request('/accounting/g02/accounts','POST',{source_database:source,account_code:accountCode,account_name:'G03-R1 專用測試費用',account_type:'expense',account_level:2,normal_balance:'debit',is_detail:1,effective_from:'2026-01-01',note:`VERIFY:G03R1:${stamp}`}),'建立專用測試科目');accountIds.push(Number(account.id));expectOk(await request(`/accounting/g02/accounts/${account.id}/approve`,'POST',{source_database:source}),'核准專用測試科目');
  const base=expectOk(await request('/accounting/g03/budgets','POST',{source_database:source,budget_code:budgetCode,budget_name:'G03-R1 預算回歸',fiscal_year:'2026',version_name:'BASE',period_count:12,currency_code:'TWD',lines:[{line_no:1,account_code:'4101',period_no:8,budget_amount:1000},{line_no:2,account_code:accountCode,period_no:8,budget_amount:600}],note:`VERIFY:G03R1:${stamp}`}),'建立 BASE 預算');budgetIds.push(Number(base.id));assert(base.status==='draft'&&base.lines.length===2,'BASE 預算多行建立失敗',base);
  expectOk(await request(`/accounting/g03/budgets/${base.id}/approve`,'POST',{source_database:source}),'核准 BASE 預算');
  const copied=expectOk(await request(`/accounting/g03/budgets/${base.id}/copy`,'POST',{source_database:source,version_name:'R1',note:`VERIFY:G03R1:${stamp}`}),'複製 R1 版本');budgetIds.push(Number(copied.id));
  const revised=expectOk(await request(`/accounting/g03/budgets/${copied.id}`,'PUT',{source_database:source,budget_code:budgetCode,budget_name:'G03-R1 預算回歸',fiscal_year:'2026',version_name:'R1',period_count:12,currency_code:'TWD',lines:[{line_no:1,account_code:'4101',period_no:8,budget_amount:1000},{line_no:2,account_code:accountCode,period_no:8,budget_amount:800}],note:`VERIFY:G03R1:${stamp}`}),'修改 R1 多行預算');assert(Number(revised.total_amount)===1800,'R1 預算總額未依明細重算',revised);
  expectOk(await request(`/accounting/g03/budgets/${copied.id}/approve`,'POST',{source_database:source}),'核准 R1 預算');

  const journal=expectOk(await request('/accounting/journals','POST',{source_database:source,journal_date:'2026-08-15',memo:`VERIFY:G03R1:${stamp}`,lines:[{account_code:accountCode,debit_amount:700,credit_amount:0,description:'G03-R1 測試費用'},{account_code:'1001',debit_amount:0,credit_amount:700,description:'G03-R1 測試銀行'}]}),'建立測試傳票草稿');journalIds.push(Number(journal.id));
  expectOk(await request(`/accounting/journals/${journal.id}/post`,'POST',{source_database:source}),'過帳測試傳票');

  const report=expectOk(await request(`/accounting/g03/report?source_database=${source}&fiscal_year=2026&budget_code=${encodeURIComponent(budgetCode)}&date_from=2026-01-01&date_to=2026-12-31`),'查詢完整預算比較');
  assert(report.budgets.length===2&&report.rows.length===4,'完整報表未保留兩個版本與四行明細',report);
  assert(report.period_summaries.length===13&&Array.isArray(report.dimension_summary)&&Array.isArray(report.actual_dimension_summary),'年度／月份／維度彙總結構不完整',report);
  assert(report.version_differences.length>=2,'多版本差異沒有產生',report.version_differences);
  const expenseRow=report.rows.find(row=>String(row.version_name)==='R1'&&String(row.account_code)===accountCode);assert(expenseRow&&Number(expenseRow.actual_amount)===700&&Number(expenseRow.available_amount)===100,'R1 實際／可用額計算不正確',expenseRow||report);

  const control=expectOk(await request(`/accounting/g03/control?source_database=${source}&fiscal_year=2026&budget_code=${encodeURIComponent(budgetCode)}&date_from=2026-01-01&date_to=2026-12-31`),'查詢最新版本預算控制');assert(control.version_selection==='latest_approved_per_budget_code'&&control.budgets.length===1&&control.rows.length===2,'預算控制未採最新已核准版本去重',control);
  const blocked=expectOk(await request('/accounting/g03/control/check','POST',{source_database:source,fiscal_year:'2026',budget_code:budgetCode,date_from:'2026-01-01',date_to:'2026-12-31',lines:[{line_no:1,account_code:accountCode,period_no:8,amount:200}]}),'超預算提案檢核');assert(blocked.allowed===false&&blocked.blocked===true&&blocked.proposal[0].control_status==='over_budget','超預算提案沒有被阻擋',blocked);
  const allowed=expectOk(await request('/accounting/g03/control/check','POST',{source_database:source,fiscal_year:'2026',budget_code:budgetCode,date_from:'2026-01-01',date_to:'2026-12-31',lines:[{line_no:1,account_code:accountCode,period_no:8,amount:50}]}),'預算內提案檢核');assert(allowed.allowed===true&&allowed.blocked===false&&allowed.proposal[0].control_status==='within_budget','預算內提案被錯誤阻擋',allowed);
  const badDate=await request('/accounting/g03/report?source_database=SH&fiscal_year=2026&budget_code='+encodeURIComponent(budgetCode)+'&date_from=2025-12-01&date_to=2026-12-31');assert(badDate.response.status===400,'跨年度預算查詢未被攔截',badDate.payload);
  const cross=await request(`/accounting/g03/control?source_database=SC&fiscal_year=2026&budget_code=${encodeURIComponent(budgetCode)}`);assert(cross.response.status===409,'SH 上下文查詢 SC 未被公司隔離攔截',cross.payload);
  console.log(JSON.stringify({ok:true,source,budget_code:budgetCode,checked:['ACTI08 預算名稱／版本','ACTI09 多行科目／部門預算','ACTR23 年度／月份實際與預算比較','ACTR28 維度彙總承接','多版本差異','最新版本超預算攔截檢核','公司隔離／跨年度日期攔截'],writes_via_api:{account:1,budgets:2,journals:1},cleanup:'completed in finally',cross_company_rejected:true},null,2));
}catch(error){console.error(JSON.stringify({ok:false,error:error.message,details:error.details,budget_code:budgetCode},null,2));process.exitCode=1;
}finally{
  try{await deleteIds(db,'accounting_journal_lines','journal_id',journalIds);await deleteIds(db,'accounting_journals','id',journalIds);await deleteIds(db,'accounting_budget_events','budget_id',budgetIds);await deleteIds(db,'accounting_budget_lines','budget_id',budgetIds);await deleteIds(db,'accounting_budgets','id',budgetIds);await deleteIds(db,'accounting_account_events','account_id',accountIds);await deleteIds(db,'accounting_accounts','id',accountIds);}catch(error){console.error(`G03-R1 cleanup failed: ${error.message}`);process.exitCode=1;}
  if(token)try{const response=await fetch(`${apiBase}/auth/logout`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}});await response.text();}catch(_){/* 回歸結果不因登出失敗改變 */}
  await db.end();
}
