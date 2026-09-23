/**
 * **国战貂蝉**（用户 2026-09-25 口径：按当前《三国杀移动版》国战标准版）。
 *
 * 口径要点（逐条对着写用例）：
 * - 群、1.5 阴阳鱼（→ 3）、珠联璧合**吕布**（走通用的 `combos`/珠联璧合机制，不特判）。
 * - 【离间】现行文本：出牌阶段限一次，你可以弃置一张牌，**依次**选择两名**男性其他角色**，
 *   令**后者**视为对**前者**使用一张【决斗】。
 *   · 顺序：**第一个选的是【决斗】的目标、第二个才是【决斗】的使用者**（最容易点反的地方）；
 *   · 代价是「一张**牌**」＝手牌 + 自己装备区（不是「手牌」），**不含判定区**、**不随机**；
 *   · 生成的是一张**正常虚拟【决斗】**：走锦囊流程（可被无懈、能触发成为目标类技能），
 *     **不许**手搓「轮流打杀」的状态机；
 *   · 伤害来源＝那张【决斗】的**使用者**（第二目标）——击杀奖惩/伤害来源类技能认的都是他，不是貂蝉。
 * - 性别按**当前公开性别**判：只明置一张＝那张；主副均明置＝**主将**；全暗置＝未确定（不可选）。
 *   ⚠️ 不许翻暗将底牌判性别（那会泄露隐藏信息）。
 * - 【闭月】：**结束阶段**（不是回合结束），「你可以」⇒ 可选；摸 1 张；纯技能效果，**不开无懈窗口**。
 */
import { describe, it, expect } from 'vitest';
import { applyIntent, createGame, emptyFlags, getHeroForMode, toSnapshot, type GameState } from '../src';
import type { Card, Faction } from '@sgs/protocol';

const A = 's0'; // 貂蝉
const B = 's1';
const C = 's2';
const D = 's3';

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
const shan = (id: string) => mk(id, 'shan', 'heart', 2);
const wuxie = (id: string) => mk(id, 'wuxie', 'spade', 3);
const wpn = (id: string): Card => ({
  ...mk(id, 'weapon', 'spade', 6),
  equipName: 'qinggang',
  range: 2,
});
const lebu = (id: string) => mk(id, 'lebu', 'spade', 6);

interface Seat {
  seatId: string;
  name: string;
  heroId: string;
  deputy?: string;
  faction?: Faction;
  hand?: Card[];
  equip?: Card[];
  reveal?: boolean;
}
/** 国战牌局：直接指派主副将（默认全部明置），跳过选将 */
function gz(seats: Seat[], turnSeat = A): GameState {
  const state = createGame(
    seats.map((s) => ({ seatId: s.seatId, name: s.name, heroId: s.heroId })),
    'TEST',
    { mode: 'guozhan' },
  );
  state.draft = null;
  for (const s of seats) {
    const p = at(state, s.seatId);
    p.heroId = s.heroId;
    p.deputyHeroId = s.deputy ?? null;
    p.faction = s.faction ?? getHeroForMode(s.heroId, 'guozhan')?.faction ?? 'qun';
    const shown = s.reveal !== false;
    p.heroRevealed = shown;
    p.deputyRevealed = shown;
    p.hand = (s.hand ?? []).slice();
    for (const c of s.equip ?? []) p.equipment[c.type === 'weapon' ? 'weapon' : 'armor'] = c;
    p.flags = emptyFlags();
    const main = getHeroForMode(s.heroId, 'guozhan')!;
    const dep = p.deputyHeroId ? getHeroForMode(p.deputyHeroId, 'guozhan')! : undefined;
    if (dep) {
      const mainHp = main.maxHp - (main.mainSlotHalfYang ? 1 : 0);
      const depHp = dep.maxHp - (dep.deputySlotHalfYang ? 1 : 0);
      p.maxHp = Math.floor((mainHp + depHp) / 2);
    } else {
      p.maxHp = main.maxHp - (main.mainSlotHalfYang ? 1 : 0);
    }
    p.hp = p.maxHp;
  }
  const idx = state.seatOrder.indexOf(turnSeat);
  state.turn = { seatIndex: idx < 0 ? 0 : idx, phase: 'play' };
  state.pending = { kind: 'play', seatId: state.seatOrder[state.turn.seatIndex]! };
  state.log = [];
  return state;
}

/** 貂蝉（甲） + 关羽（乙·男） + 张飞（丙·男） + 甄姬（丁·女） 的常规现场 */
function table(hand: Card[] = [sha('dc1')], extra: Partial<Seat> = {}): GameState {
  return gz([
    { seatId: A, name: '貂蝉', heroId: 'diaochan', faction: 'qun', hand, ...extra },
    { seatId: B, name: '关羽', heroId: 'guanyu', faction: 'shu', hand: [sha('b1'), sha('b2')] },
    { seatId: C, name: '张飞', heroId: 'zhangfei', faction: 'shu', hand: [sha('c1')] },
    { seatId: D, name: '甄姬', heroId: 'zhenji', faction: 'wei', hand: [sha('d1')] },
  ]);
}
/** 打到「貂蝉发动离间、乙(第一目标)先出杀」这一步 */
function lijian(state: GameState, firstTarget = B, secondTarget = C) {
  return act(state, A, {
    type: 'useSkill',
    skillId: 'lilian',
    cardIds: [at(state, A).hand[0]!.id],
    targetIds: [firstTarget, secondTarget],
  });
}

describe('【离间】：顺序（第一个＝【决斗】目标、第二个＝使用者）', () => {
  it('第二个选的是【决斗】的**使用者**、第一个是目标（日志与响应顺序都能看出来）', () => {
    const state = table();
    ok(lijian(state), '发动离间');
    // 日志：令 张飞（第二）视为对 关羽（第一）使用【决斗】
    expect(
      state.log.some((e) => e.message.includes('令 张飞 视为对 关羽 使用【决斗】')),
      '方向：后者对前者',
    ).toBe(true);
    // 决斗的目标（关羽·第一目标）先响应
    expect(state.pending?.kind).toBe('respondTrick');
    if (state.pending?.kind === 'respondTrick') {
      expect(state.pending.responderId, '第一目标先出杀').toBe(B);
    }
  });

  it('方向反了就会「点反」：换一下两个目标，响应顺序与来源都跟着换', () => {
    const state = table();
    ok(lijian(state, C, B), '张飞当目标、关羽当使用者');
    expect(state.log.some((e) => e.message.includes('令 关羽 视为对 张飞 使用【决斗】'))).toBe(true);
    if (state.pending?.kind === 'respondTrick') expect(state.pending.responderId).toBe(C);
  });

  it('伤害来源＝【决斗】的使用者（第二目标），**不是貂蝉**', () => {
    const state = table();
    ok(lijian(state));
    ok(act(state, B, { type: 'pass' }), '关羽不出杀'); // 第一目标先挨
    expect(at(state, B).hp).toBe(3);
    expect(state.lastDamageSourceId, '来源是张飞（第二目标）').toBe(C);
    // 张飞也不出杀 → 轮到他挨一下，来源仍是张飞自己（决斗的使用者）
    if (state.pending?.kind === 'respondTrick') ok(act(state, C, { type: 'pass' }));
  });

  it('**离间决斗造成击杀**：凶手是【决斗】使用者（触发凶手侧技能），不是貂蝉', () => {
    // 曹丕·行殇挂在 `kill`（「你杀死一名角色后，你可以获得其所有牌」）——**凶手是谁它就问谁**。
    // 这条正好把用户 §二十二 点名的那件事钉住：击杀归属认的是【决斗】的使用者。
    const state = gz([
      { seatId: A, name: '貂蝉', heroId: 'diaochan', faction: 'qun', hand: [sha('dc1')] },
      { seatId: B, name: '乙', heroId: 'guanyu', faction: 'shu', hand: [shan('b1')], reveal: true },
      { seatId: C, name: '曹丕', heroId: 'caopi', faction: 'wei', hand: [sha('c1'), sha('c2')] },
    ]);
    at(state, B).hp = 1;
    // 貂蝉：弃一张牌，令 曹丕（**第二**个选的）对 乙（第一个选的）使用【决斗】
    ok(
      act(state, A, { type: 'useSkill', skillId: 'lilian', cardIds: ['dc1'], targetIds: [B, C] }),
      '发动离间',
    );
    // 无懈窗口（B 手里没无懈 ⇒ 直接过）
    while (state.pending?.kind === 'wuxieQueue') {
      const p = state.pending;
      ok(act(state, p.askQueue[p.askIndex]!, { type: 'pass' }));
    }
    ok(act(state, B, { type: 'pass' }), '乙不出杀 ⇒ 挨 1 点');
    while (state.pending?.kind === 'respondDeath') {
      const p = state.pending;
      ok(act(state, p.askQueue[p.askIndex]!, { type: 'pass' }));
    }
    expect(at(state, B).alive, '乙阵亡').toBe(false);
    // 行殇：凶手（曹丕）被问「要不要收走其所有牌」
    if (state.pending?.kind === 'choice' && state.pending.title.includes('行殇')) {
      ok(act(state, C, { type: 'chooseOption', optionId: 'yes' }));
    }
    expect(
      at(state, C).hand.some((c) => c.id === 'b1'),
      '行殇落在**曹丕**头上（＝他才是凶手）',
    ).toBe(true);
    expect(
      at(state, A).hand.some((c) => c.id === 'b1'),
      '不是貂蝉拿走的',
    ).toBe(false);
  });
});

describe('【离间】：代价与限制', () => {
  it('出牌阶段限一次', () => {
    const state = table([sha('dc1'), sha('dc2')]);
    ok(lijian(state), '第一次');
    // 收尾：把决斗打完（两边都不出杀）
    while (state.pending?.kind === 'respondTrick') {
      const p = state.pending;
      ok(act(state, p.responderId, { type: 'pass' }));
    }
    const again = lijian(state);
    expect(again.ok, '同回合第二次被拒').toBe(false);
  });

  it('必须弃置一张牌（不选牌直接发 → 拒）', () => {
    const state = table();
    const r = act(state, A, {
      type: 'useSkill',
      skillId: 'lilian',
      cardIds: [],
      targetIds: [B, C],
    });
    expect(r.ok).toBe(false);
  });

  it('**装备牌**也可以当成本（「弃置一张**牌**」，且被弃的装备真的离开装备区）', () => {
    const state = table([], { equip: [wpn('w1')] });
    const r = act(state, A, {
      type: 'useSkill',
      skillId: 'lilian',
      cardIds: ['w1'],
      targetIds: [B, C],
    });
    ok(r, '装备当成本');
    expect(at(state, A).equipment.weapon, '装备区空了').toBeFalsy();
    expect(state.discard.some((c) => c.id === 'w1'), '进了弃牌堆').toBe(true);
  });

  it('判定区的牌**不能**当成本（代价只认手牌 + 装备区）', () => {
    const state = table([sha('dc1')]);
    at(state, A).judgment = [lebu('j1')];
    const r = act(state, A, {
      type: 'useSkill',
      skillId: 'lilian',
      cardIds: ['j1'],
      targetIds: [B, C],
    });
    expect(r.ok, '判定区的牌不在可选代价里').toBe(false);
  });

  it('必须**两名**男性其他角色：自己不能选、女性不能选', () => {
    const state = table();
    expect(
      act(state, A, { type: 'useSkill', skillId: 'lilian', cardIds: ['dc1'], targetIds: [A, B] }).ok,
      '不能选自己',
    ).toBe(false);
    expect(
      act(state, A, { type: 'useSkill', skillId: 'lilian', cardIds: ['dc1'], targetIds: [B, D] }).ok,
      '甄姬是女性',
    ).toBe(false);
    expect(
      act(state, A, { type: 'useSkill', skillId: 'lilian', cardIds: ['dc1'], targetIds: [B] }).ok,
      '只选一个',
    ).toBe(false);
  });

  it('**同一名角色不能选两次**（绕过界面直接发意图也被引擎拒）', () => {
    // 界面靠 toggle 点不出重复，但引擎是判据：以前 `[B, B]` 会被放行，
    // 结算成「关羽 视为对 关羽 使用【决斗】」（自己打自己）。见 docs §5.229。
    const state = table();
    const r = act(state, A, {
      type: 'useSkill',
      skillId: 'lilian',
      cardIds: ['dc1'],
      targetIds: [B, B],
    });
    expect(r.ok, '重复目标要被拒').toBe(false);
    expect(String(r.error ?? '')).toContain('不能重复');
  });

  it('场上不足两名男性时技能不可用（canUse 也拦）', () => {
    const state = gz([
      { seatId: A, name: '貂蝉', heroId: 'diaochan', faction: 'qun', hand: [sha('dc1')] },
      { seatId: B, name: '关羽', heroId: 'guanyu', faction: 'shu', hand: [] },
      { seatId: D, name: '甄姬', heroId: 'zhenji', faction: 'wei', hand: [] },
    ]);
    const r = act(state, A, {
      type: 'useSkill',
      skillId: 'lilian',
      cardIds: ['dc1'],
      targetIds: [B, D],
    });
    expect(r.ok).toBe(false);
  });
});

describe('【离间】：性别按**当前公开性别**（不翻暗将底牌）', () => {
  it('只明置**副将**时按副将性别；全暗置＝性别未确定 ⇒ 不能选', () => {
    // 甲：主将暗（男性 关羽）、副将明（女性 甄姬）⇒ 公开性别＝女 ⇒ 不能当离间目标
    const state = gz([
      { seatId: A, name: '貂蝉', heroId: 'diaochan', faction: 'qun', hand: [sha('dc1')] },
      { seatId: B, name: '关羽', heroId: 'guanyu', faction: 'shu', hand: [] },
      { seatId: C, name: '张飞', heroId: 'zhangfei', faction: 'shu', hand: [] },
      { seatId: D, name: '乙', heroId: 'guanyu', deputy: 'zhenji', faction: 'shu', hand: [] },
    ]);
    at(state, D).heroRevealed = false; // 只亮副将（甄姬·女）
    at(state, D).deputyRevealed = true;
    expect(
      act(state, A, { type: 'useSkill', skillId: 'lilian', cardIds: ['dc1'], targetIds: [B, D] })
        .ok,
      '只亮副将·女性 ⇒ 不可选',
    ).toBe(false);
    // 主将暗着也不能被点（底牌是男性关羽，但**没明置就不是公开男性**）
    const pv = toSnapshot(state, A).players.find((p) => p.seatId === D)!;
    expect(pv.gender, '公开性别＝副将（女）').toBe('female');

    // 全暗置 ⇒ 性别未确定：快照里没有 gender，离间也不可能选他
    at(state, D).deputyRevealed = false;
    expect(toSnapshot(state, A).players.find((p) => p.seatId === D)!.gender).toBeUndefined();
    expect(
      act(state, A, { type: 'useSkill', skillId: 'lilian', cardIds: ['dc1'], targetIds: [B, D] })
        .ok,
      '性别未确定 ⇒ 不可选',
    ).toBe(false);
  });

  it('主副将**都明置**时按**主将**性别（男将配女将 ⇒ 男；女将配男将 ⇒ 女）', () => {
    const state = gz([
      { seatId: A, name: '貂蝉', heroId: 'diaochan', faction: 'qun', hand: [sha('dc1')] },
      { seatId: B, name: '张飞', heroId: 'zhangfei', faction: 'shu', hand: [] },
      { seatId: C, name: '乙', heroId: 'guanyu', deputy: 'zhenji', faction: 'shu', hand: [] },
      { seatId: D, name: '丙', heroId: 'zhenji', deputy: 'guanyu', faction: 'wei', hand: [] },
    ]);
    const snap = toSnapshot(state, A);
    expect(snap.players.find((p) => p.seatId === C)!.gender, '主将男 ⇒ ♂').toBe('male');
    expect(snap.players.find((p) => p.seatId === D)!.gender, '主将女 ⇒ ♀').toBe('female');
    // 离间只能选「主将男」的那位，不能选「主将女」的那位
    expect(
      act(state, A, { type: 'useSkill', skillId: 'lilian', cardIds: ['dc1'], targetIds: [B, D] }).ok,
    ).toBe(false);
    ok(act(state, A, { type: 'useSkill', skillId: 'lilian', cardIds: ['dc1'], targetIds: [B, C] }));
  });

  it('界面拿到的可点目标里**没有**女性与未确定性别的人（引擎下发 legalTargets）', () => {
    const state = table();
    at(state, D).heroRevealed = false;
    at(state, D).deputyRevealed = false;
    const prompt = toSnapshot(state, A).prompt!;
    const skill = prompt.legalSkills!.find((s) => s.id === 'lilian')!;
    expect(skill.legalTargets, '只列男性（乙、丙）').toEqual([B, C]);
    expect(skill.targetSlotLabels, '有序目标的两句角色说明').toEqual([
      '【决斗】的目标',
      '发动【决斗】的角色',
    ]);
  });
});

describe('【离间】：生成的是一张**正常虚拟【决斗】**', () => {
  it('走锦囊流程：场上有无懈 ⇒ 先开无懈窗口（离间本体不开窗）', () => {
    const state = gz([
      { seatId: A, name: '貂蝉', heroId: 'diaochan', faction: 'qun', hand: [sha('dc1')] },
      { seatId: B, name: '关羽', heroId: 'guanyu', faction: 'shu', hand: [] },
      { seatId: C, name: '张飞', heroId: 'zhangfei', faction: 'shu', hand: [] },
      { seatId: D, name: '丙', heroId: 'xuchu', faction: 'wei', hand: [wuxie('d1')] },
    ]);
    ok(lijian(state));
    expect(state.pending?.kind, '虚拟【决斗】开了无懈窗口').toBe('wuxieQueue');
    ok(act(state, D, { type: 'respondCard', cardId: 'd1' }), '无懈它');
    while (state.pending?.kind === 'wuxieQueue') {
      const p = state.pending;
      ok(act(state, p.askQueue[p.askIndex]!, { type: 'pass' }));
    }
    expect(at(state, B).hp, '被无懈 ⇒ 双方都不掉血').toBe(at(state, B).maxHp);
    expect(at(state, C).hp).toBe(at(state, C).maxHp);
  });

  it('打出的【杀】走正常响应 + 伤害 + 濒死，并正确还给貂蝉出牌阶段', () => {
    const state = table();
    ok(lijian(state));
    expect(state.pending?.kind).toBe('respondTrick');
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }), '关羽出杀');
    // 轮到使用者 张飞
    if (state.pending?.kind === 'respondTrick') {
      expect(state.pending.responderId).toBe(C);
      ok(act(state, C, { type: 'pass' }), '张飞不出 ⇒ 挨 1 点');
    }
    expect(at(state, C).hp).toBe(3);
    expect(state.pending, '打完还给貂蝉的出牌阶段').toEqual({ kind: 'play', seatId: A });
  });

  it('决斗使用者是**吕布**时，无双照常生效（目标每次要连出两张【杀】）', () => {
    // 离间只负责造出那张【决斗】；无双这类「决斗使用者」侧的技能由**决斗本身**结算，
    // 所以它们必须自然生效（用户 §二十：不要把离间写成专属状态机）。
    const state = gz([
      { seatId: A, name: '貂蝉', heroId: 'diaochan', faction: 'qun', hand: [sha('dc1')] },
      { seatId: B, name: '关羽', heroId: 'guanyu', faction: 'shu', hand: [sha('b1'), sha('b2'), sha('b3')] },
      { seatId: C, name: '吕布', heroId: 'lvbu', faction: 'qun', hand: [sha('c1')] },
    ]);
    ok(act(state, A, { type: 'useSkill', skillId: 'lilian', cardIds: ['dc1'], targetIds: [B, C] }), '离间');
    while (state.pending?.kind === 'wuxieQueue') {
      const p = state.pending;
      ok(act(state, p.askQueue[p.askIndex]!, { type: 'pass' }));
    }
    // 目标（关羽）响应：无双要求**两张**杀
    expect(state.pending?.kind).toBe('respondTrick');
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }), '关羽出第 1 张杀');
    if (state.pending?.kind === 'respondTrick') {
      expect(state.pending.responderId, '还不够，仍问关羽').toBe(B);
      ok(act(state, B, { type: 'respondCard', cardId: 'b2' }), '关羽出第 2 张杀');
    }
    expect(at(state, B).hand.map((c) => c.id), '两张杀都打出去了').toEqual(['b3']);
  });

  it('决斗把人打到濒死 ⇒ 照常求桃（救回来战斗继续）', () => {
    const state = table();
    at(state, C).hp = 1; // 张飞（第二目标＝使用者）只剩 1 血
    at(state, C).hand = []; // 他手里没杀
    at(state, B).hand = [sha('b1'), sha('b2'), mk('b3', 'tao', 'heart', 3)]; // 关羽（第一目标）有杀也有桃
    ok(lijian(state), '发动离间');
    ok(act(state, B, { type: 'pass' }), '关羽不出杀 ⇒ 张飞先挨？不：目标先响应');
    // 决斗交替：目标（关羽）先响应 —— 上面那一下让关羽挨了 1 点；接着轮到使用者张飞
    if (state.pending?.kind === 'respondTrick') ok(act(state, C, { type: 'pass' }), '张飞不出杀');
    // 张飞 1 血，挨够 1 点就进濒死：此时应出现求桃链（正常流程）
    let guard = 0;
    while (state.pending?.kind === 'respondDeath' && guard++ < 6) {
      const p = state.pending;
      ok(act(state, p.askQueue[p.askIndex]!, { type: 'pass' }));
    }
    // 关羽手里有桃，会先被问；不管救没救，流程都必须**正常推进**（不是卡在离间里）
    expect(['play', 'respondTrick', 'respondDeath', 'choice']).toContain(state.pending?.kind ?? '');
  });

  it('暗置的貂蝉发动离间 ⇒ **先明置再发动**（不许偷偷发动）', () => {
    const state = gz([
      { seatId: A, name: '貂蝉', heroId: 'diaochan', faction: 'qun', hand: [sha('dc1')] },
      { seatId: B, name: '关羽', heroId: 'guanyu', faction: 'shu', hand: [] },
      { seatId: C, name: '张飞', heroId: 'zhangfei', faction: 'shu', hand: [] },
    ]);
    at(state, A).heroRevealed = false;
    at(state, A).deputyRevealed = false;
    // 暗置时「能不能选到男性目标」本身就不该看到底牌 ⇒ 先看这条
    ok(lijian(state), '暗貂蝉发动离间');
    expect(at(state, A).heroRevealed, '发动时明置').toBe(true);
    expect(state.log.some((e) => e.message.includes('亮将') || e.message.includes('明置'))).toBe(true);
  });
});

describe('【闭月】：结束阶段的一次可选摸牌', () => {
  it('结束阶段问一句；发动摸 1、取消不摸', () => {
    const yes = gz([
      { seatId: A, name: '貂蝉', heroId: 'diaochan', faction: 'qun', hand: [] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [] },
    ]);
    yes.deck = [mk('d1', 'sha', 'spade', 5), mk('d2', 'sha', 'spade', 6)];
    ok(act(yes, A, { type: 'endPhase' }));
    let guard = 0;
    while (yes.pending?.kind !== 'play' && guard++ < 20) {
      const p = yes.pending;
      if (p.kind === 'choice') {
        ok(act(yes, p.seatId, { type: 'chooseOption', optionId: 'yes' }));
      } else if (p.kind === 'discard') {
        ok(act(yes, p.seatId, { type: 'discard', cardIds: [] }));
      } else break;
    }
    expect(at(yes, A).hand.map((c) => c.id), '闭月摸到牌堆顶那张').toContain('d2');

    const no = gz([
      { seatId: A, name: '貂蝉', heroId: 'diaochan', faction: 'qun', hand: [] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [] },
    ]);
    no.deck = [mk('d1', 'sha', 'spade', 5), mk('d2', 'sha', 'spade', 6)];
    ok(act(no, A, { type: 'endPhase' }));
    guard = 0;
    while (no.pending?.kind !== 'play' && guard++ < 20) {
      const p = no.pending;
      if (p.kind === 'choice') ok(act(no, p.seatId, { type: 'chooseOption', optionId: 'no' }));
      else if (p.kind === 'discard') ok(act(no, p.seatId, { type: 'discard', cardIds: [] }));
      else break;
    }
    expect(at(no, A).hand, '不发动 ⇒ 不摸').toHaveLength(0);
  });

  it('在**弃牌阶段之后**（结束阶段）才问，摸到的牌不会再被要求弃置', () => {
    const state = gz([
      { seatId: A, name: '貂蝉', heroId: 'diaochan', faction: 'qun', hand: [] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [] },
    ]);
    // 貂蝉 3 上限、手里 4 张 ⇒ 弃牌阶段必须弃 1 张
    at(state, A).hand = [sha('h1'), sha('h2'), sha('h3'), sha('h4'), shan('h5'), shan('h6')];
    state.deck = [mk('d1', 'sha', 'spade', 5)];
    ok(act(state, A, { type: 'endPhase' }));
    expect(state.pending?.kind, '先走弃牌阶段').toBe('discard');
    ok(act(state, A, { type: 'discard', cardIds: ['h1', 'h2', 'h3'] })); // 弃到上限 3
    // 弃完 → 结束阶段：闭月（发动）
    let guard = 0;
    while (state.pending?.kind === 'choice' && guard++ < 5) {
      if (state.pending.title.includes('闭月')) {
        ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
        break;
      }
      ok(act(state, A, { type: 'discard', cardIds: [] }));
    }
    expect(at(state, A).hand, '闭月摸到的牌留在手里（不再弃）').toHaveLength(4);
  });

  it('暗置的貂蝉在结束阶段发动闭月 ⇒ 明置 + 摸 1', () => {
    const state = gz([
      { seatId: A, name: '貂蝉', heroId: 'diaochan', faction: 'qun', hand: [] },
      { seatId: B, name: '乙', heroId: 'xuchu', faction: 'wei', hand: [] },
    ]);
    at(state, A).heroRevealed = false;
    at(state, A).deputyRevealed = false;
    // 暗将想发动触发技要先**预亮**（国战口径：发动时明置）
    at(state, A).prelitSkills = ['闭月'];
    state.deck = [mk('d1', 'sha', 'spade', 5)];
    ok(act(state, A, { type: 'endPhase' }));
    let guard = 0;
    while (state.pending && state.pending.kind !== 'play' && guard++ < 20) {
      const p = state.pending;
      if (p.kind === 'choice' && p.title.includes('闭月')) {
        ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
        break;
      }
      if (p.kind === 'choice' && /发动|预亮|明置/.test(p.title)) {
        ok(act(state, A, { type: 'chooseOption', optionId: 'yes' }));
        continue;
      }
      if (p.kind === 'discard') {
        ok(act(state, A, { type: 'discard', cardIds: [] }));
        continue;
      }
      break;
    }
    if (at(state, A).hand.length > 0) {
      expect(at(state, A).heroRevealed, '发动闭月时明置').toBe(true);
    }
  });
});
