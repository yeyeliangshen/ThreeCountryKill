/**
 * **测试场景编辑器 / Test Scenario Setup**（开发工具，docs §5.206）。
 *
 * 用户 2026-09-23 拍板加的「发牌自选」升级版：给指定角色发指定的牌、放进指定区域，
 * 让「寒冰剑 / 度势② / 分区面板三栏」这类人工真机验收不必再靠刷牌刷到为止。
 *
 * 边界（与引擎同一条口径）：
 *   · **只在开发模式出现**——服务端 `devTools`（`SGS_DEV_TOOLS` / 非 production）为真、
 *     且是 dev 构建时，Game 页才会渲染它；正式对局连入口都没有。
 *   · **不绕过规则流程**——面板只是把「谁 / 哪张牌 / 哪个区域」打包成一条 `testScenario` 意图，
 *     移动与校验全在引擎里走既有搬运逻辑（见 `applyTestScenario`）。
 *   · 区域可用性取 `testDealZonesFor`（引擎导出的**唯一判据**），界面不自己写一套，
 *     所以「寒冰剑只能去手牌/装备区」「乐不思蜀能去判定区」在界面上就是灰按钮。
 *   · 每次发放引擎都会在牌局日志里写 `TEST_DEAL_OVERRIDE`，测试局面一眼认得出。
 *
 * 有意做成「哑组件」：数据（玩家列表、选牌目录）与回调都由 Game 页注入，
 * 这样它可以像别的面板一样用 `renderToStaticMarkup` 直接测。
 */
import { useMemo, useState } from 'react';
import { testDealZonesFor, type TestScenarioCard } from '@sgs/engine';
import type { TestDealZone } from '@sgs/protocol';

export interface TestScenarioPanelProps {
  players: { seatId: string; name: string }[];
  /** 默认选中的目标（一般是我自己） */
  defaultSeatId: string | null;
  /** 选牌目录：当前模式实际牌堆（由 Game 页用 testScenarioCatalog 算好） */
  catalog: TestScenarioCard[];
  onDeal: (seatId: string, cardId: string, zone: TestDealZone) => void;
  onJie: (seatId: string, count: number) => void;
  /** 给目标发 N 张「魂」（左慈·役鬼的资源；从「未加入游戏的武将牌堆」里抽） */
  onHun: (seatId: string, count: number) => void;
  onClose: () => void;
}

const ZONE_LABEL: Record<TestDealZone, string> = {
  hand: '手牌',
  equip: '装备区',
  judge: '判定区',
};
const ALL_ZONES: TestDealZone[] = ['hand', 'equip', 'judge'];

export function TestScenarioPanel({
  players,
  defaultSeatId,
  catalog,
  onDeal,
  onJie,
  onHun,
  onClose,
}: TestScenarioPanelProps) {
  const [seatId, setSeatId] = useState<string | null>(defaultSeatId ?? players[0]?.seatId ?? null);
  const [filter, setFilter] = useState('');
  const [cardId, setCardId] = useState<string | null>(null);
  const [zone, setZone] = useState<TestDealZone>('hand');
  const [jieCount, setJieCount] = useState(3);
  /** 「魂」默认发 2 张（左慈首次明置就是 2 张，正好对上） */
  const [hunCount, setHunCount] = useState(2);

  const shown = useMemo(() => {
    const kw = filter.trim();
    const list = kw ? catalog.filter((c) => c.name.includes(kw)) : catalog;
    return list.slice(0, 200);
  }, [catalog, filter]);

  const picked = useMemo(() => catalog.find((c) => c.id === cardId) ?? null, [catalog, cardId]);
  const zones = picked ? testDealZonesFor(picked) : ALL_ZONES;
  const effectiveZone = zones.includes(zone) ? zone : zones[0]!;

  return (
    <div className="dev-setup" role="dialog" aria-label="测试场景编辑器">
      <div className="ds-head">
        <span className="ds-title">测试场景编辑器（开发工具）</span>
        <button className="ghost ds-close" onClick={onClose}>
          关闭
        </button>
      </div>

      <div className="ds-row">
        <span className="ds-label">目标玩家</span>
        <div className="ds-seats">
          {players.map((p) => (
            <button
              key={p.seatId}
              className={`ds-seat${p.seatId === seatId ? ' picked' : ''}`}
              onClick={() => setSeatId(p.seatId)}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      <div className="ds-row">
        <span className="ds-label">牌</span>
        <input
          className="ds-filter"
          placeholder="过滤牌名（如 寒冰剑 / 火杀 / 乐不思蜀）"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="ds-cards">
        {shown.map((c) => {
          const can = testDealZonesFor(c);
          return (
            <button
              key={c.id}
              className={`ds-card${c.id === cardId ? ' picked' : ''}`}
              title={`${ZONE_LABEL[c.zone]}｜全牌堆 ${c.copies} 张${
                can.length > 1 ? `｜可放：${can.map((z) => ZONE_LABEL[z]).join('/')}` : ''
              }`}
              onClick={() => {
                setCardId(c.id);
                const zs = testDealZonesFor(c);
                if (!zs.includes(zone)) setZone(zs[0]!);
              }}
            >
              {c.name}
              {c.copies > 1 ? <span className="ds-copies">×{c.copies}</span> : null}
            </button>
          );
        })}
        {shown.length === 0 ? <span className="ds-empty">没有匹配的牌</span> : null}
      </div>

      <div className="ds-row">
        <span className="ds-label">区域</span>
        <div className="ds-zones">
          {ALL_ZONES.map((z) => {
            const enabled = zones.includes(z);
            return (
              <button
                key={z}
                className={`ds-zone${z === effectiveZone ? ' picked' : ''}`}
                disabled={!enabled}
                title={enabled ? '' : `这张牌不能放进${ZONE_LABEL[z]}`}
                onClick={() => setZone(z)}
              >
                {ZONE_LABEL[z]}
              </button>
            );
          })}
        </div>
        <button
          className="ds-deal"
          disabled={!seatId || !picked}
          onClick={() => {
            if (seatId && picked) onDeal(seatId, picked.id, effectiveZone);
          }}
        >
          发放
        </button>
      </div>

      <div className="ds-row ds-jie">
        <span className="ds-label">「节」</span>
        <span className="ds-hint">给目标压 N 张「节」（陆逊·度势② 要 3 张，上限 3）</span>
        <input
          className="ds-count"
          type="number"
          min={1}
          max={3}
          value={jieCount}
          onChange={(e) => setJieCount(Math.max(1, Math.min(3, Number(e.target.value) || 1)))}
        />
        <button
          className="ds-deal"
          disabled={!seatId}
          onClick={() => {
            if (seatId) onJie(seatId, jieCount);
          }}
        >
          发放节
        </button>
      </div>

      <div className="ds-row ds-hun">
        <span className="ds-label">「魂」</span>
        <span className="ds-hint">
          给目标扣 N 张「魂」（左慈·役鬼的私有资源；从「未加入游戏的武将牌堆」里抽）
        </span>
        <input
          className="ds-count"
          type="number"
          min={1}
          max={8}
          value={hunCount}
          onChange={(e) => setHunCount(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
        />
        <button
          className="ds-deal"
          disabled={!seatId}
          onClick={() => {
            if (seatId) onHun(seatId, hunCount);
          }}
        >
          发放魂
        </button>
      </div>

      <p className="ds-note">
        每次发放都会在牌局日志里留下 <code>TEST_DEAL_OVERRIDE</code> 标记，正式对局不显示本面板。
      </p>
    </div>
  );
}
