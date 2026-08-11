let currentDatabase = localStorage.getItem('erp-source-database') || 'SH';
let companyContexts = [];
let currentCompanyContextKey = localStorage.getItem('erp-company-context') || '';
let currentCompanyContext = null;
const state = { module: 'DB', screen: 'basicdata', theme: localStorage.getItem('erp-theme') || 'brown' };
const inventoryOpeningState = { batch:null, lines:[] };

const masterConfigs = {
  warehouses: { title: '庫別建立作業', code: 'warehouse_code', name: 'warehouse_name', fields: [['warehouse_code','庫別代號'],['warehouse_name','庫別名稱'],['site_code','廠別'],['warehouse_type','庫別類型'],['allow_in','允許入庫'],['allow_out','允許出庫']] },
  departments: { title: '部門建立作業', code: 'department_code', name: 'department_name', fields: [['department_code','部門代號'],['department_name','部門名稱'],['note','備註'],['account_code','會計代號']] },
  employees: { title: '員工建立作業', code: 'employee_code', name: 'employee_name', fields: [['employee_code','員工代號'],['employee_name','員工姓名'],['company_code','公司代號'],['department_code','部門代號'],['job_title','職務'],['email','Email']] },
  customers: { title: '客戶資料建立作業', code: 'customer_code', name: 'customer_name', fields: [['customer_code','客戶代號'],['short_name','簡稱'],['customer_name','客戶名稱'],['responsible_person','負責人'],['contact_name','聯絡人'],['phone','電話'],['fax','傳真'],['email','Email'],['mobile','行動電話'],['tax_id','統一編號'],['currency_code','交易幣別'],['payment_term_code','付款條件代號'],['payment_term_source_value','來源付款條件'],['invoice_type','發票聯數'],['tax_type','課稅別'],['closing_day','結帳日期']] },
  suppliers: { title: '廠商資料建立作業', code: 'supplier_code', name: 'supplier_name', fields: [['supplier_code','廠商代號'],['short_name','簡稱'],['supplier_name','廠商名稱'],['supplier_class','廠商分類'],['responsible_person','負責人'],['contact_name','聯絡人'],['phone','電話'],['fax','傳真'],['email','Email'],['mobile','行動電話'],['tax_id','統一編號'],['currency_code','交易幣別'],['payment_method','付款方式（1現金／2電匯／3支票／4其他）'],['payment_term_code','標準付款條件代號'],['payment_term_source_value','來源付款條件'],['invoice_type','發票聯數'],['tax_type','課稅別'],['closing_month_offset','結帳月數'],['closing_day','結帳逢日']] }
  ,companies: { title: '公司資料建立作業', code: 'company_code', name: 'company_name', fields: [['company_code','公司代號'],['short_name','簡稱'],['company_name','公司名稱'],['address','地址'],['phone','電話'],['tax_id','統一編號']] },
  'code-rules': { title: '編碼原則查詢', code: 'rule_code', name: 'default_name', fields: [['rule_type','規則類型'],['rule_value','規則內容'],['rule_code','規則代號'],['default_name','預設名稱']] }
  ,'item-categories': { title: '品號類別建立作業', code: 'category_code', name: 'category_name', fields: [['category_type','類別類型'],['category_code','類別代號'],['category_name','類別名稱']] },
  items: { title: '品號主檔建立作業', code: 'item_code', name: 'item_name', fields: [['item_code','品號'],['item_name','品名'],['specification','規格'],['unit','單位'],['category_1','分類一'],['category_2','分類二'],['category_3','分類三']] },
  'job-categories': { title: '職務類別建立作業', code: 'job_code', name: 'job_name', fields: [['job_code','職務代號'],['job_category','職務分類'],['job_name','職務名稱'],['note','備註']], detail: { type:'job-category-employees', title:'職務所屬人員', code:'assignment_code', required:['job_code','employee_code'], fields:[['job_code','職務代號'],['employee_code','人員代號'],['assignment_type','職務分類'],['assignment_name','名稱'],['note','備註']], makeCode:data=>`${data.job_code}:${data.employee_code}` } },
  currencies: { title: '幣別匯率建立作業', code: 'currency_code', name: 'currency_name', fields: [['currency_code','幣別'],['currency_name','幣別名稱'],['unit_price_digits','單價取位'],['amount_digits','金額取位'],['unit_cost_digits','單位成本取位'],['cost_amount_digits','成本金額取位'],['note','備註']], detail: { type:'currency-rates', title:'生效日匯率', code:'rate_code', required:['currency_code','effective_date'], fields:[['currency_code','幣別'],['effective_date','生效日期（YYYYMMDD）'],['bank_buy_rate','銀行買進'],['bank_sell_rate','銀行賣出'],['customs_buy_rate','報關買進'],['customs_sell_rate','報關賣出']], makeCode:data=>`${data.currency_code}:${data.effective_date}` } },
  'payment-terms': { title: '付款條件建立作業', code: 'term_code', name: 'term_name', required:['term_type'], fields: [['term_type','類別（1採購／託工、2銷售）'],['term_code','代號'],['term_name','名稱'],['due_rule_type','預計收付規則'],['due_offset','結帳後日／月數'],['due_base_type','預計起算類型'],['due_base_day','預計逢日'],['due_months','結帳加月數'],['due_day','預計收付款逢日'],['realization_rule_type','資金實現規則'],['realization_offset','付款後日／月數'],['realization_base_type','實現起算類型'],['realization_base_day','實現逢日'],['realization_months','付款加月數'],['realization_day','資金實現逢日'],['note','備註']] },
  calendars: { title: '行事曆建立作業', code: 'calendar_code', name: 'shift_name', required:['industry_type','calendar_year','shift_code'], fields: [['calendar_code','行事曆代號'],['industry_type','行業別（1工廠、2銀行、3刷卡班別）'],['calendar_year','年度'],['shift_code','班別'],['shift_name','班別名稱'],['note','備註']], detail: { type:'calendar-days', title:'行事曆日期明細', code:'calendar_day_code', required:['industry_type','calendar_year','shift_code','work_date'], fields:[['industry_type','行業別'],['calendar_year','年度'],['shift_code','班別'],['work_date','日期（YYYYMMDD）'],['day_type','日期屬性'],['work_hours','工時'],['closed_flag','關閉註記'],['note','備註']], makeCode:data=>`${data.industry_type}-${data.calendar_year}-${data.shift_code}:${data.work_date}`, prepare:data=>({ ...data, calendar_code:`${data.industry_type}-${data.calendar_year}-${data.shift_code}` }) } }
};

const modules = [
  { id:'DB', name:'資料庫查詢', screens:[['basicdata','基本資料'],['companies','公司資料建立作業'],['common-parameters','共用參數查詢'],['code-rules','編碼原則查詢'],['job-categories','職務類別建立作業'],['currencies','幣別匯率建立作業'],['payment-terms','付款條件建立作業'],['calendars','行事曆建立作業'],['source-mappings','標準主檔對照表'],['import-monitor','匯入批次管理'],['warehouses','庫別建立作業'],['departments','部門建立作業'],['employees','員工建立作業'],['customers','客戶資料建立作業'],['suppliers','廠商資料建立作業']] },
  { id:'INV', name:'庫存管理', screens:[['item-categories','品號類別建立作業'],['items','品號主檔建立作業'],['inventory-opening','庫存開帳作業'],['inventory-detail','庫存明細表'],['inventory-ledger','庫存明細帳'],['inventory-balance','進耗存統計表'],['inventory-movement-stats','庫存異動統計表'],['department-movement-stats','部門異動單據統計表']] },
  { id:'PUR', name:'採購管理', screens:[['requisition-entry','請購建立作業'],['purchase-order-entry','採購建立作業'],['receipt-entry','進貨建立作業'],['purchase-receipts','進貨入庫明細']] }
];

modules.find(module => module.id === 'PUR').screens = [
  ['procurement-document-types','採購單據性質'],
  ['requisition-entry','請購建立作業'],
  ['requisition-maintenance','請購維護／轉採購'],
  ['purchase-order-entry','採購建立作業'],
  ['purchase-order-changes','採購變更'],
  ['receipt-entry','進貨建立作業'],
  ['receipt-inspection','進貨驗收'],
  ['purchase-returns','採購退貨／折讓'],
  ['purchase-progress','採購進度'],
  ['open-purchase-orders','未交採購查詢'],
  ['purchase-receipts','進貨入庫明細']
];
modules.find(module => module.id === 'INV').screens = [
  ['item-categories','品號類別建立作業'],['items','品號主檔建立作業'],['inventory-opening','庫存開帳作業'],
  ['inventory-document-types','庫存單據性質'],['inventory-transactions','庫存異動作業'],['inventory-transfers','轉撥作業'],
  ['inventory-temporary','暫出／暫入作業'],['inventory-stocktake','庫存盤點作業'],['inventory-posting','進貨／退貨庫存過帳'],['inventory-new-balance','新 ERP 庫存餘額'],
  ['inventory-new-ledger','新 ERP 庫存異動帳'],['inventory-detail','SH 庫存明細表'],['inventory-ledger','SH 庫存明細帳'],
  ['inventory-balance','SH 進耗存統計表'],['inventory-movement-stats','SH 庫存異動統計表'],['department-movement-stats','SH 部門異動統計表']
];
modules.push({id:'SAL',name:'銷售管理',screens:[['sales-document-types','銷售單據性質'],['sales-quotations','報價建立作業'],['sales-orders','訂單建立作業'],['sales-order-changes','訂單變更'],['sales-shipments','銷貨建立／出庫'],['sales-returns','銷退／折讓'],['sales-progress','訂單銷貨進度'],['sales-open-orders','未交訂單查詢']]});

modules.push({id:'FIN',name:'應收／應付管理',screens:[['ar-source','銷貨轉應收'],['ar-open','應收帳款'],['ar-receipt','收款沖銷'],['ar-notes','應收票據'],['ar-aging','未收帳款查詢'],['ap-source','進貨轉應付'],['ap-open','應付帳款'],['ap-payment','付款沖銷'],['ap-notes','應付票據'],['ap-aging','未付帳款查詢']]});

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

async function api(path, options = {}) {
  const requestScreen = state.screen;
  if (path === '/api/sales-workflow/documents' && options.method === 'POST') path = '/api/sales-workflow/create';
  const headers = new Headers(options.headers || {});
  const token = localStorage.getItem('erp-auth-token');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  headers.set('X-Source-Database', currentDatabase);
  headers.set('X-Company-Id', currentCompanyContext?.company_id || currentDatabase);
  const response = await fetch(path, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
  // 使用者切換分頁後，舊分頁的慢查詢不可再回寫目前畫面，避免表頭與資料列錯位。
  if (requestScreen !== state.screen) return await new Promise(() => {});
  let data = body.data ?? body;
  const recentList = /\/(documents|order-changes|open-items|settlements|source-documents|returns|pending-inspections|requisition-maintenance|progress|open-orders|notes)(\/|\?|$)/.test(path);
  if ((!options.method || options.method === 'GET') && recentList && Array.isArray(data)) {
    const dateFields = ['document_date','change_date','settlement_date','return_date','receipt_date','requisition_date','order_date','created_at'];
    data = [...data].sort((a,b) => {
      const av = dateFields.map(key => a?.[key]).find(Boolean) || '';
      const bv = dateFields.map(key => b?.[key]).find(Boolean) || '';
      return String(bv).localeCompare(String(av)) || Number(b?.id || 0) - Number(a?.id || 0);
    }).slice(0,10);
  }
  return data;
}

function toast(message, error = false) {
  const el = document.createElement('div'); el.className = `toast ${error ? 'error' : ''}`; el.textContent = message;
  document.body.appendChild(el); setTimeout(() => el.remove(), 3200);
}

function renderSidebar() {
  $('#sidebar').innerHTML = modules.map(module => `<div class="group"><div class="group-title">${esc(module.name)}</div><button class="module ${state.module === module.id ? 'active' : ''}" data-module="${module.id}"><span class="id">${module.id}</span><span class="name">${esc(module.name)}</span></button></div>`).join('');
  document.querySelectorAll('[data-module]').forEach(button => button.onclick = () => { state.module = button.dataset.module; state.screen = modules.find(x => x.id === state.module).screens[0][0]; renderAll(); });
}

function renderTabs() {
  const module = modules.find(x => x.id === state.module) || modules[0];
  $('#tabbar').innerHTML = module.screens.map(([id, title]) => `<button class="tab ${id === state.screen ? 'active' : ''}" data-screen="${id}">${esc(title)}</button>`).join('');
  document.querySelectorAll('[data-screen]').forEach(button => button.onclick = () => { state.screen = button.dataset.screen; renderAll(); });
}

function renderAll() {
  renderSidebar(); renderTabs(); renderScreen();
  $('#breadcrumb').textContent = `${modules.find(x => x.id === state.module)?.name || ''} / ${getTitle(state.screen)}`;
}

function getTitle(screen) {
  for (const module of modules) for (const [id, title] of module.screens) if (id === screen) return title;
  return screen;
}

function renderScreen() {
  const config = masterConfigs[state.screen];
  if (config) return renderMasterScreen(state.screen, config);
  if (state.screen === 'basicdata') return renderBasicData();
  if (state.screen === 'source-mappings') return renderSourceMappings();
  if (state.screen === 'import-monitor') return renderImportMonitor();
  if (state.screen === 'common-parameters') return renderCommonParameters();
  if (state.screen === 'inventory-opening') return renderInventoryOpening();
  if (state.screen.startsWith('inventory-') && ['inventory-document-types','inventory-transactions','inventory-transfers','inventory-temporary','inventory-stocktake','inventory-posting','inventory-new-balance','inventory-new-ledger'].includes(state.screen)) return renderInventoryWorkflow(state.screen);
  if (state.module === 'PUR') return renderProcurementScreen(state.screen);
  if (state.module === 'SAL') return renderSalesScreen(state.screen);
  if (state.module === 'FIN') return renderFinanceScreen(state.screen);
  $('#canvas').innerHTML = `<section class="screen"><div class="screen-head"><h2>${esc(getTitle(state.screen))}</h2><button class="btn" id="refreshScreen">重新整理</button></div><div class="screen-body"><div class="desc">此作業已保留流程位置，後續會依 iSM 文件接續資料表與單據欄位。</div><div class="empty-hint">目前尚未載入資料。</div></div></section>`;
  $('#refreshScreen').onclick = refresh;
}

function renderInventoryOpening() {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone:'Asia/Taipei' }).replaceAll('-', '');
  $('#canvas').innerHTML = `<section class="screen"><div class="screen-head"><h2>庫存開帳作業</h2><span class="code">INV-OPEN</span><button class="btn" id="refreshOpening">重新整理</button></div><div class="screen-body">
    <div class="desc">依 iSM 期初開帳流程，先由 SH.invmc 帶入品號、庫別、目前庫存數量與庫存金額，修正錯誤後依序驗證、核准、正式過帳。SH 全程唯讀。</div>
    <form id="openingImportForm" class="form"><div class="row c3"><div class="field"><label>開帳日期（YYYYMMDD）</label><input name="opening_date" value="${today}" pattern="\d{8}" required></div><div class="field"><label>備註</label><input name="note" placeholder="例如：SH 首次庫存開帳"></div></div><button class="btn primary" type="submit">從 SH 建立開帳草稿</button></form>
    <div class="panel"><div class="panel-head"><span>開帳批次</span><button class="btn small" id="validateOpening" hidden>驗證</button><button class="btn small" id="approveOpening" hidden>核准</button><button class="btn small primary" id="postOpening" hidden>正式過帳</button></div><div class="panel-body" id="openingSummary"><div class="empty-hint">載入中…</div></div></div>
    <div class="panel" id="openingLineEditor" hidden><div class="panel-head">修正開帳明細</div><div class="panel-body"><form id="openingLineForm" class="form"><input type="hidden" name="line_id"><div class="row c3"><div class="field"><label>品號／庫別</label><input name="identity" readonly></div><div class="field"><label>庫存數量</label><input name="quantity" type="number" step="0.001" required></div><div class="field"><label>庫存金額</label><input name="amount" type="number" step="0.000001" required></div><div class="field"><label>修正備註</label><input name="note"></div></div><button class="btn primary" type="submit">儲存修正</button><button class="btn" id="cancelOpeningEdit" type="button">取消</button></form></div></div>
    <div class="panel"><div class="panel-head"><span>開帳明細</span><input id="openingKeyword" placeholder="品號、品名、庫別或錯誤"><button class="btn small" id="searchOpening" type="button">查詢</button></div><div class="panel-body"><div id="openingLineStatus" class="desc">載入中…</div><div class="table-wrap"><table class="grid"><thead><tr><th>狀態</th><th>品號</th><th>品名</th><th>庫別</th><th>儲位</th><th>數量</th><th>單位成本</th><th>金額</th><th>檢核訊息</th><th>操作</th></tr></thead><tbody id="openingRows"></tbody></table></div></div></div>
  </div></section>`;
  $('#refreshOpening').onclick = loadInventoryOpening; $('#searchOpening').onclick = loadInventoryOpening;
  $('#openingImportForm').onsubmit = importInventoryOpening; $('#openingLineForm').onsubmit = saveInventoryOpeningLine;
  $('#cancelOpeningEdit').onclick = () => { $('#openingLineEditor').hidden = true; };
  $('#validateOpening').onclick = () => runInventoryOpeningAction('validate');
  $('#approveOpening').onclick = () => runInventoryOpeningAction('approve');
  $('#postOpening').onclick = () => runInventoryOpeningAction('post');
  loadInventoryOpening();
}

async function loadInventoryOpening() {
  try {
    const keyword = $('#openingKeyword')?.value || '';
    const data = await api(`/api/inventory-opening?db=${encodeURIComponent(currentDatabase)}&keyword=${encodeURIComponent(keyword)}&limit=500`);
    inventoryOpeningState.batch = data.batch; inventoryOpeningState.lines = data.lines || [];
    if (!data.batch) {
      $('#openingSummary').innerHTML = '<div class="empty-hint">尚未建立庫存開帳草稿。</div>';
      $('#openingLineStatus').textContent = '請先從 SH 建立開帳草稿。'; $('#openingRows').innerHTML = '<tr><td colspan="10" class="empty-hint">目前沒有資料</td></tr>'; return;
    }
    const b=data.batch;
    $('#openingSummary').innerHTML = `<div class="row c3"><div><strong>開帳單號</strong><br>${esc(b.opening_no)}</div><div><strong>狀態</strong><br>${esc(b.status)}</div><div><strong>開帳日期</strong><br>${esc(b.opening_date)}</div><div><strong>來源／匯入</strong><br>${b.source_rows}／${b.imported_rows} 筆</div><div><strong>錯誤／警告</strong><br>${b.error_rows}／${b.warning_rows} 筆</div><div><strong>數量／金額</strong><br>${Number(b.total_quantity).toLocaleString()}／${Number(b.total_amount).toLocaleString()}</div></div>`;
    $('#validateOpening').hidden = !['draft','draft_with_errors','validated'].includes(b.status);
    $('#approveOpening').hidden = b.status !== 'validated'; $('#postOpening').hidden = b.status !== 'approved';
    $('#openingLineStatus').textContent = `來源：${data.source}；目前顯示 ${data.lines.length} 筆（錯誤與警告優先）`;
    $('#openingRows').innerHTML = data.lines.map(row => `<tr><td>${esc(row.validation_status)}</td><td>${esc(row.item_code)}</td><td>${esc(row.item_name)}</td><td>${esc(row.warehouse_code)} ${esc(row.warehouse_name)}</td><td>${esc(row.location_code)}</td><td>${Number(row.quantity).toLocaleString()}</td><td>${Number(row.unit_cost).toLocaleString()}</td><td>${Number(row.amount).toLocaleString()}</td><td>${esc(row.validation_message || '')}</td><td><button class="btn small" type="button" data-opening-line="${row.id}">修改</button></td></tr>`).join('') || '<tr><td colspan="10" class="empty-hint">沒有符合條件的明細</td></tr>';
    document.querySelectorAll('[data-opening-line]').forEach(button => button.onclick = () => editInventoryOpeningLine(Number(button.dataset.openingLine)));
  } catch (error) { if ($('#openingLineStatus')) $('#openingLineStatus').textContent=error.message; }
}

async function importInventoryOpening(event) {
  event.preventDefault(); const body=Object.fromEntries(new FormData(event.currentTarget).entries());
  try { await api(`/api/inventory-opening/import?db=${encodeURIComponent(currentDatabase)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); toast('SH 庫存已建立為新 ERP 開帳草稿'); await loadInventoryOpening(); } catch(error){toast(error.message,true);}
}

function editInventoryOpeningLine(id) {
  const row=inventoryOpeningState.lines.find(item=>Number(item.id)===id); if(!row)return;
  const form=$('#openingLineForm'); form.elements.line_id.value=id; form.elements.identity.value=`${row.item_code} / ${row.warehouse_code}`; form.elements.quantity.value=row.quantity; form.elements.amount.value=row.amount; form.elements.note.value=row.note||''; $('#openingLineEditor').hidden=false;
}

async function saveInventoryOpeningLine(event) {
  event.preventDefault(); const form=event.currentTarget; const id=form.elements.line_id.value; const batch=inventoryOpeningState.batch;
  try { await api(`/api/inventory-opening/${batch.id}/lines/${id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({quantity:form.elements.quantity.value,amount:form.elements.amount.value,note:form.elements.note.value})}); toast('開帳明細已修正'); $('#openingLineEditor').hidden=true; await loadInventoryOpening(); } catch(error){toast(error.message,true);}
}

async function runInventoryOpeningAction(action) {
  const batch=inventoryOpeningState.batch; if(!batch)return;
  try { await api(`/api/inventory-opening/${batch.id}/${action}`,{method:'POST'}); toast(action==='validate'?'開帳驗證完成':action==='approve'?'開帳已核准':'開帳已正式過帳'); await loadInventoryOpening(); } catch(error){toast(error.message,true);}
}

function renderSourceMappings() {
  $('#canvas').innerHTML = `<section class="screen"><div class="screen-head"><h2>標準主檔與來源對照表</h2><span class="code">inventory_erp</span><button class="btn" id="refreshScreen">重新整理</button></div><div class="screen-body"><div class="desc">本表記錄新 ERP 標準欄位與客戶來源資料表／欄位的關係。來源資料庫維持唯讀，尚未確認的欄位會標示「待確認」。</div><div class="table-wrap"><table class="grid"><thead><tr><th>來源庫</th><th>來源表</th><th>來源欄位</th><th>標準主檔</th><th>標準欄位</th><th>鍵值</th><th>證據狀態</th><th>備註</th></tr></thead><tbody id="mappingRows"></tbody></table></div></div></section>`;
  $('#refreshScreen').onclick = loadSourceMappings; loadSourceMappings();
}

async function loadSourceMappings() {
  try {
    const rows = await api(`/api/master-source-mappings?db=${encodeURIComponent(currentDatabase)}`);
    $('#mappingRows').innerHTML = rows.map(row => `<tr><td>${esc(row.source_database)}</td><td>${esc(row.source_table)}</td><td>${esc(row.source_field)}</td><td>${esc(row.standard_table)}</td><td>${esc(row.standard_field)}</td><td>${row.is_key ? '是' : ''}</td><td>${esc(row.evidence_status)}</td><td>${esc(row.note || '')}</td></tr>`).join('') || '<tr><td colspan="8" class="empty-hint">目前沒有已建立的對照資料</td></tr>';
  } catch (error) { if ($('#mappingRows')) $('#mappingRows').innerHTML = `<tr><td colspan="8" class="empty-hint">${esc(error.message)}</td></tr>`; }
}

function renderCommonParameters() {
  $('#canvas').innerHTML = `<section class="screen"><div class="screen-head"><h2>共用參數查詢</h2><span class="code">CMSI01 / cmsma</span><button class="btn" id="refreshScreen">重新整理</button></div><div class="screen-body"><div class="desc">先保留 SH cmsma 的實際欄位代號與原值，待文件確認欄位語意後，再轉換為日期格式、稅率、幣別等標準名稱。</div><div class="panel"><div class="panel-head"><input id="commonKeyword" placeholder="搜尋欄位或參數值"><button class="btn small" id="commonSearch" type="button">查詢</button></div><div class="panel-body"><div class="table-wrap"><table class="grid"><thead><tr><th>參數欄位</th><th>原始值</th><th>資料型態</th><th>來源欄位</th></tr></thead><tbody id="commonRows"></tbody></table></div></div></div></div></section>`;
  $('#refreshScreen').onclick = loadCommonParameters; $('#commonSearch').onclick = loadCommonParameters; loadCommonParameters();
}

async function loadCommonParameters() {
  try { const keyword = $('#commonKeyword')?.value || ''; const rows = await api(`/api/master/common-parameters?db=${encodeURIComponent(currentDatabase)}&keyword=${encodeURIComponent(keyword)}`); $('#commonRows').innerHTML = rows.map(row => `<tr><td>${esc(row.parameter_code)}</td><td>${esc(row.parameter_value)}</td><td>${esc(row.data_type)}</td><td>${esc(row.source_field)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty-hint">目前沒有參數資料</td></tr>'; } catch (error) { $('#commonRows').innerHTML = `<tr><td colspan="4" class="empty-hint">${esc(error.message)}</td></tr>`; }
}

function renderImportMonitor() {
  $('#canvas').innerHTML = `<section class="screen"><div class="screen-head"><h2>匯入批次管理</h2><span class="code">inventory_erp</span><button class="btn" id="refreshScreen">重新整理</button></div><div class="screen-body"><div class="desc">記錄來源資料匯入批次、來源／目標筆數核對，以及待處理錯誤。SH 為目前主要匯入來源。</div><div class="table-wrap"><table class="grid"><thead><tr><th>批次</th><th>來源</th><th>租戶／公司</th><th>狀態</th><th>來源筆數</th><th>匯入筆數</th><th>錯誤筆數</th><th>未處理錯誤</th></tr></thead><tbody id="importBatchRows"></tbody></table></div><div class="panel" id="importBatchDetail" hidden><div class="panel-head">批次明細</div><div class="panel-body" id="importBatchDetailBody"></div></div></div></section>`;
  $('#refreshScreen').onclick = loadImportBatches; loadImportBatches();
}

async function loadImportBatches() {
  try {
    const rows = await api('/api/import/batches?limit=50');
    $('#importBatchRows').innerHTML = rows.map(row => `<tr data-batch-id="${row.id}"><td>${esc(row.batch_no)}</td><td>${esc(row.source_database)} / ${esc(row.source_system)}</td><td>${esc(row.tenant_id)} / ${esc(row.company_id)}</td><td>${esc(row.status)}</td><td>${row.total_rows}</td><td>${row.imported_rows}</td><td>${row.error_rows}</td><td>${row.open_error_count}</td></tr>`).join('') || '<tr><td colspan="8" class="empty-hint">目前沒有匯入批次</td></tr>';
    document.querySelectorAll('[data-batch-id]').forEach(row => row.onclick = () => loadImportBatchDetail(row.dataset.batchId));
  } catch (error) { $('#importBatchRows').innerHTML = `<tr><td colspan="8" class="empty-hint">${esc(error.message)}</td></tr>`; }
}

async function loadImportBatchDetail(id) {
  try {
    const data = await api(`/api/import/batches/${encodeURIComponent(id)}`); const detail = $('#importBatchDetail'); const body = $('#importBatchDetailBody'); detail.hidden = false;
    const errors = data.errors.map(error => `<tr><td>${esc(error.source_table)}</td><td>${esc(error.source_key || '')}</td><td>${esc(error.error_code)}</td><td>${esc(error.error_message)}</td><td>${esc(error.status)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty-hint">沒有錯誤</td></tr>';
    body.innerHTML = `<div class="desc">${esc(data.batch.batch_no)} · ${esc(data.batch.status)} · ${esc(data.batch.notes || '')}</div><table class="grid"><thead><tr><th>來源表</th><th>來源鍵值</th><th>錯誤代碼</th><th>錯誤訊息</th><th>狀態</th></tr></thead><tbody>${errors}</tbody></table>`;
  } catch (error) { toast(error.message, true); }
}

function renderBasicData() {
  $('#canvas').innerHTML = `<section class="screen"><div class="screen-head"><h2>基本資料</h2><span class="code">CMS-BASE</span><button class="btn" id="refreshScreen">重新整理</button></div><div class="screen-body"><div class="desc">來源資料庫只供查詢；庫別、部門、員工、客戶、廠商的新增與修改，均寫入 inventory_erp 的新 ERP 主檔。</div><div class="panel"><div class="panel-head">可查詢的資料來源</div><div class="panel-body" id="sourceList">載入中…</div></div><div class="panel"><div class="panel-head">主檔資料維護</div><div class="panel-body">請從上方分頁進入建立作業。資料會依目前選取的資料來源建立對應的 inventory_erp 主檔。</div></div></div></section>`;
  $('#refreshScreen').onclick = refresh; loadDatabaseOptions();
}

async function loadDatabaseOptions() {
  try {
    const rows = await api('/api/source-databases');
    $('#sourceList').innerHTML = rows.map(row => `<button class="database-option" type="button" data-source="${esc(row.key)}"><i class="database-status ${row.exists ? 'ready' : ''}"></i><span>${esc(row.label)}<small>${row.exists ? `可用 · ${row.tableCount} 張表 · 唯讀` : '資料庫不存在'}</small></span></button>`).join('');
    document.querySelectorAll('[data-source]').forEach(button => button.onclick = () => selectSourceDatabase(button.dataset.source));
    updateContextButtons();
  } catch (error) { $('#sourceList').textContent = error.message; }
}

function updateContextButtons() {
  const companyButton = $('#companyButton');
  const databaseButton = $('#databaseButton');
  const company = currentCompanyContext;
  if (companyButton) companyButton.textContent = `🏢 公司：${company?.short_name || company?.company_code || currentDatabase}`;
  if (databaseButton) databaseButton.textContent = `🗄️ 資料庫：${currentDatabase}`;
}

function renderCompanyOptions() {
  const container = $('#companyOptions');
  if (!container) return;
  container.innerHTML = companyContexts.map(row => `<button class="company-option" type="button" data-company-context="${esc(row.context_key)}"><i class="company-status ${row.source_database === currentDatabase ? 'ready' : ''}"></i><span>${esc(row.company_name)}${row.short_name && row.short_name !== row.company_name ? `（${esc(row.short_name)}）` : ''}<small>公司代號：${esc(row.company_code)} · 來源：${esc(row.source_database)}${row.has_company_master ? ' · 已建立公司主檔' : ' · 使用來源設定'}</small></span></button>`).join('') || '<div class="empty-hint">目前沒有可用的公司別設定</div>';
  container.querySelectorAll('[data-company-context]').forEach(button => button.onclick = () => selectCompanyContext(button.dataset.companyContext));
}

async function loadCompanyOptions() {
  try {
    const rows = await api('/api/company-contexts');
    companyContexts = Array.isArray(rows) ? rows : [];
    const selected = companyContexts.find(row => row.context_key === currentCompanyContextKey)
      || companyContexts.find(row => row.source_database === currentDatabase)
      || companyContexts[0];
    if (selected) {
      currentCompanyContext = selected;
      currentCompanyContextKey = selected.context_key;
      currentDatabase = selected.source_database;
      localStorage.setItem('erp-company-context', selected.context_key);
      localStorage.setItem('erp-source-database', currentDatabase);
    }
    renderCompanyOptions();
    updateContextButtons();
  } catch (error) {
    companyContexts = [];
    renderCompanyOptions();
    updateContextButtons();
  }
}

function selectCompanyContext(contextKey) {
  const selected = companyContexts.find(row => row.context_key === contextKey);
  if (!selected) return;
  currentCompanyContext = selected;
  currentCompanyContextKey = selected.context_key;
  currentDatabase = selected.source_database;
  localStorage.setItem('erp-company-context', selected.context_key);
  localStorage.setItem('erp-source-database', currentDatabase);
  updateContextButtons();
  renderCompanyOptions();
  $('#companyPopover').hidden = true;
  $('#databasePopover').hidden = true;
  toast(`已切換公司：${selected.company_name}（${selected.source_database}）`);
  renderAll();
}

function selectSourceDatabase(sourceKey) {
  const selected = companyContexts.find(row => row.source_database === String(sourceKey).toUpperCase());
  if (selected) return selectCompanyContext(selected.context_key);
  currentDatabase = String(sourceKey).toUpperCase();
  localStorage.setItem('erp-source-database', currentDatabase);
  currentCompanyContext = null;
  updateContextButtons();
  $('#databasePopover').hidden = true;
  toast(`已切換資料來源：${currentDatabase}`);
  renderAll();
}

function renderMasterScreen(type, config) {
  const detailPanel = config.detail ? `<div class="panel"><div class="panel-head"><span>${esc(config.detail.title)}</span></div><div class="panel-body"><form id="masterDetailForm" class="form"><div class="row c3">${config.detail.fields.map(([field,label]) => `<div class="field"><label>${esc(label)}</label><input name="${field}" ${(config.detail.required || []).includes(field) ? 'required' : ''}></div>`).join('')}</div><button class="btn primary" type="submit">新增明細</button><button class="btn" type="button" id="cancelDetailEdit" hidden>取消修改</button></form><div id="masterDetailStatus" class="desc">載入中…</div><div class="table-wrap"><table class="grid"><thead><tr>${config.detail.fields.map(([,label]) => `<th>${esc(label)}</th>`).join('')}<th>操作</th></tr></thead><tbody id="masterDetailRows"></tbody></table></div></div></div>` : '';
  $('#canvas').innerHTML = `<section class="screen"><div class="screen-head"><h2>${esc(config.title)}</h2><span class="code">inventory_erp</span><button class="btn" id="refreshScreen">重新整理</button></div><div class="screen-body"><div class="desc">目前資料來源：${esc(currentDatabase)}。來源資料庫只讀；本頁新增、修改只寫入 inventory_erp 標準主檔。</div><form id="masterForm" class="form"><div class="row c3">${config.fields.map(([field,label]) => `<div class="field"><label>${esc(label)}</label><input name="${field}" ${field === config.code || (config.required || []).includes(field) ? 'required' : ''}></div>`).join('')}</div><button class="btn primary" type="submit">新增資料</button><button class="btn" type="button" id="cancelEdit" hidden>取消修改</button></form><div class="panel"><div class="panel-head"><span>近期資料</span><input id="masterKeyword" placeholder="關鍵字查詢"><button class="btn small" id="masterSearch" type="button">查詢</button></div><div class="panel-body"><div id="masterStatus" class="desc">載入中…</div><div class="table-wrap"><table class="grid"><thead><tr>${config.fields.map(([,label]) => `<th>${esc(label)}</th>`).join('')}<th>操作</th></tr></thead><tbody id="masterRows"></tbody></table></div></div></div>${detailPanel}</div></section>`;
  $('#refreshScreen').onclick = () => loadMasterRows(type, config); $('#masterSearch').onclick = () => loadMasterRows(type, config); $('#masterForm').onsubmit = event => saveMaster(event, type, config); $('#cancelEdit').onclick = () => resetMasterForm(config);
  if (config.detail) { $('#masterDetailForm').onsubmit = event => saveMasterDetail(event, config.detail); $('#cancelDetailEdit').onclick = () => resetMasterDetailForm(config.detail); }
  loadMasterRows(type, config);
}

async function loadMasterRows(type, config) {
  try {
    const keyword = $('#masterKeyword')?.value || ''; const rows = await api(`/api/master/${type}?db=${encodeURIComponent(currentDatabase)}&keyword=${encodeURIComponent(keyword)}`);
    $('#masterStatus').textContent = `資料來源：inventory_erp.erp_${type} · ${rows.length} 筆`;
    $('#masterRows').innerHTML = rows.map(row => `<tr>${config.fields.map(([field]) => `<td>${esc(row[field])}</td>`).join('')}<td><button class="btn small" type="button" data-edit-code="${esc(row[config.code])}">修改</button></td></tr>`).join('') || `<tr><td colspan="${config.fields.length + 1}" class="empty-hint">目前沒有資料</td></tr>`;
    document.querySelectorAll('[data-edit-code]').forEach(button => button.onclick = () => editMaster(button.dataset.editCode, type, config));
    if (config.detail) await loadMasterDetailRows(config.detail);
  } catch (error) { if ($('#masterStatus')) $('#masterStatus').textContent = error.message; }
}

async function loadMasterDetailRows(detail) {
  try {
    const rows = await api(`/api/master/${detail.type}?db=${encodeURIComponent(currentDatabase)}`);
    $('#masterDetailStatus').textContent = `標準明細共 ${rows.length} 筆`;
    $('#masterDetailRows').innerHTML = rows.map(row => `<tr>${detail.fields.map(([field]) => `<td>${esc(row[field])}</td>`).join('')}<td><button class="btn small" type="button" data-edit-detail="${esc(row[detail.code])}">修改</button></td></tr>`).join('') || `<tr><td colspan="${detail.fields.length + 1}" class="empty-hint">目前無明細資料</td></tr>`;
    document.querySelectorAll('[data-edit-detail]').forEach(button => button.onclick = () => editMasterDetail(button.dataset.editDetail, detail));
  } catch (error) { if ($('#masterDetailStatus')) $('#masterDetailStatus').textContent = error.message; }
}

async function editMasterDetail(code, detail) {
  const rows = await api(`/api/master/${detail.type}?db=${encodeURIComponent(currentDatabase)}&keyword=${encodeURIComponent(code)}`);
  const row = rows.find(item => String(item[detail.code]) === String(code)); const form = $('#masterDetailForm');
  if (!row || !form) return; detail.fields.forEach(([field]) => { form.elements[field].value = row[field] ?? ''; });
  form.dataset.editCode = code; form.querySelector('button[type=submit]').textContent = '儲存明細修改'; $('#cancelDetailEdit').hidden = false;
}

async function saveMasterDetail(event, detail) {
  event.preventDefault(); const form = event.currentTarget; let data = Object.fromEntries(new FormData(form).entries());
  if (detail.prepare) data = detail.prepare(data); data[detail.code] = form.dataset.editCode || detail.makeCode(data); const code = form.dataset.editCode;
  try {
    await api(`/api/master/${detail.type}${code ? `/${encodeURIComponent(code)}` : ''}?db=${encodeURIComponent(currentDatabase)}`, { method:code ? 'PUT' : 'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) });
    toast(code ? '明細修改已寫入 inventory_erp' : '明細新增已寫入 inventory_erp'); resetMasterDetailForm(detail); await loadMasterDetailRows(detail);
  } catch (error) { toast(error.message, true); }
}

function resetMasterDetailForm(detail) { const form = $('#masterDetailForm'); if (!form) return; form.reset(); delete form.dataset.editCode; form.querySelector('button[type=submit]').textContent = '新增明細'; $('#cancelDetailEdit').hidden = true; }

async function editMaster(code, type, config) {
  const rows = await api(`/api/master/${type}?db=${encodeURIComponent(currentDatabase)}&keyword=${encodeURIComponent(code)}`); const row = rows.find(item => String(item[config.code]) === String(code)); const form = $('#masterForm');
  if (!row || !form) return; config.fields.forEach(([field]) => { form.elements[field].value = row[field] ?? ''; }); form.dataset.editCode = code; form.elements[config.code].readOnly = true; form.querySelector('button[type=submit]').textContent = '儲存修改'; $('#cancelEdit').hidden = false;
}

async function saveMaster(event, type, config) {
  event.preventDefault(); const form = event.currentTarget; const data = Object.fromEntries(new FormData(form).entries()); const code = form.dataset.editCode;
  try { await api(`/api/master/${type}${code ? `/${encodeURIComponent(code)}` : ''}?db=${encodeURIComponent(currentDatabase)}`, { method: code ? 'PUT' : 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }); toast(code ? '修改已寫入 inventory_erp' : '新增已寫入 inventory_erp'); resetMasterForm(config); await loadMasterRows(type, config); } catch (error) { toast(error.message, true); }
}

function resetMasterForm(config) { const form = $('#masterForm'); if (!form) return; form.reset(); delete form.dataset.editCode; form.elements[config.code].readOnly = false; form.querySelector('button[type=submit]').textContent = '新增資料'; $('#cancelEdit').hidden = true; }
const inventoryKinds={issue:'其他領料',return:'其他退料',adjust_in:'庫存增加調整',adjust_out:'庫存減少調整',scrap:'庫存報廢',cost_adjust:'成本調整',transfer:'庫存轉撥',temp_in:'暫入',temp_in_return:'暫入歸還',temp_out:'暫出',temp_out_return:'暫出歸還',stocktake:'盤點調整'};
const salesKinds={quotation:'報價單',sales_order:'客戶訂單',shipment:'銷貨單',sales_return:'銷退／折讓單'};
function salesShell(t,b){$('#canvas').innerHTML=`<section class="screen"><div class="screen-head"><h2>${t}</h2><span class="code">inventory_erp</span></div><div class="screen-body"><div class="desc">SH COP* 僅供歷史查詢；新單據與庫存異動只寫入 inventory_erp。</div>${b}</div></section>`;}
function renderSalesScreen(s){if(s==='sales-document-types')return renderSalesTypes();if(s==='sales-progress'||s==='sales-open-orders')return renderSalesProgress(s==='sales-open-orders');if(s==='sales-order-changes')return renderSalesChanges();renderSalesEntry({'sales-quotations':'quotation','sales-orders':'sales_order','sales-shipments':'shipment','sales-returns':'sales_return'}[s]);}
function renderSalesTypes(){salesShell('銷售單據性質',`<form id="salesForm" class="form"><div class="row c3">${selectField('document_kind','種類',Object.entries(salesKinds).map(([k,v])=>`<option value="${k}">${v}</option>`).join(''))}${field('type_code','代號','text','required')}${field('type_name','名稱','text','required')}${field('number_prefix','前綴')}</div><button class="btn primary">新增</button></form>${panelTable('現有性質',['種類','代號','名稱','前綴'],'salesRows')}`);$('#salesForm').onsubmit=async e=>{e.preventDefault();let d=Object.fromEntries(new FormData(e.currentTarget));d.source_database=currentDatabase;try{await api('/api/sales-workflow/document-types',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});renderSalesTypes();}catch(x){toast(x.message,true);}};loadSalesTypes();}
async function loadSalesTypes(render=true){let r=await api(`/api/sales-workflow/document-types?source_database=${currentDatabase}`);if(render&&$('#salesRows'))$('#salesRows').innerHTML=r.map(x=>`<tr><td>${salesKinds[x.document_kind]}</td><td>${x.type_code}</td><td>${x.type_name}</td><td>${x.number_prefix}</td></tr>`).join('');return r;}
function renderSalesEntry(k){salesShell(salesKinds[k]+'建立作業',`<form id="salesForm" class="form"><input type="hidden" name="document_kind" value="${k}"><div class="row c3">${selectField('document_type','單據性質','')}${field('document_date','日期','text',`value="${procurementToday()}"`)}${field('customer_code','客戶','text','required')}${field('warehouse_code','庫別')}${field('item_code','品號','text','required')}${field('item_name','品名')}${field('unit','單位','text','value="PCS"')}${field('quantity','數量','number','step="0.001" required')}${field('unit_price','單價','number','value="0"')}${field('unit_cost','成本','number','value="0"')}${field('expected_date','預交日')}${k==='sales_return'?selectField('return_type','方式','<option value="return">銷退</option><option value="allowance">折讓</option>'):''}</div><button class="btn primary">建立草稿</button></form>${panelTable('近期單據',['單號','日期','客戶','品號','數量','已交','狀態','作業'],'salesRows')}`);$('#salesForm').onsubmit=async e=>{e.preventDefault();let d=Object.fromEntries(new FormData(e.currentTarget));d.source_database=currentDatabase;try{await api('/api/sales-workflow/documents',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});renderSalesEntry(k);}catch(x){toast(x.message,true);}};loadSalesTypes(false).then(t=>$('#salesForm').elements.document_type.innerHTML=t.filter(x=>x.document_kind===k).map(x=>`<option value="${x.type_code}">${x.type_code}｜${x.type_name}</option>`).join(''));loadSalesDocs(k);}
async function loadSalesDocs(k){let r=await api(`/api/sales-workflow/documents?source_database=${currentDatabase}&document_kind=${k}`);$('#salesRows').innerHTML=r.map(x=>`<tr><td>${x.document_no}</td><td>${x.document_date}</td><td>${x.customer_code}</td><td>${x.item_code}</td><td>${x.quantity}</td><td>${x.related_quantity}</td><td>${x.status}</td><td>${x.status==='draft'?`<button class="btn small" data-sact="approve:${x.id}">核準</button>`:['shipment','sales_return'].includes(k)&&x.status==='approved'?`<button class="btn small primary" data-sact="post:${x.id}">庫存過帳</button>`:'完成'}</td></tr>`).join('');document.querySelectorAll('[data-sact]').forEach(b=>b.onclick=async()=>{let[a,id]=b.dataset.sact.split(':');try{await api(`/api/sales-workflow/documents/${id}/${a}`,{method:'POST'});loadSalesDocs(k);}catch(e){toast(e.message,true);}});}
function renderSalesChanges(){salesShell('訂單變更',panelTable('訂單變更紀錄',['變更單','訂單','日期','品號','新數量','新單價','狀態'],'salesRows'));api(`/api/sales-workflow/order-changes?source_database=${currentDatabase}`).then(r=>$('#salesRows').innerHTML=r.map(x=>`<tr><td>${x.change_no}</td><td>${x.document_no}</td><td>${x.change_date}</td><td>${x.item_code}</td><td>${x.new_quantity}</td><td>${x.new_unit_price}</td><td>${x.status}</td></tr>`).join('')||'<tr><td colspan="7">尚無訂單變更</td></tr>').catch(e=>toast(e.message,true));}
function renderSalesProgress(open){salesShell(open?'未交訂單查詢':'訂單銷貨進度',panelTable('訂單進度',['訂單','日期','客戶','品號','訂單量','已交量','未交量','未交金額','狀態'],'salesRows'));api(`/api/sales-workflow/progress?source_database=${currentDatabase}`).then(r=>$('#salesRows').innerHTML=r.filter(x=>!open||Number(x.remaining_quantity)>0).map(x=>`<tr><td>${x.document_no}</td><td>${x.document_date}</td><td>${x.customer_code}</td><td>${x.item_code}</td><td>${x.quantity}</td><td>${x.related_quantity}</td><td>${x.remaining_quantity}</td><td>${x.remaining_amount}</td><td>${x.status}</td></tr>`).join('')).catch(e=>toast(e.message,true));}

function renderFinanceScreen(s){const type=s.startsWith('ar-')?'AR':'AP';if(s.endsWith('source'))return renderFinanceSource(type);if(s.endsWith('receipt')||s.endsWith('payment'))return renderFinanceSettlement(type);if(s.endsWith('notes'))return renderFinanceNotes(type);renderFinanceOpen(type,s.endsWith('aging'));}
function finShell(t,b){$('#canvas').innerHTML=`<section class="screen"><div class="screen-head"><h2>${t}</h2><span class="code">inventory_erp</span></div><div class="screen-body"><div class="desc">財務資料只寫入 inventory_erp；SH ACR／ACP 維持唯讀。</div>${b}</div></section>`;}
function renderFinanceSource(type){finShell(type==='AR'?'銷貨轉應收':'進貨轉應付',panelTable('待立帳來源',['來源單號','日期','對象','金額','作業'],'financeRows'));api(`/api/finance-workflow/source-documents?source_database=${currentDatabase}&account_type=${type}`).then(r=>{$('#financeRows').innerHTML=r.map((x,i)=>`<tr><td>${x.source_document_no}</td><td>${x.document_date}</td><td>${x.party_code}</td><td>${x.amount}</td><td><button class="btn small primary" data-fsrc="${i}">建立草稿</button></td></tr>`).join('')||'<tr><td colspan="5">沒有待立帳來源</td></tr>';document.querySelectorAll('[data-fsrc]').forEach(b=>b.onclick=async()=>{let x=r[+b.dataset.fsrc];try{await api('/api/finance-workflow/open-items',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...x,source_database:currentDatabase,account_type:type,original_amount:x.amount,due_date:x.document_date})});renderFinanceSource(type);}catch(e){toast(e.message,true);}});}).catch(e=>toast(e.message,true));}
function renderFinanceOpen(type,aging){finShell(type==='AR'?(aging?'未收帳款查詢':'應收帳款'):(aging?'未付帳款查詢':'應付帳款'),panelTable('帳款明細',['帳款單','日期','到期日','對象','原始金額','已沖','未沖','狀態','作業'],'financeRows'));api(`/api/finance-workflow/open-items?source_database=${currentDatabase}&account_type=${type}`).then(r=>{$('#financeRows').innerHTML=r.filter(x=>!aging||Number(x.balance_amount)!==0).map(x=>`<tr><td>${x.document_no}</td><td>${x.document_date}</td><td>${x.due_date||''}</td><td>${x.party_code}</td><td>${x.original_amount}</td><td>${x.settled_amount}</td><td>${x.balance_amount}</td><td>${x.status}</td><td>${x.status==='draft'?`<button class="btn small" data-fapp="${x.id}">核準</button>`:'完成'}</td></tr>`).join('');document.querySelectorAll('[data-fapp]').forEach(b=>b.onclick=async()=>{await api(`/api/finance-workflow/open-items/${b.dataset.fapp}/approve`,{method:'POST'});renderFinanceOpen(type,aging);});}).catch(e=>toast(e.message,true));}
function renderFinanceSettlement(type){finShell(type==='AR'?'收款沖銷':'付款沖銷',`<form id="financeForm" class="form"><div class="row c3">${selectField('document_type','單別','')}${selectField('open_item_id','未沖帳款','')}${field('settlement_date','日期','text',`value="${procurementToday()}"`)}${field('amount','沖銷金額','number','step="0.000001" required')}${selectField('payment_method','方式','<option value="cash">現金</option><option value="transfer">匯款</option><option value="check">支票</option>')}</div><button class="btn primary">建立收付款單</button></form>${panelTable('收付款紀錄',['單別／單號','日期','對象','金額','帳款','狀態','作業'],'financeRows')}`);Promise.all([api(`/api/finance-workflow/open-items?source_database=${currentDatabase}&account_type=${type}`),api(`/api/finance-workflow/settlements?source_database=${currentDatabase}&account_type=${type}`),api(`/api/finance-workflow/document-types?source_database=${currentDatabase}&account_type=${type}&document_kind=settlement`)]).then(([o,r,t])=>{let f=$('#financeForm'),s=f.elements.open_item_id;s.innerHTML=o.filter(x=>['open','partial'].includes(x.status)).map(x=>`<option value="${x.id}">${x.document_no}｜${x.balance_amount}</option>`).join('');f.elements.document_type.innerHTML=t.map(x=>`<option value="${esc(x.type_code)}">${esc(x.type_code)}｜${esc(x.type_name)}</option>`).join('');$('#financeRows').innerHTML=r.map(x=>`<tr><td>${x.settlement_no}</td><td>${x.settlement_date}</td><td>${x.party_code}</td><td>${x.amount}</td><td>${x.open_document_no||''}</td><td>${x.status}</td><td>${x.status==='draft'?`<button class="btn small" data-fpost="${x.id}">過帳</button>`:'完成'}</td></tr>`).join('')||'<tr><td colspan="7">查無資料</td></tr>';document.querySelectorAll('[data-fpost]').forEach(b=>b.onclick=async()=>{await api(`/api/finance-workflow/settlements/${b.dataset.fpost}/post`,{method:'POST'});renderFinanceSettlement(type);});});$('#financeForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/finance-workflow/settlements',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(e.currentTarget)))});renderFinanceSettlement(type);}catch(x){toast(x.message,true);}};}
function renderFinanceNotes(type){const title=type==='AR'?'應收票據':'應付票據';finShell(title,`<form id="financeNoteForm" class="form"><input type="hidden" name="account_type" value="${type}"><div class="row c3">${selectField('settlement_id',type==='AR'?'來源收款單':'來源付款單','')}${selectField('note_type','票據種類','<option value="check">支票</option><option value="promissory_note">本票</option>')}${field('issue_date','收／開票日','text',`value="${procurementToday()}" required`)}${field('due_date','到期日','text',`value="${procurementToday()}" required`)}${field('amount','票據金額','number','step="0.01" required')}${field('bank_code','銀行代號')}${field('bank_account','帳號')}${field('memo','備註')}</div><button class="btn primary">建立票據</button></form>${panelTable(title+'紀錄',['票據號碼','收／開票日','到期日','對象','金額','來源收付款單','狀態'],'financeRows')}`);Promise.all([api(`/api/finance-workflow/settlements?source_database=${currentDatabase}&account_type=${type}`),api(`/api/finance-workflow/notes?source_database=${currentDatabase}&account_type=${type}`)]).then(([settlements,notes])=>{const f=$('#financeNoteForm');f.elements.settlement_id.innerHTML=settlements.filter(x=>x.status==='posted').map(x=>`<option value="${x.id}" data-amount="${x.amount}">${x.settlement_no}｜${x.party_code}｜${x.amount}</option>`).join('');const syncAmount=()=>{const o=f.elements.settlement_id.selectedOptions[0];if(o)f.elements.amount.value=o.dataset.amount||'';};f.elements.settlement_id.onchange=syncAmount;syncAmount();$('#financeRows').innerHTML=notes.map(x=>`<tr><td>${esc(x.note_no)}</td><td>${esc(x.issue_date)}</td><td>${esc(x.due_date)}</td><td>${esc(x.party_code)}</td><td>${esc(x.amount)}</td><td>${esc(x.settlement_no||'')}</td><td>${esc(x.status)}</td></tr>`).join('')||'<tr><td colspan="7">查無資料</td></tr>';});$('#financeNoteForm').onsubmit=async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.currentTarget));d.source_database=currentDatabase;try{await api('/api/finance-workflow/notes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});toast('票據已建立');renderFinanceNotes(type);}catch(x){toast(x.message,true);}};}

function renderInventoryWorkflow(screen){
  if(screen==='inventory-document-types')return renderInventoryDocumentTypes();
  if(screen==='inventory-posting')return renderProcurementInventoryPosting();
  if(screen==='inventory-new-balance')return renderInventoryWorkflowReport('balances','新 ERP 庫存餘額');
  if(screen==='inventory-new-ledger')return renderInventoryWorkflowReport('ledger','新 ERP 庫存異動帳');
  const groups={
    'inventory-transactions':['issue','return','adjust_in','adjust_out','scrap','cost_adjust'],
    'inventory-transfers':['transfer'],
    'inventory-temporary':['temp_in','temp_in_return','temp_out','temp_out_return'],
    'inventory-stocktake':['stocktake']
  };
  renderInventoryDocumentEntry(screen,groups[screen]);
}
function inventoryShell(title,code,body){$('#canvas').innerHTML=`<section class="screen"><div class="screen-head"><h2>${title}</h2><span class="code">${code}</span></div><div class="screen-body"><div class="desc">本頁單據只寫入 inventory_erp；必須先核準、再過帳，過帳後才會影響新 ERP 庫存。</div>${body}</div></section>`;}
function renderInventoryDocumentTypes(){inventoryShell('庫存單據性質','INV-TYPE',`<form id="inventoryTypeForm" class="form"><div class="row c3"><div class="field"><label>性質代號</label><input name="type_code" required></div><div class="field"><label>性質名稱</label><input name="type_name" required></div><div class="field"><label>異動種類</label><select name="movement_kind">${Object.entries(inventoryKinds).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></div><div class="field"><label>單號前綴</label><input name="number_prefix"></div><div class="field"><label>允許負庫存</label><select name="allow_negative"><option value="0">否</option><option value="1">是</option></select></div><div class="field"><label>備註</label><input name="note"></div></div><button class="btn primary">新增單據性質</button></form>${panelTable('現有單據性質',['代號','名稱','異動種類','前綴','核準','負庫存'],'inventoryWorkflowRows')}`);$('#inventoryTypeForm').onsubmit=saveInventoryType;$('#procurementReload').onclick=loadInventoryTypes;loadInventoryTypes();}
async function loadInventoryTypes(){try{const rows=await api(`/api/inventory-workflow/document-types?source_database=${encodeURIComponent(currentDatabase)}`);$('#inventoryWorkflowRows').innerHTML=rows.map(r=>`<tr><td>${esc(r.type_code)}</td><td>${esc(r.type_name)}</td><td>${esc(inventoryKinds[r.movement_kind]||r.movement_kind)}</td><td>${esc(r.number_prefix)}</td><td>${r.requires_approval?'是':'否'}</td><td>${r.allow_negative?'是':'否'}</td></tr>`).join('');return rows;}catch(e){toast(e.message,true);return[];}}
async function saveInventoryType(e){e.preventDefault();try{const data=Object.fromEntries(new FormData(e.currentTarget));data.source_database=currentDatabase;await api('/api/inventory-workflow/document-types',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});toast('庫存單據性質已新增');e.currentTarget.reset();loadInventoryTypes();}catch(x){toast(x.message,true);}}
function renderInventoryDocumentEntry(screen,kinds){const titles={'inventory-transactions':'庫存異動作業','inventory-transfers':'轉撥作業','inventory-temporary':'暫出／暫入作業','inventory-stocktake':'庫存盤點作業'},title=titles[screen];inventoryShell(title,'INV-DOC',`<form id="inventoryDocumentForm" class="form"><div class="row c3"><div class="field"><label>單據性質</label><select name="document_type" required></select></div><div class="field"><label>單據日期</label><input name="document_date" value="${new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Taipei'})}" required></div><div class="field"><label>品號</label><input name="item_code" required></div><div class="field"><label>品名</label><input name="item_name"></div><div class="field"><label>單位</label><input name="unit" value="PCS"></div><div class="field"><label>轉出／原庫別</label><input name="from_warehouse_code"></div><div class="field"><label>轉入／目的庫別</label><input name="to_warehouse_code"></div><div class="field"><label>數量</label><input name="quantity" type="number" step="0.001" value="0"></div><div class="field"><label>實盤數量</label><input name="counted_quantity" type="number" step="0.001"></div><div class="field"><label>單位成本</label><input name="unit_cost" type="number" step="0.000001" value="0"></div><div class="field"><label>成本調整金額</label><input name="amount_delta" type="number" step="0.000001" value="0"></div><div class="field"><label>部門</label><input name="department_code"></div><div class="field"><label>人員</label><input name="employee_code"></div><div class="field"><label>對象／暫出入對象</label><input name="counterparty"></div><div class="field"><label>原因</label><input name="reason"></div><div class="field"><label>備註</label><input name="note"></div></div><button class="btn primary">建立草稿</button></form>${panelTable('近期庫存單據',['單號','日期','性質','品號','原庫','目的庫','數量／實盤','狀態','作業'],'inventoryWorkflowRows')}`);$('#inventoryDocumentForm').onsubmit=saveInventoryDocument;$('#procurementReload').onclick=()=>loadInventoryDocuments(kinds);loadInventoryEntryTypes(kinds);loadInventoryDocuments(kinds);}
async function loadInventoryEntryTypes(kinds){try{const rows=await api(`/api/inventory-workflow/document-types?source_database=${encodeURIComponent(currentDatabase)}`),s=$('#inventoryDocumentForm select[name=document_type]');if(!s)return;s.innerHTML=rows.filter(r=>kinds.includes(r.movement_kind)).map(r=>`<option value="${esc(r.type_code)}">${esc(r.type_code)}｜${esc(r.type_name)}</option>`).join('');}catch(e){toast(e.message,true);}}
async function saveInventoryDocument(e){e.preventDefault();try{const data=Object.fromEntries(new FormData(e.currentTarget));data.source_database=currentDatabase;await api('/api/inventory-workflow/documents',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});toast('庫存單據草稿已建立');renderInventoryWorkflow(state.screen);}catch(x){toast(x.message,true);}}
async function loadInventoryDocuments(kinds){try{const rows=await api(`/api/inventory-workflow/documents?source_database=${encodeURIComponent(currentDatabase)}`),filtered=rows.filter(r=>kinds.includes(r.movement_kind));$('#inventoryWorkflowRows').innerHTML=filtered.map(r=>`<tr><td>${esc(r.document_no)}</td><td>${esc(r.document_date)}</td><td>${esc(inventoryKinds[r.movement_kind]||r.movement_kind)}</td><td>${esc(r.item_code)}</td><td>${esc(r.from_warehouse_code)}</td><td>${esc(r.to_warehouse_code)}</td><td>${esc(r.movement_kind==='stocktake'?r.counted_quantity:r.quantity)}</td><td>${esc(r.status)}</td><td>${r.status==='draft'?`<button class="btn small" data-inv-approve="${r.id}">核準</button>`:r.status==='approved'?`<button class="btn small primary" data-inv-post="${r.id}">過帳</button>`:'已過帳'}</td></tr>`).join('')||'<tr><td colspan="9">尚無庫存單據</td></tr>';document.querySelectorAll('[data-inv-approve]').forEach(b=>b.onclick=()=>inventoryAction(b.dataset.invApprove,'approve',kinds));document.querySelectorAll('[data-inv-post]').forEach(b=>b.onclick=()=>inventoryAction(b.dataset.invPost,'post',kinds));}catch(e){toast(e.message,true);}}
async function inventoryAction(id,action,kinds){try{await api(`/api/inventory-workflow/documents/${id}/${action}`,{method:'POST'});toast(action==='approve'?'單據已核準':'單據已過帳並更新庫存');loadInventoryDocuments(kinds);}catch(e){toast(e.message,true);}}
function renderInventoryWorkflowReport(type,title){const balance=type==='balances';inventoryShell(title,balance?'INV-BAL':'INV-LEDGER',panelTable(title,balance?['品號','庫別','儲位','現有量','單位成本','庫存金額','最後異動']:['日期','單號','種類','品號','庫別','數量異動','單位成本','金額異動'],'inventoryWorkflowRows'));$('#procurementReload').onclick=()=>loadInventoryWorkflowReport(type);loadInventoryWorkflowReport(type);}
async function loadInventoryWorkflowReport(type){try{const rows=await api(`/api/inventory-workflow/${type}?source_database=${encodeURIComponent(currentDatabase)}`),balance=type==='balances';$('#inventoryWorkflowRows').innerHTML=rows.map(r=>balance?`<tr><td>${esc(r.item_code)}</td><td>${esc(r.warehouse_code)}</td><td>${esc(r.location_code)}</td><td>${esc(r.quantity_on_hand)}</td><td>${esc(r.unit_cost)}</td><td>${esc(r.inventory_amount)}</td><td>${esc(r.last_movement_at)}</td></tr>`:`<tr><td>${esc(r.movement_date)}</td><td>${esc(r.document_no)}</td><td>${esc(inventoryKinds[r.movement_kind]||r.movement_kind)}</td><td>${esc(r.item_code)}</td><td>${esc(r.warehouse_code)}</td><td>${esc(r.quantity_delta)}</td><td>${esc(r.unit_cost)}</td><td>${esc(r.amount_delta)}</td></tr>`).join('')||`<tr><td colspan="${balance?7:8}">目前沒有新 ERP 庫存資料</td></tr>`;}catch(e){toast(e.message,true);}}

function renderProcurementInventoryPosting(){inventoryShell('進貨／退貨庫存過帳','INV-PUR-POST',panelTable('待過帳的採購進貨與退貨',['來源','單號','日期','廠商','品號','品名','庫別','數量','作業'],'inventoryWorkflowRows'));$('#procurementReload').onclick=loadProcurementInventoryPosting;loadProcurementInventoryPosting();}
async function loadProcurementInventoryPosting(){try{const rows=await api(`/api/inventory-workflow/procurement-pending?source_database=${encodeURIComponent(currentDatabase)}`);$('#inventoryWorkflowRows').innerHTML=rows.map(r=>`<tr><td>${r.source_kind==='receipt'?'進貨':'退貨'}</td><td>${esc(r.document_no)}</td><td>${esc(r.document_date)}</td><td>${esc(r.supplier_code)}</td><td>${esc(r.item_code)}</td><td>${esc(r.item_name)}</td><td>${esc(r.warehouse_code)}</td><td>${esc(r.quantity)}</td><td><button class="btn small primary" data-pur-inv-post="${r.source_kind}:${r.id}">庫存過帳</button></td></tr>`).join('')||'<tr><td colspan="9">目前沒有待過帳單據</td></tr>';document.querySelectorAll('[data-pur-inv-post]').forEach(b=>b.onclick=async()=>{const[k,id]=b.dataset.purInvPost.split(':');try{await api(`/api/inventory-workflow/procurement/${k}/${id}/post`,{method:'POST'});toast('採購單據已完成庫存過帳');loadProcurementInventoryPosting();}catch(e){toast(e.message,true);}});}catch(e){toast(e.message,true);}}

const procurementToday = () => new Date().toLocaleDateString('sv-SE', { timeZone:'Asia/Taipei' });
const procurementSource = () => `source_database=${encodeURIComponent(currentDatabase)}`;
const procurementKindMap = { requisitions:'requisition', orders:'purchase_order', receipts:'receipt', returns:'purchase_return' };
// 鼎新資料的單號可能是「單別/單號」，新 ERP 產生的單號則可能是「單別-日期-序號」。
// 畫面統一拆成兩欄，避免把單別與單號當成同一個值呈現。
const documentRawOf = row => String(row?.document_number ?? row?.document_no ?? row?.purchase_order_no ?? row?.requisition_no ?? row?.receipt_no ?? row?.return_no ?? row?.change_no ?? row?.settlement_no ?? row?.note_no ?? '');
const documentTypeOf = row => {
  const raw = documentRawOf(row), explicit = String(row?.document_type ?? '').trim();
  if (explicit) return explicit;
  const slash = raw.indexOf('/');
  if (slash > 0) return raw.slice(0, slash);
  const hyphen = raw.indexOf('-');
  return hyphen > 0 ? raw.slice(0, hyphen) : '';
};
const documentNumberOf = row => {
  const raw = documentRawOf(row), type = documentTypeOf(row);
  const slash = raw.indexOf('/');
  if (slash > 0) return raw.slice(slash + 1);
  if (type && raw.startsWith(`${type}-`)) return raw.slice(type.length + 1);
  return raw;
};
const documentLabelOf = row => `${documentTypeOf(row)}｜${documentNumberOf(row)}`;
const displayDateOf = value => {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Taipei' }).format(date);
};
const field = (name, label, type='text', extra='') => `<div class="field"><label>${label}</label><input name="${name}" type="${type}" ${extra}></div>`;
const selectField = (name, label, options) => `<div class="field"><label>${label}</label><select name="${name}">${options}</select></div>`;
const panelTable = (title, headers, bodyId) => `<div class="panel"><div class="panel-head"><span>${String(title).replace('20','10')}</span><button class="btn small" type="button" id="procurementReload">重新整理</button></div><div class="panel-body"><div class="table-wrap"><table class="grid"><thead><tr>${headers.map(x=>`<th>${x}</th>`).join('')}</tr></thead><tbody id="${bodyId}"></tbody></table></div></div></div>`;
const procurementShell = (title, code, body) => { $('#canvas').innerHTML=`<section class="screen"><div class="screen-head"><h2>${title}</h2><span class="code">${code}</span></div><div class="screen-body"><div class="desc">新單據只寫入 inventory_erp；${esc(currentDatabase)} 原始資料庫維持唯讀。</div>${body}</div></section>`; };

function renderProcurementScreen(screen) {
  if (screen==='procurement-document-types') return renderProcurementTypes();
  if (screen==='requisition-entry') return renderProcurementEntry('requisitions');
  if (screen==='requisition-maintenance') return renderRequisitionMaintenance();
  if (screen==='purchase-order-entry') return renderProcurementEntry('orders');
  if (screen==='purchase-order-changes') return renderOrderChanges();
  if (screen==='receipt-entry') return renderProcurementEntry('receipts');
  if (screen==='receipt-inspection') return renderReceiptInspection();
  if (screen==='purchase-returns') return renderPurchaseReturns();
  if (screen==='purchase-progress') return renderProcurementReport('progress');
  if (screen==='open-purchase-orders') return renderProcurementReport('open-orders');
  return renderProcurementDocuments('receipts','進貨入庫明細');
}

function renderProcurementTypes() {
  procurementShell('採購單據性質','PUR-TYPE',`<form id="procurementForm" class="form"><div class="row c3">
    ${selectField('document_kind','單據種類','<option value="requisition">請購</option><option value="purchase_order">採購</option><option value="receipt">進貨</option><option value="purchase_return">退貨／折讓</option>')}
    ${field('type_code','性質代號','text','required')}${field('type_name','性質名稱','text','required')}${field('number_prefix','單號前綴')}
    ${selectField('requires_approval','需要核準','<option value="1">是</option><option value="0">否</option>')}${field('allow_overage','允收超交比例（%）','number','step="0.01" value="0"')}${field('note','備註')}
    </div><button class="btn primary">新增單據性質</button></form>${panelTable('現有單據性質',['種類','代號','名稱','前綴','核準','超交','狀態'],'procurementRows')}`);
  $('#procurementForm').onsubmit=saveProcurementType; $('#procurementReload').onclick=loadProcurementTypes; loadProcurementTypes();
}
async function loadProcurementTypes(){ try{const rows=await api(`/api/procurement/document-types?${procurementSource()}`); $('#procurementRows').innerHTML=rows.map(r=>`<tr><td>${esc(r.document_kind)}</td><td>${esc(r.type_code)}</td><td>${esc(r.type_name)}</td><td>${esc(r.number_prefix)}</td><td>${r.requires_approval?'是':'否'}</td><td>${esc(r.allow_overage)}</td><td>${r.is_active?'啟用':'停用'}</td></tr>`).join('')||'<tr><td colspan="7">尚無資料</td></tr>';}catch(e){toast(e.message,true);} }
async function saveProcurementType(event){event.preventDefault();try{const data=Object.fromEntries(new FormData(event.currentTarget));data.source_database=currentDatabase;await api('/api/procurement/document-types',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});event.currentTarget.reset();toast('單據性質已新增');loadProcurementTypes();}catch(e){toast(e.message,true);}}

const entryDefinitions={
  requisitions:{title:'請購建立作業',code:'PUR-RQ',path:'requisitions',fields:()=>`${selectField('document_type','單別','')}${field('requisition_date','請購日期','text',`value="${procurementToday()}" required`)}${field('requester_code','請購人員')}${field('department_code','部門')}${field('warehouse_code','需求庫別')}${field('item_code','品號','text','required')}${field('item_name','品名')}${field('specification','規格')}${field('unit','單位','text','value="PCS"')}${field('qty_requested','請購數量','number','step="0.001" required')}${field('required_date','需求日期')}${field('note','備註')}`},
  orders:{title:'採購建立作業',code:'PUR-PO',path:'orders',fields:()=>`${selectField('document_type','單別','')}${field('order_date','採購日期','text',`value="${procurementToday()}" required`)}${field('supplier_code','廠商代號','text','required')}${field('expected_date','預交日期')}${field('currency_code','幣別','text','value="TWD"')}${field('item_code','品號','text','required')}${field('item_name','品名')}${field('warehouse_code','庫別')}${field('unit','單位','text','value="PCS"')}${field('qty_ordered','採購數量','number','step="0.001" required')}${field('unit_price','單價','number','step="0.0001" value="0"')}${field('note','備註')}`},
  receipts:{title:'進貨建立作業',code:'PUR-GR',path:'receipts',fields:()=>`${selectField('document_type','單別','')}${selectField('purchase_order_item_id','參考採購明細','<option value="">獨立建立</option>')} ${field('receipt_date','進貨日期','text',`value="${procurementToday()}" required`)}${field('supplier_code','廠商代號','text','required')}${field('warehouse_code','入庫庫別')}${field('item_code','品號','text','required')}${field('item_name','品名')}${field('unit','單位','text','value="PCS"')}${field('qty_received','進貨數量','number','step="0.001" required')}${field('unit_cost','進貨成本','number','step="0.0001" value="0"')}${field('lot_no','批號')}${field('note','備註')}`}
};
function renderProcurementEntry(kind){const d=entryDefinitions[kind];procurementShell(d.title,d.code,`<form id="procurementForm" class="form"><div class="row c3">${d.fields()}</div><button class="btn primary">建立單據</button></form>${panelTable('近期 10 筆',['單別','單號','日期','對象','品號','品名','數量','狀態','核準'],'procurementRows')}`);$('#procurementForm').onsubmit=e=>saveProcurementEntry(e,kind);$('#procurementReload').onclick=()=>loadProcurementDocuments(kind);loadProcurementEntryTypes(kind);if(kind==='receipts')loadOrderOptions();loadProcurementDocuments(kind);}
async function loadProcurementEntryTypes(kind){try{const rows=await api(`/api/procurement/document-types?${procurementSource()}`),s=$('#procurementForm select[name=document_type]');if(!s)return;const wanted=procurementKindMap[kind];s.innerHTML=rows.filter(r=>r.document_kind===wanted&&r.is_active).map(r=>`<option value="${esc(r.type_code)}">${esc(r.type_code)}｜${esc(r.type_name)}</option>`).join('');}catch(e){toast(e.message,true);}}
async function loadOrderOptions(){try{const rows=await api(`/api/procurement/order-lines?${procurementSource()}`),s=$('#procurementForm select[name=purchase_order_item_id]');s.innerHTML='<option value="">獨立建立</option>'+rows.map(r=>`<option value="${r.id}">${esc(r.purchase_order_no)}｜${esc(r.item_code)}｜未交 ${esc(r.remaining_quantity)}</option>`).join('');s.onchange=()=>{const r=rows.find(x=>String(x.id)===s.value);if(!r)return;const f=$('#procurementForm');['supplier_code','item_code','item_name','warehouse_code','unit'].forEach(k=>f.elements[k].value=r[k]??'');f.elements.qty_received.value=r.remaining_quantity;f.elements.unit_cost.value=r.unit_price;};}catch(e){toast(e.message,true);}}
async function saveProcurementEntry(event,kind){event.preventDefault();try{const data=Object.fromEntries(new FormData(event.currentTarget));data.source_database=currentDatabase;await api(`/api/procurement/${kind}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});toast('單據已建立');renderProcurementEntry(kind);}catch(e){toast(e.message,true);}}
async function loadProcurementDocuments(kind){try{const rows=await api(`/api/procurement/documents/${kind}?${procurementSource()}&limit=10`);$('#procurementRows').innerHTML=rows.map(r=>`<tr><td>${esc(documentTypeOf(r))}</td><td>${esc(documentNumberOf(r))}</td><td>${esc(r.document_date)}</td><td>${esc(r.supplier_code||r.requester_code||'')}</td><td>${esc(r.item_code)}</td><td>${esc(r.item_name)}</td><td>${esc(r.quantity)}</td><td>${esc(r.status)}</td><td>${['approved','confirmed','accepted','partially_accepted','posted'].includes(r.status)?'已完成':`<button class="btn small" data-approve="${r.id}">核準</button>`}</td></tr>`).join('')||'<tr><td colspan="9">查無資料</td></tr>';document.querySelectorAll('[data-approve]').forEach(b=>b.onclick=async()=>{try{await api(`/api/procurement/documents/${kind}/${b.dataset.approve}/approve`,{method:'POST'});toast('核準完成');loadProcurementDocuments(kind);}catch(e){toast(e.message,true);}});}catch(e){toast(e.message,true);}}
function renderProcurementDocuments(kind,title){procurementShell(title,'PUR-LIST',panelTable('近期 20 筆',['單號','日期','廠商','品號','品名','數量','狀態',''],'procurementRows'));$('#procurementReload').onclick=()=>loadProcurementDocuments(kind);loadProcurementDocuments(kind);}

function renderRequisitionMaintenance(){procurementShell('請購資料維護與轉採購','PUR-RQ-MAINT',panelTable('已核準、尚未轉完的請購',['請購單','品號','品名','請購','已轉','未轉','廠商','單價','需求日','作業'],'procurementRows'));$('#procurementReload').onclick=loadRequisitionMaintenance;loadRequisitionMaintenance();}
async function loadRequisitionMaintenance(){try{const rows=await api(`/api/procurement/requisition-maintenance?${procurementSource()}`);$('#procurementRows').innerHTML=rows.map(r=>`<tr><td>${esc(r.requisition_no)}</td><td>${esc(r.item_code)}</td><td>${esc(r.item_name)}</td><td>${esc(r.qty_requested)}</td><td>${esc(r.qty_ordered)}</td><td>${esc(r.remaining_quantity)}</td><td><input data-supplier="${r.id}" value="${esc(r.suggested_supplier_code)}"></td><td><input data-price="${r.id}" type="number" step="0.0001" value="${esc(r.suggested_unit_price)}"></td><td><input data-date="${r.id}" value="${esc(r.required_date||'')}"></td><td><button class="btn small" data-lock="${r.id}">儲存並鎖定</button> <button class="btn small primary" data-convert="${r.id}">轉採購</button></td></tr>`).join('')||'<tr><td colspan="10">尚無待轉請購</td></tr>';document.querySelectorAll('[data-lock]').forEach(b=>b.onclick=()=>maintainReq(b.dataset.lock));document.querySelectorAll('[data-convert]').forEach(b=>b.onclick=()=>convertReq(b.dataset.convert));}catch(e){toast(e.message,true);}}
async function maintainReq(id){try{await api(`/api/procurement/requisition-lines/${id}/maintenance`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({suggested_supplier_code:document.querySelector(`[data-supplier="${id}"]`).value,suggested_unit_price:document.querySelector(`[data-price="${id}"]`).value,required_date:document.querySelector(`[data-date="${id}"]`).value,purchase_locked:1})});toast('請購資料已鎖定');loadRequisitionMaintenance();}catch(e){toast(e.message,true);}}
async function convertReq(id){try{const supplier_code=document.querySelector(`[data-supplier="${id}"]`).value,unit_price=document.querySelector(`[data-price="${id}"]`).value;await api(`/api/procurement/requisition-lines/${id}/convert`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source_database:currentDatabase,order_date:procurementToday(),supplier_code,unit_price})});toast('已產生採購草稿');loadRequisitionMaintenance();}catch(e){toast(e.message,true);}}

function renderOrderChanges(){procurementShell('採購變更','PUR-CHANGE',`<form id="procurementForm" class="form"><div class="row c3">${selectField('purchase_order_item_id','採購明細','<option>載入中</option>')}${field('change_date','變更日期','text',`value="${procurementToday()}"`)}${field('new_quantity','變更後數量','number','step="0.001" required')}${field('new_unit_price','變更後單價','number','step="0.0001" required')}${field('new_expected_date','變更後交期')}${field('reason','變更原因','text','required')}</div><button class="btn primary">建立變更單</button></form>${panelTable('採購變更紀錄',['變更單','採購單','日期','品號','新數量','新單價','狀態','核準'],'procurementRows')}`);$('#procurementForm').onsubmit=saveOrderChange;$('#procurementReload').onclick=loadOrderChanges;loadOrderChangeOptions();loadOrderChanges();}
async function loadOrderChangeOptions(){try{const rows=await api(`/api/procurement/order-lines?${procurementSource()}`),s=$('#procurementForm select');s.innerHTML=rows.map(r=>`<option value="${r.id}">${esc(r.purchase_order_no)}｜${esc(r.item_code)}</option>`).join('');s.onchange=()=>{const r=rows.find(x=>String(x.id)===s.value),f=$('#procurementForm');if(r){f.elements.new_quantity.value=r.qty_ordered;f.elements.new_unit_price.value=r.unit_price;f.elements.new_expected_date.value=r.expected_date||'';}};s.onchange();}catch(e){toast(e.message,true);}}
async function saveOrderChange(e){e.preventDefault();try{const data=Object.fromEntries(new FormData(e.currentTarget));data.source_database=currentDatabase;await api('/api/procurement/order-changes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});toast('採購變更已建立');loadOrderChanges();}catch(x){toast(x.message,true);}}
async function loadOrderChanges(){try{const rows=await api(`/api/procurement/order-changes?${procurementSource()}`);$('#procurementRows').innerHTML=rows.map(r=>`<tr><td>${esc(r.change_no)}</td><td>${esc(r.purchase_order_no)}</td><td>${esc(r.change_date)}</td><td>${esc(r.item_code)}</td><td>${esc(r.new_quantity)}</td><td>${esc(r.new_unit_price)}</td><td>${esc(r.status)}</td><td>${r.status==='draft'?`<button class="btn small" data-change-approve="${r.id}">核準</button>`:'已核準'}</td></tr>`).join('')||'<tr><td colspan="8">尚無變更單</td></tr>';document.querySelectorAll('[data-change-approve]').forEach(b=>b.onclick=async()=>{try{await api(`/api/procurement/order-changes/${b.dataset.changeApprove}/approve`,{method:'POST'});toast('變更已核準並套用');loadOrderChanges();}catch(e){toast(e.message,true);}});}catch(e){toast(e.message,true);}}

function renderReceiptInspection(){procurementShell('進貨驗收','PUR-QC',panelTable('待驗收進貨',['進貨單','日期','廠商','品號','進貨量','合格量','不合格量','說明','作業'],'procurementRows'));$('#procurementReload').onclick=loadInspections;loadInspections();}
async function loadInspections(){try{const rows=await api(`/api/procurement/pending-inspections?${procurementSource()}`);$('#procurementRows').innerHTML=rows.map(r=>`<tr><td>${esc(r.receipt_no)}</td><td>${esc(r.receipt_date)}</td><td>${esc(r.supplier_code)}</td><td>${esc(r.item_code)}</td><td>${esc(r.qty_received)}</td><td><input data-accepted="${r.id}" type="number" step="0.001" value="${esc(r.qty_received)}"></td><td><input data-rejected="${r.id}" type="number" step="0.001" value="0"></td><td><input data-inspect-note="${r.id}"></td><td><button class="btn small primary" data-inspect="${r.id}">完成驗收</button></td></tr>`).join('')||'<tr><td colspan="9">目前沒有待驗收單據</td></tr>';document.querySelectorAll('[data-inspect]').forEach(b=>b.onclick=()=>inspectReceipt(b.dataset.inspect));}catch(e){toast(e.message,true);}}
async function inspectReceipt(id){try{await api(`/api/procurement/receipts/${id}/inspect`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({qty_accepted:document.querySelector(`[data-accepted="${id}"]`).value,qty_rejected:document.querySelector(`[data-rejected="${id}"]`).value,inspection_note:document.querySelector(`[data-inspect-note="${id}"]`).value})});toast('驗收完成');loadInspections();}catch(e){toast(e.message,true);}}

function renderPurchaseReturns(){procurementShell('採購退貨／折讓','PUR-RETURN',`<form id="procurementForm" class="form"><div class="row c3">${selectField('document_type','單別','')}${selectField('return_type','處理方式','<option value="return">退貨</option><option value="allowance">折讓</option>')}${selectField('receipt_item_id','來源進貨','<option value="">載入中</option>')}${field('return_date','日期','text',`value="${procurementToday()}"`)}${field('return_quantity','退貨數量','number','step="0.001" value="0"')}${field('allowance_amount','折讓金額','number','step="0.01" value="0"')}${field('reason','原因','text','required')}</div><button class="btn primary">建立退貨／折讓單</button></form>${panelTable('退貨／折讓紀錄',['單號','日期','類型','廠商','品號','數量','折讓金額','狀態','核準'],'procurementRows')}`);$('#procurementForm').onsubmit=savePurchaseReturn;$('#procurementReload').onclick=loadPurchaseReturns;loadProcurementEntryTypes('returns');loadReturnableReceipts();loadPurchaseReturns();}
async function loadReturnableReceipts(){try{const rows=await api(`/api/procurement/returnable-receipts?${procurementSource()}`),s=$('#procurementForm select[name=receipt_item_id]');s.innerHTML='<option value="">請選來源進貨</option>'+rows.map(r=>`<option value="${r.receipt_item_id}">${esc(r.receipt_no)}｜${esc(r.item_code)}｜可退 ${esc(r.returnable_quantity)}</option>`).join('');}catch(e){toast(e.message,true);}}
async function savePurchaseReturn(e){e.preventDefault();try{const data=Object.fromEntries(new FormData(e.currentTarget));data.source_database=currentDatabase;await api('/api/procurement/returns',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});toast('退貨／折讓單已建立');loadPurchaseReturns();}catch(x){toast(x.message,true);}}
async function loadPurchaseReturns(){try{const rows=await api(`/api/procurement/returns?${procurementSource()}`);$('#procurementRows').innerHTML=rows.map(r=>`<tr><td>${esc(r.return_no)}</td><td>${esc(r.return_date)}</td><td>${r.return_type==='return'?'退貨':'折讓'}</td><td>${esc(r.supplier_code)}</td><td>${esc(r.item_code)}</td><td>${esc(r.return_quantity)}</td><td>${esc(r.allowance_amount)}</td><td>${esc(r.status)}</td><td>${r.status==='draft'?`<button class="btn small" data-return-approve="${r.id}">核準</button>`:'已核準'}</td></tr>`).join('')||'<tr><td colspan="9">尚無退貨／折讓單</td></tr>';document.querySelectorAll('[data-return-approve]').forEach(b=>b.onclick=async()=>{try{await api(`/api/procurement/returns/${b.dataset.returnApprove}/approve`,{method:'POST'});toast('核準完成');loadPurchaseReturns();}catch(e){toast(e.message,true);}});}catch(e){toast(e.message,true);}}

function renderProcurementReport(type){const open=type==='open-orders',title=open?'採購未交查詢':'採購進度查詢';procurementShell(title,open?'PUR-OPEN':'PUR-PROGRESS',panelTable(title,['採購單','訂單日','預交日','廠商','品號','品名','採購量','已收量','未交量',open?'未交金額':'進度'],'procurementRows'));$('#procurementReload').onclick=()=>loadProcurementReport(type);loadProcurementReport(type);}
async function loadProcurementReport(type){try{const rows=await api(`/api/procurement/${type}?${procurementSource()}`);$('#procurementRows').innerHTML=rows.map(r=>`<tr><td>${esc(r.purchase_order_no)}</td><td>${esc(r.order_date)}</td><td>${esc(r.expected_date)}</td><td>${esc(r.supplier_code)}</td><td>${esc(r.item_code)}</td><td>${esc(r.item_name)}</td><td>${esc(r.qty_ordered)}</td><td>${esc(r.qty_received)}</td><td>${esc(r.remaining_quantity)}</td><td>${esc(type==='open-orders'?r.remaining_amount:r.progress_status)}</td></tr>`).join('')||'<tr><td colspan="10">目前沒有資料</td></tr>';}catch(e){toast(e.message,true);}}

async function refresh() { renderAll(); }
function applyTheme(theme) { state.theme = theme; localStorage.setItem('erp-theme', theme); document.documentElement.dataset.theme = theme; }

document.addEventListener('click', event => {
  const theme = event.target.closest('[data-theme]')?.dataset.theme;
  if (theme) applyTheme(theme);
  if (event.target.closest('#companyButton')) {
    $('#companyPopover').hidden = !$('#companyPopover').hidden;
    $('#databasePopover').hidden = true;
    if (!companyContexts.length) loadCompanyOptions();
  }
  if (event.target.closest('#databaseButton')) {
    $('#databasePopover').hidden = !$('#databasePopover').hidden;
    $('#companyPopover').hidden = true;
    if (!$('#databasePopover').hidden) loadDatabaseOptions();
  }
  if (event.target.closest('#themeButton')) {
    $('#themePopover').hidden = !$('#themePopover').hidden;
    $('#companyPopover').hidden = true;
    $('#databasePopover').hidden = true;
  }
});
const emptyTableObserver = new MutationObserver(() => {
  document.querySelectorAll('table.grid tbody').forEach(tbody => {
    if (tbody.children.length) return;
    setTimeout(() => {
      if (!tbody.isConnected || tbody.children.length) return;
      const columns = tbody.closest('table')?.querySelectorAll('thead th').length || 1;
      tbody.innerHTML = `<tr><td colspan="${columns}" class="empty-hint">查無資料</td></tr>`;
    }, 350);
  });
});
emptyTableObserver.observe(document.body, { childList:true, subtree:true });

// 舊鼎新資料常用「單別/單號」，新 ERP 產生的單號常用「單別-日期-序號」。
// 各作業的近期清單都用同一套拆分規則，避免只修正採購單而讓銷售、庫存、財務仍混在一欄。
const documentColumnPairs = {
  procurementRows: {
    'requisition-maintenance': [{ index:0, type:'請購單別', number:'請購單號' }],
    'purchase-order-changes': [{ index:0, type:'變更單別', number:'變更單號' }, { index:1, type:'採購單別', number:'採購單號' }],
    'receipt-inspection': [{ index:0, type:'進貨單別', number:'進貨單號' }],
    'purchase-returns': [{ index:0, type:'退貨單別', number:'退貨單號' }],
    'purchase-progress': [{ index:0, type:'採購單別', number:'採購單號' }],
    'open-purchase-orders': [{ index:0, type:'採購單別', number:'採購單號' }]
  },
  salesRows: {
    'sales-quotations': [{ index:0, type:'報價單別', number:'報價單號' }],
    'sales-orders': [{ index:0, type:'訂單單別', number:'訂單單號' }],
    'sales-shipments': [{ index:0, type:'銷貨單別', number:'銷貨單號' }],
    'sales-returns': [{ index:0, type:'銷退單別', number:'銷退單號' }],
    'sales-order-changes': [{ index:0, type:'變更單別', number:'變更單號' }, { index:1, type:'訂單單別', number:'訂單單號' }],
    'sales-progress': [{ index:0, type:'訂單單別', number:'訂單單號' }],
    'sales-open-orders': [{ index:0, type:'訂單單別', number:'訂單單號' }]
  },
  financeRows: {
    'ar-source': [{ index:0, type:'銷貨單別', number:'銷貨單號' }],
    'ap-source': [{ index:0, type:'進貨單別', number:'進貨單號' }],
    'ar-open': [{ index:0, type:'應收單別', number:'應收單號' }],
    'ap-open': [{ index:0, type:'應付單別', number:'應付單號' }],
    'ar-aging': [{ index:0, type:'應收單別', number:'應收單號' }],
    'ap-aging': [{ index:0, type:'應付單別', number:'應付單號' }],
    'ar-receipt': [{ index:0, type:'收款單別', number:'收款單號' }, { index:4, type:'應收單別', number:'應收單號' }],
    'ap-payment': [{ index:0, type:'付款單別', number:'付款單號' }, { index:4, type:'應付單別', number:'應付單號' }],
    'ar-notes': [{ index:0, type:'應收票據別', number:'應收票據號' }, { index:5, type:'收款單別', number:'收款單號' }],
    'ap-notes': [{ index:0, type:'應付票據別', number:'應付票據號' }, { index:5, type:'付款單別', number:'付款單號' }]
  },
  inventoryWorkflowRows: {
    'inventory-transactions': [{ index:0, type:'庫存單別', number:'庫存單號' }],
    'inventory-transfers': [{ index:0, type:'轉撥單別', number:'轉撥單號' }],
    'inventory-temporary': [{ index:0, type:'暫出入單別', number:'暫出入單號' }],
    'inventory-stocktake': [{ index:0, type:'盤點單別', number:'盤點單號' }],
    'inventory-posting': [{ index:1, type:'來源單別', number:'來源單號' }],
    'inventory-new-ledger': [{ index:1, type:'庫存單別', number:'庫存單號' }]
  }
};

function splitDocumentTableColumns() {
  for (const [bodyId, screens] of Object.entries(documentColumnPairs)) {
    const pairs = screens[state.screen];
    if (!pairs) continue;
    const tbody = document.getElementById(bodyId);
    if (!tbody) continue;
    const thead = tbody.closest('table')?.querySelector('thead');
    if (thead && thead.dataset.erpDocumentHeaders !== state.screen) {
      const headers = [...thead.querySelectorAll('th')];
      [...pairs].sort((a,b) => b.index-a.index).forEach(pair => {
        const header = headers[pair.index];
        if (!header) return;
        header.textContent = pair.type;
        const numberHeader = document.createElement('th'); numberHeader.textContent = pair.number;
        header.after(numberHeader);
      });
      thead.dataset.erpDocumentHeaders = state.screen;
    }
    for (const row of [...tbody.querySelectorAll('tr')]) {
      if (row.dataset.erpDocumentSplit === state.screen || row.children.length < 2) continue;
      const cells = [...row.children];
      [...pairs].sort((a,b) => b.index-a.index).forEach(pair => {
        const cell = cells[pair.index];
        if (!cell || cell.hasAttribute('colspan')) return;
        const raw = cell.textContent.trim();
        // 即使來源單別／單號為空，也要保留兩個空白欄位，避免狀態與作業欄位左移。
        if (raw === '查無資料' || raw === '尚無資料') return;
        const typeCell = document.createElement('td'); typeCell.textContent = documentTypeOf({ document_no: raw });
        const numberCell = document.createElement('td'); numberCell.textContent = documentNumberOf({ document_no: raw });
        cell.replaceWith(typeCell, numberCell);
        cells.splice(pair.index, 1, typeCell, numberCell);
      });
      row.dataset.erpDocumentSplit = state.screen;
    }
  }
  for (const cell of document.querySelectorAll('table.grid tbody td')) {
    const value = cell.textContent.trim();
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) cell.textContent = displayDateOf(value);
  }
  for (const select of document.querySelectorAll('select[name="purchase_order_item_id"], select[name="open_item_id"], select[name="settlement_id"]')) {
    for (const option of select.options) {
      if (option.dataset.erpDocumentSplit) continue;
      const parts = option.textContent.split('｜');
      if (!parts[0] || !/[\/-]/.test(parts[0])) continue;
      const label = documentLabelOf({ document_no: parts.shift() });
      option.textContent = [label, ...parts].join('｜');
      option.dataset.erpDocumentSplit = '1';
    }
  }
}

const documentTableObserver = new MutationObserver(() => setTimeout(splitDocumentTableColumns, 0));
documentTableObserver.observe(document.body, { childList:true, subtree:true });
setTimeout(splitDocumentTableColumns, 0);
applyTheme(state.theme); updateContextButtons(); renderAll();
