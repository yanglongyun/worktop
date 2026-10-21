// 交互式终端会话,按 ws 连接分组:连接断了,它开的终端全部收尾。
//
// 伪终端由 launcher 提供(契约 terminal.*):形态进程里装不了 node-pty 这类原生模块,
// launcher 借系统自带的 expect 开 pty,输出走 terminal.data 事件推回来,这里按终端 id 分发给对应的 ws 客户端。
// 不经 launcher 跑时没有终端,给界面一条明确的错误。
import path from "node:path";
import { terminalDirectory } from "../agent/paths.js";
import { call, hasIimos, on } from "../iimos.js";

type Session = { id: string; launcherId: string; cwd: string; send: SendJson; client: Client };
/** ws 连接:终端会话挂在连接对象上,连接消失即随之回收。 */
type Client = { terminals?: Map<string, Session> };
type SendJson = (message: Record<string, unknown>) => void;

/** launcher 那边的终端 id → 会话。launcher 的事件只带它自己的 id。 */
const byLauncherId = new Map<string, Session>();
let subscribed = false;

const subscribe = () => {
  if (subscribed) return;
  subscribed = true;
  on("terminal.data", ({ id, data }: { id: string; data: string }) => {
    const session = byLauncherId.get(String(id));
    if (session && data) session.send({ type: "terminal_output", terminalId: session.id, data: String(data) });
  });
  on("terminal.exit", ({ id, code, signal, error }: { id: string; code: number | null; signal: string | null; error?: string }) => {
    const session = byLauncherId.get(String(id));
    if (!session) return;
    byLauncherId.delete(String(id));
    session.client.terminals?.delete(session.id);
    if (error) session.send({ type: "terminal_error", terminalId: session.id, error });
    session.send({ type: "terminal_exit", terminalId: session.id, code, signal });
  });
};

const publicCwd = (cwd: string) => String(cwd || "").replace(process.env.HOME || "", "~");

const ensureTerminalMap = (client: Client) => {
  if (!client.terminals) client.terminals = new Map<string, Session>();
  return client.terminals;
};

const stopTerminal = (client: Client, terminalId: string, sendJson?: SendJson) => {
  const sessions = ensureTerminalMap(client);
  const id = String(terminalId || "");
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  byLauncherId.delete(session.launcherId);
  void call("terminal.kill", { id: session.launcherId }).catch(() => { /* 已经没了 */ });
  sendJson?.({ type: "terminal_exit", terminalId: id, code: null, signal: "stopped" });
};

const stopAllTerminals = (client: Client, sendJson?: SendJson) => {
  const sessions = ensureTerminalMap(client);
  for (const id of Array.from(sessions.keys())) stopTerminal(client, id, sendJson);
};

const startTerminal = async (client: Client, payload: any, sendJson: SendJson) => {
  const sessions = ensureTerminalMap(client);
  const terminalId = String(payload.terminalId || "").trim();
  if (!terminalId) {
    sendJson({ type: "terminal_error", error: "missing terminalId" });
    return;
  }
  if (sessions.has(terminalId)) stopTerminal(client, terminalId, sendJson);
  if (!hasIimos()) {
    sendJson({ type: "terminal_error", terminalId, error: "终端需要在 iimos 里运行(当前没有 launcher,拿不到伪终端)" });
    return;
  }

  let cwd: string;
  try {
    cwd = terminalDirectory(payload.cwd || "");
  } catch (error) {
    sendJson({ type: "terminal_error", terminalId, error: (error as Error).message });
    return;
  }

  subscribe();
  // 占个位:spawn 期间界面可能又发了 stop,占位让 stop 能找到它
  const placeholder: Session = { id: terminalId, launcherId: "", cwd, send: sendJson, client };
  sessions.set(terminalId, placeholder);
  let term: { id: string; pty: boolean; resizable: boolean; cwd: string };
  try {
    term = await call("terminal.spawn", {
      cwd,
      cols: Math.max(20, Number(payload.cols) || 100),
      rows: Math.max(5, Number(payload.rows) || 30),
      args: process.platform === "win32" ? [] : ["-i"],
      env: {
        // launcher 的 node / iimos 命令在 IIMOS_BIN,放进 PATH 让终端里直接能用
        PATH: process.env.IIMOS_BIN ? `${process.env.IIMOS_BIN}${path.delimiter}${process.env.PATH || ""}` : (process.env.PATH || ""),
        CLICOLOR: "1",
        FORCE_COLOR: "1",
      },
    });
  } catch (error) {
    if (sessions.get(terminalId) === placeholder) sessions.delete(terminalId);
    sendJson({ type: "terminal_error", terminalId, error: (error as Error).message || String(error) });
    return;
  }
  if (sessions.get(terminalId) !== placeholder) {
    // 等 spawn 的这一会儿被 stop 了,或者又 start 了一次:把刚开的这个收掉
    void call("terminal.kill", { id: term.id }).catch(() => {});
    return;
  }
  const session: Session = { ...placeholder, launcherId: term.id, cwd: term.cwd || cwd };
  sessions.set(terminalId, session);
  byLauncherId.set(term.id, session);
  sendJson({ type: "terminal_started", terminalId, cwd: session.cwd, title: payload.title || publicCwd(session.cwd), pty: term.pty, resizable: term.resizable });
  if (!term.pty) sendJson({ type: "terminal_output", terminalId, data: "\r\n[这台机器上拿不到伪终端,命令照常能跑,但交互式程序(vim / top)不可用]\r\n" });
};

const writeTerminal = (client: Client, payload: any) => {
  const session = ensureTerminalMap(client).get(String(payload.terminalId || ""));
  if (!session?.launcherId) return;
  void call("terminal.write", { id: session.launcherId, data: String(payload.data || "") }).catch(() => {});
};

const resizeTerminal = (client: Client, payload: any) => {
  const session = ensureTerminalMap(client).get(String(payload.terminalId || ""));
  if (!session?.launcherId) return;
  const cols = Math.max(20, Number(payload.cols) || 0);
  const rows = Math.max(5, Number(payload.rows) || 0);
  if (!cols || !rows) return;
  void call("terminal.resize", { id: session.launcherId, cols, rows }).catch(() => { /* 尺寸非法或已退出 */ });
};

export { startTerminal, stopTerminal, stopAllTerminals, writeTerminal, resizeTerminal };
