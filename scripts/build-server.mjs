// 把 server/(TypeScript)打成一个纯 Node 文件 dist/server.mjs,main.js 加载它。
//
// 为什么要打包:形态跑在 launcher 用 Electron 自带的 Node 拉起的子进程里,没有 tsx,也没有 npm;
// esbuild 由 launcher 带着(IIMOS_TOOLCHAIN),开发时用仓库自己的 node_modules。
// main.js 启动时发现 server/ 的内容哈希和 dist/server.hash 不一致就自动重打一次,所以改了 server/ 直接 iimos restart 就行;
// 也可以手动跑:node scripts/build-server.mjs。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OUTFILE = path.join(ROOT, "dist", "server.mjs");

const toolchain = () => process.env.IIMOS_TOOLCHAIN || path.join(ROOT, "node_modules");

/** launcher 带的 esbuild;没有(不经 launcher、也没装依赖)就返回 null。 */
export function loadEsbuild() {
  try { return createRequire(path.join(toolchain(), "noop.js"))("esbuild"); } catch { return null; }
}

export const HASHFILE = path.join(ROOT, "dist", "server.hash");

/** server/ 全部源码的内容哈希。不用 mtime:播种 / 回滚 / 换形态都会把文件时间刷新,内容没变就不该重打。 */
export function sourceDigest(dir = path.join(ROOT, "server")) {
  const hash = createHash("sha256");
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(ts|js|mjs|cjs|json)$/.test(entry.name)) {
        hash.update(path.relative(ROOT, file)).update("\0").update(fs.readFileSync(file)).update("\0");
      }
    }
  };
  walk(dir);
  return hash.digest("hex");
}

export function isStale() {
  try { return fs.readFileSync(HASHFILE, "utf8").trim() !== sourceDigest(); } catch { return true; }
}

export async function buildServer({ esbuild = loadEsbuild() } = {}) {
  if (!esbuild) throw new Error("找不到 esbuild:在 iimos 里由 launcher 提供(IIMOS_TOOLCHAIN),开发时先 npm install");
  const started = Date.now();
  fs.mkdirSync(path.dirname(OUTFILE), { recursive: true });
  const staging = `${OUTFILE}.next`;
  await esbuild.build({
    entryPoints: [path.join(ROOT, "server", "index.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: staging,
    // ws 的两个可选原生加速模块:没有就用纯 JS,留成外部引用让它 require 失败后自己退化
    external: ["bufferutil", "utf-8-validate"],
    banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
    logLevel: "warning",
  });
  fs.renameSync(staging, OUTFILE);
  fs.writeFileSync(HASHFILE, `${sourceDigest()}\n`);
  return { ms: Date.now() - started };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { ms } = await buildServer();
  console.log(`服务端已编译到 dist/server.mjs(${ms}ms)`);
}
