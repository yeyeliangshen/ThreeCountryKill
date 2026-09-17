import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';

/**
 * 构建版本戳：短 commit + 构建时间。
 *
 * 为什么要有：前后端协议会变（比如「填房号」改成「进大厅」），
 * 而**浏览器可能还开着旧的一份构建产物**，表现就是「界面还是旧的、还连不上」。
 * 页面上直接显示版本号，一眼就能判断看到的是不是最新那份。
 */
function buildStamp(): string {
  let hash = 'nogit';
  try {
    hash = execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim();
  } catch {
    // 没有 git（从压缩包解出来构建）就只报时间
  }
  const t = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${hash} · ${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(
    t.getHours(),
  )}:${pad(t.getMinutes())}`;
}

// 客户端开发服务器
// 前端直连房主地址（默认 localhost:8080；局域网/远程填 房主IP:8080）
// 服务端监听 0.0.0.0:8080，浏览器对 ws 无同源限制，故无需代理
export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_STAMP__: JSON.stringify(buildStamp()),
  },
  server: {
    port: 5173,
    host: true, // 允许局域网设备访问 5173 调试
  },
});
