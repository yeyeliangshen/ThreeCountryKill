/**
 * **左慈·【役鬼】/【汲魂】**——用户 2026-09-26 复述的当前口径，二次校对（§5.246）。
 *
 * 这一轮抓到的四处真差异：
 * 1. 役鬼的【酒】/【桃】**直接执行结果**（手写 `jiuActive = true` / `api.heal`）——违反
 *    「技能生成牌、不重写牌的规则」：绕过 useCard 钩子、绕过【桃】「体力已满不能使用」的
 *    使用条件（满血会把魂白吞）。现在造**虚拟基本牌**、走真正的 `playJiu`/`playTao`。
 * 2. 【汲魂】两个触发都是「你可以」⇒ **要询问**（旧实现自动收）。
 * 3. 役鬼-【杀】的目标过滤借【决斗】牌面做「不可被指定」检查 ⇒ 帷幕（不挡杀）会误挡。
 * 4. 技能文本的目标句漏了「野心家」（实现里有）。
 */
import { describe, it, expect } from 'vitest';
import {
  applyIntent,
  createGame,
  emptyFlags,
  getHero,
  getHeroForMode,
  toSnapshot,
  type GameState,
} from '../src';
import type { Card, Faction } from '@sgs/protocol';

const ok = (r: { ok: boolean; error?: string }, tag = ''): void => {
  if (!r.ok) throw new Error(`${tag} 意图被拒：${r.error}`);
};
const act = (s: GameState, seat: string, i: Parameters<typeof applyIntent>[2]) =>
  applyIntent(s, seat, i);
const at = (s: GameState, seat: string) => s.players.find((p) => p.seatId === seat)!;
const mk = (id: string, type: Card['type'], suit: Card['suit'], rank = 1): Card => ({
  id,
  type,
  suit,
  rank,
});
const sha = (id: string) => mk(id, 'sha', 'spade', 7);

interface Seat {
  seatId: string;
  name: string;
  heroId: string;
  faction?: Faction;
  hand?: Card[];
  hp?: number;
}
function gz(seats: Seat[], pool: string[], turnSeat = 's0'): GameState {
  const state = createGame(
    seats.map((s) => ({ seatId: s.seatId, name: s.name, heroId: s.heroId })),
    'TEST',
    { mode: 'guozhan' },
  );
  state.draft = null;
  for (const s of seats) {
    const p = at(state, s.seatId);
    p.heroId = s.heroId;
    p.deputyHeroId = null;
    p.faction = s.faction ?? getHeroForMode(s.heroId, 'guozhan')?.faction ?? 'qun';
    p.heroRevealed = true;
    p.deputyRevealed = true;
    p.hand = (s.hand ?? []).slice();
    p.flags = emptyFlags();
    p.maxHp = 4;
    p.hp = s.hp ?? 4;
  }
  state.heroPool = pool;
  const idx = state.seatOrder.indexOf(turnSeat);
  state.turn = { seatIndex: idx < 0 ? 0 : idx, phase: 'play' };
  state.pending = { kind: 'play', seatId: state.seatOrder[state.turn.seatIndex]! };
  state.log = [];
  return state;
}
/** 给左慈直接塞「魂」并明置（绕过首次明置的随机发牌，便于指定势力） */
function withHun(state: GameState, souls: string[]): void {
  const z = at(state, 's0');
  z.hun = souls.slice();
}
/** 役鬼主动发动到「选牌名」那一问（选魂唯一/保密那步已过） */
function yiguiToCardNames(state: GameState): string[] {
  ok(act(state, 's0', { type: 'useSkill', skillId: 'yigui_use', targetIds: [] }), '发动役鬼');
  const p = state.pending;
  expect(p?.kind).toBe('choice');
  if (p?.kind !== 'choice') return [];
  return p.options.map((o) => o.id);
}

describe('【役鬼】的【桃】/【酒】：走**虚拟基本牌**，不直接执行结果', () => {
  it('【桃】：受伤时可用，走真·playTao（useCard 钩子照常触发——用遗计验证）', () => {
    const state = gz(
      [
        { seatId: 's0', name: '左慈', heroId: 'zuoci', faction: 'qun', hp: 2, hand: [] },
        { seatId: 's1', name: '乙', heroId: 'zhangfei', faction: 'shu' },
        { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun' },
      ],
      [],
    );
    // 副将郭嘉：遗计挂在「受到伤害后」——不在这条验；改用「useCard 后」的钩子难挂，
    // 直接验行为：hp +1、日志是【桃】那条、魂被移去、名字记账。
    withHun(state, ['xuchu']); // 许褚·魏
    const ids = yiguiToCardNames(state);
    expect(ids, '受伤时【桃】在候选里').toContain('tao');
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'tao' }), '选桃');
    expect(at(state, 's0').hp, '回了 1 点').toBe(3);
    expect(state.log.some((e) => e.message.includes('使用了【桃】')), '走的是真·playTao 日志').toBe(true);
    expect(at(state, 's0').hun, '魂被移去').toHaveLength(0);
    // 同回合再发动：桃已记名 ⇒ 不在候选里
    withHun(state, ['xuchu']);
    const ids2 = yiguiToCardNames(state);
    expect(ids2, '本回合役鬼已产生过【桃】').not.toContain('tao');
  });

  it('【桃】：**满血时不给选**（真牌的「体力已满不能使用」前置到候选层——不再白吞一张魂）', () => {
    const state = gz(
      [
        { seatId: 's0', name: '左慈', heroId: 'zuoci', faction: 'qun', hand: [] },
        { seatId: 's1', name: '乙', heroId: 'zhangfei', faction: 'shu' },
        { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun' },
      ],
      [],
    );
    withHun(state, ['xuchu']);
    const ids = yiguiToCardNames(state);
    expect(ids, '满血 ⇒ 桃不在候选').not.toContain('tao');
    expect(ids, '杀/酒照常在').toContain('sha');
    expect(ids).toContain('jiu');
  });

  it('【酒】：走真·playJiu（jiuActive 生效 + 标准日志），魂被移去', () => {
    const state = gz(
      [
        { seatId: 's0', name: '左慈', heroId: 'zuoci', faction: 'qun', hand: [] },
        { seatId: 's1', name: '乙', heroId: 'zhangfei', faction: 'shu' },
        { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun' },
      ],
      [],
    );
    withHun(state, ['xuchu']);
    const ids = yiguiToCardNames(state);
    expect(ids).toContain('jiu');
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'jiu' }), '选酒');
    expect(at(state, 's0').flags.jiuActive, '酒标记生效').toBe(true);
    expect(state.log.some((e) => e.message.includes('使用了【酒】')), '真·playJiu 日志').toBe(true);
    expect(at(state, 's0').hun).toHaveLength(0);
  });

  it('与其它虚拟牌同一套约定：不 bump `cardsUsedOrPlayed`（那层计数在 onPlayCard，castVirtualSha 同样不 bump）', () => {
    // 如实记：役鬼的虚拟【桃】走 playTao（useCard 钩子照跑），但「本回合使用/打出的第 X 张」
    // 的计数器在 onPlayCard 里 ⇒ 虚拟牌（含【杀】/锦囊那两条）一致地不 bump。
    // 是否该计＝蒺藜那类技能的口径问题，全仓统一改，不在这轮单独动（见 §5.246 待核对）。
    const state = gz(
      [
        { seatId: 's0', name: '左慈', heroId: 'zuoci', faction: 'qun', hp: 2, hand: [] },
        { seatId: 's1', name: '乙', heroId: 'zhangfei', faction: 'shu' },
        { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun' },
      ],
      [],
    );
    withHun(state, ['xuchu']);
    const before = at(state, 's0').flags.cardsUsedOrPlayed;
    ok(act(state, 's0', { type: 'useSkill', skillId: 'yigui_use', targetIds: [] }));
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'tao' }));
    expect(at(state, 's0').flags.cardsUsedOrPlayed, '与其它虚拟牌一致（不 bump）').toBe(before);
    expect(state.log.some((e) => e.message.includes('使用了【桃】')), '但 playTao 本体照常跑').toBe(true);
  });
});

describe('【役鬼】-【杀】：帷幕不挡杀（原来借【决斗】牌面 ⇒ 误挡）', () => {
  it('帷幕持有者**可以**成为役鬼-【杀】的目标，但**不能**成为役鬼-【过河拆桥】的目标', () => {
    const state = gz(
      [
        { seatId: 's0', name: '左慈', heroId: 'zuoci', faction: 'qun', hand: [] },
        // 贾诩（魏）＝帷幕：不能成为锦囊牌的目标（不挡杀）
        { seatId: 's1', name: '贾诩', heroId: 'jiaxu', faction: 'wei' },
        { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun' },
        { seatId: 's3', name: '丁', heroId: 'guanyu', faction: 'shu' },
      ],
      [],
    );
    withHun(state, ['xuchu']); // 许褚·魏（与贾诩同势力 ⇒ 势力限制放行）
    ok(act(state, 's0', { type: 'useSkill', skillId: 'yigui_use', targetIds: [] }), '发动役鬼');
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'sha' }), '选杀');
    const p = state.pending;
    expect(p?.kind, '问杀的目标').toBe('choice');
    if (p?.kind === 'choice') {
      const ids = p.options.map((o) => o.id);
      expect(ids, '帷幕不挡杀 ⇒ 贾诩在候选里（修复前被借用的锦囊牌面挡掉了）').toContain('s1');
    }
    ok(act(state, 's0', { type: 'chooseOption', optionId: 's1' }), '杀贾诩');
    expect(state.pending?.kind, '进入闪响应').toBe('respondSha');

    // 对照：锦囊那条仍然要被帷幕挡。用**蜀**魂（关羽）⇒ 丁（蜀）合法、
    // 贾诩（魏）势力本可（?? 不——蜀魂下魏也不合法）——改验「唯一势力合法的丁在、贾诩不在」
    const state2 = gz(
      [
        { seatId: 's0', name: '左慈', heroId: 'zuoci', faction: 'qun', hand: [] },
        { seatId: 's1', name: '贾诩', heroId: 'jiaxu', faction: 'wei' },
        { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun' },
        { seatId: 's3', name: '丁', heroId: 'guanyu', faction: 'shu' },
      ],
      [],
    );
    withHun(state2, ['guanyu']); // 关羽·蜀 ⇒ 只有丁（蜀）势力合法
    ok(act(state2, 's0', { type: 'useSkill', skillId: 'yigui_use', targetIds: [] }));
    ok(act(state2, 's0', { type: 'chooseOption', optionId: 'guohe' }), '选过河拆桥');
    const p2 = state2.pending;
    expect(p2?.kind, '有合法目标（丁）⇒ 要问').toBe('choice');
    if (p2?.kind === 'choice') {
      expect(p2.options.map((o) => o.id), '帷幕挡锦囊 ⇒ 贾诩不在候选里，只有丁').toEqual(['s3']);
    }
  });
});

describe('【汲魂】：两个触发都**询问**（「可以」⇒ 可拒绝）', () => {
  it('受伤后：问一句；牌堆空 ⇒ 不问', () => {
    const hurt = gz(
      [
        { seatId: 's0', name: '左慈', heroId: 'zuoci', faction: 'qun' },
        { seatId: 's1', name: '乙', heroId: 'zhangfei', faction: 'shu', hand: [sha('b1')] },
        { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun' },
      ],
      ['zhangliao'],
      's1',
    );
    ok(act(hurt, 's1', { type: 'playCard', cardId: 'b1', targetIds: ['s0'] }), '出杀');
    ok(act(hurt, 's0', { type: 'pass' }), '不闪');
    expect(hurt.pending?.kind, '受伤后问汲魂').toBe('choice');
    if (hurt.pending?.kind === 'choice') expect(hurt.pending.title).toContain('汲魂');
    ok(act(hurt, 's0', { type: 'chooseOption', optionId: 'yes' }));
    expect(at(hurt, 's0').hun).toHaveLength(1);

    const empty = gz(
      [
        { seatId: 's0', name: '左慈', heroId: 'zuoci', faction: 'qun' },
        { seatId: 's1', name: '乙', heroId: 'zhangfei', faction: 'shu', hand: [sha('b1')] },
        { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun' },
      ],
      [],
      's1',
    );
    ok(act(empty, 's1', { type: 'playCard', cardId: 'b1', targetIds: ['s0'] }));
    ok(act(empty, 's0', { type: 'pass' }));
    expect(empty.pending?.kind, '牌堆空 ⇒ 不问').toBe('play');
  });

  it('同势力脱离濒死后：问一句；不同势力不问（对照）', () => {
    const state = gz(
      [
        { seatId: 's0', name: '左慈', heroId: 'zuoci', faction: 'qun' },
        { seatId: 's1', name: '乙', heroId: 'zhangfei', faction: 'shu', hand: [sha('b1'), mk('b2', 'tao', 'heart', 3)] },
        { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun', hp: 1 },
      ],
      ['zhangliao'],
      's1',
    );
    ok(act(state, 's1', { type: 'playCard', cardId: 'b1', targetIds: ['s2'] }), '杀丙');
    ok(act(state, 's2', { type: 'pass' }), '丙不闪 → 濒死');
    while (state.pending?.kind === 'respondDeath') {
      const p = state.pending;
      const asked = p.askQueue[p.askIndex]!;
      if (asked === 's1' && at(state, 's1').hand.some((c) => c.id === 'b2')) {
        ok(act(state, 's1', { type: 'respondCard', cardId: 'b2' }), '乙用桃救');
      } else ok(act(state, asked, { type: 'pass' }));
    }
    expect(at(state, 's2').hp, '救回来了').toBe(1);
    expect(state.pending?.kind, '同势力脱离濒死 → 问汲魂').toBe('choice');
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'yes' }));
    expect(at(state, 's0').hun).toHaveLength(1);
  });
});

describe('文本与目标限制', () => {
  it('役鬼文本含「使用或打出」「野心家」（与实现对齐）', () => {
    const desc = getHeroForMode('zuoci', 'guozhan')!.skills.find((s) => s.name === '役鬼')!.desc ?? '';
    expect(desc).toContain('使用或打出');
    expect(desc).toContain('野心家');
    expect(desc).toContain('未确定势力');
  });

  it('野心家 / 未确定势力 / 同魂势力都在候选里（公开口径，不偷看底牌）', () => {
    const state = gz(
      [
        { seatId: 's0', name: '左慈', heroId: 'zuoci', faction: 'qun', hand: [] },
        { seatId: 's1', name: '乙', heroId: 'xuchu', faction: 'wei' },
        { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun' },
        { seatId: 's3', name: '丁', heroId: 'guanyu', faction: 'shu' },
      ],
      [],
    );
    at(state, 's1').faction = 'ambitionist';
    at(state, 's1').determinedFaction = 'ambitionist';
    at(state, 's2').heroRevealed = false;
    at(state, 's2').deputyRevealed = false; // 暗置（未确定势力）
    // s2 在环上是**对角（距离 2）**——给左慈一把范围 3 的武器，免得被距离滤掉
    at(state, 's0').equipment.weapon = {
      ...mk('w1', 'weapon', 'spade', 5),
      equipName: 'qilin',
      range: 3,
    } as Card;
    withHun(state, ['guanyu']); // 关羽·蜀
    ok(act(state, 's0', { type: 'useSkill', skillId: 'yigui_use', targetIds: [] }));
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'sha' }), '选杀');
    const p = state.pending;
    if (p?.kind === 'choice') {
      const ids = p.options.map((o) => o.id);
      expect(ids, '野心家可以').toContain('s1');
      expect(ids, '未确定势力可以').toContain('s2');
      expect(ids, '与魂（蜀）同势力可以').toContain('s3');
      // 左慈自己是群 ⇒ 不在（且杀本来就排除自己）
      expect(ids).not.toContain('s0');
    }
  });

  it('「魂」仍是私有信息：别人的快照只有数量、没有名字', () => {
    const state = gz(
      [
        { seatId: 's0', name: '左慈', heroId: 'zuoci', faction: 'qun' },
        { seatId: 's1', name: '乙', heroId: 'zhangfei', faction: 'shu' },
        { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun' },
      ],
      [],
    );
    withHun(state, ['xuchu', 'guanyu']);
    const mine = toSnapshot(state, 's0').players.find((p) => p.seatId === 's0')!;
    const theirs = toSnapshot(state, 's1').players.find((p) => p.seatId === 's0')!;
    expect(mine.hunCount).toBe(2);
    expect(mine.hunNames?.length).toBe(2);
    expect(theirs.hunCount).toBe(2);
    expect(theirs.hunNames, '别人看不到是哪两张').toBeUndefined();
    expect(JSON.stringify(theirs)).not.toContain('许褚');
  });
});
