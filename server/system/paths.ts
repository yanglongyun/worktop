// 两个根,分开说:
//   REPO_ROOT —— 代码在哪:形态的根目录(workspace),main.js 就在这里。
//   数据 —— 全在 launcher 给的 IIMOS_DATA 下,回滚只回代码,不动数据:
//     $IIMOS_DATA/config.json       模型配置,launcher 契约定的,所有形态共用(见 settings/config.ts)
//     $IIMOS_DATA/worktop/           worktop 自己的东西:database/ favicons/ logs/ files/ apps/ widgets/ skills/
//   不经 launcher 跑(node main.js、测试)时用 WORKTOP_HOME / WORKTOP_PRODUCT_HOME,再没有就 ~/.worktop。
import fs from "node:fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

// 源码在 server/system/,打包后这段代码在 dist/server.mjs 里 —— 两处离根目录的层数不同,向上找到 main.js 所在的那层才是根。
const findRoot = (from: string) => {
  for (let dir = from; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "main.js")) && fs.existsSync(path.join(dir, "package.json"))) return dir;
    if (path.dirname(dir) === dir) return path.resolve(from, "../..");
  }
};
export const REPO_ROOT = findRoot(path.dirname(fileURLToPath(import.meta.url)));

/** 所有形态共用的数据根:config.json 住在这里。 */
export const DATA_ROOT = path.resolve(process.env.IIMOS_DATA || process.env.WORKTOP_HOME || path.join(os.homedir(), ".worktop"));
/** worktop 自己的数据目录。 */
export const DATA_HOME = process.env.IIMOS_DATA
  ? path.join(DATA_ROOT, "worktop")
  : path.resolve(process.env.WORKTOP_HOME || DATA_ROOT);

const PRODUCT_HOME = path.resolve(process.env.WORKTOP_PRODUCT_HOME || DATA_HOME);
/** 应用 / 组件 / 技能的家(落地后就是用户自己的文件)。 */
export const productHome = () => { fs.mkdirSync(PRODUCT_HOME, { recursive: true }); return PRODUCT_HOME; };
