// 權限頁面由 API 端強制驗證；這裡保留登入流程所需的相容狀態。
const accessState = { roles: [], activeRoleId: null };
function canViewFeature() { return true; }
async function loadAccessControl() {
  const canvas = $('#canvas');
  if (!canvas) return;
  try { accessState.roles = await api('/api/access-roles'); } catch (_) { accessState.roles = []; }
  canvas.insertAdjacentHTML('beforeend', '<div class="panel" style="margin-top:16px"><div class="panel-head">系統權限</div><div class="panel-body">新增、修改、刪除與核準權限由登入角色及 API 端驗證控管。</div></div>');
}
