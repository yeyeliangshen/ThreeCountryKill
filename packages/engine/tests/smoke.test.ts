// 随机对局冒烟测试。
//
// 为什么值得单独留一份：这个引擎的核心是**暂停/恢复契约**（pending 挂在哪个座位、
// 谁负责把控制权还回去），单点测试很难覆盖「某个技能在多层询问之后忘了 returnTo」
// 这类问题——它不会报错，只会让 pending 变成 null，**整局静默卡死**。
// 这个文件用固定种子跑几局随机对局，把「任何时刻都必须有一个可行动的 pending」
// 当成不变式来检查。（木牛流马的移动那一层就是这么被发现的。）
//
// 种子固定 → 结果确定，不会 flaky。
import { describe, it, expect } from 'vitest';
import {
  applyIntent,
  createGame,
  getHero,
  poolForMode,
  seededRng,
  toSnapshot,
  type GameState,
  type SeatSetup,
} from '../src';

/** 决策与洗牌共用同一个可种子化随机源（引擎里已有 seededRng，别自己再写一份） */
const rng = seededRng;

/** 随机选一对同阵营的主副将（君主只能当主将） */
function pickDraft(state: GameState, seatId: string): boolean {
  const options = state.draft!.deals[seatId] ?? [];
  for (const a of options) {
    for (const b of options) {
      if (a === b) continue;
      if (getHero(a)?.faction !== getHero(b)?.faction) continue;
      if (getHero(b)?.isLord) continue;
      const res = applyIntent(state, seatId, { type: 'pickHero', heroId: a, deputyHeroId: b });
      if (res.ok) return true;
    }
  }
  return false;
}

/**
 * 记录每条「特殊路径」被真正走到过几次。
 *
 * 只统计步数是不够的——随机对局里某条分支可能一次都没触发，那种「跑通了」
 * 是假的。新增机制时把它挂上，断言语义见下面的用例。
 */
const hits: Record<string, number> = { zhangba: 0, wuxie: 0 };

/** 走一步：为「当前该行动的人」生成一个意图。返回这一步的动作名 */
function step(state: GameState, rand: () => number): string {
  if (state.draft) {
    const seat = state.draft.pendingSeats[0];
    if (!seat) throw new Error('选将阶段没有待选座位却没结束');
    pickDraft(state, seat);
    return 'draft';
  }
  const p = state.pending;
  if (!p) throw new Error('既没有 pending 也不在选将阶段——控制权丢了');
  switch (p.kind) {
    case 'play': {
      const prompt = toSnapshot(state, p.seatId).prompt;
      const cards = prompt?.legalCardIds ?? [];
      const targets = prompt?.legalTargetIds ?? [];
      const skills = prompt?.legalSkillIds ?? [];
      const roll = rand();
      if (roll < 0.5 && cards.length > 0) {
        const cardId = cards[Math.floor(rand() * cards.length)]!;
        const nTargets = rand() < 0.25 ? Math.min(2, targets.length) : targets.length > 0 ? 1 : 0;
        const chosen = targets.slice(0, nTargets);
        // 装备着【丈八蛇矛】时，偶尔走「两张手牌当【杀】」这条路
        const zhangbaPartner = rand() < 0.4 ? cards.find((id) => id !== cardId) : undefined;
        const extra = prompt?.zhangbaOk && zhangbaPartner ? [zhangbaPartner] : undefined;
        if (extra) hits.zhangba = (hits.zhangba ?? 0) + 1;
        const r = applyIntent(state, p.seatId, {
          type: 'playCard',
          cardId,
          ...(extra ? { extraCardIds: extra } : {}),
          targetIds: chosen,
        });
        // 目标数不合法的牌就退回「不用目标」再试一次，都不行就结束阶段
        if (
          !r.ok &&
          !applyIntent(state, p.seatId, { type: 'playCard', cardId, targetIds: [] }).ok
        ) {
          applyIntent(state, p.seatId, { type: 'endPhase' });
        }
        return 'playCard';
      }
      if (roll < 0.8 && skills.length > 0) {
        const skillId = skills[Math.floor(rand() * skills.length)]!;
        if (!applyIntent(state, p.seatId, { type: 'useSkill', skillId, targetIds: [] }).ok) {
          applyIntent(state, p.seatId, { type: 'endPhase' });
        }
        return 'useSkill';
      }
      applyIntent(state, p.seatId, { type: 'endPhase' });
      return 'endPhase';
    }
    case 'choice':
      applyIntent(state, p.seatId, {
        type: 'chooseOption',
        optionId: p.options[Math.floor(rand() * p.options.length)]!.id,
      });
      return 'choice';
    case 'pickCards':
      applyIntent(state, p.seatId, {
        type: 'pickCards',
        cardIds: p.cards.slice(0, p.min).map((c) => c.id),
      });
      return 'pickCards';
    case 'viewCards':
      applyIntent(state, p.seatId, { type: 'ack' });
      return 'viewCards';
    case 'discard':
      applyIntent(state, p.seatId, {
        type: 'discard',
        cardIds: toSnapshot(state, p.seatId)
          .myHand.slice(0, p.count)
          .map((c) => c.id),
      });
      return 'discard';
    case 'respondSha':
      applyIntent(state, p.responderId, { type: 'pass' });
      return 'respondSha';
    case 'respondTrick': {
      // 需打出【杀】且能用丈八时，偶尔拿两张手牌顶一张
      const prompt = toSnapshot(state, p.responderId).prompt;
      const cards = prompt?.legalCardIds ?? [];
      if (prompt?.zhangbaOk && cards.length >= 2 && rand() < 0.4) {
        hits.zhangba = (hits.zhangba ?? 0) + 1;
        applyIntent(state, p.responderId, {
          type: 'respondCard',
          cardId: cards[0]!,
          extraCardIds: [cards[1]!],
        });
        return 'respondTrick';
      }
      applyIntent(state, p.responderId, { type: 'pass' });
      return 'respondTrick';
    }
    case 'respondDeath':
      applyIntent(state, p.askQueue[p.askIndex]!, { type: 'pass' });
      return 'respondDeath';
    case 'wuxieQueue': {
      // 手里有无懈就打（还可能会再抵消上一张）——这条链很容易出「控制权没还回去」的坑
      const asked = p.askQueue[p.askIndex]!;
      const legal = toSnapshot(state, asked).prompt?.legalCardIds ?? [];
      if (legal.length > 0 && rand() < 0.5) {
        const cardId = legal[Math.floor(rand() * legal.length)]!;
        applyIntent(state, asked, { type: 'respondCard', cardId });
        hits.wuxie = (hits.wuxie ?? 0) + 1;
        return 'wuxieQueue';
      }
      applyIntent(state, asked, { type: 'pass' });
      return 'wuxieQueue';
    }
    case 'factionCall':
      applyIntent(state, p.askQueue[p.askIndex]!, { type: 'pass' });
      return 'factionCall';
    case 'activeSkill':
      throw new Error('activeSkill pending 没有驱动方式——这个原语还没接完');
  }
}

describe('随机对局冒烟：全势备篇牌堆不卡死、不抛错', () => {
  it('12 局（固定种子）都跑到分出胜负', () => {
    let totalSteps = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const rand = rng(seed);
      const n = 5 + (seed % 3);
      const setup: SeatSetup[] = Array.from({ length: n }, (_, i) => ({
        seatId: `s${i}`,
        name: `P${i}`,
        heroId: 'vanilla',
      }));
      // 牌序也必须用**同一颗种子**洗，否则同一个 seed 每次跑出来的牌都不一样，
      // 「种子固定 → 结果确定」就是句空话（这条断言曾经真的在整套跑时挂过）
      const state = createGame(setup, `T${seed}`, {
        mode: 'guozhan',
        shibei: true,
        freePick: true,
        rng: rng(seed * 7919),
      });
      let steps = 0;
      // 单局步数上限：超了说明有地方在空转（正常一局几百步）
      while (!state.gameOver && steps < 5000) {
        step(state, rand);
        steps++;
      }
      totalSteps += steps;
      expect(state.gameOver, `seed=${seed} 跑了 ${steps} 步还没结束`).toBe(true);
    }
    // 顺带确保这些随机局真的产生了交互量（不然上面可能是空转通过的）
    expect(totalSteps).toBeGreaterThan(1000);
    // 【丈八蛇矛】那条路必须真被走到过，否则这个冒烟对它是没有覆盖的
    expect(hits.zhangba).toBeGreaterThan(0);
    // 无懈（含「无懈对无懈」的抵消链）同理
    expect(hits.wuxie).toBeGreaterThan(0);
  });
});

/**
 * 逐个武将的实战冒烟。
 *
 * 为什么值得单独跑：单元测试是「按剧本走」，而这里的驱动是**随机**的——同样的技能会在
 * 各种时机被触发，专门能撞出「某个技能在多层询问之后忘了把控制权还回去」这类问题
 * （症状是 pending 变成 null、整局静默卡死，`step()` 里那句 throw 就是不变式）。
 *
 * 名单挑的是**机制最复杂 / 最近实现**的那批：眩惑与千幻要借技能、将略要问多个人、
 * 寄篱要重跑结算、调归要看队列、伪帝要账本、举荐要变更副将……
 * 每个武将跑两遍：一次放主将位、一次放副将位（副将位才走得到副将技与减半个阴阳鱼）。
 */
describe('随机对局冒烟：每个新武将参战都打得完', () => {
  const HEROES = [
    'fazheng',
    'wangping',
    'lukang',
    'zhangxiu',
    'wuguotai',
    'yuanshu',
    'wujing',
    'yanbaihu',
    'xushu',
    'zuoci',
    'yuji',
    'dongzhuo',
    'zhangren',
    'mifuren',
    'sunce',
    'dengai',
    'lidian',
    'caiwenji',
    'zhangjiao',
    'simayi',
    // 这轮改动碰过的技能：集智（后半句）/ 克己·谋断（用牌账本）/ 旋略（批量失去）/
    // 枭姬（每张都算的对照）/ 铁骑（技能判定）/ 天义（拼点，给鹰扬制造机会）
    'huangyueying',
    'lvmeng',
    'lingtong',
    'sunshangxiang',
    'machao',
    'taishici',
  ];

  /**
   * 造一局：0 号位固定成某个武将。
   *
   * 其余座位给**随机**国战武将（而不是白板）——这样拼点、借技能、势力技这些跨武将互动
   * 也有机会发生；势力上让其中两个与 0 号位相同（否则「与你势力相同的角色」这类技能
   * 永远没有对象，测了等于没测），第三个不同势力。
   */
  function seatGame(heroId: string, inDeputy: boolean, seed: number): GameState {
    const pool = poolForMode('guozhan');
    const setup: SeatSetup[] = Array.from({ length: 4 }, (_, i) => ({
      seatId: `s${i}`,
      name: `P${i}`,
      heroId: i === 0 ? 'vanilla' : pool[(seed * 7 + i * 13) % pool.length]!.id,
    }));
    const state = createGame(setup, `H${seed}`, { mode: 'guozhan', rng: rng(seed) });
    state.draft = null;
    const me = state.players[0]!;
    const hero = getHero(heroId)!;
    if (inDeputy) me.deputyHeroId = heroId;
    else me.heroId = heroId;
    me.faction = hero.faction;
    me.heroRevealed = true;
    me.deputyRevealed = true;
    me.maxHp = Math.max(1, Math.floor(hero.maxHp));
    me.hp = me.maxHp;
    state.players.slice(1).forEach((p, i) => {
      p.faction = i === 2 ? 'wei' : hero.faction;
      p.heroRevealed = true;
      p.deputyRevealed = true;
      // 副将也亮出来，好让「副将技」那类技能有第二种来源
      p.deputyHeroId = pool[(seed * 3 + i * 5) % pool.length]!.id;
    });
    state.turn = { seatIndex: 0, phase: 'play' };
    state.pending = { kind: 'play', seatId: me.seatId };
    state.log = [];
    return state;
  }

  for (const heroId of HEROES) {
    for (const inDeputy of [false, true]) {
      const where = inDeputy ? '副将位' : '主将位';
      it(`${heroId}（${where}）跑到分出胜负`, () => {
        const seed = HEROES.indexOf(heroId) * 31 + (inDeputy ? 7 : 3);
        const rand = rng(seed);
        const state = seatGame(heroId, inDeputy, seed);
        let steps = 0;
        // step() 里「既没有 pending 也不在选将阶段」会直接抛错——那正是要抓的 bug
        while (!state.gameOver && steps < 4000) {
          step(state, rand);
          steps++;
        }
        expect(state.gameOver, `${heroId}(${where}) 跑了 ${steps} 步还没结束`).toBe(true);
      });
    }
  }
});
