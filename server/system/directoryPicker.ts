import { execFile, execFileSync } from "child_process";
import path from "path";
import { call, hasIimos } from "../iimos.js";

const run = (cmd: string, args: string[], opts: Record<string, unknown> = {}) =>
  new Promise<string>((resolve, reject) => {
    execFile(cmd, args, { timeout: 0, maxBuffer: 1024 * 1024, ...opts }, (error: any, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(String(stdout || "").trim());
    });
  });

const commandExists = (cmd: string) => {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const isCancel = (error: any) => {
  const text = `${error?.message || ""}\n${error?.stderr || ""}`;
  // macOS 的取消文案随系统语言变化,用 AppleScript 错误码识别。
  if (process.platform === "darwin" && /\(-128\)/.test(text)) return true;
  return /cancel|canceled|cancelled|用户取消/i.test(text);
};

const pickDirectory = async () => {
  // 在 iimos 里:文件夹对话框由 launcher 开(契约 dialog.open),取消时 paths 为空数组
  if (hasIimos()) {
    const result = await call("dialog.open", { title: "选择文件夹", directory: true });
    const picked = Array.isArray(result?.paths) ? result.paths[0] : null;
    return picked ? path.resolve(String(picked)) : null;
  }
  try {
    if (process.platform === "darwin") {
      const picked = await run("osascript", [
        "-e",
        'POSIX path of (choose folder with prompt "选择文件夹")',
      ]);
      return picked ? path.resolve(picked) : null;
    }

    if (process.platform === "win32") {
      const script = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
        '$dialog.Description = "选择文件夹"',
        "$dialog.ShowNewFolderButton = $false",
        "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath }",
      ].join("; ");
      const picked = await run("powershell.exe", ["-NoProfile", "-Command", script]);
      return picked ? path.resolve(picked) : null;
    }

    if (commandExists("zenity")) {
      const picked = await run("zenity", ["--file-selection", "--directory", "--title=选择文件夹"]);
      return picked ? path.resolve(picked) : null;
    }
    if (commandExists("kdialog")) {
      const picked = await run("kdialog", ["--getexistingdirectory", process.cwd(), "选择文件夹"]);
      return picked ? path.resolve(picked) : null;
    }

    throw new Error("当前系统没有可用的目录选择器,请手动输入文件夹路径");
  } catch (error) {
    if (isCancel(error)) return null;
    throw error;
  }
};

export { pickDirectory };
