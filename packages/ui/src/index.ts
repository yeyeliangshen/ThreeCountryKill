// 浏览器端应用的唯一出口。
// 引擎 / 服务端 / 协议层的改动不需要进这个包；只改界面、音乐音效时才看这里。
export { App } from './App';
export { useStore, type Screen, type LobbyState } from './store';
export * from './audio';
