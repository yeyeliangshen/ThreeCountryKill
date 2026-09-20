import type { Faction } from '@sgs/protocol';

// —— 国战武将名录（实现清单与进度追踪） ——
//
// 这是**工作清单**，不是运行时数据。真正的武将定义在 heroes/ 目录里。
// 用途：① 明确还要做哪些将 ② 记录每将依赖哪个引擎原语 ③ 追踪核对状态。
//
// 放在源码里而不是文档里，是为了能直接算出完成度、也能给将来的武将图鉴当筛选依据。
//
// ⚠️ 技能原文与体力值不在本文件里：210 个技能必须逐条对照官方文本核对，
//    那是按批次做的事（见 docs/guozhan-roster.md 的批次表），
//    没核对过的字段不填猜测值。核对状态记在 status 上。

/** 扩展包归属 */
export type HeroPack = 'standard' | 'zhen' | 'shi' | 'bian' | 'quan' | 'buchen' | 'jun';

export const PACK_NAME: Record<HeroPack, string> = {
  standard: '国战标准版',
  zhen: '君临天下·阵',
  shi: '君临天下·势',
  bian: '君临天下·变',
  quan: '君临天下·权',
  buchen: '不臣篇',
  jun: '君主将（阵/势/变/权）',
};

/**
 * 引擎原语（阶段 2 的清单）。
 * 每个技能应当在这里找到它依赖的原语；找不到的说明要么用现有能力就够，
 * 要么意味着阶段 2 的清单漏了一项——那正是这张表存在的意义。
 */
export type PrimitiveId =
  | 'hook_interaction' // 钩子内发起询问（走通 pending 控制权）
  | 'pick_cards' // 从一组牌里看/选
  | 'phase_ask' // 阶段开始时的「可以」询问
  | 'faction_call' // 令同势力角色响应
  | 'target_transfer' // 目标/伤害转移
  | 'equip_lost' // 装备区失去牌的时机
  | 'hand_emptied' // 手牌减至 0 的时机
  | 'judge_ownership' // 判定牌归属（天妒）
  | 'limited_skill' // 限定技（每局一次）
  | 'awaken_skill' // 觉醒技
  | 'pindian' // 拼点
  | 'skill_nullify' // 技能失效 / 非锁定技失效
  | 'chained' // 横置 / 重置（铁索）
  | 'virtual_trick' // 多牌转化 / 虚拟锦囊
  | 'maxhp_change' // 体力上限修改
  | 'target_faction_filter' // 目标合法性按势力过滤
  | 'extra_turn' // 额外回合 / 跳过阶段
  | 'deck_top' // 牌堆顶操作
  | 'army_order' // 军令（不臣篇）
  | 'flip' // 武将牌翻面
  | 'move_field_card' // 移动场上的一张牌（谋断 / 巧变）
  | 'after_heal' // 回复体力后（淑慎）
  | 'discard_ledger' // 本回合进入弃牌堆的牌（再起）
  | 'remove_hero' // 移除武将牌（士兵牌顶替）
  | 'slot_skills' // 主将技 / 副将技
  | 'change_deputy' // 变更副将（变包）
  | 'siege_formation' // 阵法技（队列 / 围攻关系）
  | 'virtual_equip'; // 虚拟装备（视为装备着某张装备牌）

export const PRIMITIVE_NAME: Record<PrimitiveId, string> = {
  hook_interaction: '钩子内发起询问',
  pick_cards: '选牌原语',
  phase_ask: '阶段询问',
  faction_call: '势力技询问',
  target_transfer: '目标/伤害转移',
  equip_lost: '装备区失去时机',
  hand_emptied: '手牌减至 0 时机',
  judge_ownership: '判定牌归属',
  limited_skill: '限定技',
  awaken_skill: '觉醒技',
  pindian: '拼点',
  skill_nullify: '技能失效',
  chained: '横置/重置',
  virtual_trick: '虚拟锦囊/多牌转化',
  maxhp_change: '体力上限修改',
  target_faction_filter: '按势力过滤目标',
  extra_turn: '额外回合/跳过阶段',
  deck_top: '牌堆顶操作',
  army_order: '军令',
  flip: '翻面',
  move_field_card: '移动场上的一张牌',
  after_heal: '回复体力后时机',
  remove_hero: '移除武将牌',
  change_deputy: '变更副将',
  siege_formation: '阵法技（队列/围攻）',
  slot_skills: '主将技/副将技',
  discard_ledger: '弃牌堆回合账本',
  virtual_equip: '虚拟装备（视为装备着）',
};

/**
 * 实现状态。
 * - `done`    已实现且有测试
 * - `partial` 已收入，但技能不全（缺的技能记在 missing 里）
 * - `todo`    尚未实现
 * - `verify`  技能原文尚未核对，核对前不动工
 */
export type RosterStatus = 'done' | 'partial' | 'todo' | 'verify';

export interface RosterEntry {
  id: string;
  name: string;
  faction: Faction;
  pack: HeroPack;
  status: RosterStatus;
  /** status 为 partial 时：还缺哪些技能 */
  missing?: string[];
  /**
   * 该武将技能需要用到的原语。
   * 只在**核对过技能原文**后填；未核对的留空，别填猜测。
   */
  primitives?: PrimitiveId[];
  /** 核对备注（版本差异、官方原文出处等） */
  note?: string;
}

// ——————————————————————————————————————————
// 标准版（每势力 15）
// ⚠️ 待澄清：国战标准版 2012 初版每势力只有 8 名，15 名应是把后续包并入的口径。
//    这一份名单来自百度百科/萌娘百科，定稿前需与官方武将表对照。
// ——————————————————————————————————————————

const STANDARD_WEI: RosterEntry[] = [
  {
    id: 'caocao',
    name: '曹操',
    faction: 'wei',
    pack: 'standard',
    status: 'done',
    primitives: ['faction_call', 'hook_interaction'],
    note: '护驾走 faction_call（需要【闪】的两种场景：被【杀】指定、响应【万箭齐发】）。原本暂带 isLord 标记（想给将来补君主留伏笔），但官方国战曹操是**普通武将**、君主另有「君曹操」，而那标记会连带开启君主规则（白拿珠联璧合、亮将必须双亮、只能当主将）——已摘掉。',
  },
  {
    id: 'simayi',
    name: '司马懿',
    faction: 'wei',
    pack: 'standard',
    status: 'done',
    primitives: ['hook_interaction', 'pick_cards', 'judge_ownership'],
    note: '反馈/鬼才都是完整版：反馈由自己挑一张来源的牌；鬼才手动选牌替换判定（走 api.replaceJudgeCard，判定链会接回来）。',
  },
  {
    id: 'xiahoudun',
    name: '夏侯惇',
    faction: 'wei',
    pack: 'standard',
    status: 'done',
    primitives: ['hook_interaction', 'pick_cards'],
    note: '刚烈已按 2025-09 官方口径实现为「来源二选一」，选项一的弃牌由来源自己挑（选牌原语）。',
  },
  {
    id: 'zhangliao',
    name: '张辽',
    faction: 'wei',
    pack: 'standard',
    status: 'done',
    primitives: ['phase_ask', 'pick_cards'],
    note: '突袭：先问是否发动 → 少摸一张 → 至多选两名角色 → 逐张挑他们手里的一张。',
  },
  {
    id: 'xuchu',
    name: '许褚',
    faction: 'wei',
    pack: 'standard',
    status: 'done',
    primitives: ['phase_ask', 'pick_cards'],
    note: '裸衣两模式都实现了：身份局少摸一张、国战摸牌阶段结束弃一张牌，都通过 drawPhase/drawPhaseEnd 的询问 + dealtDamageBonus 加成。',
  },
  {
    id: 'guojia',
    name: '郭嘉',
    faction: 'wei',
    pack: 'standard',
    status: 'done',
    primitives: ['judge_ownership', 'pick_cards'],
    note: '天妒自动收取（白拿牌严格优于不拿，等于最优出牌）。遗计按「每次伤害事件触发一次」——现行国战文本虽是「受到 1 点伤害后」，但 2025-09-19 调整后遗计按次触发（按点的是荀彧·节命）。',
  },
  { id: 'zhenji', name: '甄姬', faction: 'wei', pack: 'standard', status: 'done' },
  {
    id: 'caopi',
    name: '曹丕',
    faction: 'wei',
    pack: 'standard',
    status: 'done',
    primitives: ['flip', 'hook_interaction'],
    note: '行殇需要新的 kill 时机（「杀死角色后」派发给凶手）——而且必须在死者的牌被清进弃牌堆之前跑，所以 doDeath 拆成了「先跑 kill 钩子、再清牌」。放逐用 flip。',
  },
  {
    id: 'xunyu',
    name: '荀彧',
    faction: 'wei',
    pack: 'standard',
    status: 'done',
    primitives: ['pindian'],
    note: '驱虎走 api.pindian（赢了由他指定对方攻击范围内的受害者）。节命是 afterDamage 钩子，补牌到体力上限且至多 5 张。',
  },
  {
    id: 'xiahouyuan',
    name: '夏侯渊',
    faction: 'wei',
    pack: 'standard',
    status: 'done',
    primitives: ['virtual_trick', 'extra_turn'],
    note: '神速需要「虚拟杀」入口（api.castVirtualSha，与虚拟锦囊对应）+ 新增的 skipJudgment 标记。',
  },
  {
    id: 'zhanghe',
    name: '张郃',
    faction: 'wei',
    pack: 'standard',
    status: 'done',
    primitives: ['extra_turn', 'pick_cards'],
  },
  {
    id: 'xuhuang',
    name: '徐晃',
    faction: 'wei',
    pack: 'standard',
    status: 'done',
    note: '断粮：黑色基本牌/装备牌当【兵粮寸断】。⚠️ 界面限制：黑色【杀】【装备】本来就能直接用，界面的用法选择只对「不能直接用」的牌给转化，所以目前只有黑色【闪】【桃】会走断粮。',
  },
  {
    id: 'caoren',
    name: '曹仁',
    faction: 'wei',
    pack: 'standard',
    status: 'done',
    primitives: ['flip'],
    note: '据守是 turnEnd 钩子：摸三张 + 翻面。做它时发现并修了一个真 bug——跳过的回合不该跑结束阶段钩子，否则据守会循环触发。',
  },
  {
    id: 'yuejin',
    name: '乐进',
    faction: 'wei',
    pack: 'standard',
    status: 'done',
    primitives: ['hook_interaction'],
    note: '骁果需要新的 othersTurnEnd 时机（turnEnd 只派发给回合玩家）。',
  },
  {
    id: 'dianwei',
    name: '典韦',
    faction: 'wei',
    pack: 'standard',
    status: 'done',
    primitives: ['hook_interaction'],
    note: '强袭：代价二选一（失去 1 点体力 / 弃武器），弃武器走 api.discardCard 以便触发失去装备的技能。',
  },
];

const STANDARD_SHU: RosterEntry[] = [
  {
    id: 'liubei',
    name: '刘备',
    faction: 'shu',
    pack: 'standard',
    status: 'done',
    primitives: ['pick_cards', 'faction_call'],
    note: '仁德（累计两张回血一次）+ 激将（faction_call 的【杀】场景：决斗/南蛮/借刀/离间的响应）。原本暂带 isLord（同曹操那条注释：官方国战刘备是普通武将，君主另有「君刘备」）——已摘掉。',
  },
  { id: 'zhangfei', name: '张飞', faction: 'shu', pack: 'standard', status: 'done' },
  { id: 'guanyu', name: '关羽', faction: 'shu', pack: 'standard', status: 'done' },
  {
    id: 'zhugeliang',
    name: '诸葛亮',
    faction: 'shu',
    pack: 'standard',
    status: 'done',
    primitives: ['pick_cards', 'deck_top'],
    note: '观星 + 空城（**国战两段**）都已实现（用户 2026-09-21 规格，见 docs §5.154）。观星：X = min(存活, 5)；「任意顺序置于牌堆顶或牌堆底」三种摆法都可达——**「全部放底」原来不可达**（第一步「一张不选」被当成「都不动」直接收工，而那正是它的表达方式），现在两步都问、两张牌都能自定顺序；牌堆不够 X 张时按「立即重洗、继续结算」（`drawOne` 本来就会重洗，势力锦囊也正是在这第一次重洗洗入）。空城①：只在**成为目标时**判（0 手牌挡【杀】【决斗】），结算中途变成 0 手牌不追溯取消；青龙偃月刀「继续出杀」算新的一次使用，已补目标合法性重判。空城②（国战专属）：0 手牌时其他角色于其回合外交给他的牌改置于武将牌上（`Player.kongcheng`，新增 `api.giveCard` 的「交给」语义；**只拦交给**，摸牌/五谷/获得不算），下一个摸牌阶段开始时一次性获得，摸牌阶段被跳过则顺延。珠联璧合：黄月英 / 姜维 / 蒋琬费祎。1.5 阴阳鱼 → `maxHp: 3`。',
  },
  { id: 'zhaoyun', name: '赵云', faction: 'shu', pack: 'standard', status: 'done' },
  { id: 'machao', name: '马超', faction: 'shu', pack: 'standard', status: 'done' },
  {
    id: 'huangyueying',
    name: '黄月英',
    faction: 'shu',
    pack: 'standard',
    status: 'done',
    note: '集智两句都实现了：使用非延时锦囊时摸一张；若摸到的是基本牌，可以弃之再摸一张（只有第一张会触发，不作递归）。⚠️ 为此把集智从 `useCard`（同步分发）挪到 `cardActionStarted`（可挂起）——后半句要发问，同步时机上的询问会被后续流程静默覆盖。顺带修了一个真 bug：`cardActionStarted` 在 onPlayCard 里被**派发过两次**（doPlay 里多留了一句），对蒺藜那种只读计数的技能看不出来，对有副作用的集智就会多摸一张。',
  },
  {
    id: 'ganfuren',
    name: '甘夫人',
    faction: 'shu',
    pack: 'standard',
    status: 'done',
    primitives: ['hook_interaction', 'phase_ask'],
    note: '按**最新**官方文本（国战标准版 2018 口径）：淑慎不限定势力（2012 旧版限「与你势力相同」）；神智是「准备阶段弃置所有手牌，弃置数 ≥ 当前体力才回复 1 点」，不是「准备阶段回复 1 点」。淑慎挂在新增的 afterHeal 时机上。',
  },
  // 注意：卧龙诸葛亮与诸葛亮是两名不同武将，各有独立 id
  {
    id: 'wolong',
    name: '卧龙诸葛亮',
    faction: 'shu',
    pack: 'standard',
    status: 'done',
    note: '八阵（lockedFields: hasBaguaAlways，equip.tryBaguaDodge 读）+ 火计（canUseAs huogong）+ 看破（canUseAs wuxie）。基础 maxHp 3 是对的：牌面 1.5 阴阳鱼 = 身份局体力÷2，见文档 4.1。',
  },
  {
    id: 'pangtong',
    name: '庞统',
    faction: 'shu',
    pack: 'standard',
    status: 'done',
    primitives: ['limited_skill', 'chained'],
    note: '双技能齐了。连环 = canUseAs(梅花手牌→tiesuo)，「或重铸」那半边不用另写——引擎看到「这张牌能当可重铸的牌型用」就允许重铸（engine.ts canRecastCard）。涅槃 = nearDeath 钩子 + usedOncePerGame。',
  },
  { id: 'huangzhong', name: '黄忠', faction: 'shu', pack: 'standard', status: 'done' },
  {
    id: 'weiyan',
    name: '魏延',
    faction: 'shu',
    pack: 'standard',
    status: 'done',
  },
  {
    id: 'liushan',
    name: '刘禅',
    faction: 'shu',
    pack: 'standard',
    status: 'done',
    primitives: ['extra_turn', 'hook_interaction'],
  },
  {
    id: 'menghuo',
    name: '孟获',
    faction: 'shu',
    pack: 'standard',
    status: 'done',
    primitives: ['chained', 'pick_cards'],
    note: '祸首 = immuneToNanman + 新增的 nanmanDamageSource（南蛮伤害的来源改记成孟获，在 passAoeTrick 里换）。再起挂在**新增的 discardPhaseEnd 时机**上，X = 本回合经 toDiscard 记进账本的红桃牌数（按你的口径取红桃，不是「红色」）。来源版本之间对目标是否限势力有分歧，这里按红桃那个版本取「至多X名角色」。',
  },
  {
    id: 'zhurong',
    name: '祝融',
    faction: 'shu',
    pack: 'standard',
    status: 'done',
    primitives: ['pick_cards', 'pindian'],
    note: '烈刃与巨象**两半都实现了**：南蛮对你无效（immuneToNanman）+ 其他角色用过的南蛮结算后你获得之（gainsUsedNanman，由引擎在锦囊收口派发）。',
  },
];

const STANDARD_WU: RosterEntry[] = [
  {
    id: 'sunquan',
    name: '孙权',
    faction: 'wu',
    pack: 'standard',
    status: 'done',
    primitives: ['faction_call'],
    note: '救援不是 faction_call——它是纯加血规则（同势力其他角色用桃救你时额外回 1 点），在 respondDeathSave 里实现。',
  },
  { id: 'ganning', name: '甘宁', faction: 'wu', pack: 'standard', status: 'done' },
  {
    id: 'lvmeng',
    name: '吕蒙',
    faction: 'wu',
    pack: 'standard',
    status: 'done',
    primitives: ['move_field_card'],
    note: '按**最新国战标准版（2018）**文本：克己（锁定技，出牌阶段未使用过颜色不同的牌或出牌阶段被跳过 → 手牌上限+4）+ 谋断（用满四花色或三类别 → 移动场上的一张牌）。⚠️ 界吕蒙是「克己+勤学（觉醒）」另一套，国战不是那套。用过的牌由 markCardUsed 在 useCard 钩子处统一登记（只记自己的出牌阶段）。',
  },
  { id: 'huanggai', name: '黄盖', faction: 'wu', pack: 'standard', status: 'done' },
  { id: 'zhouyu', name: '周瑜', faction: 'wu', pack: 'standard', status: 'done' },
  {
    id: 'daqiao',
    name: '大乔',
    faction: 'wu',
    pack: 'standard',
    status: 'done',
    primitives: ['hook_interaction', 'target_transfer', 'pick_cards'],
    note: '流离走 api.redirectAttack（AttackBox）：引擎对新目标重新走一遍「成为目标」的结算。只允许改一次目标，防两个大乔来回弹。',
  },
  {
    id: 'xiaoqiao',
    name: '小乔',
    faction: 'wu',
    pack: 'standard',
    status: 'done',
    primitives: ['target_transfer'],
  },
  {
    id: 'lusu',
    name: '鲁肃',
    faction: 'wu',
    pack: 'standard',
    status: 'done',
    primitives: ['pick_cards', 'move_field_card'],
    note: '好施（摸牌阶段多摸两张，手牌>5 就把一半交给手牌最少的人）+ 缔盟（选两名其他角色，弃两人手牌数之差，然后交换双方手牌）。⚠️ 好施在**钩子**里发起询问，不能传 returnTo——传了会把摸牌阶段跳掉（引擎的续接队列才是正确通路）。缔盟的 X 只有选完目标才知道，所以目标由主动技收、弃牌在 execute 里用 askPickCards 再问。',
  },
  {
    id: 'sunjian',
    name: '孙坚',
    faction: 'wu',
    pack: 'standard',
    status: 'done',
    primitives: ['hook_interaction'],
  },
  {
    id: 'taishici',
    name: '太史慈',
    faction: 'wu',
    pack: 'standard',
    status: 'done',
    primitives: ['pindian'],
    note: '天义：拼点赢了本回合额外一张【杀】且【杀】无距离限制（flags.ignoreShaDistanceThisTurn）。',
  },
  {
    id: 'dingfeng',
    name: '丁奉',
    faction: 'wu',
    pack: 'standard',
    status: 'done',
    primitives: ['chained'],
  },
  {
    id: 'zhangzhao_zhanghong',
    name: '张昭张纮',
    faction: 'wu',
    pack: 'standard',
    status: 'done',
    primitives: ['pick_cards'],
  },
  { id: 'zhoutai', name: '周泰', faction: 'wu', pack: 'standard', status: 'done' },
  {
    id: 'luxun',
    name: '陆逊',
    faction: 'wu',
    pack: 'standard',
    status: 'done',
    primitives: ['hand_emptied'],
    note: '连营用「意图开始前 vs 结束后」比对触发。已知局限：同一段结算里先清空又摸回来的情况检测不到。',
  },
  {
    id: 'sunshangxiang',
    name: '孙尚香',
    faction: 'wu',
    pack: 'standard',
    status: 'done',
    primitives: ['equip_lost'],
    note: '枭姬挂在 equipLost 上：顶替装备、被拆、被顺、借刀交武器都会触发。',
  },
];

const STANDARD_QUN: RosterEntry[] = [
  { id: 'lvbu', name: '吕布', faction: 'qun', pack: 'standard', status: 'done' },
  { id: 'huatuo', name: '华佗', faction: 'qun', pack: 'standard', status: 'done' },
  { id: 'diaochan', name: '貂蝉', faction: 'qun', pack: 'standard', status: 'done' },
  { id: 'mateng', name: '马腾', faction: 'qun', pack: 'standard', status: 'done' },
  { id: 'kongrong', name: '孔融', faction: 'qun', pack: 'standard', status: 'done' },
  { id: 'zoushi', name: '邹氏', faction: 'qun', pack: 'standard', status: 'done' },
  { id: 'tianfeng', name: '田丰', faction: 'qun', pack: 'standard', status: 'done' },
  {
    id: 'jiling',
    name: '纪灵',
    faction: 'qun',
    pack: 'standard',
    status: 'done',
    primitives: ['pindian'],
  },
  { id: 'panfeng', name: '潘凤', faction: 'qun', pack: 'standard', status: 'done' },
  {
    id: 'zhangjiao',
    name: '张角',
    faction: 'qun',
    pack: 'standard',
    status: 'done',
    primitives: ['hook_interaction', 'judge_ownership'],
  },
  {
    id: 'yuanshao',
    name: '袁绍',
    faction: 'qun',
    pack: 'standard',
    status: 'done',
    primitives: ['virtual_trick'],
    note: '乱击：两张同花色手牌当【万箭齐发】，走 api.castVirtualTrick。身份局里他还有主公技【血裔】，国战不是君主，不收录。',
  },
  {
    id: 'yanliang_wenchou',
    name: '颜良文丑',
    faction: 'qun',
    pack: 'standard',
    status: 'done',
    primitives: ['pindian'],
  },
  {
    id: 'caiwenji',
    name: '蔡文姬',
    faction: 'qun',
    pack: 'standard',
    status: 'done',
    primitives: ['pick_cards'],
  },
  {
    id: 'jiaxu',
    name: '贾诩',
    faction: 'qun',
    pack: 'standard',
    status: 'done',
    primitives: ['limited_skill'],
  },
  {
    id: 'pangde',
    name: '庞德',
    faction: 'qun',
    pack: 'standard',
    status: 'done',
    primitives: ['hook_interaction'],
  },
];

// ——————————————————————————————————————————
// 君临天下 阵 / 势 / 变 / 权（各 8 将，均单势力魏蜀吴群）
// 各包的君主将（君刘备/君张角/君孙权/君曹操）本次不做。
// ——————————————————————————————————————————

const ZHEN: RosterEntry[] = [
  {
    id: 'dengai',
    name: '邓艾',
    faction: 'wei',
    pack: 'zhen',
    status: 'done',
    primitives: ['awaken_skill', 'pick_cards'],
    note: '屯田（新时机 cardsLost：意图前后对「手牌+装备区」做快照比对，只在自己回合外派发）+ 急袭（主将技、减半个阴阳鱼：田当顺手牵羊，**保留这张田的真实花色/颜色**，所以【帷幕】按颜色照常生效——只有♦田能偷贾诩，靠 Card.tian 标记 + usableCardsOf/findUsableCard/takeUsableCard 扩展）+ 资粮（副将技：同势力角色受伤后交一张田）都已实现并有测试。局限：同一段结算里「先丢掉又摸回来」检测不到（与 handEmptied 同一处局限）。',
  },
  {
    id: 'caohong',
    name: '曹洪',
    faction: 'wei',
    pack: 'zhen',
    status: 'done',
    primitives: ['hook_interaction', 'siege_formation'],
    note: '护援 + 鹤翼（阵法技）都已实现：鹤翼用 grantsFeiyingToQueue，由 distance() 里的 hasFeiying 读——同一队列（formationQueue：连续相邻且同势力）的其他人视为拥有飞影。',
  },
  {
    id: 'jiangwei',
    name: '姜维',
    faction: 'shu',
    pack: 'zhen',
    status: 'done',
    primitives: ['awaken_skill'],
    note: '志继已实现：走 api.changeMaxHp + api.grantSkill（从诸葛亮身上摘【观星】）。觉醒技是锁定技，满足条件必须发动、不问。',
  },
  {
    id: 'jiangwan_feyi',
    name: '蒋琬费祎',
    faction: 'shu',
    pack: 'zhen',
    status: 'done',
    primitives: ['pick_cards'],
    note: '生息（2015/典藏版口径：弃牌阶段开始时）与守成都已实现；守成的「同势力」按互相认同口径（双方需明置）。',
  },
  {
    id: 'xusheng',
    name: '徐盛',
    faction: 'wu',
    pack: 'zhen',
    status: 'done',
    primitives: ['hook_interaction', 'siege_formation'],
    note: '疑城 + 鸟翔（阵法技）都已实现：鸟翔挂在 othersBecomeTarget，靠 siegeRelations（围攻关系）判断「同一个围攻关系里的围攻角色出杀指定被围攻者」→ requiredShan = 2。',
  },
  {
    id: 'jiangqin',
    name: '蒋钦',
    faction: 'wu',
    pack: 'zhen',
    status: 'done',
    primitives: ['pick_cards', 'hook_interaction', 'siege_formation'],
    note: '尚义 + 鸟翔（阵法技）都已实现。',
  },
  {
    id: 'yuji',
    name: '于吉',
    faction: 'qun',
    pack: 'zhen',
    status: 'done',
    primitives: ['hook_interaction', 'pick_cards'],
    note: '国战于吉是【千幻】（蛊惑是身份局版本，国战不用）。千幻牌堆放 Player.qianhuan（与「田」同类）；「成为非装备牌的唯一目标」用 othersBecomeTarget——单人目标的锦囊现在也派发它（startTrickResolution），取消【杀】走 attack.dodged、取消锦囊走 wuxieChain（与无懈·国同一条路）。',
  },
  {
    id: 'hetaihou',
    name: '何太后',
    faction: 'qun',
    pack: 'zhen',
    status: 'done',
    primitives: ['hook_interaction'],
    note: '鸩毒（新时机 othersPlayPhase：「其他角色的出牌阶段开始时」）+ 戚乱（用 state.killedThisTurn，按回合清）。取君临天下·阵 2013 印刷版口径：鸩毒只对其他角色、戚乱固定摸三张（OL 2020 后的动态版未采用）。',
  },
];

const SHI: RosterEntry[] = [
  {
    id: 'lidian',
    name: '李典',
    faction: 'wei',
    pack: 'shi',
    status: 'done',
    primitives: ['pick_cards'],
    note: '恂恂（2013 印刷版：摸牌阶段看四取二、其余置牌堆底）+ 忘隙（造成/受到 1 点伤害后各摸一张，逐点）。忘隙的「若该角色存活」已按官方口径落实：本引擎伤害层顺序是「伤害后钩子→濒死」（官方相反），所以「被打进濒死」那一半改成记一笔待办（flags.wangxiPending），等 nearDeathResolved（濒死结算完、知道活没活下来）再问——救回来了照样各摸一张，没救回来就不触发。',
  },
  {
    id: 'zangba',
    name: '臧霸',
    faction: 'wei',
    pack: 'shi',
    status: 'done',
    primitives: ['hook_interaction'],
    note: '横江已实现（印刷版：受伤后令当前回合角色手牌上限-1，其弃牌阶段没弃牌则臧霸摸一张；用新标记 flags.hengjiangTarget + othersDiscardPhaseEnd 时机）。2023 典藏版修订（上限>0 条件、摸 X 张）未采用。',
  },
  {
    id: 'madai',
    name: '马岱',
    faction: 'shu',
    pack: 'shi',
    status: 'done',
    primitives: ['hook_interaction', 'pick_cards'],
    note: '潜袭（2013 印刷版：判定 → 令距离 1 的角色本回合不能用/打出该颜色手牌）+ 马术。候选是「距离**为 1**」的角色：马术 -1 之后相邻者被**距离下限 1** 兜住，所以相邻的三个人都能选（用户 2026-09-21 的口径，见 docs §5.155）。颜色限制是新标记 flags.cannotPlayColor，在「使用/重铸/打出响应」三处统一拦。2018 修订版（摸一弃一代替判定）未采用。技能判定已接入「判定牌生效前」的公共时机（见下条说明），所以鬼才/鬼道可以改判、天妒可以收牌。',
  },
  {
    id: 'mifuren',
    name: '糜夫人',
    faction: 'shu',
    pack: 'shi',
    status: 'done',
    primitives: ['remove_hero'],
    note: '闺秀（明置摸两张走新时机 heroRevealed；移除时回 1 血走 Hero.healOwnerOnRemoval）+ 存嗣（移除自己并把【勇决】给一名角色，非自己则其摸两张）都已实现。【勇决】是伪武将（notDraftable），触发走新时机 attackSettled。',
  },
  {
    id: 'sunce',
    name: '孙策',
    faction: 'wu',
    pack: 'shi',
    status: 'done',
    primitives: ['awaken_skill', 'pindian', 'slot_skills'],
    note: '激昂（用/被打红色杀或决斗两个方向都摸一张；决斗方向用了「单人目标锦囊也派发成为目标后」）+ 鹰扬 + 魂殇（副将技，deputySlotHalfYang 减半个阴阳鱼）都已实现。鹰扬按国战原文「当你拼点的牌亮出后，你可以令此牌的点数+3或-3（至少为A，至多为K）」——为此给拼点流程加了新时机 pindianRevealed + api.setPindianRank（与判定里的 replaceJudgeCard 同一套「盒子」写法：问了才知道改几，不能靠返回值）。⚠️ 顺带修了一个坑：拼点原本靠最后一次扣牌询问的 returnTo 回到出牌阶段，鹰扬的询问一挂起那条兜底就失效（pending 会停在 null），所以引擎在拼点链末尾显式补一次 resumePlay。珠联璧合（周瑜/大乔/太史慈）也已登记。',
  },
  {
    id: 'chenwu_dongxi',
    name: '陈武董袭',
    faction: 'wu',
    pack: 'shi',
    status: 'done',
    primitives: ['chained'],
    note: '断绁（令一名其他角色横置，自己也横置）+ 奋命（结束阶段若自己横置，弃置所有横置角色各一张牌）。取 2013 印刷版：断绁只横置一名（2022 加强版是至多 X 名，未采用）。',
  },
  {
    id: 'dongzhuo',
    name: '董卓',
    faction: 'qun',
    pack: 'shi',
    status: 'done',
    primitives: ['maxhp_change', 'pick_cards', 'remove_hero'],
    note: '横征 + 暴凌（主将技、锁定技）都已实现：暴凌在出牌阶段结束时移除副将、+3 上限、回 3 血并把【崩坏】授予自己（崩坏是伪武将，notDraftable）。主将技按技能名限制（mainSlotSkills），并让它少半个阴阳鱼（mainSlotHalfYang）。',
  },
  {
    id: 'zhangren',
    name: '张任',
    faction: 'qun',
    pack: 'shi',
    status: 'done',
    primitives: ['remove_hero', 'hook_interaction', 'siege_formation'],
    note: '穿心 + 锋矢（阵法技）都已实现。',
  },
];

const BIAN: RosterEntry[] = [
  {
    id: 'xunyou',
    name: '荀攸',
    faction: 'wei',
    pack: 'bian',
    status: 'done',
    primitives: ['virtual_trick', 'change_deputy'],
    note: '奇策（先选锦囊再选目标：目标数受手牌数限制，收尾可选变更一次副将）+ 智愚 都已实现。虚拟锦囊的花色取第一张材料牌（只影响帷幕那类看颜色的判断）。',
  },
  {
    id: 'bianfuren',
    name: '卞夫人',
    faction: 'wei',
    pack: 'bian',
    status: 'done',
    primitives: ['pick_cards', 'hook_interaction'],
    note: '取 2017 印刷版：挽危（被拆/被顺时可自己挑失去哪张牌——引擎的 pickTargetCard 现在也认「指定的手牌」）+ 约俭（新时机 othersDiscardPhase + flags.targetedOtherFactionThisTurn）。2020 修订版把挽危整个换成「从牌堆拿同名牌」，未采用。',
  },
  {
    id: 'masu',
    name: '马谡',
    faction: 'shu',
    pack: 'bian',
    status: 'done',
    primitives: ['pick_cards'],
    note: '散谣 + 制蛮 都已实现：制蛮挂在新时机 damageCaused（来源视角），防止伤害后获得其装备/判定区一张牌，同势力时其可以变更副将（变包机制：从残留武将牌堆连亮到与主将同势力）。',
  },
  {
    id: 'shamoke',
    name: '沙摩柯',
    faction: 'shu',
    pack: 'bian',
    status: 'done',
    primitives: ['hook_interaction'],
    note: '蒺藜已实现：新时机 cardActionStarted（使用与打出的唯一公共时机，在「计数」处派发）+ flags.cardsUsedOrPlayed/actionRangeSnapshot；范围取「这张牌生效之前」的值（官方 FAQ：先出牌再装武器不算）。顺带修了一个真 bug：onPlayCard 里钩子发问会被随后的 playSha/playTrick 覆盖（现在把出牌动作放进钩子续接里）。',
  },
  {
    id: 'lingtong',
    name: '凌统',
    faction: 'wu',
    pack: 'bian',
    status: 'done',
    primitives: ['hook_interaction'],
    note: '旋略（失去装备区的牌后弃一名其他角色的一张牌，不能碰判定区）+ 勇进（限定技：移动场上至多三张装备牌）都已实现。「一次失去只触发一次」已落实：equipLost 是逐张派发的（枭姬那种要求每张都算），所以给同一次动作的整批装备牌共用一个 payload.eventId，旋略按它去重；配套把「一次丢多张」的几处（甘露交换、水淹七军弃光、贯石斧一次弃两张、悲歌梅花弃两张走新的 api.discardCards）都改成同一事件。',
  },
  {
    id: 'lvfan',
    name: '吕范',
    faction: 'wu',
    pack: 'bian',
    status: 'done',
    primitives: ['pick_cards', 'move_field_card', 'change_deputy'],
    note: '调度（2017 印刷版：同势力角色依次「使用一张装备牌 / 把装备区的牌移给同势力队友」）+ 典财（新时机 othersPlayPhaseEnd + flags.lostCardsThisPhase 计数；摸至手牌上限后可选变更副将）都已实现。2019 修订版把调度整个换掉了，未采用。',
  },
  {
    id: 'zuoci',
    name: '左慈',
    faction: 'qun',
    pack: 'bian',
    status: 'done',
    primitives: ['virtual_trick', 'hook_interaction'],
    note: '取**2019 典藏版**国战文本的「役鬼 + 汲魂」（2017 印刷版是「化身 + 新生」，两者是完全不同的两套技能，未采用）。魂牌堆 Player.hun（存武将 id，暗置→用时随机移去并亮出牌面，势力决定目标限制）；汲魂的「濒死结算结束后存活」用新时机 nearDeathResolved。',
  },
    {
    id: 'lijue_guosi',
    name: '李傕郭汜',
    faction: 'qun',
    pack: 'bian',
    status: 'done',
    primitives: ['limited_skill', 'hook_interaction'],
    note: '国战李傕郭汜**只有【凶算】一个技能**（亦算是身份/SP 单体李傕的，不在这里）。凶算＝限定技：弃一张手牌、对同势力角色造成 1 点伤害、摸三张；若其有已发动的限定技，点一个，本回合结束时视为未发动（flags.limitedToReset + turnEnd 里清理）。钩子形式的限定技（涅槃等）没中文名可查，选项标签直接用作者写的 key。',
  },
];

const QUAN: RosterEntry[] = [
  {
    id: 'cuiyan_maojie',
    name: '崔琰毛玠',
    faction: 'wei',
    pack: 'quan',
    status: 'done',
    primitives: ['pick_cards', 'virtual_trick'],
    note: '取 **2019 修订版**（2023 国战典藏版口径）：征辟①「未确定势力角色→你对其使用牌无距离和次数限制」（新标记 distanceLimitlessToSeat：distance() 放行 + playSha 跳过次数限制，目标明置后惰性失效）；②交换牌；奉迎＝限定技，所有手牌当【挟天子以令诸侯】（不带大势力校验），然后同势力角色摸至手牌上限。三版差异（2018 初版「视为与你势力相同」、2021 版奉迎改成额外回合）写在代码注释里。',
  },
  {
    id: 'yujin',
    name: '于禁',
    faction: 'wei',
    pack: 'quan',
    status: 'done',
    primitives: ['army_order', 'pick_cards'],
    note: '节钺（与印刷版/OL 一致）：准备阶段交给「不是魏势力」（＝与你势力不同）的一名角色一张手牌，令其执行军令；执行则你摸一张，不执行则你本回合摸牌阶段多摸三张（drawCountDelta +3）。军令机制复用董昭·劝进那套 api.armyOrder。',
  },
  {
    id: 'fazheng',
    name: '法正',
    faction: 'shu',
    pack: 'quan',
    status: 'done',
    primitives: ['pick_cards'],
    note: '取 **2019 修订版**（＝三国杀官网现行文本）：恩怨①「其他角色对你使用【桃】时其摸一张牌」（2018 初版是「你获得他人至少两张牌后其摸一张」，未采用）+ 恩怨②「受伤后来源交一张手牌或失去 1 点体力」；眩惑「交给你一张手牌并弃置一张牌，然后本回合获得武圣/咆哮/龙胆/铁骑/烈弓/狂骨之一（不能选场上已有的）」。眩惑与【黄天】同一档：**反向**技能挂在 legal/onUseSkill 的外部技能表上；六个技能都用国战版（借来的烈弓按国战条件判、咆哮带「第二张杀摸一张」），授予走 grantTempSkill。恩怨①只可能在濒死求桃时触发，靠 afterHeal 新增的 payload.taoSaverId 派发，且与【救援】一致只认实体【桃】（红牌当桃、酒当桃不算）。已知读法：发动者必须是已确定势力的角色（暗将无势力，与【黄天】同口径）。',
  },
  {
    id: 'wangping',
    name: '王平',
    faction: 'shu',
    pack: 'quan',
    status: 'done',
    primitives: ['army_order', 'maxhp_change'],
    note: '将略（限定技，**三国杀官网现行文本**）：出牌阶段选一条「军令」，与你势力相同的其他角色均可执行；你和每个执行者体力上限+1且回复1点体力，然后你摸X张（X＝因此回复体力的角色数）。⚠️ 2018 印刷版那句「未确定势力的角色可以在此时明置武将牌」线上已删，本实现按现行文本（暗将不能借机明置，也不在名单里——暗将没有势力）。新原语 api.armyOrderMulti（一条军令问多个人的变体，与 armyOrder 共用挑令流程）；「先加上限再回血」按官方原文顺序，所以满血参与者也能回这 1 点；X 用 api.heal 的实际回复量来数（被军令翻面者不能回复体力就不算）。顺带把 healAndTrigger 里 never-read 的 cannotHealThisTurn（军令·翻面）补上——在此之前「本回合不能回复体力」是空话。',
  },
  {
    id: 'wuguotai',
    name: '吴国太',
    faction: 'wu',
    pack: 'quan',
    status: 'done',
    primitives: ['pick_cards', 'move_field_card', 'army_order'],
    note: '甘露 + 补益（君临天下·权，吴，国战牌面 1.5 阴阳鱼 → 3，称号·武烈皇后；文本按三国杀官网，与 B 站 Wiki 的国战栏一致）。甘露的限制（牌数差 ≤ 你已损失体力值、牌数之和 ≥ 1）都在「两名角色」这一对上，所以目标组合在 execute 里校验；交换走新原语 api.swapEquipAreas——先把两边装备区的牌都收下来（各自触发失去装备的钩子：枭姬、白银狮子回血），再互换放回，中途不会把牌顶进弃牌堆（逐张顶掉会把本来要换过去的牌弃掉）。补益挂在 nearDeathResolved，sourceId 取 payload 里新加的「本次伤害来源」；没有来源（闪电那种）时跳过；「每回合限一次」用 flags.skillUsedThisTurn。',
  },
  {
    id: 'lukang',
    name: '陆抗',
    faction: 'wu',
    pack: 'quan',
    status: 'done',
    primitives: ['pick_cards'],
    note: '恪守 + 筑围（君临天下·权，吴，国战牌面 1.5 阴阳鱼 → 3，称号·孤柱扶厦）。恪守按**三国杀官网现行文本**：两句互不依赖（第二句没有「若如此做」也没有「然后」），付不起/不想付代价时只要没有同势力其他角色，判定照样做——B 站 Wiki 的国战栏写成「…令此伤害-1，**然后**若没有…你进行一次判定」，读起来像「付了代价才判」，未采用。「令此伤害-1」走新通道 flags.damageReduce（damageDealt 钩子里除「防止」外的第二个出口，可选的减伤没法写进 finalizeDamage 那套锁定技算法），减到 0 按「没造成伤害」处理。筑围的「获得之」与【天妒】同路（beforeJudge 返回 gainJudgeCard）且同样是自动收（官方那半句是「可以」，白拿严格更优），真正需要问的后半句单独弹一次；「伤害锦囊」按「结算时会造伤」认：决斗/南蛮/万箭/火攻 + 势备篇的火烧连营、水淹七军（后者二选一里能造成伤害）。「本回合手牌上限+1」复用 flags.handLimitBonus，杀次数新增 flags.shaLimitBonus（都随回合重置）。',
  },
  {
    id: 'yuanshu',
    name: '袁术',
    faction: 'qun',
    pack: 'quan',
    status: 'done',
    primitives: ['army_order', 'pick_cards', 'virtual_equip'],
    note: '庸肆 + 伪帝（君临天下·权，群，国战牌面 2 阴阳鱼 → 4；文本按三国杀官网现行文本）。庸肆的「视为装备着【玉玺】」做成字段 virtualYuxi + heroes.hasYuxi：真装了，或者「庸肆 + 场上任何人的装备区里都没有实体玉玺」——【玉玺】的两条效果（摸牌阶段多摸一张 / 出牌阶段开始时视为使用【知己知彼】）都改成读这一个函数，所以条款只实现一次。「成为【知己知彼】的目标时展示所有手牌」挂 othersBecomeTarget（单目标锦囊给所有存活角色派发、含目标本人，按 payload.targetId 认人；时机在无懈窗口之前，正是「成为目标时」），展示按本引擎惯例写成一条日志（火攻/智愚同）。伪帝按 2019 修订版的「**其他**角色」（2018 初版可对自己发动）；「本回合从牌堆获得过牌」的账本＝ state.gainedFromDeckThisTurn（在 drawOne 里盖戳、随回合清空，重洗后摸到的也算——比意图快照准）；不执行的惩罚＝先拿光其手牌、再由袁术挑等量张还回去（还装备区的牌走 api.transferCard 会触发枭姬那类）。「本回合从牌堆获得过牌」的认人方式已修正：原来是「本回合抽出的牌 id 列表」（别人顺手牵羊拿走之后，新持有者也会被算进去），现在按**意图结束时的首次持有**把牌归因到人（state.deckGainOwner）——偷来的不算自己摸的。已知偏差：同一手意图里「摸到又立刻弃掉」的牌不会归因。',
  },
  {
    id: 'zhangxiu',
    name: '张绣',
    faction: 'qun',
    pack: 'quan',
    status: 'done',
    primitives: ['pick_cards'],
    note: '附敌 + 从谏（君临天下·权，群，国战牌面 2 阴阳鱼 → 4）。附敌的「其」是**伤害来源**：交给来源一张手牌后，从「与来源势力相同的角色」里挑**体力值≥你**者中体力最多的一档打 1 点（并列时由张绣挑；来源自己也算候选，官方写的是「与其势力相同的角色」不是「其他角色」）；来源是暗将（无确定势力）或没有合格候选时连询问都不弹。从谏是锁定技、用新字段 damageDelta 表达：引擎在 damageStep 里读（不像裸衣只在【杀】/【决斗】），所以任何伤害都吃得到——连附敌自己那 1 点也会因为「回合外造成」再 +1。两个方向：① 回合外造成伤害 +1；② 回合内受到伤害 +1；「自己回合里自伤」只会命中②一次。',
  },
];

// ——————————————————————————————————————————
// 不臣篇：**双势力 12 名 + 野心家 4 名 + 单势力 4 名，全部已实现**（技能文本由用户逐批核对后给出）。
// 这里曾写着「只有两个势力这条已核到、技能文本还没核到」——那是登记期的状态，早已补齐
// （见 heroes.ts 与 docs §5.81–§5.107）。
// ——————————————————————————————————————————

const BUCHEN: RosterEntry[] = [
  {
    id: 'dongzhao',
    name: '董昭',
    faction: 'wei',
    pack: 'buchen',
    status: 'done',
    primitives: ['army_order'],
    note: '劝进已实现（军令机制的第一个用户）。体力填的是身份局口径的 3（牌面是 1.5 阴阳鱼，阴阳鱼数 = 体力÷2，见文档 4.1）。',
  },
  // ⚠️ 以下三名的**国战（不臣篇）文本**尚未查到，查到之前不实现（见 docs/guozhan-roster.md §5.27
  // 记的查证过程与死路）。它们的势力/体力也还没确认，别照身份局那版填。
  {
    id: 'xushu',
    name: '徐庶',
    faction: 'shu',
    pack: 'buchen',
    status: 'done',
    primitives: ['pick_cards', 'slot_skills', 'change_deputy'],
    note: '诛害 + 举荐（不臣篇·上，蜀，国战牌面 2 阴阳鱼 → 4，称号·难为完臣；珠联璧合 赵云/卧龙诸葛亮）。取 **2021 线下实体卡**口径——三版并存，这一版两个技能都能完整实现：诛害＝其他角色的结束阶段，若该角色本回合造成过伤害，则你可以对其使用一张【杀】（挂 othersTurnEnd，payload.turnSeatId 就是那个结束回合的人；「造成过伤害」读 flags.dealtDamageThisTurn，即生息那套公共登记，自伤不算；使用走 api.useShaOn，它不查距离，正好满足「无距离限制」）；举荐＝副将技（deputySlotSkills + deputySlotHalfYang），结束阶段弃一张非基本牌令一名同势力角色二选一（摸两张/回 1 血），然后其可变更一次副将。⚠️ 未采用的另两版：移动版 2021 的诛害多了「无视防具 + 用闪后弃牌」、副将换成【荐才】（要轮数计数与「获知武将牌」的信息通道）；2023 典藏版两个技能都换掉了（谦策 + 举荐②）。',
  },
  {
    id: 'wujing',
    name: '吴景',
    faction: 'wu',
    pack: 'buchen',
    status: 'done',
    primitives: ['virtual_trick', 'siege_formation', 'pick_cards'],
    note: '调归 + 风扬（不臣篇·上，吴，国战牌面 2 阴阳鱼 → 4，称号·汗马鎏金；移动版 2021 口径）。调归：手牌里的一张装备牌当【调虎离山】使用（材料先付），走 api.castVirtualTrick 的完整锦囊流程；「若你的势力**因此**形成队列」按字面读＝这次结算后队列确实形成或变长（before 存 flags.queueSizeBeforeTrick，afterUse 时比较），所以本来就有队列没变长、或被无懈抵消时都不摸牌。为此引擎在【调虎离山】结算收尾处派发了 afterUse（该时机以前只有声明；目前只开这一条路，推广到所有锦囊出口要改 49 处 resumePlay，先不动）。formationQueue 现在跳过「被调虎离山移出座次」的角色——否则调归的典型用法（把中间的敌人调走让同势力连上）根本不会成立。⚠️ 读法：「队列」按**至少 2 名**处理（官方阵法技是否要求 3 名未在本会话核实）。风扬做成字段 fengyang + fengyangBlocksEquip()，引擎在过河拆桥/顺手牵羊的选牌、transferCard（反馈那类获得）两处收口调用；「移动」类（巧变/谋断/勇进/甘露）不受限——官方只说「弃置或获得」。UI 目前不会把被保护的装备置灰（引擎会拒绝该选择）。',
  },
  {
    id: 'yanbaihu',
    name: '严白虎',
    faction: 'qun',
    pack: 'buchen',
    status: 'done',
    primitives: ['pick_cards', 'slot_skills', 'remove_hero'],
    note: '雉盗 + 寄篱（不臣篇·上，群，国战牌面 2 阴阳鱼 → 4，称号·豺牙落涧；文本已核）。取 **2021 移动版**口径：寄篱是副将技（deputySlotSkills + deputySlotHalfYang；2022 版去掉了副将技标签与 -1 阴阳鱼，2021 线下实体卡把「再使用一次」写成「此牌结算两次」，同义）。雉盗：距离用现成的 flags.distanceToOneThisTurn，「只能指定他与你」用新标记 flags.cardTargetOnlySeat 并在 engine.onPlayCard 统一拦（zhidaoTargetsBlocked，AOE 那类不指定目标却会打到别人的牌也一并拦）；「第一次对其造成伤害后获得其区域里的一张牌」挂 afterDamageDealt + flags.zhidaoHitDone，拿牌走 takeOneOfTargetCards。寄篱三句都实现了：①「此牌结算结束后，此牌的使用者对你再使用一次相同牌名的牌」——成为红色即时锦囊唯一目标时由 othersBecomeTarget 钩子置 trickCtx.jiliUse、成为红色【杀】唯一目标（attack.totalTargets===1）时由 becomeTarget 钩子置 attack.jiliUse；执行侧在单目标锦囊的结算收口 endTrickResolution()（原来 54 处 resumePlay 全换成它）、【杀】的 afterAttackSettledTail、【桃】的自用与濒死求桃两条路上各**新使用一张无实体虚拟同名牌**（engine.virtualSameNameCard / useVirtualSameNameCard：subcards=[]、不继承花色点数、无色、generatedBy 标为 jili，是一次全新的卡牌使用事件，会重新指定目标并重开响应窗口）；防自环＝虚拟牌无色（寄篱钩子只认红色牌）+ attack.generatedBy 第二道保险。⚠️ 与君孙权【据江】的「此牌额外结算一次」是**两套机制**：据江走 extraResolve＝同一张牌追加一遍结算（不新建使用、不重开响应窗口、账本 state.extraResolvedCards 按牌 id 去重），不再是共用字段。②「本阶段第 2 次受到伤害防止并移除」——damageDealt 里读 flags.damageCountKey/count（键＝`回合座位:阶段名`）。⚠️ 已知简化/读法：第二张不沿用第一遍选的明牌（过拆/顺手那张可能已被拿走，让使用者重选）；被无懈抵消的锦囊照样会「再使用一次」（按「成为目标就触发」的字面读法）；【酒】靠布尔标记生效，第二张不叠加伤害；【桃】的第二张直接结算回复 1 点（不套「体力已满不能使用【桃】」那条**主动使用**的限制）。',
  },

];

/**
 * ⚠️ 关于「技能判定」的统一说明（第 96 名武将收口后补的）：
 *
 * 技能里的判定（刚烈 / 屯田 / 潜袭 / 悲歌 / 恪守 / 雷击）现在统一走引擎的 `api.judge(...)`——
 * 也就是**和判定阶段的延时锦囊完全同一条路**：摸判定牌 → 「判定牌生效前」时机（鬼才司马懿、
 * 鬼道张角可以打出手牌**改判**）→ 天妒（郭嘉）可以收走**自己**的判定牌 → 判定牌归判定者
 * （所以小乔·红颜对「技能拥有者判定」那类仍然按拥有者口径看）。
 * 判定者不再一律是技能使用者：**雷击由张角指定的那名角色判定、悲歌由受伤者判定**（都按官方原文），
 * 所以「谁能收这张判定牌」也跟着变。
 *
 * 马超·铁骑也在这条路上（它挂在 `useCard` 上）——以前 useCard 是同步分发的时机，判定里鬼才
 * 一发问就会被覆盖，所以只能裸判定；后来 `useCard` 转成**可挂起**（见 docs §5.34）之后就一并接上了。
 * 现在 roster 里**没有**「改不了判定的技能」了。
 */
export const GUOZHAN_ROSTER: RosterEntry[] = [
  /**
   * 君主将四张（君曹操/君刘备/君孙权/君袁绍）——**独立的武将牌**，不是普通的曹操/刘备/孙权/袁绍。
   *
   * ✅ **四张后来都补齐了**（这段曾写着「另外三位君主的君威未实现、专属装备待核对」）：
   * 君主特性 +【君威】+ 四件专属装备（飞龙夺凤 / 六龙骖驾 / 定澜夜明珠 / 盟军大纛）+ 各自的技能
   * 都在，`status` 也已从 `partial` 改成 `done`。
   *
   * 当时的状态（保留作背景）：`partial`——只做了**君主将的固定特性**（只作主将 / 不当野心家 /
   * 亮将双将同亮 / 与同势力全员珠联璧合 / 阵亡令同势力各失去 1 点体力），**牌自己的技能**没做：
   * 君主技「君威」与四件专属装备（飞龙夺凤 / 六龙骖驾 / 定澜夜明珠 / 盟军大纛）、
   * 以及各君主的常规技能。文本已核对到的一部分（WIKI，移动版）：
   *   君刘备 · 君威：出牌阶段，若场上没有【飞龙夺凤】，你可以弃置一张牌，从游戏外使用之。
   *                    当你死亡时，蜀势力角色各失去 1 点体力。
   *   君刘备 · 章武：一名角色的结束阶段，你可以视为使用 1 枚与你势力相同的角色本回合使用过的国战标记。
   *   君刘备 · 励众（锁定技）：每轮结束时，你令与你势力相同的角色中本轮造成过伤害且造成伤害值最多的
   *                    角色各获得 1 枚「先驱」标记。
   * 未做的原因：君威依赖「从游戏外获取并使用专属装备」这条新机制；章武依赖「国战标记的使用」；
   * 励众依赖「轮次」概念与伤害账本——都是独立的一块，等单独排期。
   */
  {
    id: 'juncaocao',
    name: '君曹操',
    faction: 'wei',
    pack: 'jun',
    // ⚠️ 曾长期停在 partial（君主将那一批当时只做了特性）：2026-09 逐条核对后确认
    //    君主特性 +【君威】+ 专属装备 + 牌自己的技能都已实现（见下面 note），改为 done。
    status: 'done',
    note: '君主特性 + 【君威】+ 专属装备【六龙骖驾】（♥K 宝物：你计算与其他角色的距离 -3；离开装备区即销毁）+ 【雄驰】（每回合第一次造成伤害后，可令受伤的角色对一名与你势力相同的角色造成 1 点虚拟伤害）+ 【征戎】（受到伤害后，可将一名角色的至多 X 张手牌替换为等量张【杀】，X＝你已损失的体力值且至少 1；换来的【杀】是从**牌堆**里找出的实体牌）三条都已实现——均按用户核对后提供的口径（君曹操就是这三条）。⚠️ 来源说明：本仓库最早按用户前一版资料做过【建安】（五子良将纛）与【挥鞭】，用户随后更正，已从武将上摘掉（实现留在 git 历史；引擎的「君主旗」机制保留未删、当前无武将挂载）。详见 docs/guozhan-roster.md §5.57。',
  },
  {
    id: 'junliubei',
    name: '君刘备',
    faction: 'shu',
    pack: 'jun',
    // ⚠️ 曾长期停在 partial（君主将那一批当时只做了特性）：2026-09 逐条核对后确认
    //    君主特性 +【君威】+ 专属装备 + 牌自己的技能都已实现（见下面 note），改为 done。
    status: 'done',
    note: '君主特性 + 【君威】 + 专属装备【飞龙夺凤】（「每回合首次用【杀】造成伤害后获得其一枚阴阳鱼标记或一张手牌」+「离开装备区即销毁」）+ 【章武】（一名角色的结束阶段，可视为使用 1 枚与你势力相同的角色本回合使用过的国战标记——本实现把三枚标记的效果抽成可复用函数，视为使用时不消耗标记；账本 GameState.markerUsesThisTurn 每回合清空）+ 【励众】（锁定技：每轮结束时给本轮造成伤害最多的同势力角色各 1 枚「先驱」；引擎在座次绕回首位时派发 roundEnd + 按轮清空的伤害台账）都已实现。【阴阳鱼】在弃牌阶段的那条用法（弃置 → 本回合手牌上限 +2）**已实现**（见 §5.66），账本两个阶段都记。详见 docs/guozhan-roster.md §5.62。',
  },
  {
    id: 'junsunquan',
    name: '君孙权',
    faction: 'wu',
    pack: 'jun',
    // ⚠️ 曾长期停在 partial（君主将那一批当时只做了特性）：2026-09 逐条核对后确认
    //    君主特性 +【君威】+ 专属装备 + 牌自己的技能都已实现（见下面 note），改为 done。
    status: 'done',
    note: '君主特性 + 【君威】+ 专属装备【定澜夜明珠】（锁定技：你每回合首次弃置牌后摸一张；离开装备区即销毁）+ 【督授】（与你势力相同的角色的出牌阶段限一次，可弃置至多两张牌令你摸等量牌）+ 【据江】（锁定技：吴不为大势力时，与你势力相同的角色指定你为目标的非伤害牌额外结算一次，装备牌/延时锦囊/势力锦囊除外）都已实现——均按用户核对后提供的口径。专属装备【定澜夜明珠】的牌面已核（**宝物·方块 K**）。【据江】排除的「势力锦囊牌」按用户核对后的官方定义＝《不臣篇》那四张（魏【号令天下】/蜀【克复中原】/吴【固国安邦】/群【文和乱武】），见 protocol 的 FACTION_TRICK_TYPES（那四张尚未实装，名单先登记）。另：技能里直接 toDiscard 的代价弃置（如【君威】）不算「弃置」，不会触发定澜夜明珠与礼让。详见 docs/guozhan-roster.md §5.61。',
  },
  {
    id: 'junyuanshao',
    name: '君袁绍',
    faction: 'qun',
    pack: 'jun',
    // ⚠️ 曾长期停在 partial（君主将那一批当时只做了特性）：2026-09 逐条核对后确认
    //    君主特性 +【君威】+ 专属装备 + 牌自己的技能都已实现（见下面 note），改为 done。
    status: 'done',
    note: '君主特性 + 【君威】+ 专属装备【盟军大纛】（受到伤害时弃两张牌防止此伤害，弃的其中一张可以是它自己；离开装备区即销毁）+ 【会盟】（锁定技：场上一个势力的角色数 0 ↔ 非0 时摸一张）+ 【授锋】（一名角色于其出牌阶段使用首张伤害牌结算结束后，交给其一张牌（目标是自己则跳过），然后从弃牌堆获得此伤害牌）都已实现——均按用户核对后提供的口径，并已用移动版 WIKI 复核技能文本。【盟军大纛】的牌面已核（**装备牌·防具，红桃 3**，占防具槽）。⚠️ 待核对：①【会盟】的「角色数」按明置算还是按武将牌本身的势力算（本实现取明置口径）；③【授锋】的「伤害牌」完整定义，以及「该牌已被别人拿走 / 本来就是虚拟牌」时的结算。详见 docs/guozhan-roster.md §5.60。⚠️ 群势力的君主在部分资料里写作「君张角」，本仓库以 biligame 的君威条目为准取「君袁绍」。',
  },
  ...STANDARD_WEI,
  ...STANDARD_SHU,
  ...STANDARD_WU,
  ...STANDARD_QUN,
  ...ZHEN,
  ...SHI,
  ...BIAN,
  ...QUAN,
  ...BUCHEN,
];

/** 名录规模与各状态计数（进度统计 / 图鉴筛选用） */
export function rosterStats(): Record<RosterStatus, number> & { total: number } {
  const out = { done: 0, partial: 0, todo: 0, verify: 0, total: GUOZHAN_ROSTER.length };
  for (const e of GUOZHAN_ROSTER) out[e.status]++;
  return out;
}

/**
 * 已实现的引擎原语。
 * 阶段 2 每做完一项就加到这里，pendingPrimitives() 会自动把它从待办里去掉。
 */
export const PRIMITIVES_DONE: PrimitiveId[] = [
  'hook_interaction',
  'pick_cards',
  'deck_top',
  'equip_lost',
  'judge_ownership',
  'phase_ask',
  'hand_emptied',
  'extra_turn',
  'limited_skill',
  'flip',
  'target_transfer',
  'faction_call',
  'pindian',
  'chained',
  'virtual_trick',
  'skill_nullify',
  'awaken_skill',
  'army_order',
  // 阶段 2.1「钩子内发起询问」已完成（GameState.resumeQueue + runHooksPausable + applyIntent 排空）。
  // 阶段 2.2「选牌原语」已完成（Pending.pickCards + askPickCards + 界面浮层 +
  //   PromptView.pickCards；第一个用户是观星，候选牌不在手牌里也要能选）。
  // 阶段 2.3 已完成：equip_lost 时机（枭姬）、判定牌归属 gainJudgeCard（天妒）、
  //   drawPhaseEnd 时机 + drawCountDelta/damageBonusThisTurn/dealtDamageBonus（裸衣）。
  // 阶段 2.4 已完成：hand_emptied 时机（连营）、extra_turns 队列（放权）、
  //   限定技（涅槃走 nearDeath 钩子 + usedOncePerGame）、翻面（flip，跳过下一个回合）。
  // 阶段 2.5 进行中：target_transfer 已完成（大乔·流离，走 api.redirectAttack + AttackBox）。
  //   faction_call 已完成：需要【闪】的场景（护驾：被杀指定/万箭齐发）与
  //   需要【杀】的场景（激将：决斗/南蛮/借刀/离间的响应）。
  //   virtual_trick 已完成（api.castVirtualTrick + startTrickResolution 抽取；袁绍·乱击）。
  //   skill_nullify 已完成：锁定技标记体系（ActiveSkill.locked / HookRegistration.locked /
  //   Hero.lockedFields）+ effectiveHeroes 屏蔽 + api.nullifyNonLockedSkills。
  //   注意：还没有武将在用 skill_nullify（新国战铁骑、左慈的文本都待核对）。
  //
  // maxhp_change：董卓·崩坏已接上（changeMaxHp + 崩坏伪武将），可以算了。
  'maxhp_change',
  'change_deputy', // 变更副将：残留武将牌堆 + 连亮到同势力 + 替换副将（马谡·制蛮）
  // remove_hero / slot_skills（第十批就做完了，一直漏登记）：移除武将牌
  //   （Player.removedHeroIds + effectiveHeroes 过滤 + api.removeHeroCard）与主将技/副将技
  //   （Hero.mainSlotSkills / deputySlotSkills + collectTimingHooks 过滤 + mainSlotHalfYang）。
  //   用户：董卓·暴凌、糜夫人、张任、孙策·魂殇、严白虎·寄篱、徐庶·举荐。
  'remove_hero',
  'slot_skills',
  // virtual_equip：虚拟装备。第一个用户是袁术·庸肆「若场上没有【玉玺】你视为装备着【玉玺】」
  //   （heroes.hasYuxi，两处消费方——摸牌阶段多摸一张、出牌阶段开始时视为使用【知己知彼】
  //   ——共用它）。更早的同类做法是卧龙诸葛亮·八阵的 hasBaguaAlways（只服务防具栏）。
  'virtual_equip',
  // remove_hero / slot_skills（第十批）：移除武将牌（Player.removedHeroIds +
  //   effectiveHeroes 过滤 + api.removeHeroCard）与主将技/副将技
  //   （Hero.mainSlotSkills/deputySlotSkills + collectTimingHooks 过滤 + mainSlotHalfYang）。
  //   第一个用户是董卓·暴凌（连带崩坏）。
  // 已转换（可挂起）的时机：afterDamage / afterDamageDealt / becomeTarget /
  //                          turnStart / judgePhase / drawPhase / playPhase / turnEnd
  // 尚未转换：nearDeath / beforeResolve / afterResolve / discardPhase / death
  //   （useCard 已转换：见 docs/guozhan-roster.md §5.34；afterUse 目前只在【调虎离山】那条路派发）
  //
  // 另外，上轮已具备的能力（不在这张待办表里的原语）：
  // 目标过滤（空城/谦逊/帷幕）、奇才距离、完杀、体力上限取整、
  // 国战标记（先驱/阴阳鱼/珠联璧合）、珠联璧合组合表、君主特性（4/6 项）。
];

/** 还差哪些原语没做（去重，供排期参考） */
export function pendingPrimitives(): PrimitiveId[] {
  const done = new Set<PrimitiveId>(PRIMITIVES_DONE);
  const need = new Set<PrimitiveId>();
  for (const e of GUOZHAN_ROSTER) {
    if (e.status === 'done') continue;
    for (const p of e.primitives ?? []) need.add(p);
  }
  return [...need].filter((p) => !done.has(p)).sort();
}
