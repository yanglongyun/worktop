import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initTheme } from "./lib/theme";
// styles.css 是 Tailwind 源文件,npm run build:css 编成 styles.built.css(进 git);没有 node_modules 时直接改 extra.css
import "./styles.built.css";
import "./extra.css";

initTheme(); // 对齐主题偏好 + 跟随系统深浅变化(首帧定妆在 index.html 内联脚本)

createRoot(document.getElementById("app")!).render(<App />);
