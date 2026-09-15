// Vite 构建外壳：只负责把 @sgs/ui 的应用挂到 #root。
// 界面、样式、背景音乐与音效都在 packages/ui 里，改那些不需要动这个包。
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@sgs/ui';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
