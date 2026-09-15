// 从日志增量里挑出该播的音效与语音。
//
// 单独拆成纯函数是为了能直接测：这里的边界情况比看上去多
// （首次进局不补声音、一次快照带多个事件、快照窗口滑动等）。
import type { LogEntry } from '@sgs/protocol';
import { LOG_SFX } from './logSfx';
import type { SfxName } from './sfx';

export interface SfxPick {
  /** 本次要播的合成音效；null 表示不播 */
  name: SfxName | null;
  /** 本次要播的「动作」音效/语音（日志的 action）；null 表示不播 */
  action: string | null;
  /** 动作属于哪个座次（用来取该角色的性别播语音） */
  actionSeat: string | null;
  /** 推进后的游标（最后一条已处理的日志 id） */
  lastId: number;
}

/**
 * 给定上次处理到的日志 id 与本次快照里的日志窗口，返回要播的声音与新游标。
 *
 * 注意不能用日志长度当游标：快照只下发最近 50 条（见 engine 的 toSnapshot），
 * 到达上限后长度就不再增长，必须靠引擎给每条日志发配的自增 id。
 */
export function pickNewSfx(prevId: number, log: LogEntry[] | undefined): SfxPick {
  if (!log || log.length === 0) {
    return { name: null, action: null, actionSeat: null, lastId: -1 };
  }
  const newest = log[log.length - 1]!.id;
  // 首次拿到日志（进局 / 重连）：只对齐游标，不补放声音，
  // 否则一进局就会把开局那几条一起响出来
  if (prevId < 0) {
    return { name: null, action: null, actionSeat: null, lastId: newest };
  }

  // 一次快照可能带多个事件（南蛮入侵结算一整轮等），
  // 音效只取最后一个有音效的、动作取最后一个带动作的，否则会糊成一片
  let name: SfxName | null = null;
  let action: string | null = null;
  let actionSeat: string | null = null;
  for (const entry of log) {
    if (entry.id <= prevId) continue;
    const hit = LOG_SFX[entry.kind];
    if (hit) name = hit;
    if (entry.action) {
      action = entry.action;
      actionSeat = entry.seat ?? null;
    }
  }
  return { name, action, actionSeat, lastId: newest };
}
