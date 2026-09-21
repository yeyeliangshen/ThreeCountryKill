import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { targetNeedsHandCards } from './targetRules';

/**
 * 【火攻】的目标必须有手牌（用户 2026-09-22 报、09-23 复报「其他交互路径」）。
 *
 * 界面这一半的职责：把**不可点**的目标画成不可点；引擎那一半负责拒绝任何绕过界面的指定
 * （出牌校验 + 技能目标候选 + 虚拟锦囊结算入口，见 packages/engine 的 dropTargetsWithoutHand）。
 */
describe('「目标必须有手牌」的界面判据', () => {
  it('只有【火攻】要求目标有手牌（含转化后的火攻）', () => {
    expect(targetNeedsHandCards('huogong')).toBe(true);
    for (const t of ['sha', 'guohe', 'shunshou', 'juedou', 'jiedao', 'lebu', 'wuzhong']) {
      expect(targetNeedsHandCards(t), t).toBe(false);
    }
    // 拿不到牌型（虚拟牌/查不到）时不拦——引擎那边仍会拒绝
    expect(targetNeedsHandCards(null)).toBe(false);
    expect(targetNeedsHandCards(undefined)).toBe(false);
  });

  it('Game.tsx 的可点目标判据真的用了它（否则空手角色会重新可点）', () => {
    const src = readFileSync(join(__dirname, 'pages', 'Game.tsx'), 'utf8');
    expect(src).toContain('targetNeedsHandCards(');
    // 判据必须落在 canClickTarget 里（点了才报错是以前的行为）
    const block = src.slice(src.indexOf('function canClickTarget'), src.indexOf('function handleTargetClick'));
    expect(block).toContain('selectedTargetNeedsHand');
    expect(block).toContain('handCount');
  });
});
