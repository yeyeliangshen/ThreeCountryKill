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
