import { describe, it, expect } from 'vitest';
import type { LogEntry } from '@sgs/protocol';
import { pickNewVoices, type SeatHeroes } from './pickNewVoices';

const e = (id: number, kind: string, message: string, seat?: string): LogEntry =>
  ({ id, kind, message, ...(seat ? { seat } : {}) }) as LogEntry;

/** 甲（周瑜·反间/英姿）乙（暗置，查不到） */
const HEROES: Record<string, SeatHeroes> = {
  s0: { heroId: 'zhouyu', deputyHeroId: 'huanggai', skills: ['反间', '英姿', '苦肉'] },
  s1: { heroId: null, deputyHeroId: null, skills: [] },
};
const heroesOf = (seat: string): SeatHeroes | null => HEROES[seat] ?? null;

describe('武将语音的挑选（技能 / 阵亡）', () => {
  it('首次拿到日志只对齐游标，不补放', () => {
    const log = [e(1, 'skill', '甲 发动【反间】。', 's0')];
    expect(pickNewVoices(-1, log, heroesOf)).toEqual({ requests: [], lastId: 1 });
  });

  it('技能日志 → 按「技能名出现在文本里」对上武将', () => {
    const log = [e(1, 'skill', '甲 发动【反间】向乙展示一张手牌。', 's0')];
    const r = pickNewVoices(0, log, heroesOf);
    expect(r.requests).toEqual([{ seat: 's0', heroId: 'zhouyu', skill: '反间' }]);
    expect(r.lastId).toBe(1);
  });

  it('技能名取**最长**匹配（避免短名先命中）', () => {
    const log = [e(1, 'skill', '甲 发动【火计强化】。', 's0')];
    const r = pickNewVoices(0, log, (s) =>
      s === 's0' ? { heroId: 'wolong', skills: ['火计', '火计强化'] } : null,
    );
    expect(r.requests[0]?.skill).toBe('火计强化');
  });

  it('阵亡日志 → 阵亡语音；暗置（查不到武将）与无座次的日志都跳过', () => {
    const log = [
      e(1, 'skill', '甲 发动【反间】。', 's0'),
      e(2, 'damage', '甲 受到 1 点伤害。', 's0'), // 不是 skill/death → 不出声
      e(3, 'death', '乙 阵亡。', 's1'), // 暗置 → 查不到武将 → 跳过
      e(4, 'death', '甲 阵亡。', 's0'),
      e(5, 'skill', '丙 发动【反间】。'), // 没有 seat → 跳过
    ];
    const r = pickNewVoices(0, log, heroesOf);
    expect(r.requests).toEqual([
      { seat: 's0', heroId: 'zhouyu', skill: '反间' },
      { seat: 's0', heroId: 'zhouyu', skill: '阵亡' },
    ]);
    expect(r.lastId).toBe(5);
  });

  it('只处理游标之后的新日志；一次快照带多条新日志时全部处理', () => {
    const log = [
      e(1, 'skill', '甲 发动【英姿】。', 's0'),
      e(2, 'skill', '甲 发动【苦肉】。', 's0'),
      e(3, 'skill', '甲 发动【反间】。', 's0'),
    ];
    const r = pickNewVoices(1, log, heroesOf);
    expect(r.requests.map((x) => x.skill)).toEqual(['苦肉', '反间']);
    expect(r.lastId).toBe(3);
  });

  it('技能名对不上（源资源包没有这条）→ 不出声', () => {
    const log = [e(1, 'skill', '甲 发动【业炎】。', 's0')];
    expect(pickNewVoices(0, log, heroesOf).requests).toEqual([]);
  });
});
