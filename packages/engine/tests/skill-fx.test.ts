/**
 * **统一的技能事件源**（用户 2026-09-25 口径①~④ 的数据侧）：
 *
 * > 缺陷：其他角色发动技能时，缺少技能名称和技能效果展示…该机制应由**统一的技能事件系统**
 * > 驱动，而不是为每个武将分别制作提示逻辑。
 *
 * 引擎侧的口径（界面那一半在 `packages/ui/src/skillTips.ts` / `components/SkillTip.tsx`）：
 *
 * - 触发技 / 主动技发动时，把 `{ 谁, 技能名, 技能拼音 id, 还在不在结算 }` 写进 `state.skillFx`
 *   并随**每一份**快照下发（公开信息：发动本来就是明面上的事）；
 * - 写入点**唯一**——`pushLog(kind === 'skill')`（这个技能真写了日志）与
 *   「这个技能发起了询问」（`setPending`）两处，都在 `withSkillCtx` 声明的技能身份下；
 *   所以**注册了钩子但没发动**的技能不会误报（本文件最后一条钉的就是这条）；
 * - 生命周期：下一次 intent 时，**已经结算完**（`settling === false`）的让位；
 *   还在等回答的留着（口径③）。
 *
 * ⚠️ 带「改动前 ✗」的用例在本特性落地前必红（那时快照里根本没有 `skillFx` 这个字段）。
 */
import { describe, it, expect } from 'vitest';
import {
  applyIntent,
  createGame,
  emptyFlags,
  getHero,
  getHeroForMode,
  HEROES,
  toSnapshot,
  type GameState,
} from '../src';
import type { Card } from '@sgs/protocol';

const A = 's0';
const B = 's1';
const C = 's2';
const ok = (r: { ok: boolean; error?: string }, tag = ''): void => {
  if (!r.ok) throw new Error(`${tag} 意图被拒：${r.error}`);
};
const act = (s: GameState, seat: string, i: Parameters<typeof applyIntent>[2]) =>
  applyIntent(s, seat, i);
const mk = (id: string, type: Card['type'], suit: Card['suit'], rank = 1): Card => ({
  id,
  type,
  suit,
  rank,
});
const sha = (id: string) => mk(id, 'sha', 'spade', 5);
const shan = (id: string) => mk(id, 'shan', 'heart', 2);
/** 红色非【杀】（武圣要转化的就是这种牌） */
const redTrick = (id: string) => mk(id, 'shunshou', 'heart', 3);

/**
 * 国战牌局：直接指定武将牌（绕开选将），默认甲的出牌阶段；武将默认**已明置**。
 *
 * ⚠️ `deck` 一定要给：判定牌是从牌堆顶（`deck.pop()`）摸的，用随机牌堆会让
 *    「刚烈判红桃则无效」那类分支时有时无——用例必须每次都走进同一条分支。
 */
function gz(
  seats: { seatId: string; name: string; heroId: string; deputy?: string; hand?: Card[] }[],
  turnSeat = A,
  deck: Card[] = [],
): GameState {
  const state = createGame(
    seats.map((s) => ({ seatId: s.seatId, name: s.name, heroId: s.heroId })),
    'TEST',
    { mode: 'guozhan' },
  );
  state.draft = null;
  state.deck = deck.slice();
  for (const s of seats) {
    const p = state.players.find((x) => x.seatId === s.seatId)!;
    p.heroId = s.heroId;
    p.deputyHeroId = s.deputy ?? s.heroId;
    p.maxHp = 5;
    p.hp = 5;
    p.faction = getHero(s.heroId)!.faction;
    p.hand = (s.hand ?? []).slice();
    p.flags = emptyFlags();
    p.heroRevealed = true;
    p.deputyRevealed = true;
  }
  const idx = state.seatOrder.indexOf(turnSeat);
  state.turn = { seatIndex: idx < 0 ? 0 : idx, phase: 'play' };
  state.pending = { kind: 'play', seatId: state.seatOrder[state.turn.seatIndex]! };
  state.log = [];
  return state;
}
const at = (state: GameState, seatId: string) => state.players.find((p) => p.seatId === seatId)!;

describe('主动技：发动时写下结构化技能事件', () => {
  it('孙权发动【制衡】⇒ 快照里出现 skillFx（改动前 ✗：快照没有这个字段）', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'sunquan', hand: [sha('a1'), sha('a2')] },
      { seatId: B, name: '乙', heroId: 'vanilla' },
    ]);
    expect(toSnapshot(state, A).skillFx ?? null, '开局：没有技能在跑').toBe(null);
    ok(
      act(state, A, { type: 'useSkill', skillId: 'zhiheng', cardIds: ['a1'], targetIds: [] }),
      '制衡',
    );
    const fx = toSnapshot(state, A).skillFx;
    expect(fx).toBeTruthy();
    expect(fx!.seatId, '谁发的').toBe(A);
    expect(fx!.skillName, '技能名（界面靠它显示与查描述）').toBe('制衡');
    expect(fx!.skillId, '主动技有拼音 id').toBe('zhiheng');
    // 制衡是同步结算（弃一张、摸一张），没有留下询问
    expect(fx!.settling, '没人被问话 ⇒ 已结算完，界面按「短暂显示」收尾').toBe(false);
    // 序号自增：界面靠它认出「新的一次发动」
    expect(fx!.seq).toBeGreaterThan(0);
  });

  it('同一份状态对**所有人**下发同一条事件（别人发动我也看得到）', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'sunquan', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla' },
      { seatId: C, name: '丙', heroId: 'vanilla' },
    ]);
    ok(act(state, A, { type: 'useSkill', skillId: 'zhiheng', cardIds: ['a1'], targetIds: [] }));
    for (const seat of [A, B, C]) {
      expect(toSnapshot(state, seat).skillFx?.skillName, `${seat} 的快照`).toBe('制衡');
    }
  });

  it('只带该带的字段：没有武将牌信息，暗将不会因为这条提示泄露', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'sunquan', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla' },
    ]);
    ok(act(state, A, { type: 'useSkill', skillId: 'zhiheng', cardIds: ['a1'], targetIds: [] }));
    expect(Object.keys(toSnapshot(state, B).skillFx!).sort()).toEqual(
      ['seatId', 'seq', 'settling', 'skillId', 'skillName'].sort(),
    );
  });
});

describe('触发技：真的发动才写事件，注册了但没发动的不写', () => {
  it('张飞第 1 张【杀】：咆哮没发动 ⇒ 没有事件（改动前 ✗）', () => {
    const state = gz([
      // 副将用「平民」（没有任何技能）：本例只想看【咆哮】这一条，
      // 别让副将的触发技（马超·铁骑那种）把事件写进去
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        deputy: 'vanilla',
        hand: [sha('a1'), sha('a2')],
      },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [shan('b1'), shan('b2')] },
    ]);
    state.pending = { kind: 'play', seatId: A };
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }), '第 1 张杀');
    ok(act(state, B, { type: 'pass' }), '乙不闪');
    expect(
      state.log.some((l) => l.message.includes('咆哮')),
      '第 1 张杀不该有咆哮日志',
    ).toBe(false);
    expect(toSnapshot(state, A).skillFx ?? null, '没发动 ⇒ 不提示').toBe(null);
  });

  it('张飞第 2 张【杀】：咆哮发动（钩子写了日志）⇒ 事件出现，且是甲这一座', () => {
    const state = gz([
      {
        seatId: A,
        name: '甲',
        heroId: 'zhangfei',
        deputy: 'vanilla',
        hand: [sha('a1'), sha('a2')],
      },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [shan('b1'), shan('b2'), shan('b3')] },
    ]);
    state.pending = { kind: 'play', seatId: A };
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }), '第 1 张杀');
    ok(act(state, B, { type: 'pass' }), '乙不闪');
    state.skillFx = null; // 清掉上一张杀留下的（本例只想看第 2 张）
    ok(act(state, A, { type: 'playCard', cardId: 'a2', targetIds: [B] }), '第 2 张杀');
    expect(
      state.log.some((l) => l.message.includes('咆哮')),
      '第 2 张杀：咆哮真的发动了',
    ).toBe(true);
    expect(toSnapshot(state, A).skillFx?.skillName).toBe('咆哮');
    expect(toSnapshot(state, B).skillFx?.seatId, '乙也看得到「谁发的」').toBe(A);
  });
});

describe('「先问再结算」的技能：询问一出现就提示，并保持到答完', () => {
  it('甲杀乙（夏侯惇）⇒ 乙的【刚烈】在询问出现的那一刻就写下事件，且 settling=true（改动前 ✗）', () => {
    const state = gz(
      [
        { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1'), sha('a3')] },
        { seatId: B, name: '乙', heroId: 'xiahoudun', deputy: 'vanilla', hand: [] },
      ],
      A,
      [mk('j1', 'sha', 'spade', 7)],
    ); // 判定牌固定：黑桃 ⇒ 不判红桃 ⇒ 刚烈照常生效
    state.pending = { kind: 'play', seatId: A };
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }), '杀');
    ok(act(state, B, { type: 'pass' }), '乙不闪（手里也没有）');
    // 刚烈：先判定（判红桃才无效，这里判什么无所谓），非红桃 ⇒ 问伤害来源选一项
    const pending = state.pending;
    expect(pending?.kind, '刚烈把询问挂给了甲').toBe('choice');
    const fx = toSnapshot(state, A).skillFx;
    expect(fx?.skillName, '询问出现时就已经宣告了是【刚烈】').toBe('刚烈');
    expect(fx?.seatId, '发动者是乙（挨打的那位）').toBe(B);
    expect(fx?.settling, '有人被问话 ⇒ 界面保持提示（口径③）').toBe(true);
  });

  it('答完之后 settling 变 false（界面据此按「结算完」收尾）；再下一次 intent 让位', () => {
    const state = gz(
      [
        { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1'), sha('a3'), sha('a4')] },
        { seatId: B, name: '乙', heroId: 'xiahoudun', deputy: 'vanilla', hand: [] },
      ],
      A,
      [mk('j1', 'sha', 'spade', 7)],
    ); // 判定牌固定：黑桃 ⇒ 不判红桃 ⇒ 刚烈照常生效
    state.pending = { kind: 'play', seatId: A };
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }), '杀');
    ok(act(state, B, { type: 'pass' }), '乙不闪');
    const p = state.pending;
    if (p?.kind !== 'choice') throw new Error('刚烈没有把询问挂给甲');
    ok(act(state, A, { type: 'chooseOption', optionId: 'damage' }), '甲选择受到 1 点伤害');
    expect(toSnapshot(state, A).skillFx?.skillName, '事件还在（让位发生在下一次 intent）').toBe(
      '刚烈',
    );
    expect(toSnapshot(state, A).skillFx?.settling, '已经没人被问话 ⇒ 结算完了').toBe(false);
    ok(act(state, A, { type: 'endPhase' }), '下一次 intent');
    expect(toSnapshot(state, A).skillFx ?? null, '结算完的提示让位（口径④）').toBe(null);
  });

  it('还在等回答时**不**让位：答另一个询问之后提示仍在（口径③）', () => {
    const state = gz(
      [
        { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1'), sha('a3')] },
        { seatId: B, name: '乙', heroId: 'xiahoudun', deputy: 'vanilla', hand: [] },
      ],
      A,
      [mk('j1', 'sha', 'spade', 7)],
    ); // 判定牌固定：黑桃 ⇒ 不判红桃 ⇒ 刚烈照常生效
    state.pending = { kind: 'play', seatId: A };
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }), '杀');
    ok(act(state, B, { type: 'pass' }), '乙不闪');
    const before = toSnapshot(state, A).skillFx;
    expect(before?.settling).toBe(true);
    // 甲选了「弃两张手牌」这条：里面还会再问一次「弃哪两张」——两次询问之间提示都不许消失
    ok(act(state, A, { type: 'chooseOption', optionId: 'discard' }), '甲选择弃牌');
    const mid = toSnapshot(state, A).skillFx;
    expect(mid?.skillName, '多步结算中途提示仍在').toBe('刚烈');
    expect(mid?.settling, '还在问（选弃哪两张）').toBe(true);
    expect(mid?.seq, '同一次发动，不重播').toBe(before?.seq);
  });
});

describe('settling 的口径：只有「在等回答」才算没结算完', () => {
  it('出牌阶段的占位空位不算（没人被问话）', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'sunquan', hand: [sha('a1'), sha('a2')] },
      { seatId: B, name: '乙', heroId: 'vanilla' },
    ]);
    ok(act(state, A, { type: 'useSkill', skillId: 'zhiheng', cardIds: ['a1'], targetIds: [] }));
    expect(state.pending?.kind, '回到出牌阶段').toBe('play');
    expect(toSnapshot(state, A).skillFx?.settling).toBe(false);
  });
});

/**
 * **覆盖守门**（用户口径④「必须由统一的技能事件系统驱动」）：
 * `HookRegistration.skillId` 不只是提示的入口——它同时是国战**预亮名单**的键
 * （`prelitableSkills` 的 `hookedNames`）与主将技/副将技的过滤键（`collectTimingHooks`）。
 * 一个钩子漏了它，就是「这个技能既不会提示、也不能预亮」：国战里暗置时它等于不存在。
 */
describe('覆盖守门：所有触发技钩子都声明了 skillId（统一事件源的入口）', () => {
  const MODES = ['junzheng', '2v2', 'melee', 'guozhan'] as const;

  it('没有漏网的钩子（漏一个就少一个技能：不提示 + 不可预亮）', () => {
    const missing: string[] = [];
    for (const h of HEROES) {
      for (const mode of MODES) {
        const hero = getHeroForMode(h.id, mode);
        if (!hero) continue;
        for (const hook of hero.hooks ?? []) {
          if (!hook.skillId) missing.push(`${hero.id}/${mode}:${hook.timing}`);
        }
      }
    }
    expect(missing, '这些钩子缺 skillId（同时也会从国战预亮名单里消失）').toEqual([]);
  });
});

/**
 * 国战版【洛神】/【裸衣】的钩子原本**漏了 skillId**：它们是这两个技能在国战里的唯一入口，
 * 漏掉之后暗置时预亮名单里没有它们（`prelitableSkills` 认 skillId），预亮了也不会问
 * ——与 §5.10 记的机制（触发技＝预亮 + 时机询问）不一致；提示那边自然也什么都没有。
 */
describe('国战版【洛神】：暗置预亮 → 询问 + 技能提示（改动前 ✗：钩子缺 skillId，两边都断）', () => {
  it('预亮【洛神】后轮到自己的准备阶段：问「是否明置并发动」，并把 skillFx 下发给所有人', () => {
    const state = gz(
      [
        { seatId: A, name: '甲', heroId: 'zhenji' },
        { seatId: B, name: '乙', heroId: 'vanilla' },
      ],
      B, // 先走乙的回合，结束它 ⇒ 轮到甲的准备阶段（turnStart）
      [sha('d1'), sha('d2')],
    );
    const a = at(state, A);
    a.heroRevealed = false;
    a.deputyRevealed = false;
    ok(act(state, A, { type: 'prelightSkill', skillName: '洛神' }), '预亮');
    expect(a.prelitSkills).toEqual(['洛神']);
    expect(a.heroRevealed, '预亮本身不明置').toBe(false);

    ok(act(state, B, { type: 'endPhase' }), '乙结束回合');

    // 国战准备阶段的通用入口先出现（「是否明置武将牌？」）——它不属于本特性，答「暂不明置」
    ok(act(state, A, { type: 'chooseOption', optionId: 'none' }), '暂不明置');

    expect(state.pending?.kind, '预亮的非锁定技：先问是否明置并发动').toBe('choice');
    const title = state.pending?.kind === 'choice' ? state.pending.title : '';
    expect(title).toContain('洛神');
    expect(title, '问的是「明置并发动」').toContain('明置');
    expect(a.heroRevealed, '还没答「发动」之前不许明置').toBe(false);

    // 提示那一半：别人（乙）的快照同样看得到「甲 发动【洛神】」，且此刻还在等回答
    const seen = toSnapshot(state, B).skillFx;
    expect(seen?.skillName).toBe('洛神');
    expect(seen?.seatId).toBe(A);
    expect(seen?.settling, '正在等甲回答 ⇒ 界面保持提示').toBe(true);
  });
});

/**
 * **转化技也是「发动技能」**（用户 2026-09-25 口径①的补漏）：【武圣】【龙胆】【倾国】
 * 【看破】【奇袭】【急救】… 这类技能既没有主动技的 `execute`、也没有钩子，所以不经过
 * 技能事件源原有的两条入口（`withSkillCtx` 包着的技能日志、`setPending` 的技能询问）。
 * 它们在引擎里的落点是「一张牌被转化着打出去」的那 7 处（`announceConversion`），
 * 仍然是**一个函数管全部转化技**，不是给每个武将写一份提示。
 *
 * ⚠️ 反例与正例同样重要：`canUseAs` 是**武将级**谓词（武圣＝「红牌」），真【杀】当【杀】
 * 打、真【闪】当【闪】打也满足它——那样报技能名就是**误报**。用例两头都钉。
 */
describe('转化技：转化也是「发动技能」，走同一个事件源', () => {
  it('关羽用【武圣】把红牌当【杀】使用 ⇒ skillFx 是武圣（改动前 ✗：转化一个字都不报）', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'guanyu', hand: [redTrick('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla' },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B], as: 'sha' }));
    // 别人（乙）也看得到——这正是用户报的那条缺陷
    const seen = toSnapshot(state, B).skillFx;
    expect(seen?.skillName).toBe('武圣');
    expect(seen?.seatId).toBe(A);
    // 这张【杀】打完就问乙「是否出闪」⇒ 正在等回答，提示**保持**（口径③）。
    // 这一格是 setPending 里的 syncSkillSettling 续上的，说明转化提示也吃同一条保持规则
    expect(seen?.settling).toBe(true);
  });

  it('反例：真【杀】当【杀】打，不报技能（武圣的「红牌」对红【杀】也成立，别误报）', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'guanyu', hand: [mk('a1', 'sha', 'heart', 5)] },
      { seatId: B, name: '乙', heroId: 'vanilla' },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    expect(toSnapshot(state, A).skillFx, '没转化就没提示').toBeNull();
  });

  it('赵云用【龙胆】把【杀】当【闪】打出 ⇒ skillFx 是龙胆（响应那条落点）', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'zhaoyun', hand: [sha('b1')] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    expect(state.pending?.kind).toBe('respondSha');
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }), '龙胆：杀当闪');
    const seen = toSnapshot(state, A).skillFx;
    expect(seen?.skillName).toBe('龙胆');
    expect(seen?.seatId).toBe(B);
  });

  it('反例：真【闪】当【闪】打出，不报', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [sha('a1')] },
      { seatId: B, name: '乙', heroId: 'zhaoyun', hand: [shan('b1')] },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }));
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    expect(toSnapshot(state, A).skillFx).toBeNull();
  });

  it('卧龙诸葛亮：红牌当【火攻】报火计、黑牌当【无懈】报看破（一个人两个转化技，要报对）', () => {
    // ① 出牌阶段：红牌当【火攻】
    const s1 = gz([
      { seatId: A, name: '甲', heroId: 'wolong', hand: [redTrick('a1')] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [shan('b1')] },
    ]);
    ok(act(s1, A, { type: 'playCard', cardId: 'a1', targetIds: [B], as: 'huogong' }));
    expect(toSnapshot(s1, B).skillFx?.skillName, '火计而不是看破').toBe('火计');

    // ② 无懈窗口：黑牌当【无懈可击】→ 看破
    const s2 = gz([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [mk('a1', 'wuzhong', 'heart', 3)] },
      { seatId: B, name: '乙', heroId: 'wolong', hand: [mk('b1', 'shan', 'spade', 2)] },
    ]);
    ok(act(s2, A, { type: 'playCard', cardId: 'a1', targetIds: [A] }));
    expect(s2.pending?.kind, '无中生有的无懈窗口').toBe('wuxieQueue');
    while (s2.pending?.kind === 'wuxieQueue' && s2.pending.askQueue[s2.pending.askIndex] !== B) {
      ok(act(s2, s2.pending.askQueue[s2.pending.askIndex]!, { type: 'pass' }));
    }
    ok(act(s2, B, { type: 'respondCard', cardId: 'b1' }), '看破：黑牌当无懈');
    expect(toSnapshot(s2, A).skillFx?.skillName, '看破而不是火计').toBe('看破');
  });

  it('反例：【无懈可击·国】本来就是当【无懈可击】打的，不算转化（不报看破）', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'vanilla', hand: [mk('a1', 'wuzhong', 'heart', 3)] },
      {
        seatId: B,
        name: '乙',
        heroId: 'wolong',
        hand: [mk('b1', 'wuxieguo', 'spade', 2)], // 黑色的【无懈可击·国】
      },
    ]);
    ok(act(state, A, { type: 'playCard', cardId: 'a1', targetIds: [A] }));
    while (state.pending?.kind === 'wuxieQueue' && state.pending.askQueue[state.pending.askIndex] !== B) {
      ok(act(state, state.pending.askQueue[state.pending.askIndex]!, { type: 'pass' }));
    }
    ok(act(state, B, { type: 'respondCard', cardId: 'b1' }));
    expect(toSnapshot(state, A).skillFx, '牌自己的用法，不是技能转化').toBeNull();
  });

  it('反例：【酒】濒死当【桃】自救也不算转化（华佗的急救不该被报出来）', () => {
    const state = gz([
      { seatId: A, name: '甲', heroId: 'huatuo', hand: [mk('a1', 'jiu', 'heart', 5)] },
      { seatId: B, name: '乙', heroId: 'vanilla', hand: [sha('b1')] },
    ]);
    const a = at(state, A);
    a.hp = 1;
    state.turn = { seatIndex: state.seatOrder.indexOf(B)!, phase: 'play' };
    state.pending = { kind: 'play', seatId: B };
    ok(act(state, B, { type: 'playCard', cardId: 'b1', targetIds: [A] }));
    ok(act(state, A, { type: 'pass' }), '不闪');
    expect(state.pending?.kind).toBe('respondDeath');
    ok(act(state, A, { type: 'respondCard', cardId: 'a1' }), '酒当桃自救');
    expect(a.hp).toBe(1);
    expect(toSnapshot(state, B).skillFx, '酒自己的用法，不是急救').toBeNull();
  });

  it('覆盖守门：每个「多转化技」的武将都必须声明 conversionTypes（否则技能名会报错）', () => {
    const missing: string[] = [];
    const MODES = ['junzheng', '2v2', 'melee', 'guozhan'] as const;
    for (const h of HEROES) {
      for (const mode of MODES) {
        const hero = getHeroForMode(h.id, mode);
        if (!hero) continue;
        const names = Object.entries(hero.skillFields ?? {})
          .filter(([, f]) => f.includes('canUseAs'))
          .map(([n]) => n);
        if (names.length < 2) continue;
        const declared = hero.conversionTypes ?? {};
        for (const n of names) {
          if (!declared[n]?.length) missing.push(`${hero.id}/${mode}:${n}`);
        }
      }
    }
    expect(missing, '多个转化技的武将必须说清各自提供哪个牌型').toEqual([]);
  });
});
