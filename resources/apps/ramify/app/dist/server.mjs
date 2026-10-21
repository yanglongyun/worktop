// src/server/index.ts
import { createServer } from "node:http";

// src/server/http/errors.ts
var HttpError = class extends Error {
  constructor(status, message, code = "REQUEST_FAILED") {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "HttpError";
  }
  status;
  code;
};

// src/server/http/router.ts
function parseTemplate(template) {
  return template.split("/").filter(Boolean).map((segment) => segment.startsWith(":") ? { kind: "parameter", name: segment.slice(1) } : { kind: "literal", value: segment });
}
function suppressBody(res) {
  const end = res.end.bind(res);
  res.end = ((...args) => {
    const callback = args.find((arg) => typeof arg === "function");
    return callback ? end(callback) : end();
  });
}
function matchPath(segments, path) {
  const values = path.split("/").filter(Boolean);
  if (values.length !== segments.length) return null;
  const params = {};
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (segment.kind === "literal") {
      if (segment.value !== values[index]) return null;
    } else {
      params[segment.name] = decodeURIComponent(values[index]);
    }
  }
  return params;
}
var Router = class {
  routes = [];
  get(template, handler) {
    this.add("GET", template, handler);
  }
  post(template, handler) {
    this.add("POST", template, handler);
  }
  put(template, handler) {
    this.add("PUT", template, handler);
  }
  delete(template, handler) {
    this.add("DELETE", template, handler);
  }
  async handle(req, res, path) {
    const isHead = req.method === "HEAD";
    const method = isHead ? "GET" : req.method;
    for (const route of this.routes) {
      if (method !== route.method) continue;
      const params = matchPath(route.segments, path);
      if (!params) continue;
      if (isHead) suppressBody(res);
      await route.handler({ req, res, path, params });
      return true;
    }
    return false;
  }
  add(method, template, handler) {
    this.routes.push({ method, segments: parseTemplate(template), handler });
  }
};

// src/server/http/response.ts
function sendJson(res, status, body) {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(body));
}
function sendText(res, status, body, contentType = "text/plain; charset=utf-8", headers = {}) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    ...headers
  });
  res.end(body);
}
function sendBuffer(res, body, contentType, headers = {}) {
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": body.length,
    ...headers
  });
  res.end(body);
}

// src/server/http/static.ts
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
var cwdDist = join(process.cwd(), "dist", "public");
var DIST = process.env.RAMIFY_APP_DIR ? join(process.env.RAMIFY_APP_DIR, "dist", "public") : existsSync(cwdDist) ? cwdDist : join(dirname(fileURLToPath(import.meta.url)), "public");
var MIME = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2"
};
function serveStatic(res, requestPath) {
  const requested = normalize(requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, ""));
  let file = join(DIST, requested);
  if (relative(DIST, file).startsWith("..")) {
    sendText(res, 403, "forbidden");
    return;
  }
  if (!existsSync(file)) {
    if (extname(requested) !== "") {
      sendText(res, 404, "not found");
      return;
    }
    file = join(DIST, "index.html");
  }
  if (!existsSync(file)) {
    sendText(res, 404, "Ramify runtime is incomplete");
    return;
  }
  const contentType = MIME[extname(file)] || "application/octet-stream";
  const cacheControl = relative(DIST, file).startsWith("assets") ? "public, max-age=31536000, immutable" : "no-cache";
  res.writeHead(200, {
    "Cache-Control": cacheControl,
    "Content-Type": contentType.startsWith("text/") ? `${contentType}; charset=utf-8` : contentType
  });
  res.end(readFileSync(file));
}

// src/server/db/connection.ts
import { randomUUID } from "node:crypto";
import { join as join3 } from "node:path";
import { DatabaseSync } from "node:sqlite";

// src/server/data-directory.ts
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join as join2 } from "node:path";
import { platform } from "node:process";
function resolveDataDirectory() {
  if (process.env.APP_DATA_DIR) return process.env.APP_DATA_DIR;
  if (process.env.RAMIFY_DATA_DIR) return process.env.RAMIFY_DATA_DIR;
  if (platform === "darwin") return join2(homedir(), "Library", "Application Support", "Ramify");
  if (platform === "win32") return join2(process.env.APPDATA || homedir(), "Ramify");
  return join2(process.env.XDG_DATA_HOME || join2(homedir(), ".local", "share"), "ramify");
}
var dataDirectory = resolveDataDirectory();
mkdirSync(dataDirectory, { recursive: true });

// src/server/db/connection.ts
var database = new DatabaseSync(join3(dataDirectory, "ramify.db"));
function transaction(operation) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
var createId = () => randomUUID().replaceAll("-", "").slice(0, 12);

// src/server/nodes/node.repository.ts
var TREE_QUERY = `
  WITH RECURSIVE tree AS (
    SELECT n.*, printf('%010d:%s', n.position, n.id) AS sort_path
    FROM nodes n WHERE n.project_id=? AND n.parent_id IS NULL
    UNION ALL
    SELECT n.*, tree.sort_path || '/' || printf('%010d:%s', n.position, n.id)
    FROM nodes n JOIN tree ON n.parent_id=tree.id
  )
  SELECT id, project_id, parent_id, position, type, title, content, created_at, updated_at,
    ROW_NUMBER() OVER (ORDER BY sort_path) AS seq
  FROM tree ORDER BY sort_path
`;
var NodeRepository = class {
  findStatement = database.prepare("SELECT * FROM nodes WHERE id=?");
  findInProjectStatement = database.prepare("SELECT * FROM nodes WHERE id=? AND project_id=?");
  listTreeStatement = database.prepare(TREE_QUERY);
  listProjectStatement = database.prepare("SELECT * FROM nodes WHERE project_id=? ORDER BY parent_id, position, created_at, id");
  nextPositionStatement = database.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM nodes WHERE project_id=? AND parent_id=?");
  insertRootStatement = database.prepare(`
    INSERT INTO nodes (id, project_id, parent_id, position, title)
    VALUES (?, ?, NULL, 0, ?)
  `);
  insertStatement = database.prepare(`
    INSERT INTO nodes (id, project_id, parent_id, position, type, title, content)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  updateNodeStatement = database.prepare(`
    UPDATE nodes SET parent_id=?, position=?, type=?, title=?, content=?,
      updated_at=strftime('%Y-%m-%d %H:%M:%f','now') WHERE id=?
  `);
  updateNodeVersionedStatement = database.prepare(`
    UPDATE nodes SET parent_id=?, position=?, type=?, title=?, content=?,
      updated_at=strftime('%Y-%m-%d %H:%M:%f','now') WHERE id=? AND updated_at=?
  `);
  deleteProjectNodesStatement = database.prepare("DELETE FROM nodes WHERE project_id=?");
  listSubtreeStatement = database.prepare(`
    WITH RECURSIVE subtree(id) AS (
      SELECT id FROM nodes WHERE id=?
      UNION ALL
      SELECT nodes.id FROM nodes JOIN subtree ON nodes.parent_id=subtree.id
    )
    SELECT * FROM nodes WHERE id IN (SELECT id FROM subtree)
  `);
  deleteSubtreeStatement = database.prepare(`
    WITH RECURSIVE subtree(id) AS (
      SELECT id FROM nodes WHERE id=?
      UNION ALL
      SELECT nodes.id FROM nodes JOIN subtree ON nodes.parent_id=subtree.id
    )
    DELETE FROM nodes WHERE id IN (SELECT id FROM subtree)
  `);
  descendantStatement = database.prepare(`
    WITH RECURSIVE subtree(id) AS (
      SELECT id FROM nodes WHERE id=?
      UNION ALL
      SELECT nodes.id FROM nodes JOIN subtree ON nodes.parent_id=subtree.id
    )
    SELECT 1 AS found FROM subtree WHERE id=? LIMIT 1
  `);
  find(id) {
    return this.findStatement.get(id);
  }
  findInProject(id, projectId) {
    return this.findInProjectStatement.get(id, projectId);
  }
  listTree(projectId) {
    return this.listTreeStatement.all(projectId);
  }
  listProject(projectId) {
    return this.listProjectStatement.all(projectId);
  }
  nextPosition(projectId, parentId) {
    return Number(this.nextPositionStatement.get(projectId, parentId).position);
  }
  insertRoot(id, projectId, title) {
    this.insertRootStatement.run(id, projectId, title);
  }
  insert(node) {
    this.insertStatement.run(node.id, node.projectId, node.parentId, node.position, node.type, node.title, node.content);
  }
  updateNode(id, parentId, position, type, title, content, expected) {
    const result = expected ? this.updateNodeVersionedStatement.run(parentId, position, type, title, content, id, expected) : this.updateNodeStatement.run(parentId, position, type, title, content, id);
    return Number(result.changes);
  }
  isInSubtree(rootId, nodeId) {
    return Boolean(this.descendantStatement.get(rootId, nodeId));
  }
  deleteProjectNodes(projectId) {
    this.deleteProjectNodesStatement.run(projectId);
  }
  listSubtree(id) {
    return this.listSubtreeStatement.all(id);
  }
  deleteSubtree(id) {
    return Number(this.deleteSubtreeStatement.run(id).changes);
  }
};

// src/server/http/body.ts
var MAX_BODY_BYTES = 10 * 1024 * 1024;
function readJsonBody(req) {
  return new Promise((resolve2, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "request body too large", "BODY_TOO_LARGE"));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end", () => {
      try {
        const value = data ? JSON.parse(data) : {};
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          reject(new HttpError(400, "JSON object required", "INVALID_BODY"));
          return;
        }
        resolve2(value);
      } catch {
        reject(new HttpError(400, "invalid JSON", "INVALID_JSON"));
      }
    });
    req.on("error", reject);
  });
}

// src/server/nodes/node.routes.ts
function registerNodeRoutes(router, service) {
  router.post("/api/projects/:projectId/nodes", async ({ req, res, params }) => {
    sendJson(res, 200, service.create(params.projectId, await readJsonBody(req)));
  });
  router.post("/api/projects/:projectId/nodes/batch", async ({ req, res, params }) => {
    sendJson(res, 200, service.createBatch(params.projectId, await readJsonBody(req)));
  });
  router.put("/api/nodes/:nodeId", async ({ req, res, params }) => {
    sendJson(res, 200, service.update(params.nodeId, await readJsonBody(req)));
  });
  router.put("/api/nodes/:nodeId/artifact", async ({ req, res, params }) => {
    sendJson(res, 200, service.updateArtifact(params.nodeId, await readJsonBody(req)));
  });
  router.put("/api/nodes/:nodeId/artifact/error", async ({ req, res, params }) => {
    sendJson(res, 200, service.markArtifactError(params.nodeId, await readJsonBody(req)));
  });
  router.delete("/api/nodes/:nodeId/artifact", ({ res, params }) => {
    sendJson(res, 200, service.clearArtifact(params.nodeId));
  });
  router.delete("/api/nodes/:nodeId", ({ res, params }) => {
    sendJson(res, 200, service.delete(params.nodeId));
  });
  router.get("/api/nodes/:nodeId/html", ({ req, res, params }) => {
    const artifact = service.html(params.nodeId);
    const revision = new URL(req.url ?? "", "http://127.0.0.1").searchParams.get("revision");
    sendText(res, 200, artifact.document, "text/html; charset=utf-8", {
      "Cache-Control": revision ? "private, max-age=31536000, immutable" : "no-store"
    });
  });
  router.get("/api/nodes/:nodeId/content", ({ res, params }) => {
    sendJson(res, 200, service.content(params.nodeId));
  });
  router.get("/api/nodes/:nodeId/artifact/source", ({ res, params }) => {
    sendJson(res, 200, service.artifactSource(params.nodeId));
  });
  router.get("/api/nodes/:nodeId/artifact", ({ res, params }) => {
    const artifact = service.artifact(params.nodeId);
    sendBuffer(res, artifact.content, artifact.mime, {
      "Cache-Control": "no-store",
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`
    });
  });
}

// src/shared/types.ts
var ARTIFACT_TYPES = ["html", "markdown", "svg", "image", "video", "audio"];
var THEME_PREFERENCES = ["light", "dark", "system"];
var LOCALES = ["zh-CN", "en", "ja", "es", "de"];
function isArtifactType(value) {
  return typeof value === "string" && ARTIFACT_TYPES.includes(value);
}
function isThemePreference(value) {
  return typeof value === "string" && THEME_PREFERENCES.includes(value);
}
function isLocale(value) {
  return typeof value === "string" && LOCALES.includes(value);
}

// node_modules/marked/lib/marked.esm.js
function M() {
  return { async: false, breaks: false, extensions: null, gfm: true, hooks: null, pedantic: false, renderer: null, silent: false, tokenizer: null, walkTokens: null };
}
var T = M();
function N(l3) {
  T = l3;
}
var _ = { exec: () => null };
function E(l3) {
  let e = [];
  return (t) => {
    let n = Math.max(0, Math.min(3, t - 1)), s = e[n];
    return s || (s = l3(n), e[n] = s), s;
  };
}
function d(l3, e = "") {
  let t = typeof l3 == "string" ? l3 : l3.source, n = { replace: (s, r) => {
    let i = typeof r == "string" ? r : r.source;
    return i = i.replace(m.caret, "$1"), t = t.replace(s, i), n;
  }, getRegex: () => new RegExp(t, e) };
  return n;
}
var Te = ((l3 = "") => {
  try {
    return !!new RegExp("(?<=1)(?<!1)" + l3);
  } catch {
    return false;
  }
})();
var m = { codeRemoveIndent: /^(?: {1,4}| {0,3}\t)/gm, outputLinkReplace: /\\([\[\]])/g, indentCodeCompensation: /^(\s+)(?:```)/, beginningSpace: /^\s+/, endingHash: /#$/, startingSpaceChar: /^ /, endingSpaceChar: / $/, nonSpaceChar: /[^ ]/, newLineCharGlobal: /\n/g, tabCharGlobal: /\t/g, multipleSpaceGlobal: /\s+/g, blankLine: /^[ \t]*$/, doubleBlankLine: /\n[ \t]*\n[ \t]*$/, blockquoteStart: /^ {0,3}>/, blockquoteSetextReplace: /\n {0,3}((?:=+|-+) *)(?=\n|$)/g, blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm, listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g, listIsTask: /^\[[ xX]\] +\S/, listReplaceTask: /^\[[ xX]\] +/, listTaskCheckbox: /\[[ xX]\]/, anyLine: /\n.*\n/, hrefBrackets: /^<(.*)>$/, tableDelimiter: /[:|]/, tableAlignChars: /^\||\| *$/g, tableRowBlankLine: /\n[ \t]*$/, tableAlignRight: /^ *-+: *$/, tableAlignCenter: /^ *:-+: *$/, tableAlignLeft: /^ *:-+ *$/, startATag: /^<a /i, endATag: /^<\/a>/i, startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i, endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i, startAngleBracket: /^</, endAngleBracket: />$/, pedanticHrefTitle: /^([^'"]*[^\s])\s+(['"])(.*)\2/, unicodeAlphaNumeric: /[\p{L}\p{N}]/u, escapeTest: /[&<>"']/, escapeReplace: /[&<>"']/g, escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/, escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, caret: /(^|[^\[])\^/g, percentDecode: /%25/g, findPipe: /\|/g, splitPipe: / \|/, slashPipe: /\\\|/g, carriageReturn: /\r\n|\r/g, spaceLine: /^ +$/gm, notSpaceStart: /^\S*/, endingNewline: /\n$/, listItemRegex: (l3) => new RegExp(`^( {0,3}${l3})((?:[	 ][^\\n]*)?(?:\\n|$))`), nextBulletRegex: E((l3) => new RegExp(`^ {0,${l3}}(?:[*+-]|\\d{1,9}[.)])((?:[ 	][^\\n]*)?(?:\\n|$))`)), hrRegex: E((l3) => new RegExp(`^ {0,${l3}}((?:- *){3,}|(?:_ *){3,}|(?:\\* *){3,})(?:\\n+|$)`)), fencesBeginRegex: E((l3) => new RegExp(`^ {0,${l3}}(?:\`\`\`|~~~)`)), headingBeginRegex: E((l3) => new RegExp(`^ {0,${l3}}#`)), htmlBeginRegex: E((l3) => new RegExp(`^ {0,${l3}}<(?:[a-z].*>|!--)`, "i")), blockquoteBeginRegex: E((l3) => new RegExp(`^ {0,${l3}}>`)) };
var Oe = /^(?:[ \t]*(?:\n|$))+/;
var we = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
var ye = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}\1[~`]* *(?=\n|$)|$)/;
var B = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
var Pe = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
var j = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
var oe = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |blockCode|fences|blockquote|heading|html|table))+?)\n {0,3}(=+|-+) *(?:\n+|$)/;
var ae = d(oe).replace(/bull/g, j).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/\|table/g, "").getRegex();
var Se = d(oe).replace(/bull/g, j).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/).getRegex();
var F = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table| +\n)[^\n]+)*)/;
var $e = /^[^\n]+/;
var U = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\])+/;
var Le = d(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/).replace("label", U).replace("title", /(?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\))/).getRegex();
var _e = d(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, j).getRegex();
var H = "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
var K = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
var ze = d("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n+|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n+|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n+|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n+|$)|</?(tag)(?: +|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|<(?!script|pre|style|textarea)([a-z][\\w-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|</(?!script|pre|style|textarea)[a-z][\\w-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$))", "i").replace("comment", K).replace("tag", H).replace("attribute", / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).getRegex();
var le = (l3) => d(F).replace("hr", B).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("|table", "").replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list", l3).replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", H).getRegex();
var Me = le(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/);
var Ee = le(/ {0,3}(?:[*+-]|\d{1,9}[.)])[ \t]+[^ \t\n]/);
var Ie = d(/^( {0,3}> ?(paragraph|[^\n]*)(?:\n|$))+/).replace("paragraph", Ee).getRegex();
var W = { blockquote: Ie, code: we, def: Le, fences: ye, heading: Pe, hr: B, html: ze, lheading: ae, list: _e, newline: Oe, paragraph: Me, table: _, text: $e };
var se = d("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)").replace("hr", B).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("blockquote", " {0,3}>").replace("code", "(?: {4}| {0,3}	)[^\\n]").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", H).getRegex();
var Ae = { ...W, lheading: Se, table: se, paragraph: d(F).replace("hr", B).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("table", se).replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", H).getRegex() };
var Ce = { ...W, html: d(`^ *(?:comment *(?:\\n|\\s*$)|<(tag)[\\s\\S]+?</\\1> *(?:\\n{2,}|\\s*$)|<tag(?:"[^"]*"|'[^']*'|\\s[^'"/>\\s]*)*?/?> *(?:\\n{2,}|\\s*$))`).replace("comment", K).replace(/tag/g, "(?!(?:a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img)\\b)\\w+(?!:|[^\\w\\s@]*@)\\b").getRegex(), def: /^ *\[([^\]]+)\]: *<?([^\s>]+)>?(?: +(["(][^\n]+[")]))? *(?:\n+|$)/, heading: /^(#{1,6})(.*)(?:\n+|$)/, fences: _, lheading: /^(.+?)\n {0,3}(=+|-+) *(?:\n+|$)/, paragraph: d(F).replace("hr", B).replace("heading", ` *#{1,6} *[^
]`).replace("lheading", ae).replace("|table", "").replace("blockquote", " {0,3}>").replace("|fences", "").replace("|list", "").replace("|html", "").replace("|tag", "").getRegex() };
var Be = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
var qe = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
var ue = /^( {2,}|\\)\n(?!\s*$)/;
var De = /^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/;
var I = /[\p{P}\p{S}]/u;
var Z = /[\s\p{P}\p{S}]/u;
var X = /[^\s\p{P}\p{S}]/u;
var ve = d(/^((?![*_])punctSpace)/, "u").replace(/punctSpace/g, Z).getRegex();
var pe = /(?!~)[\p{P}\p{S}]/u;
var He = /(?!~)[\s\p{P}\p{S}]/u;
var Ze = /(?:[^\s\p{P}\p{S}]|~)/u;
var Ge = d(/link|precode-code|html/, "g").replace("link", /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/).replace("precode-", Te ? "(?<!`)()" : "(^^|[^`])").replace("code", /(?<b>`+)[^`]+\k<b>(?!`)/).replace("html", /<(?! )[^<>]*?>/).getRegex();
var ce = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
var Ne = d(ce, "u").replace(/punct/g, I).getRegex();
var Qe = d(ce, "u").replace(/punct/g, pe).getRegex();
var he = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)";
var je = d(he, "gu").replace(/notPunctSpace/g, X).replace(/punctSpace/g, Z).replace(/punct/g, I).getRegex();
var Fe = d(he, "gu").replace(/notPunctSpace/g, Ze).replace(/punctSpace/g, He).replace(/punct/g, pe).getRegex();
var Ue = d("^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)", "gu").replace(/notPunctSpace/g, X).replace(/punctSpace/g, Z).replace(/punct/g, I).getRegex();
var Ke = d(/^~~?(?:((?!~)punct)|[^\s~])/, "u").replace(/punct/g, I).getRegex();
var We = "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)";
var Xe = d(We, "gu").replace(/notPunctSpace/g, X).replace(/punctSpace/g, Z).replace(/punct/g, I).getRegex();
var Je = d(/\\(punct)/, "gu").replace(/punct/g, I).getRegex();
var Ve = d(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/).replace("scheme", /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/).replace("email", /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/).getRegex();
var Ye = d(K).replace("(?:-->|$)", "-->").getRegex();
var et = d("^comment|^</[a-zA-Z][\\w:-]*\\s*>|^<[a-zA-Z][\\w-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>").replace("comment", Ye).replace("attribute", /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).getRegex();
var v = /(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/;
var tt = d(/^!?\[(label)\]\(\s*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?\s*\)/).replace("label", v).replace("href", /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/).replace("title", /"(?:\\"?|[^"\\])*"|'(?:\\'?|[^'\\])*'|\((?:\\\)?|[^)\\])*\)/).getRegex();
var ke = d(/^!?\[(label)\]\[(ref)\]/).replace("label", v).replace("ref", U).getRegex();
var de = d(/^!?\[(ref)\](?:\[\])?/).replace("ref", U).getRegex();
var nt = d("reflink|nolink(?!\\()", "g").replace("reflink", ke).replace("nolink", de).getRegex();
var ie = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
var J = { _backpedal: _, anyPunctuation: Je, autolink: Ve, blockSkip: Ge, br: ue, code: qe, del: _, delLDelim: _, delRDelim: _, emStrongLDelim: Ne, emStrongRDelimAst: je, emStrongRDelimUnd: Ue, escape: Be, link: tt, nolink: de, punctuation: ve, reflink: ke, reflinkSearch: nt, tag: et, text: De, url: _ };
var rt = { ...J, link: d(/^!?\[(label)\]\((.*?)\)/).replace("label", v).getRegex(), reflink: d(/^!?\[(label)\]\s*\[([^\]]*)\]/).replace("label", v).getRegex() };
var Q = { ...J, emStrongRDelimAst: Fe, emStrongLDelim: Qe, delLDelim: Ke, delRDelim: Xe, url: d(/^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/).replace("protocol", ie).replace("email", /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![-_])/).getRegex(), _backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/, del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/, text: d(/^([`~]+|[^`~])(?:(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)))/).replace("protocol", ie).getRegex() };
var st = { ...Q, br: d(ue).replace("{2,}", "*").getRegex(), text: d(Q.text).replace("\\b_", "\\b_| {2,}\\n").replace(/\{2,\}/g, "*").getRegex() };
var q = { normal: W, gfm: Ae, pedantic: Ce };
var A = { normal: J, gfm: Q, breaks: st, pedantic: rt };
var it = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
var ge = (l3) => it[l3];
function O(l3, e) {
  if (e) {
    if (m.escapeTest.test(l3)) return l3.replace(m.escapeReplace, ge);
  } else if (m.escapeTestNoEncode.test(l3)) return l3.replace(m.escapeReplaceNoEncode, ge);
  return l3;
}
function V(l3) {
  try {
    l3 = encodeURI(l3).replace(m.percentDecode, "%");
  } catch {
    return null;
  }
  return l3;
}
function Y(l3, e) {
  let t = l3.replace(m.findPipe, (r, i, o) => {
    let u = false, a = i;
    for (; --a >= 0 && o[a] === "\\"; ) u = !u;
    return u ? "|" : " |";
  }), n = t.split(m.splitPipe), s = 0;
  if (n[0].trim() || n.shift(), n.length > 0 && !n.at(-1)?.trim() && n.pop(), e) if (n.length > e) n.splice(e);
  else for (; n.length < e; ) n.push("");
  for (; s < n.length; s++) n[s] = n[s].trim().replace(m.slashPipe, "|");
  return n;
}
function $(l3, e, t) {
  let n = l3.length;
  if (n === 0) return "";
  let s = 0;
  for (; s < n; ) {
    let r = l3.charAt(n - s - 1);
    if (r === e && !t) s++;
    else if (r !== e && t) s++;
    else break;
  }
  return l3.slice(0, n - s);
}
function ee(l3) {
  let e = l3.split(`
`), t = e.length - 1;
  for (; t >= 0 && m.blankLine.test(e[t]); ) t--;
  return e.length - t <= 2 ? l3 : e.slice(0, t + 1).join(`
`);
}
function fe(l3, e) {
  if (l3.indexOf(e[1]) === -1) return -1;
  let t = 0;
  for (let n = 0; n < l3.length; n++) if (l3[n] === "\\") n++;
  else if (l3[n] === e[0]) t++;
  else if (l3[n] === e[1] && (t--, t < 0)) return n;
  return t > 0 ? -2 : -1;
}
function me(l3, e = 0) {
  let t = e, n = "";
  for (let s of l3) if (s === "	") {
    let r = 4 - t % 4;
    n += " ".repeat(r), t += r;
  } else n += s, t++;
  return n;
}
function xe(l3, e, t, n, s) {
  let r = e.href, i = e.title || null, o = l3[1].replace(s.other.outputLinkReplace, "$1");
  n.state.inLink = true;
  let u = { type: l3[0].charAt(0) === "!" ? "image" : "link", raw: t, href: r, title: i, text: o, tokens: n.inlineTokens(o) };
  return n.state.inLink = false, u;
}
function ot(l3, e, t) {
  let n = l3.match(t.other.indentCodeCompensation);
  if (n === null) return e;
  let s = n[1];
  return e.split(`
`).map((r) => {
    let i = r.match(t.other.beginningSpace);
    if (i === null) return r;
    let [o] = i;
    return o.length >= s.length ? r.slice(s.length) : r;
  }).join(`
`);
}
var w = class {
  options;
  rules;
  lexer;
  constructor(e) {
    this.options = e || T;
  }
  space(e) {
    let t = this.rules.block.newline.exec(e);
    if (t && t[0].length > 0) return { type: "space", raw: t[0] };
  }
  code(e) {
    let t = this.rules.block.code.exec(e);
    if (t) {
      let n = this.options.pedantic ? t[0] : ee(t[0]), s = n.replace(this.rules.other.codeRemoveIndent, "");
      return { type: "code", raw: n, codeBlockStyle: "indented", text: s };
    }
  }
  fences(e) {
    let t = this.rules.block.fences.exec(e);
    if (t) {
      let n = t[0], s = ot(n, t[3] || "", this.rules);
      return { type: "code", raw: n, lang: t[2] ? t[2].trim().replace(this.rules.inline.anyPunctuation, "$1") : t[2], text: s };
    }
  }
  heading(e) {
    let t = this.rules.block.heading.exec(e);
    if (t) {
      let n = t[2].trim();
      if (this.rules.other.endingHash.test(n)) {
        let s = $(n, "#");
        (this.options.pedantic || !s || this.rules.other.endingSpaceChar.test(s)) && (n = s.trim());
      }
      return { type: "heading", raw: $(t[0], `
`), depth: t[1].length, text: n, tokens: this.lexer.inline(n) };
    }
  }
  hr(e) {
    let t = this.rules.block.hr.exec(e);
    if (t) return { type: "hr", raw: $(t[0], `
`) };
  }
  blockquote(e) {
    let t = this.rules.block.blockquote.exec(e);
    if (t) {
      let n = $(t[0], `
`).split(`
`), s = "", r = "", i = [];
      for (; n.length > 0; ) {
        let o = false, u = [], a;
        for (a = 0; a < n.length; a++) if (this.rules.other.blockquoteStart.test(n[a])) u.push(n[a]), o = true;
        else if (!o) u.push(n[a]);
        else break;
        n = n.slice(a);
        let c = u.join(`
`), p = c.replace(this.rules.other.blockquoteSetextReplace, `
    $1`).replace(this.rules.other.blockquoteSetextReplace2, "");
        s = s ? `${s}
${c}` : c, r = r ? `${r}
${p}` : p;
        let k = this.lexer.state.top;
        if (this.lexer.state.top = true, this.lexer.blockTokens(p, i, true), this.lexer.state.top = k, n.length === 0) break;
        let h = i.at(-1);
        if (h?.type === "code") break;
        if (h?.type === "blockquote") {
          let R = h, f = R.raw + `
` + n.join(`
`), S = this.blockquote(f);
          i[i.length - 1] = S, s = s.substring(0, s.length - R.raw.length) + S.raw, r = r.substring(0, r.length - R.text.length) + S.text;
          break;
        } else if (h?.type === "list") {
          let R = h, f = R.raw + `
` + n.join(`
`), S = this.list(f);
          i[i.length - 1] = S, s = s.substring(0, s.length - h.raw.length) + S.raw, r = r.substring(0, r.length - R.raw.length) + S.raw, n = f.substring(i.at(-1).raw.length).split(`
`);
          continue;
        }
      }
      return { type: "blockquote", raw: s, tokens: i, text: r };
    }
  }
  list(e) {
    let t = this.rules.block.list.exec(e);
    if (t) {
      let n = t[1].trim(), s = n.length > 1, r = { type: "list", raw: "", ordered: s, start: s ? +n.slice(0, -1) : "", loose: false, items: [] };
      n = s ? `\\d{1,9}\\${n.slice(-1)}` : `\\${n}`, this.options.pedantic && (n = s ? n : "[*+-]");
      let i = this.rules.other.listItemRegex(n), o = false;
      for (; e; ) {
        let a = false, c = "", p = "";
        if (!(t = i.exec(e)) || this.rules.block.hr.test(e)) break;
        c = t[0], e = e.substring(c.length);
        let k = me(t[2].split(`
`, 1)[0], t[1].length), h = e.split(`
`, 1)[0], R = !k.trim(), f = 0;
        if (this.options.pedantic ? (f = 2, p = k.trimStart()) : R ? f = t[1].length + 1 : (f = k.search(this.rules.other.nonSpaceChar), f = f > 4 ? 1 : f, p = k.slice(f), f += t[1].length), R && this.rules.other.blankLine.test(h) && (c += h + `
`, e = e.substring(h.length + 1), a = true), !a) {
          let S = this.rules.other.nextBulletRegex(f), te = this.rules.other.hrRegex(f), ne = this.rules.other.fencesBeginRegex(f), re = this.rules.other.headingBeginRegex(f), be = this.rules.other.htmlBeginRegex(f), Re = this.rules.other.blockquoteBeginRegex(f);
          for (; e; ) {
            let G = e.split(`
`, 1)[0], C;
            if (h = G, this.options.pedantic ? (h = h.replace(this.rules.other.listReplaceNesting, "  "), C = h) : C = h.replace(this.rules.other.tabCharGlobal, "    "), ne.test(h) || re.test(h) || be.test(h) || Re.test(h) || S.test(h) || te.test(h)) break;
            if (C.search(this.rules.other.nonSpaceChar) >= f || !h.trim()) p += `
` + C.slice(f);
            else {
              if (R || k.replace(this.rules.other.tabCharGlobal, "    ").search(this.rules.other.nonSpaceChar) >= 4 || ne.test(k) || re.test(k) || te.test(k)) break;
              p += `
` + h;
            }
            R = !h.trim(), c += G + `
`, e = e.substring(G.length + 1), k = C.slice(f);
          }
        }
        r.loose || (o ? r.loose = true : this.rules.other.doubleBlankLine.test(c) && (o = true)), r.items.push({ type: "list_item", raw: c, task: !!this.options.gfm && this.rules.other.listIsTask.test(p), loose: false, text: p, tokens: [] }), r.raw += c;
      }
      let u = r.items.at(-1);
      if (u) u.raw = u.raw.trimEnd(), u.text = u.text.trimEnd();
      else return;
      r.raw = r.raw.trimEnd();
      for (let a of r.items) {
        this.lexer.state.top = false, a.tokens = this.lexer.blockTokens(a.text, []);
        let c = a.tokens[0];
        if (a.task && (c?.type === "text" || c?.type === "paragraph")) {
          a.text = a.text.replace(this.rules.other.listReplaceTask, ""), c.raw = c.raw.replace(this.rules.other.listReplaceTask, ""), c.text = c.text.replace(this.rules.other.listReplaceTask, "");
          for (let k = this.lexer.inlineQueue.length - 1; k >= 0; k--) if (this.rules.other.listIsTask.test(this.lexer.inlineQueue[k].src)) {
            this.lexer.inlineQueue[k].src = this.lexer.inlineQueue[k].src.replace(this.rules.other.listReplaceTask, "");
            break;
          }
          let p = this.rules.other.listTaskCheckbox.exec(a.raw);
          if (p) {
            let k = { type: "checkbox", raw: p[0] + " ", checked: p[0] !== "[ ]" };
            a.checked = k.checked, r.loose ? a.tokens[0] && ["paragraph", "text"].includes(a.tokens[0].type) && "tokens" in a.tokens[0] && a.tokens[0].tokens ? (a.tokens[0].raw = k.raw + a.tokens[0].raw, a.tokens[0].text = k.raw + a.tokens[0].text, a.tokens[0].tokens.unshift(k)) : a.tokens.unshift({ type: "paragraph", raw: k.raw, text: k.raw, tokens: [k] }) : a.tokens.unshift(k);
          }
        } else a.task && (a.task = false);
        if (!r.loose) {
          let p = a.tokens.filter((h) => h.type === "space"), k = p.length > 0 && p.some((h) => this.rules.other.anyLine.test(h.raw));
          r.loose = k;
        }
      }
      if (r.loose) for (let a of r.items) {
        a.loose = true;
        for (let c of a.tokens) c.type === "text" && (c.type = "paragraph");
      }
      return r;
    }
  }
  html(e) {
    let t = this.rules.block.html.exec(e);
    if (t) {
      let n = ee(t[0]);
      return { type: "html", block: true, raw: n, pre: t[1] === "pre" || t[1] === "script" || t[1] === "style", text: n };
    }
  }
  def(e) {
    let t = this.rules.block.def.exec(e);
    if (t) {
      let n = t[1].toLowerCase().replace(this.rules.other.multipleSpaceGlobal, " "), s = t[2] ? t[2].replace(this.rules.other.hrefBrackets, "$1").replace(this.rules.inline.anyPunctuation, "$1") : "", r = t[3] ? t[3].substring(1, t[3].length - 1).replace(this.rules.inline.anyPunctuation, "$1") : t[3];
      return { type: "def", tag: n, raw: $(t[0], `
`), href: s, title: r };
    }
  }
  table(e) {
    let t = this.rules.block.table.exec(e);
    if (!t || !this.rules.other.tableDelimiter.test(t[2])) return;
    let n = Y(t[1]), s = t[2].replace(this.rules.other.tableAlignChars, "").split("|"), r = t[3]?.trim() ? t[3].replace(this.rules.other.tableRowBlankLine, "").split(`
`) : [], i = { type: "table", raw: $(t[0], `
`), header: [], align: [], rows: [] };
    if (n.length === s.length) {
      for (let o of s) this.rules.other.tableAlignRight.test(o) ? i.align.push("right") : this.rules.other.tableAlignCenter.test(o) ? i.align.push("center") : this.rules.other.tableAlignLeft.test(o) ? i.align.push("left") : i.align.push(null);
      for (let o = 0; o < n.length; o++) i.header.push({ text: n[o], tokens: this.lexer.inline(n[o]), header: true, align: i.align[o] });
      for (let o of r) i.rows.push(Y(o, i.header.length).map((u, a) => ({ text: u, tokens: this.lexer.inline(u), header: false, align: i.align[a] })));
      return i;
    }
  }
  lheading(e) {
    let t = this.rules.block.lheading.exec(e);
    if (t) {
      let n = t[1].trim();
      return { type: "heading", raw: $(t[0], `
`), depth: t[2].charAt(0) === "=" ? 1 : 2, text: n, tokens: this.lexer.inline(n) };
    }
  }
  paragraph(e) {
    let t = this.rules.block.paragraph.exec(e);
    if (t) {
      let n = t[1].charAt(t[1].length - 1) === `
` ? t[1].slice(0, -1) : t[1];
      return { type: "paragraph", raw: t[0], text: n, tokens: this.lexer.inline(n) };
    }
  }
  text(e) {
    let t = this.rules.block.text.exec(e);
    if (t) return { type: "text", raw: t[0], text: t[0], tokens: this.lexer.inline(t[0]) };
  }
  escape(e) {
    let t = this.rules.inline.escape.exec(e);
    if (t) return { type: "escape", raw: t[0], text: t[1] };
  }
  tag(e) {
    let t = this.rules.inline.tag.exec(e);
    if (t) return !this.lexer.state.inLink && this.rules.other.startATag.test(t[0]) ? this.lexer.state.inLink = true : this.lexer.state.inLink && this.rules.other.endATag.test(t[0]) && (this.lexer.state.inLink = false), !this.lexer.state.inRawBlock && this.rules.other.startPreScriptTag.test(t[0]) ? this.lexer.state.inRawBlock = true : this.lexer.state.inRawBlock && this.rules.other.endPreScriptTag.test(t[0]) && (this.lexer.state.inRawBlock = false), { type: "html", raw: t[0], inLink: this.lexer.state.inLink, inRawBlock: this.lexer.state.inRawBlock, block: false, text: t[0] };
  }
  link(e) {
    let t = this.rules.inline.link.exec(e);
    if (t) {
      let n = t[2].trim();
      if (!this.options.pedantic && this.rules.other.startAngleBracket.test(n)) {
        if (!this.rules.other.endAngleBracket.test(n)) return;
        let i = $(n.slice(0, -1), "\\");
        if ((n.length - i.length) % 2 === 0) return;
      } else {
        let i = fe(t[2], "()");
        if (i === -2) return;
        if (i > -1) {
          let u = (t[0].indexOf("!") === 0 ? 5 : 4) + t[1].length + i;
          t[2] = t[2].substring(0, i), t[0] = t[0].substring(0, u).trim(), t[3] = "";
        }
      }
      let s = t[2], r = "";
      if (this.options.pedantic) {
        let i = this.rules.other.pedanticHrefTitle.exec(s);
        i && (s = i[1], r = i[3]);
      } else r = t[3] ? t[3].slice(1, -1) : "";
      return s = s.trim(), this.rules.other.startAngleBracket.test(s) && (this.options.pedantic && !this.rules.other.endAngleBracket.test(n) ? s = s.slice(1) : s = s.slice(1, -1)), xe(t, { href: s && s.replace(this.rules.inline.anyPunctuation, "$1"), title: r && r.replace(this.rules.inline.anyPunctuation, "$1") }, t[0], this.lexer, this.rules);
    }
  }
  reflink(e, t) {
    let n;
    if ((n = this.rules.inline.reflink.exec(e)) || (n = this.rules.inline.nolink.exec(e))) {
      let s = (n[2] || n[1]).replace(this.rules.other.multipleSpaceGlobal, " "), r = t[s.toLowerCase()];
      if (!r) {
        let i = n[0].charAt(0);
        return { type: "text", raw: i, text: i };
      }
      return xe(n, r, n[0], this.lexer, this.rules);
    }
  }
  emStrong(e, t, n = "") {
    let s = this.rules.inline.emStrongLDelim.exec(e);
    if (!s || !s[1] && !s[2] && !s[3] && !s[4] || s[4] && n.match(this.rules.other.unicodeAlphaNumeric)) return;
    if (!(s[1] || s[3] || "") || !n || this.rules.inline.punctuation.exec(n)) {
      let i = [...s[0]].length - 1, o, u, a = i, c = 0, p = s[0][0] === "*" ? this.rules.inline.emStrongRDelimAst : this.rules.inline.emStrongRDelimUnd;
      for (p.lastIndex = 0, t = t.slice(-1 * e.length + i); (s = p.exec(t)) !== null; ) {
        if (o = s[1] || s[2] || s[3] || s[4] || s[5] || s[6], !o) continue;
        if (u = [...o].length, s[3] || s[4]) {
          a += u;
          continue;
        } else if ((s[5] || s[6]) && i % 3 && !((i + u) % 3)) {
          c += u;
          continue;
        }
        if (a -= u, a > 0) continue;
        u = Math.min(u, u + a + c);
        let k = [...s[0]][0].length, h = e.slice(0, i + s.index + k + u);
        if (Math.min(i, u) % 2) {
          let f = h.slice(1, -1);
          return { type: "em", raw: h, text: f, tokens: this.lexer.inlineTokens(f) };
        }
        let R = h.slice(2, -2);
        return { type: "strong", raw: h, text: R, tokens: this.lexer.inlineTokens(R) };
      }
    }
  }
  codespan(e) {
    let t = this.rules.inline.code.exec(e);
    if (t) {
      let n = t[2].replace(this.rules.other.newLineCharGlobal, " "), s = this.rules.other.nonSpaceChar.test(n), r = this.rules.other.startingSpaceChar.test(n) && this.rules.other.endingSpaceChar.test(n);
      return s && r && (n = n.substring(1, n.length - 1)), { type: "codespan", raw: t[0], text: n };
    }
  }
  br(e) {
    let t = this.rules.inline.br.exec(e);
    if (t) return { type: "br", raw: t[0] };
  }
  del(e, t, n = "") {
    let s = this.rules.inline.delLDelim.exec(e);
    if (!s) return;
    if (!(s[1] || "") || !n || this.rules.inline.punctuation.exec(n)) {
      let i = [...s[0]].length - 1, o, u, a = i, c = this.rules.inline.delRDelim;
      for (c.lastIndex = 0, t = t.slice(-1 * e.length + i); (s = c.exec(t)) !== null; ) {
        if (o = s[1] || s[2] || s[3] || s[4] || s[5] || s[6], !o || (u = [...o].length, u !== i)) continue;
        if (s[3] || s[4]) {
          a += u;
          continue;
        }
        if (a -= u, a > 0) continue;
        u = Math.min(u, u + a);
        let p = [...s[0]][0].length, k = e.slice(0, i + s.index + p + u), h = k.slice(i, -i);
        return { type: "del", raw: k, text: h, tokens: this.lexer.inlineTokens(h) };
      }
    }
  }
  autolink(e) {
    let t = this.rules.inline.autolink.exec(e);
    if (t) {
      let n, s;
      return t[2] === "@" ? (n = t[1], s = "mailto:" + n) : (n = t[1], s = n), { type: "link", raw: t[0], text: n, href: s, tokens: [{ type: "text", raw: n, text: n }] };
    }
  }
  url(e) {
    let t;
    if (t = this.rules.inline.url.exec(e)) {
      let n, s;
      if (t[2] === "@") n = t[0], s = "mailto:" + n;
      else {
        let r;
        do
          r = t[0], t[0] = this.rules.inline._backpedal.exec(t[0])?.[0] ?? "";
        while (r !== t[0]);
        n = t[0], t[1] === "www." ? s = "http://" + t[0] : s = t[0];
      }
      return { type: "link", raw: t[0], text: n, href: s, tokens: [{ type: "text", raw: n, text: n }] };
    }
  }
  inlineText(e) {
    let t = this.rules.inline.text.exec(e);
    if (t) {
      let n = this.lexer.state.inRawBlock;
      return { type: "text", raw: t[0], text: t[0], escaped: n };
    }
  }
};
var x = class l {
  tokens;
  options;
  state;
  inlineQueue;
  tokenizer;
  constructor(e) {
    this.tokens = [], this.tokens.links = /* @__PURE__ */ Object.create(null), this.options = e || T, this.options.tokenizer = this.options.tokenizer || new w(), this.tokenizer = this.options.tokenizer, this.tokenizer.options = this.options, this.tokenizer.lexer = this, this.inlineQueue = [], this.state = { inLink: false, inRawBlock: false, top: true };
    let t = { other: m, block: q.normal, inline: A.normal };
    this.options.pedantic ? (t.block = q.pedantic, t.inline = A.pedantic) : this.options.gfm && (t.block = q.gfm, this.options.breaks ? t.inline = A.breaks : t.inline = A.gfm), this.tokenizer.rules = t;
  }
  static get rules() {
    return { block: q, inline: A };
  }
  static lex(e, t) {
    return new l(t).lex(e);
  }
  static lexInline(e, t) {
    return new l(t).inlineTokens(e);
  }
  lex(e) {
    e = e.replace(m.carriageReturn, `
`), this.blockTokens(e, this.tokens);
    for (let t = 0; t < this.inlineQueue.length; t++) {
      let n = this.inlineQueue[t];
      this.inlineTokens(n.src, n.tokens);
    }
    return this.inlineQueue = [], this.tokens;
  }
  blockTokens(e, t = [], n = false) {
    this.tokenizer.lexer = this, this.options.pedantic && (e = e.replace(m.tabCharGlobal, "    ").replace(m.spaceLine, ""));
    let s = 1 / 0;
    for (; e; ) {
      if (e.length < s) s = e.length;
      else {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
      let r;
      if (this.options.extensions?.block?.some((o) => (r = o.call({ lexer: this }, e, t)) ? (e = e.substring(r.raw.length), t.push(r), true) : false)) continue;
      if (r = this.tokenizer.space(e)) {
        e = e.substring(r.raw.length);
        let o = t.at(-1);
        r.raw.length === 1 && o !== void 0 ? o.raw += `
` : t.push(r);
        continue;
      }
      if (r = this.tokenizer.code(e)) {
        e = e.substring(r.raw.length);
        let o = t.at(-1);
        o?.type === "paragraph" || o?.type === "text" ? (o.raw += (o.raw.endsWith(`
`) ? "" : `
`) + r.raw, o.text += `
` + r.text, this.inlineQueue.at(-1).src = o.text) : t.push(r);
        continue;
      }
      if (r = this.tokenizer.fences(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.heading(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.hr(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.blockquote(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.list(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.html(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.def(e)) {
        e = e.substring(r.raw.length);
        let o = t.at(-1);
        o?.type === "paragraph" || o?.type === "text" ? (o.raw += (o.raw.endsWith(`
`) ? "" : `
`) + r.raw, o.text += `
` + r.raw, this.inlineQueue.at(-1).src = o.text) : this.tokens.links[r.tag] || (this.tokens.links[r.tag] = { href: r.href, title: r.title }, t.push(r));
        continue;
      }
      if (r = this.tokenizer.table(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.lheading(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      let i = e;
      if (this.options.extensions?.startBlock) {
        let o = 1 / 0, u = e.slice(1), a;
        this.options.extensions.startBlock.forEach((c) => {
          a = c.call({ lexer: this }, u), typeof a == "number" && a >= 0 && (o = Math.min(o, a));
        }), o < 1 / 0 && o >= 0 && (i = e.substring(0, o + 1));
      }
      if (this.state.top && (r = this.tokenizer.paragraph(i))) {
        let o = t.at(-1);
        n && o?.type === "paragraph" ? (o.raw += (o.raw.endsWith(`
`) ? "" : `
`) + r.raw, o.text += `
` + r.text, this.inlineQueue.pop(), this.inlineQueue.at(-1).src = o.text) : t.push(r), n = i.length !== e.length, e = e.substring(r.raw.length);
        continue;
      }
      if (r = this.tokenizer.text(e)) {
        e = e.substring(r.raw.length);
        let o = t.at(-1);
        o?.type === "text" ? (o.raw += (o.raw.endsWith(`
`) ? "" : `
`) + r.raw, o.text += `
` + r.text, this.inlineQueue.pop(), this.inlineQueue.at(-1).src = o.text) : t.push(r);
        continue;
      }
      if (e) {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
    }
    return this.state.top = true, t;
  }
  inline(e, t = []) {
    return this.inlineQueue.push({ src: e, tokens: t }), t;
  }
  inlineTokens(e, t = []) {
    this.tokenizer.lexer = this;
    let n = e, s = null;
    if (this.tokens.links) {
      let a = Object.keys(this.tokens.links);
      if (a.length > 0) for (; (s = this.tokenizer.rules.inline.reflinkSearch.exec(n)) !== null; ) a.includes(s[0].slice(s[0].lastIndexOf("[") + 1, -1)) && (n = n.slice(0, s.index) + "[" + "a".repeat(s[0].length - 2) + "]" + n.slice(this.tokenizer.rules.inline.reflinkSearch.lastIndex));
    }
    for (; (s = this.tokenizer.rules.inline.anyPunctuation.exec(n)) !== null; ) n = n.slice(0, s.index) + "++" + n.slice(this.tokenizer.rules.inline.anyPunctuation.lastIndex);
    let r;
    for (; (s = this.tokenizer.rules.inline.blockSkip.exec(n)) !== null; ) r = s[2] ? s[2].length : 0, n = n.slice(0, s.index + r) + "[" + "a".repeat(s[0].length - r - 2) + "]" + n.slice(this.tokenizer.rules.inline.blockSkip.lastIndex);
    n = this.options.hooks?.emStrongMask?.call({ lexer: this }, n) ?? n;
    let i = false, o = "", u = 1 / 0;
    for (; e; ) {
      if (e.length < u) u = e.length;
      else {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
      i || (o = ""), i = false;
      let a;
      if (this.options.extensions?.inline?.some((p) => (a = p.call({ lexer: this }, e, t)) ? (e = e.substring(a.raw.length), t.push(a), true) : false)) continue;
      if (a = this.tokenizer.escape(e)) {
        e = e.substring(a.raw.length), t.push(a);
        continue;
      }
      if (a = this.tokenizer.tag(e)) {
        e = e.substring(a.raw.length), t.push(a);
        continue;
      }
      if (a = this.tokenizer.link(e)) {
        e = e.substring(a.raw.length), t.push(a);
        continue;
      }
      if (a = this.tokenizer.reflink(e, this.tokens.links)) {
        e = e.substring(a.raw.length);
        let p = t.at(-1);
        a.type === "text" && p?.type === "text" ? (p.raw += a.raw, p.text += a.text) : t.push(a);
        continue;
      }
      if (a = this.tokenizer.emStrong(e, n, o)) {
        e = e.substring(a.raw.length), t.push(a);
        continue;
      }
      if (a = this.tokenizer.codespan(e)) {
        e = e.substring(a.raw.length), t.push(a);
        continue;
      }
      if (a = this.tokenizer.br(e)) {
        e = e.substring(a.raw.length), t.push(a);
        continue;
      }
      if (a = this.tokenizer.del(e, n, o)) {
        e = e.substring(a.raw.length), t.push(a);
        continue;
      }
      if (a = this.tokenizer.autolink(e)) {
        e = e.substring(a.raw.length), t.push(a);
        continue;
      }
      if (!this.state.inLink && (a = this.tokenizer.url(e))) {
        e = e.substring(a.raw.length), t.push(a);
        continue;
      }
      let c = e;
      if (this.options.extensions?.startInline) {
        let p = 1 / 0, k = e.slice(1), h;
        this.options.extensions.startInline.forEach((R) => {
          h = R.call({ lexer: this }, k), typeof h == "number" && h >= 0 && (p = Math.min(p, h));
        }), p < 1 / 0 && p >= 0 && (c = e.substring(0, p + 1));
      }
      if (a = this.tokenizer.inlineText(c)) {
        e = e.substring(a.raw.length), a.raw.slice(-1) !== "_" && (o = a.raw.slice(-1)), i = true;
        let p = t.at(-1);
        p?.type === "text" ? (p.raw += a.raw, p.text += a.text) : t.push(a);
        continue;
      }
      if (e) {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
    }
    return t;
  }
  infiniteLoopError(e) {
    let t = "Infinite loop on byte: " + e;
    if (this.options.silent) console.error(t);
    else throw new Error(t);
  }
};
var y = class {
  options;
  parser;
  constructor(e) {
    this.options = e || T;
  }
  space(e) {
    return "";
  }
  code({ text: e, lang: t, escaped: n }) {
    let s = (t || "").match(m.notSpaceStart)?.[0], r = e.replace(m.endingNewline, "") + `
`;
    return s ? '<pre><code class="language-' + O(s) + '">' + (n ? r : O(r, true)) + `</code></pre>
` : "<pre><code>" + (n ? r : O(r, true)) + `</code></pre>
`;
  }
  blockquote({ tokens: e }) {
    return `<blockquote>
${this.parser.parse(e)}</blockquote>
`;
  }
  html({ text: e }) {
    return e;
  }
  def(e) {
    return "";
  }
  heading({ tokens: e, depth: t }) {
    return `<h${t}>${this.parser.parseInline(e)}</h${t}>
`;
  }
  hr(e) {
    return `<hr>
`;
  }
  list(e) {
    let t = e.ordered, n = e.start, s = "";
    for (let o = 0; o < e.items.length; o++) {
      let u = e.items[o];
      s += this.listitem(u);
    }
    let r = t ? "ol" : "ul", i = t && n !== 1 ? ' start="' + n + '"' : "";
    return "<" + r + i + `>
` + s + "</" + r + `>
`;
  }
  listitem(e) {
    return `<li>${this.parser.parse(e.tokens)}</li>
`;
  }
  checkbox({ checked: e }) {
    return "<input " + (e ? 'checked="" ' : "") + 'disabled="" type="checkbox"> ';
  }
  paragraph({ tokens: e }) {
    return `<p>${this.parser.parseInline(e)}</p>
`;
  }
  table(e) {
    let t = "", n = "";
    for (let r = 0; r < e.header.length; r++) n += this.tablecell(e.header[r]);
    t += this.tablerow({ text: n });
    let s = "";
    for (let r = 0; r < e.rows.length; r++) {
      let i = e.rows[r];
      n = "";
      for (let o = 0; o < i.length; o++) n += this.tablecell(i[o]);
      s += this.tablerow({ text: n });
    }
    return s && (s = `<tbody>${s}</tbody>`), `<table>
<thead>
` + t + `</thead>
` + s + `</table>
`;
  }
  tablerow({ text: e }) {
    return `<tr>
${e}</tr>
`;
  }
  tablecell(e) {
    let t = this.parser.parseInline(e.tokens), n = e.header ? "th" : "td";
    return (e.align ? `<${n} align="${e.align}">` : `<${n}>`) + t + `</${n}>
`;
  }
  strong({ tokens: e }) {
    return `<strong>${this.parser.parseInline(e)}</strong>`;
  }
  em({ tokens: e }) {
    return `<em>${this.parser.parseInline(e)}</em>`;
  }
  codespan({ text: e }) {
    return `<code>${O(e, true)}</code>`;
  }
  br(e) {
    return "<br>";
  }
  del({ tokens: e }) {
    return `<del>${this.parser.parseInline(e)}</del>`;
  }
  link({ href: e, title: t, tokens: n }) {
    let s = this.parser.parseInline(n), r = V(e);
    if (r === null) return s;
    e = r;
    let i = '<a href="' + e + '"';
    return t && (i += ' title="' + O(t) + '"'), i += ">" + s + "</a>", i;
  }
  image({ href: e, title: t, text: n, tokens: s }) {
    s && (n = this.parser.parseInline(s, this.parser.textRenderer));
    let r = V(e);
    if (r === null) return O(n);
    e = r;
    let i = `<img src="${e}" alt="${O(n)}"`;
    return t && (i += ` title="${O(t)}"`), i += ">", i;
  }
  text(e) {
    return "tokens" in e && e.tokens ? this.parser.parseInline(e.tokens) : "escaped" in e && e.escaped ? e.text : O(e.text);
  }
};
var L = class {
  strong({ text: e }) {
    return e;
  }
  em({ text: e }) {
    return e;
  }
  codespan({ text: e }) {
    return e;
  }
  del({ text: e }) {
    return e;
  }
  html({ text: e }) {
    return e;
  }
  text({ text: e }) {
    return e;
  }
  link({ text: e }) {
    return "" + e;
  }
  image({ text: e }) {
    return "" + e;
  }
  br() {
    return "";
  }
  checkbox({ raw: e }) {
    return e;
  }
};
var b = class l2 {
  options;
  renderer;
  textRenderer;
  constructor(e) {
    this.options = e || T, this.options.renderer = this.options.renderer || new y(), this.renderer = this.options.renderer, this.renderer.options = this.options, this.renderer.parser = this, this.textRenderer = new L();
  }
  static parse(e, t) {
    return new l2(t).parse(e);
  }
  static parseInline(e, t) {
    return new l2(t).parseInline(e);
  }
  parse(e) {
    this.renderer.parser = this;
    let t = "";
    for (let n = 0; n < e.length; n++) {
      let s = e[n];
      if (this.options.extensions?.renderers?.[s.type]) {
        let i = s, o = this.options.extensions.renderers[i.type].call({ parser: this }, i);
        if (o !== false || !["space", "hr", "heading", "code", "table", "blockquote", "list", "html", "def", "paragraph", "text"].includes(i.type)) {
          t += o || "";
          continue;
        }
      }
      let r = s;
      switch (r.type) {
        case "space": {
          t += this.renderer.space(r);
          break;
        }
        case "hr": {
          t += this.renderer.hr(r);
          break;
        }
        case "heading": {
          t += this.renderer.heading(r);
          break;
        }
        case "code": {
          t += this.renderer.code(r);
          break;
        }
        case "table": {
          t += this.renderer.table(r);
          break;
        }
        case "blockquote": {
          t += this.renderer.blockquote(r);
          break;
        }
        case "list": {
          t += this.renderer.list(r);
          break;
        }
        case "checkbox": {
          t += this.renderer.checkbox(r);
          break;
        }
        case "html": {
          t += this.renderer.html(r);
          break;
        }
        case "def": {
          t += this.renderer.def(r);
          break;
        }
        case "paragraph": {
          t += this.renderer.paragraph(r);
          break;
        }
        case "text": {
          t += this.renderer.text(r);
          break;
        }
        default: {
          let i = 'Token with "' + r.type + '" type was not found.';
          if (this.options.silent) return console.error(i), "";
          throw new Error(i);
        }
      }
    }
    return t;
  }
  parseInline(e, t = this.renderer) {
    this.renderer.parser = this;
    let n = "";
    for (let s = 0; s < e.length; s++) {
      let r = e[s];
      if (this.options.extensions?.renderers?.[r.type]) {
        let o = this.options.extensions.renderers[r.type].call({ parser: this }, r);
        if (o !== false || !["escape", "html", "link", "image", "strong", "em", "codespan", "br", "del", "text"].includes(r.type)) {
          n += o || "";
          continue;
        }
      }
      let i = r;
      switch (i.type) {
        case "escape": {
          n += t.text(i);
          break;
        }
        case "html": {
          n += t.html(i);
          break;
        }
        case "link": {
          n += t.link(i);
          break;
        }
        case "image": {
          n += t.image(i);
          break;
        }
        case "checkbox": {
          n += t.checkbox(i);
          break;
        }
        case "strong": {
          n += t.strong(i);
          break;
        }
        case "em": {
          n += t.em(i);
          break;
        }
        case "codespan": {
          n += t.codespan(i);
          break;
        }
        case "br": {
          n += t.br(i);
          break;
        }
        case "del": {
          n += t.del(i);
          break;
        }
        case "text": {
          n += t.text(i);
          break;
        }
        default: {
          let o = 'Token with "' + i.type + '" type was not found.';
          if (this.options.silent) return console.error(o), "";
          throw new Error(o);
        }
      }
    }
    return n;
  }
};
var P = class {
  options;
  block;
  constructor(e) {
    this.options = e || T;
  }
  static passThroughHooks = /* @__PURE__ */ new Set(["preprocess", "postprocess", "processAllTokens", "emStrongMask"]);
  static passThroughHooksRespectAsync = /* @__PURE__ */ new Set(["preprocess", "postprocess", "processAllTokens"]);
  preprocess(e) {
    return e;
  }
  postprocess(e) {
    return e;
  }
  processAllTokens(e) {
    return e;
  }
  emStrongMask(e) {
    return e;
  }
  provideLexer(e = this.block) {
    return e ? x.lex : x.lexInline;
  }
  provideParser(e = this.block) {
    return e ? b.parse : b.parseInline;
  }
};
var D = class {
  defaults = M();
  options = this.setOptions;
  parse = this.parseMarkdown(true);
  parseInline = this.parseMarkdown(false);
  Parser = b;
  Renderer = y;
  TextRenderer = L;
  Lexer = x;
  Tokenizer = w;
  Hooks = P;
  constructor(...e) {
    this.use(...e);
  }
  walkTokens(e, t) {
    let n = [];
    for (let s of e) switch (n = n.concat(t.call(this, s)), s.type) {
      case "table": {
        let r = s;
        for (let i of r.header) n = n.concat(this.walkTokens(i.tokens, t));
        for (let i of r.rows) for (let o of i) n = n.concat(this.walkTokens(o.tokens, t));
        break;
      }
      case "list": {
        let r = s;
        n = n.concat(this.walkTokens(r.items, t));
        break;
      }
      default: {
        let r = s;
        this.defaults.extensions?.childTokens?.[r.type] ? this.defaults.extensions.childTokens[r.type].forEach((i) => {
          let o = r[i].flat(1 / 0);
          n = n.concat(this.walkTokens(o, t));
        }) : r.tokens && (n = n.concat(this.walkTokens(r.tokens, t)));
      }
    }
    return n;
  }
  use(...e) {
    let t = this.defaults.extensions || { renderers: {}, childTokens: {} };
    return e.forEach((n) => {
      let s = { ...n };
      if (s.async = this.defaults.async || s.async || false, n.extensions && (n.extensions.forEach((r) => {
        if (!r.name) throw new Error("extension name required");
        if ("renderer" in r) {
          let i = t.renderers[r.name];
          i ? t.renderers[r.name] = function(...o) {
            let u = r.renderer.apply(this, o);
            return u === false && (u = i.apply(this, o)), u;
          } : t.renderers[r.name] = r.renderer;
        }
        if ("tokenizer" in r) {
          if (!r.level || r.level !== "block" && r.level !== "inline") throw new Error("extension level must be 'block' or 'inline'");
          let i = t[r.level];
          i ? i.unshift(r.tokenizer) : t[r.level] = [r.tokenizer], r.start && (r.level === "block" ? t.startBlock ? t.startBlock.push(r.start) : t.startBlock = [r.start] : r.level === "inline" && (t.startInline ? t.startInline.push(r.start) : t.startInline = [r.start]));
        }
        "childTokens" in r && r.childTokens && (t.childTokens[r.name] = r.childTokens);
      }), s.extensions = t), n.renderer) {
        let r = this.defaults.renderer || new y(this.defaults);
        for (let i in n.renderer) {
          if (!(i in r)) throw new Error(`renderer '${i}' does not exist`);
          if (["options", "parser"].includes(i)) continue;
          let o = i, u = n.renderer[o], a = r[o];
          r[o] = (...c) => {
            let p = u.apply(r, c);
            return p === false && (p = a.apply(r, c)), p || "";
          };
        }
        s.renderer = r;
      }
      if (n.tokenizer) {
        let r = this.defaults.tokenizer || new w(this.defaults);
        for (let i in n.tokenizer) {
          if (!(i in r)) throw new Error(`tokenizer '${i}' does not exist`);
          if (["options", "rules", "lexer"].includes(i)) continue;
          let o = i, u = n.tokenizer[o], a = r[o];
          r[o] = (...c) => {
            let p = u.apply(r, c);
            return p === false && (p = a.apply(r, c)), p;
          };
        }
        s.tokenizer = r;
      }
      if (n.hooks) {
        let r = this.defaults.hooks || new P();
        for (let i in n.hooks) {
          if (!(i in r)) throw new Error(`hook '${i}' does not exist`);
          if (["options", "block"].includes(i)) continue;
          let o = i, u = n.hooks[o], a = r[o];
          P.passThroughHooks.has(i) ? r[o] = (c) => {
            if (this.defaults.async && P.passThroughHooksRespectAsync.has(i)) return (async () => {
              let k = await u.call(r, c);
              return a.call(r, k);
            })();
            let p = u.call(r, c);
            return a.call(r, p);
          } : r[o] = (...c) => {
            if (this.defaults.async) return (async () => {
              let k = await u.apply(r, c);
              return k === false && (k = await a.apply(r, c)), k;
            })();
            let p = u.apply(r, c);
            return p === false && (p = a.apply(r, c)), p;
          };
        }
        s.hooks = r;
      }
      if (n.walkTokens) {
        let r = this.defaults.walkTokens, i = n.walkTokens;
        s.walkTokens = function(o) {
          let u = [];
          return u.push(i.call(this, o)), r && (u = u.concat(r.call(this, o))), u;
        };
      }
      this.defaults = { ...this.defaults, ...s };
    }), this;
  }
  setOptions(e) {
    return this.defaults = { ...this.defaults, ...e }, this;
  }
  lexer(e, t) {
    return x.lex(e, t ?? this.defaults);
  }
  parser(e, t) {
    return b.parse(e, t ?? this.defaults);
  }
  parseMarkdown(e) {
    return (n, s) => {
      let r = { ...s }, i = { ...this.defaults, ...r }, o = this.onError(!!i.silent, !!i.async);
      if (this.defaults.async === true && r.async === false) return o(new Error("marked(): The async option was set to true by an extension. Remove async: false from the parse options object to return a Promise."));
      if (typeof n > "u" || n === null) return o(new Error("marked(): input parameter is undefined or null"));
      if (typeof n != "string") return o(new Error("marked(): input parameter is of type " + Object.prototype.toString.call(n) + ", string expected"));
      if (i.hooks && (i.hooks.options = i, i.hooks.block = e), i.async) return (async () => {
        let u = i.hooks ? await i.hooks.preprocess(n) : n, c = await (i.hooks ? await i.hooks.provideLexer(e) : e ? x.lex : x.lexInline)(u, i), p = i.hooks ? await i.hooks.processAllTokens(c) : c;
        i.walkTokens && await Promise.all(this.walkTokens(p, i.walkTokens));
        let h = await (i.hooks ? await i.hooks.provideParser(e) : e ? b.parse : b.parseInline)(p, i);
        return i.hooks ? await i.hooks.postprocess(h) : h;
      })().catch(o);
      try {
        i.hooks && (n = i.hooks.preprocess(n));
        let a = (i.hooks ? i.hooks.provideLexer(e) : e ? x.lex : x.lexInline)(n, i);
        i.hooks && (a = i.hooks.processAllTokens(a)), i.walkTokens && this.walkTokens(a, i.walkTokens);
        let p = (i.hooks ? i.hooks.provideParser(e) : e ? b.parse : b.parseInline)(a, i);
        return i.hooks && (p = i.hooks.postprocess(p)), p;
      } catch (u) {
        return o(u);
      }
    };
  }
  onError(e, t) {
    return (n) => {
      if (n.message += `
Please report this to https://github.com/markedjs/marked.`, e) {
        let s = "<p>An error occurred:</p><pre>" + O(n.message + "", true) + "</pre>";
        return t ? Promise.resolve(s) : s;
      }
      if (t) return Promise.reject(n);
      throw n;
    };
  }
};
var z = new D();
function g(l3, e) {
  return z.parse(l3, e);
}
g.options = g.setOptions = function(l3) {
  return z.setOptions(l3), g.defaults = z.defaults, N(g.defaults), g;
};
g.getDefaults = M;
g.defaults = T;
g.use = function(...l3) {
  return z.use(...l3), g.defaults = z.defaults, N(g.defaults), g;
};
g.walkTokens = function(l3, e) {
  return z.walkTokens(l3, e);
};
g.parseInline = z.parseInline;
g.Parser = b;
g.parser = b.parse;
g.Renderer = y;
g.TextRenderer = L;
g.Lexer = x;
g.lexer = x.lex;
g.Tokenizer = w;
g.Hooks = P;
g.parse = g;
var Kt = g.options;
var Wt = g.setOptions;
var Xt = g.use;
var Jt = g.walkTokens;
var Vt = g.parseInline;
var en = b.parse;
var tn = x.lex;

// src/server/artifacts/render.ts
var MD_STYLE = `
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{margin:0;background:#faf7f2;color:#2b2620;font:16px/1.75 Georgia,'Songti SC','Noto Serif SC',serif;-webkit-font-smoothing:antialiased}
  main{max-width:720px;margin:0 auto;padding:56px 32px 88px}
  h1,h2,h3,h4,h5,h6{color:#171310;line-height:1.3;margin:2em 0 .6em;font-weight:700}
  h1{font-size:2rem;margin-top:.4em}
  h2{font-size:1.5rem;padding-bottom:.35em;border-bottom:1px solid #e7ded0}
  h3{font-size:1.2rem}
  p{margin:.9em 0}
  a{color:#b3492f;text-decoration:underline;text-underline-offset:3px}
  strong{color:#171310}
  blockquote{margin:1.4em 0;padding:.2em 1.2em;border-left:3px solid #c9a27a;background:#f3ece1;color:#5a4f42;border-radius:0 8px 8px 0}
  code{font:.86em/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#efe8dc;padding:.15em .4em;border-radius:5px}
  pre{background:#211d18;color:#e8e0d2;padding:18px 20px;border-radius:12px;overflow-x:auto;margin:1.4em 0}
  pre code{background:none;padding:0;color:inherit}
  ul,ol{padding-left:1.5em;margin:.9em 0}
  li{margin:.3em 0}
  table{border-collapse:collapse;width:100%;margin:1.4em 0;font-size:.94em}
  th,td{border:1px solid #e0d6c5;padding:.55em .8em;text-align:left}
  th{background:#f1eadd}
  hr{border:0;border-top:1px solid #e0d6c5;margin:2.4em auto;width:52%}
  img{max-width:100%}
`;
var SVG_STYLE = `
  html,body{margin:0;height:100%}
  body{display:grid;place-items:center;background:#f4f1ea;background-image:radial-gradient(#00000010 1px,transparent 1px);background-size:18px 18px}
  svg{max-width:92vw;max-height:92vh;filter:drop-shadow(0 10px 30px rgba(20,16,10,.14))}
`;
var MEDIA_STYLE = `
  :root{color-scheme:light}
  *{box-sizing:border-box}
  html,body{margin:0;width:100%;height:100%}
  body{display:grid;place-items:center;padding:24px;background:#f4f1ea;background-image:radial-gradient(#00000010 1px,transparent 1px);background-size:18px 18px}
  img,video{display:block;max-width:100%;max-height:100%;object-fit:contain;border-radius:12px;box-shadow:0 18px 48px rgba(20,16,10,.16)}
  audio{width:min(560px,100%)}
`;
var escapeHtml = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
var escapeAttribute = (value) => escapeHtml(value).replace(/"/g, "&quot;");
function standardsDocument(document) {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(document);
  if (doctype) return document;
  return `<!DOCTYPE html>${document}`;
}
function renderArtifact(content, type) {
  if (type === "image" || type === "video" || type === "audio") {
    const source = escapeAttribute(content.trim());
    const media = type === "image" ? `<img src="${source}" alt="\u751F\u6210\u7684\u56FE\u7247">` : type === "video" ? `<video src="${source}" controls playsinline preload="metadata"></video>` : `<audio src="${source}" controls preload="metadata"></audio>`;
    return standardsDocument(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>${MEDIA_STYLE}</style></head><body>${media}</body></html>`);
  }
  if (type === "markdown") {
    const body = g.parse(content, { async: false });
    return standardsDocument(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>${MD_STYLE}</style></head><body><main>${body}</main></body></html>`);
  }
  if (type === "svg") {
    return standardsDocument(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>${SVG_STYLE}</style></head><body>${content}</body></html>`);
  }
  return standardsDocument(content);
}

// src/server/nodes/node.service.ts
var MEDIA_TYPES = /* @__PURE__ */ new Set(["image", "video", "audio"]);
function requireTitle(value) {
  const title = typeof value === "string" ? value.trim() : "";
  if (!title) throw new HttpError(400, "title required", "TITLE_REQUIRED");
  return title;
}
function optionalContent(value) {
  return typeof value === "string" && value.length ? value : null;
}
function positionOf(value, fallback) {
  if (value === void 0) return fallback;
  if (!Number.isInteger(value) || Number(value) < 0) throw new HttpError(400, "position must be a non-negative integer", "INVALID_POSITION");
  return Number(value);
}
function requireArtifactSource(source) {
  const value = typeof source === "string" ? source : "";
  if (!value.trim()) throw new HttpError(400, "artifact required", "ARTIFACT_REQUIRED");
  return value;
}
function artifactPath(node) {
  return isArtifactType(node.type) ? node.content : null;
}
var NodeService = class {
  constructor(nodes, projects, artifacts) {
    this.nodes = nodes;
    this.projects = projects;
    this.artifacts = artifacts;
  }
  nodes;
  projects;
  artifacts;
  create(projectId, input) {
    this.requireProject(projectId);
    const parentId = typeof input.parentId === "string" ? input.parentId : "";
    if (!parentId) throw new HttpError(400, "parentId required", "PARENT_REQUIRED");
    if (!this.nodes.findInProject(parentId, projectId)) throw new HttpError(404, "parent node not found", "PARENT_NOT_FOUND");
    const artifactType = this.artifactTypeOf(input.artifactType);
    if (input.artifact !== void 0 && !artifactType) throw new HttpError(400, "artifactType required", "ARTIFACT_TYPE_REQUIRED");
    if (artifactType && input.content !== void 0 && input.content !== null) {
      throw new HttpError(400, "content cannot be combined with artifactType", "AMBIGUOUS_NODE_CONTENT");
    }
    const id = createId();
    const source = artifactType && input.artifact !== void 0 ? requireArtifactSource(input.artifact) : null;
    const artifact = source && artifactType ? this.artifacts.write(projectId, id, artifactType, source) : null;
    try {
      transaction(() => {
        this.nodes.insert({
          id,
          projectId,
          parentId,
          position: positionOf(input.position, this.nodes.nextPosition(projectId, parentId)),
          type: artifactType ?? "text",
          title: requireTitle(input.title),
          content: artifactType ? artifact : optionalContent(input.content)
        });
        this.projects.touch(projectId);
      });
    } catch (error) {
      this.artifacts.remove(artifact);
      throw error;
    }
    return { id };
  }
  createBatch(projectId, input) {
    this.requireProject(projectId);
    if (!Array.isArray(input.nodes) || input.nodes.length === 0) throw new HttpError(400, "nodes must be a non-empty array", "NODES_REQUIRED");
    if (input.nodes.length > 100) throw new HttpError(400, "batch is limited to 100 nodes", "BATCH_TOO_LARGE");
    const written = [];
    try {
      const result = transaction(() => {
        const ids = /* @__PURE__ */ new Map();
        const created = [];
        for (const raw of input.nodes) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "each batch node must be an object", "INVALID_BATCH_NODE");
          const item = raw;
          const key = typeof item.key === "string" ? item.key.trim() : "";
          if (!key || ids.has(key)) throw new HttpError(400, "batch node keys must be unique", "INVALID_BATCH_KEY");
          const parentId = typeof item.parentKey === "string" ? ids.get(item.parentKey) : typeof item.parentId === "string" ? item.parentId : void 0;
          if (!parentId || !this.nodes.findInProject(parentId, projectId)) throw new HttpError(404, `parent not found for ${key}`, "PARENT_NOT_FOUND");
          const artifactType = this.artifactTypeOf(item.artifactType, key);
          if (item.artifact !== void 0 && !artifactType) throw new HttpError(400, `artifactType required for ${key}`, "ARTIFACT_TYPE_REQUIRED");
          if (artifactType && item.content !== void 0 && item.content !== null) {
            throw new HttpError(400, `content cannot be combined with artifactType for ${key}`, "AMBIGUOUS_NODE_CONTENT");
          }
          const id = createId();
          const source = artifactType && item.artifact !== void 0 ? requireArtifactSource(item.artifact) : null;
          const artifact = source && artifactType ? this.artifacts.write(projectId, id, artifactType, source) : null;
          if (artifact) written.push(artifact);
          this.nodes.insert({
            id,
            projectId,
            parentId,
            position: positionOf(item.position, this.nodes.nextPosition(projectId, parentId)),
            type: artifactType ?? "text",
            title: requireTitle(item.title),
            content: artifactType ? artifact : optionalContent(item.content)
          });
          ids.set(key, id);
          created.push({ key, id });
        }
        this.projects.touch(projectId);
        return { nodes: created };
      });
      return result;
    } catch (error) {
      this.artifacts.removeMany(written);
      throw error;
    }
  }
  update(nodeId, input) {
    const node = this.requireNode(nodeId);
    const title = input.title === void 0 ? node.title : requireTitle(input.title);
    const changesContent = input.content !== void 0;
    const type = changesContent ? "text" : node.type;
    const content = changesContent ? optionalContent(input.content) : node.content;
    let parentId = node.parent_id;
    if (input.parentId !== void 0) {
      if (!node.parent_id) throw new HttpError(400, "root node cannot be moved", "ROOT_NODE_MOVE_NOT_ALLOWED");
      parentId = typeof input.parentId === "string" ? input.parentId : "";
      const parent = this.nodes.findInProject(parentId, node.project_id);
      if (!parent) throw new HttpError(404, "parent node not found", "PARENT_NOT_FOUND");
      if (parentId === nodeId || this.nodes.isInSubtree(nodeId, parentId)) throw new HttpError(400, "move would create a cycle", "TREE_CYCLE");
    }
    const expected = typeof input.expectedUpdatedAt === "string" ? input.expectedUpdatedAt : void 0;
    transaction(() => {
      if (!this.nodes.updateNode(nodeId, parentId, positionOf(input.position, node.position), type, title, content, expected)) {
        throw new HttpError(409, "node changed since it was read", "VERSION_CONFLICT");
      }
      this.projects.touch(node.project_id);
    });
    if (changesContent) this.artifacts.remove(artifactPath(node));
    return this.requireNode(nodeId);
  }
  updateArtifact(nodeId, input) {
    const node = this.requireNode(nodeId);
    if (!isArtifactType(input.artifactType)) throw new HttpError(400, "artifactType required", "ARTIFACT_TYPE_REQUIRED");
    const type = input.artifactType;
    const expected = typeof input.expectedUpdatedAt === "string" ? input.expectedUpdatedAt : void 0;
    if (expected && expected !== node.updated_at) throw new HttpError(409, "node changed since it was read", "VERSION_CONFLICT");
    const artifact = this.artifacts.write(node.project_id, nodeId, type, requireArtifactSource(input.artifact));
    const previousPath = artifactPath(node);
    try {
      transaction(() => {
        if (!this.nodes.updateNode(nodeId, node.parent_id, node.position, type, node.title, artifact, expected)) {
          throw new HttpError(409, "node changed since it was read", "VERSION_CONFLICT");
        }
        this.projects.touch(node.project_id);
      });
    } catch (error) {
      if (previousPath !== artifact) this.artifacts.remove(artifact);
      throw error;
    }
    if (previousPath !== artifact) this.artifacts.remove(previousPath);
    return { ok: true };
  }
  markArtifactError(nodeId, input) {
    const node = this.requireNode(nodeId);
    if (!isArtifactType(node.type)) throw new HttpError(400, "node has no artifact", "ARTIFACT_TYPE_REQUIRED");
    const error = typeof input.error === "string" ? input.error.trim() : "";
    if (!error) throw new HttpError(400, "error required", "ERROR_REQUIRED");
    const expected = typeof input.expectedUpdatedAt === "string" ? input.expectedUpdatedAt : void 0;
    transaction(() => {
      if (!this.nodes.updateNode(nodeId, node.parent_id, node.position, "error", node.title, error, expected)) {
        throw new HttpError(409, "node changed since it was read", "VERSION_CONFLICT");
      }
      this.projects.touch(node.project_id);
    });
    this.artifacts.remove(artifactPath(node));
    return { ok: true };
  }
  clearArtifact(nodeId) {
    const node = this.requireNode(nodeId);
    transaction(() => {
      this.nodes.updateNode(nodeId, node.parent_id, node.position, "text", node.title, null);
      this.projects.touch(node.project_id);
    });
    this.artifacts.remove(artifactPath(node));
    return { ok: true };
  }
  delete(nodeId) {
    const node = this.requireNode(nodeId);
    if (!node.parent_id) throw new HttpError(400, "root node cannot be deleted", "ROOT_NODE_IMMUTABLE");
    const paths = this.nodes.listSubtree(nodeId).map(artifactPath);
    const deleted = transaction(() => {
      const count = this.nodes.deleteSubtree(nodeId);
      this.projects.touch(node.project_id);
      return count;
    });
    this.artifacts.removeMany(paths);
    return { ok: true, deleted };
  }
  html(nodeId) {
    const node = this.requireArtifactNode(nodeId);
    const type = node.type;
    const path = node.content;
    const mime = this.artifacts.mime(path, type);
    const source = MEDIA_TYPES.has(type) ? mime.startsWith("text/uri-list") ? this.artifacts.readText(path).trim() : `/api/nodes/${node.id}/artifact` : this.artifacts.readText(path);
    return { document: renderArtifact(source, type) };
  }
  content(nodeId) {
    const node = this.requireNode(nodeId);
    return { content: node.type === "text" || node.type === "error" ? node.content : null };
  }
  artifactSource(nodeId) {
    const node = this.requireArtifactNode(nodeId);
    return { source: this.artifacts.source(node.content, node.type), artifactType: node.type };
  }
  artifact(nodeId) {
    const node = this.requireArtifactNode(nodeId);
    const path = node.content;
    const type = node.type;
    return { content: this.artifacts.read(path), mime: this.artifacts.mime(path, type), filename: this.artifacts.filename(path) };
  }
  artifactTypeOf(value, key) {
    if (value === void 0 || value === null) return null;
    if (isArtifactType(value)) return value;
    throw new HttpError(400, key ? `invalid artifactType for ${key}` : "invalid artifactType", "INVALID_ARTIFACT_TYPE");
  }
  requireProject(projectId) {
    const project = this.projects.find(projectId);
    if (!project) throw new HttpError(404, "project not found", "PROJECT_NOT_FOUND");
    return project;
  }
  requireNode(nodeId) {
    const node = this.nodes.find(nodeId);
    if (!node) throw new HttpError(404, "node not found", "NODE_NOT_FOUND");
    return node;
  }
  requireArtifactNode(nodeId) {
    const node = this.requireNode(nodeId);
    if (!isArtifactType(node.type) || !node.content) throw new HttpError(404, "artifact not found", "ARTIFACT_NOT_FOUND");
    return node;
  }
};

// src/server/projects/project.repository.ts
var ProjectRepository = class {
  listStatement = database.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM nodes n WHERE n.project_id=p.id AND n.parent_id IS NOT NULL) AS node_count,
      (SELECT COUNT(*) FROM nodes n WHERE n.project_id=p.id
        AND n.type IN ('html','markdown','svg','image','video','audio') AND n.content IS NULL) AS generating_count,
      (SELECT n.id FROM nodes n WHERE n.project_id=p.id AND n.parent_id IS NOT NULL
        AND n.type IN ('html','markdown','svg','image','video','audio') AND n.content IS NOT NULL
        ORDER BY n.created_at DESC LIMIT 1) AS preview_node_id
    FROM projects p
    ORDER BY p.updated_at DESC
  `);
  findStatement = database.prepare("SELECT * FROM projects WHERE id=?");
  insertStatement = database.prepare("INSERT INTO projects (id, title, prompt) VALUES (?, ?, ?)");
  deleteStatement = database.prepare("DELETE FROM projects WHERE id=?");
  touchStatement = database.prepare(`
    UPDATE projects SET updated_at=strftime('%Y-%m-%d %H:%M:%f','now') WHERE id=?
  `);
  renameStatement = database.prepare(`
    UPDATE projects SET title=?, updated_at=strftime('%Y-%m-%d %H:%M:%f','now') WHERE id=?
  `);
  renameVersionedStatement = database.prepare(`
    UPDATE projects SET title=?, updated_at=strftime('%Y-%m-%d %H:%M:%f','now') WHERE id=? AND updated_at=?
  `);
  touchAllStatement = database.prepare(`
    UPDATE projects SET updated_at=strftime('%Y-%m-%d %H:%M:%f','now')
  `);
  // 轻量版本标记:项目数量 + 最新 updated_at,足以让前端轮询判断"是否需要重新拉取列表"。
  listVersionStatement = database.prepare(`
    SELECT COUNT(*) AS count, COALESCE(MAX(updated_at), '') AS latest FROM projects
  `);
  findVersionStatement = database.prepare("SELECT updated_at FROM projects WHERE id=?");
  list() {
    return this.listStatement.all();
  }
  find(id) {
    return this.findStatement.get(id);
  }
  listVersion() {
    const row = this.listVersionStatement.get();
    return `${row.count}:${row.latest}`;
  }
  // 项目自身的 updated_at 已经在每次节点增删改时被 touch(),
  // 所以它同时就是"该项目 + 其节点树"的版本标记,树轮询直接复用它即可。
  findVersion(id) {
    const row = this.findVersionStatement.get(id);
    return row?.updated_at;
  }
  insert(project) {
    this.insertStatement.run(project.id, project.title, project.prompt);
  }
  delete(id) {
    this.deleteStatement.run(id);
  }
  touch(id) {
    this.touchStatement.run(id);
  }
  touchAll() {
    this.touchAllStatement.run();
  }
  rename(id, title, expected) {
    const result = expected ? this.renameVersionedStatement.run(title, id, expected) : this.renameStatement.run(title, id);
    return Number(result.changes);
  }
};

// src/server/projects/project.routes.ts
function registerProjectRoutes(router, service) {
  router.get("/api/projects", ({ res }) => {
    sendJson(res, 200, service.list());
  });
  router.get("/api/projects/version", ({ res }) => {
    sendJson(res, 200, { version: service.version() });
  });
  router.post("/api/projects", async ({ req, res }) => {
    sendJson(res, 200, service.create(await readJsonBody(req)));
  });
  router.put("/api/projects/:projectId", async ({ req, res, params }) => {
    sendJson(res, 200, service.rename(params.projectId, await readJsonBody(req)));
  });
  router.delete("/api/projects/:projectId", ({ res, params }) => {
    sendJson(res, 200, service.delete(params.projectId));
  });
  router.get("/api/projects/:projectId/tree", ({ res, params }) => {
    sendJson(res, 200, service.tree(params.projectId));
  });
  router.get("/api/projects/:projectId/version", ({ res, params }) => {
    sendJson(res, 200, { version: service.treeVersion(params.projectId) });
  });
}

// src/server/projects/project.service.ts
var ProjectService = class {
  constructor(projects, nodes, artifacts) {
    this.projects = projects;
    this.nodes = nodes;
    this.artifacts = artifacts;
  }
  projects;
  nodes;
  artifacts;
  list() {
    return this.projects.list();
  }
  create(input) {
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!prompt) throw new HttpError(400, "prompt is required", "PROMPT_REQUIRED");
    const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : prompt.slice(0, 20);
    const projectId = createId();
    const rootId = createId();
    const count = input.count === void 0 ? 0 : Number(input.count);
    if (!Number.isInteger(count) || count < 0 || count > 5) {
      throw new HttpError(400, "count must be an integer between 0 and 5", "INVALID_COUNT");
    }
    const nodeIds = Array.from({ length: count }, () => createId());
    transaction(() => {
      this.projects.insert({ id: projectId, title, prompt });
      this.nodes.insertRoot(rootId, projectId, prompt);
      nodeIds.forEach((id, position) => {
        this.nodes.insert({
          id,
          projectId,
          parentId: rootId,
          position,
          type: "html",
          title: `\u65B9\u6848 ${position + 1}\uFF08\u751F\u6210\u4E2D\uFF09`,
          content: null
        });
      });
    });
    return { ...this.requireProject(projectId), rootId, nodeIds };
  }
  rename(projectId, input) {
    this.requireProject(projectId);
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title) throw new HttpError(400, "title is required", "TITLE_REQUIRED");
    const expected = typeof input.expectedUpdatedAt === "string" ? input.expectedUpdatedAt : void 0;
    if (!this.projects.rename(projectId, title, expected)) {
      throw new HttpError(409, "project changed since it was read", "VERSION_CONFLICT");
    }
    return this.requireProject(projectId);
  }
  delete(projectId) {
    const artifacts = this.nodes.listProject(projectId).map((node) => isArtifactType(node.type) ? node.content : null);
    transaction(() => {
      this.nodes.deleteProjectNodes(projectId);
      this.projects.delete(projectId);
    });
    this.artifacts.removeMany(artifacts);
    return { ok: true };
  }
  tree(projectId) {
    const nodes = this.nodes.listTree(projectId).map((node) => ({
      ...node,
      artifact_revision: this.artifacts.revision(isArtifactType(node.type) ? node.content : null)
    }));
    return {
      project: this.requireProject(projectId),
      nodes
    };
  }
  version() {
    return this.projects.listVersion();
  }
  treeVersion(projectId) {
    const version = this.projects.findVersion(projectId);
    if (version === void 0) throw new HttpError(404, "project not found", "PROJECT_NOT_FOUND");
    return version;
  }
  requireProject(projectId) {
    const project = this.projects.find(projectId);
    if (!project) throw new HttpError(404, "project not found", "PROJECT_NOT_FOUND");
    return project;
  }
};

// src/server/change-watcher.ts
import { mkdirSync as mkdirSync2, statSync, watch } from "node:fs";
import { join as join4 } from "node:path";
var started = false;
var timers = /* @__PURE__ */ new Map();
var watchers = [];
function debounce(key, operation) {
  const existing = timers.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    timers.delete(key);
    operation();
  }, 80);
  timer.unref();
  timers.set(key, timer);
}
function databaseFingerprint() {
  return ["ramify.db", "ramify.db-wal"].map((name) => {
    try {
      const stat = statSync(join4(dataDirectory, name));
      return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    } catch {
      return "missing";
    }
  }).join("|");
}
function startChangeWatcher() {
  if (started) return;
  started = true;
  const artifactsDirectory = join4(dataDirectory, "artifacts");
  mkdirSync2(artifactsDirectory, { recursive: true });
  const projects = new ProjectRepository();
  let databaseRevision = databaseFingerprint();
  const resyncDatabaseRevision = () => {
    databaseRevision = databaseFingerprint();
  };
  setInterval(() => {
    const nextRevision = databaseFingerprint();
    if (nextRevision === databaseRevision) return;
    databaseRevision = nextRevision;
    debounce("database", () => {
      projects.touchAll();
      resyncDatabaseRevision();
    });
  }, 250).unref();
  watchers.push(watch(artifactsDirectory, { persistent: false, recursive: true }, (_event, filename) => {
    const projectId = filename ? String(filename).split(/[\\/]/)[0] : "";
    debounce(`artifact:${projectId}`, () => {
      if (projectId) projects.touch(projectId);
      else projects.touchAll();
      resyncDatabaseRevision();
    });
  }));
}

// src/server/artifacts/artifact.store.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync as mkdirSync3, openSync, readFileSync as readFileSync2, renameSync, rmSync, statSync as statSync2, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname as dirname2, extname as extname2, join as join5, resolve, sep } from "node:path";
var TEXT_FORMATS = {
  html: { extension: "html", mime: "text/html; charset=utf-8" },
  markdown: { extension: "md", mime: "text/markdown; charset=utf-8" },
  svg: { extension: "svg", mime: "image/svg+xml" }
};
var MEDIA_EXTENSIONS = {
  "image/avif": "avif",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/ogg": "ogv",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/webm": "webm"
};
var EXTENSION_MIMES = Object.fromEntries(
  Object.entries(MEDIA_EXTENSIONS).map(([mime, extension]) => [extension, mime])
);
function decodeDataUri(value, type) {
  const match = /^data:([^;,]+)(;base64)?,([\s\S]*)$/i.exec(value.trim());
  if (!match || !match[1].toLowerCase().startsWith(`${type}/`)) {
    throw new HttpError(400, `invalid ${type} data URI`, "INVALID_MEDIA_SOURCE");
  }
  const mime = match[1].toLowerCase();
  let data;
  try {
    data = match[2] ? Buffer.from(match[3].replace(/\s/g, ""), "base64") : Buffer.from(decodeURIComponent(match[3]), "utf8");
  } catch {
    throw new HttpError(400, `invalid ${type} data URI`, "INVALID_MEDIA_SOURCE");
  }
  if (!data.length) throw new HttpError(400, `empty ${type} data URI`, "INVALID_MEDIA_SOURCE");
  return { data, mime, extension: MEDIA_EXTENSIONS[mime] || "bin" };
}
function encodeSource(data, mime) {
  return `data:${mime};base64,${data.toString("base64")}`;
}
var ArtifactStore = class {
  root = join5(dataDirectory, "artifacts");
  constructor() {
    mkdirSync3(this.root, { recursive: true });
  }
  write(projectId, nodeId, type, content) {
    let data;
    let mime;
    let extension;
    const textFormat = TEXT_FORMATS[type];
    if (textFormat) {
      data = Buffer.from(content, "utf8");
      ({ mime, extension } = textFormat);
    } else if (content.trim().startsWith("data:")) {
      ({ data, mime, extension } = decodeDataUri(content, type));
    } else {
      data = Buffer.from(`${content.trim()}
`, "utf8");
      mime = "text/uri-list; charset=utf-8";
      extension = "url";
    }
    const relativePath = `${projectId}/${nodeId}.${extension}`;
    const absolutePath = this.resolvePath(relativePath);
    mkdirSync3(dirname2(absolutePath), { recursive: true });
    const temporaryPath = `${absolutePath}.tmp-${randomUUID2()}`;
    try {
      writeFileSync(temporaryPath, data, { flag: "wx", mode: 384 });
      const descriptor = openSync(temporaryPath, "r+");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporaryPath, absolutePath);
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw error;
    }
    return relativePath;
  }
  read(path) {
    try {
      return readFileSync2(this.resolvePath(path));
    } catch {
      throw new HttpError(404, "artifact file not found", "ARTIFACT_FILE_NOT_FOUND");
    }
  }
  readText(path) {
    return this.read(path).toString("utf8");
  }
  mime(path, type) {
    if (path.endsWith(".url")) return "text/uri-list; charset=utf-8";
    const textFormat = TEXT_FORMATS[type];
    if (textFormat) return textFormat.mime;
    return EXTENSION_MIMES[this.extension(path)] || "application/octet-stream";
  }
  source(path, type) {
    const mime = this.mime(path, type);
    const data = this.read(path);
    if (mime.startsWith("text/uri-list")) return data.toString("utf8").trim();
    if (mime.startsWith("text/") || mime.startsWith("image/svg+xml")) return data.toString("utf8");
    return encodeSource(data, mime.split(";")[0]);
  }
  remove(path) {
    if (!path) return;
    const absolutePath = this.resolvePath(path);
    try {
      unlinkSync(absolutePath);
    } catch {
    }
    try {
      rmSync(dirname2(absolutePath), { recursive: false });
    } catch {
    }
  }
  removeMany(paths) {
    for (const path of new Set(paths.filter((value) => Boolean(value)))) this.remove(path);
  }
  filename(path) {
    return basename(path);
  }
  extension(path) {
    return extname2(path).slice(1) || "bin";
  }
  revision(path) {
    if (!path) return "";
    try {
      const stat = statSync2(this.resolvePath(path));
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return "missing";
    }
  }
  resolvePath(relativePath) {
    if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.[a-z0-9]+$/.test(relativePath)) {
      throw new HttpError(500, "invalid artifact path", "INVALID_ARTIFACT_PATH");
    }
    const absolutePath = resolve(this.root, ...relativePath.split("/"));
    if (!absolutePath.startsWith(`${resolve(this.root)}${sep}`)) {
      throw new HttpError(500, "invalid artifact path", "INVALID_ARTIFACT_PATH");
    }
    return absolutePath;
  }
};

// src/server/settings/settings.routes.ts
function registerSettingsRoutes(router, store) {
  router.get("/api/settings", ({ res }) => {
    sendJson(res, 200, store.read());
  });
  router.put("/api/settings/theme", async ({ req, res }) => {
    const { theme } = await readJsonBody(req);
    if (!isThemePreference(theme)) {
      throw new HttpError(400, "theme must be light, dark, or system", "INVALID_THEME");
    }
    const settings = store.write({ ...store.read(), theme });
    sendJson(res, 200, settings);
  });
  router.put("/api/settings/locale", async ({ req, res }) => {
    const { locale } = await readJsonBody(req);
    if (!isLocale(locale)) {
      throw new HttpError(400, "locale must be zh-CN, en, ja, es, or de", "INVALID_LOCALE");
    }
    const settings = store.write({ ...store.read(), locale });
    sendJson(res, 200, settings);
  });
}

// src/server/settings/settings.store.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync4, readFileSync as readFileSync3, renameSync as renameSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join6 } from "node:path";
var DEFAULT_SETTINGS = { theme: "system", locale: "zh-CN" };
var SettingsStore = class {
  file;
  constructor(directory = dataDirectory) {
    mkdirSync4(directory, { recursive: true });
    this.file = join6(directory, "settings.json");
  }
  read() {
    if (!existsSync2(this.file)) return { ...DEFAULT_SETTINGS };
    try {
      const value = JSON.parse(readFileSync3(this.file, "utf8"));
      return {
        theme: isThemePreference(value.theme) ? value.theme : DEFAULT_SETTINGS.theme,
        locale: isLocale(value.locale) ? value.locale : DEFAULT_SETTINGS.locale
      };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }
  write(settings) {
    const temporary = `${this.file}.tmp`;
    writeFileSync2(temporary, `${JSON.stringify(settings, null, 2)}
`, "utf8");
    renameSync2(temporary, this.file);
    return settings;
  }
};

// src/server/generation/host-ai.ts
var TIMEOUT_MS = 8 * 60 * 1e3;
var hostAiAvailable = () => Boolean(process.env.HOST_URL) && Boolean(process.env.APP_TOKEN);
async function hostComplete(system, prompt, opts = {}) {
  const hostUrl = (process.env.HOST_URL ?? "").replace(/\/+$/, "");
  const res = await fetch(`${hostUrl}/apps/ai/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.APP_TOKEN ?? ""}` },
    body: JSON.stringify({
      prompt,
      instructions: system,
      // title 进「任务」列表 —— 让用户看得懂这次是替他干什么
      ...opts.title ? { title: opts.title } : {},
      ...opts.schema ? { schema: opts.schema, schemaName: "directions" } : {}
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
  }
  if (!res.ok) throw new Error(String(data?.error || `host complete failed: HTTP ${res.status}`));
  const text = String(data?.text || "");
  if (!text.trim()) throw new Error("host returned empty completion");
  return text;
}

// src/server/generation/prompts.ts
var CARD_TYPES = ["html", "markdown", "svg"];
var LANGUAGE_RULE = "Language: write every visible word in the same language as the user brief. If the brief names a target audience, market or language, follow that instead. Never mix languages within one piece of work.";
var SHARED_RULES = "Output the work itself only \u2014 no JSON, no markdown code fences, no explanation, no preamble. Never propose a backend, database, API, account login, payment, multi-page routing or anything needing a server: this tool produces self-contained single-file work only. " + LANGUAGE_RULE + " Content must be substantive and believable, and the presentation refined.";
var GENERATOR_SYSTEMS = {
  html: "You are a senior designer and front-end engineer. Produce one self-contained HTML document: CSS and JS inlined, no external resources at all (no external fonts, images, scripts or stylesheets). Render imagery with inline SVG, CSS gradients and shapes, or emoji. Never link to external images or placeholder services, and never leave an empty or externally-pointing <img>. Output a complete document starting with <!DOCTYPE html> and ending with </html>. " + SHARED_RULES,
  markdown: "You are a senior writer and information architect. Produce one complete, well-structured Markdown document. Use heading levels, lists, tables, quotes and code blocks to organise the content. It must be substantive and immediately usable \u2014 no placeholders. Do not embed HTML tags and do not link to external images. Output plain Markdown text directly. " + SHARED_RULES,
  svg: "You are a senior illustrator and visual designer. Produce one self-contained SVG work: it must carry a viewBox, keep all styling inline, and use no external resources, no <script> and no bitmaps. Composition complete, detail rich, palette considered; render text with <text>. Output a complete <svg>\u2026</svg>. " + SHARED_RULES
};
var generatorSystem = (type) => GENERATOR_SYSTEMS[type] || GENERATOR_SYSTEMS.html;
var PLAN_SYSTEM = "You are a senior creative director. Understand what the user actually wants, then split it into executable creative directions. Each direction has a short title, an output type, and an idea \u2014 a concrete direction for the downstream creator. Keep title and idea separate. " + LANGUAGE_RULE + " Both title and idea follow that same language.\nEach direction picks one output type: html = pages, posters, interfaces, interactive demos; markdown = documents, articles, proposals, reading-first content; svg = logos, icons, illustrations, pure vector work. When the intent is clear, give every direction the same type; mix types only when the user explicitly wants to compare formats. This tool does not produce bitmap photographs: express photo-like intent through svg or html.\nWhatever the user already made explicit \u2014 subject, content, aesthetic leaning, audience \u2014 is evidence; never change what the user cares about just to manufacture variety. The more specific the brief, the more restrained the differences between directions; only when the brief is open, or the user explicitly asks to diverge, should the directions pull apart on style, structure and mood.\nEvery idea must describe in natural language how this version should be made and how it differs from the others, directly executable by the downstream creator.";
var TYPE_TASK = {
  html: "produce one complete single-file HTML page",
  markdown: "write one complete Markdown document",
  svg: "produce one complete SVG work"
};
var rootPrompt = (idea, type) => `Following this creative direction, ${TYPE_TASK[type] || TYPE_TASK.html}:

${idea}`;
var branchPrompt = (parentType, parentContent, type, idea) => `This is the complete previous version (type: ${parentType}):

${parentContent}

Building on it, ${TYPE_TASK[type] || TYPE_TASK.html} following the direction below. The direction decides whether this is a large rework or a small adjustment:
${idea}`;
function planPrompt(params) {
  if (params.kind === "root") {
    return `User brief:
${params.prompt}

Plan ${params.count} creative directions that match the user's real intent and are distinguishable from each other, and pick an output type (html/markdown/svg) for each. The more specific the brief, the more restrained the differences. Do not manufacture difference mechanically. Every direction produces one complete piece of work.`;
  }
  const context = params.parentContent ? `Previous version (type: ${params.parentType || "html"}):
${params.parentContent}` : "No previous content.";
  return `${context}

User instruction for this round:
${params.prompt}

Plan ${params.count} downstream directions that satisfy this instruction, and pick an output type (html/markdown/svg) for each. Keep the previous version's type unless the user explicitly asks to change format. For a specific fix, let the versions differ only in detail, pacing or emphasis; for exploration, pull them clearly apart. Do not manufacture difference mechanically.`;
}
var stripFence = (text) => {
  const m2 = String(text || "").trim().match(/^```[a-z]*\s*\n([\s\S]*?)\n?```$/i);
  return m2 ? m2[1].trim() : String(text || "").trim();
};
function normalizeContent(text, type) {
  const content = type === "markdown" ? String(text || "").trim() : stripFence(text);
  if (!content) throw new Error("missing_content");
  return content;
}
function contentError(type, content) {
  const value = String(content || "").trim();
  if (!value) return "missing_content";
  if (type === "html" && !(/<html[\s>]/i.test(value) && /<\/html>\s*$/i.test(value))) return "invalid_html_output";
  if (type === "svg" && (!/<svg[\s>]/i.test(value) || /<script[\s>]/i.test(value))) return "invalid_svg_output";
  return "";
}
var DIRECTIONS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["directions"],
  properties: {
    directions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "type", "idea"],
        properties: {
          title: { type: "string" },
          type: { type: "string", enum: ["html", "markdown", "svg"] },
          idea: { type: "string" }
        }
      }
    }
  }
};
var asType = (value) => CARD_TYPES.includes(String(value || "").trim().toLowerCase()) ? String(value).trim().toLowerCase() : "html";
function parseDirections(text, count) {
  let json;
  try {
    json = JSON.parse(stripFence(text));
  } catch {
    throw new Error("plan_not_json");
  }
  const raw = Array.isArray(json?.directions) ? json.directions : [];
  const directions = raw.map((item) => ({ title: String(item?.title || "").trim(), type: asType(item?.type), idea: String(item?.idea || "").trim() })).filter((d2) => d2.title && d2.idea);
  if (!directions.length) throw new Error("missing_directions");
  return directions.slice(0, count);
}

// src/server/generation/run.ts
var MAX_PARENT_CHARS = 14e4;
var CONCURRENCY = 3;
async function generateOne(nodes, nodeService, nodeId, direction, job) {
  try {
    const type = direction.type;
    const prompt = job.kind === "branch" && job.parent ? branchPrompt(job.parent.type, job.parent.content.slice(0, MAX_PARENT_CHARS), type, direction.idea) : rootPrompt(direction.idea, type);
    const raw = await hostComplete(generatorSystem(type), prompt, { title: `\u751F\u6210\u300C${direction.title}\u300D` });
    const content = normalizeContent(raw, type);
    const invalid = contentError(type, content);
    if (invalid) throw new Error(invalid);
    nodeService.updateArtifact(nodeId, { artifactType: type, artifact: content });
    nodeService.update(nodeId, { title: direction.title });
  } catch (error) {
    markFailed(nodes, nodeService, nodeId, error instanceof Error ? error.message : String(error));
  }
}
function markFailed(nodes, nodeService, nodeId, message) {
  const node = nodes.find(nodeId);
  if (!node || !isArtifactType(node.type) || node.content) return;
  try {
    nodeService.markArtifactError(nodeId, { error: `\u751F\u6210\u5931\u8D25\uFF1A${message}` });
  } catch (error) {
    console.error("[generation]", "failed to mark node as failed", nodeId, error);
  }
}
function dispatchGeneration(nodes, nodeService, job) {
  void (async () => {
    let directions;
    try {
      const plan = await hostComplete(PLAN_SYSTEM, planPrompt({
        kind: job.kind,
        count: job.count,
        prompt: job.prompt,
        parentType: job.parent?.type,
        parentContent: job.parent?.content.slice(0, MAX_PARENT_CHARS)
      }), { schema: DIRECTIONS_SCHEMA, title: `\u89C4\u5212 ${job.count} \u4E2A\u65B9\u5411:${job.prompt.slice(0, 20)}` });
      directions = parseDirections(plan, job.count);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const nodeId of job.nodeIds) markFailed(nodes, nodeService, nodeId, `\u65B9\u5411\u89C4\u5212\u5931\u8D25\uFF1A${message}`);
      return;
    }
    const assigned = job.nodeIds.map((nodeId, i) => ({ nodeId, direction: directions[i] || directions[directions.length - 1] }));
    for (let i = 0; i < assigned.length; i += CONCURRENCY) {
      await Promise.all(assigned.slice(i, i + CONCURRENCY).map(({ nodeId, direction }) => generateOne(nodes, nodeService, nodeId, direction, job)));
    }
  })();
}

// src/server/generation/generation.routes.ts
var UNAVAILABLE_MESSAGE = "\u751F\u6210\u9700\u8981\u5728\u5951\u7EA6\u5BBF\u4E3B\u91CC\u8FD0\u884C\uFF08\u672A\u914D\u7F6E HOST_URL / APP_TOKEN\uFF09";
function requireHostAi() {
  if (!hostAiAvailable()) throw new HttpError(501, UNAVAILABLE_MESSAGE, "HOST_AI_UNAVAILABLE");
}
function parsePrompt(value) {
  const prompt = typeof value === "string" ? value.trim() : "";
  if (!prompt) throw new HttpError(400, "prompt required", "PROMPT_REQUIRED");
  return prompt;
}
function parseCount(value) {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 5) {
    throw new HttpError(400, "count must be an integer between 1 and 5", "INVALID_COUNT");
  }
  return Number(value);
}
function parseNodeIds(value, count) {
  if (!Array.isArray(value) || value.length !== count || !value.every((id) => typeof id === "string" && id)) {
    throw new HttpError(400, "nodeIds must be an array of ids matching count", "INVALID_NODE_IDS");
  }
  return value;
}
function registerGenerationRoutes(router, projects, nodes, nodeService) {
  router.post("/api/projects/:projectId/generate", async ({ req, res, params }) => {
    requireHostAi();
    const project = projects.find(params.projectId);
    if (!project) throw new HttpError(404, "project not found", "PROJECT_NOT_FOUND");
    const body = await readJsonBody(req);
    const prompt = parsePrompt(body.prompt);
    const count = parseCount(body.count);
    const nodeIds = parseNodeIds(body.nodeIds, count);
    for (const nodeId of nodeIds) {
      if (!nodes.findInProject(nodeId, params.projectId)) throw new HttpError(404, `node ${nodeId} not found in project`, "NODE_NOT_FOUND");
    }
    dispatchGeneration(nodes, nodeService, { kind: "root", prompt, count, nodeIds });
    sendJson(res, 202, { accepted: true, nodeIds });
  });
  router.post("/api/nodes/:nodeId/branch", async ({ req, res, params }) => {
    requireHostAi();
    const parent = nodes.find(params.nodeId);
    if (!parent) throw new HttpError(404, "node not found", "NODE_NOT_FOUND");
    const body = await readJsonBody(req);
    const prompt = parsePrompt(body.prompt);
    const count = parseCount(body.count);
    const nodeIds = parseNodeIds(body.nodeIds, count);
    for (const nodeId of nodeIds) {
      if (!nodes.findInProject(nodeId, parent.project_id)) throw new HttpError(404, `node ${nodeId} not found in project`, "NODE_NOT_FOUND");
    }
    let parentContent = "";
    try {
      parentContent = String(nodeService.artifactSource(parent.id)?.source ?? "");
    } catch {
      parentContent = String(parent.content || "");
    }
    dispatchGeneration(nodes, nodeService, {
      kind: "branch",
      prompt,
      count,
      nodeIds,
      parent: { type: parent.type, content: parentContent }
    });
    sendJson(res, 202, { accepted: true, nodeIds });
  });
}

// src/server/app.ts
function createRequestHandler() {
  const projects = new ProjectRepository();
  const nodes = new NodeRepository();
  const artifacts = new ArtifactStore();
  const settings = new SettingsStore();
  const nodeService = new NodeService(nodes, projects, artifacts);
  const router = new Router();
  startChangeWatcher();
  router.get("/api/health", ({ res }) => sendJson(res, 200, {
    service: "ramify",
    version: process.env.RAMIFY_VERSION || "development",
    pid: process.pid,
    instanceId: process.env.RAMIFY_INSTANCE_ID || null,
    capabilities: [
      "batch-nodes",
      "optimistic-concurrency",
      "server-seq",
      "direct-sql",
      "direct-artifacts",
      "external-change-events",
      "theme-settings",
      "locale-settings",
      ...hostAiAvailable() ? ["ai-generate"] : []
    ]
  }));
  registerSettingsRoutes(router, settings);
  registerProjectRoutes(router, new ProjectService(projects, nodes, artifacts));
  registerNodeRoutes(router, nodeService);
  registerGenerationRoutes(router, projects, nodes, nodeService);
  return async function handleRequest(req, res) {
    const path = new URL(req.url || "/", "http://localhost").pathname;
    try {
      if (path.startsWith("/api/")) {
        if (!await router.handle(req, res, path)) sendJson(res, 404, { error: "not found", code: "ROUTE_NOT_FOUND" });
        return;
      }
      serveStatic(res, path);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error("[server]", error);
      if (!res.headersSent) sendJson(res, status, {
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof HttpError ? error.code : "INTERNAL_ERROR"
      });
    }
  };
}

// src/server/db/schema.ts
function initializeSchema() {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      parent_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      type TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text', 'html', 'markdown', 'svg', 'image', 'video', 'audio', 'error')),
      title TEXT NOT NULL,
      content TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (type IS NOT 'error' OR content IS NOT NULL)
    );

    CREATE INDEX IF NOT EXISTS idx_nodes_project ON nodes(project_id, parent_id, position);
    CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id, position);
  `);
}

// src/server/index.ts
var PORT = Number(process.env.PORT) || 9519;
var HOST = process.env.HOST || "127.0.0.1";
initializeSchema();
var server = createServer(createRequestHandler());
server.listen(PORT, HOST, () => {
  console.log(`[ramify-skill] canvas on http://${HOST}:${PORT}`);
});
var shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const forceExit = setTimeout(() => process.exit(0), 3e3);
  forceExit.unref();
  server.close(() => {
    try {
      database.close();
    } catch {
    }
    process.exit(0);
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
