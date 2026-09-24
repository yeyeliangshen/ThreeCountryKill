// 三国杀联机版服务端入口：Node + ws。
// 同一个 HTTP 端口既托管前端静态页（packages/client/dist），又承载 WebSocket；
// 部署后浏览器访问 http://公网IP:8080 即可拿到游戏页并自动连 ws 开房。
import { WebSocketServer, type WebSocket } from 'ws';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClientMessage, RoomSummary, ServerMessage } from '@sgs/protocol';
import type { ApplyResult } from '@sgs/engine';
import { Room } from './room';

const PORT = Number(process.env.PORT ?? 8080);

/**
 * **开发工具开关**（「测试场景编辑器」/ Test Scenario Setup，见 docs §5.206）。
 *
 * 判定顺序：`SGS_DEV_TOOLS=1/true` 强制开、`=0/false` 强制关；没设就按「非 production 即开」
 * （`pnpm dev` 默认开着，pm2 的 `NODE_ENV=production` 默认关着）。
 * 它只影响房间里能不能布置测试场景，**不进任何规则路径**。
 */
const DEV_TOOLS = ((): boolean => {
  const raw = process.env.SGS_DEV_TOOLS;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return process.env.NODE_ENV !== 'production';
})();

/**
 * 离线座位保留多久（毫秒）。默认 10 分钟，可用 `IDLE_SEAT_MS` 覆盖；
 * 设成 0（或负数/乱填）＝关掉这个回收机制，离线座位一直留着。
 */
function readMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return n;
}
const IDLE_SEAT_MS = readMs('IDLE_SEAT_MS', 10 * 60 * 1000);
/** 多久扫一遍（毫秒），默认 30 秒，可用 `IDLE_SWEEP_MS` 覆盖 */
const IDLE_SWEEP_MS = Math.max(1000, readMs('IDLE_SWEEP_MS', 30_000));

// 前端静态资源目录：相对源文件定位（packages/server/src → ../../client/dist），
// 不依赖运行时 cwd；可用 STATIC_DIR 环境变量覆盖。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = process.env.STATIC_DIR
  ? path.resolve(process.env.STATIC_DIR)
  : path.resolve(__dirname, '../../client/dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
};

// 托管前端构建产物：命中文件直出，未命中回 index.html（SPA 兜底）。
function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }
  let urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(STATIC_DIR, urlPath);
  // 防目录穿越
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      const idx = path.join(STATIC_DIR, 'index.html');
      fs.stat(idx, (e2, s2) => {
        if (e2 || !s2.isFile()) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('前端尚未构建（packages/client/dist 缺失）');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        fs.createReadStream(idx).pipe(res);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}

// —— 房间表与大厅 ——
//
// 房间**只由房主显式创建**（`createRoom`）：没有「谁先填这个房号谁就建出房间」那条路了。
// 房间的存活条件只有一条：**还有没有人占着座位**（离线也算占着，所以他们能认回来）。
// 座位全空 → 删房。删房只走 `destroyRoom` 一个入口。
const rooms = new Map<string, Room>();

/** 目前「在大厅里」的连接：只有这些需要收房间列表 */
const hallClients = new Set<WebSocket>();

/** 分配一个没被占用的 4 位房号 */
function allocateRoomCode(): string {
  for (let i = 0; i < 200; i++) {
    const code = String(1000 + Math.floor(Math.random() * 9000));
    if (!rooms.has(code)) return code;
  }
  // 极端情况：4 位都被占了，用递增兜底（保证一定能建房）
  for (let n = 1000; n <= 9999; n++) {
    const code = String(n);
    if (!rooms.has(code)) return code;
  }
  return String(Date.now() % 10000);
}

/** 大厅列表：等人中的房间排前面，然后按房号 */
function roomSummaries(): RoomSummary[] {
  return [...rooms.values()]
    .map((r) => r.summary())
    .sort((a, b) =>
      a.started === b.started ? a.roomCode.localeCompare(b.roomCode) : a.started ? 1 : -1,
    );
}

function broadcastHall(): void {
  const rooms0 = roomSummaries();
  for (const ws of hallClients) send(ws, { type: 'hall', rooms: rooms0 });
}

/**
 * 删房的**唯一入口**：通知房里的人 → 从表里删掉 → 广播给大厅。
 * 触发点：房主离开且没人留下（座位全空）、以及连接关闭后房间空了。
 */
function destroyRoom(room: Room, reason: string): void {
  if (!rooms.has(room.roomCode)) return;
  room.notifyClosed(reason);
  rooms.delete(room.roomCode);
  broadcastHall();
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

/**
 * 定期回收「离开太久」的座位：离线超过 `IDLE_SEAT_MS` 就等同本人离开——
 * 座位释放（房主照常移交），房间里没人了就删房。本人再回来走的是「新登录」那条路
 * （昵称认不到旧座位 → 坐空位）；对局中被收回的位置变成**可接替的空位**。
 */
function sweepIdleSeats(): void {
  if (!(IDLE_SEAT_MS > 0)) return;
  for (const room of [...rooms.values()]) {
    const { changed, emptied } = room.releaseIdle(IDLE_SEAT_MS);
    if (emptied) {
      destroyRoom(room, '房间里没人了，房间已关闭。');
      continue;
    }
    if (changed) {
      room.broadcastLobby();
      broadcastHall();
    }
  }
}
setInterval(sweepIdleSeats, IDLE_SWEEP_MS).unref();

const httpServer = http.createServer(serveStatic);
const wss = new WebSocketServer({ server: httpServer });

httpServer.listen(PORT, '0.0.0.0', () => {
  const hasStatic = fs.existsSync(path.join(STATIC_DIR, 'index.html'));
  console.log(`[三国杀] 服务端已启动：http://0.0.0.0:${PORT}`);
  console.log(`[三国杀] 本机访问：http://localhost:${PORT}`);
  console.log(
    IDLE_SEAT_MS > 0
      ? `[三国杀] 离线座位保留 ${Math.round(IDLE_SEAT_MS / 1000)} 秒（每 ${Math.round(IDLE_SWEEP_MS / 1000)} 秒扫一次；IDLE_SEAT_MS=0 可关掉）`
      : '[三国杀] 离线座位回收已关闭（IDLE_SEAT_MS=0）',
  );
  console.log(
    hasStatic
      ? `[三国杀] 前端静态托管：${STATIC_DIR}`
      : `[三国杀] 警告：未找到前端构建产物（${STATIC_DIR}），仅提供 WebSocket；请先构建客户端或用 dev 模式。`,
  );
});

wss.on('connection', (ws: WebSocket) => {
  // 每条连接维护：所在房间、所坐座位、昵称
  // （room === null 就是「在大厅里」，这种连接收 `hall` 房间列表）
  let room: Room | null = null;
  let seatId: string | null = null;
  let name = '';

  /** 进大厅：登记昵称、收房间列表、不再算房间成员 */
  const enterHall = (nick: string): void => {
    name = nick.trim() || '无名';
    room = null;
    seatId = null;
    hallClients.add(ws);
    send(ws, { type: 'hall', rooms: roomSummaries() });
  };

  /**
   * 离开当前房间：释放座位（换房/退出前都会先调它）。
   * 座位全空就把房间删掉——**房间的存活条件只有这一条**。
   */
  const leaveCurrentRoom = (): void => {
    const r = room;
    if (!r) return;
    if (seatId) r.releaseSeat(seatId);
    room = null;
    seatId = null;
    if (r.isEmpty()) destroyRoom(r, '房间里没人了，房间已关闭。');
    else {
      r.broadcastLobby();
      broadcastHall();
    }
  };

  ws.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: 'error', message: '无效的消息格式' });
      return;
    }

    switch (msg.type) {
      case 'enterHall': {
        enterHall(msg.name);
        break;
      }

      case 'listRooms': {
        // 界面上的「刷新」：顺手把它登记成大厅连接（断线重连后可能不在集合里）
        hallClients.add(ws);
        send(ws, { type: 'hall', rooms: roomSummaries() });
        break;
      }

      case 'createRoom': {
        if (!name) {
          send(ws, { type: 'error', message: '请先进入大厅' });
          break;
        }
        leaveCurrentRoom();
        const r = new Room(allocateRoomCode(), 8, DEV_TOOLS);
        rooms.set(r.roomCode, r);
        // 创建者自动落座 1 号位，并成为房主（新房还没有房主，claimSeat 会指派）
        const created = r.claimSeat('1', ws, name);
        if (!created.ok) {
          rooms.delete(r.roomCode);
          send(ws, { type: 'error', message: created.error });
          break;
        }
        room = r;
        seatId = created.seatId;
        hallClients.delete(ws);
        r.broadcastLobby();
        broadcastHall();
        break;
      }

      case 'joinRoom': {
        if (!name) {
          send(ws, { type: 'error', message: '请先进入大厅' });
          break;
        }
        const target = rooms.get(msg.roomCode.trim());
        if (!target) {
          send(ws, { type: 'error', message: '房间不存在（可能已经关闭）' });
          break;
        }
        // 认回/接替：那个座位有名字但离线。已开局的房间只允许这一种进入方式
        // （没带座位号时按**昵称**认：同一个昵称＝同一个人，换了设备也能回来）
        const joinable = target.canJoin(msg.seatId, name);
        if (!joinable.ok) {
          send(ws, { type: 'error', message: joinable.error });
          break;
        }
        const seat = msg.seatId ? target.seats.find((x) => x.seatId === msg.seatId) : undefined;
        // 带座位号但那个位子已经空了/不是我的 → 不算「认回」，走下面的按昵称找
        const reclaiming = !!seat && seat.name === name;
        // 没带座位号（换了设备、本地没记住）：先按**昵称**找自己的座位，再退到第一个空位。
        // 不这么找的话，同一个人回来会变成「同名两个人」——旧座位成离线幽灵，新座位又占一位。
        const mine = target.findByName(name);
        leaveCurrentRoom();
        room = target;
        hallClients.delete(ws);
        const wantSeatId = reclaiming
          ? msg.seatId!
          : (mine?.seatId ?? target.findEmpty()?.seatId ?? null);
        if (wantSeatId) {
          const res = target.claimSeat(wantSeatId, ws, name);
          if (!res.ok) send(ws, { type: 'error', message: res.error });
          else seatId = res.seatId;
        } else {
          // 满员：人先进房间待着（界面会提示「请先落座」）
          seatId = null;
        }
        // lobby **一定要发**：客户端靠它知道「我坐在哪个位子」（也是本地记住会话、
        // 之后刷新能认回座位的前提）；已开局的话再补一份快照把对局界面推上去。
        target.broadcastLobby();
        if (target.started) target.broadcastSnapshots();
        broadcastHall();
        break;
      }

      case 'leaveRoom': {
        if (!room) {
          send(ws, { type: 'error', message: '你不在房间里' });
          break;
        }
        // 对局中不放人（座位保留，重连能接着打）；打完了才允许退出去
        if (!room.canLeave()) {
          send(ws, {
            type: 'error',
            message: '对局中不能离开房间——直接关页面就行，座位会给你留着',
          });
          break;
        }
        const leaving = room.roomCode;
        leaveCurrentRoom();
        enterHall(name);
        console.log(`[三国杀] 房间 ${leaving}：一位玩家离开`);
        break;
      }

      case 'claimSeat': {
        if (!room) {
          send(ws, { type: 'error', message: '请先进入房间' });
          break;
        }
        const res = room.claimSeat(msg.seatId, ws, name);
        if (!res.ok) {
          send(ws, { type: 'error', message: res.error });
          break;
        }
        seatId = res.seatId;
        hallClients.delete(ws);
        room.broadcastLobby();
        if (room.started) room.broadcastSnapshots(); // 认回对局中的座位：把界面推到对局
        broadcastHall(); // 人数变了，大厅列表也跟着更新
        break;
      }

      case 'setMode': {
        if (!room || !seatId) {
          send(ws, { type: 'error', message: '请先落座' });
          break;
        }
        const res = room.setMode(seatId, msg.mode);
        if (!res.ok) {
          send(ws, { type: 'error', message: res.error });
          break;
        }
        room.broadcastLobby();
        broadcastHall();
        break;
      }

      case 'setFreePick': {
        if (!room || !seatId) {
          send(ws, { type: 'error', message: '请先落座' });
          break;
        }
        const res = room.setFreePick(seatId, msg.freePick);
        if (!res.ok) {
          send(ws, { type: 'error', message: res.error });
          break;
        }
        room.broadcastLobby();
        break;
      }

      case 'setGuozhanConfig': {
        if (!room || !seatId) {
          send(ws, { type: 'error', message: '请先落座' });
          break;
        }
        const res = room.setGuozhanConfig(seatId, msg.config);
        if (!res.ok) {
          send(ws, { type: 'error', message: res.error });
          break;
        }
        room.broadcastLobby();
        break;
      }

      case 'startGame': {
        if (!room || !seatId) {
          send(ws, { type: 'error', message: '请先落座' });
          break;
        }
        // 扩展开关是**房间状态**（房间里存的那份），不从开局消息里读——避免客户端各传各的
        const res = room.startGame(seatId, msg.mode, msg.heroDealCount, msg.freePick);
        if (!res.ok) {
          send(ws, { type: 'error', message: res.error });
          break;
        }
        room.broadcastSnapshots();
        broadcastHall();
        break;
      }

      case 'intent': {
        if (!room || !seatId) {
          send(ws, { type: 'error', message: '请先落座' });
          break;
        }
        // ⚠️ 兜底：意图是**外部输入**。引擎里已经把缺字段补齐了（applyIntent 的边界），
        //    但任何一处没料到的异常/断言都不该把整个服务端进程带走——那会同时干掉所有房间。
        //    这里只对这一条消息负责：报错给这个客户端，游戏继续。
        let res: ApplyResult;
        try {
          res = room.handleIntent(seatId, msg.intent);
        } catch (e) {
          console.error('[三国杀] 处理意图时抛异常（已吞掉，房间继续）:', msg.intent, e);
          send(ws, { type: 'error', message: '这条操作无法处理（内部错误）' });
          break;
        }
        if (!res.ok) send(ws, { type: 'error', message: res.error });
        else room.broadcastSnapshots();
        break;
      }

      default: {
        send(ws, { type: 'error', message: '未知消息类型' });
      }
    }
  });

  const onDisconnect = (): void => {
    hallClients.delete(ws);
    if (!room) return;
    room.disconnect(ws);
    // 正常情况下座位还占着（离线可重连），所以不会删；这行是兜底
    if (room.isEmpty()) destroyRoom(room, '房间里没人了，房间已关闭。');
  };

  ws.on('close', onDisconnect);
  // 连接异常：等同断线，标记座位离线
  ws.on('error', onDisconnect);
});
