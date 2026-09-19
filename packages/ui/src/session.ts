// 本机记住「我是谁、我在哪个房间」——刷新/锁屏回来时自动回到原来的座位。
//
// 为什么需要它：座位是靠 `claimSeat(seatId)` 认回来的（服务端会保留离线座位、恢复原身份），
// 而 seatId 只存在内存里。以前一刷新就没了，自己的座位变成「离线」幽灵：自己回不去、
// 别人也坐不了，那一局只能作废。把 {服务器, 房号, 昵称, 座位} 存到 localStorage 就够了。
//
// 只在「主动点断开」时清掉（见 store.disconnect），换房间时会被覆盖。
// 不再记「服务器地址」：连哪台服务器由**当前页面地址**决定（前端与 ws 同端口），
// 登录页上那个输入框已经去掉——留着旧值反而会把玩家指到别的服务器上。
import type { SavedSession } from './types';

const KEY = 'sgs.session';

/** localStorage 可能在隐私模式/被禁用时抛异常——读写都要兜住，不能让它把游戏搞崩 */
function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadSession(): SavedSession | null {
  const ls = safeStorage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedSession>;
    if (typeof parsed.roomCode !== 'string') return null;
    return {
      roomCode: parsed.roomCode,
      name: typeof parsed.name === 'string' ? parsed.name : '',
      seatId: typeof parsed.seatId === 'string' ? parsed.seatId : null,
    };
  } catch {
    return null;
  }
}

export function saveSession(s: SavedSession): void {
  const ls = safeStorage();
  if (!ls) return;
  try {
    ls.setItem(KEY, JSON.stringify(s));
  } catch {
    // 存不进去就算了：只是下次要手填房号
  }
}

export function clearSession(): void {
  const ls = safeStorage();
  if (!ls) return;
  try {
    ls.removeItem(KEY);
  } catch {
    // 同上
  }
}
