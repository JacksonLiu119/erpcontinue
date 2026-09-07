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
function assertSummary(summary,source,group){
  for(const key of ['document_count','line_count','order_quantity','delivered_quantity','remaining_quantity','order_amount','delivered_amount','remaining_amount']){
    assert(Number.isFinite(Number(summary?.[key])),source+'/'+group+' 缺少摘要欄位 '+key);
  }
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
  const groups=['customer_item','customer','item','salesperson','period','customer_salesperson','item_salesperson','period_customer','period_item','period_salesperson','detail'];
  for(const context of contexts){
    const source=String(context.source_database).toUpperCase(),company=String(context.company_id||source);
    const switched=await request('/api/auth/context',token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source_key:source})});
    assert(switched.status===200&&switched.body.ok,source+' 公司上下文切換失敗：'+(switched.body.error||switched.status));
    const headers=contextHeaders(token,source,company);
    for(const group of groups){
      const result=await request('/api/sales-workflow/statistics?source_database='+source+'&from_date=2020-01-01&to_date=2026-12-31&closure=all&group_by='+group+'&limit=5',token,{headers});
      assert(result.status===200&&result.body.ok&&result.body.data?.report_code==='COPR20',source+'/'+group+' COPR20 查詢失敗：'+(result.body.error||result.status));
      assert(result.body.data.source_database===source,source+'/'+group+' 回傳來源資料庫不符');
      const expectedTarget=source==='SH'?'inventory_erp':'inventory_erp_sc';
      assert(result.body.data.target_database===expectedTarget,source+'/'+group+' 回傳目標資料庫不符：'+result.body.data.target_database);
      assertSummary(result.body.data.summary,source,group);
      assert(Array.isArray(result.body.data.rows)&&result.body.data.rows.length<=5,source+'/'+group+' 明細上限未生效');
      for(const row of result.body.data.rows||[])assert(!String(row.status_codes||'').split(',').some(status=>['draft','voided'].includes(status)),source+'/'+group+' 混入草稿／作廢狀態');
    }
    for(const closure of ['open','closed']){
      const result=await request('/api/sales-workflow/statistics?source_database='+source+'&from_date=2020-01-01&to_date=2026-12-31&closure='+closure+'&group_by=customer_item&limit=5',token,{headers});
      assert(result.status===200&&result.body.ok,source+'/'+closure+' 結案篩選失敗：'+(result.body.error||result.status));
      for(const row of result.body.data.rows||[]){
        const statuses=String(row.status_codes||'').split(',').filter(Boolean);
        if(closure==='open')assert(statuses.every(status=>['approved','partial'].includes(status)),source+'/open 混入已結案狀態');
        if(closure==='closed')assert(statuses.every(status=>['completed','closed'].includes(status)),source+'/closed 混入未結案狀態');
      }
    }
    const period=await request('/api/sales-workflow/statistics?source_database='+source+'&from_date=2026-07-01&to_date=2026-07-31&group_by=period&limit=5',token,{headers});
    assert(period.status===200&&period.body.ok,source+'/period 日期區間查詢失敗：'+(period.body.error||period.status));
    const invalidRange=await request('/api/sales-workflow/statistics?source_database='+source+'&from_date=2026-08-01&to_date=2026-07-31&group_by=period&limit=5',token,{headers});
    assert(invalidRange.status===400,source+' 反向日期區間未被拒絕：'+invalidRange.status);
    const invalidGroup=await request('/api/sales-workflow/statistics?source_database='+source+'&group_by=invalid&limit=5',token,{headers});
    assert(invalidGroup.status===400,source+' 無效統計維度未被拒絕：'+invalidGroup.status);
  }
  if(contexts.length>1){
    const first=contexts[0],second=contexts[1],source=String(first.source_database).toUpperCase(),other=String(second.source_database).toUpperCase();
    const switched=await request('/api/auth/context',token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source_key:source})});
    assert(switched.status===200&&switched.body.ok,'跨公司測試前切換失敗');
    const cross=await request('/api/sales-workflow/statistics?source_database='+other+'&group_by=customer_item&limit=5',token,{headers:contextHeaders(token,other,String(second.company_id||other))});
    assert(cross.status===409,'統計報表跨公司請求未被拒絕：'+cross.status);
  }
  console.log('Sales statistics verification passed for '+contexts.map(row=>String(row.source_database).toUpperCase()).join(', ')+'.');
}catch(error){
  console.error('Sales statistics verification failed: '+error.message);
  process.exitCode=1;
}
