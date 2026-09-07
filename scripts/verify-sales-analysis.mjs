import 'dotenv/config';

const baseUrl=String(process.env.ERP_BASE_URL||'http://127.0.0.1:3000').replace(/\/$/,'');
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
async function request(path,token='',options={}){
  const headers=new Headers(options.headers||{});
  if(token)headers.set('Authorization','Bearer '+token);
  const response=await fetch(baseUrl+path,{...options,headers});
  const body=await response.json().catch(()=>({}));
  return{status:response.status,body};
}
function contextHeaders(token,source,company){
  return{Authorization:'Bearer '+token,'X-ERP-Context-Key':source,'X-Source-Database':source,'X-Company-Id':company};
}
function assertFinite(value,message){
  assert(Number.isFinite(Number(value)),message+': '+value);
}
function assertAnalysis(data,source,group){
  assert(data?.report_code==='COP-ANALYSIS',source+'/'+group+' 回傳報表代碼不符');
  assert(data?.source_database===source,source+'/'+group+' 回傳來源資料庫不符');
  const expectedTarget=source==='SH'?'inventory_erp':'inventory_erp_sc';
  assert(data?.target_database===expectedTarget,source+'/'+group+' 回傳目標資料庫不符：'+data?.target_database);
  for(const key of ['sales_rows','inventory_rows','receivable_rows'])assert(Array.isArray(data?.[key]),source+'/'+group+' 缺少分析資料區塊 '+key);
  for(const section of ['sales','inventory','receivable'])assert(data?.summary?.[section],source+'/'+group+' 缺少摘要區塊 '+section);
  for(const key of ['quote_to_order_rate','order_fulfillment_rate','shipment_return_rate','receivable_collection_rate'])assertFinite(data.summary?.rates?.[key],source+'/'+group+' 缺少比率 '+key);
  for(const key of ['unmapped_customer_count','unmapped_item_count','unmapped_department_count','unmapped_salesperson_count','source_linked_line_count','orphan_source_line_count'])assertFinite(data.summary?.data_quality?.[key],source+'/'+group+' 缺少資料品質欄位 '+key);
  assert(Array.isArray(data.source_definitions)&&data.source_definitions.length===3,source+'/'+group+' 來源定義不完整');
  assert(Array.isArray(data.excluded_scope)&&data.excluded_scope.includes('製造')&&data.excluded_scope.includes('成本計算'),source+'/'+group+' 製造／成本排除範圍遺失');
  for(const rows of [data.sales_rows,data.inventory_rows,data.receivable_rows])assert(rows.length<=Number(data.limit||200),source+'/'+group+' 明細上限未生效');
}

let token='';
try{
  const login=await request('/api/auth/login','',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:process.env.ERP_AUDIT_USER||'admin',password:process.env.ERP_AUDIT_PASSWORD||'12345678'})});
  assert(login.status===200&&login.body.ok&&login.body.data?.token,'登入失敗：'+(login.body.error||login.status));
  token=login.body.data.token;
  const contextsResult=await request('/api/company-contexts',token);
  assert(contextsResult.status===200&&contextsResult.body.ok,'取得公司上下文失敗');
  const contexts=(contextsResult.body.data||[]).filter(row=>['SH','SC'].includes(String(row.source_database||'').toUpperCase()));
  assert(contexts.length>0,'沒有可驗證的 SH／SC 公司上下文');
  const groups=['customer','item','category','department','salesperson','warehouse','currency','document_kind','period','customer_item','customer_department','customer_salesperson','item_category','item_warehouse','period_customer','period_item','period_category','period_department','period_salesperson','period_warehouse','period_customer_item','detail'];
  for(const context of contexts){
    const source=String(context.source_database).toUpperCase(),company=String(context.company_id||source);
    const switched=await request('/api/auth/context',token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source_key:source})});
    assert(switched.status===200&&switched.body.ok,source+' 公司上下文切換失敗：'+(switched.body.error||switched.status));
    const headers=contextHeaders(token,source,company);
    for(const group of groups){
      const result=await request('/api/sales-workflow/analysis?source_database='+source+'&from_date=2026-07-01&to_date=2026-07-31&group_by='+group+'&limit=5',token,{headers});
      assert(result.status===200&&result.body.ok,source+'/'+group+' 銷售分析查詢失敗：'+(result.body.error||result.status));
      assertAnalysis(result.body.data,source,group);
    }
    const wideRange=await request('/api/sales-workflow/analysis?source_database='+source+'&from_date=2020-01-01&to_date=2026-12-31&group_by=customer&limit=5',token,{headers});
    assert(wideRange.status===200&&wideRange.body.ok,source+'/customer 全期間查詢失敗：'+(wideRange.body.error||wideRange.status));
    assertAnalysis(wideRange.body.data,source,'customer-wide-range');
    const period=await request('/api/sales-workflow/analysis?source_database='+source+'&from_date=2026-07-01&to_date=2026-07-31&group_by=period&limit=5',token,{headers});
    assert(period.status===200&&period.body.ok,source+'/period 日期區間查詢失敗：'+(period.body.error||period.status));
    assert(period.body.data.from_date==='2026-07-01'&&period.body.data.to_date==='2026-07-31',source+'/period 日期區間未保留');
    const invalidRange=await request('/api/sales-workflow/analysis?source_database='+source+'&from_date=2026-08-01&to_date=2026-07-31&group_by=period&limit=5',token,{headers});
    assert(invalidRange.status===400,source+' 反向日期區間未被拒絕：'+invalidRange.status);
    const invalidGroup=await request('/api/sales-workflow/analysis?source_database='+source+'&group_by=invalid&limit=5',token,{headers});
    assert(invalidGroup.status===400,source+' 無效分析維度未被拒絕：'+invalidGroup.status);
  }
  if(contexts.length>1){
    const first=contexts[0],second=contexts[1],source=String(first.source_database).toUpperCase(),other=String(second.source_database).toUpperCase();
    const switched=await request('/api/auth/context',token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source_key:source})});
    assert(switched.status===200&&switched.body.ok,'跨公司測試前切換失敗');
    const cross=await request('/api/sales-workflow/analysis?source_database='+other+'&group_by=customer_item&limit=5',token,{headers:contextHeaders(token,other,String(second.company_id||other))});
    assert(cross.status===409,'銷售分析跨公司請求未被拒絕：'+cross.status);
  }
  console.log('Sales analysis verification passed for '+contexts.map(row=>String(row.source_database).toUpperCase()).join(', ')+'.');
}catch(error){
  console.error('Sales analysis verification failed: '+error.message);
  process.exitCode=1;
}
