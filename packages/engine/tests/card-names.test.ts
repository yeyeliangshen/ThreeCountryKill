/**
 * **装备牌的显示名必须完整**（用户 2026-09-23 报的缺陷）。
 *
 * 症状：势备篇的【明光铠】【护心镜】在界面上显示成「防具」、【惊帆】显示成「−1马」——
 * 玩家看不出实际装了什么牌（用户原话：「避免玩家无法快速判断当前角色实际装备了什么牌」）。
 *
 * 根因：`EQUIP_NAME` 是一张**手维护**的表，牌堆用了 `equipName` 而表里没有那条，
 * `cardShortName` 就回落到通用槽位名（`CARD_TYPE_NAME[type]` = 武器/防具/+1马/−1马/宝物）。
 * 这类漂移以前没人能发现（测试都不看显示名），所以这里把它变成红灯：
 * **以后往牌堆里加装备牌忘了补名字，会在测试里立刻暴露**，而不是等玩家在牌桌上看见「防具」。
 */
import { describe, it, expect } from 'vitest';
import { CARD_TYPE_NAME, EQUIP_NAME, cardShortName, type Card } from '@sgs/protocol';
import { buildDeck } from '../src';
// 势备篇与君主专属装备没从 index 转出去（它们只在引擎内部用），测试直接引模块
import {
  buildShibeiCards,
  lordEquipDinglan,
  lordEquipFeilong,
  lordEquipLiulong,
  lordEquipMengjun,
} from '../src/deck';

const EQUIP_TYPES = ['weapon', 'armor', 'plusMount', 'minusMount', 'treasure'] as const;

/** 把一圈装备牌挨个检查：必须有**具体牌名**（不能回落到槽位名），且表里能查到 */
function checkAll(cards: Card[], tag: string): string[] {
  const bad: string[] = [];
  for (const c of cards) {
    if (!EQUIP_TYPES.includes(c.type as (typeof EQUIP_TYPES)[number])) continue;
    const generic = CARD_TYPE_NAME[c.type];
    const shown = cardShortName(c);
    if (!c.equipName) bad.push(`${tag} ${c.id} 没有 equipName`);
    else if (!EQUIP_NAME[c.equipName]) bad.push(`${tag} ${c.id} equipName=${c.equipName} 不在 EQUIP_NAME`);
    else if (shown === generic) bad.push(`${tag} ${c.id} 回落到槽位名「${generic}」`);
  }
  return bad;
}

describe('装备牌的显示名（界面上的「装了什么」）', () => {
  it('国战牌堆 + 势备篇：每张装备牌都显示**具体牌名**', () => {
    const guozhan = buildDeck('guozhan', { shibei: true });
    const bad = [...checkAll(guozhan, '国战堆'), ...checkAll(buildShibeiCards(), '势备篇')];
    expect(bad, bad.join('\n')).toEqual([]);
    // 顺手点名片：势备篇那三张以前是「防具」「−1马」
    const shibei = buildShibeiCards();
    const nameOf = (id: string) => shibei.find((c) => c.equipName === id);
    expect(nameOf('mingguang') && cardShortName(nameOf('mingguang')!)).toBe('明光铠');
    expect(nameOf('huxinjing') && cardShortName(nameOf('huxinjing')!)).toBe('护心镜');
    expect(nameOf('jingfan') && cardShortName(nameOf('jingfan')!)).toBe('惊帆');
  });

  it('军争牌堆同样完整（身份局那套也有装备）', () => {
    const bad = checkAll(buildDeck('melee'), '军争堆');
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('君主专属装备（君威从游戏外取的那四张）也有牌名', () => {
    const lords = [lordEquipFeilong(1), lordEquipLiulong(2), lordEquipDinglan(3), lordEquipMengjun(4)];
    const bad = checkAll(lords, '君主装备');
    expect(bad, bad.join('\n')).toEqual([]);
    expect(lords.map((c) => cardShortName(c))).toEqual([
      '飞龙夺凤',
      '六龙骖驾',
      '定澜夜明珠',
      '盟军大纛',
    ]);
  });

  /**
   * 反向守门：`EQUIP_NAME` 里的**每一个** id 都要能被牌堆用上（或者至少是个已知牌名）——
   * 这条不严（预留条目可以有），只钉住「表里全是正经牌名、没有 `undefined` 这种占位」。
   */
  it('EQUIP_NAME 里没有空值', () => {
    for (const [id, name] of Object.entries(EQUIP_NAME)) {
      expect(typeof name, id).toBe('string');
      expect(name.length, id).toBeGreaterThan(0);
    }
  });
});
