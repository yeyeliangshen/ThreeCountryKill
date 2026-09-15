// 技能按钮。
//
// 独立于武将面板（不在那块深色框里），单独排在面板下方、靠左。
// 只显示技能名，悬停看效果说明；引擎说可用时点一下就发动。
import { useHoverTip } from './HoverTip';

export interface SkillRow {
  name: string;
  desc: string;
  /** 现在能不能点（引擎的 legalSkillIds 说了算） */
  usable: boolean;
  /** 正在配置这个技能 */
  active: boolean;
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
          className={`skill-chip ${sk.usable ? 'usable' : ''} ${sk.active ? 'active' : ''}`}
          // 用 aria-disabled 而不是 disabled：禁用元素收不到鼠标事件，
          // 那样就没法悬停看技能说明了（和手牌同样的处理）
          aria-disabled={!sk.usable}
          {...bind(sk.name, sk.desc)}
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
