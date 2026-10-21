# AGENT.md

> 这份文档由你(worktop 形态里的 agent)维护,写给下一次的你自己。结构变了、加了功能、定了约定、踩了坑,就改这里。
> 你每一轮都会读到它,写错了下一次的你就会被带偏。下面是出厂时的样子。

## 这是什么

worktop 是 iimos 的一个形态:个人 AI 工作台。左侧活动栏(对话、文件、网站、应用、小组件、技能、设置),
右侧是标签页 + 左右分屏的工作区,对话、文件、终端、网页、Git、应用都在标签里开。
六个工具:bash、read、edit、write、browser、confirm。模型用用户自己的(BYOK),配置在 `$IIMOS_DATA/config.json`。

你跑在 launcher 拉起的子进程里,脚下这个目录(workspace)就是你自己的源码,全都可以改。改完 `iimos reload`(只改了 ui/)
或 `iimos restart`(改了 server/ 或 main.js);每改完一件事 `iimos snapshot "说明"`。细节见 launcher 契约(每轮都在你的指令里)。

## 目录

```text
main.js             入口(纯 Node):server/ 的内容哈希和 dist/server.hash 对不上就用 launcher 的 esbuild 重打一次 → 起本地服务 → iimos.ready({ url, window })
dist/server.mjs     服务端的打包产物(进 git,回滚瞬间可用),server.hash 是它对应的源码哈希。手动重打:node scripts/build-server.mjs
server/             服务端,TypeScript,只听 127.0.0.1;窗口第一次带 ?token= 打开,换成 HttpOnly Cookie,接口和 WebSocket 都认它
  index.ts          http 服务:Host / Origin / 令牌三道闸,/api 分发,其余给 ui/ 静态文件;/apps/* 是应用桥(自带 Bearer,不认 Cookie)
  iimos.ts          launcher 能力的入口:call / on / notify。不经 launcher 跑时 call 直接报错
  system/paths.ts   数据在哪:$IIMOS_DATA/config.json(模型配置,所有形态共用)、$IIMOS_DATA/worktop/(数据库、favicons、日志、附件、apps、widgets、skills)
  settings/         config.ts 读写 config.json 的 responsesUrl / apiKey / model(只校验这三项,别的字段原样保留);store.ts 其余设置在 SQLite
  database/         node:sqlite,schema.ts 建表,不写迁移
  http/             api/ 按模块分路由;ws.ts 是唯一的双向通道(发消息、停止、终端);static.ts 托管 ui/index.html + ui/dist
  chats/            对话:turn.ts 运行编排(逐条落库、压缩、停止收尾),prompt.ts 拼系统提示词(含 launcher 契约 + 本文件),approvals.ts 提醒卡
  agent/            Agent 循环(index.js、compact.js)和六个工具(tools.ts 装配,functions/ 实现)
  ai/               模型请求(Responses 流式),重试
  vendor/ws/        ws 库原样复制进仓库:用户机器上没有 node_modules,重打服务端时要能找到它
  terminals/        terminals.ts 交互式终端:伪终端由 launcher 提供(契约 terminal.*),这里按 ws 连接分组转发;jobs.ts 后台进程(bash background)
  files/            文件树、常用目录、监听、附件;git/ 仓库状态与 diff
  browser/          收藏、历史、密码(密钥在 macOS 钥匙串)、favicon 代理 —— 都是数据,和真浏览器无关
  apps/ widgets/ skills/   应用(每个一个子进程 + 真 origin)、小组件(每个一个端口)、技能(SKILL.md);出厂的在 resources/,首次启动落地到数据目录
ui/                 界面:React + TypeScript(+ Tailwind 类名)
  index.html        只引用 dist/main.js 和 dist/main.css
  src/main.tsx      入口;App.tsx 顶层状态与快捷键;components/ 侧栏、工作区、对话、文件、设置……
  src/styles.css    Tailwind 源文件(@theme 里是全部颜色变量);styles.built.css 是编好的(进 git);extra.css 给不经 Tailwind 的新样式
  vendor/           第三方库:iimos add 装的(@dnd-kit/core、@xterm/xterm、@xterm/addon-fit、marked)和 codemirror-all.js(见下),vendor.json 记着来源
  vendor-src/codemirror-all.ts   CodeMirror 的统一入口,scripts/vendor-codemirror.mjs 打成 vendor/codemirror-all.js
  build.config.mjs  编译选项的补充(注入 __APP_VERSION__);iimos build 和 scripts/build-ui.mjs 都走它
  dist/             编译产物(iimos reload / build 生成),跟着源码一起进快照
resources/          出厂的技能、应用、小组件
scripts/            build-server.mjs(服务端打包,main.js 也 import 它)、build-ui.mjs(开发时编界面)、vendor-codemirror.mjs
tests/              node --test;host-routes.test.ts 用 tsx 跑(开发用,需要 node_modules)
package.json        version 是形态版本号;iimos.contract 是需要的 launcher 契约版本(2:要终端能力)
```

## 约定

- `config.json` 是所有形态共用的:responsesUrl / apiKey / model 三项是契约定的,别改它们的意思;别的形态写的字段原样保留。
  界面和 /api/settings 沿用 `apiUrl` 这个名字,store.ts 里换成 responsesUrl。
- 系统的事都走 launcher:终端 `terminal.*`、文件夹对话框 `dialog.open`、系统通知 `notify`、浏览器 `browser.request`。
  不要 import electron,也装不了原生模块(node-pty 这类)。
- **终端**:界面 ws 发 terminal_start / input / resize / stop,服务端转成 launcher 的 terminal.spawn / write / resize / kill,
  输出由 terminal.data 事件推回。launcher 拿不到伪终端时(Windows)命令照常能跑,TUI 不可用,界面上会说。
- **browser 工具**只有 tabs / open / close / cdp 四个操作,操作的是用户自己的 Chrome / Edge(要装 iimos 插件,在 iimos 仓库 extension/);
  页面里的一切用 cdp 发 Chrome 开发者工具协议命令,只能操作自己 open 的标签页,每个对话一个以标题命名的标签组。
  插件没连上时工具返回明确的失败。工作区里的「网页」标签是 iframe,只是看,和 browser 工具无关。
- **改服务端**:改 server/ 后 `iimos restart`,main.js 启动时会自动重打 dist/server.mjs(esbuild 由 launcher 提供)。
  服务端不能有 npm 依赖(用户机器上没有 node_modules):要用第三方库就像 server/vendor/ws 那样原样复制进来。
  想先看编译错误:`node scripts/build-server.mjs`。
- **改界面**:改 ui/src 后 `iimos reload`。Tailwind 类名只有 styles.built.css 里已经编进去的才有效(用户机器上没有 Tailwind 编译器);
  新样式写进 `ui/src/extra.css`(可用 --color-* 变量),或者直接写 style。有 node_modules 的开发机上 `npm run build:css` 重编。
- **加前端库**:`iimos add <包>`,之后照常 import。React 不用装。CodeMirror 例外:它的包都依赖同一份 @codemirror/state,
  要加 CodeMirror 的 API,在 ui/vendor-src/codemirror-all.ts 加一行 export,再 `npm run vendor:codemirror`(需要 node_modules)。
- 加工具:tools.ts 加定义 + functions/ 加实现,然后 `iimos restart`。
- **出厂应用(resources/apps/)的编译产物要进 git**:笔记的 ui/dist、创意的 app/dist、导图的 assets/client/apps/mindmap/dist。
  用户机器上没有 npm,只有源码的应用起不来。改了这些应用的源码,在开发机上重新编译再提交。
  出厂应用只在数据目录里还没有时才落地,老用户的副本不会自动更新。
- 数据格式要向前兼容:回滚只回代码,不动 $IIMOS_DATA。
- 端口跨启动稳定(记在 $IIMOS_DATA/worktop/port.json):界面偏好存 localStorage,按 origin 隔离,换端口就全没了。

## 验证

```sh
npm run build        # css + server + ui(开发机)
npm test             # 服务端测试(需要 node_modules)
npx tsc --noEmit     # 类型检查
iimos build          # 只编界面(用户机器上也能跑)
```

改了运行逻辑先跑测试再 restart。
