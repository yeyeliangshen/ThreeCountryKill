import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * 渲染错误的兜底。
 *
 * 为什么需要它（2026-09-21 实测）：`Game` 里曾经有一个 hook 排在提前 return 之后
 * （「加载中…」那一帧少调一个 hook），快照到达后 React 抛
 * "Rendered more hooks than during the previous render" ——**没有 error boundary 时
 * React 会把整棵树卸载**，而 `body` 是深色底（#070a0d），于是界面上什么都看不到＝
 * 用户报的「黑屏」。这类崩溃本身要修（已修），但**兜底不能少**：任何一次渲染异常
 * 都不该变成一块看不见任何信息的黑屏，至少要让玩家看到「出错了 + 一键重载」。
 *
 * 重载按钮走 `location.reload()`：服务端保留座位（可重连），刷新是安全的恢复手段。
 */
interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 控制台留一份完整堆栈——黑屏时用户能截图，开发时能直接看到组件栈
    console.error('[三国杀] 界面崩溃：', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash-screen">
        <div className="crash-title">界面出错了</div>
        <div className="crash-msg">{error.message || String(error)}</div>
        <div className="crash-hint">
          座位会给你留着，点下面的按钮重载即可接着打（也可以直接刷新页面）。
        </div>
        <button className="primary" onClick={() => location.reload()}>
          重新加载
        </button>
      </div>
    );
  }
}
