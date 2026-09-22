/**
 * **统一的技能提示判据**——用户 2026-09-25 口径①~④：
 *
 * > 缺陷：其他角色发动技能时，缺少技能名称和技能效果展示…① 技能发动或触发时，在对应角色附近
 * > 短暂显示技能名称；② 点击技能名称或技能提示时，可查看完整技能描述；③ 对于正在等待玩家响应或
 * > 正在进行多步结算的技能，应保持必要的当前技能提示；④ 技能结算完成后自动收起，避免长期遮挡
 * > 牌桌。该机制应由**统一的技能事件系统**驱动，而不是为每个武将分别制作提示逻辑。
 *
 * 这一层只认**引擎下发的那一条事件**（`Snapshot.skillFx`，见 protocol 的 `SkillFxView`）：
 * 输入是「刚发动/刚触发的技能 + 它还在不在结算」，输出是「现在该显示什么、什么时候收起」。
 * **不认牌、不认武将、更不许正则匹配日志里的中文技能名**——技能名与发动者座次都由引擎给出。
 *
 * 全是纯函数（`skillTips.test.ts` 直测），React 只负责把结果贴成 DOM 与定时器。
 */
import type { GameMode, PlayerView, SkillFxView } from '@sgs/protocol';
import { getHeroForMode, HEROES } from '@sgs/engine';

/** 一次「发动」没人被问话时，技能名停留多久（口径①的「短暂」） */
export const SKILL_TIP_BASE_MS = 4200;
/** 结算刚结束时再多留一会儿（不然最后一步的结果刚出来提示就没了） */
export const SKILL_TIP_TAIL_MS = 1400;
/** 还在等回答 / 多步结算中：每来一份快照就续这么久（口径③的「保持」） */
export const SKILL_TIP_HOLD_MS = 2600;
/**
 * 兜底上限（口径④的「避免长期遮挡」）：**无论**结算拖多久，一条提示最多留这么久。
 * 引擎的 `settling` 理论上会在结算完的那一刻变 false，但万一快照丢了/流程异常，
 * 这一条保证提示一定会自己消失。
 */
export const SKILL_TIP_MAX_MS = 15000;
/** 玩家**手动点开**完整描述后最多留这么久（他要求看的，给足时间；仍然不会永久遮挡） */
export const SKILL_TIP_PIN_MAX_MS = 30000;

/** 现在该显示的那一条技能提示（React 只把它贴成 DOM，不做任何判断） */
export interface SkillTip {
  /** 引擎给的事件号（`SkillFxView.seq`）：变了＝新的一次发动 */
  seq: number;
  /** 发动者座次：提示贴在他那张牌 / 武将面板附近 */
  seatId: string;
  /** 技能中文名（展示 + 查描述的键） */
  skillName: string;
  /** 出现时刻（毫秒时间戳，`Date.now()`） */
  since: number;
  /** 到期时刻：到点还没被续上就收起来 */
  expiresAt: number;
  /** 引擎说它还在结算（等某人回答 / 多步结算）——口径③，提示保持 */
  settling: boolean;
  /** 玩家手动展开了完整描述（口径②）：不再按上面的时限自动收，改用 PIN 上限 */
  pinned: boolean;
}

/**
 * **事件流 → 该显示什么**（口径①③④的唯一判据）。
 *
 * 逐条规则（有意写死，别让上层再判一遍）：
 * - **基线**：本客户端看到的**第一份快照**不播——进房 / 刷新时引擎那份 `skillFx` 可能是
 *   好几步之前的事，照着播就是把旧技能当新闻（与 `chainState.diffChainStates` 同一条规矩）。
 * - **换了一条**（`seq` 变了）⇒ 立刻换成新的（口径①），旧的让位；
 * - **还在结算**（`settling`）⇒ 续时保持（口径③），但撞到 `SKILL_TIP_MAX_MS` 兜底就收；
 * - **结算完了** ⇒ 从「现在」起最多再留 `SKILL_TIP_TAIL_MS`，到点自动收起（口径④）；
 * - **玩家点开过**（`pinned`）⇒ 不再按上面的时限收，改用 `SKILL_TIP_PIN_MAX_MS`
 *   （他要看的说明不能下一秒就没了）；他再点一次、或下一个技能发动时让位。
 */
export function nextSkillTip(
  prev: SkillTip | null,
  fx: SkillFxView | null,
  now: number,
  opts: { baseline?: boolean } = {},
): SkillTip | null {
  // ① 这一次发动是新的（或本来就没有）
  if (fx && (!prev || prev.seq !== fx.seq)) {
    if (opts.baseline) return prev; // 第一份快照只当基线，不播
    return {
      seq: fx.seq,
      seatId: fx.seatId,
      skillName: fx.skillName,
      since: now,
      expiresAt: now + (fx.settling ? SKILL_TIP_HOLD_MS : SKILL_TIP_BASE_MS),
      settling: fx.settling,
      pinned: false,
    };
  }
  if (!prev) return null;

  // ② 已经点开看说明的：按 PIN 上限留着（新的一次发动在上面那支已经把它换掉了）
  if (prev.pinned) {
    const alive = now < prev.since + SKILL_TIP_PIN_MAX_MS;
    return alive ? { ...prev, settling: fx ? fx.settling : false } : null;
  }

  // ③ 引擎那边结算完了（或事件被清掉），或④还在结算：
  const settling = fx ? fx.settling : false;
  if (settling) {
    // 兜底：多步结算也不许超过 MAX（否则一个卡住的流程会把提示永久留在牌桌上）
    if (now >= prev.since + SKILL_TIP_MAX_MS) return null;
    return {
      ...prev,
      settling: true,
      expiresAt: Math.min(now + SKILL_TIP_HOLD_MS, prev.since + SKILL_TIP_MAX_MS),
    };
  }
  // 结算**刚刚**结束（上一帧还在等回答）：从这一刻起再留 TAIL，让最后一步的结果看得到；
  // 已经结束过的那一份（重复到达的快照）**不动计时**——否则别人的一次无关动作
  // 会把还没到点的提示提前收掉。
  const expiresAt = prev.settling
    ? Math.min(now + SKILL_TIP_TAIL_MS, prev.since + SKILL_TIP_MAX_MS)
    : prev.expiresAt;
  if (now >= expiresAt) return null;
  return { ...prev, settling: false, expiresAt };
}

/** 这一条还要过多久才该重新判一次（没得判＝null）；钩子用它定下一次 tick */
export function skillTipRemainingMs(tip: SkillTip | null, now: number): number | null {
  if (!tip) return null;
  return Math.max(0, tip.expiresAt - now);
}

/**
 * 技能**描述**从哪来：优先用该角色**已明置**武将牌上的那一份（模式正确：国战与身份局
 * 的同名技能描述并不相同，见 heroes.ts 的说明），查不到再按技能名在名册里找第一处。
 *
 * ⚠️ 两个安全点：
 * - **不新造规则文本**：描述全部来自引擎的 `Hero.skills[].desc`（界面本来就在用的那一份，
 *   见 `HeroChips.skillsTipDesc` / `legal.skillDescFor`）；
 * - **不泄露暗将**：查的是**引擎已经宣布过的那个技能名**（事件本身就带它），
 *   按名查字典不会反推出「这是谁的技能」；角色自己未明置的武将 id 也不会被读到。
 */
export function skillTipDesc(
  mode: GameMode,
  players: readonly PlayerView[],
  seatId: string,
  skillName: string,
): string {
  const seat = players.find((p) => p.seatId === seatId);
  if (seat) {
    for (const id of [seat.heroId, seat.deputyHeroId]) {
      const hero = id ? getHeroForMode(id, mode) : undefined;
      const found = hero?.skills.find((s) => s.name === skillName);
      if (found) return found.desc;
    }
  }
  // 兜底：借来的技能（黄天/眩惑那类不在使用者武将牌上）、或该武将的 id 还没下发时，
  // 按名字在名册里找（同一模式下同名技能视为同一个）。
  for (const h of HEROES) {
    const hero = getHeroForMode(h.id, mode);
    const found = hero?.skills.find((s) => s.name === skillName);
    if (found) return found.desc;
  }
  return '';
}
