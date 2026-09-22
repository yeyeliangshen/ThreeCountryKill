import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Card } from '@sgs/protocol';
import { cardUses, isDirectlyPlayable, useActionOf } from './cardUses';

/**
 * 「这张牌怎么用？」的用法列表 + 点了之后走哪条路。
 *
 * 用户 2026-09-23 报的缺陷就出在这里：**连横的用法列出来了，但点击时没有对应的动作分支**
 * （掉进 `beginPlay(card, u.as)`，`u.as` 是 undefined ⇒ 当成「按牌面使用」），
 * 于是带连横标记的牌永远进不了连横模式（`lianhengCard` 全仓没有写入点）。
 * 这个文件把「用法 → 动作」钉死：四种用法各有去处，漏一条就红。
 */
const card = (type: Card['type'], extra?: Partial<Card>): Card =>
  ({ id: 'c1', type, suit: 'spade', rank: 1, ...extra }) as Card;

describe('牌面用法 → 动作（连横不能再掉进「按牌面使用」）', () => {
  it('连横用法 → lianheng（**不是** play）', () => {
    expect(useActionOf({ lianheng: true, label: '连横' })).toBe('lianheng');
    // 连横是最容易被后面的 play 兜底吃掉的一条：这里连断言它的 as 为空也不掉出去
    expect(useActionOf({ lianheng: true, as: undefined, label: '连横' })).toBe('lianheng');
  });

  it('重铸 / 丈八 / 直接使用各有各的动作', () => {
    expect(useActionOf({ recast: true, label: '重铸' })).toBe('recast');
    expect(useActionOf({ zhangba: true, label: '丈八' })).toBe('zhangba');
    expect(useActionOf({ label: '按【杀】使用' })).toBe('play');
    expect(useActionOf({ as: 'guohe', label: '当【过河拆桥】使用' })).toBe('play');
  });

  it('【挟天子以令诸侯】：既有「按牌面使用」也有「连横」，两条互不干扰', () => {
    const xietianzi = card('xietianzi', { lianheng: true });
    const uses = cardUses(xietianzi, [], false, false, ['s1', 's2'], false, null);
    expect(uses.map((u) => u.label)).toEqual([
      '按【挟天子以令诸侯】使用',
      '连横（交给一名势力不同或未确定势力的角色）',
    ]);
    // 「使用」和「连横」是两条独立的路：一个走 play、一个走 lianheng
    expect(uses.map(useActionOf)).toEqual(['play', 'lianheng']);
    // 一个合法目标都没有时不给连横这一条（别把玩家引到死路上）
    expect(cardUses(xietianzi, [], false, false, [], false, null).map(useActionOf)).toEqual(['play']);
  });

  it('【闪】这种打不出去的牌：有连横标记时唯一的用法就是连横', () => {
    const shan = card('shan', { lianheng: true });
    expect(isDirectlyPlayable(shan)).toBe(false);
    const uses = cardUses(shan, [], false, false, ['s1'], false, null);
    expect(uses.map(useActionOf)).toEqual(['lianheng']);
  });

  it('没有连横标记的牌不会出现连横用法（通用机制认标记）', () => {
    const sha = card('sha');
    expect(cardUses(sha, [], false, false, ['s1'], false, null).map(useActionOf)).toEqual(['play']);
  });

  /**
   * 静态守门：`Game.tsx` 必须**真的**按 `useActionOf` 分派，而且连横那一支要落到
   * `setLianhengCard`（连横模式的唯一入口）——这条正是当初漏掉的那一行。
   */
  it('Game.tsx 用 useActionOf 分派，连横分支接进了连横模式', () => {
    const src = readFileSync(join(__dirname, 'pages', 'Game.tsx'), 'utf8');
    expect(src).toContain('useActionOf(');
    expect(src).toContain("case 'lianheng':");
    const block = src.slice(src.indexOf("case 'lianheng':"), src.indexOf("case 'lianheng':") + 260);
    expect(block).toContain('setLianhengCard(');
    // 连横模式必须有人写：否则状态永远是 null（连横进不去）
    expect(src.match(/setLianhengCard\(card\.id\)/g)?.length ?? 0).toBeGreaterThan(0);
  });
});
