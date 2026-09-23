/**
 * **技能目标的「一对」限制 + 甘露的交换预览**（用户 2026-09-25 口径）。
 *
 * 规则原文（吴国太·甘露）：
 * > 出牌阶段限一次，你可以选择两名角色，若他们装备区里的牌数之差不大于你已损失的体力值，
 * > 则交换两人的装备区里的牌（两人的装备牌总数至少为 1）。
 *
 * 用户的交互要求：**别让玩家自己算差值**——引擎把合法**目标对**整批下发，界面据此动态过滤；
 * 两个目标定下来之后在中央列出双方**完整装备区**（按牌名）再确认。
 *
 * 仓库没有 jsdom，所以分两层：纯函数直测（`pairAllowsMore` / `pairComplete` / `equipSwapNote`）
 * + 源码守门（接线、预览、引擎侧下发）。
 *
 * ⚠️ 带「改动前 ✗」的用例在本轮修复前必红。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { equipSwapNote, pairAllowsMore, pairComplete } from './skillTargets';

const read = (...p: string[]): string => readFileSync(join(__dirname, ...p), 'utf8');
const game = read('pages', 'Game.tsx');
// 引擎侧的两份（本目录是 packages/ui/src ⇒ ../../engine/src）
const legal = readFileSync(join(__dirname, '..', '..', 'engine', 'src', 'legal.ts'), 'utf8');
const heroes = readFileSync(join(__dirname, '..', '..', 'engine', 'src', 'heroes.ts'), 'utf8');

/** 甲(2 件) ↔ 乙(1 件)、乙 ↔ 丙(0 件) 合法；甲 ↔ 丙 差 2 > 已损失 1 ⇒ 不合法 */
const PAIRS = [
  ['s0', 's1'],
  ['s1', 's2'],
];

describe('对着色：点第二个人时按「合法目标对」过滤（改动前 ✗：那时界面只看 maxTargets）', () => {
  it('没有 pairs 的技能（绝大多数）一律放行——界面不许自己加限制', () => {
    expect(pairAllowsMore(undefined, [], 's0')).toBe(true);
    expect(pairAllowsMore(undefined, ['s0'], 's9')).toBe(true);
    expect(pairComplete(undefined, ['s0', 's9'])).toBe(true);
  });

  it('还没选人 / 再点已选的人 ⇒ 放行（那是取消选择的手势）', () => {
    expect(pairAllowsMore(PAIRS, [], 's0')).toBe(true);
    expect(pairAllowsMore(PAIRS, [], 's2')).toBe(true);
    expect(pairAllowsMore(PAIRS, ['s0'], 's0')).toBe(true);
  });

  it('已选第一个之后：只有跟他凑得出合法对的座位才可点', () => {
    expect(pairAllowsMore(PAIRS, ['s0'], 's1'), '甲+乙 = 差 1 ≤ 1').toBe(true);
    expect(pairAllowsMore(PAIRS, ['s0'], 's2'), '甲+丙 = 差 2 > 1 ⇒ 置灰').toBe(false);
    expect(pairAllowsMore(PAIRS, ['s1'], 's2'), '乙+丙 = 差 1 ⇒ 可以').toBe(true);
  });

  it('两个都选完了 ⇒ 这一层不再拦（交给 maxTargets 与确认按钮）', () => {
    expect(pairAllowsMore(PAIRS, ['s0', 's1'], 's2')).toBe(true);
  });
});

describe('确认按钮：选满一对但不成对时不给按', () => {
  it('成对 ⇒ 可以确认；不成对 ⇒ 不行', () => {
    expect(pairComplete(PAIRS, ['s0', 's1'])).toBe(true);
    expect(pairComplete(PAIRS, ['s1', 's2'])).toBe(true);
    expect(pairComplete(PAIRS, ['s0', 's2']), '凑不成合法的对').toBe(false);
  });

  it('没选满两个 ⇒ 这一层不管（minTargets 那一层会拦）', () => {
    expect(pairComplete(PAIRS, ['s0'])).toBe(true);
    expect(pairComplete(PAIRS, [])).toBe(true);
  });
});

describe('交换预览的那行核对说明', () => {
  it('把「差值 / 已损失体力」写出来（玩家不用自己算）', () => {
    expect(equipSwapNote(3, 1, 1)).toBe('装备区：3 件 ⇄ 1 件（差 2，你已损失 1 点体力 → 上限 1）');
    expect(equipSwapNote(2, 0, 2)).toContain('差 2');
  });
});

describe('接线守门（源码字符串，无 jsdom）', () => {
  it('引擎把合法目标对下发（`legalTargetPairs`），且判据只有一份（`ganluPairOk`）', () => {
    expect(legal, 'legal.ts 要把它拼进 legalSkills').toContain('legalTargetPairs: pairs');
    expect(heroes, '甘露声明 targetPairOk').toContain('targetPairOk: (state, player, a, b) => ganluPairOk(state, player, a, b)');
    // 唯一的判据：canUse / execute 的 ganluPairs 与 targetPairOk 都走它（不许两套口径）
    expect(heroes).toContain('function ganluPairOk(');
    expect(heroes, 'pair 判据里要有「总数 ≥ 1」').toContain('na + nb >= 1');
    expect(heroes, '以及「差值 ≤ 已损失体力」').toContain('Math.abs(na - nb) <= lost');
  });

  it('界面：可点性走 pairAllowsMore（对手那一栏 + 自己那一格），确认走 pairComplete', () => {
    expect(game).toContain('pairAllowsMore(skillMode.skill.legalTargetPairs, skillMode.targetIds, p.seatId)');
    expect(game).toContain('pairAllowsMore(skillMode.skill.legalTargetPairs, skillMode.targetIds, me.seatId)');
    expect(game).toContain('pairComplete(skill.legalTargetPairs, targetIds)');
  });

  it('界面：两个目标定下来后画出交换预览（双方装备按牌名）+ 按钮变成「交换」', () => {
    expect(game, '预览块').toContain('equip-swap');
    expect(game).toContain("skillMode.skill.preview === 'equipSwap'");
    expect(game, '牌名要用 cardShortName（不能只写「武器」）').toContain('cardShortName(c)');
    expect(game, '核对说明').toContain('equipSwapNote(');
    // 确认按钮的文案：预览形态（甘露）时叫「交换」，其余技能叫「确认<技能名>」
    // （用户 2026-09-25 口径：离间要写成「确认离间」，让玩家知道自己在确认什么）
    expect(game, '确认按钮在预览时叫「交换」').toContain("? '交换'");
    expect(game, '其余技能叫「确认<技能名>」').toContain('确认${skillMode.skill.name}');
  });

  it('界面**不**自己写死「甘露」这两个字（限制与预览都由引擎下发的字段驱动）', () => {
    // 说明文字里可以出现技能名，但**判据**里不许（那种地方只允许 legalTargetPairs / preview）
    expect(game).not.toContain("skillId === 'ganlu'");
    expect(game).not.toContain("id === 'ganlu'");
  });
});
