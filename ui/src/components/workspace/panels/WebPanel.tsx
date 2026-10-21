// 网页标签:一个 <iframe>。
//
// 形态的窗口由 launcher 开,没有 Electron 的 <webview>(也拿不到用户浏览器的登录态);这里能做的是把网页嵌进来,
// 嵌不进来的(多数大站禁 iframe)给一个诚实的兜底,一键去系统浏览器开。
// AI 要操作网页走 browser 工具 → launcher → 浏览器插件,和这个面板无关。
// 面板由 WorkspaceGroup 常驻挂载、CSS 控显隐 —— 卸载 = 重载。
import { type HistoryEntry, browserApi } from "../../../api/browser";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, Globe, History, RotateCw, Star, Trash } from "../../ui/icons";
import type { WorkspaceGroupId, WebTab } from "../types";
import { displayUrl, hostKey, normalizeUrl } from "../../../lib/urls";
import { showToast } from "../../ui/Toast";
import { toNavigableUrl } from "../../../lib/search";

type Socket = {
  send: (m: any) => void;
  on: (t: string, fn: (p: any) => void) => () => void;
};

export function WebPanel({ tab, socket, onUpdate, onFocus, groupId }: {
  tab: WebTab;
  socket: Socket;
  /** 必须是恒定引用(useCallback)。 */
  onUpdate: (id: string, patch: Partial<Pick<WebTab, "title" | "url" | "favicon">>) => void;
  /** 网页拿到焦点(用户在页面里点了)→ 激活它所在的半区。 */
  onFocus?: (groupId: WorkspaceGroupId) => void;
  groupId?: WorkspaceGroupId;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // 平时展示人话形(藏 https:// 和尾斜杠),点进编辑时换完整 URL
  const [address, setAddress] = useState(displayUrl(tab.url));
  const editing = useRef(false);
  // iframe 的 src:只在导航时改。跨源页面的内部跳转我们看不到,地址栏停在我们最后导航到的地址上。
  const [src, setSrc] = useState(tab.url);
  const [history, setHistory] = useState<string[]>([tab.url]);
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState(false);
  const [starred, setStarred] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyRows, setHistoryRows] = useState<HistoryEntry[]>([]);

  const navigate = (url: string, pushHistory = true) => {
    setBlocked(false);
    setLoading(true);
    setSrc(url);
    editing.current = false;
    setAddress(displayUrl(url));
    onUpdate(tab.id, { url, title: url.replace(/^https?:\/\//, "").replace(/\/$/, "") });
    void browserApi.noteVisit({ url });
    if (pushHistory) {
      setHistory((h) => [...h.slice(0, cursor + 1), url]);
      setCursor((c) => c + 1);
    }
  };

  const go = (target?: string) => {
    // 地址栏的老规矩:像网址就开,不像就交给设置里选的搜索引擎
    const url = target ? normalizeUrl(target) : toNavigableUrl(address);
    if (!url) return;
    navigate(url);
  };
  const back = () => { if (cursor > 0) { setCursor(cursor - 1); navigate(history[cursor - 1], false); } };
  const forward = () => { if (cursor < history.length - 1) { setCursor(cursor + 1); navigate(history[cursor + 1], false); } };
  const reload = () => { const frame = frameRef.current; if (frame) { setLoading(true); frame.src = src; } };

  // 加载完成 / 被拒:同源之外读不到任何东西,只能靠 load 事件和一个超时猜它有没有画出来。
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let settled = false;
    const onLoad = () => { settled = true; setLoading(false); };
    frame.addEventListener("load", onLoad);
    const timer = setTimeout(() => { if (!settled) { setLoading(false); setBlocked(true); } }, 12_000);
    return () => { frame.removeEventListener("load", onLoad); clearTimeout(timer); };
  }, [src]);

  // 点进 iframe 时宿主 DOM 收不到鼠标事件,靠 window blur + activeElement 判断
  useEffect(() => {
    if (!onFocus || !groupId) return;
    const onBlur = () => { if (document.activeElement === frameRef.current) onFocus(groupId); };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [onFocus, groupId]);

  // 星标状态跟着地址走,也跟着「网站」面板的增删走(在面板里删掉,这里要熄灭)
  useEffect(() => {
    const key = hostKey(tab.url);
    const sync = () => {
      void browserApi.listBookmarks()
        .then((sites) => setStarred(!!key && sites.some((site) => hostKey(site.url) === key)))
        .catch(() => {});
    };
    sync();
    return socket.on("sites_changed", sync);
  }, [socket, tab.url]);

  // 历史面板:开着才拉,关键词变了重拉
  useEffect(() => {
    if (!historyOpen) return;
    let gone = false;
    const timer = setTimeout(() => {
      void browserApi.listHistory(historyQuery).then((rows) => { if (!gone) setHistoryRows(rows); }).catch(() => {});
    }, historyQuery ? 180 : 0);
    return () => { gone = true; clearTimeout(timer); };
  }, [historyOpen, historyQuery]);

  // 去系统浏览器:launcher 的窗口把外链交给系统浏览器
  const openExternal = () => window.open(tab.url, "_blank");

  const toggleSite = () => {
    if (!starred) {
      void browserApi.createBookmark({ url: tab.url, title: tab.title })
        .then(() => { setStarred(true); showToast("已收藏到「网站」面板"); })
        .catch(() => {});
      return;
    }
    const key = hostKey(tab.url);
    void browserApi.listBookmarks()
      .then((sites) => {
        const hit = sites.find((site) => site.kind === "site" && hostKey(site.url) === key);
        return hit ? browserApi.removeBookmark(hit.id) : null;
      })
      .then(() => { setStarred(false); showToast("已从「网站」面板移除"); })
      .catch(() => {});
  };

  const navBtn = "w-7 h-7 rounded flex items-center justify-center text-text-dim hover:text-text hover:bg-bg-hover transition-colors disabled:opacity-30";

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-bg">
      {/* 工具栏:后退 / 前进 / 刷新 / 地址 / 收藏 / 记录 / 系统浏览器 */}
      <div className="shrink-0 flex items-center gap-1 px-2 py-1.5 border-b border-border bg-bg-raised/60">
        <button className={navBtn} title="后退" disabled={cursor === 0} onClick={back}><ArrowLeft size={14} /></button>
        <button className={navBtn} title="前进" disabled={cursor >= history.length - 1} onClick={forward}><ArrowRight size={14} /></button>
        <button className={navBtn} title="刷新" onClick={reload}>
          <RotateCw size={13} className={loading ? "animate-spin" : ""} />
        </button>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onFocus={(e) => {
            editing.current = true;
            setAddress(tab.url);
            const el = e.target as HTMLInputElement;
            requestAnimationFrame(() => el.select());
          }}
          onBlur={() => { editing.current = false; setAddress(displayUrl(tab.url)); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { go(); (e.target as HTMLInputElement).blur(); }
            if (e.key === "Escape") { editing.current = false; setAddress(displayUrl(tab.url)); (e.target as HTMLInputElement).blur(); }
          }}
          spellCheck={false}
          className="flex-1 min-w-0 h-7 px-2.5 rounded-md border border-border bg-surface text-[12.5px] font-mono text-text-dim focus:text-text focus:border-accent outline-none transition-colors"
        />
        <button
          className={starred ? `${navBtn} text-accent hover:text-accent` : navBtn}
          title={starred ? "从「网站」面板移除" : "添加到「网站」面板"}
          onClick={toggleSite}
        >
          <Star size={13} fill={starred ? "currentColor" : "none"} />
        </button>
        <div className="relative">
          <button
            className={historyOpen ? `${navBtn} text-text bg-bg-hover` : navBtn}
            title="浏览记录"
            onClick={(e) => { e.stopPropagation(); setHistoryOpen((open) => !open); setHistoryQuery(""); }}
          >
            <History size={13} />
          </button>
          {historyOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setHistoryOpen(false)} />
              <div className="absolute top-full right-0 mt-1 z-50 w-[360px] rounded-lg border border-border bg-bg-raised shadow-lg overflow-hidden">
                <div className="flex items-center gap-2 px-2.5 py-2 border-b border-border">
                  <input
                    autoFocus
                    value={historyQuery}
                    onChange={(e) => setHistoryQuery(e.target.value)}
                    placeholder="搜索浏览记录…"
                    className="flex-1 min-w-0 h-7 px-2 rounded-md border border-border bg-bg text-[12.5px] text-text placeholder:text-text-faint outline-none focus:border-accent"
                  />
                  {historyRows.length > 0 && (
                    <button
                      className="shrink-0 text-[11.5px] text-text-faint hover:text-danger transition-colors"
                      onClick={() => { void browserApi.forgetHistory({ all: true }).then(() => setHistoryRows([])); }}
                    >
                      清空
                    </button>
                  )}
                </div>
                <div className="max-h-[320px] overflow-y-auto py-1">
                  {historyRows.map((row) => (
                    <div key={row.url} className="group flex items-center gap-2 px-2.5 py-1.5 hover:bg-bg-hover transition-colors">
                      <button className="min-w-0 flex-1 text-left" onClick={() => { setHistoryOpen(false); go(row.url); }}>
                        <div className="truncate text-[12.5px] text-text">{row.title || row.url}</div>
                        <div className="truncate text-[11px] text-text-faint">{displayUrl(row.url)}</div>
                      </button>
                      <button
                        title="从记录中删除"
                        className="shrink-0 w-5 h-5 rounded flex items-center justify-center text-text-faint opacity-0 group-hover:opacity-100 hover:text-danger transition-all"
                        onClick={() => {
                          void browserApi.forgetHistory({ url: row.url })
                            .then(() => setHistoryRows((rows) => rows.filter((r) => r.url !== row.url)));
                        }}
                      >
                        <Trash size={11} />
                      </button>
                    </div>
                  ))}
                  {!historyRows.length && (
                    <div className="px-3 py-6 text-center text-[12px] text-text-faint">
                      {historyQuery ? "没有匹配的记录" : "还没有浏览记录"}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
        <button className={navBtn} title="用系统浏览器打开" onClick={openExternal}><ExternalLink size={13} /></button>
      </div>

      <div className="flex-1 min-h-0 relative">
        <iframe
          ref={frameRef}
          src={src}
          title={tab.title}
          referrerPolicy="no-referrer-when-downgrade"
          allow="clipboard-read; clipboard-write; fullscreen"
          className="absolute inset-0 w-full h-full border-0 bg-white"
        />
        {blocked && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-bg px-6 text-center">
            <Globe size={28} className="text-text-faint" />
            <div className="text-[14px] text-text">这个网站不让嵌在别的页面里</div>
            <div className="text-[12px] text-text-faint max-w-md truncate font-mono">{tab.url}</div>
            <button
              onClick={openExternal}
              className="mt-1 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-accent text-white text-[13px] hover:opacity-90 transition-opacity"
            >
              <ExternalLink size={13} /> 在浏览器打开
            </button>
            <button onClick={() => setBlocked(false)} className="text-[12px] text-text-faint hover:text-text">其实已经显示出来了,关掉这个提示</button>
          </div>
        )}
      </div>
    </div>
  );
}
