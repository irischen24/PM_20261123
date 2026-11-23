/**
 * Config.gs — 全域設定、列舉值、資料表 Schema 與中文欄位標籤
 * YearEnd PMO｜Enterprise Project Management System
 *
 * Schema DSL：'欄位:型別!'，! 代表必填；enum(X) 取 ENUMS.X。
 * 型別：id ref refs str text date datetime time int num money pct enum email url bool json
 * 每張表自動附加系統欄位：row_version（樂觀鎖版本）、is_deleted（Soft Delete）
 */

var APP = {
  NAME: 'YearEnd PMO',
  FULL_NAME: 'YearEnd PMO｜Enterprise Project Management System',
  VERSION: '0.1.0-phase1',
  TZ: 'Asia/Taipei',
  CURRENCY: 'TWD',
  LOCALE: 'zh-TW',
  DEFAULT_PROJECT_ID: 'YEP-2027-001',
  SS_NAME: 'YearEnd_PMO_2027_Database',
  PROP_SS_ID: 'SPREADSHEET_ID',
  // 你的資料庫試算表（僅在 Script Properties 尚未設定時，由 setupDatabase() 寫入一次；前端無法修改）
  DEFAULT_SPREADSHEET_ID: '1VOrrbgMmHFSg_EXUL_nzFOH8t6bL2aGGraRrI6paek0',
  LOCK_WAIT_MS: 15000,
  MAX_STR: 300,
  MAX_TEXT: 5000
};

var SYSTEM_COLS = ['row_version', 'is_deleted'];

var ENUMS = {
  PROJECT_STATUS: ['Initiating', 'Planning', 'Executing', 'Monitoring', 'Closing', 'Closed', 'On Hold', 'Cancelled'],
  METHODOLOGY: ['Predictive', 'Agile', 'Hybrid'],
  WBS_STATUS: ['Not Started', 'In Progress', 'Completed', 'Delayed', 'Blocked', 'Cancelled'],
  PRIORITY: ['Critical', 'High', 'Medium', 'Low'],
  MILESTONE_STATUS: ['Planned', 'On Track', 'At Risk', 'Delayed', 'Achieved', 'Cancelled'],
  AVAILABILITY: ['Available', 'Partially Available', 'Unavailable'],
  RACI: ['R', 'A', 'C', 'I'],
  COST_CATEGORY: ['餐飲', '場地', '視聽設備', '主持與節目', '抽獎紀念品', '攝影', '行政物資', '應變準備金', '其他'],
  PAYMENT_STATUS: ['Not Committed', 'Committed', 'Invoiced', 'Partially Paid', 'Paid', 'Cancelled'],
  ISSUE_STATUS: ['Open', 'In Progress', 'Blocked', 'Resolved', 'Closed'],
  ISSUE_CATEGORY: ['Scope', 'Schedule', 'Cost', 'Quality', 'Vendor', 'Resource', 'Safety', 'Technical', 'Other'],
  SEVERITY: ['Critical', 'High', 'Medium', 'Low'],
  ESTIMATION_METHOD: ['EventComplexity', 'FunctionPoint'],
  COMPLEXITY: ['Low', 'Average', 'High'],
  REQ_STATUS: ['Draft', 'Approved', 'Implemented', 'Verified', 'Rejected', 'Deferred'],
  CHANGE_DECISION: ['Pending', 'Approved', 'Rejected', 'Deferred'],
  CHANGE_STATUS: ['Draft', 'Submitted', 'Impact Analysis', 'Approved', 'Rejected', 'Implemented', 'Closed'],
  RISK_CATEGORY: ['Venue', 'Vendor', 'Budget', 'Schedule', 'Safety', 'Weather', 'People', 'Technical', 'Other'],
  RISK_STRATEGY: ['Avoid', 'Mitigate', 'Transfer', 'Accept', 'Escalate'],
  RISK_STATUS: ['Open', 'Monitoring', 'Occurred', 'Closed'],
  MEETING_STATUS: ['Scheduled', 'Completed', 'Cancelled'],
  ACCEPT_RESULT: ['Pending', 'Passed', 'Failed', 'Waived'],
  DOC_CATEGORY: ['Project Charter', 'Scope Statement', 'Project Management Plan', 'Requirements', 'WBS Dictionary',
    'Risk Register', 'Change Log', 'Status Report', 'Meeting Minutes', 'Vendor Contracts', 'Acceptance Report',
    'Project Closure Report', 'Lessons Learned'],
  DOC_STATUS: ['Not Started', 'Drafting', 'In Review', 'Approved', 'Superseded'],
  EVENT_STAGE: ['活動前場勘', '供應商到場', '設備安裝', '音響及視訊測試', '主持彩排', '參加者報到', '正式活動', '撤場與清點'],
  EXEC_RESULT: ['Pending', 'Go', 'No-Go', 'Done', 'Issue'],
  ROLE: ['Admin', 'PM', 'Member', 'Viewer'],
  AUDIT_ACTION: ['CREATE', 'UPDATE', 'DELETE', 'RESTORE', 'APPROVE', 'BASELINE', 'SNAPSHOT', 'SETUP', 'DENIED'],
  AUDIT_RESULT: ['SUCCESS', 'FAILED']
};

/** 主資料表定義（順序即工作表順序） */
var TABLES = {
  Projects: { code: 'D01', label: '專案基本資訊', key: 'project_id', cols:
    'project_id:id!,project_name:str!,project_description:text,sponsor_id:ref,pm_id:ref,start_date:date!,planned_end_date:date!,' +
    'actual_end_date:date,baseline_version:str,total_budget:money!,project_status:enum(PROJECT_STATUS)!,methodology:enum(METHODOLOGY),' +
    'theme:str,event_date:date,participants:int,created_at:datetime,updated_at:datetime' },

  WBS: { code: 'D02', label: 'WBS 專案分解結構', key: 'wbs_id', cols:
    'wbs_id:id!,project_id:ref!,parent_wbs_id:ref,level:int!,wbs_code:str!,task_name:str!,task_description:text,deliverable:str,' +
    'acceptance_criteria:text,owner_id:ref,planned_start_date:date,planned_end_date:date,actual_start_date:date,actual_end_date:date,' +
    'duration_days:int,percent_complete:pct,task_weight:num,dependency_ids:refs,priority:enum(PRIORITY),status:enum(WBS_STATUS)!,' +
    'baseline_version:str,approved_at:datetime,created_at:datetime,updated_at:datetime' },

  Milestones: { code: 'D03', label: '里程碑', key: 'milestone_id', cols:
    'milestone_id:id!,project_id:ref!,milestone_name:str!,description:text,baseline_date:date!,forecast_date:date,actual_date:date,' +
    'owner_id:ref,status:enum(MILESTONE_STATUS)!,linked_wbs_ids:refs,acceptance_criteria:text,approved_by:ref,updated_at:datetime' },

  Resources: { code: 'D04', label: '人力資源', key: 'resource_id', cols:
    'resource_id:id!,name:str!,department:str,role:str,email:email,capacity_hours_per_week:num,allocated_hours:num,hourly_rate:money,' +
    'availability_status:enum(AVAILABILITY),project_id:ref,notes:text' },

  RACI: { code: 'D05', label: 'RACI 責任分派', key: 'raci_id', cols:
    'raci_id:id!,project_id:ref!,deliverable_id:ref!,resource_id:ref!,responsibility_type:enum(RACI)!,updated_at:datetime' },

  Costs: { code: 'D06', label: '成本管理', key: 'cost_id', cols:
    'cost_id:id!,project_id:ref!,wbs_id:ref,category:enum(COST_CATEGORY)!,description:str!,vendor_id:str,baseline_budget:money,' +
    'committed_amount:money,actual_amount:money,forecast_amount:money,payment_status:enum(PAYMENT_STATUS),invoice_number:str,' +
    'due_date:date,paid_date:date,approved_by:ref,updated_at:datetime' },

  Issues: { code: 'D07', label: '問題追蹤', key: 'issue_id', cols:
    'issue_id:id!,project_id:ref!,title:str!,description:text,category:enum(ISSUE_CATEGORY),severity:enum(SEVERITY)!,priority:enum(PRIORITY)!,' +
    'owner_id:ref,reporter_id:ref,status:enum(ISSUE_STATUS)!,created_date:date!,due_date:date,resolved_date:date,root_cause:text,' +
    'corrective_action:text,linked_wbs_id:ref,linked_risk_id:ref,updated_at:datetime' },

  Estimates: { code: 'D08', label: '功能點數／複雜度估算', key: 'estimate_id', cols:
    'estimate_id:id!,project_id:ref!,component_name:str!,estimation_method:enum(ESTIMATION_METHOD)!,complexity_level:enum(COMPLEXITY),' +
    'quantity:num,unit_effort_hours:num,estimated_hours:num,estimated_cost:money,assumptions:text,estimator_id:ref,updated_at:datetime' },

  Requirements: { code: 'D09', label: '需求追溯', key: 'requirement_id', cols:
    'requirement_id:id!,project_id:ref!,source:str,stakeholder_id:ref,requirement_description:text!,priority:enum(PRIORITY),' +
    'acceptance_criteria:text,status:enum(REQ_STATUS)!,linked_wbs_ids:refs,linked_deliverable_ids:refs,linked_test_ids:refs,' +
    'approved_by:ref,version:str,updated_at:datetime' },

  Changes: { code: 'D10', label: '變更管理', key: 'change_id', cols:
    'change_id:id!,project_id:ref!,change_title:str!,change_description:text,reason:text,requester_id:ref,request_date:date!,' +
    'scope_impact:text,cost_impact:money,schedule_impact:int,risk_impact:text,decision:enum(CHANGE_DECISION),approver_id:ref,' +
    'approval_date:date,implementation_status:enum(CHANGE_STATUS)!,baseline_version_after:str,history_json:json,updated_at:datetime' },

  Risks: { code: 'D11', label: '風險管理', key: 'risk_id', cols:
    'risk_id:id!,project_id:ref!,risk_description:text!,category:enum(RISK_CATEGORY),probability:int!,impact:int!,risk_score:int,' +
    'severity:enum(SEVERITY),owner_id:ref,response_strategy:enum(RISK_STRATEGY),mitigation_action:text,contingency_plan:text,' +
    'trigger:text,status:enum(RISK_STATUS)!,review_date:date,linked_issue_id:ref,updated_at:datetime' },

  Communications: { code: 'D12', label: '溝通與會議', key: 'meeting_id', cols:
    'meeting_id:id!,project_id:ref!,meeting_title:str!,meeting_date:date!,start_time:time,end_time:time,organizer_id:ref,attendee_ids:refs,' +
    'agenda:text,minutes:text,decisions:text,action_items:text,action_owner_ids:refs,action_due_dates:str,' +
    'meeting_status:enum(MEETING_STATUS)!,updated_at:datetime' },

  Acceptance: { code: 'D13', label: '驗收清單', key: 'acceptance_id', cols:
    'acceptance_id:id!,project_id:ref!,deliverable_id:ref,acceptance_item:str!,acceptance_criteria:text,evidence_link:url,reviewer_id:ref,' +
    'planned_review_date:date,actual_review_date:date,result:enum(ACCEPT_RESULT)!,is_critical:bool,comments:text,approved_by:ref,updated_at:datetime' },

  Documents: { code: 'D14', label: '文件管理', key: 'document_id', cols:
    'document_id:id!,project_id:ref!,document_category:enum(DOC_CATEGORY)!,document_name:str!,document_version:str,owner_id:ref,' +
    'reviewer_id:ref,status:enum(DOC_STATUS)!,planned_delivery_date:date,actual_delivery_date:date,google_drive_file_id:str,' +
    'document_url:url,approval_date:date,updated_at:datetime' },

  Execution: { code: 'D15', label: '活動執行（Event Go-Live）', key: 'execution_id', cols:
    'execution_id:id!,project_id:ref!,wbs_id:ref,event_stage:enum(EVENT_STAGE)!,planned_start:datetime,planned_end:datetime,' +
    'actual_start:datetime,actual_end:datetime,owner_id:ref,completion_percent:pct,go_no_go_criteria:text,result:enum(EXEC_RESULT),' +
    'issue_id:ref,notes:text' },

  WeeklySnapshots: { code: 'D16', label: '每週績效快照', key: 'snapshot_id', immutable: true, cols:
    'snapshot_id:id!,project_id:ref!,week_ending:date!,baseline_version:str,planned_percent:pct,actual_percent:pct,forecast_percent:pct,' +
    'completed_task_count:int,in_progress_count:int,not_started_count:int,delayed_count:int,blocked_count:int,overdue_task_count:int,' +
    'open_issue_count:int,high_risk_count:int,planned_value:money,earned_value:money,actual_cost:money,cpi:num,spi:num,recorded_at:datetime' },

  AuditLogs: { code: 'D17', label: '操作稽核', key: 'log_id', appendOnly: true, cols:
    'log_id:id!,timestamp:datetime!,actor_id:str!,entity_type:str!,entity_id:str,action_type:enum(AUDIT_ACTION)!,before_json:json,' +
    'after_json:json,request_id:str,result:enum(AUDIT_RESULT)!' },

  Settings: { code: 'D18', label: '系統設定', key: 'setting_key', cols:
    'setting_key:id!,setting_value:text,description:text,updated_at:datetime' },

  Users: { code: 'D19', label: '使用者', key: 'user_id', cols:
    'user_id:id!,email:email!,display_name:str!,role:enum(ROLE)!,resource_id:ref,active:bool!,created_at:datetime,updated_at:datetime' },

  Roles: { code: 'D20', label: '角色權限', key: 'role', cols:
    'role:id!,description:str,permissions:text!,updated_at:datetime' }
};

/** 前端可透過泛用 CRUD 存取的資料表（AuditLogs 僅能讀取） */
var CRUD_TABLES = ['Projects', 'WBS', 'Milestones', 'Resources', 'RACI', 'Costs', 'Issues', 'Estimates', 'Requirements',
  'Changes', 'Risks', 'Communications', 'Acceptance', 'Documents', 'Execution', 'WeeklySnapshots', 'Settings', 'Users', 'Roles'];

/** WBS 基準欄位：approved_at 有值後鎖定，只能透過核准的變更請求建立新基準版本 */
var WBS_BASELINE_FIELDS = ['planned_start_date', 'planned_end_date', 'task_weight', 'parent_wbs_id', 'wbs_code', 'deliverable', 'acceptance_criteria'];

/** 中文欄位標籤（UI 顯示用；第 1 列固定英文代碼） */
var LABELS = {
  project_id: '專案編號', project_name: '專案名稱', project_description: '專案說明', sponsor_id: '專案發起人', pm_id: '專案經理',
  start_date: '開始日', planned_end_date: '計畫完成日', actual_end_date: '實際完成日', baseline_version: '基準版本',
  total_budget: '總預算', project_status: '專案狀態', methodology: '方法論', theme: '主題', event_date: '活動日', participants: '參加人數',
  created_at: '建立時間', updated_at: '更新時間',
  wbs_id: 'WBS ID', parent_wbs_id: '上層 WBS', level: '層級', wbs_code: 'WBS 編碼', task_name: '工作名稱', task_description: '工作說明',
  deliverable: '交付成果', acceptance_criteria: '驗收標準', owner_id: '負責人', planned_start_date: '計畫開始', actual_start_date: '實際開始',
  duration_days: '工期（天）', percent_complete: '完成率 %', task_weight: '權重', dependency_ids: '前置工作', priority: '優先等級',
  status: '狀態', approved_at: '核准時間',
  milestone_id: '里程碑 ID', milestone_name: '里程碑', description: '說明', baseline_date: '基準日', forecast_date: '預測日',
  actual_date: '實際日', linked_wbs_ids: '關聯 WBS', approved_by: '核准者',
  resource_id: '人員 ID', name: '姓名', department: '部門', role: '角色', email: 'Email', capacity_hours_per_week: '每週可用工時',
  allocated_hours: '已分配工時', hourly_rate: '時薪', availability_status: '可用狀態', notes: '備註',
  raci_id: 'RACI ID', deliverable_id: '交付成果（WBS）', responsibility_type: 'RACI',
  cost_id: '成本 ID', category: '類別', vendor_id: '供應商', baseline_budget: '基準預算', committed_amount: '已承諾',
  actual_amount: '實際支出', forecast_amount: '預測金額', payment_status: '付款狀態', invoice_number: '發票號碼', due_date: '到期日', paid_date: '付款日',
  issue_id: '問題 ID', title: '標題', severity: '嚴重度', reporter_id: '回報人', created_date: '建立日', resolved_date: '解決日',
  root_cause: '根本原因', corrective_action: '矯正措施', linked_wbs_id: '關聯 WBS', linked_risk_id: '關聯風險',
  estimate_id: '估算 ID', component_name: '估算項目', estimation_method: '估算方法', complexity_level: '複雜度', quantity: '數量',
  unit_effort_hours: '單位工時', estimated_hours: '估算工時', estimated_cost: '估算成本', assumptions: '假設', estimator_id: '估算人',
  requirement_id: '需求 ID', source: '來源', stakeholder_id: '利害關係人', requirement_description: '需求描述',
  linked_deliverable_ids: '關聯交付成果', linked_test_ids: '關聯驗收', version: '版本',
  change_id: '變更 ID', change_title: '變更標題', change_description: '變更說明', reason: '原因', requester_id: '申請人', request_date: '申請日',
  scope_impact: '範疇影響', cost_impact: '成本影響', schedule_impact: '時程影響（天）', risk_impact: '風險影響', decision: '決策',
  approver_id: '核准人', approval_date: '核准日', implementation_status: '流程狀態', baseline_version_after: '變更後基準版本', history_json: '歷程',
  risk_id: '風險 ID', risk_description: '風險描述', probability: '機率 (1-5)', impact: '影響 (1-5)', risk_score: '風險分數',
  response_strategy: '回應策略', mitigation_action: '減緩措施', contingency_plan: '應變計畫', trigger: '觸發條件', review_date: '檢視日', linked_issue_id: '關聯問題',
  meeting_id: '會議 ID', meeting_title: '會議名稱', meeting_date: '日期', start_time: '開始', end_time: '結束', organizer_id: '召集人',
  attendee_ids: '與會者', agenda: '議程', minutes: '會議紀錄', decisions: '決議', action_items: '行動項目', action_owner_ids: '行動負責人',
  action_due_dates: '行動期限', meeting_status: '會議狀態',
  acceptance_id: '驗收 ID', acceptance_item: '驗收項目', evidence_link: '證據連結', reviewer_id: '審查人', planned_review_date: '預定審查日',
  actual_review_date: '實際審查日', result: '結果', is_critical: '關鍵驗收', comments: '意見',
  document_id: '文件 ID', document_category: '文件分類', document_name: '文件名稱', document_version: '版本',
  planned_delivery_date: '預定交付日', actual_delivery_date: '實際交付日', google_drive_file_id: 'Drive 檔案 ID', document_url: '文件連結',
  execution_id: '執行 ID', event_stage: '活動階段', planned_start: '計畫開始', planned_end: '計畫結束', actual_start: '實際開始',
  actual_end: '實際結束', completion_percent: '完成率 %', go_no_go_criteria: 'Go/No-Go 條件',
  snapshot_id: '快照 ID', week_ending: '週結束日', planned_percent: '計畫 %', actual_percent: '實際 %', forecast_percent: '預測 %',
  completed_task_count: '已完成', in_progress_count: '進行中', not_started_count: '未開始', delayed_count: '延遲', blocked_count: '受阻',
  overdue_task_count: '逾期', open_issue_count: '未結問題', high_risk_count: '高風險', planned_value: 'PV', earned_value: 'EV',
  actual_cost: 'AC', cpi: 'CPI', spi: 'SPI', recorded_at: '記錄時間',
  log_id: 'Log ID', timestamp: '時間', actor_id: '操作者', entity_type: '資料類型', entity_id: '資料 ID', action_type: '動作',
  before_json: '修改前', after_json: '修改後', request_id: 'Request ID',
  setting_key: '設定鍵', setting_value: '設定值',
  user_id: '使用者 ID', display_name: '顯示名稱', active: '啟用', permissions: '權限',
  row_version: '版本號', is_deleted: '已刪除'
};

/** 解析 Schema DSL → [{name,type,arg,required}]（含系統欄位） */
function schemaOf_(table) {
  var def = TABLES[table];
  if (!def) throw appError_('BAD_TABLE', '未知的資料表：' + table);
  if (def._fields) return def._fields;
  var fields = def.cols.split(',').map(function (spec) {
    var m = spec.trim().match(/^([a-z_]+):([a-z]+)(?:\(([A-Z_]+)\))?(!)?$/);
    if (!m) throw new Error('Schema 定義錯誤：' + table + ' → ' + spec);
    return { name: m[1], type: m[2], arg: m[3] || null, required: !!m[4] };
  });
  fields.push({ name: 'row_version', type: 'int', system: true });
  fields.push({ name: 'is_deleted', type: 'bool', system: true });
  def._fields = fields;
  return fields;
}

function headersOf_(table) {
  return schemaOf_(table).map(function (f) { return f.name; });
}
