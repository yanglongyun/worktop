/** 形态版本号,ui/build.config.mjs 编译时从 package.json 注入。 */
declare const __APP_VERSION__: string;

/** esbuild 把 import "./x.css" 打进 dist/main.css;给 tsc 一个说法。 */
declare module "*.css";
