# ws(vendored)

`ws` 8.22.0 原样复制(MIT,见 LICENSE)。放在仓库里而不是 node_modules:形态在用户机器上没有 npm,
main.js 用 launcher 的 esbuild 重打 dist/server.mjs 时要能在源码里直接找到它。
升级:把 node_modules/ws 的 lib/、index.js、wrapper.mjs、LICENSE、package.json 再复制一遍。
