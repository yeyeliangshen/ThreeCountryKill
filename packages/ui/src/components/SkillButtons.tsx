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
   */
  state?: 'dark' | 'prelit';
  onClick: () => void;
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
          {...bind(
            sk.name +
              (sk.state === 'prelit' ? '（已预亮）' : sk.state === 'dark' ? '（暗置）' : ''),
            sk.desc,
          )}
          onClick={() => {
            if (!sk.usable) return;
            sk.onClick();
          }}
        >
          {sk.name}
        </button>
      ))}
      {tipNode}
    </div>
  );
}
