// 在仓库里编译界面,和 launcher 的 iimos build 用同一套选项:ui/src/main.tsx → ui/dist/main.js + main.css。
// 第三方库从 ui/vendor/ 取(iimos add 装的,或 scripts/vendor-codemirror.mjs 打的),React 用 node_modules 里的那份;
// 运行时 launcher 用自带的 React。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ui = path.join(ROOT, "ui");
let vendor = {};
try { vendor = JSON.parse(fs.readFileSync(path.join(ui, "vendor", "vendor.json"), "utf8")); } catch { /* 没装过第三方库 */ }
const alias = Object.fromEntries(Object.entries(vendor).map(([name, { file }]) => [name, `./vendor/${file}`]));
const defaults = {
  absWorkingDir: ui,
  entryPoints: ["src/main.tsx"],
  outdir: "dist",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome130",
  jsx: "automatic",
  minify: true,
  charset: "utf8",
  sourcemap: false,
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".svg": "file", ".png": "file", ".woff2": "file" },
  nodePaths: [path.join(ROOT, "node_modules")],
  alias,
  logLevel: "warning",
};
const { default: configure } = await import(path.join(ui, "build.config.mjs"));
await esbuild.build(configure(defaults));
console.log("界面已编译到 ui/dist");
