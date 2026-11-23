/**
 * Auth.gs — 使用者識別與角色授權
 *
 * 身分來源：Session.getActiveUser().getEmail()
 *  ⚠ 能否取得 Email 取決於部署模式（詳見 README「部署身分」）：
 *    - 「以存取網頁應用程式的使用者身分執行」：可可靠取得 Email，但每位使用者需有試算表存取權。
 *    - 「以我的身分執行」＋同一 Google Workspace 網域：通常可取得 Email。
 *    - 「以我的身分執行」＋一般 Gmail 跨帳號：常回傳空字串 → 本系統一律拒絕存取，不會猜測身分。
 *
 * 權限字串：'<action>:<Table>'，action = read | write | delete | approve | admin；支援 '*' 萬用字元。
 * 角色與權限存在 Roles 工作表，不寫死於 HTML。
 */

var DEFAULT_ROLES = {
  Admin: { description: '系統管理員：全部權限', permissions: '*:*' },
  PM: { description: '專案經理：讀寫、核准、基準管理', permissions: 'read:*,write:*,delete:*,approve:*,baseline:WBS,snapshot:WeeklySnapshots,confirmActual:WBS,-write:Users,-write:Roles,-write:Settings,-delete:Users,-delete:Roles,-delete:Settings' },
  Member: { description: '專案成員：讀取全部；可維護問題、風險、會議、執行與自身工作進度', permissions: 'read:*,-read:AuditLogs,-read:Users,write:Issues,write:Risks,write:Communications,write:Execution,write:Acceptance,write:WBS' },
  Viewer: { description: '檢視者：唯讀（不含稽核與使用者）', permissions: 'read:*,-read:AuditLogs,-read:Users,-read:Roles' }
};

var USER_CACHE_ = null;

function currentEmail_() {
  var email = '';
  try { email = Session.getActiveUser().getEmail() || ''; } catch (e) { email = ''; }
  return email.trim().toLowerCase();
}

/** 取得目前使用者與權限；無法辨識或未授權即丟出錯誤 */
function currentUser_() {
  if (USER_CACHE_) return USER_CACHE_;
  var email = currentEmail_();
  if (!email) {
    throw appError_('UNAUTHENTICATED', '無法辨識您的 Google 帳號。請確認 Web App 部署設定（見 README「部署身分」），或改以組織帳號登入。');
  }
  var users = Repo_.list('Users', { where: function (u) { return u.email === email; } });
  if (!users.length || !users[0].active) {
    auditDenied_(email, 'Users', 'LOGIN');
    throw appError_('FORBIDDEN', '帳號 ' + email + ' 尚未被授權使用本系統，請聯絡系統管理員。');
  }
  var u = users[0];
  var roleRow = Repo_.get('Roles', u.role);
  var perms = (roleRow ? roleRow.permissions : (DEFAULT_ROLES[u.role] || {}).permissions || '').split(',')
    .map(function (s) { return s.trim(); }).filter(String);
  USER_CACHE_ = {
    user_id: u.user_id, email: u.email, display_name: u.display_name, role: u.role,
    resource_id: u.resource_id || '', permissions: perms
  };
  return USER_CACHE_;
}

/** 檢查權限。'-' 開頭為明確拒絕，優先於允許 */
function can_(user, action, table) {
  var target = action + ':' + table;
  var match = function (p) {
    var parts = p.split(':');
    return (parts[0] === '*' || parts[0] === action) && (parts[1] === '*' || parts[1] === table);
  };
  var denied = user.permissions.some(function (p) { return p.charAt(0) === '-' && match(p.substring(1)); });
  if (denied) return false;
  return user.permissions.some(function (p) { return p.charAt(0) !== '-' && match(p); });
}

function authorize_(user, action, table) {
  if (!can_(user, action, table)) {
    auditDenied_(user.email, table, action);
    throw appError_('FORBIDDEN', '您的角色（' + user.role + '）沒有「' + action + ' ' + table + '」權限。');
  }
}

/** 提供前端顯示用的權限摘要（前端僅用於隱藏按鈕；真正檢查一律在後端） */
function permissionSummary_(user) {
  var out = {};
  CRUD_TABLES.concat(['AuditLogs']).forEach(function (t) {
    out[t] = { read: can_(user, 'read', t), write: can_(user, 'write', t), del: can_(user, 'delete', t), approve: can_(user, 'approve', t) };
  });
  out._baseline = can_(user, 'baseline', 'WBS');
  out._snapshot = can_(user, 'snapshot', 'WeeklySnapshots');
  out._admin = can_(user, 'admin', '*');
  return out;
}
