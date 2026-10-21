// @ts-nocheck
// browser:控制用户的浏览器(Chrome / Edge),经 launcher 转给 iimos 浏览器插件(契约 browser.request)。
//
// 四个动作:tabs / open / close 管标签页,cdp 把 Chrome 开发者工具协议命令原样转发。
// 只能操作自己 open 的标签页,每个对话的标签页放进以对话标题命名的标签组。
// 插件没连上(用户没装、浏览器没开)时诚实报错,不装能行。截图的 base64 存成 PNG 交给模型看。
import { writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { resolveLocalPath } from "../paths.js";
import { call, hasIimos, on } from "../../iimos.js";
import { getChat } from "../../chats/store.js";

const ACTIONS = ["tabs", "open", "close", "cdp"];

export const browserDef = {
  type: "function",
  name: "browser",
  description:
    "控制用户的浏览器(Chrome / Edge,需要用户装了 iimos 浏览器插件)。只能操作你用 open 打开的标签页,它们放在以当前对话标题命名的标签组里。" +
    "open 打开网页并等加载完;页面里的一切操作用 cdp 发送 Chrome 开发者工具协议命令,method 是命令名,params 是参数。常用做法:" +
    "读文字:Runtime.evaluate { expression: \"document.body.innerText\", returnByValue: true };" +
    "执行 JS:Runtime.evaluate { expression, awaitPromise: true, returnByValue: true };" +
    "点击:先用 Runtime.evaluate 取元素 getBoundingClientRect 的中心,再依次发 Input.dispatchMouseEvent mouseMoved、mousePressed、mouseReleased(button: \"left\", clickCount: 1);" +
    "输入:先点击输入框,再 Input.insertText { text };按键:Input.dispatchKeyEvent keyDown 和 keyUp(key、code、windowsVirtualKeyCode);" +
    "滚动:Input.dispatchMouseEvent { type: \"mouseWheel\", x, y, deltaX: 0, deltaY };" +
    "截图:Page.captureScreenshot { format: \"png\", clip: { x: scrollX, y: scrollY, width: innerWidth, height: innerHeight, scale: 1 / devicePixelRatio } },这样图片坐标就是点击坐标;截图会保存成 PNG 并作为图片交给你。" +
    "点击或跳转后页面可能还在加载,需要时用 Runtime.evaluate 查 document.readyState。",
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string", description: "一句话说明这次操作的目的(界面会显示)" },
      action: {
        type: "string",
        enum: ACTIONS,
        description: "tabs 列出已打开的标签页;open 打开网址(带 tab 则在该标签页跳转);close 关闭标签页;cdp 发送 CDP 命令",
      },
      tab: { type: "integer", description: "标签页编号,open 返回" },
      url: { type: "string", description: "open 的网址" },
      method: { type: "string", description: "cdp 的命令名,如 Runtime.evaluate、Input.dispatchMouseEvent、Page.captureScreenshot" },
      params: { type: "object", description: "cdp 的命令参数" },
      path: { type: "string", description: "截图可选:保存路径,支持绝对路径或 ~/;默认保存到本轮产物目录" },
    },
    required: ["summary", "action"],
    additionalProperties: false,
  },
};

export const browser = async ({ action, tab, url, method, params, path: savePath }, ctx) => {
  const act = String(action || "");
  if (!ACTIONS.includes(act)) return `error: action 必须是 ${ACTIONS.join(" / ")} 之一`;
  if (!hasIimos()) return "error: browser 不可用 —— 需要在 iimos 里运行(当前没有 launcher)。";
  try {
    const status = await call("browser.status");
    if (!status?.connected) return "error: 浏览器插件未连接:请让用户在 Chrome 或 Edge 里安装并启用 iimos 插件(iimos 仓库的 extension/ 目录),并打开浏览器。";
    // 带上对话信息,插件按对话把标签页放进以标题命名的标签组
    const chat = ctx?.chatId ? getChat(String(ctx.chatId)) : null;
    const session = { id: String(ctx?.chatId || "worktop"), title: chat?.title || "worktop" };
    const args = { session };
    if (act === "open") {
      const target = String(url || "").trim();
      if (!target) return "error: open 需要 url";
      args.url = /^[a-z][a-z0-9+.-]*:/i.test(target) ? target : `https://${target}`;
      if (!/^https?:\/\//i.test(args.url)) return "error: 只支持 http(s) 网址";
      if (tab != null) args.tab = Number(tab);
    } else if (act === "close") {
      if (tab == null) return "error: close 需要 tab";
      args.tab = Number(tab);
    } else if (act === "cdp") {
      if (tab == null) return "error: cdp 需要 tab(先 tabs 或 open)";
      if (!String(method || "").trim()) return "error: cdp 需要 method";
      args.tab = Number(tab);
      args.method = String(method);
      args.params = params && typeof params === "object" ? params : {};
    }
    const result = await call("browser.request", { action: act, args });

    if (act === "tabs") {
      const tabs = Array.isArray(result?.tabs) ? result.tabs : [];
      if (!tabs.length) return "还没有打开的标签页,用 open 打开网页";
      return tabs.map((t) => `[tab ${t.tab}] ${t.title || "(无标题)"}(${t.group || ""})\n${t.url}`).join("\n");
    }
    if (act === "close") return `已关闭 tab ${result?.closed ?? tab}`;
    if (act === "open") return `[tab ${result?.tab}] ${result?.title || ""}\n${result?.url || args.url}`;

    // 页面脚本抛错时 CDP 会在结果里带 exceptionDetails,当作工具失败
    if (result?.exceptionDetails) {
      const detail = result.exceptionDetails;
      return `error: ${detail.exception?.description || detail.text || "脚本执行出错"}`;
    }
    if (args.method === "Page.captureScreenshot" && typeof result?.data === "string") {
      const bytes = Buffer.from(result.data, "base64");
      const ext = args.params?.format === "jpeg" ? ".jpeg" : args.params?.format === "webp" ? ".webp" : ".png";
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
      const requested = String(savePath || "").trim();
      const abs = requested ? resolveLocalPath(requested, ctx.cwd)
        : resolveLocalPath(join(ctx.outputDir || ctx.cwd || "~", `web-shot-${stamp}${ext}`));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, bytes);
      ctx.emit?.({ type: "tree_changed", reason: "browser_screenshot", paths: [abs] });
      return {
        output: `已截图保存到 ${abs}(${Math.round(bytes.length / 1024)} KB),并已作为图像交给你查看。`,
        image: { path: abs, mimeType: ext === ".png" ? "image/png" : ext === ".jpeg" ? "image/jpeg" : "image/webp", size: bytes.length },
      };
    }
    return JSON.stringify(result ?? null, null, 2);
  } catch (error) {
    return `error: ${error?.message || error}`;
  }
};

/** 插件连上 / 断开时给界面一个信号(界面上可以提示),没人听也无所谓。 */
export const watchBrowser = (emit) => {
  on("browser.connected", () => emit({ type: "browser_status", connected: true }));
  on("browser.disconnected", () => emit({ type: "browser_status", connected: false }));
};
