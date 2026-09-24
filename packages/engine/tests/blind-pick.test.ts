/**
 * **通用「隐藏手牌盲选」机制**（用户 2026-09-22 报的缺陷 + 规格）。
 *
 * 设计契约（规格原文的口径）：**规则层负责决定「可以操作谁的哪些牌」，界面层负责根据
 * 当前玩家的可见权限决定展示牌面还是牌背。** 落到代码上是三件事：
 *
 *  1. 技能侧只说「这是**别人的未知手牌**」——`api.askPickCards(..., { hidden: true, ownerSeatId })`。
 *     不针对张辽【突袭】单写一套（它只是第一个用户）。
 *  2. **牌面绝不出服务端**：`legal.ts` 在 `hidden` 时把候选剥成 `{ id }`；界面按 `pickHidden`
 *     画牌背。这一条是本文件钉的重点——「不发」比「发了让界面别显示」可靠得多。
 *  3. 其中**已经因其他效果公开**的那几张（`visibleIds`）照常画牌面，其余仍是牌背。
 *
 * 引擎侧的「谁看得见」另一半（观察者快照里手牌只有张数）由既有用例覆盖，这里只管盲选。
 */
import { describe, it, expect } from 'vitest';
import {
  applyIntent,
  buildPrompt,
  createGame,
  emptyFlags,
  targetCardOptions,
  type GameState,
} from '../src';
import { askPickCards } from '../src/engine';
import type { Card } from '@sgs/protocol';

const A = 's0';
const B = 's1';
const C = 's2';
const mk = (id: string, type: Card['type'], suit: Card['suit'], rank = 1): Card => ({
  id,
  type,
  suit,
  rank,
});

/** 国战局：甲（关羽）乙（张辽）丙。选将跳过、全部已明置、手牌清空后按需摆放。 */
function gz(): GameState {
  const state = createGame(
    [
      { seatId: A, name: '甲', heroId: 'guanyu' },
      { seatId: B, name: '乙', heroId: 'zhangliao' },
      { seatId: C, name: '丙', heroId: 'caocao' },
    ],
    'TEST',
    { mode: 'guozhan' },
  );
  state.draft = null;
  // ⚠️ 必须显式写 heroId：`createGame` 不落将（那是选将阶段的事），不写的话摸牌阶段
  //    根本不会问【突袭】——用例会静默地整段跑空（踩过：pending 直接是乙的出牌阶段）。
  const HERO: Record<string, string> = { [A]: 'guanyu', [B]: 'zhangliao', [C]: 'caocao' };
  for (const p of state.players) {
    p.heroId = HERO[p.seatId]!;
    p.deputyHeroId = null;
    p.heroRevealed = true;
    p.deputyRevealed = true;
    p.maxHp = 4;
    p.hp = 4;
    p.hand = [];
    p.flags = emptyFlags();
  }
  state.log = [];
  return state;
}

/** 把回合交给乙（甲的出牌阶段结束），乙的摸牌阶段会问【突袭】 */
function toDrawPhaseOfB(state: GameState): void {
  state.turn = { seatIndex: 0, phase: 'play' };
  state.pending = { kind: 'play', seatId: A };
  expect(applyIntent(state, A, { type: 'endPhase' }).ok).toBe(true);
  expect(state.pending?.kind).toBe('choice');
  if (state.pending?.kind !== 'choice') throw new Error('应为【突袭】的发动询问');
  expect(state.pending.title).toContain('突袭');
}

const seat = (state: GameState, seatId: string) => state.players.find((p) => p.seatId === seatId)!;

describe('盲选：牌面不出服务端（用户 2026-09-22）', () => {
  it('【突袭】的下发只有 id：候选牌不带牌名/花色/点数，且标了在看谁的手牌', () => {
    const state = gz();
    const c = seat(state, C);
    // 丙的两张手牌刻意用**不同花色点数**：只要漏发一张牌面，下面的断言就能逮住
    c.hand = [mk('c1', 'sha', 'heart', 13), mk('c2', 'tao', 'spade', 7)];
    toDrawPhaseOfB(state);
    expect(applyIntent(state, B, { type: 'chooseOption', optionId: 'yes' }).ok).toBe(true);
    // 候选只有丙
    expect(applyIntent(state, B, { type: 'chooseOption', optionId: C }).ok).toBe(true);
    expect(state.pending?.kind).toBe('pickCards');

    const prompt = buildPrompt(state, B);
    expect(prompt?.kind).toBe('pickCards');
    expect(prompt?.pickHidden, '盲选必须标记，界面据此画牌背').toBe(true);
    expect(prompt?.pickOwnerSeatId, '界面要能说清「在看谁的手牌」').toBe(C);
    expect(prompt?.pickVisibleIds, '本轮没有已公开的牌').toBeUndefined();
    // ⭐ 核心断言：**每一张候选只有一个 id**，没有任何牌面字段
    expect(prompt?.pickCards?.map((x) => Object.keys(x).sort())).toEqual([['id'], ['id']]);
    expect(prompt?.pickCards?.map((x) => x.id).sort()).toEqual(['c1', 'c2']);
    // 整份下发里都不该出现牌面信息（防止换个字段名漏出去）
    const raw = JSON.stringify(prompt);
    expect(raw).not.toContain('"heart"');
    expect(raw).not.toContain('"spade"');
    expect(raw).not.toContain('13');
    expect(raw).not.toContain('7');
  });

  it('别人的快照里连这个询问都没有（拿不到候选，也拿不到牌面）', () => {
    const state = gz();
    const c = seat(state, C);
    c.hand = [mk('c1', 'sha', 'heart', 13), mk('c2', 'tao', 'spade', 7)];
    const b = seat(state, B);
    toDrawPhaseOfB(state);
    applyIntent(state, B, { type: 'chooseOption', optionId: 'yes' });
    applyIntent(state, B, { type: 'chooseOption', optionId: C });
    expect(state.pending?.kind).toBe('pickCards');

    for (const other of [A, C]) {
      const p = buildPrompt(state, other);
      // 不是他的询问 ⇒ 没有提示；退一步说，即使有别的提示也不含候选牌面
      if (p) expect(JSON.stringify(p)).not.toContain('c1');
      expect(p?.pickHidden).toBeUndefined();
      expect(p?.pickCards).toBeUndefined();
    }
    // 连丙本人也看不到自己的这两张牌进了候选列表（他不该知道自己被挑了哪张）
    expect(buildPrompt(state, C)?.pickCards).toBeUndefined();
  });

  it('按 id 选择后牌真的易主（牌面没下发也不影响结算）', () => {
    const state = gz();
    const c = seat(state, C);
    c.hand = [mk('c1', 'sha', 'heart', 13), mk('c2', 'tao', 'spade', 7)];
    const b = seat(state, B);
    state.deck.push(mk('d1', 'sha', 'club', 1));
    toDrawPhaseOfB(state);
    applyIntent(state, B, { type: 'chooseOption', optionId: 'yes' });
    applyIntent(state, B, { type: 'chooseOption', optionId: C });
    expect(state.pending?.kind).toBe('pickCards');
    expect(applyIntent(state, B, { type: 'pickCards', cardIds: ['c1'] }).ok).toBe(true);
    expect(c.hand.map((x) => x.id)).toEqual(['c2']);
    expect(b.hand.map((x) => x.id)).toContain('c1');
    // ⚠️ 真机验收时抓到的第二条泄露：日志是**发给全场**的。选牌收口那句原来无条件写牌名
    //    （`选择了 【红桃13·杀】`），等于把对手的手牌公开给所有人。盲选必须与秘密选牌同款：
    //    只记张数。
    const logs = state.log.map((e) => e.message).join('|');
    expect(logs).not.toContain('红桃');
    expect(logs).not.toContain('杀');
    expect(logs).toMatch(/选择了 1 张牌/);
  });
});

describe('盲选：已公开的牌照常画牌面（规格「已公开的手牌按可见性显示」）', () => {
  it('visibleIds 命中的候选保留完整牌面，其余仍只有 id', () => {
    const state = gz();
    const c = seat(state, C);
    c.hand = [mk('c1', 'sha', 'heart', 13), mk('c2', 'tao', 'spade', 7)];
    state.turn = { seatIndex: 1, phase: 'draw' };

    // 直接摆一个盲选询问：c1 因别的效果**已公开**（例如刚被【火攻】展示过）
    askPickCards(
      state,
      B,
      '【测试】：选择获得 丙 的一张手牌',
      c.hand.slice(),
      1,
      1,
      () => {},
      { hidden: true, ownerSeatId: C, visibleIds: ['c1'] },
    );

    const prompt = buildPrompt(state, B);
    expect(prompt?.pickHidden).toBe(true);
    expect(prompt?.pickOwnerSeatId).toBe(C);
    expect(prompt?.pickVisibleIds).toEqual(['c1']);
    const byId = new Map(prompt?.pickCards?.map((x) => [x.id, x]));
    // 已公开的那张：牌面完整
    expect(byId.get('c1')?.type).toBe('sha');
    expect(byId.get('c1')?.suit).toBe('heart');
    expect(byId.get('c1')?.rank).toBe(13);
    // 没公开的那张：只有 id
    expect(Object.keys(byId.get('c2')!).sort()).toEqual(['id']);
  });
});

describe('盲选：机制是通用的（不是给【突袭】单开的口子）', () => {
  /**
   * 【征戎】（君曹操）：发动者从**别人**的手里挑牌换掉 —— 同一个缺陷类，必须同一条原语。
   * 这条同时是「一个原语、多个技能」的守门：谁要是把盲选写回某个技能内部，这里会红。
   */
  it('【征戎】选替换哪些手牌时，候选同样只有 id', () => {
    const state = createGame(
      [
        { seatId: A, name: '甲', heroId: 'juncaocao' },
        { seatId: B, name: '乙', heroId: 'guanyu' },
        { seatId: C, name: '丙', heroId: 'zhangliao' },
      ],
      'TEST',
      { mode: 'guozhan' },
    );
    state.draft = null;
    const set = (seatId: string, heroId: string, hand: Card[], hp = 4) => {
      const p = seat(state, seatId);
      p.heroId = heroId;
      p.heroRevealed = true;
      p.deputyRevealed = false;
      p.maxHp = 4;
      p.hp = hp;
      p.hand = hand;
      p.flags = emptyFlags();
    };
    set(A, 'juncaocao', [], 2); // 已损失 2 点 → X = 2
    set(B, 'guanyu', [mk('b1', 'tao', 'heart', 9), mk('b2', 'guohe', 'spade', 3), mk('b4', 'sha', 'club', 4)]);
    set(C, 'zhangliao', []);
    state.deck = [mk('d1', 'shan', 'diamond', 1), mk('d2', 'sha', 'club', 5)];
    state.turn = { seatIndex: 1, phase: 'play' };
    state.pending = { kind: 'play', seatId: B };
    state.log = [];

    expect(applyIntent(state, B, { type: 'playCard', cardId: 'b4', targetIds: [A] }).ok).toBe(true);
    expect(applyIntent(state, A, { type: 'pass' }).ok).toBe(true);
    expect(seat(state, A).hp).toBe(1);
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind !== 'choice') throw new Error('应为【征戎】的选择');
    expect(state.pending.title).toContain('征戎');
    expect(applyIntent(state, A, { type: 'chooseOption', optionId: B }).ok).toBe(true);
    expect(state.pending?.kind).toBe('pickCards');

    const prompt = buildPrompt(state, A);
    expect(prompt?.pickHidden).toBe(true);
    expect(prompt?.pickOwnerSeatId).toBe(B); // 在看**乙**的手牌
    expect(prompt?.pickCards?.map((x) => Object.keys(x))).toEqual([['id'], ['id']]);
    expect(JSON.stringify(prompt)).not.toContain('"heart"');
    expect(JSON.stringify(prompt)).not.toContain('"guohe"');
    // 乙本人也拿不到这个询问（是他被换牌，不是他选牌）
    expect(buildPrompt(state, B)?.pickCards).toBeUndefined();
  });
});

describe('盲选：混区域的候选（手牌隐藏 + 装备公开）', () => {
  /**
   * 【反馈】（司马懿）：候选是**伤害来源的牌**——手牌是未知信息（画牌背），装备区是公开区
   * （照常画牌面）。这是 `pickVisibleIds` 的第一个生产用例：「已公开的手牌按可见性显示」
   * 这条规格在**混区域**候选上的落法（可见性由规则层判，界面不猜）。
   */
  it('手牌只有 id、装备保留完整牌面，两者在同一份候选里', () => {
    const state = createGame(
      [
        { seatId: A, name: '甲', heroId: 'vanilla' },
        { seatId: B, name: '乙', heroId: 'simayi' },
      ],
      'TEST',
    );
    state.draft = null;
    for (const p of state.players) {
      p.heroRevealed = true;
      p.deputyRevealed = true;
      p.maxHp = 4;
      p.hp = 4;
      p.hand = [];
      p.flags = emptyFlags();
    }
    const a = seat(state, A);
    const b = seat(state, B);
    b.heroId = 'simayi'; // 受伤者 = 挑牌的人
    a.hand = [mk('a1', 'sha', 'spade', 7), mk('a2', 'tao', 'heart', 9)];
    a.equipment.armor = mk('ar1', 'armor', 'heart', 1);
    state.turn = { seatIndex: 0, phase: 'play' };
    state.pending = { kind: 'play', seatId: A };

    // 甲对乙出【杀】→ 乙不闪、受到 1 点伤害 → 反馈先问是否发动
    expect(applyIntent(state, A, { type: 'playCard', cardId: 'a1', targetIds: [B] }).ok).toBe(true);
    expect(applyIntent(state, B, { type: 'pass' }).ok).toBe(true);
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind !== 'choice') throw new Error('应为【反馈】的发动询问');
    expect(applyIntent(state, B, { type: 'chooseOption', optionId: 'yes' }).ok).toBe(true);
    expect(state.pending?.kind).toBe('pickCards');

    const prompt = buildPrompt(state, B);
    expect(prompt?.pickHidden, '反馈的候选里手牌是未知的').toBe(true);
    expect(prompt?.pickOwnerSeatId).toBe(A);
    expect(prompt?.pickVisibleIds, '装备区是公开区 → 照常画牌面').toEqual(['ar1']);
    const byId = new Map(prompt?.pickCards?.map((x) => [x.id, x]));
    // 手牌 a2：只有 id（a1 已经打出去了，不在候选里）
    expect(Object.keys(byId.get('a2')!).sort()).toEqual(['id']);
    // 装备 ar1：完整牌面
    expect(byId.get('ar1')?.type).toBe('armor');
    expect(byId.get('ar1')?.suit).toBe('heart');
    expect(byId.get('ar1')?.rank).toBe(1);
    // 结算照旧：拿装备
    expect(applyIntent(state, B, { type: 'pickCards', cardIds: ['ar1'] }).ok).toBe(true);
    expect(a.equipment.armor).toBeNull();
    expect(b.hand.map((c) => c.id)).toContain('ar1');
  });
});

/**
 * **自己操作自己的牌 ⇒ 不许盲选**（用户 2026-09-25 报的缺陷：陈武董袭【奋命】要弃自己的牌时
 * 系统直接随机/按「第 N 张暗牌」处理，玩家挑不了）。
 *
 * 盲选的适用前提是「候选来自**别人的未知手牌**」。自己的手牌自己是知道的，
 * 所以选项必须是**真牌面**（`card:<id>`），文案也要写「你的【…】」而不是「其第 N 张（暗）」。
 * 这条直接钉在共用原语 `targetCardOptions` 上——它是「从某人的区域里挑一张」的唯一出口，
 * 修在这里 ⇒ 所有用它（或它的两个包装 `pickOneOfTargetCards` / `takeOneOfTargetCards`）的技能
 * 一起生效，不是给某个武将打补丁。
 */
describe('自己操作自己的牌：给真牌面，不是盲选（用户 2026-09-25）', () => {
  it('目标=自己 ⇒ `card:<id>` + 「弃置你的【牌名】」；目标=别人 ⇒ 仍是「第 k 张（暗）」', () => {
    const state = gz();
    const a = seat(state, A);
    const c = seat(state, C);
    a.hand = [mk('a1', 'tao', 'heart', 9)];
    c.hand = [mk('c1', 'sha', 'spade', 13), mk('c2', 'tao', 'diamond', 7)];

    const own = targetCardOptions(state, A, a, '弃置');
    expect(own.map((o) => o.id), '自己的牌按牌 id 给选项').toEqual(['card:a1']);
    expect(own[0]!.label).toBe('弃置你的【红桃9·桃】');
    expect(own[0]!.label, '不许出现「其第 N 张（暗）」').not.toContain('暗');

    const other = targetCardOptions(state, A, c, '弃置');
    expect(other.map((o) => o.id), '别人的手牌照旧盲选').toEqual(['hand:0', 'hand:1']);
    expect(other[0]!.label).toBe('弃置其第 1 张手牌（暗，共 2 张）');
    // 别人的候选里不许出现牌面（连牌名都不能有）
    expect(JSON.stringify(other)).not.toContain('杀');
    expect(JSON.stringify(other)).not.toContain('桃');
    expect(JSON.stringify(other)).not.toContain('黑桃');
  });

  it('装备区/判定区两种身份都给真牌面（公开区本来就不是暗信息）', () => {
    const state = gz();
    const a = seat(state, A);
    a.hand = [];
    a.equipment.weapon = { id: 'w1', type: 'weapon', suit: 'spade', rank: 6, equipName: 'qinggang' };
    a.judgment.push(mk('j1', 'lebu', 'heart', 6));
    const ids = targetCardOptions(state, A, a, '弃置').map((o) => o.id);
    expect(ids).toContain('card:w1');
    expect(ids).toContain('card:j1');
  });
});
