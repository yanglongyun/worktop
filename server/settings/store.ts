import { getDb } from "../database/connection.js";
import { readModelConfig, writeModelConfig } from "./config.js";

import { DEFAULT_SETTINGS } from "./defaults.js";

// 模型连接三项(apiUrl / apiKey / model)不在数据库里:它们是 launcher 契约定的 $IIMOS_DATA/config.json
// 的 responsesUrl / apiKey / model,所有形态共用。界面和接口沿用 apiUrl 这个名字,这里换一次。
const MODEL_KEYS = ["apiUrl", "apiKey", "model"] as const;

/** 老库里存过模型连接的,第一次搬进 config.json(config.json 已有的不动),搬完从库里删掉。 */
let migrated = false;
const migrateModelSettings = () => {
  if (migrated) return;
  migrated = true;
  const db = getDb();
  const rows = db.prepare("SELECT key, value FROM settings WHERE key IN ('apiUrl', 'apiKey', 'model')").all() as { key: string; value: string }[];
  if (!rows.length) return;
  try {
    const current = readModelConfig();
    const patch: Record<string, string> = {};
    for (const row of rows) {
      const target = row.key === "apiUrl" ? "responsesUrl" : row.key;
      if (!current[target as keyof typeof current] && row.value) patch[target] = row.value;
    }
    if (Object.keys(patch).length) writeModelConfig(patch);
    db.prepare("DELETE FROM settings WHERE key IN ('apiUrl', 'apiKey', 'model')").run();
  } catch (error: any) {
    console.error("[settings] 模型配置搬进 config.json 失败:", error?.message || error);
  }
};

const getSettings = () => {
  migrateModelSettings();
  const rows = getDb().prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const settings = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    if (row.key in DEFAULT_SETTINGS) settings[row.key as keyof typeof DEFAULT_SETTINGS] = row.value;
  }
  const model = readModelConfig();
  settings.apiUrl = model.responsesUrl;
  settings.apiKey = model.apiKey;
  settings.model = model.model;
  return settings;
};

const saveSettings = (patch: Record<string, unknown> = {}) => {
  const db = getDb();
  const model: Record<string, string> = {};
  const stmt = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    if (value === undefined || value === null) continue;
    if ((MODEL_KEYS as readonly string[]).includes(key)) {
      model[key === "apiUrl" ? "responsesUrl" : key] = String(value);
      continue;
    }
    stmt.run(key, String(value));
  }
  if (Object.keys(model).length) writeModelConfig(model);
  return getSettings();
};

/** 工具循环上限:开关关掉就是不限(给循环一个永远到不了的整数);开着按 maxToolRounds,非法值回落默认 64。 */
export const toolRoundsOf = (settings: { toolRoundsLimit?: string; maxToolRounds?: string }) => {
  if ((settings.toolRoundsLimit || "on") === "off") return Number.MAX_SAFE_INTEGER;
  const n = Number(settings.maxToolRounds);
  return Number.isInteger(n) && n > 0 ? n : 64;
};

export { getSettings, saveSettings };
