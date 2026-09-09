// 權限頁面由 API 端強制驗證；這裡保留登入流程所需的相容狀態。
const accessState = { roles: [], activeRoleId: null, isAdmin: false, permissions: [], allowed_sources: [], department_scopes: [] };
const featureAliases = {
  basicdata:'basicdata', companies:'basicdata', 'common-parameters':'basicdata', 'code-rules':'basicdata',
  'job-categories':'basicdata', currencies:'basicdata', 'payment-terms':'basicdata', calendars:'basicdata',
  'source-mappings':'basicdata', 'data-quality':'data-quality', customers:'source-customers', 'sales-customer-controls':'source-customers', suppliers:'source-suppliers',
  'sales-customer-pricing-batch':'sales-customer-pricing', 'sales-contracts':'sales-orders', 'sales-delivery-schedule':'sales-progress',
  'sales-exceptions':'sales-progress', 'sales-order-tools':'sales-orders', 'sales-vouchers':'sales-orders',
  'sales-report-center':'sales-statistics', 'sales-report-gaps':'sales-statistics',
  'sales-maintenance':'sales-maintenance', 'sales-maintenance-gaps':'sales-maintenance',
  'sales-customer-info':'sales-readonly', 'sales-order-info':'sales-readonly',
  'sales-order-tree':'sales-readonly', 'sales-customer-transactions':'sales-readonly',
  'inventory-detail':'inventory-new-ledger', 'inventory-ledger':'inventory-new-ledger',
  'inventory-balance':'inventory-new-balance', 'inventory-movement-stats':'inventory-new-ledger',
  'department-movement-stats':'inventory-new-ledger',
  'inventory-batch':'inventory-transactions', 'inventory-month-close':'inventory-transactions', 'inventory-special-reports':'operations-reports',
  'purchase-basic-gaps':'procurement-document-types', 'purchase-maintenance-gaps':'purchase-progress', 'purchase-report-gaps':'purchase-progress',
  'receipt-pricing':'receipt-entry',
  'finance-flow':'finance-workflow', 'ar-source':'finance-workflow', 'ar-open':'finance-workflow', 'ar-credits':'finance-workflow', 'ar-receipt':'finance-workflow',
  'ar-notes':'finance-workflow', 'ar-aging':'finance-workflow', 'ap-source':'finance-workflow',
  'ap-open':'finance-workflow', 'ap-payment':'finance-workflow', 'ap-notes':'finance-workflow', 'advances-offset':'finance-workflow',
  'ap-aging':'finance-workflow', 'general-ledger':'accounting-general-ledger', 'accounting-financial-preview':'accounting-general-ledger', 'accounting-financial-statements':'accounting-general-ledger', 'accounting-budget':'accounting-general-ledger', 'accounting-fixed-assets':'accounting-general-ledger', 'accounting-profit-center':'accounting-general-ledger', 'operations-reports':'operations-reports'
};
function canViewFeature(screen) {
  if (accessState.isAdmin) return true;
  // 銷售水管圖是 COP 導覽頁；具備任一銷售主檔、訂單、銷貨或銷售報表權限即可看到，
  // 節點點入後仍會依各自 SHEET 權限再次攔截。
  if (screen === 'sales-pipe') {
    return accessState.permissions.some(row => [
      'sales-document-types','source-customers','customers','items',
      'sales-customer-controls','sales-customer-items','sales-customer-pricing',
      'sales-forecast','sales-quotations','sales-orders','sales-progress',
      'sales-shipments','sales-returns','sales-statistics','sales-analysis',
      'sales-vouchers','sales-order-tools','sales-exceptions','sales-maintenance','sales-readonly',
      'sales-customer-info','sales-order-info','sales-order-tree','sales-customer-transactions'
    ].includes(row.feature_code) && Number(row.can_view));
  }
  // 採購水管圖是導覽頁；只要角色具備任一採購／進貨查詢權限即可看到，
  // 每個節點點入後仍會依各自 SHEET 權限再次攔截。
  if (screen === 'purchase-pipe') {
    return accessState.permissions.some(row => [
      'procurement-document-types','requisition-entry','requisition-maintenance',
      'purchase-order-entry','purchase-order-changes','receipt-arrival','receipt-entry',
      'receipt-inspection','receipt-rejected-return','receipt-posting','purchase-returns',
      'purchase-progress','open-purchase-orders','purchase-receipts','purchase-flow-audit'
    ].includes(row.feature_code) && Number(row.can_view));
  }
  // 庫存水管圖是導覽頁；具備任一庫存作業或庫存報表權限即可看到，
  // 每個節點點入後仍會依目標 SHEET 的權限再次攔截。
  if (screen === 'inventory-pipe') {
    return accessState.permissions.some(row => [
      'inventory-opening','inventory-document-types','inventory-transactions',
      'inventory-transfers','inventory-temporary','inventory-stocktake',
      'inventory-posting','inventory-reversals','inventory-new-ledger','inventory-new-balance',
      'inventory-detail','inventory-ledger','inventory-balance','inventory-movement-stats',
      'department-movement-stats'
    ].includes(row.feature_code) && Number(row.can_view));
  }
  // 應收水管圖是導覽頁；具備任一應收、資金或財務報表權限即可看到，
  // 每個節點點入後仍會依目標 SHEET 的權限再次攔截。
  if (screen === 'receivable-pipe') {
    return accessState.permissions.some(row => [
      'finance-workflow','finance-bookkeeping','finance-cash','finance-reconcile',
      'accounting-drafts','accounting-general-ledger','bank-ledger',
      'operations-health','operations-reports','sales-shipments','sales-returns',
      'sales-statistics','sales-analysis'
    ].includes(row.feature_code) && Number(row.can_view));
  }
  // 應付水管圖是導覽頁；具備任一採購、應付、資金或財務報表權限即可看到，
  // 每個節點點入後仍會依目標 SHEET 的權限再次攔截。
  if (screen === 'payable-pipe') {
    return accessState.permissions.some(row => [
      'finance-workflow','finance-bookkeeping','finance-cash','finance-reconcile',
      'accounting-drafts','accounting-general-ledger','bank-ledger',
      'operations-health','operations-reports','receipt-entry','receipt-posting',
      'receipt-pricing','purchase-returns','purchase-receipts','purchase-flow-audit'
    ].includes(row.feature_code) && Number(row.can_view));
  }
  // 銀行／票據資金水管圖是跨應收、應付與銀行對帳的導覽頁；具備任一資金、票據、
  // 會計或報表權限即可看到，進入節點後仍依目標 SHEET 的權限再次攔截。
  if (screen === 'treasury-pipe') {
    return accessState.permissions.some(row => [
      'finance-workflow','finance-bookkeeping','finance-cash','finance-reconcile',
      'accounting-drafts','accounting-general-ledger','bank-ledger',
      'operations-health','operations-reports','ar-notes','ap-notes'
    ].includes(row.feature_code) && Number(row.can_view));
  }
  // 會計總帳水管圖是底稿、傳票、期間與報表的導覽頁；具備任一會計、財務或報表
  // 查詢權限即可看到，進入節點後仍依目標 SHEET 的權限再次攔截。
  if (screen === 'ledger-pipe') {
    return accessState.permissions.some(row => [
      'finance-workflow','finance-bookkeeping','accounting-drafts',
      'accounting-general-ledger','accounting-periods','accounting-year-close',
      'accounting-opening-balances','accounting-auto-rules',
      'operations-health','operations-reports'
    ].includes(row.feature_code) && Number(row.can_view));
  }
  const code = featureAliases[screen] || screen;
  return accessState.permissions.some(row => row.feature_code === code && Number(row.can_view));
}
async function loadAccessControl() {
  const canvas = $('#canvas');
  if (!canvas) return;
  try { accessState.roles = await api('/api/access-roles'); } catch (_) { accessState.roles = []; }
  canvas.insertAdjacentHTML('beforeend', '<div class="panel" style="margin-top:16px"><div class="panel-head">系統權限</div><div class="panel-body">新增、修改、刪除與核準權限由登入角色及 API 端驗證控管。</div></div>');
}
