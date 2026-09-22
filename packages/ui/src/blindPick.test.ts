import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blindPickOwnerText, pickIsFaceDown } from './blindPick';

/**
 * 盲选的界面侧判据（用户 2026-09-22 的规格：规则层定「能操作谁的哪些牌」，
 * 界面层按可见权限决定牌面还是牌背）。
 *
 * 判据只有三行，但它反了就是**直接泄露对手手牌**——所以钉住。
 */
describe('盲选：牌面 / 牌背的判据', () => {
  it('非盲选（pickHidden 未置）→ 全是牌面，不受 pickVisibleIds 影响', () => {
    expect(pickIsFaceDown({}, 'c1')).toBe(false);
    expect(pickIsFaceDown({ pickVisibleIds: ['c2'] }, 'c1')).toBe(false);
    expect(pickIsFaceDown(null, 'c1')).toBe(false);
    expect(pickIsFaceDown(undefined, 'c1')).toBe(false);
  });

  it('盲选 → 默认全是牌背（没在 pickVisibleIds 里就绝不露脸）', () => {
    expect(pickIsFaceDown({ pickHidden: true }, 'c1')).toBe(true);
    expect(pickIsFaceDown({ pickHidden: true, pickVisibleIds: [] }, 'c1')).toBe(true);
    expect(pickIsFaceDown({ pickHidden: true, pickVisibleIds: ['c2'] }, 'c1')).toBe(true);
  });

  it('盲选 + 已公开的那几张 → 那些画牌面，其余仍是牌背', () => {
    const p = { pickHidden: true, pickVisibleIds: ['c1'] };
    expect(pickIsFaceDown(p, 'c1')).toBe(false); // 已公开：照常画牌面
    expect(pickIsFaceDown(p, 'c2')).toBe(true); // 没公开：牌背
  });

  it('提示语说清在看谁的手牌；拿不到名字时退成「未知手牌」', () => {
    expect(blindPickOwnerText('丙')).toBe('从 丙 的手牌中选择');
    expect(blindPickOwnerText(undefined)).toBe('从未知手牌中选择');
    expect(blindPickOwnerText(null)).toBe('从未知手牌中选择');
    expect(blindPickOwnerText('')).toBe('从未知手牌中选择');
  });

  /**
   * 静态守门：`Game.tsx` 必须**真的**用这个判据决定画牌背，而且盲选那张牌**不给牌名/花色**
   * （只留一句「看不到牌面」的 aria-label）。有人把这段删了，泄露会原样回来。
   */
  it('Game.tsx 用的是这个判据渲染牌背，且不给盲选的牌任何牌面文字', () => {
    const src = readFileSync(join(__dirname, 'pages', 'Game.tsx'), 'utf8');
    expect(src).toContain('pickIsFaceDown(');
    expect(src).toContain('blindPickOwnerText(');
    expect(src).toContain('pickHidden');
    // 盲选分支里不许出现牌名/花色的渲染（cardShortName / SUIT_NAME / rankLabel 都是牌面）。
    // 窗口＝从判据那行到「画牌面」那条路的分界注释为止；注释若被删掉，下面的断言会直接报
    // 边界找不到（响亮地失败），而不是悄悄放行。
    const start = src.indexOf('pickIsFaceDown(');
    const end = src.indexOf('// 选牌是**有序**的', start);
    expect(start, 'Game.tsx 里找不到盲选判据').toBeGreaterThan(-1);
    expect(end, '找不到牌面分支的分界注释').toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block).toContain('card-back-option');
    expect(block).not.toContain('cardShortName');
    expect(block).not.toContain('SUIT_NAME');
    expect(block).not.toContain('rankLabel');
  });
});
