import { useStore } from '../store';

export function JoinPage() {
  const name = useStore((s) => s.name);
  const setForm = useStore((s) => s.setForm);
  const connect = useStore((s) => s.connect);
  const reconnecting = useStore((s) => s.reconnecting);

  // 连哪台服务器不用填：就用**当前页面的地址**（前端与 ws 同端口，部署后自动同源；
  // 开发模式下 store 里默认指到 localhost:8080）。
  const canJoin = !!name.trim();

  return (
    <div className="join-page">
      <div className="join-card">
        <h1>三国杀 · 联机版</h1>
        <p className="sub">填昵称进入大厅，在大厅里创建房间或加入别人的房间</p>

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
