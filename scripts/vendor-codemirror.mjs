// CodeMirror 打成一个 vendor 文件 ui/vendor/codemirror-all.js,记进 ui/vendor/vendor.json,界面里 import ... from "codemirror-all"。
//
// 为什么不逐个 iimos add:CodeMirror 的二十几个包都依赖同一个 @codemirror/state,逐个从 esm.sh 打包会各带一份 state,
// 两份 state 的扩展互不相认(典型症状 "Unrecognized extension value")。一次打成一个文件只有一份。
// 这里用仓库 node_modules 里的版本(npm install 后跑),产物进 git;用户机器上不需要再跑。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ui = path.join(ROOT, "ui");
const NAME = "codemirror-all";
const entry = path.join(ui, "vendor-src", `${NAME}.ts`);
const file = `${NAME}.js`;

await esbuild.build({
  entryPoints: [entry],
  outfile: path.join(ui, "vendor", file),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome130",
  minify: true,
  charset: "utf8",
  nodePaths: [path.join(ROOT, "node_modules")],
  logLevel: "warning",
});

const versions = Object.fromEntries(["codemirror", "@codemirror/state", "@codemirror/view", "@codemirror/language", "@codemirror/merge"].map((pkg) => [
  pkg, JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", pkg, "package.json"), "utf8")).version,
]));
const vendorFile = path.join(ui, "vendor", "vendor.json");
let vendor = {};
try { vendor = JSON.parse(fs.readFileSync(vendorFile, "utf8")); } catch { /* 第一次 */ }
vendor[NAME] = { version: versions.codemirror, file, source: `scripts/vendor-codemirror.mjs(本地 esbuild 打包 ui/vendor-src/${NAME}.ts,${JSON.stringify(versions)})`, at: new Date().toISOString() };
fs.writeFileSync(vendorFile, `${JSON.stringify(vendor, null, 2)}\n`);
console.log(`已打包 ui/vendor/${file}`);
