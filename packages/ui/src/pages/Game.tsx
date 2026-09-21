import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CARD_TYPE_NAME,
  MODE_NAME,
  SUIT_NAME,
  SUIT_SYMBOL,
  rankLabel,
  cardLabel,
  cardShortName,
  cardDescription,
  isRed,
  isBasicCard,
  isEquipCard,
  isInstantTrick,
  isWuxieLike,
  isDelayedTrick,
  isRecastable,
  type Card,
  type CardType,
  type DamageAttribute,
  type Faction,
  type GameMode,
  type PlayerView,
  type Snapshot,
} from '@sgs/protocol';
import {
  getHero,
  lordVariantOf,
  getHeroForMode,
  heroCanUseAs,
  ROLE_NAME,
  FACTION_NAME,
  MARKER_DESC,
  type Hero,
  type ActiveSkill,
} from '@sgs/engine';
import { EquipChip } from '../components/EquipChip';
import { HeroPanel, type HeroSlot } from '../components/HeroPanel';
import { HeroChips, heroChipsOf } from '../components/HeroChips';
import { SkillButtons, type SkillRow } from '../components/SkillButtons';
import { heroArt } from '../components/heroArt';
import { cardBack } from '../components/cardBack';
import { useHoverTip } from '../components/HoverTip';
import { effectConfirmFor, needsEffectConfirm } from '../components/effectConfirm';
import { nextGuozhanSlots } from '../draftSlots';
import { skillEntryShown } from '../skillPhase';
import { useStore } from '../store';

const PHASE_NAME: Record<string, string> = {
  prepare: '准备',
  judgment: '判定',
  draw: '摸牌',
  play: '出牌',
  discard: '弃牌',
  turnEnd: '回合结束',
  gameOver: '游戏结束',
  draft: '选将',
};

/** 把服务端 winner 字符串转成人类可读的胜方文案 */
function winnerText(mode: GameMode, winner: string, players: PlayerView[]): string {
  if (mode === 'junzheng') {
    if (winner === 'rebel') return '反贼胜利';
    if (winner === 'lord') return '主忠方胜利';
    if (winner === 'renegade') return '内奸胜利';
    return '游戏结束';
  }
  if (mode === '2v2') {
    if (winner === 'team0') return '队伍1胜利';
    if (winner === 'team1') return '队伍2胜利';
    return '游戏结束';
  }
  if (mode === 'guozhan') {
    const fname = FACTION_NAME[winner as Faction];
    return fname ? `${fname}势力胜利` : '游戏结束';
  }
  // melee：winner 是存活者 seatId
  const wp = players.find((p) => p.seatId === winner);
  return wp ? `${wp.name} 获胜` : '游戏结束';
}


/** 势力中文名（双势力武将牌显示两个势力，如「魏/蜀」） */

function factionLabel(h: { faction: Faction; secondFaction?: Faction }): string {

  const a = FACTION_NAME[h.faction] ?? h.faction;

  return h.secondFaction ? `${a}/${FACTION_NAME[h.secondFaction] ?? h.secondFaction}` : a;

}



/** 悬浮在武将牌上的说明：势力 + 体力 + 每条技能的**名称与效果** */

function heroTooltip(h: {

  name: string;

  faction: Faction;

  secondFaction?: Faction;

  maxHp: number;

  skills: { name: string; desc: string }[];

  isLord?: boolean;

}): string {

  const head = [

    `${h.name}${h.isLord ? '（君主将）' : ''}`,

    `势力：${factionLabel(h)}　体力：${h.maxHp}`,

  ];

  const skills =

    h.skills.length === 0

      ? ['（技能文本尚未核对，暂空）']

      : h.skills.map((s) => `【${s.name}】${s.desc}`);

  return [...head, '', ...skills].join('\n');

}


/**
 * 出牌阶段：这张牌需要选几个目标（区间，铁索连环是 1 至 2 名）。
 *
 * `shaMaxTargets` = 这张【杀】最多能指定几个目标，由 `shaMaxTargetsFor` 按
 * 【方天画戟】的**两个版本**算好（国战版任意名 / 军争版最后一张手牌时最多 3 名）。
 */
function targetRange(
  card: Card,
  as?: CardType,
  shaMaxTargets?: number,
): { min: number; max: number; self: boolean } {
  // 转化牌按转化后的类型算需要几个目标（大乔·国色：方块牌当【乐不思蜀】要 1 个目标）
  const type = as ?? card.type;
  const effective: Card = type === card.type ? card : { ...card, type };
  if (type === 'tiesuo') return { min: 1, max: 2, self: true };
  // 调虎离山：一至两名**其他**角色（不能选自己）
  if (type === 'tiaohu') return { min: 1, max: 2, self: false };
  if (isEquipCard(effective)) return { min: 0, max: 0, self: false };
  if (type === 'tao' || type === 'jiu') return { min: 0, max: 0, self: false };
  if (type === 'wuzhong' || type === 'taoyuan') return { min: 0, max: 0, self: false };
  if (type === 'shandian') return { min: 0, max: 0, self: false };
  if (type === 'nanman' || type === 'wanjian') return { min: 0, max: 0, self: false };
  if (type === 'yiyi' || type === 'wugu') return { min: 0, max: 0, self: false };
  if (type === 'jiedao') return { min: 2, max: 2, self: false };
  // 敕令：目标是规则算出来的（所有没有势力的角色），不用点
  if (type === 'chiling') return { min: 0, max: 0, self: false };
  // 联军盛宴：点一个代表角色 = 选一个「其他势力」
  if (type === 'lianjun') return { min: 1, max: 1, self: false };
  if (type === 'sha' && (shaMaxTargets ?? 1) > 1) {
    return { min: 1, max: shaMaxTargets!, self: false };
  }
  return { min: 1, max: 1, self: false }; // sha, juedou, guohe, shunshou, huogong, lebu, bingliang, yuanjiao, zhibi
}

/** 这张牌能否在出牌阶段直接使用（无需转化） */
function isDirectlyPlayable(card: Card): boolean {
  if (card.type === 'sha' || card.type === 'tao' || card.type === 'jiu') return true;
  if (isEquipCard(card)) return true;
  if (isDelayedTrick(card)) return true;
  // 无懈可击（含国战版）只能在响应时打出，出牌阶段点不动
  if (isInstantTrick(card) && !isWuxieLike(card)) return true;
  return false;
}

/** 从快照获取当前玩家的活跃武将（国战：已亮将；其他：主将） */
function getMyActiveHeroes(me: PlayerView, mode: GameMode): Hero[] {
  const isGuozhan = mode === 'guozhan';
  if (isGuozhan) {
    const heroes: Hero[] = [];
    // 被【断肠】点名的武将牌：牌还在、势力性别也在，但**技能全没了**，界面别再列它
    const nullified = me.nullifiedHeroId ?? null;
    if (me.heroRevealed && me.heroId && me.heroId !== nullified) {
      const h = getHeroForMode(me.heroId, mode);
      if (h) heroes.push(h);
    }
    if (me.deputyRevealed && me.deputyHeroId && me.deputyHeroId !== nullified) {
      const h = getHeroForMode(me.deputyHeroId, mode);
      if (h) heroes.push(h);
    }
    return heroes;
  }
  // 非国战也必须按模式取：同一个武将国战/军争的技能不一样
  const h = getHeroForMode(me.heroId, mode);
  return h ? [h] : [];
}

/** 国战鏖战状态：仅 2 个非野心家阵营存活 */
function isAoyuMode(snapshot: Snapshot): boolean {
  if (snapshot.mode !== 'guozhan') return false;
  const alive = snapshot.players.filter((p) => p.isAlive);
  const factions = new Set(
    alive.map((p) => p.faction).filter((f): f is Faction => !!f && f !== 'ambitionist'),
  );
  return factions.size === 2;
}

/** 转化技可能出现的所有目标类型，顺序即优先级 */
const CONVERSION_TYPES: CardType[] = [
  'sha',
  'guohe',
  'tao',
  'shan',
  'lebu',
  'bingliang',
  'huogong',
  'tiesuo',
];

/** 能靠转化技把别的牌变成可重铸牌型的技能目标（庞统·连环 →【铁索连环】） */
const RECAST_VIA_TYPES: CardType[] = ['tiesuo', 'zhibi'];

/** 一种用法：`as` 为空表示「按牌面本身使用」 */
interface CardUse {
  as?: CardType;
  /** 转化后的伤害属性（朱雀羽扇：普通【杀】当火【杀】） */
  asAttribute?: DamageAttribute;
  /** 重铸：不指定目标，把牌弃掉再摸一张（不是「使用」） */
  recast?: boolean;
  /** 连横（势备篇）：把手牌交给一名势力不同或未确定势力的角色 */
  lianheng?: boolean;
  /** 【丈八蛇矛】：这张牌当【杀】的**第一张**，还要再点一张手牌凑成两张 */
  zhangba?: boolean;
  label: string;
}

/**
 * 列出这张牌在出牌阶段有哪几种用法。
 *
 * 以前这里只返回**一个**转化类型，而且**牌面能直接用就不给转化**——
 * 于是徐晃拿黑色【杀】时没法选择「当兵粮寸断用」（甘宁·奇袭、大乔·国色同样受影响）。
 * 现在把「牌面本身」和各种转化都列出来，多于一种时由玩家选。
 */
function cardUses(
  card: Card,
  heroes: Hero[],
  aoyu: boolean,
  hasZhuque: boolean,
  lianhengTargets: string[],
  zhangbaOk: boolean,
  shuangxiongColor: 'red' | 'black' | null,
): CardUse[] {
  const uses: CardUse[] = [];
  if (isDirectlyPlayable(card)) {
    uses.push({ label: `按【${cardShortName(card)}】使用` });
  }
  for (const type of CONVERSION_TYPES) {
    if (heroes.some((h) => heroCanUseAs(h, card, type))) {
      uses.push({ as: type, label: `当【${CARD_TYPE_NAME[type]}】使用` });
    }
  }
  if (aoyu && card.type === 'tao' && !uses.some((u) => u.as === 'sha')) {
    uses.push({ as: 'sha', label: '当【杀】使用（鏖战）' });
  }
  // 连横（势备篇）：带标记的手牌可以交出去——「交给谁」的合法性由服务端算好
  if (card.lianheng && lianhengTargets.length > 0) {
    uses.push({ lianheng: true, label: '连横（交给一名势力不同或未确定势力的角色）' });
  }
  // 朱雀羽扇：普通【杀】可以当火【杀】使用（同一张牌换属性，不是换牌型）
  if (hasZhuque && card.type === 'sha' && !card.attribute) {
    uses.push({ asAttribute: 'fire', label: '当火【杀】使用（朱雀羽扇）' });
  }
  // 颜良文丑·双雄：本回合可以把与判定牌**颜色不同**的手牌当【决斗】使用
  if (shuangxiongColor && (isRed(card) ? 'red' : 'black') !== shuangxiongColor) {
    uses.push({ as: 'juedou', label: '当【决斗】使用（双雄）' });
  }
  // 【丈八蛇矛】：两张手牌当【杀】。这里只是「第一张」，点完还要再选一张
  if (zhangbaOk && !uses.some((u) => u.zhangba)) {
    uses.push({ zhangba: true, label: '两张手牌当【杀】使用（丈八蛇矛）' });
  }
  // 可重铸的牌（铁索连环 / 知己知彼）多一条「重铸」用法；
  // 庞统·连环那种「梅花牌当【铁索连环】使用**或重铸**」也要给这一条
  if (
    isRecastable(card) ||
    RECAST_VIA_TYPES.some((t) => card.type !== t && heroes.some((h) => heroCanUseAs(h, card, t)))
  ) {
    uses.push({ recast: true, label: '重铸（弃置此牌，摸一张）' });
  }
  return uses;
}

/** 从武将列表中查找技能定义 */
function findSkill(heroes: Hero[], skillId: string): ActiveSkill | undefined {
  for (const h of heroes) {
    const sk = h.activeSkills?.find((s) => s.id === skillId);
    if (sk) return sk;
  }
  return undefined;
}

export function Game() {
  const snapshot = useStore((s) => s.snapshot);
  const sendIntent = useStore((s) => s.sendIntent);
  const pickHero = useStore((s) => s.pickHero);
  const pickHeroes = useStore((s) => s.pickHeroes);
  const revealHero = useStore((s) => s.revealHero);
  const useSkill = useStore((s) => s.useSkill);
  const chooseOption = useStore((s) => s.chooseOption);
  const sendPickCards = useStore((s) => s.pickCards);
  const sendFactionCall = useStore((s) => s.factionCall);
  const leaveRoom = useStore((s) => s.leaveRoom);

  // 出牌阶段：选中一张需目标的牌后，再选目标
  const [selected, setSelected] = useState<{
    cardId: string;
    as?: CardType;
    /** 转化后的伤害属性（朱雀羽扇） */
    asAttribute?: DamageAttribute;
    /** 至少/至多几个目标（铁索连环是 1–2 名，所以是个区间） */
    min: number;
    max: number;
    /** 是否允许把自己选成目标（铁索连环） */
    self: boolean;
    picked: string[];
    /** 【丈八蛇矛】：与 cardId 一起当【杀】的第二张手牌 */
    extraCardIds?: string[];
  } | null>(null);
  // 弃牌阶段：已选待弃的牌
  const [picks, setPicks] = useState<string[]>([]);
  // 「这张牌要怎么用」的选择（牌有直接用法 + 转化用法时弹出来）
  const [usePick, setUsePick] = useState<{ cardId: string; uses: CardUse[] } | null>(null);
  // 连横模式：已选好要交出去的牌，等点目标
  const [lianhengCard, setLianhengCard] = useState<string | null>(null);
  // 连横选中的目标（选中不等于发出：也要点一下确认）
  const [lianhengPick, setLianhengPick] = useState<string | null>(null);
  /**
   * 【丈八蛇矛】模式：正在挑「两张手牌」。
   *
   * `mode` 决定凑齐两张之后干什么：
   * - 'use' ：接着走 `selected` 选目标，当【杀】使用；
   * - 'respond'：直接作为本次响应打出去（南蛮/决斗/借刀/离间/势力技代打）。
   */
  const [zhangbaMode, setZhangbaMode] = useState<{
    picked: string[];
    mode: 'use' | 'respond';
  } | null>(null);
  // 「从一组牌里选」的已选牌（选中但未确认，防误触）
  const [pickSel, setPickSel] = useState<string[]>([]);
  // 选将阶段：已选中但未确认的武将（防误触）
  const [pickedHero, setPickedHero] = useState<string | null>(null);
  // 国战选将：主将 + 副将
  const [mainPick, setMainPick] = useState<string | null>(null);
  /**
   * 国战选将：每个发到的格子显示哪一版（君主将 / 标准版）。
   *
   * 官方国战里君主将「替换」同名标准武将登场——但你发到的是随机的，所以线上通行做法是
   * 「发到了标准版就等于也拿到了君主版」。这里就是那个开关：键＝发到的原 id、值＝当前显示
   * 的版本（缺省就是原 id）。引擎那边由 heroes.ts 的 LORD_VARIANTS 放行（pickHero 校验）。
   */
  const [heroSwap, setHeroSwap] = useState<Record<string, string>>({});
  const shownHeroId = (dealtId: string) => heroSwap[dealtId] ?? dealtId;
  /**
   * 换一局（服务器重新发将）时把上一局的选将状态清掉。
   *
   * 结束一局后回到房间再开一局，这个组件可能**不会卸载**（screen 一直是 'game'），
   * 于是上一局的 mainPick / deputyPick / 换版本记录会带到新一局的选将里——那时玩家会看到
   * 上一局选的人已经亮着，甚至会带着上一局的「换成君主将」。发到的将变了就是新的一局，
   * 这里以「发将列表」为界清零（同一局里这个键是稳定的）。
   */
  const draftPrompt = snapshot?.prompt;
  const draftKey =
    draftPrompt?.kind === 'pickHero' ? (draftPrompt.legalHeroIds ?? []).join(',') : '';
  useEffect(() => {
    setMainPick(null);
    setDeputyPick(null);
    setHeroSwap({});
  }, [draftKey]);
  /** 在这个格子上换成另一版（君主 ↔ 标准），已选中的话跟着换 */
  function swapHeroVersion(dealtId: string) {
    const cur = shownHeroId(dealtId);
    const next = lordVariantOf(cur);
    if (!next) return;
    setHeroSwap((prev) => ({ ...prev, [dealtId]: next }));
    if (mainPick === cur) setMainPick(next);
    if (deputyPick === cur) setDeputyPick(next);
  }
  const [deputyPick, setDeputyPick] = useState<string | null>(null);
  // 主动技能交互模式
  const [skillMode, setSkillMode] = useState<{
    skillId: string;
    /**
     * 技能定义。武将技能直接给 `ActiveSkill`（本地有对象、maxCards 是函数）；
     * **标记技能**（阴阳鱼/先驱/珠联璧合/野心家）不属于任何武将，用服务端在提示里
     * 下发的形状（见 protocol 的 `legalSkills`）——`maxCards` 缺省即可（这几枚都不吃牌）。
     */
    skill: {
      id: string;
      name: string;
      desc?: string;
      needsCards?: boolean;
      minTargets: number;
      maxTargets: number;
      maxCards?: ActiveSkill['maxCards'];
    };
    cardIds: string[];
    targetIds: string[];
  } | null>(null);
  /**
   * 「生效前的确认」（用户 2026-09-18 要求）：**主动发起的效果**——【杀】【酒】、装装备、武将技能——
   * 真正发出去之前先摆一句「它到底干什么」，确认了才发。
   *
   * 为什么要它：这几类点一下就生效，而牌面说明平时只有**悬停**才看得到（触屏上根本没有悬停）；
   * 装装备尤其疼（点错就把装备丢进装备区、还顶掉原来那件）。
   */
  /** 多选座位（`pickSeats` 提示）：点亮了几家，确认时才发出去 */
  const [seatPick, setSeatPick] = useState<string[]>([]);
  const [confirmUse, setConfirmUse] = useState<{
    title: string;
    desc: string;
    ok: () => void;
  } | null>(null);
  // 手牌悬停提示（固定定位，避免被 .hand 的滚动容器裁切）。
  // 武将技能用的是同一套，见 components/HoverTip.tsx
  const { bind: bindTip, hide: hideTip, tipNode } = useHoverTip();

  // 提示内容一变就清空本地选择。
  //
  // 依赖不能直接用 snapshot.prompt —— 每次快照都是新对象，而服务端会因为
  // 别人的动作反复下发快照。用对象引用当依赖会导致「我正在选将，对手一动，
  // 我的选择就被清空」。所以这里把提示的**内容**压成一个字符串当 key：
  // 提问没变就不清空，真正换了问题才清空。
  const promptKey = useMemo(() => {
    const p = snapshot?.prompt;
    if (!p) return 'none';
    // 候选牌也要进 key：换了一批牌就是换了问题（选牌原语的候选可能不在手牌里，
    // 单看 kind/message 分辨不出来）
    const pickIds = p.pickCards?.map((c) => c.id).join(',') ?? '';
    const viewIds = p.viewCards?.map((c) => c.id).join(',') ?? '';
    return `${p.kind}|${p.message}|${p.legalCardIds.join(',')}|${p.legalTargetIds.join(',')}|${pickIds}|${viewIds}`;
  }, [snapshot?.prompt]);
  useEffect(() => {
    setSelected(null);
    setPicks([]);
    setPickSel([]);
    setUsePick(null);
    setLianhengCard(null);
    setPickedHero(null);
    setMainPick(null);
    setDeputyPick(null);
    setSkillMode(null);
    setZhangbaMode(null);
  }, [promptKey]);

  // 出牌记录：新事件滚到底，否则最新一条可能在可视区外
  const logBoxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const box = logBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [snapshot?.log]);

  // 多选座位的提示换了一轮（候选变了）→ 清空上一轮点亮的。
  //
  // ⚠️ **这个 hook 必须放在下面那条 `if (!snapshot) return …` 之前**——那是一条**提前 return**：
  //    「已开局但快照还没到」时会先渲染一帧「加载中…」（重连 / 刷新 / 手机切屏回来必经这一帧），
  //    随后快照到达再渲染一次。hook 要是排在那条 return 后面，第二帧就会**多调用一个 hook** →
  //    React 抛 "Rendered more hooks than during the previous render" → 整棵树被卸载 →
  //    界面全空。在深色底（body #070a0d）上就是用户看到的**黑屏**（2026-09-21 实测复现）。
  const seatPickKey =
    snapshot?.prompt?.kind === 'pickSeats'
      ? (snapshot.prompt.seatCandidates ?? []).join(',') + '|' + snapshot.prompt.pickMax
      : '';
  useEffect(() => {
    setSeatPick([]);
  }, [seatPickKey]);

  if (!snapshot) return <div className="game loading">加载中…</div>;

  const me = snapshot.players.find((p) => p.seatId === snapshot.seatId)!;
  // 技能说明要按模式取：国战与军争的同名技能描述不同
  const myHero = getHeroForMode(me.heroId, snapshot.mode);
  const myDeputyHero = getHeroForMode(me.deputyHeroId, snapshot.mode);
  const others = snapshot.players.filter((p) => p.seatId !== snapshot.seatId);
  const prompt = snapshot.prompt;
  const legalSet = new Set(prompt?.legalCardIds ?? []);
  const targetSet = new Set(prompt?.legalTargetIds ?? []);
  const myTurn = snapshot.turn.seatId === snapshot.seatId;
  const isGameOver = snapshot.turn.phase === 'gameOver' && snapshot.winner !== null;
  const isGuozhan = snapshot.mode === 'guozhan';
  const aoyu = isAoyuMode(snapshot);
  const myHeroes = getMyActiveHeroes(me, snapshot.mode);
  // ⚠️ **出牌阶段与弃牌阶段都要读**：国战标记技能不属于任何武将，只能靠服务端下发的
  // `legalSkillIds` / `legalSkills` 补出来；而【阴阳鱼】在弃牌阶段是「弃置 → 手牌上限 +2」
  // 这一支（引擎的 `buildDiscardPrompt` 会把这几个标记一起下发）。以前这里写死
  // `kind === 'play'`，于是**弃牌阶段那几枚标记按钮根本不渲染**（用户报的「点了没用」里
  // 最典型的一种）——详见 docs §5.177。
  const skillIds = skillEntryShown(prompt?.kind) ? (prompt!.legalSkillIds ?? []) : [];
  // 【木牛流马】下扣置的牌「如手牌般使用或打出」，所以自己的可用牌 = 手牌 + 辎。
  // 对手的那一份快照里只有 `cargoCount`（扣置是暗信息），拿到的 cargo 是空的。
  // 【丈八蛇矛】：这一轮能不能「两张手牌当【杀】」完全由服务端算（zhangbaOk）
  const zhangbaOk = prompt?.zhangbaOk === true;
  const muniuCargo = me.equipment.find((c) => c.equipName === 'muniu')?.cargo ?? [];
  const myUsableCards = [...snapshot.myHand, ...muniuCargo];
  const cargoIds = new Set(muniuCargo.map((c) => c.id));

  /**
   * 这张【杀】最多能指定几个目标——【方天画戟】**两个版本两套规则**，与引擎的
   * `fangtianRule` 一一对应：
   * - 国战版（势备篇）：任意名势力各不相同的角色 → 上限放到 99，点满后按「确认目标」发出去；
   * - 军争版：只有这张【杀】是**你最后的手牌**时，才可以额外指定至多两个（共 3 名）。
   *
   * 「最后的手牌」只数真手牌——木牛流马扣置的牌不算（它只是「如手牌般使用」）。
   */
  function shaMaxTargetsFor(card: Card): number {
    if (!me.equipment.some((c) => c.equipName === 'fangtian')) return 1;
    if (snapshot!.mode === 'guozhan') return 99;
    const isLastHandCard = !cargoIds.has(card.id) && snapshot!.myHand.length === 1;
    return isLastHandCard ? 3 : 1;
  }

  // 连横的合法目标由服务端下发（与具体哪张牌无关）
  const lianhengTargets = prompt?.kind === 'play' ? (prompt.lianhengTargets ?? []) : [];
  const lianhengSet = new Set(lianhengTargets);

  /** 已经选定用法、开始出这张牌：要目标就进选择模式，不要就直接发 */
  function beginPlay(card: Card, as?: CardType, asAttribute?: DamageAttribute) {
    const range = targetRange(card, as, shaMaxTargetsFor(card));
    if (range.max === 0) {
      const fire = (): void => {
        sendIntent({
          type: 'playCard',
          cardId: card.id,
          ...(as ? { as } : {}),
          ...(asAttribute ? { asAttribute } : {}),
          targetIds: [],
        });
      };
      // 【酒】/装装备这类「不需要目标」的牌原先点一下就发——现在先生效前确认（§5.144）
      if (needsEffectConfirm(card, as)) {
        const info = effectConfirmFor(card, as, snapshot?.mode);
        setConfirmUse({ title: info.title, desc: info.desc, ok: () => { setConfirmUse(null); fire(); } });
        return;
      }
      fire();
      return;
    }
    setSelected({
      cardId: card.id,
      ...(as ? { as } : {}),
      ...(asAttribute ? { asAttribute } : {}),
      min: range.min,
      max: range.max,
      self: range.self,
      picked: [],
    });
  }

  /** 重铸：把可重铸的牌置入弃牌堆再摸一张（不是「使用」） */
  function beginRecast(card: Card) {
    sendIntent({ type: 'recast', cardId: card.id });
  }

  /** 【丈八蛇矛】：开始挑两张手牌（第一张就是刚才点的那张） */
  function beginZhangba(card: Card, mode: 'use' | 'respond' = 'use') {
    setZhangbaMode({ picked: [card.id], mode });
  }

  /** 丈八模式下点手牌：选满两张就收手 */
  function toggleZhangbaCard(cardId: string) {
    if (!zhangbaMode) return;
    const has = zhangbaMode.picked.includes(cardId);
    if (has) {
      setZhangbaMode({ ...zhangbaMode, picked: zhangbaMode.picked.filter((x) => x !== cardId) });
      return;
    }
    if (zhangbaMode.picked.length >= 2) return;
    setZhangbaMode({ ...zhangbaMode, picked: [...zhangbaMode.picked, cardId] });
  }

  /** 丈八：两张凑齐了，按模式继续（使用 → 选目标；响应 → 直接打出） */
  function confirmZhangba() {
    if (!zhangbaMode || zhangbaMode.picked.length !== 2) return;
    const [first, second] = zhangbaMode.picked;
    if (zhangbaMode.mode === 'respond') {
      sendIntent({ type: 'respondCard', cardId: first!, extraCardIds: [second!] });
      setZhangbaMode(null);
      return;
    }
    // 当【杀】使用 → 复用现有的选目标流程。
    // 目标是**一名**角色：丈八蛇矛与方天画戟都是武器，不可能同时装备，
    // 所以这里不存在「方天画戟那种多目标」的情况。
    setSelected({
      cardId: first!,
      extraCardIds: [second!],
      min: 1,
      max: 1,
      self: false,
      picked: [],
    });
    setZhangbaMode(null);
  }

  // —— 出牌：这张牌有几种用法就先让玩家挑 ——
  function pickPlayCard(card: Card) {
    if (!prompt || prompt.kind !== 'play' || !legalSet.has(card.id)) return;
    const hasZhuque = me.equipment.some((c) => c.equipName === 'zhuque');
    const uses = cardUses(
      card,
      myHeroes,
      aoyu,
      hasZhuque,
      lianhengTargets,
      zhangbaOk,
      me.shuangxiongColor ?? null,
    );
    if (uses.length === 0) return;
    if (uses.length === 1) {
      const only = uses[0]!;
      if (only.recast) beginRecast(card);
      else if (only.zhangba) beginZhangba(card);
      else beginPlay(card, only.as);
      return;
    }
    // 多种用法（例如徐晃的黑色【杀】：既能出杀，也能当兵粮寸断）→ 弹选项
    setUsePick({ cardId: card.id, uses });
  }

  /**
   * 点目标：**只选中，不发出**——选完还要点「确认使用」。
   *
   * 以前单目标牌是「点谁就打谁」，误点一下头像就出去了（【杀】/【顺手牵羊】这种最要命）；
   * 现在统一成「选中 → 确认」两步，已选中的再点一下＝取消该目标。
   */
  function pickTarget(targetId: string) {
    if (!selected) return;
    if (selected.picked.includes(targetId)) {
      setSelected({ ...selected, picked: selected.picked.filter((t) => t !== targetId) });
      return;
    }
    if (selected.picked.length >= selected.max) return;
    setSelected({ ...selected, picked: [...selected.picked, targetId] });
  }

  /** 选中的目标够不够（够就可以点确认了） */
  function selectedCanConfirm(): boolean {
    if (!selected) return false;
    return selected.picked.length >= selected.min && selected.picked.length <= selected.max;
  }

  /** 确认按钮文案：把「对谁用什么」写清楚，免得又误点 */
  function selectedConfirmLabel(): string {
    if (!selected) return '确认使用';
    const card = myUsableCards.find((c) => c.id === selected.cardId);
    const name = selected.as ? CARD_TYPE_NAME[selected.as] : card ? cardShortName(card) : '这张牌';
    const who = selected.picked
      .map((id) => snapshot?.players.find((p) => p.seatId === id)?.name ?? id)
      .join('、');
    return `确认：对 ${who} 使用【${name}】`;
  }

  /**
   * 「选完目标、点确认之前」把效果写出来（用户 2026-09-18 要求）。
   * 只有【杀】【酒】、装装备这几类显示——其余牌维持在目标上就够清楚了，不打扰。
   */
  function selectedEffectDesc(): string {
    if (!selected) return '';
    const card = myUsableCards.find((c) => c.id === selected.cardId);
    if (!card || !needsEffectConfirm(card, selected.as)) return '';
    return effectConfirmFor(card, selected.as, snapshot?.mode).desc;
  }

  /** 铁索连环这类「一至两名」的牌：攒够了就把目标发出去 */
  function confirmTargets() {
    if (!selected) return;
    if (selected.picked.length < selected.min || selected.picked.length > selected.max) return;
    sendIntent({
      type: 'playCard',
      cardId: selected.cardId,
      ...(selected.as ? { as: selected.as } : {}),
      ...(selected.asAttribute ? { asAttribute: selected.asAttribute } : {}),
      ...(selected.extraCardIds ? { extraCardIds: selected.extraCardIds } : {}),
      targetIds: selected.picked,
    });
    setSelected(null);
  }

  // —— 响应杀/濒死/锦囊/无懈：直接出牌（引擎自动检测转化） ——
  function pickRespondCard(card: Card) {
    if (!prompt || !legalSet.has(card.id)) return;
    sendIntent({ type: 'respondCard', cardId: card.id });
  }

  // —— 弃牌 ——
  function togglePick(cardId: string) {
    if (!prompt || prompt.kind !== 'discard') return;
    setPicks((prev) =>
      prev.includes(cardId)
        ? prev.filter((c) => c !== cardId)
        : prev.length < prompt.mustSelectTargetCount
          ? [...prev, cardId]
          : prev,
    );
  }
  function confirmDiscard() {
    if (picks.length !== prompt?.mustSelectTargetCount) return;
    sendIntent({ type: 'discard', cardIds: picks });
  }

  // —— 从一组牌里选（观星看牌堆顶、刚烈弃两张、仁德送牌…）——
  function togglePickCard(cardId: string) {
    if (prompt?.kind !== 'pickCards') return;
    const max = prompt.pickMax ?? 0;
    setPickSel((prev) =>
      prev.includes(cardId)
        ? prev.filter((c) => c !== cardId)
        : prev.length < max
          ? [...prev, cardId]
          : prev,
    );
  }
  function confirmPickCards() {
    if (prompt?.kind !== 'pickCards') return;
    const min = prompt.pickMin ?? 0;
    const max = prompt.pickMax ?? 0;
    if (pickSel.length < min || pickSel.length > max) return;
    sendPickCards(pickSel);
  }

  // —— 主动技能交互 ——
  function enterSkillMode(skillId: string) {
    // 先找**自己武将**的主动技；找不到就用**服务端下发**的那份定义。
    //
    // ⚠️ 这一步是「阴阳鱼按钮点不动」的修复（用户 2026-09-21）：标记技能不属于任何武将，
    //    findSkill(myHeroes, …) 必然查不到 —— 以前这里直接 `return`，于是按钮点了毫无反应
    //    （连「不可用」的提示都没有）。
    const heroSkill = findSkill(myHeroes, skillId);
    const given = (prompt?.legalSkills ?? []).find((x) => x.id === skillId);
    if (!heroSkill && !given) return;
    setSkillMode({
      skillId,
      skill: heroSkill ?? {
        id: skillId,
        name: given!.name,
        desc: given!.desc,
        needsCards: given!.needsCards,
        minTargets: given!.minTargets,
        maxTargets: given!.maxTargets,
      },
      cardIds: [],
      targetIds: [],
    });
  }
  function toggleSkillCard(cardId: string) {
    if (!skillMode) return;
    setSkillMode((prev) => {
      if (!prev) return prev;
      const has = prev.cardIds.includes(cardId);
      // 上限由技能自己给（国战·制衡 = 体力上限，苦肉/离间/反间 = 1），
      // 不在客户端按技能 id 硬编码——否则两边各写一套上限迟早对不上
      const maxCards = prev.skill.maxCards?.({ maxHp: me.maxHp, handCount: me.handCount }) ?? 99;
      if (has) return { ...prev, cardIds: prev.cardIds.filter((c) => c !== cardId) };
      if (prev.cardIds.length >= maxCards) return prev;
      return { ...prev, cardIds: [...prev.cardIds, cardId] };
    });
  }
  function toggleSkillTarget(targetId: string) {
    if (!skillMode) return;
    setSkillMode((prev) => {
      if (!prev) return prev;
      const has = prev.targetIds.includes(targetId);
      const { minTargets, maxTargets } = prev.skill;
      if (has) return { ...prev, targetIds: prev.targetIds.filter((t) => t !== targetId) };
      if (prev.targetIds.length >= maxTargets) return prev;
      return { ...prev, targetIds: [...prev.targetIds, targetId] };
    });
  }
  function confirmSkill() {
    if (!skillMode) return;
    const { skillId, cardIds, targetIds } = skillMode;
    useSkill(skillId, cardIds, targetIds);
    setSkillMode(null);
  }

  // —— 国战选将：点击武将分配主将/副将槽位 ——
  // 槽位怎么变是纯函数（`nextGuozhanSlots`，单测在 draftSlots.test.ts）——判定必须与引擎的
  // `pickHero` 同口径（`canPairHeroes`），否则「界面拼不出来、引擎却收」的组合会再出现。
  function pickGuozhanHero(id: string) {
    const next = nextGuozhanSlots({ main: mainPick, deputy: deputyPick }, id, (hid) => getHero(hid));
    setMainPick(next.main);
    setDeputyPick(next.deputy);
  }

  // 判定当前选中牌的目标提示文案
  function selectedHint(): string {
    if (!selected) return '';
    const names = selected.picked
      .map((id) => snapshot?.players.find((p) => p.seatId === id)?.name ?? id)
      .join('、');
    // 目标够了：把「对谁用」摆出来，并提示还要点一下确认（点目标不再直接出牌）
    if (selected.picked.length >= selected.min) {
      if (selected.min === 2) {
        return `已选：${names}（第 1 个是武器持有者、第 2 个是出杀目标）——点「确认」发出`;
      }
      return `目标：${names} —— 点「确认」发出`;
    }
    if (selected.min === 2) {
      if (selected.picked.length === 0) return '请选择武器持有者';
      return '请选择出杀目标';
    }
    if (selected.max > 1) {
      return `请选择 1 至 2 名目标（${selected.self ? '可含自己' : '不含自己'}），已选 ${selected.picked.length} 名`;
    }
    return '请选择目标（点上方对手，选完再点确认）';
  }

  // 技能确认按钮是否可用
  function skillCanConfirm(): boolean {
    if (!skillMode) return false;
    const { skill, cardIds, targetIds } = skillMode;
    const cardsOk = !skill.needsCards || cardIds.length >= 1;
    const targetsOk = targetIds.length >= skill.minTargets && targetIds.length <= skill.maxTargets;
    return cardsOk && targetsOk;
  }

  // 选将阶段：聚焦选将面板，不渲染空牌桌 / 0 体力条
  if (snapshot.turn.phase === 'draft') {
    /**
     * ⚠️ 选将阶段**也会挂询问**：双势力组合要在此时**由玩家选势力**（引擎给一条 `choice`）。
     * 这里以前不管 prompt 直接渲染选将面板 —— 那条询问就永远点不到，玩家确认完武将后
     * 界面一直停在选将页（实测卡死）。所以先把「非选将的询问」摆在最上面，答完再回选将列表。
     */
    if (prompt && prompt.kind !== 'pickHero') {
      return (
        <div className="draft">
          <div className="draft-title">选将阶段 · 询问</div>
          <div className={`prompt prompt-${prompt.kind}`}>
            <div className="prompt-msg">{prompt.message}</div>
            {prompt.kind === 'choice' &&
              prompt.choiceOptions?.map((o) => (
                <button key={o.id} className="primary" onClick={() => chooseOption(o.id)}>
                  {o.label}
                </button>
              ))}
          </div>
        </div>
      );
    }
    const options = prompt?.kind === 'pickHero' ? (prompt.legalHeroIds ?? []) : [];
    // 「君主↔标准版」里白捡的那些（没人拿走才在列表里，见 protocol 的 draftVariants）
    const variants = prompt?.kind === 'pickHero' ? (prompt.draftVariants ?? []) : [];
    const canSwapTo = (targetId: string) => options.includes(targetId) || variants.includes(targetId);
    const guozhanCanConfirm = !!mainPick && !!deputyPick && mainPick !== deputyPick;

    if (isGuozhan) {
      return (
        <div className="draft">
          <div className="draft-title">选将阶段 · 国战</div>
          {options.length > 0 ? (
            <>
              <div className="hero-list">
                {options.map((dealtId) => {
                  const id = shownHeroId(dealtId);
                  const h = getHero(id);
                  if (!h) return null;
                  const isMain = mainPick === id;
                  const isDeputy = deputyPick === id;
                  const variantId = lordVariantOf(id);
                  const variant = variantId && canSwapTo(variantId) ? getHero(variantId) : undefined;
                  // 君主将只能作主将：这张牌正选在副将位、要换成君主版时是不合法的组合，
                  // 与其让玩家确认时被引擎拒掉，不如直接禁用并说明怎么换
                  const swapBlocked = isDeputy && !!variant?.isLord;
                  const art = heroArt(id);
                  return (
                    <div key={dealtId} className="hero-cell">
                      <button
                        className={`hero-card faction-${h.faction} ${isMain || isDeputy ? 'picked' : ''}`}
                        title={heroTooltip(h)}
                        onClick={() => pickGuozhanHero(id)}
                      >
                        {/* 原画（没有对应文件的武将自动不显示这一格，见 heroArt.ts） */}
                        {art && <img className="hero-card-art" src={art} alt="" />}
                        <div className="hero-card-body">
                          <div className="hero-name">{h.name}</div>
                          <div className="hero-meta">
                            <span className={`hero-faction faction-${h.faction}`}>
                              {factionLabel(h)}
                            </span>
                            <span className="hero-hp">体力 {h.maxHp}</span>
                          </div>
                          <div className="hero-skills">
                            {h.skills.map((sk) => (
                              <div key={sk.name}>
                                <b>{sk.name}</b>
                              </div>
                            ))}
                          </div>
                        </div>
                        {isMain && <div className="hero-slot-tag">主将</div>}
                        {isDeputy && <div className="hero-slot-tag">副将</div>}
                      </button>
                      {variant && (
                        <button
                          className="hero-swap"
                          disabled={swapBlocked}
                          onClick={() => swapHeroVersion(dealtId)}
                          title={
                            swapBlocked
                              ? '君主将只能作主将：先把它选到主将位再换'
                              : `换成 ${variant.name}`
                          }
                        >
                          {variant.isLord ? '👑 换成君主将' : '换成标准版'}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              <button
                className="primary big"
                disabled={!guozhanCanConfirm}
                onClick={() => {
                  if (mainPick && deputyPick) pickHeroes(mainPick, deputyPick);
                }}
              >
                {guozhanCanConfirm
                  ? `确认：${getHero(mainPick)?.name ?? ''} + ${getHero(deputyPick)?.name ?? ''}`
                  : '请选择 2 位同阵营武将'}
              </button>
            </>
          ) : (
            <div className="hint">已选将，等待其他玩家…</div>
          )}
        </div>
      );
    }

    // 非国战：单选将
    return (
      <div className="draft">
        <div className="draft-title">选将阶段</div>
        {options.length > 0 ? (
          <>
            <div className="hero-list">
              {options.map((id) => {
                const h = getHero(id);
                if (!h) return null;
                const isPicked = pickedHero === id;
                const art = heroArt(id);
                return (
                  <button
                    key={id}
                    className={`hero-card ${isPicked ? 'picked' : ''}`}
                    title={heroTooltip(h)}
                    onClick={() => setPickedHero(id)}
                  >
                    {art && <img className="hero-card-art" src={art} alt="" />}
                    <div className="hero-card-body">
                      <div className="hero-name">
                        {h.name}
                        {h.id === 'vanilla' && <small>（白板）</small>}
                      </div>
                      <div className="hero-meta">
                        <span className={`hero-faction faction-${h.faction}`}>
                          {factionLabel(h)}
                        </span>
                        <span className="hero-hp">体力 {h.maxHp}</span>
                      </div>
                      <div className="hero-skills">
                        {h.skills.map((sk) => (
                          <div key={sk.name}>
                            <b>{sk.name}</b>
                          </div>
                        ))}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
            <button
              className="primary big"
              disabled={!pickedHero}
              onClick={() => pickedHero && pickHero(pickedHero)}
            >
              {pickedHero ? `确认选择 ${getHero(pickedHero)?.name ?? ''}` : '请选择武将'}
            </button>
          </>
        ) : (
          <div className="hint">已选将，等待其他玩家…</div>
        )}
      </div>
    );
  }

  // 游戏结束：显示胜方覆盖层
  if (isGameOver) {
    return (
      <div className="game game-over-screen">
        <div className="game-over-banner">
          <div className="game-over-title">
            {winnerText(snapshot.mode, snapshot.winner!, snapshot.players)}
          </div>
          <div className="hint">游戏结束</div>
          {/* 打完了才允许离开房间：服务端对局中会拒绝释放座位（座位留着等人重连） */}
          <button className="ghost" onClick={leaveRoom}>
            离开房间
          </button>
        </div>
        <div className="players-row">
          {snapshot.players.map((p) => {
            const hero = getHero(p.heroId);
            const factionClass = isGuozhan && p.faction ? `faction-${p.faction}` : '';
            return (
              <div
                key={p.seatId}
                className={`player ${!p.isAlive ? 'dead' : ''} team-${p.team ?? 0} ${factionClass}`}
              >
                <div className="p-name">
                  {p.name}
                  {snapshot.mode === 'junzheng' && p.role && (
                    <span className={`role-badge role-${p.role}`}>{ROLE_NAME[p.role]}</span>
                  )}
                  {isGuozhan && p.faction && (
                    <span className={`faction-badge ${p.faction}`}>{FACTION_NAME[p.faction]}</span>
                  )}
                </div>
                <div className="p-hero">
                  {isGuozhan
                    ? `${hero?.name ?? '?'} / ${getHero(p.deputyHeroId)?.name ?? '?'}`
                    : (hero?.name ?? '?')}
                </div>
                <div className="p-hp">
                  {Array.from({ length: p.maxHp }).map((_, i) => (
                    <span key={i} className={`hp-cell ${i < p.hp ? 'on' : ''}`} />
                  ))}
                </div>
                {!p.isAlive && <div className="p-dead">阵亡</div>}
              </div>
            );
          })}
        </div>
        <div className="log">
          {snapshot.log.slice(-10).map((l, i) => (
            <div key={i} className={`log-line log-${l.kind}`}>
              {l.message}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // 是否处于"选目标"或"技能模式"的交互态
  const targeting = !!selected || !!skillMode || !!lianhengCard || !!zhangbaMode;

  // 判断某对手是否可被点击（选目标 / 技能选目标）
  function canClickTarget(p: PlayerView): boolean {
    // 多选座位：候选里那几家可点（再点一下取消）；选满 max 之后只能取消、不能继续加
    if (prompt?.kind === 'pickSeats') {
      if (!(prompt.seatCandidates ?? []).includes(p.seatId)) return false;
      if (seatPick.includes(p.seatId)) return true;
      return seatPick.length < (prompt.pickMax ?? 99);
    }
    if (!p.isAlive) return false;
    if (lianhengCard) return lianhengSet.has(p.seatId);
    if (!targeting) return false;
    if (skillMode) {
      if (skillMode.targetIds.includes(p.seatId)) return true;
      return targetSet.has(p.seatId) && skillMode.targetIds.length < skillMode.skill.maxTargets;
    }
    if (selected) {
      if (selected.picked.includes(p.seatId)) return true;
      return targetSet.has(p.seatId) && selected.picked.length < selected.max;
    }
    return false;
  }

  function handleTargetClick(p: PlayerView) {
    if (prompt?.kind === 'pickSeats') {
      setSeatPick((prev) =>
        prev.includes(p.seatId) ? prev.filter((x) => x !== p.seatId) : [...prev, p.seatId],
      );
      return;
    }
    if (lianhengCard) {
      // 只选中（同一个再点一下＝取消）；发出交给「确认连横」
      setLianhengPick((prev) => (prev === p.seatId ? null : p.seatId));
      return;
    }
    if (skillMode) {
      toggleSkillTarget(p.seatId);
      return;
    }
    if (selected) {
      if (selected.picked.includes(p.seatId)) return; // 已选
      pickTarget(p.seatId);
    }
  }

  // —— 武将面板：原画 + 体力勾玉 + 技能名 ——
  // 亮将：只有**准备阶段开始时**能主动明置（引擎的判定阶段＝准备阶段+判定阶段），
  // 其余时机想明置只能靠发动技能。所以按钮默认只在准备阶段露出来；
  // 例外是武将牌自己写着「出牌阶段，你可明置此武将牌」的（小乔·红颜、邹氏·祸水），
  // 那两条按**张**判——只有写了这句话的那张牌能在出牌阶段亮。
  const phase = snapshot.turn.phase;
  const canRevealSlot = (hero: typeof myHero): boolean =>
    myTurn &&
    !skillMode &&
    !selected &&
    // 主动明置只在**准备阶段**（判定阶段是另一个阶段了，不能亮）
    (phase === 'prepare' || (phase === 'play' && hero?.canRevealInPlayPhase === true));
  const canRevealNow = canRevealSlot(myHero);
  // 铁索连环可以把「自己」选成目标：这时自己的武将面板整体可点
  const canPickSelf =
    !!selected &&
    !lianhengCard &&
    selected.self &&
    prompt?.kind === 'play' &&
    !selected.picked.includes(me.seatId) &&
    selected.picked.length < selected.max;
  const heroSlots: HeroSlot[] = isGuozhan
    ? [
        {
          heroId: me.heroId,
          name: myHero?.name ?? '?',
          faction: myHero?.faction ?? null,
          hidden: !me.heroRevealed,
          slotLabel: '主将',
          onReveal:
            canRevealSlot(myHero) && !me.heroRevealed && me.heroId
              ? () => revealHero(me.heroId!)
              : undefined,
        },
        {
          heroId: me.deputyHeroId,
          name: myDeputyHero?.name ?? '?',
          faction: myDeputyHero?.faction ?? null,
          hidden: !me.deputyRevealed,
          slotLabel: '副将',
          onReveal:
            canRevealSlot(myDeputyHero) && !me.deputyRevealed && me.deputyHeroId
              ? () => revealHero(me.deputyHeroId!)
              : undefined,
        },
      ]
    : [
        {
          heroId: me.heroId,
          name: myHero?.name ?? '?',
          faction: myHero?.faction ?? null,
          hidden: false,
          slotLabel: null,
        },
      ];

  // 列出国战主副将的全部技能，主动技能在可用时可点发动。
  //
  // 国战暗置的武将牌：技能不生效，但界面要给出**预亮**入口——
  // - 触发技：点一下预亮/取消预亮，等它自己的时机到来时引擎会问是否发动；
  // - 主动技：点一下就等于「明置该武将并发动」（引擎会先明置）；
  // - 锁定技 / 转化技（马术、咆哮、武圣…）：只能靠亮将，这里显示成不可点。
  // 「哪些技能可预亮」由服务端下发（prompt.prelitableSkills），界面不自己判断。
  // 出牌阶段 / 弃牌阶段的服务端技能定义（含不属于任何武将的**国战标记**，见上面 skillIds 的注释）
  const legalSkills = skillEntryShown(prompt?.kind) ? (prompt!.legalSkills ?? []) : [];
  // 可预亮的名单在快照上（随时可预亮，不必等自己的出牌阶段）
  const prelitable = new Set(me.prelitableSkills ?? []);
  const prelit = new Set(me.prelitSkills ?? []);
  const skillRows: SkillRow[] = [];
  const coveredSkillIds = new Set<string>();
  for (const hero of isGuozhan ? [myHero, myDeputyHero] : [myHero]) {
    if (!hero) continue;
    const hidden = isGuozhan && !(hero.id === me.heroId ? me.heroRevealed : me.deputyRevealed);
    for (const s of hero.skills) {
      const act = hero.activeSkills?.find((a) => a.name === s.name);
      if (act) coveredSkillIds.add(act.id);
      const active = !!act && skillMode?.skillId === act.id;
      if (hidden && prelitable.has(s.name)) {
        // 可预亮的触发技
        const on = prelit.has(s.name);
        skillRows.push({
          name: s.name,
          desc: s.desc,
          usable: true,
          active: on,
          state: on ? 'prelit' : 'dark',
          onClick: () => sendIntent({ type: 'prelightSkill', skillName: s.name }),
        });
        continue;
      }
      skillRows.push({
        name: s.name,
        desc: s.desc,
        usable: !!act && skillIds.includes(act.id) && !selected && (!skillMode || active),
        active,
        // 暗置但可以点（主动技点了就明置发动）
        state: hidden ? 'dark' : undefined,
        onClick: () => {
          if (!act) return;
          if (active) setSkillMode(null);
          else enterSkillMode(act.id);
        },
      });
    }
  }
  // 标记技能不属于任何武将，只能靠服务端下发的 legalSkills 补出来
  for (const s of legalSkills) {
    if (coveredSkillIds.has(s.id)) continue;
    const active = skillMode?.skillId === s.id;
    skillRows.push({
      name: s.name,
      desc: s.desc,
      usable: !selected && (!skillMode || active),
      active,
      onClick: () => {
        if (active) setSkillMode(null);
        else enterSkillMode(s.id);
      },
    });
  }

  return (
    <div className="game">
      {/* 左栏：牌桌（对手 / 操作 / 手牌）。窄屏时这层容器消失，直接排单列 */}
      <div className="board">
        {/* 其他玩家 */}
        <div className="players-row">
          {others.map((p) => {
            const isTarget = canClickTarget(p);
            const isPickedTarget =
              (prompt?.kind === 'pickSeats' && seatPick.includes(p.seatId)) ||
              (targeting &&
                (selected?.picked.includes(p.seatId) ||
                  skillMode?.targetIds.includes(p.seatId) ||
                  lianhengPick === p.seatId));
            const isCurrent = snapshot.turn.seatId === p.seatId;
            const isLord = p.role === 'lord';
            const teamClass = snapshot.mode === '2v2' ? `team-${p.team ?? 0}` : '';
            const factionClass = isGuozhan && p.faction ? `faction-${p.faction}` : '';
            return (
              <button
                key={p.seatId}
                className={`player ${isCurrent ? 'current' : ''} ${!p.isAlive ? 'dead' : ''} ${isTarget ? 'targetable' : ''} ${isPickedTarget ? 'picked-target' : ''} ${teamClass} ${factionClass}`}
                onClick={isTarget ? () => handleTargetClick(p) : undefined}
                disabled={!isTarget}
              >
                <div className="p-top">
                  {/* 武将小卡：国战画**两张**（主将 / 副将），暗置那张只显示「暗」；
                      悬浮（手机长按）能看到明置武将的技能名与效果——用户 2026-09-21 要求 */}
                  <HeroChips chips={heroChipsOf(p, snapshot.mode)} />
                  <span className="p-info">
                    <span className="p-name">
                      {p.name}
                      {isCurrent && <span className="dot">●</span>}
                      {isLord && p.isAlive && <span className="lord-tag">主</span>}
                      {!p.isAlive && p.role && snapshot.mode === 'junzheng' && (
                        <span className={`role-badge role-${p.role}`}>{ROLE_NAME[p.role]}</span>
                      )}
                      {isGuozhan && p.faction && (
                        <span className={`faction-badge ${p.faction}`}>
                          {FACTION_NAME[p.faction]}
                        </span>
                      )}
                    </span>
                    <span className="p-hp">
                      {Array.from({ length: p.maxHp }).map((_, i) => (
                        <span key={i} className={`hp-cell ${i < p.hp ? 'on' : ''}`} />
                      ))}
                    </span>
                    <span className="p-hand">手 {p.handCount}</span>
                  </span>
                </div>
                {/* 装备区（花色 + 点数 + 牌名，与自己的面板同一个组件） */}
                {p.equipment.length > 0 && (
                  <div className="p-equip">
                    {p.equipment.map((c) => (
                      <EquipChip key={c.id} card={c} mode={snapshot.mode} bind={bindTip} />
                    ))}
                  </div>
                )}
                {/* 国战标记（公开信息，用户 2026-09-21 要求）：看得到对手手上还有哪些标记 */}
                {p.markers && p.markers.length > 0 && (
                  <div className="p-markers">
                    {p.markers.map((m) => (
                      <span
                        key={m.id}
                        className={`marker-chip mark-${m.id}`}
                        {...bindTip(
                          `【${m.label}】${m.count > 1 ? ` ×${m.count}` : ''}`,
                          MARKER_DESC[m.id] ?? '',
                        )}
                      >
                        {m.label}
                        {m.count > 1 && <span className="marker-count">{m.count}</span>}
                      </span>
                    ))}
                  </div>
                )}
                {/* 判定区 */}
                {p.judgment.length > 0 && (
                  <div className="p-judge">
                    {p.judgment.map((c) => (
                      <span
                        key={c.id}
                        className="judge-icon"
                        {...bindTip(cardShortName(c), cardDescription(c, snapshot.mode))}
                      >
                        {cardShortName(c)}
                      </span>
                    ))}
                  </div>
                )}
                {!p.isAlive && <div className="p-dead">阵亡</div>}
              </button>
            );
          })}
        </div>

        {/* 操作区 + 手牌绑成一块（.dock）：窄屏时整块吸附在屏幕底部，
            按钮与自己的牌永远在眼前；宽屏时靠 CSS 把它压到牌桌底部 */}
        <div className="dock">
          {/* 提示/操作区 */}
          {prompt ? (
            <div className={`prompt prompt-${prompt.kind}`}>
              <div className="prompt-msg">{prompt.message}</div>

              {/* 势力技（护驾/激将）：需要打出一张牌时，可以令同势力角色代打。
              它跨越 respondSha / respondTrick 两种提示，所以放在这里统一渲染 */}
              {prompt.factionCall && (
                <button
                  className="primary"
                  onClick={() => sendFactionCall(prompt.factionCall!.skillId)}
                >
                  发动【{prompt.factionCall.skillName}】（请{' '}
                  {prompt.factionCall.helpers.map((h) => h.name).join('、')} 代打
                  {CARD_TYPE_NAME[prompt.factionCall.needType]}）
                </button>
              )}

              {/* 多选座位（怀异那类「至多 X 名角色」）：点面板点亮，确认才发出去 */}
              {prompt.kind === 'pickSeats' && (
                <>
                  <span className="hint">
                    {prompt.pickTitle}（已选 {seatPick.length}
                    {prompt.pickMax !== undefined ? ` / 至多 ${prompt.pickMax}` : ''}）
                  </span>
                  <span className="use-effect-desc">
                    点上面的角色面板选择；再点一下取消
                    {prompt.pickMin ? `（至少选 ${prompt.pickMin} 名）` : '（可以一个都不选）'}
                  </span>
                  <button
                    className="primary"
                    disabled={seatPick.length < (prompt.pickMin ?? 0)}
                    onClick={() => {
                      sendIntent({ type: 'pickSeats', seatIds: seatPick });
                      setSeatPick([]);
                    }}
                  >
                    确认选择
                  </button>
                </>
              )}

              {/* 通用「选择一项」：技能令你二选一（反间/铁骑/除疠…）。
                  ⚠️ 选目标区域里的牌时，手牌那几个选项是 `hand:<第几张>`（引擎的「目标区域选牌」
                  原语，docs §5.149）——它们是**暗牌**，只给牌背样式，牌名/花色一律不显示。 */}
              {prompt.kind === 'choice' && (
                <>
                  {prompt.choiceOptions?.map((o) =>
                    o.id.startsWith('hand:') ? (
                      // 暗牌：只画**卡背**，不给牌名/花色/点数（规格第九条）
                      <button
                        key={o.id}
                        className="card-back-option"
                        title="对方的一张手牌（看不到牌面）"
                        onClick={() => chooseOption(o.id)}
                      >
                        {cardBack ? (
                          <img className="card-back-img" src={cardBack} alt="牌背" />
                        ) : (
                          '🂠'
                        )}
                      </button>
                    ) : (
                      <button key={o.id} className="primary" onClick={() => chooseOption(o.id)}>
                        {o.label}
                      </button>
                    ),
                  )}
                </>
              )}

              {/* 从一组牌里选若干张（观星看牌堆顶、刚烈弃两张、仁德送牌…）。
              候选牌不一定在手牌里，所以这里单独铺一行牌面，不复用手牌区 */}
              {prompt.kind === 'pickCards' && prompt.pickCards && (
                <div className="pick-cards">
                  <div className="pick-cards-row">
                    {prompt.pickCards.map((card) => {
                      const on = pickSel.includes(card.id);
                      // 选牌是**有序**的（诸葛亮·观星要按点击顺序摆牌堆），所以给选中的牌标个序号
                      const order = pickSel.indexOf(card.id) + 1;
                      const name = cardShortName(card);
                      const catClass = isEquipCard(card)
                        ? 'cat-equip'
                        : isDelayedTrick(card)
                          ? 'cat-delayed'
                          : isInstantTrick(card)
                            ? 'cat-trick'
                            : 'cat-basic';
                      return (
                        <button
                          key={card.id}
                          className={`card ${isRed(card) ? 'red' : 'black'} legal ${on ? 'picked' : ''} ${catClass}`}
                          aria-label={cardLabel(card)}
                          onMouseEnter={
                            bindTip(
                              `${SUIT_NAME[card.suit]}${rankLabel(card.rank)} · ${name}`,
                              cardDescription(card, snapshot.mode),
                            ).onMouseEnter
                          }
                          onMouseLeave={hideTip}
                          onClick={() => togglePickCard(card.id)}
                        >
                          <span className="c-idx">
                            <span className="c-rank">{rankLabel(card.rank)}</span>
                            <span className="c-suit">{SUIT_SYMBOL[card.suit]}</span>
                          </span>
                          <span className="c-name">
                            <span className={name.length >= 5 ? 'long' : undefined}>{name}</span>
                          </span>
                          {on && prompt.pickMax !== 1 && (
                            <span className="c-order" title="点击顺序">
                              {order}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  <button
                    className="primary"
                    aria-disabled={
                      pickSel.length < (prompt.pickMin ?? 0) ||
                      pickSel.length > (prompt.pickMax ?? 0)
                    }
                    onClick={confirmPickCards}
                  >
                    确定（已选 {pickSel.length} / {prompt.pickMin}
                    {prompt.pickMin === prompt.pickMax ? '' : `-${prompt.pickMax}`} 张）
                  </button>
                </div>
              )}

              {/* 私密查看（知己知彼）：内容只下发给本人，看完确认 */}
              {prompt.kind === 'viewCards' && (
                <div className="prompt-choice view-cards">
                  <div className="view-title">{prompt.viewTitle}</div>
                  {prompt.viewNote && <div className="view-note">{prompt.viewNote}</div>}
                  {prompt.viewCards && prompt.viewCards.length > 0 && (
                    <div className="pick-cards-row">
                      {prompt.viewCards.map((card) => {
                        const name = cardShortName(card);
                        return (
                          <span
                            key={card.id}
                            className={`card ${isRed(card) ? 'red' : 'black'} readonly`}
                            title={`${SUIT_NAME[card.suit]}${rankLabel(card.rank)} · ${name}\n${cardDescription(card, snapshot.mode)}`}
                          >
                            <span className="c-idx">
                              <span className="c-rank">{rankLabel(card.rank)}</span>
                              <span className="c-suit">{SUIT_SYMBOL[card.suit]}</span>
                            </span>
                            <span className="c-name">
                              <span className={name.length >= 5 ? 'long' : undefined}>{name}</span>
                            </span>
                          </span>
                        );
                      })}
                    </div>
                  )}
                  <button className="primary" onClick={() => sendIntent({ type: 'ack' })}>
                    确认
                  </button>
                </div>
              )}

              {/* 这张牌有多种用法（直接使用 + 转化 + 重铸）：先让玩家挑一种 */}
              {prompt.kind === 'play' && usePick && (
                <div className="use-pick">
                  <span className="hint">这张牌怎么用？</span>
                  {usePick.uses.map((u, i) => (
                    <button
                      key={
                        u.recast
                          ? 'recast'
                          : u.zhangba
                            ? 'zhangba'
                            : u.lianheng
                              ? 'lianheng'
                              : (u.as ?? `self-${i}`)
                      }
                      className="primary"
                      onClick={() => {
                        const card = myUsableCards.find((c) => c.id === usePick.cardId);
                        setUsePick(null);
                        if (!card) return;
                        if (u.recast) beginRecast(card);
                        else if (u.zhangba) beginZhangba(card);
                        else beginPlay(card, u.as);
                      }}
                    >
                      {u.label}
                    </button>
                  ))}
                  <button className="ghost" onClick={() => setUsePick(null)}>
                    取消
                  </button>
                </div>
              )}

              {/* 出牌阶段：结束出牌（主动技能在武将面板里发动） */}
              {prompt.kind === 'play' && !skillMode && !selected && !confirmUse && (
                <>
                  <button className="ghost" onClick={() => sendIntent({ type: 'endPhase' })}>
                    结束出牌
                  </button>
                </>
              )}

              {/* 技能交互模式。⚠️ 弃牌阶段也要渲染：【阴阳鱼】在那儿是「弃置 → 手牌上限 +2」
                  那一支（引擎的 useSkill 对 `alsoUsableInDiscardPhase` 的技能放行弃牌阶段），
                  只判 'play' 的话点了没反应——见 docs §5.177 */}
              {skillEntryShown(prompt.kind) && skillMode && (
                <div className="skill-mode">
                  <span className="hint">
                    <b>【{skillMode.skill.name}】</b>
                    {/* 把「要选几张、已经选了几张」写全：只说「请选择手牌」看不出选上没有 */}
                    {skillMode.skill.needsCards &&
                      ` 手牌 ${skillMode.cardIds.length} 张${
                        skillMode.skill.maxCards
                          ? ` / 至多 ${skillMode.skill.maxCards({ maxHp: me.maxHp, handCount: me.handCount })}`
                          : ''
                      }`}
                    {skillMode.skill.maxTargets > 0 &&
                      ` · 目标 ${skillMode.targetIds.length} / ${
                        skillMode.skill.maxTargets >= 99 ? '不限' : skillMode.skill.maxTargets
                      }`}
                    {skillMode.skill.needsCards && skillMode.cardIds.length === 0 && ' · 请点手牌'}
                    {skillMode.skill.minTargets > 0 &&
                      skillMode.targetIds.length < skillMode.skill.minTargets &&
                      ' · 请点角色'}
                  </span>
                  {skillMode.skill.desc && (
                    <span className="use-effect-desc">{skillMode.skill.desc}</span>
                  )}
                  <button className="primary" disabled={!skillCanConfirm()} onClick={confirmSkill}>
                    确认技能
                  </button>
                  <button className="ghost" onClick={() => setSkillMode(null)}>
                    取消
                  </button>
                </div>
              )}

              {/* 【丈八蛇矛】：正在挑两张手牌 */}
              {zhangbaMode && (
                <>
                  <span className="hint">
                    【丈八蛇矛】：点两张手牌当【杀】
                    {zhangbaMode.mode === 'respond' ? '打出' : '使用'}（已选{' '}
                    {zhangbaMode.picked.length}/2）
                  </span>
                  <button
                    className="primary"
                    disabled={zhangbaMode.picked.length !== 2}
                    onClick={confirmZhangba}
                  >
                    确认
                  </button>
                  <button className="ghost" onClick={() => setZhangbaMode(null)}>
                    取消
                  </button>
                </>
              )}

              {/* 连横：已选好牌，等点目标 */}
              {lianhengCard && prompt.kind === 'play' && (
                <span className="hint">连横：点一名对手把手牌交给他（势力不同的会摸一张牌）</span>
              )}
              {lianhengCard && prompt.kind === 'play' && (
                <>
                  <span className="hint">
                    连横：点一名同势力角色
                    {lianhengPick
                      ? `（已选 ${snapshot?.players.find((p) => p.seatId === lianhengPick)?.name ?? '?'}）`
                      : ''}
                    —— 点「确认」把牌交给他
                  </span>
                  <button
                    className="primary"
                    disabled={!lianhengPick}
                    onClick={() => {
                      if (!lianhengPick) return;
                      sendIntent({
                        type: 'lianheng',
                        cardId: lianhengCard,
                        targetSeatId: lianhengPick,
                      });
                      setLianhengCard(null);
                      setLianhengPick(null);
                    }}
                  >
                    确认连横
                  </button>
                  <button
                    className="ghost"
                    onClick={() => {
                      setLianhengCard(null);
                      setLianhengPick(null);
                    }}
                  >
                    取消连横
                  </button>
                </>
              )}

              {/* 生效前的确认：主动发起的效果先说明再发（【杀】【酒】/装装备，见 effectConfirm.ts） */}
              {confirmUse && prompt.kind === 'play' && (
                <div className="use-confirm">
                  <div className="use-confirm-title">{confirmUse.title}</div>
                  <div className="use-confirm-desc">{confirmUse.desc}</div>
                  <div className="use-confirm-actions">
                    <button className="primary" onClick={confirmUse.ok}>
                      确认使用
                    </button>
                    <button className="ghost" onClick={() => setConfirmUse(null)}>
                      取消
                    </button>
                  </div>
                </div>
              )}

              {/* 选目标提示 */}
              {selected && prompt.kind === 'play' && (
                <>
                  <span className="hint">{selectedHint()}</span>
                  {selectedEffectDesc() && (
                    <span className="use-effect-desc">{selectedEffectDesc()}</span>
                  )}
                  <button
                    className="primary"
                    disabled={!selectedCanConfirm()}
                    onClick={confirmTargets}
                  >
                    {selectedConfirmLabel()}
                  </button>
                  <button className="ghost" onClick={() => setSelected(null)}>
                    取消
                  </button>
                </>
              )}

              {/* 诸葛恪·【傲才】：回合外被要求出基本牌时，用牌堆顶两张里的实体牌满足这次响应。
                  这里只按「将面是不是诸葛恪」显示；回合内点了会被引擎拒（提示【傲才】只能在回合外）。 */}
              {(prompt.kind === 'respondSha' ||
                prompt.kind === 'respondDeath' ||
                prompt.kind === 'respondTrick') &&
                (me.heroId === 'zhugeke' || me.deputyHeroId === 'zhugeke') && (
                  <button className="ghost" onClick={() => sendIntent({ type: 'aocai' })}>
                    【傲才】看牌堆顶两张
                  </button>
                )}
              {/* 弃权按钮（响应类提示） */}
              {prompt.kind === 'respondSha' && (
                <button className="ghost" onClick={() => sendIntent({ type: 'pass' })}>
                  弃权（不出闪）
                </button>
              )}
              {prompt.kind === 'respondDeath' && (
                <button className="ghost" onClick={() => sendIntent({ type: 'pass' })}>
                  弃权（不救）
                </button>
              )}
              {prompt.kind === 'respondTrick' && (
                <button className="ghost" onClick={() => sendIntent({ type: 'pass' })}>
                  弃权
                </button>
              )}
              {prompt.kind === 'wuxieQueue' && (
                <button className="ghost" onClick={() => sendIntent({ type: 'pass' })}>
                  不使用
                </button>
              )}
              {/* 响应里需要【杀】时，装备着丈八蛇矛可以拿两张手牌顶一张 */}
              {prompt.zhangbaOk && prompt.kind !== 'play' && !zhangbaMode && (
                <button
                  className="ghost"
                  onClick={() => setZhangbaMode({ picked: [], mode: 'respond' })}
                >
                  丈八蛇矛：两张手牌当【杀】
                </button>
              )}
              {prompt.kind === 'discard' && (
                <button
                  className="primary"
                  disabled={picks.length !== prompt.mustSelectTargetCount}
                  onClick={confirmDiscard}
                >
                  弃牌（{picks.length}/{prompt.mustSelectTargetCount}）
                </button>
              )}
            </div>
          ) : (
            <div className="prompt prompt-wait">{myTurn ? '…' : '等待其他玩家行动…'}</div>
          )}

          {/* 我的手牌 + 木牛流马下扣置的牌（后者标一个「辎」角标） */}
          <div className="hand">
            {myUsableCards.map((card) => {
              const isCargo = cargoIds.has(card.id);
              const legal = legalSet.has(card.id);
              const isPick =
                (prompt?.kind === 'discard' && picks.includes(card.id)) ||
                (prompt?.kind === 'play' && selected?.cardId === card.id) ||
                !!zhangbaMode?.picked.includes(card.id);
              const isSkillCard = !!skillMode && skillMode.cardIds.includes(card.id);
              // 技能模式要选牌时整手牌都是候选——不能沿用「不合法就变灰」的样式，
              // 否则可选的牌看起来全是用不了的（这是「选中技能后看不清」的主要来源）
              const dimmed = skillMode?.skill.needsCards ? false : !legal;
              const fireClass = card.type === 'sha' && card.attribute === 'fire' ? 'fire-attr' : '';
              const thunderClass =
                card.type === 'sha' && card.attribute === 'thunder' ? 'thunder-attr' : '';
              // 牌面底部的分类色条：基本牌 / 锦囊 / 延时锦囊 / 装备
              const catClass = isEquipCard(card)
                ? 'cat-equip'
                : isDelayedTrick(card)
                  ? 'cat-delayed'
                  : isInstantTrick(card)
                    ? 'cat-trick'
                    : 'cat-basic';
              const name = cardShortName(card);
              // 技能模式下需要选手牌 → 全手牌可点
              const skillCardClickable = !!skillMode && skillMode.skill.needsCards;
              // 丈八模式：整手牌都可点（任意两张都能凑成【杀】）
              const cardDisabled = zhangbaMode ? false : skillMode ? !skillCardClickable : !legal;
              return (
                <button
                  key={card.id}
                  className={`card ${isRed(card) ? 'red' : 'black'} ${dimmed ? 'dim' : 'legal'} ${isPick ? 'picked' : ''} ${isSkillCard ? 'picked' : ''} ${fireClass} ${thunderClass} ${catClass} ${isCargo ? 'cargo' : ''}`}
                  aria-disabled={cardDisabled}
                  aria-label={cardLabel(card)}
                  onMouseEnter={
                    bindTip(
                      `${SUIT_NAME[card.suit]}${rankLabel(card.rank)} · ${name}${isCargo ? '（木牛流马·辎）' : ''}`,
                      cardDescription(card, snapshot.mode),
                    ).onMouseEnter
                  }
                  onMouseLeave={hideTip}
                  onClick={() => {
                    // 【丈八蛇矛】模式优先：这时候点牌是「凑两张」而不是出牌
                    if (zhangbaMode) {
                      toggleZhangbaCard(card.id);
                      return;
                    }
                    if (cardDisabled) return;
                    if (!prompt) return;
                    if (skillMode) {
                      if (skillCardClickable) toggleSkillCard(card.id);
                      return;
                    }
                    if (prompt.kind === 'pickHero') return;
                    if (prompt.kind === 'play') pickPlayCard(card);
                    else if (prompt.kind === 'discard') togglePick(card.id);
                    else pickRespondCard(card);
                  }}
                >
                  {/* 左上角标：点数 + 花色。闪电/乐不思蜀/兵粮寸断都靠花色点数判定，
                  所以这两项必须直接看得见 */}
                  <span className="c-idx">
                    <span className="c-rank">{rankLabel(card.rank)}</span>
                    <span className="c-suit">{SUIT_SYMBOL[card.suit]}</span>
                  </span>
                  <span className="c-name">
                    <span className={name.length >= 5 ? 'long' : undefined}>{name}</span>
                  </span>
                  {isCargo && <span className="c-cargo">辎</span>}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* 右栏：技能列在左边，右边是出牌记录 + 武将面板。
          这样记录和面板同宽（都在 .side-main 里），技能又在面板框左侧。
          窄屏时两层容器消失，按 order 排成单列 */}
      <aside className="side">
        <SkillButtons skills={skillRows} />

        <div className="side-main">
          {/* 出牌记录 */}
          <div className="center">
            <div className="turn-info">
              [{MODE_NAME[snapshot.mode]}]{' '}
              {snapshot.players.find((p) => p.seatId === snapshot.turn.seatId)?.name} 的回合 ·{' '}
              {PHASE_NAME[snapshot.turn.phase] ?? snapshot.turn.phase}
            </div>
            <div className="log" ref={logBoxRef}>
              {snapshot.log.slice(-40).map((l) => (
                <div key={l.id} className={`log-line log-${l.kind}`}>
                  {l.message}
                </div>
              ))}
            </div>
          </div>

          {/* 武将面板 */}
          <HeroPanel
            me={me}
            mode={snapshot.mode}
            slots={heroSlots}
            targetable={canPickSelf && !selected!.picked.includes(me.seatId)}
            picked={!!selected?.picked.includes(me.seatId)}
            onSelect={canPickSelf ? () => pickTarget(me.seatId) : undefined}
          />
        </div>
      </aside>

      {tipNode}
    </div>
  );
}
