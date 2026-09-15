import { describe, it, expect } from 'vitest';
import type { LogEntry } from '@sgs/protocol';
import { pickNewSfx } from './pickNewSfx';
import { hasVoice } from './voice';

/** 造日志条目：id 从 startId 起依次递增，kind 按传入顺序 */
function entries(startId: number, kinds: string[]): LogEntry[] {
  return kinds.map((kind, i) => ({ id: startId + i, kind, message: `${kind}-${startId + i}` }));
}

// 映射关系（见 logSfx.ts）：sha→card  damage→damage  draw→无

describe('pickNewSfx', () => {
  it('首次拿到日志不发声，只把游标对齐到最新', () => {
    const log = entries(0, ['start', 'damage', 'sha']);
    const r = pickNewSfx(-1, log);
    expect(r.name).toBe(null);
    expect(r.lastId).toBe(2);
  });

  it('没有日志时游标重置，下次重新对齐', () => {
    expect(pickNewSfx(7, [])).toEqual({ name: null, action: null, actionSeat: null, lastId: -1 });
    expect(pickNewSfx(7, undefined)).toEqual({
      name: null,
      action: null,
      actionSeat: null,
      lastId: -1,
    });
  });

  it('已处理到 id 1，则 id 2 的 sha 触发 card', () => {
    const log = entries(0, ['start', 'damage', 'sha']);
    const r = pickNewSfx(1, log);
    expect(r.name).toBe('card');
    expect(r.lastId).toBe(2);
  });

  it('新增多条只播最后一个，避免糊成一片', () => {
    // 南蛮入侵结算一整轮：出杀 → 受伤 → 出杀 → 受伤
    const log = entries(0, ['start', 'sha', 'damage', 'sha', 'damage']);
    const r = pickNewSfx(0, log);
    expect(r.name).toBe('damage');
    expect(r.lastId).toBe(4);
  });

  it('新增的条目都没映射时不发声，但游标要推进', () => {
    const log = entries(0, ['start', 'draw', 'discard', 'draw']);
    const r = pickNewSfx(1, log);
    expect(r.name).toBe(null);
    expect(r.lastId).toBe(3);
  });

  it('窗口滑动：只认 id 大于游标的条目，被挤出去的老条目不算新', () => {
    // 快照只带最近 50 条，窗口整体前移后 id 40 的旧条目仍在数组里
    const log = entries(40, ['draw', 'sha']);
    const r = pickNewSfx(40, log);
    expect(r.name).toBe('card'); // 只有 id 41 的 sha 是新条目
    expect(r.lastId).toBe(41);
  });

  it('窗口没动时不重复发声', () => {
    const log = entries(40, ['sha', 'damage']);
    const first = pickNewSfx(40, log);
    expect(first.name).toBe('damage');
    const again = pickNewSfx(first.lastId, log);
    expect(again.name).toBe(null);
    expect(again.lastId).toBe(41);
  });

  it('换局后日志 id 从头开始时游标回退对齐，不会一直卡着不出声', () => {
    // 上一局游标已经到 99，新一局 id 重新从小数字开始
    const log = entries(40, ['sha', 'damage']);
    const r = pickNewSfx(99, log);
    expect(r.name).toBe(null); // 这一拍不补声音
    expect(r.lastId).toBe(41); // 游标对齐到新窗口
    // 之后的新事件照常发声
    expect(pickNewSfx(r.lastId, entries(40, ['sha', 'damage', 'judge'])).name).toBe('judge');
  });
});

describe('pickNewSfx：动作与座次（供音效/语音用）', () => {
  /** 带 action/seat 的日志条目 */
  function withAction(id: number, kind: string, action?: string, seat?: string): LogEntry {
    return { id, kind, message: `${kind}-${id}`, ...(action ? { action } : {}), ...(seat ? { seat } : {}) };
  }

  it('带 action 的条目会把动作与座次一起带出来', () => {
    const log = [withAction(0, 'sha', 'sha-fire', 's1')];
    const r = pickNewSfx(0, [withAction(1, 'sha', 'sha-fire', 's1')]);
    expect(r.action).toBe('sha-fire');
    expect(r.actionSeat).toBe('s1');
    expect(log.length).toBe(1);
  });

  it('首次进局同样不补动作，只对齐游标', () => {
    const r = pickNewSfx(-1, [withAction(0, 'sha', 'sha', 's0')]);
    expect(r.action).toBe(null);
    expect(r.actionSeat).toBe(null);
    expect(r.lastId).toBe(0);
  });

  it('一次快照多个动作时取最后一个（与音效的取舍规则一致）', () => {
    const log = [
      withAction(0, 'sha', 'sha', 's0'),
      withAction(1, 'shan', 'shan', 's1'),
      withAction(2, 'trick', 'wanjian', 's0'),
    ];
    const r = pickNewSfx(0, log);
    expect(r.action).toBe('wanjian');
    expect(r.actionSeat).toBe('s0');
  });

  it('没有 action 的条目不影响动作，但音效照旧按 kind 出', () => {
    const log = [withAction(0, 'draw'), withAction(1, 'damage')];
    const r = pickNewSfx(0, log);
    expect(r.action).toBe(null);
    expect(r.name).toBe('damage');
  });

  it('hasVoice：只有带语音的动作会被标记', () => {
    expect(hasVoice('sha')).toBe(true);
    expect(hasVoice('sha-thunder')).toBe(true);
    // 装备/盾破/自残属于音效不属于卡牌语音
    expect(hasVoice('equip')).toBe(false);
    expect(hasVoice('shield')).toBe(false);
  });
});
