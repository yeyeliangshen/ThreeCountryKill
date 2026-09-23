/**
 * **潘凤·【狂斧】**（用户 2026-09-26 口径：现行文本）。
 *
 * 现行：「当你使用【杀】对目标角色**造成伤害后**，你可以**弃置或获得其一张牌**。」
 * —— 范围是**手牌 + 装备区**（不再只操作装备区），两种处置方式自己选。
 * 旧版（仓库原状）：「将其**装备区**里的一张牌**置入你的装备区**或弃置之」。
 *
 * 判定区**不在候选**里（「一张牌」不含判定区，与死谏同一口径）。
 */
import { describe, it, expect } from 'vitest';
import { applyIntent, createGame, emptyFlags, getHeroForMode, type GameState } from '../src';
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
const qinggang: Card = {
  ...mk('e1', 'weapon', 'spade', 6),
  equipName: 'qinggang',
  range: 2,
} as Card;

interface Seat {
  seatId: string;
  name: string;
  heroId: string;
  faction?: Faction;
  hand?: Card[];
  equip?: Card;
  judgment?: Card[];
}
function gz(seats: Seat[], turnSeat = 's0'): GameState {
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
    if (s.equip) p.equipment.weapon = s.equip;
    if (s.judgment) p.judgment = s.judgment.slice();
    p.flags = emptyFlags();
    p.maxHp = 4;
    p.hp = 4;
  }
  const idx = state.seatOrder.indexOf(turnSeat);
  state.turn = { seatIndex: idx < 0 ? 0 : idx, phase: 'play' };
  state.pending = { kind: 'play', seatId: state.seatOrder[state.turn.seatIndex]! };
  state.log = [];
  return state;
}
/** 甲（潘凤）用【杀】打乙、乙不闪 ⇒ 造成伤害后进入狂斧的询问 */
function hit(extra: Partial<Seat> = {}): GameState {
  const state = gz([
    { seatId: 's0', name: '甲', heroId: 'panfeng', faction: 'qun', hand: [sha('a1')] },
    { seatId: 's1', name: '乙', heroId: 'zhangfei', faction: 'shu', hand: [], ...extra },
    { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun', hand: [] },
  ]);
  ok(act(state, 's0', { type: 'playCard', cardId: 'a1', targetIds: ['s1'] }), '出杀');
  ok(act(state, 's1', { type: 'pass' }), '乙不闪');
  return state;
}

describe('【狂斧】：杀造成伤害后，弃置或获得其**一张牌**（手牌 + 装备）', () => {
  it('**获得手牌**：手牌只给牌背（`hand:k`），拿到的牌进**自己的手牌**', () => {
    const state = hit({ hand: [mk('b1', 'shan', 'heart', 2), mk('b2', 'tao', 'heart', 3)] });
    expect(at(state, 's1').hp).toBe(3);
    expect(state.pending?.kind, '狂斧问一句').toBe('choice');
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'yes' }));
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'take' }), '获得');
    // 候选：两张手牌（牌背，`hand:0/1`）
    expect(state.pending?.kind).toBe('choice');
    if (state.pending?.kind === 'choice') {
      expect(state.pending.options.map((o) => o.id)).toEqual(['hand:0', 'hand:1']);
      expect(state.pending.options.every((o) => !o.label.includes('·')), '牌背不给牌名').toBe(true);
    }
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'hand:1' }));
    expect(at(state, 's1').hand.map((c) => c.id), '乙少一张').toEqual(['b1']);
    expect(at(state, 's0').hand.map((c) => c.id), '甲多一张（进手牌）').toContain('b2');
  });

  it('**弃置手牌**：一样是盲选牌背，弃的牌进弃牌堆（不随机）', () => {
    const state = hit({ hand: [mk('b1', 'shan', 'heart', 2), mk('b2', 'tao', 'heart', 3)] });
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'yes' }));
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'drop' }), '弃置');
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'hand:0' }));
    expect(at(state, 's1').hand.map((c) => c.id), '点第 1 张就弃第 1 张').toEqual(['b2']);
    expect(state.discard.some((c) => c.id === 'b1')).toBe(true);
  });

  it('**装备**既可选（明牌牌名）也可以被「获得」进手牌', () => {
    const state = hit({ equip: qinggang });
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'yes' }));
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'take' }));
    if (state.pending?.kind === 'choice') {
      expect(state.pending.options.map((o) => o.id)).toEqual(['card:e1']);
      expect(state.pending.options[0]!.label, '装备给牌名').toContain('青釭剑');
    }
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'card:e1' }));
    expect(at(state, 's0').hand.map((c) => c.id), '装备牌也进手牌').toContain('e1');
    expect(at(state, 's1').equipment.weapon).toBeFalsy();
  });

  it('**判定区不出现**在候选里（「一张牌」不含判定区）', () => {
    const state = hit({
      hand: [mk('b1', 'shan', 'heart', 2)],
      judgment: [mk('j1', 'lebu', 'spade', 6)],
    });
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'yes' }));
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'take' }));
    if (state.pending?.kind === 'choice') {
      const ids = state.pending.options.map((o) => o.id);
      expect(ids).toContain('hand:0');
      expect(ids, '判定区的牌不在候选').not.toContain('card:j1');
      const zones = state.pending.zonePick?.targets[0]?.zones.map((z) => z.zone) ?? [];
      expect(zones, '分区面板里也没有判定区').toEqual(['hand']);
    }
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'hand:0' }));
    expect(at(state, 's1').judgment.map((c) => c.id), '判定区原样不动').toEqual(['j1']);
  });

  it('分区面板：手牌画牌背、装备画牌面（与死谏/挑衅同一套）', () => {
    const state = hit({ hand: [mk('b1', 'shan', 'heart', 2)], equip: qinggang });
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'yes' }));
    ok(act(state, 's0', { type: 'chooseOption', optionId: 'drop' }));
    const layout = state.pending?.zonePick?.targets[0];
    expect(layout?.zones.map((z) => z.zone)).toEqual(['hand', 'equip']);
    expect(layout?.zones[0]!.items.every((i) => !i.card), '手牌只有 optionId').toBe(true);
    expect(layout?.zones[1]!.items[0]!.card?.id, '装备带牌面').toBe('e1');
  });

  it('**没造成伤害（被闪避）⇒ 不触发**', () => {
    const state = gz([
      { seatId: 's0', name: '甲', heroId: 'panfeng', faction: 'qun', hand: [sha('a1')] },
      {
        seatId: 's1',
        name: '乙',
        heroId: 'zhangfei',
        faction: 'shu',
        hand: [mk('b1', 'shan', 'heart', 2)],
      },
      { seatId: 's2', name: '丙', heroId: 'lvbu', faction: 'qun', hand: [] },
    ]);
    ok(act(state, 's0', { type: 'playCard', cardId: 'a1', targetIds: ['s1'] }));
    ok(act(state, 's1', { type: 'respondCard', cardId: 'b1' }), '出闪');
    expect(state.pending?.kind, '闪掉了 ⇒ 没有狂斧的询问').toBe('play');
    expect(state.log.some((e) => e.message.includes('狂斧'))).toBe(false);
  });

  it('文本是现行口径（弃置或获得其一张牌）', () => {
    const desc = getHeroForMode('panfeng', 'guozhan')!.skills[0]!.desc ?? '';
    expect(desc).toContain('弃置或获得其一张牌');
    expect(desc, '不再写「置入你的装备区」').not.toContain('置入你的装备区');
  });
});
