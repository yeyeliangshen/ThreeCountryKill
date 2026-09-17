// Room 的生命周期单测（服务端以前一个测试都没有，这套规则就靠它兜底）。
//
// 房间规则只有两条，但很容易写错，尤其是「谁算空」和「房主怎么走」：
// - **座位全空**才算没人（离线还算占着，所以他们能认回来）→ 空房由调用方删掉；
// - **房主离开时把房主移交给房间里另一个人**，没人留下就没有房主了。
import { describe, it, expect } from 'vitest';
import type { WebSocket } from 'ws';
import { Room } from '../src/room';

/** 一个够用的假连接：Room 只用到 readyState / OPEN / send */
function fakeWs(sent: string[] = []): WebSocket {
  return {
    readyState: 1,
    OPEN: 1,
    send: (raw: string) => sent.push(raw),
  } as unknown as WebSocket;
}

function newRoom(): Room {
  return new Room('1234');
}

describe('Room · 落座与房主', () => {
  it('建房后第一个落座的人是房主', () => {
    const room = newRoom();
    const res = room.claimSeat('1', fakeWs(), '甲');
    expect(res).toEqual({ ok: true, seatId: '1' });
    expect(room.hostSeatId).toBe('1');
    expect(room.seats[0]!.isHost).toBe(true);
    expect(room.summary()).toMatchObject({ hostName: '甲', players: 1, started: false });
  });

  it('第二个人落座不会抢走房主，人数跟着涨', () => {
    const room = newRoom();
    room.claimSeat('1', fakeWs(), '甲');
    room.claimSeat('2', fakeWs(), '乙');
    expect(room.hostSeatId).toBe('1');
    expect(room.seats.filter((s) => s.isHost)).toHaveLength(1);
    expect(room.summary().players).toBe(2);
  });

  it('已占用且在线的座位不能抢', () => {
    const room = newRoom();
    room.claimSeat('1', fakeWs(), '甲');
    const res = room.claimSeat('1', fakeWs(), '乙');
    expect(res.ok).toBe(false);
  });

  it('同一连接再认一次自己的座位是允许的', () => {
    const room = newRoom();
    const ws = fakeWs();
    room.claimSeat('1', ws, '甲');
    expect(room.claimSeat('1', ws, '甲').ok).toBe(true);
    expect(room.summary().players).toBe(1);
  });
});

describe('Room · 换座', () => {
  it('换到别的空座位时会释放原座位（不会一人占两位）', () => {
    const room = newRoom();
    const ws = fakeWs();
    room.claimSeat('1', ws, '甲');
    room.claimSeat('3', ws, '甲');
    expect(room.seats[0]!.name).toBeNull();
    expect(room.seats[2]!.name).toBe('甲');
    expect(room.summary().players).toBe(1);
  });

  it('房主换座时房主身份跟着走', () => {
    const room = newRoom();
    const ws = fakeWs();
    room.claimSeat('1', ws, '甲');
    room.claimSeat('4', ws, '甲');
    expect(room.hostSeatId).toBe('4');
    expect(room.seats[3]!.isHost).toBe(true);
    expect(room.seats.filter((s) => s.isHost)).toHaveLength(1);
  });
});

describe('Room · 离线与认回', () => {
  it('断线只标离线、保留名字；别人点这个座位＝接替他（保留原武将身份）', () => {
    const room = newRoom();
    room.claimSeat('1', fakeWs(), '甲');
    room.game = null;
    room.disconnect(room.seats[0]!.ws!);
    expect(room.seats[0]!.connected).toBe(false);
    expect(room.seats[0]!.name).toBe('甲');
    // 离线座位仍算「有人占着」
    expect(room.summary().players).toBe(1);
    expect(room.isEmpty()).toBe(false);

    // 另一个人（或本人换设备）点进来 → 恢复原身份
    const res = room.claimSeat('1', fakeWs(), '随便什么名字');
    expect(res.ok).toBe(true);
    expect(room.seats[0]!.name).toBe('甲');
    expect(room.seats[0]!.connected).toBe(true);
  });
});

describe('Room · 离开与房主移交', () => {
  it('房主离开后房主移交给房间里另一个人', () => {
    const room = newRoom();
    room.claimSeat('1', fakeWs(), '甲');
    room.claimSeat('2', fakeWs(), '乙');
    room.releaseSeat('1');
    expect(room.seats[0]!.name).toBeNull();
    expect(room.hostSeatId).toBe('2');
    expect(room.seats[1]!.isHost).toBe(true);
    expect(room.summary()).toMatchObject({ hostName: '乙', players: 1 });
  });

  it('普通玩家离开不会动房主', () => {
    const room = newRoom();
    room.claimSeat('1', fakeWs(), '甲');
    room.claimSeat('2', fakeWs(), '乙');
    room.releaseSeat('2');
    expect(room.hostSeatId).toBe('1');
    expect(room.summary().players).toBe(1);
  });

  it('最后一个占着座位的人离开 → 座位全空（调用方据此删房）', () => {
    const room = newRoom();
    room.claimSeat('1', fakeWs(), '甲');
    expect(room.isEmpty()).toBe(false);
    room.releaseSeat('1');
    expect(room.isEmpty()).toBe(true);
    expect(room.hostSeatId).toBeNull();
  });

  it('全员离线不算空房——座位还占着，他们能回来', () => {
    const room = newRoom();
    room.claimSeat('1', fakeWs(), '甲');
    room.claimSeat('2', fakeWs(), '乙');
    for (const s of room.seats) if (s.ws) room.disconnect(s.ws);
    expect(room.isEmpty()).toBe(false);
    expect(room.summary().players).toBe(2);
  });
});

describe('Room · 已开局的房间进不去', () => {
  function startedRoom(): Room {
    const room = newRoom();
    room.claimSeat('1', fakeWs(), '甲');
    room.claimSeat('2', fakeWs(), '乙');
    // 直接标成已开局（真的开一局需要 2 人 + 引擎，这里只测门禁规则）
    room.started = true;
    return room;
  }

  it('没带座位号 → 拒绝', () => {
    const room = startedRoom();
    const res = room.canJoin();
    expect(res.ok).toBe(false);
  });

  it('想坐空座位 → 拒绝', () => {
    const room = startedRoom();
    expect(room.canJoin('3').ok).toBe(false);
  });

  it('认回一个已离线且已有名字的座位 → 允许', () => {
    const room = startedRoom();
    room.disconnect(room.seats[1]!.ws!);
    expect(room.canJoin('2').ok).toBe(true);
  });

  it('那个座位还在线 → 仍然拒绝（不能顶人）', () => {
    const room = startedRoom();
    expect(room.canJoin('2').ok).toBe(false);
  });

  it('对局中不允许「离开房间」，打完才允许', () => {
    const room = startedRoom();
    expect(room.canLeave()).toBe(false);
    room.game = { gameOver: true } as never;
    expect(room.canLeave()).toBe(true);
  });
});
