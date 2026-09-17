import type { GameMode } from '@sgs/protocol';
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
  const setShibei = useStore((s) => s.setShibei);
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
                checked={lobby.shibei}
                onChange={(e) => setShibei(e.target.checked)}
              />
              势备篇（+52 张）
            </label>
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
