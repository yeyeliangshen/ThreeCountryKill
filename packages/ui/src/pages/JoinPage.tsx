import { useStore } from '../store';

export function JoinPage() {
  const serverAddr = useStore((s) => s.serverAddr);
  const name = useStore((s) => s.name);
  const setForm = useStore((s) => s.setForm);
  const connect = useStore((s) => s.connect);
  const reconnecting = useStore((s) => s.reconnecting);

  // 服务器地址可留空：留空时用当前页 host（部署后与 ws 同端口，自动同源）
  const canJoin = !!name.trim();

  return (
    <div className="join-page">
      <div className="join-card">
        <h1>三国杀 · 联机版</h1>
        <p className="sub">填昵称进入大厅，在大厅里创建房间或加入别人的房间</p>

        <label>
          服务器地址<span className="hint">（留空=当前服务器）</span>
          <input
            value={serverAddr}
            onChange={(e) => setForm({ serverAddr: e.target.value })}
            placeholder="留空用当前服务器，或填 localhost:8080 / 192.168.1.5:8080"
          />
        </label>

        <label>
          昵称
          <input
            value={name}
            onChange={(e) => setForm({ name: e.target.value })}
            placeholder="你的名字"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canJoin) connect();
            }}
          />
        </label>

        <button className="primary" disabled={!canJoin} onClick={connect}>
          进入大厅
        </button>
        {reconnecting && <p className="hint">正在回到上次的房间…</p>}
      </div>
    </div>
  );
}
