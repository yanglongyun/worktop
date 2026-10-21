// 模型配置固定在 $IIMOS_DATA/config.json:responsesUrl / apiKey / model 三项是 launcher 契约定的,所有形态共用。
// 这里只校验 worktop 自己用的字段;别的形态写进去的字段原样保留,不认识的不报错。
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DATA_ROOT } from "../system/paths.js";

export const CONFIG_PATH = path.join(DATA_ROOT, "config.json");

export type ModelConfig = { responsesUrl: string; apiKey: string; model: string };
const KEYS: (keyof ModelConfig)[] = ["responsesUrl", "apiKey", "model"];

const readAll = (): Record<string, unknown> => {
  let raw: string;
  try { raw = fs.readFileSync(CONFIG_PATH, "utf8"); }
  catch (error: any) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`配置文件读取失败:${error?.message || error}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`配置文件不是合法的 JSON:${CONFIG_PATH}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("配置必须是对象");
  return parsed as Record<string, unknown>;
};

const validate = (config: Record<string, unknown>) => {
  for (const key of KEYS) {
    if (key in config && typeof config[key] !== "string") throw new Error(`${key} 必须是字符串`);
  }
  const url = String(config.responsesUrl || "");
  if (url) {
    let address: URL;
    try { address = new URL(url); } catch { throw new Error("模型接口地址无效"); }
    if (!["http:", "https:"].includes(address.protocol)) throw new Error("模型接口地址必须使用 HTTP 或 HTTPS");
  }
};

/** 读模型配置。文件不存在就是三个空串。 */
export const readModelConfig = (): ModelConfig => {
  const all = readAll();
  validate(all);
  return {
    responsesUrl: String(all.responsesUrl || ""),
    apiKey: String(all.apiKey || ""),
    model: String(all.model || ""),
  };
};

/** 改模型配置:只改给出的字段,文件里别的字段原样保留。原子写,权限 0600(里面有 key)。 */
export const writeModelConfig = (patch: Partial<ModelConfig>) => {
  const all = readAll();
  for (const key of KEYS) {
    if (patch[key] !== undefined && patch[key] !== null) all[key] = String(patch[key]);
  }
  validate(all);
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  const temp = `${CONFIG_PATH}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temp, CONFIG_PATH);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return readModelConfig();
};
