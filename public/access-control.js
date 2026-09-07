// 權限頁面由 API 端強制驗證；這裡保留登入流程所需的相容狀態。
const accessState = { roles: [], activeRoleId: null, isAdmin: false, permissions: [], allowed_sources: [], department_scopes: [] };
const featureAliases = {
  basicdata:'basicdata', companies:'basicdata', 'common-parameters':'basicdata', 'code-rules':'basicdata',
  'job-categories':'basicdata', currencies:'basicdata', 'payment-terms':'basicdata', calendars:'basicdata',
  'source-mappings':'basicdata', 'data-quality':'data-quality', customers:'source-customers', suppliers:'source-suppliers',
  'inventory-detail':'inventory-new-ledger', 'inventory-ledger':'inventory-new-ledger',
  'inventory-balance':'inventory-new-balance', 'inventory-movement-stats':'inventory-new-ledger',
  'department-movement-stats':'inventory-new-ledger',
  'receipt-pricing':'receipt-entry',
  'finance-flow':'finance-workflow', 'ar-source':'finance-workflow', 'ar-open':'finance-workflow', 'ar-receipt':'finance-workflow',
  'ar-notes':'finance-workflow', 'ar-aging':'finance-workflow', 'ap-source':'finance-workflow',
  'ap-open':'finance-workflow', 'ap-payment':'finance-workflow', 'ap-notes':'finance-workflow',
  'ap-aging':'finance-workflow', 'general-ledger':'accounting-general-ledger', 'accounting-financial-preview':'accounting-general-ledger', 'operations-reports':'operations-reports'
};
function canViewFeature(screen) {
  if (accessState.isAdmin) return true;
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
  const code = featureAliases[screen] || screen;
  return accessState.permissions.some(row => row.feature_code === code && Number(row.can_view));
}
async function loadAccessControl() {
  const canvas = $('#canvas');
  if (!canvas) return;
  try { accessState.roles = await api('/api/access-roles'); } catch (_) { accessState.roles = []; }
  canvas.insertAdjacentHTML('beforeend', '<div class="panel" style="margin-top:16px"><div class="panel-head">系統權限</div><div class="panel-body">新增、修改、刪除與核準權限由登入角色及 API 端驗證控管。</div></div>');
}
