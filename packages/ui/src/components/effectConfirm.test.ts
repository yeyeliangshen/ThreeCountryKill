import { describe, it, expect } from 'vitest';
import type { Card } from '@sgs/protocol';
import { effectConfirmFor, needsEffectConfirm } from './effectConfirm';

const mk = (id: string, type: Card['type'], extra: Partial<Card> = {}): Card =>
  ({ id, type, suit: 'spade', rank: 7, ...extra }) as Card;

/** 【杀】【酒】【桃】、锦囊、装备、转化牌各来一张（equipName 决定它是不是装备） */
const sha = mk('c1', 'sha');
const jiu = mk('c2', 'jiu');
const tao = mk('c3', 'tao');
const guohe = mk('c4', 'guohe');
const qinggang = mk('c5', 'weapon', { equipName: 'qinggang' });
const redAsSha = mk('c6', 'tao'); // 武圣：红牌当【杀】

describe('主动发起的效果：生效前确认（杀 / 酒 / 装装备）', () => {
  it('【杀】【酒】【装备】要确认，【桃】/锦囊不要', () => {
    expect(needsEffectConfirm(sha)).toBe(true);
    expect(needsEffectConfirm(jiu)).toBe(true);
    expect(needsEffectConfirm(qinggang)).toBe(true);
    expect(needsEffectConfirm(tao)).toBe(false);
    expect(needsEffectConfirm(guohe)).toBe(false);
  });

  it('转化出来的【杀】也要确认（按转化后的类型判）', () => {
    expect(needsEffectConfirm(redAsSha, 'sha')).toBe(true);
  });

  it('确认文案：把「用什么、对谁」写清，并给出牌面效果', () => {
    const r = effectConfirmFor(sha, undefined, 'guozhan', ['甲', '乙']);
    expect(r.title).toBe('对 甲、乙 使用【杀】');
    expect(r.desc.length).toBeGreaterThan(0);

    const solo = effectConfirmFor(jiu, undefined, 'guozhan');
    expect(solo.title).toBe('使用【酒】');
    expect(solo.desc.length).toBeGreaterThan(0);
  });

  it('装装备：标题是「装上」（不是「使用」），说明是这件装备的效果', () => {
    const r = effectConfirmFor(qinggang, undefined, 'guozhan');
    expect(r.title.startsWith('装上')).toBe(true);
    expect(r.desc).toBe(effectConfirmFor(qinggang, undefined, 'guozhan').desc);
    expect(r.desc, '装备说明应是这件装备自己的效果，而不是空的').not.toBe('');
  });

  it('转化牌给的是**转化后**那张牌的说明，不是原牌的', () => {
    const asSha = effectConfirmFor(redAsSha, 'sha', 'guozhan', ['甲']);
    const asTao = effectConfirmFor(redAsSha, undefined, 'guozhan');
    expect(asSha.title).toBe('对 甲 使用【杀】');
    expect(asSha.desc).not.toBe(asTao.desc);
  });
});
