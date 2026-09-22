import { describe, it, expect } from 'vitest';
import { getHero } from '@sgs/engine';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nextGuozhanSlots, type GuozhanSlots } from './draftSlots';

const heroOf = (id: string) => getHero(id);
const empty: GuozhanSlots = { main: null, deputy: null };
/** 依次点这几张牌，返回最终槽位 */
const clickAll = (ids: string[]): GuozhanSlots =>
  ids.reduce<GuozhanSlots>((slots, id) => nextGuozhanSlots(slots, id, heroOf), empty);

describe('国战选将 · 槽位分配（与引擎 pickHero 同口径）', () => {
  it('双势力牌能配它的**任一**所属势力：孟达(魏/蜀) + 关羽(蜀) 落副将位', () => {
    // ⚠️ 回归：以前这里只比 `faction`（魏 ≠ 蜀）→ 判定成「不同阵营」→ 换成主将，
    //    于是**引擎明明收的合法组合**在界面上永远拼不出来（用户 2026-09-21 给的双势力口径）。
    expect(clickAll(['mengda', 'guanyu'])).toEqual({ main: 'mengda', deputy: 'guanyu' });
    expect(clickAll(['mengda', 'caocao'])).toEqual({ main: 'mengda', deputy: 'caocao' }); // 配魏
    // 双势力放**副将**位同样合法
    expect(clickAll(['caocao', 'mengda'])).toEqual({ main: 'caocao', deputy: 'mengda' });
  });

  it('两张双势力：有共同势力 → 落副将；没有共同势力 → 当主将（引擎那边也会拒这个组合）', () => {
    // 魏/蜀 × 魏/吴：共同势力只有魏
    expect(clickAll(['mengda', 'tangzi'])).toEqual({ main: 'mengda', deputy: 'tangzi' });
    // 魏/蜀 × 魏/蜀：两个共同势力 → 引擎会挂「选势力」询问
    expect(clickAll(['mengda', 'xiahouba'])).toEqual({ main: 'mengda', deputy: 'xiahouba' });
    // 魏/蜀 × 吴/群：一个共同势力都没有 → 不能当副将，改成替换主将
    expect(clickAll(['mengda', 'shixie'])).toEqual({ main: 'shixie', deputy: null });
  });

  it('单势力之间：同势力落副将、不同势力替换主将', () => {
    expect(clickAll(['guanyu', 'zhangfei'])).toEqual({ main: 'guanyu', deputy: 'zhangfei' });
    expect(clickAll(['guanyu', 'sunquan'])).toEqual({ main: 'sunquan', deputy: null });
  });

  it('野心家武将只能在主将位：作副将点击时替换主将', () => {
    expect(clickAll(['sunchen', 'guanyu'])).toEqual({ main: 'sunchen', deputy: 'guanyu' });
    expect(clickAll(['guanyu', 'sunchen'])).toEqual({ main: 'sunchen', deputy: null });
    // 双势力主 + 野心家副 → 同样只能替换主将（position 表：野心家 MAIN_ONLY）
    expect(clickAll(['mengda', 'sp_simazhao'])).toEqual({ main: 'sp_simazhao', deputy: null });
    // 野心家 + 双势力 → 可以，副将位照放（双势力的那一面由引擎再问玩家）
    expect(clickAll(['sp_simazhao', 'mengda'])).toEqual({ main: 'sp_simazhao', deputy: 'mengda' });
    // ⚠️ 野心家 + 野心家 → **不可以**（用户 2026-09-21 口径）：第二张只能替换主将
    expect(clickAll(['sp_simazhao', 'jie_zhonghui'])).toEqual({ main: 'jie_zhonghui', deputy: null });
  });

  it('取消与替换', () => {
    // 再点一次已选的主将/副将 = 取消那一格
    expect(nextGuozhanSlots({ main: 'mengda', deputy: 'guanyu' }, 'mengda', heroOf)).toEqual({
      main: null,
      deputy: 'guanyu',
    });
    expect(nextGuozhanSlots({ main: 'mengda', deputy: 'guanyu' }, 'guanyu', heroOf)).toEqual({
      main: 'mengda',
      deputy: null,
    });
    // 两槽都满 → 新点的牌当主将，副将清空
    expect(nextGuozhanSlots({ main: 'mengda', deputy: 'guanyu' }, 'caocao', heroOf)).toEqual({
      main: 'caocao',
      deputy: null,
    });
  });

  /**
   * 静态守门：`Game.tsx` 里的槽位分配**必须**走这个纯函数。
   * 为什么值得钉：这条口径以前在界面里被抄了一份（只比 `faction`），于是引擎与界面不一致
   * （界面上拼不出合法组合）。抄一份的成本看起来很低，但错一次就是「玩家选不出武将」。
   */
  it('Game.tsx 用的是这个纯函数，没有自己再抄一份判定', () => {
    const src = readFileSync(join(__dirname, 'pages', 'Game.tsx'), 'utf8');
    expect(src).toContain('nextGuozhanSlots(');
    expect(src).not.toMatch(/faction === h\.faction/);
  });

  /**
   * 静态守门：选将卡上的**技能列表**必须按**本局模式**取武将。
   *
   * 为什么值得钉（真机验收时发现的）：国战与身份局的同名武将技能不同（陆逊：国战＝谦逊+度势、
   * 身份局＝谦逊+连营），而选将卡以前用的是不带模式的 `getHero` ⇒ 国战选将时卡面上写着
   * 连营，实际打出来的是度势，玩家按卡面做决策必然踩空。
   */
  it('Game.tsx 的选将卡用 getHeroForMode（技能列表跟着本局模式走）', () => {
    const src = readFileSync(join(__dirname, 'pages', 'Game.tsx'), 'utf8');
    expect(src).toContain('getHeroForMode(id, snapshot.mode)');
    // 选将区不许再用裸 getHero 拿武将（那会拿到身份局版本）
    const draftBlock = src.slice(src.indexOf('className="draft"'), src.indexOf('className="draft"') + 4000);
    expect(draftBlock).not.toMatch(/const h = getHero\(/);
  });
});
