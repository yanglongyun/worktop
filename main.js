// 形态的入口,由 launcher 加载。起本地服务 → 报到 iimos.ready({ url, window })。
//
// 纯 Node,不碰 Electron:launcher 开窗口加载这个地址。窗口、通知、文件框、浏览器、终端这些系统的事
// 通过 globalThis.iimos 叫 launcher 做(server/iimos.ts)。
// 不经 launcher 也能跑(node main.js):没有快照和回滚,数据放 WORKTOP_HOME 或 ~/.worktop,地址打在终端里,终端和浏览器工具不可用。
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildServer, isStale, loadEsbuild, OUTFILE } from "./scripts/build-server.mjs";

const iimos = globalThis.iimos;
const ROOT = import.meta.dirname;

// launcher 的 node / iimos 命令放进 PATH:bash 工具、应用进程、终端都要用
if (process.env.IIMOS_BIN) process.env.PATH = `${process.env.IIMOS_BIN}${path.delimiter}${process.env.PATH || ""}`;

// 服务端是 TypeScript,打成 dist/server.mjs 再加载。源码变了(内容哈希对不上 dist/server.hash)就重打一次(esbuild 由 launcher 提供);
// 没有 esbuild 又没有产物才算起不来。
if (isStale()) {
  const esbuild = loadEsbuild();
  if (esbuild) {
    const { ms } = await buildServer({ esbuild });
    console.log(`[worktop] 服务端已重新编译(${ms}ms)`);
  } else if (!fs.existsSync(OUTFILE)) {
    throw new Error("dist/server.mjs 不存在,也找不到 esbuild 来编译:npm install 后 npm run build:server");
  }
}
const { startServer } = await import(pathToFileURL(OUTFILE).href);

// 端口要跨启动稳定:界面的偏好(主题、侧栏宽度、开着的标签……)存在 localStorage,按 origin 隔离,origin 含端口。
// 首次随机选一个记下来,以后先用它;被占了才另选。
const dataDir = process.env.IIMOS_DATA ? path.join(process.env.IIMOS_DATA, "worktop") : (process.env.WORKTOP_HOME || path.join(process.env.HOME || ROOT, ".worktop"));
const portFile = path.join(dataDir, "port.json");
const portFree = (port) => new Promise((resolve) => {
  const probe = net.createServer();
  probe.once("error", () => resolve(false));
  probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
});
async function pickPort() {
  const fixed = Number(process.env.PORT) || 0;
  if (fixed) return fixed;
  let saved = 0;
  try { saved = Number(JSON.parse(fs.readFileSync(portFile, "utf8")).port) || 0; } catch { /* 第一次 */ }
  if (saved > 1024 && saved < 65536 && await portFree(saved)) return saved;
  return 0;
}

const token = randomBytes(32).toString("hex");
const runtime = await startServer({ port: await pickPort(), token });
try {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(portFile, JSON.stringify({ port: runtime.port }));
} catch (error) {
  console.error("[worktop] 记不住端口,下次启动界面偏好会重置:", error?.message);
}
const url = `${runtime.origin}/?token=${token}`;

if (iimos) {
  iimos.onShutdown(() => runtime.close());
  iimos.ready({
    url,
    window: {
      width: 1440,
      height: 900,
      minWidth: 900,
      minHeight: 600,
      title: "worktop",
      background: "#ffffff",
      // 用系统原生标题栏:红绿灯和窗口钮归系统,界面不用给它们让位
      titleBar: "native",
    },
  });
} else {
  console.log(url);
  const shutdown = () => runtime.close().finally(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
