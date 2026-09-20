// 从日志增量里挑出「该播哪位武将的哪句技能语音」。
//
// 为什么要单独一个纯函数：日志里**没有**结构化的技能名字段（引擎的 pushLog 只带 kind/seat/action），
// 所以「这条日志是哪个技能」要靠「这条座次手上那两个武将的技能名，谁出现在日志文本里」来判。
// 这种判断边界多（同一句里出现两个技能名、暗置武将没有 id、技能名是我们内部的合成名…），
// 拆出来直接测比在 useEffect 里试靠谱。
//
// 与 `pickNewSfx` 的分工：那边负责「音效 / 卡牌语音」（一条最新事件），这边负责「武将技能语音」与
// 「阵亡语音」（**每一条新日志都可能要出声**，所以按条遍历）。
import type { LogEntry } from '@sgs/protocol';

/** 一个座次手上那两个武将：id + 他们的技能名（含国战覆盖版） */
export interface SeatHeroes {
  heroId: string | null;
  deputyHeroId?: string | null;
  skills: string[];
}

export interface VoiceRequest {
  /** 谁的语音（座次） */
  seat: string;
  /** 用哪个武将的语音（主将或副将，取技能名命中的那个） */
  heroId: string;
  /** 技能名；`阵亡` 是阵亡语音 */
  skill: string;
}

export interface VoicePick {
  requests: VoiceRequest[];
  /** 推进后的游标 */
  lastId: number;
}

/** 从「技能名出现在文本里」判这条日志是哪个技能；找不到返回 null */
function skillInMessage(message: string, skills: string[]): string | null {
  // 长名字优先：避免「火计」先命中、而实际是「火计·强化」这类更长的写法
  const sorted = [...skills].sort((a, b) => b.length - a.length);
  for (const s of sorted) if (s && message.includes(s)) return s;
  return null;
}

/**
 * @param prevId   上次处理到的日志 id
 * @param log      本次快照里的日志窗口（只带最近若干条）
 * @param heroesOf 取某座次的两个武将（id + 技能名）；暗置/查不到就返回 null
 */
export function pickNewVoices(
  prevId: number,
  log: LogEntry[] | undefined,
  heroesOf: (seatId: string) => SeatHeroes | null,
): VoicePick {
  if (!log || log.length === 0) return { requests: [], lastId: -1 };
  const newest = log[log.length - 1]!.id;
  // 首次拿到日志（进局/重连）：只对齐游标，不补放（否则一进局把开局那几条一起念出来）
  if (prevId < 0) return { requests: [], lastId: newest };

  const requests: VoiceRequest[] = [];
  for (const entry of log) {
    if (entry.id <= prevId) continue;
    const seat = entry.seat;
    if (!seat) continue;
    const heroes = heroesOf(seat);
    if (!heroes) continue;
    // 阵亡：谁的阵亡语音（阵亡那一刻武将已经亮出来了，所以查得到）
    if (entry.kind === 'death') {
      if (heroes.heroId) requests.push({ seat, heroId: heroes.heroId, skill: '阵亡' });
      continue;
    }
    if (entry.kind !== 'skill') continue;
    const skill = skillInMessage(entry.message, heroes.skills);
    if (!skill) continue;
    // 技能名属于主将还是副将（两个武将的技能名一般不同名；同名时算主将）
    requests.push({ seat, heroId: heroes.heroId ?? heroes.deputyHeroId ?? '', skill });
  }
  return { requests, lastId: newest };
}
