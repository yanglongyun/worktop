// 界面编译选项:iimos build 用 launcher 的默认选项(esbuild + React,见 launcher/build.js),这里只补 worktop 需要的。
// 收默认选项,返回改过的。scripts/build-ui.mjs(开发时在仓库里编)也走这里,两边一套。
import fs from "node:fs";

const version = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export default function (options) {
  return {
    ...options,
    define: { ...options.define, __APP_VERSION__: JSON.stringify(version) },
  };
}
