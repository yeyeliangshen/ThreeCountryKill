import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 客户端开发服务器
// 前端直连房主地址（默认 localhost:8080；局域网/远程填 房主IP:8080）
// 服务端监听 0.0.0.0:8080，浏览器对 ws 无同源限制，故无需代理
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true, // 允许局域网设备访问 5173 调试
  },
});
