/**
 * 免责声明版本（issue #62 前端3）。
 *
 * 改动 `detail.consent.clauses` 之后**必须**同时改这个值：报名记录里存的是当时那一版，
 * 用于日后核对「这位同学同意的是哪一版文本」。格式为日期，便于排序与人工核对。
 */
export const repairActivityConsentVersion = "2026-10-25";

/**
 * 公开维修活动页文案（M1）。
 */
export const repairActivitiesPage = {
  title: "维修活动",
  label: "Activities",
  lead: "电脑医院不定期举办现场维修活动。选择一场活动报名，到场后由成员接待。",
  empty: "暂时没有可展示的维修活动。",
  loadFailed: "活动列表加载失败，请稍后重试。",
  remaining: "剩余名额 {count}",
  /** 公开列表卡片用更短的「剩余 N」。 */
  remainingShort: "剩余 {count}",
  capacity: "名额 {registered} / {capacity}",
  activityAt: "活动时间",
  window: "报名时间",
  endedHint: "活动已结束",
  previousPage: "上一页",
  nextPage: "下一页",
  paginationLabel: "分页",
  detail: {
    backToList: "维修活动",
    breadcrumb: "活动详情",
    category: "校园志愿服务",
    signupTitle: "报名参加",
    lookupTitle: "已经报名？",
    lookupHint: "使用报名手机号查询或修改故障类型。",
    lookupPhonePlaceholder: "报名时使用的手机号",
    name: "姓名",
    namePlaceholder: "用于现场核对",
    phone: "手机号",
    phonePlaceholder: "用于查询报名",
    issueType: "故障类型",
    /** 机型选填（issue #68）：填了成员到场前能先了解设备。 */
    deviceModel: "机型（选填）",
    deviceModelPlaceholder: "如：联想小新 Pro 14",
    submitSignup: "提交报名",
    submitLookup: "查询报名",
    submitUpdate: "保存故障类型",
    signupSuccess: "请按时到场，可使用报名手机号查询记录。到场前请做好以下准备。",
    precautionsTitle: "到场前，记好这四件事",
    signupSuccessTitle: "报名成功",
    acknowledgePrecautions: "我已知晓",
    signupConsentHint: "提交前会展示完整须知，征得同意后才会报名。",
    fullPrecautions: "完整报名须知与免责声明 · {count} 条",
    serviceTitle: "服务说明",
    serviceHint: "社团提供免费志愿服务。能否修复、维修时长以现场检查为准；特殊拆机需求请提前咨询。",
    cancelHint: "如需取消报名，请联系 QQ 群管理员。",
    preparation: [
      { icon: "hardDrive", title: "备份数据", description: "送修前自行备份重要文件。" },
      { icon: "plug", title: "携带电源", description: "请带上设备的电源适配器。" },
      { icon: "package", title: "自备耗材", description: "清灰、换硅脂请自备导热膏等耗材。" },
      {
        icon: "message",
        title: "特殊机型先咨询",
        description: "部分 Dell 游戏本请先联系 QQ 群管理员。",
      },
    ],
    lookupSuccess: "已找到报名记录，可修改故障类型。",
    updateSuccess: "故障类型已更新。",
    signupDisabled: "当前不可报名",
    upcomingDisabled: "报名尚未开始",
    /** 报名开始倒计时（issue #187）：以服务器时间为准，归零后自动刷新状态。 */
    countdownPrefix: "距报名开始",
    countdownOpeningSoon: "即将开放，请稍候",
    countdownUnits: { days: "天", hours: "时", minutes: "分", seconds: "秒" },
    /** 块下只提示开始时间：截止时间由上方「报名时间」承载，避免整行重复。 */
    countdownOpensHint: "{open} 开始报名",
    /** 倒计时归零、状态转为可报名时对读屏的一次性播报。 */
    countdownOpened: "报名已开放，现在可以提交报名。",
    closedDisabled: "报名已截止",
    fullDisabled: "名额已满",
    notEditable: "当前状态不可修改故障类型（可能已签到或已接待）。",
    /** 报名前的免责声明：必须点「我已阅读并同意」才能提交，服务端同样强制。 */
    consent: {
      title: "报名须知与免责声明",
      subtitle: "提交报名前请阅读以下内容；不同意则无法提交。",
      clauses: [
        "报名需填写真实姓名与常用手机号：姓名用于现场核对，手机号用于查询报名与接收活动变更通知。",
        "本活动由社团成员提供免费志愿服务，不收取费用；设备能否修复、需要多长时间，以现场检查结果为准。",
        "送修前请自行备份重要数据。因设备自身老化、数据未备份等非服务方原因造成的损失，社团不承担责任。",
        "配件与耗材按现场情况与客户协商解决，社团不承诺提供配件。",
        "如需清灰、更换硅脂等使用耗材的服务，请自备硅脂（导热膏）等耗材；未自备将无法完成该类服务。",
        "送修时请携带电源适配器；部分故障需通电才能现场检查。",
        "部分 Dell 游戏本机型因主板倒装设计，换硅脂需要拆卸整块主板，对比其他机型所需时间较长，难度稍大，风险较高，由于不同场次活动的参加成员不同，我们可能不进行接待，请先 QQ 群内联系管理员确认。",
        "如果想要取消报名请联系 QQ 群内管理员，把名额留给需要的人。",
        "报名信息只用于本场活动的组织与到场核对，不对外公开。",
      ],
      agree: "我已阅读并同意",
      cancel: "取消",
    },
  },
  issueTypes: [
    { value: "CLEAN_PASTE", label: "清灰换硅脂" },
    { value: "CLEAN_ONLY", label: "清灰" },
    { value: "SOFTWARE_SYSTEM", label: "软件 / 系统问题" },
    { value: "OTHER", label: "其他故障" },
  ],
} as const;

/**
 * 成员端维修活动文案（M2）。页面与组件不得硬编码长文案。
 */
export const memberRepairActivitiesCopy = {
  list: {
    title: "维修活动",
    label: "Activities",
    lead: "选择一场活动标记出勤，再为到场客户签到、排队与接待。",
    empty: "暂时没有可接待的维修活动。",
    loadFailed: "活动列表加载失败，请稍后重试。",
    openBoard: "进入工作台",
    attended: "已出勤",
    notAttended: "未出勤",
    capacity: "名额 {registered} / {capacity}",
    activityAt: "活动时间",
  },
  board: {
    title: "活动工作台",
    label: "活动工作台 · STAFF BOARD",
    back: "返回活动列表",
    loadFailed: "工作台加载失败，请稍后重试。",
    attendCta: "参加本场",
    attending: "标记出勤中…",
    attendSuccess: "已标记本场出勤。",
    attendRequired: "请先点击「参加本场」标记出勤，才能签到客户或接待。",
    attendPrompt: "你尚未参加本场。先标记出勤后，才能在左侧勾选报名并签到。",
    /** 成员视角（issue #108 起成员无「待签到」区）：出勤后可接待排队中的客户。 */
    attendPromptMember: "你尚未参加本场。先标记出勤后，才能接待排队中的客户。",
    signupNotClosed: "报名尚未截止，暂不可出勤、签到或接待。",
    activityEnded: "活动已结束，不能再出勤、签到或接待；仍可查看记录并按权限纠错。",
    attendedBadge: "你已出勤",
    /** 手机端分区切换行（<1100px 常显；宽屏隐藏）的无障碍名称。 */
    paneSwitcherLabel: "工作台分区切换",
    eligibleTitle: "待签到",
    eligibleTag: "Eligible",
    eligibleEmpty: "当前没有可签到的报名。",
    queueTitle: "排队中",
    queueTag: "Queue",
    queueEmpty: "排队为空。请到左侧勾选报名并点「签到入队」。",
    /** 成员视角（issue #108 起成员无「待签到」区）。 */
    queueEmptyMember: "排队为空，暂无等待接待的客户。",
    /** 队列位次：按当前渲染顺序（服务端已按签到时间升序）从 1 开始。 */
    queueRank: "第{index}位",
    checkIn: "签到入队",
    checkingIn: "签到中…",
    checkInSuccess: "已签到入队。",
    checkInUpdatedSuccess: "故障类型已更新，客户已签到入队。",
    checkInRefreshFailed: "客户已签到入队，但工作台刷新失败，将自动重试。",
    refreshFailed: "工作台刷新失败，仍显示上次数据，将自动重试。",
    checkInConfirmTitle: "确认签到入队？",
    checkInConfirmHint:
      "请逐一核对以下客户的信息与故障类型；如有误，可在此修改。确认后将为这些客户签到入队。",
    checkInConfirm: "确认签到",
    checkInCancel: "取消",
    selectHint: "勾选左侧报名后点「签到入队」。",
    selectNone: "请先勾选至少一条报名。",
    serve: "接待",
    serving: "落单中…",
    serveSuccess: "已接待，请继续填写维修记录。",
    withdraw: "撤回",
    withdrawing: "撤回中…",
    withdrawSuccess: "已撤回排队。",
    withdrawConfirmTitle: "确认撤回排队？",
    withdrawConfirmHint: "撤回后该客户会离开排队，回到待签到列表；如需再次排队，须重新勾选并签到。",
    withdrawConfirm: "确认撤回",
    withdrawCancel: "取消",
    loading: "正在加载工作台…",
    issueType: "故障类型",
    deviceModel: "机型",
    phone: "电话",
    showPhone: "查看完整客户电话",
    hidePhone: "隐藏客户电话",
    phoneLoading: "正在读取客户电话",
    phoneLoadFailed: "客户电话读取失败，请稍后重试。",
    name: "姓名",
    checkedInAt: "入队时间",
    viewRepair: "查看维修单",
    /** 「已接待」区块（issue #79 第 6 项）：常驻区块，数据空了只换内容不卸载。 */
    servedTitle: "已接待",
    servedTag: "Served",
    servedEmpty: "本场还没有已接待的客户。",
    /** 成员视角（issue #207）：列表只含本人接待，空态要说清「你」。 */
    servedEmptySelf: "本场你还没有接待记录。",
    /** 待补建（issue #221）：登记已接待，但维修单还没创建。 */
    servedPendingTag: "待补建",
    servedPendingHint: "客户已接待，维修单还没创建。",
    continueFill: "继续填写",
    /** 非接待者（如活动管理员）看到的占位：补建记录只由接待人本人完成。 */
    servedPendingByOwner: "由接待人继续填写",
    fillRepair: "填写维修记录",
    /** 撤销接待（issue #221）：仅未建单的接待，接待者本人 / 活动管理员可撤。 */
    revertServe: "撤销接待",
    revertingServe: "撤销中…",
    revertServeConfirmTitle: "确认撤销接待？",
    revertServeConfirmHint:
      "撤销后该客户回到接待前的位置；这次接待还没有创建维修单，不会删除任何维修记录或照片。已建单的接待不能撤销，操作会记录审计。",
    /** 旧 serve 草稿（PR #221 之前）仍保留撤销入口：会删除未提交草稿及照片。 */
    revertServeConfirmHintLegacy:
      "撤销后该客户回到接待前的位置；这次接待生成的未提交维修草稿及其照片会被删除。已提交的维修记录不能撤销，操作会记录审计。",
    revertServeConfirm: "确认撤销",
    revertServeCancel: "取消",
    revertServeSuccess: "已撤销接待，客户回到接待前的位置。",
    pendingServeUndoHint: "若接错了客户，可先关掉本窗，在「已接待」区块点「撤销接待」。",
    recordMissing: "维修单状态未知，请刷新后再看。",
    /** 「出勤成员」入口与弹层（issue #107）：仅活动管理员可见的只读名单。 */
    attendanceEntry: "出勤成员 {count} 人",
    attendanceTitle: "出勤成员",
    attendanceEmpty: "本场还没有成员出勤。",
    attendanceCheckedInAt: "{time} 签到",
    attendanceNote: "按签到时间升序。",
    /**
     * 全局接单拦截（issue #79 第 6 项，issue #221 起按登记行判定）：存在已接待但未建单的
     * 客户时不能接单，客户端先行拦截（不发请求），服务端以 `ACTIVITY_SERVE_PENDING` 兜底。
     */
    pendingServeTitle: "有未完成的接待记录",
    pendingServeBody:
      "机主「{owner}」（{activity}）已接待，但维修单还没有创建。请先完成这条记录，再接待下一位客户。",
    pendingServeFill: "继续填写",
    pendingServeDismiss: "知道了",
  },
} as const;
