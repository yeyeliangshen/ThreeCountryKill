import type { MarkerId } from '@sgs/protocol';
import type { GameState, MarkerUsage, Player } from './model';
import { getPlayer, pushLog } from './model';
import { drawOne } from './deck';
import { getHero, getHeroForMode, type ActiveSkill, type SkillApi } from './heroes';

// —— 国战标记 ——
// 规则的获得条件与用法见 docs/guozhan-reference.md §2。
//
// 标记不属于任何武将牌，所以它带来的「出牌阶段」技能不经过 activeHeroes：
// legal.buildPlayPrompt 与 engine.onUseSkill 各自把 markerActiveSkills() 合并一次。
// 标记的消耗靠数量递减，因此不设 oncePerTurn。

/** 标记技能 id 的统一前缀，避免和武将主动技（zhiheng/kurou…）撞名 */
export const MARKER_SKILL_PREFIX = 'mark_';

export function markerCount(player: Player, id: MarkerId): number {
  return player.markers[id] ?? 0;
}

export function addMarker(player: Player, id: MarkerId, n = 1): void {
  player.markers[id] = markerCount(player, id) + n;
}

/** 消耗一个标记，返回是否真的消耗掉了。归零就删键（Markers 只记 > 0 的） */
export function consumeMarker(player: Player, id: MarkerId): boolean {
  const n = markerCount(player, id);
  if (n <= 0) return false;
  if (n === 1) delete player.markers[id];
  else player.markers[id] = n - 1;
  return true;
}

/** 给玩家看的一句话说明（界面悬停用） */
export const MARKER_DESC: Record<MarkerId, string> = {
  xianqu: '出牌阶段弃置：将手牌补至 4 张，并观看一名其他角色的一张暗置武将牌。',
  yinyangyu: '出牌阶段弃置：摸 1 张牌；或在弃牌阶段弃置：本回合手牌上限 +2。',
  zhulian: '弃置：摸 2 张牌，或回复 1 点体力。',
  ambitionist:
    '弃置：当作【阴阳鱼】【珠联璧合】【先驱】中的任意一种使用。（首次明置主将牌后获得一枚；' +
    '它不是「野心家身份」，两者只是名字撞车）',
};

/** 摸 n 张（牌堆耗尽就少摸），返回实际摸到的张数 */
function drawN(state: GameState, player: Player, n: number): number {
  let got = 0;
  for (let i = 0; i < n; i++) {
    const c = drawOne(state);
    if (!c) break;
    player.hand.push(c);
    got++;
  }
  return got;
}

/**
 * 记一笔「谁本回合把哪枚国战标记按哪种用法用掉了」（章武要用；见 GameState.markerUsesThisTurn）。
 *
 * ⚠️ 【章武】是「视为使用**同一枚标记的同一种用法**」，所以用法也要记：
 *    阴阳鱼在出牌阶段（摸一张）与弃牌阶段（手牌上限 +2）是两种不同的效果。
 */
export function noteMarkerUsed(
  state: GameState,
  seatId: string,
  id: MarkerId,
  usage: MarkerUsage,
): void {
  state.markerUsesThisTurn.push({ seatId, markerId: id, usage });
}

/**
 * 【先驱】的效果：手牌补至四张，并观看目标**未明置的副将**牌。
 * 「弃置标记」这个动作由调用方负责（真用掉 / 章武的「视为使用」都不消耗标记）。
 *
 * ⚠️ 只看**副将**：牌面原文是「并观看其没有明置的**副将**牌」（用户核对后的口径表也是
 *    「观看一名其他角色未明置的副将」）。先前这里看的是「任意一张暗置武将牌」，
 *    而且两张都暗着时还要问看哪张——那是错的，本轮订正（副将已明置就没得看）。
 */
export function useXianqu(
  state: GameState,
  player: Player,
  target: Player | undefined,
  api: SkillApi,
  via: string,
  opts?: { returnTo?: string },
): void {
  const got = drawN(state, player, Math.max(0, 4 - player.hand.length));
  pushLog(
    state,
    'marker',
    `${via}，${player.name} 补了 ${got} 张牌${target ? `，并观看 ${target.name} 未明置的副将` : ''}。`,
  );
  if (!target) return;
  // 观看是自己要看完的信息展示：**主动技**里给 returnTo（看完把控制权还给出牌方）；
  // **钩子**里不能给（钩子链条会自己接着跑，见 runHooksFrom 的 viewCards 分支）。
  const show = (name: string): void => {
    api.privateView(
      player.seatId,
      `${target.name} 的副将`,
      { cards: [], note: name },
      opts?.returnTo ? { returnTo: opts.returnTo } : undefined,
    );
  };
  // 只看**副将**：「并观看其没有明置的副将牌」（牌面原文；用户核对后的口径表也是
  // 「观看一名其他角色未明置的副将」）。副将已经明置、或他根本没有副将牌 → 没得看。
  if (target.deputyRevealed || !target.deputyHeroId) {
    show('（他没有未明置的副将）');
    return;
  }
  const deputy = getHeroForMode(target.deputyHeroId, state.mode) ?? getHero(target.deputyHeroId);
  show(deputy?.name ?? '（找不到那张武将牌）');
}

const XIANQU: ActiveSkill = {
  id: `${MARKER_SKILL_PREFIX}xianqu`,
  name: '先驱',
  minTargets: 1,
  maxTargets: 1,
  canUse: () => true,
  // 官方原文：「你可以于出牌阶段内选择一名其他角色并弃置一个『先驱』标记，然后你将手牌数摸至
  // 四张并观看其没有明置的副将牌。」（移动版 WIKI 已核；仓库文档 §2 的表述一致）
  // ⚠️ 以前只做了「手牌补至 4 张」，理由是「查看暗将需要私密信息通道，尚未实现」——那个通道
  //    后来做好了（知彼/尚义在用 privateView），所以这半句现在补上。
  execute: (state, player, intent, api) => {
    const tid = intent.targetIds?.[0];
    const target = tid ? getPlayer(state, tid) : undefined;
    if (!target) return '【先驱】需选择一名其他角色';
    if (!consumeMarker(player, 'xianqu')) return '没有【先驱】标记';
    noteMarkerUsed(state, player.seatId, 'xianqu', 'view');
    useXianqu(state, player, target, api, `${player.name} 弃置【先驱】`, {
      // 选完必须把控制权还给发起者，否则 pending 停在询问上、出牌方再也动不了
      returnTo: player.seatId,
    });
    return undefined;
  },
};

/**
 * 【阴阳鱼】在**弃牌阶段**那条用法：本回合手牌上限 +2。
 * 【章武】在结束阶段复现时也走它——那时通常已经没有实际作用，但效果要照原样执行。
 */
export function useYinyangyuHandLimit(state: GameState, player: Player, via: string): void {
  player.flags.handLimitBonus += 2;
  pushLog(state, 'marker', `${via}，${player.name} 本回合手牌上限 +2。`, { seat: player.seatId });
}

/** 【阴阳鱼】在**出牌阶段**那条用法：摸一张牌 */
export function useYinyangyu(state: GameState, player: Player, via: string): number {
  const got = drawN(state, player, 1);
  pushLog(state, 'marker', `${via}，${player.name} 摸了 ${got} 张牌。`);
  return got;
}

const YINYANGYU: ActiveSkill = {
  id: `${MARKER_SKILL_PREFIX}yinyangyu`,
  name: '阴阳鱼',
  minTargets: 0,
  maxTargets: 0,
  // 一枚标记两种用法，按**阶段**分流：出牌阶段摸一张、弃牌阶段本回合手牌上限 +2。
  // （其余阶段不给这个按钮：判定/摸牌阶段用不上，也不该在别人的回合里点。
  //   ⚠️ 2026-09-21 之前这里写死 `() => true`，而且 execute 永远走「摸一张」——
  //      弃牌阶段那条用法虽然实现了（useYinyangyuHandLimit），却没有入口。）
  canUse: (state) => state.turn.phase === 'play' || state.turn.phase === 'discard',
  alsoUsableInDiscardPhase: true,
  execute: (state, player) => {
    if (!consumeMarker(player, 'yinyangyu')) return '没有【阴阳鱼】标记';
    if (state.turn.phase === 'discard') {
      noteMarkerUsed(state, player.seatId, 'yinyangyu', 'handLimit');
      useYinyangyuHandLimit(state, player, `${player.name} 弃置【阴阳鱼】`);
      return undefined;
    }
    noteMarkerUsed(state, player.seatId, 'yinyangyu', 'draw');
    useYinyangyu(state, player, `${player.name} 弃置【阴阳鱼】`);
    return undefined;
  },
};

/**
 * 【珠联璧合】的效果：摸两张牌，或回复 1 点体力（二选一）。
 * `opts.returnTo` 只在**主动技**里给（钩子里不能给，见 askChoice 的说明）。
 */
export function useZhulian(
  state: GameState,
  player: Player,
  api: SkillApi,
  via: string,
  opts?: {
    returnTo?: string;
    /** 【章武】复现：按记录好的那条用法直接结算，不再问「摸两张还是回体力」 */
    forced?: 'draw' | 'heal';
    /** 选完之后回调（把「用的是哪条」记进章武的账本） */
    onPicked?: (state: GameState, usage: 'draw' | 'heal') => void;
  },
): void {
  const apply = (st: GameState, p: Player, picked: string): void => {
    if (picked === 'heal') {
      const before = p.hp;
      p.hp = Math.min(p.maxHp, p.hp + 1);
      pushLog(st, 'marker', `${via}，${p.name} 回复 ${p.hp - before} 点体力。`);
      return;
    }
    const got = drawN(st, p, 2);
    pushLog(st, 'marker', `${via}，${p.name} 摸了 ${got} 张牌。`);
  };
  if (opts?.forced) {
    apply(state, player, opts.forced);
    return;
  }
  api.askChoice(
    state,
    player.seatId,
    `${via}：请选择一项`,
    [
      { id: 'draw', label: '摸两张牌' },
      { id: 'heal', label: '回复 1 点体力' },
    ],
    (st, p, picked) => {
      opts?.onPicked?.(st, picked === 'heal' ? 'heal' : 'draw');
      apply(st, p, picked);
    },
    opts?.returnTo,
  );
}

const ZHULIAN: ActiveSkill = {
  id: `${MARKER_SKILL_PREFIX}zhulian`,
  name: '珠联璧合',
  minTargets: 0,
  maxTargets: 0,
  canUse: () => true,
  execute: (state, player, _intent, api) => {
    if (!consumeMarker(player, 'zhulian')) return '没有【珠联璧合】标记';
    // 官方两种用法（摸两张牌 / 回复 1 点体力），做成「选择一项」。
    // 记账放在**选完之后**——要连「用的是哪一条」一起记（【章武】照它复现）
    useZhulian(state, player, api, `${player.name} 弃置【珠联璧合】`, {
      // 选完必须把控制权还给发起者，否则 pending 停在 choice 上、出牌方再也动不了
      returnTo: player.seatId,
      onPicked: (st, usage) => noteMarkerUsed(st, player.seatId, 'zhulian', usage),
    });
    return undefined;
  },
};

/**
 * 【野心家】标记：当作【阴阳鱼】【珠联璧合】【先驱】中的任意一种使用。
 *
 * 用户核对后的口径：**它不是「野心家身份」**（那个决定你属于哪个势力、怎么获胜），
 * 只是一枚「万能国战标记」。所以【章武】的账本要记**实际被当成哪一种标记、走了哪个分支**，
 * 而不是记一个 `ambitionist`（见 noteMarkerUsed 的三参）。
 */
const AMBITIONIST: ActiveSkill = {
  id: `${MARKER_SKILL_PREFIX}ambitionist`,
  name: '野心家',
  minTargets: 0,
  maxTargets: 0,
  canUse: () => true,
  execute: (state, player, _intent, api) => {
    if (markerCount(player, 'ambitionist') <= 0) return '没有【野心家】标记';
    api.askChoice(
      state,
      player.seatId,
      '【野心家】标记：当作哪一枚国战标记使用？',
      [
        { id: 'yinyangyu', label: '【阴阳鱼】（摸一张牌）' },
        { id: 'zhulian', label: '【珠联璧合】（摸两张 / 回复 1 点体力）' },
        { id: 'xianqu', label: '【先驱】（补至四张并观看其未明置的副将）' },
      ],
      (st, p, picked) => {
        consumeMarker(p, 'ambitionist');
        const via = `【${p.name}】用【野心家】标记当作`;
        if (picked === 'zhulian') {
          useZhulian(st, p, api, `${via}【珠联璧合】`, {
            returnTo: p.seatId,
            onPicked: (s2, usage) => noteMarkerUsed(s2, p.seatId, 'zhulian', usage),
          });
          return;
        }
        if (picked === 'xianqu') {
          const others = st.players.filter((x) => x.alive && x.seatId !== p.seatId);
          if (others.length === 0) {
            noteMarkerUsed(st, p.seatId, 'xianqu', 'view');
            useXianqu(st, p, undefined, api, `${via}【先驱】`);
            return;
          }
          api.askChoice(
            st,
            p.seatId,
            '【野心家】标记当作【先驱】：观看哪名其他角色未明置的副将？',
            others.map((x) => ({ id: x.seatId, label: x.name })),
            (st2, p2, seatId) => {
              noteMarkerUsed(st2, p2.seatId, 'xianqu', 'view');
              useXianqu(st2, p2, getPlayer(st2, seatId), api, `${via}【先驱】`, {
                returnTo: p2.seatId,
              });
            },
            p.seatId,
          );
          return;
        }
        // 阴阳鱼（出牌阶段那条：摸一张）
        noteMarkerUsed(st, p.seatId, 'yinyangyu', 'draw');
        useYinyangyu(st, p, `${via}【阴阳鱼】`);
      },
      player.seatId,
    );
    return undefined;
  },
};

/**
 * 当前持有的标记所能发起的「出牌阶段」技能。
 * 非国战模式没有标记，直接返回空。
 */
export function markerActiveSkills(state: GameState, player: Player): ActiveSkill[] {
  if (state.mode !== 'guozhan') return [];
  const out: ActiveSkill[] = [];
  if (markerCount(player, 'xianqu') > 0) out.push(XIANQU);
  if (markerCount(player, 'yinyangyu') > 0) out.push(YINYANGYU);
  if (markerCount(player, 'zhulian') > 0) out.push(ZHULIAN);
  if (markerCount(player, 'ambitionist') > 0) out.push(AMBITIONIST);
  return out;
}
