// 權限頁面由 API 端強制驗證；這裡保留登入流程所需的相容狀態。
const accessState = { roles: [], activeRoleId: null, isAdmin: false, permissions: [] };
const featureAliases = {
  basicdata:'basicdata', companies:'basicdata', 'common-parameters':'basicdata', 'code-rules':'basicdata',
  'job-categories':'basicdata', currencies:'basicdata', 'payment-terms':'basicdata', calendars:'basicdata',
  'source-mappings':'basicdata', 'data-quality':'data-quality', customers:'source-customers', suppliers:'source-suppliers',
  'inventory-detail':'inventory-new-ledger', 'inventory-ledger':'inventory-new-ledger',
  'inventory-balance':'inventory-new-balance', 'inventory-movement-stats':'inventory-new-ledger',
  'department-movement-stats':'inventory-new-ledger',
  'finance-flow':'finance-workflow', 'ar-source':'finance-workflow', 'ar-open':'finance-workflow', 'ar-receipt':'finance-workflow',
  'ar-notes':'finance-workflow', 'ar-aging':'finance-workflow', 'ap-source':'finance-workflow',
  'ap-open':'finance-workflow', 'ap-payment':'finance-workflow', 'ap-notes':'finance-workflow',
  'ap-aging':'finance-workflow', 'general-ledger':'accounting-general-ledger', 'operations-reports':'operations-reports'
};
function canViewFeature(screen) {
  if (accessState.isAdmin) return true;
  const code = featureAliases[screen] || screen;
  return accessState.permissions.some(row => row.feature_code === code && Number(row.can_view));
}
async function loadAccessControl() {
  const canvas = $('#canvas');
  if (!canvas) return;
  try { accessState.roles = await api('/api/access-roles'); } catch (_) { accessState.roles = []; }
  canvas.insertAdjacentHTML('beforeend', '<div class="panel" style="margin-top:16px"><div class="panel-head">系統權限</div><div class="panel-body">新增、修改、刪除與核準權限由登入角色及 API 端驗證控管。</div></div>');
}
