/**
 * **统一的技能提示判据**（用户 2026-09-25 口径①~④）——事件流 → 该显示什么、什么时候收起。
 *
 * 全部是 `skillTips.ts` 里的纯函数：这里的用例直接喂「引擎下发的事件 + 当前时刻」，
 * 不碰 DOM（仓库没有 jsdom）。渲染那一半在 `components/SkillTip.test.tsx`。
 *
 * ⚠️ 带「改动前 ✗」的用例在本特性落地前必红。
 */
import { describe, it, expect } from 'vitest';
import type { SkillFxView } from '@sgs/protocol';
import {
  nextSkillTip,
  skillTipDesc,
  skillTipRemainingMs,
  SKILL_TIP_BASE_MS,
  SKILL_TIP_HOLD_MS,
  SKILL_TIP_MAX_MS,
  SKILL_TIP_PIN_MAX_MS,
  SKILL_TIP_TAIL_MS,
  type SkillTip,
} from './skillTips';

const ev = (patch: Partial<SkillFxView> = {}): SkillFxView => ({
  seq: 1,
  seatId: 's1',
  skillName: '制衡',
  skillId: 'zhiheng',
  settling: false,
  ...patch,
});

describe('① 发动/触发：新事件 → 显示（且只显示事件里给的那个技能）', () => {
  it('事件里是谁、哪个技能，就显示谁、哪个（改动前 ✗：以前没有这条判据）', () => {
    const tip = nextSkillTip(null, ev(), 1000);
    expect(tip).toBeTruthy();
    expect(tip!.seatId).toBe('s1');
    expect(tip!.skillName).toBe('制衡');
    expect(tip!.settling).toBe(false);
    expect(tip!.pinned).toBe(false);
    // 没人被问话时：基础停留时长（口径①的「短暂」）
    expect(tip!.expiresAt).toBe(1000 + SKILL_TIP_BASE_MS);
  });

  it('基线：本客户端看到的第一份快照不播（进房/刷新不把旧技能当新闻）', () => {
    expect(nextSkillTip(null, ev(), 1000, { baseline: true })).toBeNull();
    // 有基线之后照常播
    expect(nextSkillTip(null, ev(), 1000, { baseline: false })).toBeTruthy();
  });

  it('换成另一个技能（seq 变了）⇒ 立刻换成新的（不排队、不叠加）', () => {
    const first = nextSkillTip(null, ev(), 0)!;
    const second = nextSkillTip(first, ev({ seq: 2, seatId: 's2', skillName: '刚烈' }), 500)!;
    expect(second.skillName).toBe('刚烈');
    expect(second.seatId).toBe('s2');
    expect(second.since).toBe(500);
  });

  it('同一份事件重复到达（seq 没变）⇒ 不重播、不重置计时', () => {
    const first = nextSkillTip(null, ev(), 0)!;
    const again = nextSkillTip(first, ev(), 300)!;
    expect(again.since).toBe(0);
    expect(again.expiresAt).toBe(SKILL_TIP_BASE_MS);
  });
});

describe('③ 等待响应 / 多步结算期间：提示保持', () => {
  it('settling 为真时，基础时长过了也还在（并且每份快照续时）', () => {
    const tip = nextSkillTip(null, ev({ settling: true }), 0)!;
    // 基础时长早就过了
    const later = nextSkillTip(tip, ev({ settling: true }), SKILL_TIP_BASE_MS + 500);
    expect(later, '还在等回答 ⇒ 保持').toBeTruthy();
    expect(later!.settling).toBe(true);
    expect(later!.expiresAt).toBe(SKILL_TIP_BASE_MS + 500 + SKILL_TIP_HOLD_MS);
  });

  it('但撞上兜底上限就收（口径④：再怎么拖也不许长期占着牌桌）', () => {
    const tip = nextSkillTip(null, ev({ settling: true }), 0)!;
    expect(nextSkillTip(tip, ev({ settling: true }), SKILL_TIP_MAX_MS - 1)).toBeTruthy();
    expect(nextSkillTip(tip, ev({ settling: true }), SKILL_TIP_MAX_MS)).toBeNull();
  });

  it('结算完了（settling 由真变假）：从这一刻起最多再留 TAIL 就收起', () => {
    let tip = nextSkillTip(null, ev({ settling: true }), 0)!;
    // 每份快照都会走一次判据（钩子里的定时器同理），这里照实喂进去
    tip = nextSkillTip(tip, ev({ settling: true }), 2000)!;
    tip = nextSkillTip(tip, ev({ settling: true }), 4000)!;
    const done = nextSkillTip(tip, ev({ settling: false }), 5000)!;
    expect(done.settling, '引擎说结算完了').toBe(false);
    expect(done.expiresAt).toBe(5000 + SKILL_TIP_TAIL_MS);
    expect(nextSkillTip(done, ev({ settling: false }), 5000 + SKILL_TIP_TAIL_MS)).toBeNull();
  });
});

describe('④ 结算完成 / 事件被清掉：自动收起', () => {
  it('没人被问话时：到点就没了（不会永久留着）', () => {
    const tip = nextSkillTip(null, ev(), 0)!;
    expect(nextSkillTip(tip, ev(), SKILL_TIP_BASE_MS - 1)).toBeTruthy();
    expect(nextSkillTip(tip, ev(), SKILL_TIP_BASE_MS)).toBeNull();
  });

  it('引擎把事件清掉（fx 为 null）：「已经结算完」的那条不改计时，等它自己到点', () => {
    // 制衡那种同步技能：事件出现时就没人被问话 —— 下一位玩家一动手，引擎就把字段清掉了，
    // 但提示该按自己的基础时长走完（「短暂显示」不是「一闪而过」）。
    const tip = nextSkillTip(null, ev(), 0)!;
    const cleared = nextSkillTip(tip, null, 100)!;
    expect(cleared, '事件没了 ≠ 立刻消失').toBeTruthy();
    expect(cleared!.expiresAt).toBe(SKILL_TIP_BASE_MS);
    expect(nextSkillTip(cleared, null, SKILL_TIP_BASE_MS)).toBeNull();
  });

  it('还在保持（settling）时事件被清掉：只再留 TAIL 就收起', () => {
    const tip = nextSkillTip(null, ev({ settling: true }), 0)!;
    const cleared = nextSkillTip(tip, null, 100)!;
    expect(cleared!.settling).toBe(false);
    expect(cleared!.expiresAt).toBe(100 + SKILL_TIP_TAIL_MS);
    expect(nextSkillTip(cleared, null, 100 + SKILL_TIP_TAIL_MS)).toBeNull();
  });

  it('剩余时间给钩子定下一次 tick（没有提示时不需要定时器）', () => {
    expect(skillTipRemainingMs(null, 1234)).toBeNull();
    const tip = nextSkillTip(null, ev(), 0)!;
    expect(skillTipRemainingMs(tip, 1000)).toBe(SKILL_TIP_BASE_MS - 1000);
    expect(skillTipRemainingMs(tip, SKILL_TIP_BASE_MS + 50), '已经过去就是 0').toBe(0);
  });
});

describe('② 点开完整描述：要看的说明不许下一秒就没了', () => {
  it('点开（pinned）后基础时长过了仍在，直到 PIN 上限', () => {
    const tip: SkillTip = { ...nextSkillTip(null, ev(), 0)!, pinned: true };
    expect(nextSkillTip(tip, ev(), SKILL_TIP_BASE_MS + 1000), '他点开在看').toBeTruthy();
    expect(nextSkillTip(tip, ev(), SKILL_TIP_PIN_MAX_MS - 1)).toBeTruthy();
    expect(nextSkillTip(tip, ev(), SKILL_TIP_PIN_MAX_MS), '兜底上限仍然管着').toBeNull();
  });

  it('下一个技能发动时，点开的那条照样让位（不叠在牌桌上）', () => {
    const pinned: SkillTip = { ...nextSkillTip(null, ev(), 0)!, pinned: true };
    const next = nextSkillTip(pinned, ev({ seq: 9, skillName: '咆哮' }), 1000)!;
    expect(next.skillName).toBe('咆哮');
    expect(next.pinned).toBe(false);
  });
});

describe('描述从哪来：复用武将技能文本，且不泄露暗将', () => {
  const players = [
    {
      seatId: 's1',
      name: '甲',
      heroId: 'sunquan',
      deputyHeroId: null,
      heroRevealed: true,
      deputyRevealed: true,
    },
  ] as unknown as Parameters<typeof skillTipDesc>[1];

  it('用发动者**明置**武将牌上的那一份（制衡：出牌阶段限一次…）', () => {
    expect(skillTipDesc('junzheng', players, 's1', '制衡')).toContain('弃置');
  });

  it('国战与身份局的同名技能取**本模式**的那一份（不混用版本）', () => {
    const junzheng = skillTipDesc('junzheng', players, 's1', '制衡');
    const guozhan = skillTipDesc('guozhan', players, 's1', '制衡');
    expect(junzheng).not.toBe('');
    expect(guozhan).not.toBe('');
    // 国战口径「至多 X 张」（X = 体力上限），身份局无此限制——两份文本必须不同
    expect(guozhan).not.toBe(junzheng);
  });

  it('该角色没明置这个技能时按名册兜底（借来的技能也查得到）', () => {
    const stranger = [
      { seatId: 's2', name: '乙', heroId: null, deputyHeroId: null },
    ] as unknown as Parameters<typeof skillTipDesc>[1];
    expect(skillTipDesc('junzheng', stranger, 's2', '制衡')).toContain('弃置');
    expect(skillTipDesc('junzheng', stranger, 's2', '根本没有这个技能'), '查不到就是空串').toBe('');
  });
});
