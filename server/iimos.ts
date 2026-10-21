// launcher 的能力入口。形态跑在 launcher 拉起的子进程里,窗口、通知、文件框、浏览器、终端这些系统的事
// 都通过 globalThis.iimos 叫 launcher 做(能力清单见 launcher 契约 CONTRACT.md)。
// 不经 launcher 跑(node main.js、测试)时 globalThis.iimos 不存在:call 直接报错,on 什么也收不到。
type Iimos = {
  call: (name: string, args?: Record<string, unknown>) => Promise<any>;
  on: (name: string, fn: (data: any) => void) => () => void;
  ready: (info: { url: string; window?: Record<string, unknown> }) => void;
  onShutdown: (fn: (info: { restarting: boolean }) => unknown) => void;
  workspace?: string;
  data?: string;
  contract?: string;
};

export const iimos = (globalThis as any).iimos as Iimos | undefined;
export const hasIimos = () => !!iimos;

export const call = (name: string, args: Record<string, unknown> = {}): Promise<any> =>
  iimos ? iimos.call(name, args) : Promise.reject(new Error("这个功能需要在 iimos 里运行(没有 launcher)"));

export const on = (name: string, fn: (data: any) => void): (() => void) =>
  iimos ? iimos.on(name, fn) : () => {};

/** 系统通知。发不出去就算了(不经 launcher、机器不支持),不拦主流程。 */
export const notify = (title: string, body: string) =>
  call("notify", { title: String(title || "worktop").slice(0, 100), body: String(body || "").slice(0, 500) }).catch(() => {});
