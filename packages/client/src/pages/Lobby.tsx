import { useStore } from '../store';

export function Lobby() {
  const lobby = useStore((s) => s.lobby);
  const claimSeat = useStore((s) => s.claimSeat);
  const heroDealCount = useStore((s) => s.heroDealCount);
  const setForm = useStore((s) => s.setForm);
  const startGame = useStore((s) => s.startGame);
  const disconnect = useStore((s) => s.disconnect);

  if (!lobby) return null;
  const mySeatId = lobby.mySeatId;
  const mySeat = lobby.seats.find((s) => s.seatId === mySeatId);
  const occupied = lobby.seats.filter((s) => s.name);
  const allReady = occupied.length >= 2;
  const amHost = mySeat?.isHost;

  return (
    <div className="lobby">
      <header>
        <span>房间号：{lobby.roomCode}</span>
        <button className="ghost" onClick={disconnect}>
          退出
        </button>
      </header>

      <section className="seats-grid">
        {lobby.seats.map((s) => {
          const mine = s.seatId === mySeatId;
          const clickable = !mySeatId && s.name === null;
          return (
            <div
              key={s.seatId}
              className={`seat ${mine ? 'mine' : ''} ${clickable ? 'clickable' : ''}`}
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
            <button className="primary big" disabled={!allReady} onClick={startGame}>
              {allReady ? '开始游戏' : `等待玩家入座（${occupied.length} 人）`}
            </button>
          </div>
        ) : (
          <div className="hint">{amHost === undefined ? '请先落座' : '等待房主开始游戏…'}</div>
        )}
      </footer>
    </div>
  );
}
