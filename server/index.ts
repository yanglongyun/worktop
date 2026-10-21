import http from "http";
import { handleApi } from "./http/api/index.js";
import { attachWs } from "./http/ws.js";
import { serve } from "./http/static.js";
import { startWatcher } from "./files/watcher.js";
import { isTrustedHost, isTrustedOrigin } from "./http/origin.js";
import { seedPresetWidgets, sweepTrash } from "./widgets/registry.js";
import { seedPresetSkills } from "./skills/registry.js";
import { startWidgetSiteSweeper, closeAllWidgetSites } from "./widgets/site.js";
import { seedPresetApps, watchApps } from "./apps/registry.js";
import { startAlwaysApps, stopAllApps } from "./apps/supervisor.js";

export const COOKIE = "worktop_token";

/** 请求带的令牌 Cookie。 */
const cookieToken = (header: string | undefined) => {
  for (const part of String(header || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === COOKIE) return rest.join("=");
  }
  return "";
};

/**
 * 起本地服务。token 是本次启动的令牌:窗口第一次带着 ?token= 打开,服务端换成 HttpOnly Cookie,
 * 之后的页面、接口、WebSocket 都认这个 Cookie —— 本机别的进程、别的网页拿不到它。
 * 应用进程调的 /apps/* 走自己的 Bearer 令牌(apps/bridge.ts),不认 Cookie。
 */
const startServer = async ({ port = 0, token = "" }: { port?: number; token?: string } = {}) =>
  new Promise<{ server: http.Server; port: number; origin: string; close: () => Promise<void> }>((resolve, reject) => {
    const authorized = (req: http.IncomingMessage) => !token || cookieToken(req.headers.cookie) === token;
    const server = http.createServer(async (req, res) => {
      // 第一道闸:Host 必须是回环。防 DNS rebinding —— 挡住把域名重绑到 127.0.0.1 后
      // 用 GET 读走对话/文件的恶意网页(对所有方法生效,含 GET)。
      if (!isTrustedHost(req.headers.host)) {
        res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "forbidden host" }));
        return;
      }
      // 第二道闸:带副作用的方法(非 GET/HEAD)必须来自应用自身,挡住恶意网页的跨源写。
      const method = String(req.method || "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD" && !isTrustedOrigin(req.headers.origin, port)) {
        res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "forbidden origin" }));
        return;
      }
      const url = new URL(req.url || "/", "http://127.0.0.1");
      // 第三道闸:令牌。地址里带对了令牌就换成 Cookie 再跳回去;/health 和应用桥(/apps/*,自带 Bearer)不认 Cookie。
      if (token && method === "GET" && url.searchParams.get("token") === token) {
        url.searchParams.delete("token");
        res.writeHead(302, {
          "Set-Cookie": `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`,
          Location: `${url.pathname}${url.search}`,
        });
        res.end();
        return;
      }
      const open = url.pathname === "/health" || url.pathname === "/apps" || url.pathname.startsWith("/apps/");
      if (!open && !authorized(req)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("需要令牌:请从 iimos 窗口打开这个页面\n");
        return;
      }
      const result = await handleApi(req, res);
      if (result === null) serve(res, url.pathname);
    });
    attachWs(server, port, authorized);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address() as import("net").AddressInfo;
      const actual = address.port;
      process.env.WORKTOP_PORT = String(actual); // 提示词里应用取址、应用进程的 HOST_URL 都用它
      startWatcher(); // 常用目录文件监听:磁盘上的任何变化 → 树自动刷新
      seedPresetApps();  // 出厂应用落地到应用的家 —— 之后就是用户自己的 app
      seedPresetWidgets(); // 预装组件落地到组件的家 —— 之后就是用户自己的组件(可改可删)
      seedPresetSkills();   // 出厂技能落地到技能的家 —— 之后就是用户自己的文件
      sweepTrash();        // 回收站里躺满 30 天的真删
      startWidgetSiteSweeper(); // 组件站点闲置回收
      watchApps();              // 应用目录监听:AI 刚写完一个 app,刷新就出现在列表里
      void startAlwaysApps();   // run.mode: "always" 的应用随宿主拉起(其余按需)
      console.log(`worktop running on http://127.0.0.1:${actual}`);
      resolve({
        server,
        port: actual,
        origin: `http://127.0.0.1:${actual}`,
        // 收尾:app 子进程是我们 spawn 的,得由我们收尾,不然会在系统里留下一地孤儿进程还占着端口
        close: async () => {
          await stopAllApps().catch(() => {});
          closeAllWidgetSites();
          server.closeAllConnections?.();
          await new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
    server.on("error", reject);
  });

export { startServer };
