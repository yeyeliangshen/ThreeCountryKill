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
export type HeroPack = 'standard' | 'zhen' | 'shi' | 'bian' | 'quan' | 'buchen';

export const PACK_NAME: Record<HeroPack, string> = {
  standard: '国战标准版',
  zhen: '君临天下·阵',
  shi: '君临天下·势',
  bian: '君临天下·变',
  quan: '君临天下·权',
  buchen: '不臣篇',
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
  | 'discard_ledger'; // 本回合进入弃牌堆的牌（再起）

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
  discard_ledger: '弃牌堆回合账本',
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
    note: '护驾走 faction_call（需要【闪】的两种场景：被【杀】指定、响应【万箭齐发】）。★ 暂带 isLord 标记，所以当前只能作主将。',
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
    note: '天妒自动收取（白拿牌严格优于不拿，等于最优出牌）。遗计按「每次伤害事件触发一次」（官方为逐点）。',
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
    note: '仁德（累计两张回血一次）+ 激将（faction_call 的【杀】场景：决斗/南蛮/借刀/离间的响应）。★ 暂带 isLord。',
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
    note: '观星已实现。简化：只能选「哪些沉底」，留在牌堆顶的保持原序，不做任意排序。',
  },
  { id: 'zhaoyun', name: '赵云', faction: 'shu', pack: 'standard', status: 'done' },
  { id: 'machao', name: '马超', faction: 'shu', pack: 'standard', status: 'done' },
  {
    id: 'huangyueying',
    name: '黄月英',
    faction: 'shu',
    pack: 'standard',
    status: 'done',
    note: '集智官方还有「若摸到基本牌可弃之再摸一张」，本实现取前半段（简化）。',
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
    note: '烈刃已实现（afterDamageDealt + pindian + transferCard）。巨象只做了「南蛮对你无效」那一半（immuneToNanman）。',
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
    status: 'todo',
    primitives: ['awaken_skill', 'pick_cards'],
  },
  {
    id: 'caohong',
    name: '曹洪',
    faction: 'wei',
    pack: 'zhen',
    status: 'done',
    primitives: ['hook_interaction'],
    note: '护援已实现（装备牌置入他人装备区 → 可弃其距离 1 的一名角色的一张牌）。鹤翼＝阵法技，需要队列系统，尚未实现。',
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
    primitives: ['hook_interaction'],
    note: '疑城已实现（2019 典藏版口径：由成为目标的角色自己决定摸一弃一）。鸟翔＝阵法技，需要围攻关系/队列系统，尚未实现。',
  },
  {
    id: 'jiangqin',
    name: '蒋钦',
    faction: 'wu',
    pack: 'zhen',
    status: 'done',
    primitives: ['pick_cards', 'hook_interaction'],
    note: '尚义已实现（新原语 api.privateView：私密查看手牌 / 暗置武将牌）。鸟翔＝阵法技（围攻关系），需要队列系统，尚未实现。',
  },
  {
    id: 'yuji',
    name: '于吉',
    faction: 'qun',
    pack: 'zhen',
    status: 'todo',
    primitives: ['hook_interaction'],
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
    status: 'todo',
    primitives: ['pick_cards'],
  },
  { id: 'zangba', name: '臧霸', faction: 'wei', pack: 'shi', status: 'todo' },
  { id: 'madai', name: '马岱', faction: 'shu', pack: 'shi', status: 'todo' },
  { id: 'mifuren', name: '糜夫人', faction: 'shu', pack: 'shi', status: 'todo' },
  {
    id: 'sunce',
    name: '孙策',
    faction: 'wu',
    pack: 'shi',
    status: 'todo',
    primitives: ['awaken_skill'],
  },
  {
    id: 'chenwu_dongxi',
    name: '陈武董袭',
    faction: 'wu',
    pack: 'shi',
    status: 'todo',
    primitives: ['chained'],
  },
  {
    id: 'dongzhuo',
    name: '董卓',
    faction: 'qun',
    pack: 'shi',
    status: 'todo',
    primitives: ['maxhp_change'],
  },
  { id: 'zhangren', name: '张任', faction: 'qun', pack: 'shi', status: 'todo' },
];

const BIAN: RosterEntry[] = [
  {
    id: 'xunyou',
    name: '荀攸',
    faction: 'wei',
    pack: 'bian',
    status: 'todo',
    primitives: ['virtual_trick'],
  },
  { id: 'bianfuren', name: '卞夫人', faction: 'wei', pack: 'bian', status: 'todo' },
  {
    id: 'masu',
    name: '马谡',
    faction: 'shu',
    pack: 'bian',
    status: 'todo',
    primitives: ['pick_cards'],
  },
  { id: 'shamoke', name: '沙摩柯', faction: 'shu', pack: 'bian', status: 'todo' },
  {
    id: 'lingtong',
    name: '凌统',
    faction: 'wu',
    pack: 'bian',
    status: 'todo',
    primitives: ['hook_interaction'],
  },
  {
    id: 'lvfan',
    name: '吕范',
    faction: 'wu',
    pack: 'bian',
    status: 'todo',
    primitives: ['pick_cards'],
  },
  {
    id: 'zuoci',
    name: '左慈',
    faction: 'qun',
    pack: 'bian',
    status: 'todo',
    primitives: ['skill_nullify'],
  },
  { id: 'lijue_guosi', name: '李傕郭汜', faction: 'qun', pack: 'bian', status: 'todo' },
];

const QUAN: RosterEntry[] = [
  {
    id: 'cuiyan_maojie',
    name: '崔琰毛玠',
    faction: 'wei',
    pack: 'quan',
    status: 'todo',
    primitives: ['pick_cards'],
  },
  {
    id: 'yujin',
    name: '于禁',
    faction: 'wei',
    pack: 'quan',
    status: 'todo',
    primitives: ['hook_interaction'],
  },
  {
    id: 'fazheng',
    name: '法正',
    faction: 'shu',
    pack: 'quan',
    status: 'todo',
    primitives: ['pick_cards'],
  },
  { id: 'wangping', name: '王平', faction: 'shu', pack: 'quan', status: 'todo' },
  {
    id: 'wuguotai',
    name: '吴国太',
    faction: 'wu',
    pack: 'quan',
    status: 'todo',
    primitives: ['pick_cards'],
  },
  { id: 'lukang', name: '陆抗', faction: 'wu', pack: 'quan', status: 'todo' },
  {
    id: 'yuanshu',
    name: '袁术',
    faction: 'qun',
    pack: 'quan',
    status: 'todo',
    primitives: ['maxhp_change'],
  },
  { id: 'zhangxiu', name: '张绣', faction: 'qun', pack: 'quan', status: 'todo' },
];

// ——————————————————————————————————————————
// 不臣篇（只收单势力的魏蜀吴群；双势力与野心家武将本次不做）
// ⚠️ 待澄清：下篇的单势力将名单尚未确认，只列入已确认的上篇四方。
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
  { id: 'xushu', name: '徐庶', faction: 'shu', pack: 'buchen', status: 'verify' },
  { id: 'wujing', name: '吴景', faction: 'wu', pack: 'buchen', status: 'verify' },
  { id: 'yanbaihu', name: '严白虎', faction: 'qun', pack: 'buchen', status: 'verify' },
];

export const GUOZHAN_ROSTER: RosterEntry[] = [
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
  // maxhp_change：**引擎侧就绪但没有武将验证**——SkillApi.changeMaxHp 已实现，
  //   等董卓·崩坏 / 袁术那批接上。所以它不在上面这份已完成的清单里。
  // 已转换（可挂起）的时机：afterDamage / afterDamageDealt / becomeTarget /
  //                          turnStart / judgePhase / drawPhase / playPhase / turnEnd
  // 尚未转换：useCard / nearDeath / beforeResolve / afterResolve / afterUse / discardPhase / death
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
