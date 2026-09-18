import type { MarkerId } from '@sgs/protocol';
import type { GameState, Player } from './model';
import { getPlayer, pushLog } from './model';
import { drawOne } from './deck';
import { unrevealedHeroes, type ActiveSkill, type SkillApi } from './heroes';

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
  ambitionist: '弃置：视为使用其余三种标记中的任意一种。（暂无武将可获得）',
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

/** 记一笔「谁本回合用掉了一枚国战标记」（章武要用；见 GameState.markerUsesThisTurn） */
export function noteMarkerUsed(state: GameState, seatId: string, id: MarkerId): void {
  state.markerUsesThisTurn.push({ seatId, markerId: id });
}

/**
 * 【先驱】的效果：手牌补至四张，并观看目标一名暗置武将牌。
 * 「弃置标记」这个动作由调用方负责（真用掉 / 章武的「视为使用」都不消耗标记）。
 */
export function useXianqu(
  state: GameState,
  player: Player,
  target: Player | undefined,
  api: SkillApi,
  via: string,
): void {
  const got = drawN(state, player, Math.max(0, 4 - player.hand.length));
  pushLog(
    state,
    'marker',
    `${via}，${player.name} 补了 ${got} 张牌${target ? `，并观看 ${target.name} 的暗置武将牌` : ''}。`,
  );
  if (!target) return;
  // 「观看其一张暗置武将牌」：两张都暗着时由观看者挑一张（与知彼同一口径）
  const hidden = unrevealedHeroes(state.mode, target);
  const show = (name: string): void => {
    api.privateView(
      player.seatId,
      `${target.name} 的暗置武将牌`,
      { cards: [], note: name },
      { returnTo: player.seatId },
    );
  };
  if (hidden.length === 0) {
    show('（他没有暗置的武将牌）');
    return;
  }
  if (hidden.length === 1) {
    show(hidden[0]!.name);
    return;
  }
  api.askChoice(
    state,
    player.seatId,
    '【先驱】：观看哪一张暗置武将牌？',
    hidden.map((h) => ({ id: h.id, label: h.name })),
    (_st, _p, picked) => {
      show(hidden.find((h) => h.id === picked)?.name ?? hidden[0]!.name);
    },
    player.seatId,
  );
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
    noteMarkerUsed(state, player.seatId, 'xianqu');
    useXianqu(state, player, target, api, `${player.name} 弃置【先驱】`);
    return undefined;
  },
};

/** 【阴阳鱼】的效果：摸一张牌（弃牌阶段那条「手牌上限 +2」不在这个函数里） */
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
  canUse: () => true,
  execute: (state, player) => {
    if (!consumeMarker(player, 'yinyangyu')) return '没有【阴阳鱼】标记';
    noteMarkerUsed(state, player.seatId, 'yinyangyu');
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
  opts?: { returnTo?: string },
): void {
  api.askChoice(
    state,
    player.seatId,
    `${via}：请选择一项`,
    [
      { id: 'draw', label: '摸两张牌' },
      { id: 'heal', label: '回复 1 点体力' },
    ],
    (st, p, picked) => {
      if (picked === 'heal') {
        const before = p.hp;
        p.hp = Math.min(p.maxHp, p.hp + 1);
        pushLog(st, 'marker', `${via}，${p.name} 回复 ${p.hp - before} 点体力。`);
        return;
      }
      const got = drawN(st, p, 2);
      pushLog(st, 'marker', `${via}，${p.name} 摸了 ${got} 张牌。`);
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
    noteMarkerUsed(state, player.seatId, 'zhulian');
    // 官方两种用法（摸两张牌 / 回复 1 点体力），做成「选择一项」
    useZhulian(state, player, api, `${player.name} 弃置【珠联璧合】`, {
      // 选完必须把控制权还给发起者，否则 pending 停在 choice 上、出牌方再也动不了
      returnTo: player.seatId,
    });
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
  return out;
}
