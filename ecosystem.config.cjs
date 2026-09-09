// pm2 进程配置：以 tsx 即时转译运行服务端源码（与 dev 同机制），
// 无需编译 server/engine/protocol，只需构建前端（packages/client/dist）。
const path = require('node:path');

const PORT = Number(process.env.PORT) || 8080;

module.exports = {
  apps: [
    {
      name: 'sgs',
      script: path.join(__dirname, 'packages/server/src/index.ts'),
      interpreter: 'node',
      node_args: '--import tsx/esm',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        PORT: String(PORT),
      },
      autorestart: true,
      max_restarts: 20,
      // 崩溃后 1s 再拉起，避免反复打日志
      restart_delay: 1000,
    },
  ],
};
