// 大厅：连上服务器后先看到这里——列出所有**房主创建的房间**，
// 可以自己创建一个，也可以点别人的房间进去。
//
// 房间的存活条件只有一条：还有没有人占着座位（离线也算占着）。
// 所以列表里不会出现「没有房主的房间」——房主离开时会把身份移交给房间里另一个人，
// 没人留下时房间直接被删掉（房间删掉后客户端会收到 roomClosed）。
import { useState } from 'react';
import { MODE_NAME, type RoomSummary } from '@sgs/protocol';
import { useStore } from '../store';

/** 房间卡片上的状态文案 */
function statusOf(room: RoomSummary): { text: string; cls: string } {
  if (room.started) return { text: '游戏中', cls: 'playing' };
  if (room.players >= room.maxSeats) return { text: '已满员', cls: 'full' };
  return { text: '等待中', cls: 'waiting' };
}

export function Hall() {
  const rooms = useStore((s) => s.rooms);
  const name = useStore((s) => s.name);
  const createRoom = useStore((s) => s.createRoom);
  const joinRoom = useStore((s) => s.joinRoom);
  const refreshRooms = useStore((s) => s.refreshRooms);
  const disconnect = useStore((s) => s.disconnect);
  const [code, setCode] = useState('');

  const canCreate = !!name.trim();

  return (
    <div className="hall">
      <header>
        <span className="hall-title">大厅</span>
        <span className="hall-me">我是 {name || '无名'}</span>
        <button className="ghost" onClick={refreshRooms}>
          刷新
        </button>
        <button className="ghost" onClick={disconnect}>
          断开
        </button>
      </header>

      <div className="hall-actions">
        <button className="primary" disabled={!canCreate} onClick={createRoom}>
          创建房间
        </button>
        <span className="hall-or">或</span>
        <input
          className="hall-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="输入房号直接加入"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && code.trim()) {
              joinRoom(code);
              setCode('');
            }
          }}
        />
        <button
          className="ghost"
          disabled={!code.trim()}
          onClick={() => {
            joinRoom(code);
            setCode('');
          }}
        >
          加入
        </button>
      </div>

      {rooms.length === 0 ? (
        <p className="hall-empty">
          还没有房间。点「创建房间」当房主，朋友在大厅里就能看到你的房间。
        </p>
      ) : (
        <div className="hall-rooms">
          {rooms.map((room) => {
            const status = statusOf(room);
            const joinable = !room.started && room.players < room.maxSeats;
            return (
              <div
                key={room.roomCode}
                className={`room-card ${joinable ? 'clickable' : ''}`}
                title={room.started ? '这一局已经开始了，进不去' : '点一下加入这个房间'}
                onClick={joinable ? () => joinRoom(room.roomCode) : undefined}
              >
                <div className="room-code">房间 {room.roomCode}</div>
                <div className="room-host">
                  房主 {room.hostName}
                  <span className="host-tag">房主</span>
                </div>
                <div className="room-meta">
                  <span className={`room-status ${status.cls}`}>{status.text}</span>
                  <span>{MODE_NAME[room.mode]}</span>
                  <span>
                    {room.players}/{room.maxSeats} 人
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
