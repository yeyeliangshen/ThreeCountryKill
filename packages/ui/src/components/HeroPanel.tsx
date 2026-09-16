// 武将面板。
//
// 结构：
//   ┌─ 面板 ─────────────────────┐
//   │  群   ┌──────────────┐     │   左列上部：国家徽章 + 竖排武将名
//   │  华   │              │     │   右侧：原画（完整显示，不裁切）
//   │  佗   │     原画      │     │
//   │       │              │     │   面板高度 = 原画高度，原画下面不留白
//   │  ◆    └──────────────┘     │   左列下部：装备判定 + 竖排血量（压到底部）
//   │  ◆                         │
//   └───────────────────────────┘
// 技能不在这里——是左边独立的一列按钮（面板框外），见 SkillButtons.tsx。
// 不显示玩家自己的名字（甲/乙），只显示武将信息。
//
// 原画按 <武将 id>.jpg 放在 packages/ui/assets/heroes/ 下，见 heroArt.ts。
import { ROLE_NAME, FACTION_NAME, MARKER_DESC } from '@sgs/engine';
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
  /** 可以把「自己」选成目标时（铁索连环），面板整体可点 */
  onSelect?: () => void;
  targetable?: boolean;
  picked?: boolean;
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
      {...bind(
        `${slot.name}　体力 ${hp}/${maxHp}`,
        slot.hidden ? '国战暗将：亮将后才能使用技能。' : '',
      )}
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

export function HeroPanel({ me, mode, slots, onSelect, targetable, picked }: HeroPanelProps) {
  const { bind, tipNode } = useHoverTip();
  const teamClass = mode === '2v2' ? `team-${me.team ?? 0}` : '';
  // 国战用玩家的阵营（可能是野心家），其他模式用武将自身的阵营
  const faction = mode === 'guozhan' ? me.faction : (slots[0]?.faction ?? null);
  const factionClass = mode === 'guozhan' && me.faction ? `faction-${me.faction}` : '';

  return (
    <div
      className={`hero-panel ${teamClass} ${factionClass} ${me.isAlive ? '' : 'dead'} ${targetable ? 'targetable' : ''} ${picked ? 'picked-target' : ''}`}
      onClick={onSelect}
    >
      {/* 左列：顶部是国家徽章 + 竖排武将名，底部是装备判定 + 竖排血量 */}
      <div className="hero-info">
        <div className="hero-info-top">
          {me.role && mode === 'junzheng' && (
            <span className={`role-badge role-${me.role}`}>{ROLE_NAME[me.role]}</span>
          )}
          {faction && <span className={`faction-badge ${faction}`}>{FACTION_NAME[faction]}</span>}
          {/* 国战标记（公开信息）：先驱 / 阴阳鱼 / 珠联璧合 */}
          {me.markers?.map((m) => (
            <span
              key={m.id}
              className={`marker-chip mark-${m.id}`}
              {...bind(
                `【${m.label}】${m.count > 1 ? ` ×${m.count}` : ''}`,
                MARKER_DESC[m.id] ?? '',
              )}
            >
              {m.label}
              {m.count > 1 && <span className="marker-count">{m.count}</span>}
            </span>
          ))}
          {/* 武将牌翻面朝上（公开信息）：会跳过下一个回合 */}
          {me.flipped && (
            <span
              className="marker-chip mark-flip"
              {...bind('翻面', '武将牌翻面朝上：跳过你的下一个回合，然后翻回正面。')}
            >
              翻
            </span>
          )}
          {/* 横置状态（铁索连环）：属性伤害会沿横置的角色蔓延 */}
          {me.chained && (
            <span
              className="marker-chip mark-chained"
              {...bind(
                '横置',
                '处于铁索连环状态：受到属性伤害时会重置，并让其他横置的角色受到同样的伤害。',
              )}
            >
              横
            </span>
          )}
          <span className="hi-name">{slots.map((s) => s.name).join(' + ')}</span>
        </div>

        {/* 底部：装备判定 + 血量（勾玉竖排，压到面板底部） */}
        <div className="hero-info-foot">
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
          <span className="hi-hp">
            {Array.from({ length: me.maxHp }).map((_, i) => (
              <span key={i} className={`hp-cell ${i < me.hp ? 'on' : ''}`} />
            ))}
          </span>
        </div>
      </div>

      {/* 原画：按 1 : 1.415 完整显示，不裁切。高度决定面板高度 */}
      <div className="hero-portraits">
        {slots.map((s, i) => (
          <Portrait key={i} slot={s} hp={me.hp} maxHp={me.maxHp} bind={bind} />
        ))}
      </div>

      {tipNode}
    </div>
  );
}
