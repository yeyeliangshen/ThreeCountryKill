import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cardSelfTargetAllowed, skillSelfTargetAllowed, targetNeedsHandCards } from './targetRules';

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

/**
 * 「能不能把**自己**选成目标」（用户 2026-09-24 口径，见 docs/guozhan-roster.md §5.209）：
 * **由牌/技能文本决定，不能由通用目标选择 UI 决定**。
 *
 * 界面这一半的职责：**只读服务端下发的自身合法目标**（`selfTargetUses` / `legalSkills[].selfTarget`），
 * 自己不写「哪张牌能选自己」的表。
 */
describe('「能否选自己」的界面判据：只读服务端下发的合法目标', () => {
  const prompt = {
    selfTargetUses: [
      { cardId: 'huogong-1', type: 'huogong' as const },
      { cardId: 'tiesuo-1', type: 'tiesuo' as const },
    ],
  };

  it('服务端说可以才是可以（【火攻】【铁索连环】）', () => {
    expect(cardSelfTargetAllowed(prompt, 'huogong-1', 'huogong')).toBe(true);
    expect(cardSelfTargetAllowed(prompt, 'tiesuo-1', 'tiesuo')).toBe(true);
  });

  it('服务端没说就不可以：【杀】【顺手牵羊】等「其他角色」的牌', () => {
    expect(cardSelfTargetAllowed(prompt, 'sha-1', 'sha')).toBe(false);
    expect(cardSelfTargetAllowed(prompt, 'shunshou-1', 'shunshou')).toBe(false);
    expect(cardSelfTargetAllowed(prompt, 'huogong-1', 'sha')).toBe(false); // 牌 id 对、用法不对
  });

  it('同一张牌的不同用法答案不同（卧龙的红【决斗】：当火攻可以、按决斗不行）', () => {
    const p = { selfTargetUses: [{ cardId: 'red-1', type: 'huogong' as const }] };
    expect(cardSelfTargetAllowed(p, 'red-1', 'huogong')).toBe(true);
    expect(cardSelfTargetAllowed(p, 'red-1', 'juedou')).toBe(false);
  });

  it('没有提示 / 没有牌型时一律不可点（不猜）', () => {
    expect(cardSelfTargetAllowed(null, 'huogong-1', 'huogong')).toBe(false);
    expect(cardSelfTargetAllowed({}, 'huogong-1', 'huogong')).toBe(false);
    expect(cardSelfTargetAllowed(prompt, 'huogong-1', null)).toBe(false);
    expect(cardSelfTargetAllowed(prompt, 'huogong-1', undefined)).toBe(false);
  });

  it('技能：读技能自己声明的 selfTarget（青囊/排异… 声明了；写「其他角色」的没有）', () => {
    expect(skillSelfTargetAllowed({ selfTarget: true })).toBe(true);
    expect(skillSelfTargetAllowed({})).toBe(false);
    expect(skillSelfTargetAllowed(null)).toBe(false);
  });
});

/**
 * 静态守门：**界面不许自己再写一套「哪张牌能选自己」的规则**
 * （以前的 `targetRange().self` 那张表就是这么和引擎各写一套、把【火攻】挡在外面的）。
 */
describe('Game.tsx 的自身目标可点性来自服务端', () => {
  const src = readFileSync(join(__dirname, 'pages', 'Game.tsx'), 'utf8');

  it('用了 targetRules 里的两个判据', () => {
    expect(src).toContain('cardSelfTargetAllowed(');
    expect(src).toContain('skillSelfTargetAllowed(');
  });

  it('旧的本地「self」表已经删掉（targetRange 不再返回 self，也不读 selected.self）', () => {
    expect(src).not.toContain('selected.self');
    expect(src).not.toMatch(/min: number;\s*\n\s*max: number;\s*\n\s*self: boolean;/);
    expect(src).not.toMatch(/targetRange\([\s\S]{0,80}?self:/);
  });

  it('自己那一栏的可点性判据落在 canPickSelf 上，且读的是下发的合法目标', () => {
    const block = src.slice(src.indexOf('const canPickSelf'), src.indexOf('const heroSlots'));
    expect(block).toContain('selectedCanTargetSelf');
    expect(block).toContain('skillSelfTargetAllowed');
    // 不许出现「自己一定不能选」这类通用判断
    expect(block).not.toContain('!== me.seatId');
  });
});
