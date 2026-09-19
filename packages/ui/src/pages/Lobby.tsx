import type { GameMode } from '@sgs/protocol';
import { configFromPreset, GUOZHAN_PRESETS } from '@sgs/engine';

import { useStore } from '../store';

// 各模式中文名 + 人数要求（与服务端 modeMinPlayers/modeMaxPlayers 保持一致）
const MODE_INFO: { mode: GameMode; label: string; min: number; max: number; disabled?: boolean }[] =
  [
    { mode: 'melee', label: '混战', min: 2, max: 8 },
    { mode: '2v2', label: '2v2', min: 4, max: 4 },
    { mode: 'junzheng', label: '军争（身份）', min: 5, max: 8 },
    { mode: 'guozhan', label: '国战', min: 2, max: 8 },
  ];

export function Lobby() {
  const lobby = useStore((s) => s.lobby);
  const claimSeat = useStore((s) => s.claimSeat);
  const heroDealCount = useStore((s) => s.heroDealCount);
  const setForm = useStore((s) => s.setForm);
  const setMode = useStore((s) => s.setMode);
  const setFreePick = useStore((s) => s.setFreePick);
  const setExtension = useStore((s) => s.setExtension);
  const setGuozhanConfig = useStore((s) => s.setGuozhanConfig);
  const startGame = useStore((s) => s.startGame);
  const leaveRoom = useStore((s) => s.leaveRoom);

  if (!lobby) return null;
  const mySeatId = lobby.mySeatId;
  const mySeat = lobby.seats.find((s) => s.seatId === mySeatId);
  const occupied = lobby.seats.filter((s) => s.name);
  const amHost = mySeat?.isHost;
  const currentMode = lobby.mode;
  const modeInfo = MODE_INFO.find((m) => m.mode === currentMode);
  const playerCount = occupied.length;
  const canStart = amHost && modeInfo && playerCount >= modeInfo.min && playerCount <= modeInfo.max;

  return (
    <div className="lobby">
      <header>
        <span>房间号：{lobby.roomCode}</span>
        <button
          className="ghost"
          onClick={leaveRoom}
          title="离开房间回大厅（房子里没人了这个房间就关了）"
        >
          离开房间
        </button>
      </header>

      {/* 模式选择 */}
      <section className="mode-selector">
        <div className="mode-selector-title">游戏模式</div>
        <div className="mode-buttons">
          {MODE_INFO.map((m) => {
            const active = currentMode === m.mode;
            return (
              <button
                key={m.mode}
                className={`mode-btn ${active ? 'active' : ''} ${m.disabled ? 'disabled' : ''}`}
                disabled={!amHost || m.disabled}
                onClick={() => !m.disabled && setMode(m.mode)}
              >
                {m.label}
                {m.disabled && <small> 敬请期待</small>}
                {!m.disabled && (
                  <small> {m.min === m.max ? `${m.min}人` : `${m.min}-${m.max}人`}</small>
                )}
              </button>
            );
          })}
        </div>
        {!amHost && <div className="hint">房主选择：{modeInfo?.label ?? currentMode}</div>}
      </section>

      <section className="seats-grid">
        {lobby.seats.map((s) => {
          const mine = s.seatId === mySeatId;
          // 空座位：还没落座的人可以坐；**离线座位：谁都能点**——
          // 点它就等于认回/接替那个玩家（服务端会保留原武将），
          // 这样锁屏、刷新、换设备都能回到原来的位置。
          const empty = s.name === null;
          const offline = s.name !== null && !s.connected;
          const clickable = !mine && (empty ? !mySeatId : offline);
          return (
            <div
              key={s.seatId}
              className={`seat ${mine ? 'mine' : ''} ${clickable ? 'clickable' : ''}`}
              title={
                offline
                  ? `${s.name} 离线了，点一下接替他`
                  : empty && !mySeatId
                    ? '点一下坐这里'
                    : undefined
              }
              onClick={clickable ? () => claimSeat(s.seatId) : undefined}
            >
              <div className="seat-no">座位 {s.seatId}</div>
              <div className="seat-name">
                {s.name ?? '空闲'}
                {s.isHost && <span className="host-tag">房主</span>}
              </div>
              {!s.connected && s.name && <div className="seat-offline">离线</div>}
            </div>
          );
        })}
      </section>

      <footer className="lobby-foot">
        {amHost ? (
          <div className="host-controls">
            <label className="deal-count">
              每人发将数
              <input
                type="number"
                min={1}
                max={5}
                value={heroDealCount}
                onChange={(e) => {
                  const n = Math.max(1, Math.min(5, Number(e.target.value) || 1));
                  setForm({ heroDealCount: n });
                }}
              />
            </label>
            <label className="free-pick" title="测试用：勾上后选将阶段所有人都能从全部武将里挑">
              <input
                type="checkbox"
                checked={lobby.freePick}
                onChange={(e) => setFreePick(e.target.checked)}
              />
              选将不限（测试用）
            </label>
            <label
              className="shibei"
              title="国战的游戏牌扩展：开启后国战牌堆追加 52 张（只对国战生效）"
            >
              <input
                type="checkbox"
                checked={lobby.config.extensions.shibei === 'current'}
                onChange={(e) => setExtension('shibei', e.target.checked ? 'current' : 'off')}
              />
              势备篇（+52 张）
            </label>
            <label
              className="buchen"
              title="不臣篇：野心家武将、双势力武将、暴露野心/建立新势力、势力锦囊（牌与机制尚未实装，先占位）"
            >
              <input
                type="checkbox"
                checked={lobby.config.extensions.buchen === 'current'}
                onChange={(e) => setExtension('buchen', e.target.checked ? 'current' : 'off')}
              />
              不臣篇（占位）
            </label>
            <label
              className="junlintianxia"
              title="2026 君临天下：启用君主将与专属装备（关闭后君主将不进选将池）"
            >
              <input
                type="checkbox"
                checked={lobby.config.extensions.junlintianxia === '2026'}
                onChange={(e) =>
                  setExtension('junlintianxia', e.target.checked ? '2026' : 'off')
                }
              />
              君临天下（君主将）
            </label>
            {(
              [
                ['zhen', '君临天下·阵（8 人）'],
                ['shi', '君临天下·势（8 人）'],
                ['bian', '君临天下·变（8 人）'],
                ['quan', '君临天下·权（8 人）'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className={key} title={`${label}：关闭时该包武将不进选将池`}>
                <input
                  type="checkbox"
                  checked={lobby.config.extensions[key] === 'current'}
                  onChange={(e) => setExtension(key, e.target.checked ? 'current' : 'off')}
                />
                {label}
              </label>
            ))}
            <div className="preset-hint" title="预设只是「一键生成配置」；手动改任何一项就会变成自定义">
              当前：
              {(() => {
                const ext = lobby.config.extensions;
                const same = (p: 'standard' | 'full2026') =>
                  JSON.stringify(ext) === JSON.stringify(GUOZHAN_PRESETS[p].extensions);
                if (same('standard')) return '标准国战';
                if (same('full2026')) return '全扩展2026';
                return '自定义';
              })()}
            </div>
            <div className="preset-row">
              {(['standard', 'full2026'] as const).map((name) => (
                <button
                  key={name}
                  className="preset-btn"
                  title={name === 'standard' ? '三个扩展全关' : '势备 + 不臣 + 2026 君临天下'}
                  onClick={() => setGuozhanConfig(configFromPreset(name))}
                >
                  {name === 'standard' ? '标准国战' : '全扩展2026'}
                </button>
              ))}
            </div>
            <button className="primary big" disabled={!canStart} onClick={startGame}>
              {canStart ? '开始游戏' : `等待玩家入座（${playerCount}/${modeInfo?.min ?? 2} 人）`}
            </button>
          </div>
        ) : (
          <div className="hint">{amHost === undefined ? '请先落座' : '等待房主开始游戏…'}</div>
        )}
      </footer>
    </div>
  );
}
