// Room 的生命周期单测（服务端以前一个测试都没有，这套规则就靠它兜底）。
//
// 房间规则只有两条，但很容易写错，尤其是「谁算空」和「房主怎么走」：
// - **座位全空**才算没人（离线还算占着，所以他们能认回来）→ 空房由调用方删掉；
// - **房主离开时把房主移交给房间里另一个人**，没人留下就没有房主了。
import { describe, it, expect } from 'vitest';
import type { WebSocket } from 'ws';
import { Room } from '../src/room';
import { GUOZHAN_CONFIG_SCHEMA_VERSION } from '@sgs/engine';


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

describe('Room · 一个昵称＝一个用户', () => {
  it('同一个昵称用新连接回来：并成一个座位，旧座位不再占着', () => {
    const room = newRoom();
    room.claimSeat('1', fakeWs(), '甲');
    room.claimSeat('2', fakeWs(), '乙');
    // 甲换了设备（新连接、本地没记住座位号）→ 服务端按昵称认出他
    const seats = room.seatViews();
    const mine = seats.find((s) => s.name === '甲')!;
    const res = room.claimSeat('3', fakeWs(), '甲');
    expect(res.ok).toBe(true);
    // 仍然只有一个人叫「甲」：新座位坐上了，旧座位被让出来
    expect(room.seatViews().filter((s) => s.name === '甲')).toHaveLength(1);
    expect(room.seatViews().find((s) => s.name === '甲')!.seatId).toBe('3');
    expect(room.seats.find((s) => s.seatId === mine.seatId)!.name).toBeNull();
    expect(room.summary().players).toBe(2); // 甲 + 乙
  });

  it('被并掉的那条连接会收到 roomClosed（否则它那边界面静默卡住）', () => {
    const room = newRoom();
    const oldSent: string[] = [];
    room.claimSeat('1', fakeWs(oldSent), '甲');
    room.claimSeat('2', fakeWs(), '甲');
    expect(oldSent.some((m) => m.includes('roomClosed'))).toBe(true);
  });

  it('同一个昵称点自己那个**在线**的座位：接管，而不是「已被占用」', () => {
    const room = newRoom();
    const oldSent: string[] = [];
    room.claimSeat('1', fakeWs(oldSent), '甲');
    const res = room.claimSeat('1', fakeWs(), '甲'); // 另一个标签页
    expect(res.ok).toBe(true);
    expect(room.seats[0]!.connected).toBe(true);
    expect(oldSent.some((m) => m.includes('roomClosed'))).toBe(true);
    expect(room.summary().players).toBe(1);
  });

  it('同一条连接换座（同名）不会把自己顶回大厅', () => {
    const room = newRoom();
    const sent: string[] = [];
    const ws = fakeWs(sent); // 同一条连接：先坐 1 号位，再换到 3 号位
    room.claimSeat('1', ws, '甲');
    room.claimSeat('3', ws, '甲');
    expect(sent.some((m) => m.includes('roomClosed'))).toBe(false);
    expect(room.seatViews().filter((s) => s.name === '甲')).toHaveLength(1);
  });

  it('同名的是房主时，房主身份跟着人走', () => {
    const room = newRoom();
    room.claimSeat('1', fakeWs(), '甲');
    room.claimSeat('3', fakeWs(), '甲'); // 换到 3 号位
    expect(room.hostSeatId).toBe('3');
    expect(room.seats.find((s) => s.seatId === '3')!.isHost).toBe(true);
    expect(room.seats.filter((s) => s.isHost)).toHaveLength(1);
  });

  it('开局后不按昵称并座位（局中座位是游戏状态，不能因为同名就动）', () => {
    const room = newRoom();
    room.claimSeat('1', fakeWs(), '甲');
    room.claimSeat('2', fakeWs(), '乙');
    room.started = true;
    // 局中「甲」的旧座位离线，另一个连接用同名坐 3 号位 → 旧座位保留（认回得走座位号）
    room.seats[0]!.connected = false;
    room.seats[0]!.ws = null;
    const res = room.claimSeat('3', fakeWs(), '甲');
    expect(res.ok).toBe(true);
    expect(room.seatViews().filter((s) => s.name === '甲')).toHaveLength(2);
  });

  it('不同昵称互不影响：乙坐别的位子不会动甲', () => {
    const room = newRoom();
    room.claimSeat('1', fakeWs(), '甲');
    room.claimSeat('2', fakeWs(), '乙');
    expect(room.seatViews().filter((s) => s.name !== null)).toHaveLength(2);
    expect(room.hostSeatId).toBe('1');
  });

  it('已开局的房间：同昵称的离线座位不带座位号也能认出（换了设备也能回）', () => {
    const room = newRoom();
    room.claimSeat('1', fakeWs(), '甲');
    room.claimSeat('2', fakeWs(), '乙');
    room.started = true;
    room.seats[0]!.connected = false;
    room.seats[0]!.ws = null;
    expect(room.canJoin(undefined, '甲')).toEqual({ ok: true });
    expect(room.canJoin(undefined, '乙')).toEqual({ ok: false, error: '该房间已开局，无法加入' });
    expect(room.canJoin(undefined, '丙')).toEqual({ ok: false, error: '该房间已开局，无法加入' });
    // 甲自己还在线时也不能被顶（局中不该换手）
    room.seats[1]!.connected = true;
    expect(room.canJoin(undefined, '乙')).toEqual({ ok: false, error: '该房间已开局，无法加入' });
  });
});

describe('Room · 离开太久回收座位', () => {
  it('离线超过时限 → 座位收回，房间人少了', () => {
    const room = newRoom();
    const wsB = fakeWs();
    room.claimSeat('1', fakeWs(), '甲');
    room.claimSeat('2', wsB, '乙');
    room.disconnect(wsB);
    // 把断开时刻往回拨 6 分钟
    room.seats[1]!.disconnectedAt = Date.now() - 6 * 60 * 1000;
    const res = room.releaseIdle(5 * 60 * 1000);
    expect(res).toEqual({ changed: true, emptied: false });
    expect(room.seatViews().find((s) => s.seatId === '2')!.name).toBeNull();
    expect(room.summary().players).toBe(1);
  });

  it('没超过时限的不动它；在线的不动它', () => {
    const room = newRoom();
    const wsB = fakeWs(), wsC = fakeWs();
    room.claimSeat('1', fakeWs(), '甲');
    room.claimSeat('2', wsB, '乙');
    room.claimSeat('3', wsC, '丙');
    room.disconnect(wsB);
    room.seats[1]!.disconnectedAt = Date.now() - 60 * 1000; // 才 1 分钟
    const res = room.releaseIdle(5 * 60 * 1000);
    expect(res.changed).toBe(false);
    expect(room.summary().players).toBe(3);
  });

  it('所有人都被收回 → emptied（调用方据此删房）', () => {
    const room = newRoom();
    const ws = fakeWs();
    room.claimSeat('1', ws, '甲');
    room.disconnect(ws);
    room.seats[0]!.disconnectedAt = Date.now() - 60 * 60 * 1000;
    expect(room.releaseIdle(60 * 1000)).toEqual({ changed: true, emptied: true });
  });

  it('被收回的是房主 → 房主移交给还占着座位的人', () => {
    const room = newRoom();
    const wsA = fakeWs();
    room.claimSeat('1', wsA, '甲');
    room.claimSeat('2', fakeWs(), '乙');
    room.disconnect(wsA);
    room.seats[0]!.disconnectedAt = Date.now() - 60 * 60 * 1000;
    room.releaseIdle(60 * 1000);
    expect(room.hostSeatId).toBe('2');
  });

  it('对局中被收回的位子变成「可接替的空位」，别人能进', () => {
    const room = newRoom();
    const wsA = fakeWs();
    room.claimSeat('1', wsA, '甲');
    room.claimSeat('2', fakeWs(), '乙');
    room.started = true;
    // 只关心「谁在游戏里」这件事，给个最小的假 state；不调 disconnect（那会去序列化快照）
    room.game = { players: [{ seatId: '1' }, { seatId: '2' }] } as never;
    room.seats[0]!.connected = false;
    room.seats[0]!.ws = null;
    room.seats[0]!.disconnectedAt = Date.now() - 60 * 60 * 1000;
    room.releaseIdle(60 * 1000);
    expect(room.abandonedSeats().map((s) => s.seatId)).toEqual(['1']);
    expect(room.canJoin(undefined, '丙')).toEqual({ ok: true }); // 丙可以进来接替那一位
    expect(room.canJoin(undefined, '乙')).toEqual({ ok: false, error: '该房间已开局，无法加入' });
  });

  it('未开局的房间里，收回后回来就是「新登录」：坐空位', () => {
    const room = newRoom();
    const wsA = fakeWs();
    room.claimSeat('1', wsA, '甲');
    room.disconnect(wsA);
    room.seats[0]!.disconnectedAt = Date.now() - 60 * 60 * 1000;
    room.releaseIdle(60 * 1000);
    expect(room.findByName('甲')).toBeNull(); // 认不到旧座位了
    expect(room.findEmpty()!.seatId).toBe('1'); // 空位就是刚才那个
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

  describe('房间 · 国战扩展开关（第③步）', () => {
    const cfg = (ext: Partial<Record<'shibei' | 'buchen' | 'junlintianxia', string>>) => ({
      schemaVersion: GUOZHAN_CONFIG_SCHEMA_VERSION,
      extensions: {
        shibei: (ext.shibei ?? 'off') as 'off' | 'current',
        buchen: (ext.buchen ?? 'off') as 'off' | 'current',
        junlintianxia: (ext.junlintianxia ?? 'off') as 'off' | '2026',
        zhen: 'off' as const,
        shi: 'off' as const,
        bian: 'off' as const,
        quan: 'off' as const,
      },
    });

    it('新房间默认是「标准国战」（三个扩展全关）', () => {
      const room = new Room('8888');
      expect(room.currentConfig().extensions).toEqual({
        shibei: 'off',
        buchen: 'off',
        junlintianxia: 'off',
        zhen: 'off',
        shi: 'off',
        bian: 'off',
        quan: 'off',
      });
    });

    it('只有房主能改；非房主被拒', () => {
      const room = new Room('8888');
      room.claimSeat('1', fakeWs(), '甲');
      room.claimSeat('2', fakeWs(), '乙');
      expect(room.setGuozhanConfig('2', cfg({ shibei: 'current' })).ok).toBe(false);
      expect(room.setGuozhanConfig('1', cfg({ shibei: 'current' })).ok).toBe(true);
      expect(room.currentConfig().extensions.shibei).toBe('current');
    });

    it('配置不合法时被拒（联机时它是网络数据）', () => {
      const room = new Room('8888');
      room.claimSeat('1', fakeWs(), '甲');
      const bad = room.setGuozhanConfig('1', {
        schemaVersion: GUOZHAN_CONFIG_SCHEMA_VERSION,
        extensions: { shibei: 'legacy', buchen: 'off', junlintianxia: 'off' },
      });
      expect(bad.ok).toBe(false);
      expect(room.currentConfig().extensions.shibei).toBe('off'); // 没被改脏
    });

    it('开局后冻结：再改一律拒绝，且开局用的是冻结的那份', () => {
      const room = new Room('8888');
      room.claimSeat('1', fakeWs(), '甲');
      room.claimSeat('2', fakeWs(), '乙');
      expect(room.setGuozhanConfig('1', cfg({ junlintianxia: '2026' })).ok).toBe(true);
      expect(room.startGame('1', 'guozhan', 7, true).ok).toBe(true);
      const after = room.setGuozhanConfig('1', cfg({ junlintianxia: 'off' }));
      expect(after.ok).toBe(false);
      expect(room.currentConfig().extensions.junlintianxia).toBe('2026'); // 冻结生效
    });
  });
});
