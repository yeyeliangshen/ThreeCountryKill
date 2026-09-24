// 技能按钮。
//
// 独立于武将面板（不在那块深色框里），单独排在面板下方、靠左。
// 只显示技能名，悬停看效果说明；引擎说可用时点一下就发动。
import { useHoverTip } from './HoverTip';

export interface SkillRow {
  name: string;
  desc: string;
  /** 现在能不能点（引擎的 legalSkillIds / prelitableSkills 说了算） */
  usable: boolean;
  /** 正在配置这个技能，或（国战）已经预亮 */
  active: boolean;
  /**
   * 国战暗置相关的外观：
   * - 'dark'   暗置武将上的技能（还没生效）
   * - 'prelit' 已预亮（时机到了引擎会询问是否发动）
   * - 'reveal' 锁定技：此刻点它＝**主动明置该武将**（用户 2026-09-22 口径）
   */
  state?: 'dark' | 'prelit' | 'reveal';
  /**
   * **锁定技且已生效**（武将已明置、技能有效）——它没有「是否发动」这一步，是**持续生效**的
   * （用户 2026-09-25 确认口径：【红颜】这类锁定技「应持续按照技能文本自动修改…不需要玩家
   * 每次选择是否发动」）。
   *
   * chip 上给一枚「锁」标，悬停/点击的标题里写明「锁定技·持续生效」：玩家一眼能看出
   * 它**不是**一个「点了才发动」的按钮（暗置那侧的明置/预亮入口见 `state`）。
   */
  always?: boolean;
  /**
   * 悬停标题里那句「点了会怎样」（不带括号）。
   *
   * 缺省按 `state` 推（暗置 / 已预亮 / 点击＝明置该武将），但国战暗置的**锁定技**由调用方
   * 明确写死：同一个技能 chip 在出牌阶段是「明置该武将」、其余时机是「预亮」，
   * 玩家必须一眼分清这两件事（用户 2026-09-22 口径）。
   */
  action?: string;
  onClick: () => void;
}

/** `state` 决定的那句默认「点了会怎样」 */
function defaultAction(state: SkillRow['state']): string {
  if (state === 'reveal') return '点击＝明置该武将（锁定技）';
  if (state === 'prelit') return '已预亮';
  if (state === 'dark') return '暗置';
  return '';
}

/** 悬停标题：`技能名（点了会怎样）`；没有动作可言时就是技能名 */
function tipTitle(sk: SkillRow): string {
  const action = sk.action ?? defaultAction(sk.state);
  // 已生效的锁定技：标题里直说「持续生效」，免得玩家等一个「是否发动」的询问
  if (!action && sk.always) return `${sk.name}（锁定技·持续生效）`;
  return action ? `${sk.name}（${action}）` : sk.name;
}

export function SkillButtons({ skills }: { skills: SkillRow[] }) {
  const { bind, tipNode } = useHoverTip();
  if (skills.length === 0) return null;
  return (
    <div className="skill-bar">
      {skills.map((sk) => (
        <button
          key={sk.name}
          className={`skill-chip ${sk.usable ? 'usable' : ''} ${sk.active ? 'active' : ''} ${sk.state ?? ''}`}
          // 用 aria-disabled 而不是 disabled：禁用元素收不到鼠标事件，
          // 那样就没法悬停看技能说明了（和手牌同样的处理）
          aria-disabled={!sk.usable}
          {...bind(tipTitle(sk), sk.desc)}
          onClick={() => {
            if (!sk.usable) return;
            sk.onClick();
          }}
        >
          {sk.name}
          {/* 点它＝明置该武将（国战暗置的锁定技，自己的出牌阶段）。
              手机上要长按才看得到悬停说明，所以动作写在 chip 上（用户 2026-09-22 口径）。 */}
          {sk.state === 'reveal' && <span className="chip-action">明置</span>}
          {/* 已生效的锁定技：标出「锁」，说明它是持续生效、没有「是否发动」这一步
              （用户 2026-09-25 口径：【红颜】这类锁定技不该每次弹询问） */}
          {sk.always && (
            <span className="chip-lock" title="锁定技：持续生效">
              锁
            </span>
          )}
        </button>
      ))}
      {tipNode}
    </div>
  );
}
