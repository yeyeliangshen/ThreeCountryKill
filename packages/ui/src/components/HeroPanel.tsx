// 武将面板。
//
// 结构：
//   ┌─ 面板 ─────────────────────┐
//   │  群   ┌──────────────┐     │   左上：国家徽章 + 竖排武将名
//   │  华   │              │     │   右侧：原画（完整显示，不裁切）
//   │  佗   │     原画      │     │
//   │       └──────────────┘     │
//   │  ◆◆◆◆   装备 / 判定        │   底排：血量勾玉 + 装备判定
//   └───────────────────────────┘
// 技能不在这里——是面板左边独立的一排按钮，见 SkillButtons.tsx。
// 不显示玩家自己的名字（甲/乙），只显示武将信息。
//
// 原画按 <武将 id>.jpg 放在 packages/ui/assets/heroes/ 下，见 heroArt.ts。
import { ROLE_NAME, FACTION_NAME } from '@sgs/engine';
import {
  cardDescription,
  cardShortName,
  type Card,
  type Faction,
  type GameMode,
  type PlayerView,
} from '@sgs/protocol';
import { heroArt } from './heroArt';
import { useHoverTip } from './HoverTip';

/** 一个武将占位（国战有主将 / 副将两个） */
export interface HeroSlot {
  /** 用于查原画；PlayerView 里可能为 undefined */
  heroId?: string | null;
  name: string;
  faction: Faction | null;
  /** 国战未亮将 */
  hidden: boolean;
  /** 国战：'主将' / '副将'；其他模式为 null */
  slotLabel: string | null;
  /** 有值则显示「亮将」按钮 */
  onReveal?: () => void;
}

export interface HeroPanelProps {
  me: PlayerView;
  mode: GameMode;
  slots: HeroSlot[];
}

function Portrait({
  slot,
  hp,
  maxHp,
  bind,
}: {
  slot: HeroSlot;
  hp: number;
  maxHp: number;
  bind: (title: string, desc: string) => Record<string, unknown>;
}) {
  const art = heroArt(slot.heroId);
  return (
    <div
      className={`portrait ${slot.faction ? `faction-${slot.faction}` : ''} ${slot.hidden ? 'unrevealed' : ''}`}
      {...bind(`${slot.name}　体力 ${hp}/${maxHp}`, slot.hidden ? '国战暗将：亮将后才能使用技能。' : '')}
    >
      {art ? (
        <img className="portrait-photo" src={art} alt={slot.name} />
      ) : (
        // 没有原画的武将（如中立「平民」）回退成名字占位
        <span className="portrait-name">{slot.name}</span>
      )}
      {slot.hidden && <span className="portrait-dim">暗</span>}
      {slot.slotLabel && <span className="portrait-tag">{slot.slotLabel}</span>}
      {slot.onReveal && (
        <button className="portrait-reveal" onClick={slot.onReveal}>
          亮将
        </button>
      )}
    </div>
  );
}

export function HeroPanel({ me, mode, slots }: HeroPanelProps) {
  const { bind, tipNode } = useHoverTip();
  const teamClass = mode === '2v2' ? `team-${me.team ?? 0}` : '';
  // 国战用玩家的阵营（可能是野心家），其他模式用武将自身的阵营
  const faction = mode === 'guozhan' ? me.faction : slots[0]?.faction ?? null;
  const factionClass = mode === 'guozhan' && me.faction ? `faction-${me.faction}` : '';

  return (
    <div className={`hero-panel ${teamClass} ${factionClass} ${me.isAlive ? '' : 'dead'}`}>
      <div className="hero-main">
        {/* 左上：国家徽章 + 武将名（竖排） */}
        <div className="hero-info">
          {me.role && mode === 'junzheng' && (
            <span className={`role-badge role-${me.role}`}>{ROLE_NAME[me.role]}</span>
          )}
          {faction && <span className={`faction-badge ${faction}`}>{FACTION_NAME[faction]}</span>}
          <span className="hi-name">{slots.map((s) => s.name).join(' + ')}</span>
        </div>

        {/* 原画：按 1 : 1.415 完整显示，不裁切 */}
        <div className="hero-portraits">
          {slots.map((s, i) => (
            <Portrait key={i} slot={s} hp={me.hp} maxHp={me.maxHp} bind={bind} />
          ))}
        </div>
      </div>

      {/* 底排：血量勾玉 + 装备 / 判定 */}
      <div className="hero-foot">
        <span className="hi-hp">
          {Array.from({ length: me.maxHp }).map((_, i) => (
            <span key={i} className={`hp-cell ${i < me.hp ? 'on' : ''}`} />
          ))}
        </span>
        {(me.equipment.length > 0 || me.judgment.length > 0) && (
          <span className="hero-zones">
            {me.equipment.map((c: Card) => (
              <span
                key={c.id}
                className={`equip-icon equip-${c.type}`}
                title={`${cardShortName(c)}\n${cardDescription(c)}`}
              >
                {cardShortName(c)}
              </span>
            ))}
            {me.judgment.map((c: Card) => (
              <span
                key={c.id}
                className="judge-icon"
                title={`${cardShortName(c)}\n${cardDescription(c)}`}
              >
                {cardShortName(c)}
              </span>
            ))}
          </span>
        )}
      </div>

      {tipNode}
    </div>
  );
}
