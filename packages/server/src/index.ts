// 三国杀联机版服务端入口：Node + ws。
// 同一个 HTTP 端口既托管前端静态页（packages/client/dist），又承载 WebSocket；
// 部署后浏览器访问 http://公网IP:8080 即可拿到游戏页并自动连 ws 开房。
import { WebSocketServer, type WebSocket } from 'ws';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClientMessage, ServerMessage } from '@sgs/protocol';
import { Room } from './room';

const PORT = Number(process.env.PORT ?? 8080);

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

const rooms = new Map<string, Room>();

function getOrCreateRoom(code: string): Room {
  let r = rooms.get(code);
  if (!r) {
    r = new Room(code.trim() || 'default');
    rooms.set(r.roomCode, r);
  }
  return r;
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

const httpServer = http.createServer(serveStatic);
const wss = new WebSocketServer({ server: httpServer });

httpServer.listen(PORT, '0.0.0.0', () => {
  const hasStatic = fs.existsSync(path.join(STATIC_DIR, 'index.html'));
  console.log(`[三国杀] 服务端已启动：http://0.0.0.0:${PORT}`);
  console.log(`[三国杀] 本机访问：http://localhost:${PORT}`);
  console.log(
    hasStatic
      ? `[三国杀] 前端静态托管：${STATIC_DIR}`
      : `[三国杀] 警告：未找到前端构建产物（${STATIC_DIR}），仅提供 WebSocket；请先构建客户端或用 dev 模式。`,
  );
});

wss.on('connection', (ws: WebSocket) => {
  // 每条连接维护：所在房间、所坐座位、昵称
  let room: Room | null = null;
  let seatId: string | null = null;
  let name = '';

  ws.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: 'error', message: '无效的消息格式' });
      return;
    }

    switch (msg.type) {
      case 'join': {
        room = getOrCreateRoom(msg.roomCode);
        name = msg.name?.trim() || '无名';
        // 先给本连接回一个 lobby，再广播给全房
        send(ws, {
          type: 'lobby',
          roomCode: room.roomCode,
          seats: room.seatViews(),
          started: room.started,
          mySeatId: seatId,
        });
        room.broadcastLobby();
        break;
      }

      case 'claimSeat': {
        if (!room) {
          send(ws, { type: 'error', message: '请先发送 join 进房' });
          break;
        }
        const res = room.claimSeat(msg.seatId, ws, name);
        if (!res.ok) {
          send(ws, { type: 'error', message: res.error });
          break;
        }
        seatId = res.seatId;
        if (room.started) room.broadcastSnapshots();
        else room.broadcastLobby();
        break;
      }

      case 'startGame': {
        if (!room || !seatId) {
          send(ws, { type: 'error', message: '请先落座' });
          break;
        }
        const res = room.startGame(seatId, msg.heroDealCount);
        if (!res.ok) {
          send(ws, { type: 'error', message: res.error });
          break;
        }
        room.broadcastSnapshots();
        break;
      }

      case 'intent': {
        if (!room || !seatId) {
          send(ws, { type: 'error', message: '请先落座' });
          break;
        }
        const res = room.handleIntent(seatId, msg.intent);
        if (!res.ok) send(ws, { type: 'error', message: res.error });
        else room.broadcastSnapshots();
        break;
      }

      default: {
        send(ws, { type: 'error', message: '未知消息类型' });
      }
    }
  });

  ws.on('close', () => {
    if (room) room.disconnect(ws);
  });

  ws.on('error', () => {
    // 连接异常：等同断线，标记座位离线
    if (room) room.disconnect(ws);
  });
});
