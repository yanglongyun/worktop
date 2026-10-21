// 界面的静态文件:ui/index.html 只引用 dist/main.js 和 dist/main.css(iimos build 编出来的),加一个 icon.svg。
import { REPO_ROOT } from "../system/paths.js";
import fs from "fs";
import path from "path";

const UI = path.join(REPO_ROOT, "ui");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const isFile = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

const serve = (res: import("http").ServerResponse, pathname: string) => {
  const index = path.join(UI, "index.html");
  if (!isFile(path.join(UI, "dist", "main.js"))) {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("界面还没编译:iimos build(或 npm run build)\n");
    return;
  }
  // 只放 dist/ 和根上的几个文件;src/ vendor/ 不对外
  const allowed = pathname === "/" || pathname === "/index.html" || pathname === "/icon.svg" || pathname.startsWith("/dist/");
  const target = path.normalize(path.join(UI, pathname === "/" ? "/index.html" : pathname));
  if (!target.startsWith(UI) || !allowed) {
    // SPA fallback:页面路由都回 index.html
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(index));
    return;
  }
  if (isFile(target)) {
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(fs.readFileSync(target));
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found\n");
};

export { serve };
