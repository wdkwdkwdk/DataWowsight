"use client";

import dynamic from "next/dynamic";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, FileJson2, FileSpreadsheet, ScrollText, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Connection = {
  id: string;
  name: string;
  kind: string;
  createdAt: string;
};

type Conversation = {
  id: string;
  datasourceId: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
};

type DeleteTarget =
  | { type: "connection"; id: string; name: string }
  | { type: "conversation"; id: string; name: string };

type SqlTrace = {
  title: string;
  sql: string;
  rationale?: string;
  status?: "ok" | "blocked" | "error";
  reason?: string;
  durationMs?: number;
  rowCount?: number;
};

type Report = {
  summary: string;
  keyEvidence: Array<{ label: string; value: string }>;
  analysisMethod: string;
  chartSuggestion?: string;
  chart?: InsightChart;
  resultTable?: {
    title: string;
    columns: string[];
    rows: Array<Record<string, unknown>>;
  };
  sqlTraces: SqlTrace[];
  debugLogs?: DebugLog[];
};

type DebugLog = {
  ts: string;
  kind: "llm_request" | "llm_response" | "sql_started" | "sql_result" | "sql_blocked" | "sql_error" | "system";
  title: string;
  detail?: string;
  payload?: string;
};

type InsightChart = {
  type: "line" | "bar" | "pie";
  title: string;
  xKey?: string;
  yKeys?: string[];
  labelKey?: string;
  valueKey?: string;
  data: Array<Record<string, unknown>>;
};

type LlmConfig = {
  provider: string;
  defaultModel: string;
  selectableModels: string[];
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  metaJson?: {
    report?: Report;
    live?: {
      currentStatus: string;
      sqlTraces: SqlTrace[];
      evidence: Array<{ label: string; value: string }>;
    };
  };
};

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });
const APP_VERSION = "v1.0.31";
const MODEL_STORAGE_KEY = "dw:selected-llm-model";

export default function Home() {
  const [mounted, setMounted] = useState(false);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [pageView, setPageView] = useState<"home" | "chat">("home");

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const [composer, setComposer] = useState("");
  const [globalLoading, setGlobalLoading] = useState(false);
  const [runStatus, setRunStatus] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [authLoading, setAuthLoading] = useState(true);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [accessPassword, setAccessPassword] = useState("");
  const [authError, setAuthError] = useState("");

  const [showAddDb, setShowAddDb] = useState(false);
  const [dbName, setDbName] = useState("");
  const [dbUri, setDbUri] = useState("");
  const [dbConnMode, setDbConnMode] = useState<"url" | "params">("url");
  const [dbParamKind, setDbParamKind] = useState<"postgres" | "mysql">("postgres");
  const [dbParamHost, setDbParamHost] = useState("");
  const [dbParamPort, setDbParamPort] = useState("");
  const [dbParamDatabase, setDbParamDatabase] = useState("");
  const [dbParamUser, setDbParamUser] = useState("");
  const [dbParamPassword, setDbParamPassword] = useState("");
  const [dbParamSsl, setDbParamSsl] = useState(true);
  const [dbCreateStatus, setDbCreateStatus] = useState("");
  const [dbScanPercent, setDbScanPercent] = useState<number | null>(null);
  const [dbScanStage, setDbScanStage] = useState("");
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [datasourceNote, setDatasourceNote] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteStatus, setNoteStatus] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [showConnectionActions, setShowConnectionActions] = useState(false);
  const [llmConfig, setLlmConfig] = useState<LlmConfig | null>(null);
  const [selectedLlmModel, setSelectedLlmModel] = useState("");
  const [showRename, setShowRename] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [openExportForMessageId, setOpenExportForMessageId] = useState<string | null>(null);
  const [logViewer, setLogViewer] = useState<{ messageId: string; logs: DebugLog[] } | null>(null);

  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const sseRef = useRef<EventSource | null>(null);
  const actionMenuRef = useRef<HTMLDivElement | null>(null);
  const suppressAutoLoadConversationIdRef = useRef<string | null>(null);
  const optimisticConversationIdRef = useRef<string | null>(null);
  const loadMessagesReqIdRef = useRef(0);

  const selectedConnection = useMemo(
    () => connections.find((c) => c.id === selectedConnectionId),
    [connections, selectedConnectionId],
  );
  const llmModelOptions = useMemo(() => {
    const fromConfig = llmConfig?.selectableModels ?? [];
    if (fromConfig.length > 0) return fromConfig;
    if (selectedLlmModel) return [selectedLlmModel];
    return [];
  }, [llmConfig, selectedLlmModel]);
  const authReady = !authLoading && (!authEnabled || authenticated);

  const loadConnections = useCallback(async () => {
    setConnectionsLoading(true);
    try {
      const res = await fetch("/api/connections");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Load connections failed");

      const list = (data.connections ?? []) as Connection[];
      setConnections(list);
      if (selectedConnectionId && !list.some((item) => item.id === selectedConnectionId)) {
        setSelectedConnectionId("");
        setPageView("home");
      }
    } finally {
      setConnectionsLoading(false);
    }
  }, [selectedConnectionId]);

  const loadConversations = useCallback(async (datasourceId: string) => {
    const res = await fetch(`/api/conversations?datasourceId=${encodeURIComponent(datasourceId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Load conversations failed");

    const list = (data.conversations ?? []) as Conversation[];
    setConversations(list);
    if (list.length === 0) {
      setSelectedConversationId("");
      setMessages([]);
      return;
    }

    const exists = list.some((c) => c.id === selectedConversationId);
    if (!exists) {
      setSelectedConversationId(list[0].id);
    }
  }, [selectedConversationId]);

  const loadMessages = useCallback(async (conversationId: string, options?: { force?: boolean }) => {
    const reqId = ++loadMessagesReqIdRef.current;
    const res = await fetch(`/api/conversations/${conversationId}/messages`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Load messages failed");
    if (reqId !== loadMessagesReqIdRef.current) return;
    if (!options?.force && optimisticConversationIdRef.current === conversationId) return;
    setMessages((data.messages ?? []) as ChatMessage[]);
  }, []);

  const loadLlmConfig = useCallback(async () => {
    const res = await fetch("/api/llm/config", { cache: "no-store" });
    const data = (await res.json()) as LlmConfig & { error?: string };
    if (!res.ok) throw new Error(data.error || "加载模型配置失败");
    const options = Array.isArray(data.selectableModels) ? data.selectableModels.filter(Boolean) : [];
    const fallbackModel = data.defaultModel || options[0] || "";
    const stored = typeof window !== "undefined" ? window.localStorage.getItem(MODEL_STORAGE_KEY)?.trim() : "";
    const resolved =
      stored && (options.includes(stored) || stored === fallbackModel)
        ? stored
        : fallbackModel;
    setLlmConfig({
      provider: data.provider || "mock",
      defaultModel: fallbackModel,
      selectableModels: options.length ? options : [fallbackModel],
    });
    setSelectedLlmModel(resolved);
    if (typeof window !== "undefined" && resolved) {
      window.localStorage.setItem(MODEL_STORAGE_KEY, resolved);
    }
  }, []);

  useEffect(() => {
    setMounted(true);
    console.info(`[DataWowsight] ${APP_VERSION}`);
  }, []);

  useEffect(() => {
    if (!authReady) return;
    void loadConnections();
    void loadLlmConfig();
    return () => {
      sseRef.current?.close();
    };
  }, [authReady, loadConnections, loadLlmConfig]);

  const refreshAuthStatus = useCallback(async () => {
    const res = await fetch("/api/auth/status", { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Auth status failed");
    setAuthEnabled(Boolean(data.enabled));
    setAuthenticated(Boolean(data.authenticated));
  }, []);

  useEffect(() => {
    void (async () => {
      setAuthLoading(true);
      try {
        await refreshAuthStatus();
      } catch {
        setAuthEnabled(false);
        setAuthenticated(true);
      } finally {
        setAuthLoading(false);
      }
    })();
  }, [refreshAuthStatus]);

  useEffect(() => {
    if (!selectedConnectionId) return;
    void loadConversations(selectedConnectionId);
  }, [loadConversations, selectedConnectionId]);

  useEffect(() => {
    if (!selectedConnectionId) {
      setDatasourceNote("");
      setNoteDraft("");
      return;
    }
    void loadDatasourceNote(selectedConnectionId);
  }, [selectedConnectionId]);

  useEffect(() => {
    if (!selectedConversationId) {
      setMessages([]);
      return;
    }
    if (suppressAutoLoadConversationIdRef.current === selectedConversationId) {
      suppressAutoLoadConversationIdRef.current = null;
      return;
    }
    void loadMessages(selectedConversationId);
  }, [loadMessages, selectedConversationId]);

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages]);

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (actionMenuRef.current && !actionMenuRef.current.contains(target)) {
        setShowConnectionActions(false);
      }
      const exportEl = target instanceof Element ? target.closest(".export-menu") : null;
      if (!exportEl) {
        setOpenExportForMessageId(null);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  async function createConversation(title?: string, options?: { autoSelect?: boolean; syncList?: boolean }) {
    if (!selectedConnectionId) throw new Error("请先选择数据库");
    const autoSelect = options?.autoSelect ?? true;
    const syncList = options?.syncList ?? true;

    const res = await fetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ datasourceId: selectedConnectionId, title }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Create conversation failed");

    const created = data.conversation as Conversation | undefined;
    if (created?.id) {
      setConversations((prev) => {
        const exists = prev.some((c) => c.id === created.id);
        if (exists) return prev;
        return [created, ...prev];
      });
    }

    if (created?.id && autoSelect) {
      setSelectedConversationId(created.id);
      setMessages([]);
      setMobileSidebarOpen(false);
    }

    if (syncList) {
      void loadConversations(selectedConnectionId);
    }
    return created?.id as string;
  }

  async function handleCreateConversation() {
    if (!selectedConnectionId || creatingConversation) return;
    setCreatingConversation(true);
    setStatusMessage("正在创建新会话...");
    setSelectedConversationId("");
    setMessages([]);
    setRunStatus("");
    setMobileSidebarOpen(false);
    try {
      await createConversation(undefined, { autoSelect: true, syncList: true });
      setStatusMessage("");
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "创建会话失败");
    } finally {
      setCreatingConversation(false);
    }
  }

  async function handleCreateDb(e: FormEvent) {
    e.preventDefault();
    setGlobalLoading(true);
    setDbCreateStatus("正在创建连接并校验权限...");
    setDbScanPercent(null);
    setDbScanStage("");
    setStatusMessage("");
    let scanTimer: ReturnType<typeof setInterval> | null = null;
    const scanStartAt = Date.now();

    try {
      const connectionUri = buildConnectionUri({
        mode: dbConnMode,
        uri: dbUri,
        kind: dbParamKind,
        host: dbParamHost,
        port: dbParamPort,
        database: dbParamDatabase,
        user: dbParamUser,
        password: dbParamPassword,
        ssl: dbParamSsl,
      });

      const res = await fetch("/api/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: dbName, uri: connectionUri }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Create connection failed");

      const newConnectionId = data.datasource.id as string;
      setDbCreateStatus("连接成功，正在自动扫描结构...");
      const tickScanProgress = () => {
        const progress = estimateScanProgress(Date.now() - scanStartAt);
        setDbScanPercent(progress.percent);
        setDbScanStage(progress.stage);
        setDbCreateStatus(`正在扫描结构 ${progress.percent}% · ${progress.stage}`);
      };
      tickScanProgress();
      scanTimer = setInterval(tickScanProgress, 700);
      const introspectRes = await fetch(`/api/connections/${newConnectionId}/introspect?full=1`, { method: "POST" });
      const introspectData = await introspectRes.json();
      if (!introspectRes.ok) throw new Error(introspectData.error || "Schema introspection failed");
      if (scanTimer) {
        clearInterval(scanTimer);
        scanTimer = null;
      }
      setDbScanPercent(100);
      setDbScanStage("扫描完成");
      setDbCreateStatus("正在扫描结构 100% · 扫描完成");
      await wait(260);

      await loadConnections();
      setSelectedConnectionId("");
      setPageView("home");
      setShowAddDb(false);
      setDbName("");
      setDbUri("");
      setDbConnMode("url");
      setDbParamKind("postgres");
      setDbParamHost("");
      setDbParamPort("");
      setDbParamDatabase("");
      setDbParamUser("");
      setDbParamPassword("");
      setDbParamSsl(true);
      setStatusMessage(`数据库已就绪（${data.datasource.name}），扫描到 ${introspectData.tables ?? 0} 张表/视图。`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "创建数据库失败");
    } finally {
      if (scanTimer) clearInterval(scanTimer);
      setDbCreateStatus("");
      setDbScanPercent(null);
      setDbScanStage("");
      setGlobalLoading(false);
    }
  }

  async function handleReloadSchema() {
    if (!selectedConnectionId) return;
    setGlobalLoading(true);
    let scanTimer: ReturnType<typeof setInterval> | null = null;
    const scanStartAt = Date.now();
    const tickScanProgress = () => {
      const progress = estimateScanProgress(Date.now() - scanStartAt);
      setStatusMessage(`正在重建索引 ${progress.percent}% · ${progress.stage}`);
    };
    tickScanProgress();
    scanTimer = setInterval(tickScanProgress, 700);
    try {
      const res = await fetch(`/api/connections/${selectedConnectionId}/introspect?full=1`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Reindex failed");
      if (scanTimer) {
        clearInterval(scanTimer);
        scanTimer = null;
      }
      setStatusMessage(`重索引完成，共同步 ${data.tables ?? 0} 张表/视图。`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "重索引失败");
    } finally {
      if (scanTimer) clearInterval(scanTimer);
      setGlobalLoading(false);
    }
  }

  async function loadDatasourceNote(connectionId: string) {
    const res = await fetch(`/api/connections/${connectionId}/note`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "加载备注失败");
    const note = String(data.note ?? "");
    setDatasourceNote(note);
    setNoteDraft(note);
  }

  async function handleSaveNote() {
    if (!selectedConnectionId) return;
    setNoteBusy(true);
    setNoteStatus("");
    try {
      const res = await fetch(`/api/connections/${selectedConnectionId}/note`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: noteDraft }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "保存备注失败");
      setDatasourceNote(noteDraft.trim());
      setNoteStatus("已保存");
    } catch (error) {
      setNoteStatus(error instanceof Error ? error.message : "保存备注失败");
    } finally {
      setNoteBusy(false);
    }
  }

  function openConnection(connectionId: string) {
    setSelectedConnectionId(connectionId);
    setSelectedConversationId("");
    setMessages([]);
    setPageView("chat");
    setShowConnectionActions(false);
  }

  function goHome() {
    setPageView("home");
    setShowConnectionActions(false);
    setMobileSidebarOpen(false);
    setRunStatus("");
  }

  function handleSelectLlmModel(nextModel: string) {
    const value = nextModel.trim();
    setSelectedLlmModel(value);
    if (typeof window !== "undefined") {
      if (value) window.localStorage.setItem(MODEL_STORAGE_KEY, value);
      else window.localStorage.removeItem(MODEL_STORAGE_KEY);
    }
  }

  async function handleRenameConnection() {
    if (!selectedConnectionId || !renameDraft.trim()) return;
    setRenameBusy(true);
    setStatusMessage("");
    try {
      const res = await fetch(`/api/connections/${selectedConnectionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: renameDraft.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "重命名失败");
      await loadConnections();
      setShowRename(false);
      setStatusMessage("数据库名称已更新");
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "重命名失败");
    } finally {
      setRenameBusy(false);
    }
  }

  async function handleDeleteConfirmed() {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setStatusMessage("");
    try {
      if (deleteTarget.type === "connection") {
        sseRef.current?.close();
        const deletingId = deleteTarget.id;
        const res = await fetch(`/api/connections/${deletingId}`, { method: "DELETE" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "删除数据库失败");

        const currentConnections = connections.filter((c) => c.id !== deletingId);
        setConnections(currentConnections);
        setSelectedConnectionId("");
        setSelectedConversationId("");
        setMessages([]);
        setConversations([]);
        setPageView("home");
        setStatusMessage("数据库已删除");
      } else {
        sseRef.current?.close();
        const deletingId = deleteTarget.id;
        const res = await fetch(`/api/conversations/${deletingId}`, { method: "DELETE" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "删除会话失败");
        if (selectedConversationId === deletingId) {
          setSelectedConversationId("");
          setMessages([]);
        }
        if (selectedConnectionId) await loadConversations(selectedConnectionId);
        setStatusMessage("会话已删除");
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "删除失败");
    } finally {
      setDeleteBusy(false);
      setDeleteTarget(null);
    }
  }

  async function handleSendMessage(e: FormEvent) {
    e.preventDefault();
    if (!composer.trim()) return;
    if (!selectedConnectionId) {
      setStatusMessage("请先添加并选择数据库");
      return;
    }

    const question = composer.trim();
    setComposer("");
    setStatusMessage("");

    let conversationId = selectedConversationId;
    if (!conversationId) {
      // 首条消息发送时先不切会话，避免触发 loadMessages 覆盖本地临时消息
      conversationId = await createConversation(summarizeTitle(question), { autoSelect: false, syncList: false });
    }

    const userMsg: ChatMessage = {
      id: `local-user-${Date.now()}`,
      role: "user",
      content: question,
    };
    const assistantId = `local-assistant-${Date.now()}`;
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      metaJson: {
        live: { currentStatus: "正在思考...", sqlTraces: [], evidence: [] },
      },
    };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    optimisticConversationIdRef.current = conversationId;
    setRunStatus("正在启动分析...");

    const res = await fetch(`/api/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, connectionId: selectedConnectionId, llmModel: selectedLlmModel || undefined }),
    });
    const data = await res.json();
    if (!res.ok) {
      optimisticConversationIdRef.current = null;
      setRunStatus("");
      setStatusMessage(data.error || "发送失败");
      return;
    }

    const runId = data.runId as string;
    // 后端已持久化用户消息后再切换会话，避免闪烁丢消息
    if (selectedConversationId !== conversationId) {
      suppressAutoLoadConversationIdRef.current = conversationId;
      setSelectedConversationId(conversationId);
      setMobileSidebarOpen(false);
    }
    subscribeRunSse(runId, assistantId, conversationId);
    await loadConversations(selectedConnectionId);
  }

  function subscribeRunSse(runId: string, assistantId: string, conversationId: string) {
    sseRef.current?.close();
    const sse = new EventSource(`/api/analysis/runs/${runId}/stream`);
    sseRef.current = sse;

    const setLiveStatus = (text: string) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantId) return m;
          const current = m.metaJson?.live ?? { currentStatus: "", sqlTraces: [], evidence: [] };
          return {
            ...m,
            metaJson: {
              ...m.metaJson,
              live: {
                ...current,
                currentStatus: text,
              },
            },
          };
        }),
      );
    };

    const appendSqlTrace = (trace: SqlTrace) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantId) return m;
          const current = m.metaJson?.live ?? { currentStatus: "", sqlTraces: [], evidence: [] };
          return {
            ...m,
            metaJson: {
              ...m.metaJson,
              live: {
                ...current,
                sqlTraces: [...current.sqlTraces, trace],
              },
            },
          };
        }),
      );
    };

    const appendEvidence = (item: { label: string; value: string }) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantId) return m;
          const current = m.metaJson?.live ?? { currentStatus: "", sqlTraces: [], evidence: [] };
          return {
            ...m,
            metaJson: {
              ...m.metaJson,
              live: {
                ...current,
                evidence: [...current.evidence, item],
              },
            },
          };
        }),
      );
    };

    sse.addEventListener("run_started", () => {
      setRunStatus("运行中");
    });

    sse.addEventListener("planning", (ev) => {
      const data = JSON.parse(ev.data);
      const detail = String(data?.payload?.title ?? data?.payload?.detail ?? "规划步骤");
      setLiveStatus(detail);
      setRunStatus("正在规划");
    });

    sse.addEventListener("sql_started", (ev) => {
      const data = JSON.parse(ev.data);
      const title = String(data?.payload?.title ?? "SQL 执行");
      setLiveStatus(title);
      setRunStatus("正在执行 SQL");
    });

    sse.addEventListener("sql_finished", (ev) => {
      const data = JSON.parse(ev.data);
      const trace = (data?.payload?.trace ?? {}) as SqlTrace;
      appendSqlTrace(trace);
      setLiveStatus(trace.title || "步骤完成");
    });

    sse.addEventListener("sql_blocked", (ev) => {
      const data = JSON.parse(ev.data);
      const trace = (data?.payload?.trace ?? {}) as SqlTrace;
      appendSqlTrace(trace);
      setLiveStatus(trace.title || "SQL 被拦截");
    });

    sse.addEventListener("sql_error", (ev) => {
      const data = JSON.parse(ev.data);
      const trace = (data?.payload?.trace ?? {}) as SqlTrace;
      appendSqlTrace(trace);
      setLiveStatus(trace.title || "SQL 执行报错");
    });

    sse.addEventListener("evidence", (ev) => {
      const data = JSON.parse(ev.data);
      appendEvidence(data.payload as { label: string; value: string });
    });

    sse.addEventListener("final", async (ev) => {
      const data = JSON.parse(ev.data);
      const report = data?.payload?.report as Report | undefined;
      if (report) {
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== assistantId) return m;
            return {
              ...m,
              content: report.summary,
              metaJson: { report },
            };
          }),
        );
      }
      setLiveStatus("分析完成");
      setRunStatus("");
      sse.close();
      optimisticConversationIdRef.current = null;
      await loadMessages(conversationId, { force: true });
      if (selectedConnectionId) {
        await loadDatasourceNote(selectedConnectionId);
      }
    });

    sse.addEventListener("failed", (ev) => {
      const data = JSON.parse(ev.data);
      setRunStatus("");
      setLiveStatus(`失败：${String(data?.payload?.error ?? "分析失败")}`);
      sse.close();
      optimisticConversationIdRef.current = null;
      void loadMessages(conversationId, { force: true });
    });

    sse.addEventListener("done", () => {
      sse.close();
      setRunStatus("");
      // 兜底：若 final 事件丢失或顺序异常，主动拉取最终结果
      void pollRunUntilDone(runId, assistantId, conversationId);
    });

    sse.onerror = async () => {
      sse.close();
      setRunStatus("SSE 中断，回退轮询结果...");
      await pollRunUntilDone(runId, assistantId, conversationId);
    };
  }

  async function pollRunUntilDone(runId: string, assistantId: string, conversationId: string) {
    for (let i = 0; i < 40; i++) {
      await wait(1200);
      const res = await fetch(`/api/analysis/runs/${runId}?resume=1`);
      const data = await res.json();
      if (!res.ok) {
        setStatusMessage(data.error || "获取运行状态失败");
        return;
      }
      const run = data.run;
      const resume = data.resume as { resumed?: boolean; reason?: string } | undefined;
      if (resume?.resumed) {
        setRunStatus("检测到任务中断，正在继续执行...");
      }
      if (run.status === "completed") {
        const report = run.result?.report ?? (run.result as Report | undefined);
        if (report) {
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: report.summary, metaJson: { report } } : m)),
          );
        }
        optimisticConversationIdRef.current = null;
        await loadMessages(conversationId, { force: true });
        if (selectedConnectionId) {
          await loadDatasourceNote(selectedConnectionId);
        }
        setRunStatus("");
        return;
      }
      if (run.status === "failed") {
        optimisticConversationIdRef.current = null;
        setRunStatus("");
        setStatusMessage(run.result?.error || "分析失败");
        return;
      }
    }
    setRunStatus("");
    setStatusMessage("运行超时，请重试");
  }

  const currentMessages = messages;

  if (!mounted) {
    return (
      <div className="claude-shell">
        <header className="claude-header">
          <div className="header-left">
            <div className="breadcrumb">
              <span className="crumb-brand-link active">DataWowsight</span>
            </div>
          </div>
        </header>
        <main className="home-main">
          <section className="home-grid">
            <div className="db-card loading"><div className="skeleton s1" /><div className="skeleton s2" /><div className="skeleton s3" /></div>
            <div className="db-card loading"><div className="skeleton s1" /><div className="skeleton s2" /><div className="skeleton s3" /></div>
            <div className="db-card loading"><div className="skeleton s1" /><div className="skeleton s2" /><div className="skeleton s3" /></div>
          </section>
        </main>
      </div>
    );
  }

  if (authLoading) {
    return (
      <div className="claude-shell">
        <main className="home-main auth-gate-shell">
          <div className="auth-card">
            <h2>加载中...</h2>
          </div>
        </main>
      </div>
    );
  }

  if (authEnabled && !authenticated) {
    return (
      <div className="claude-shell">
        <main className="home-main auth-gate-shell">
          <div className="auth-card">
            <h2>Enter Password</h2>
            <p>此页面已启用访问密码，请先验证。</p>
            <form
              className="auth-form"
              onSubmit={(e) => {
                e.preventDefault();
                void (async () => {
                  setAuthError("");
                  const res = await fetch("/api/auth/login", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ password: accessPassword }),
                  });
                  const data = await res.json();
                  if (!res.ok) {
                    setAuthError(data.error || "验证失败");
                    return;
                  }
                  setAccessPassword("");
                  await refreshAuthStatus();
                })();
              }}
            >
              <input
                type="password"
                value={accessPassword}
                onChange={(e) => setAccessPassword(e.target.value)}
                placeholder="Password"
                autoFocus
                required
              />
              {authError && <div className="status-msg">{authError}</div>}
              <button className="btn" type="submit" disabled={!accessPassword.trim()}>
                Unlock
              </button>
            </form>
          </div>
        </main>
      </div>
    );
  }

  return (
    <>
    <div className="claude-shell">
      <header className="claude-header">
        <div className="header-left">
          <div className="breadcrumb">
            <button
              className={`crumb-brand-link ${pageView === "home" ? "active" : ""}`}
              onClick={goHome}
              type="button"
            >
              DataWowsight
            </button>
            <span className="app-version-badge">{APP_VERSION}</span>
            {pageView === "chat" && (
              <>
                <span className="crumb-sep">/</span>
                <span className="crumb-current" title={selectedConnection?.name ?? "Database"}>
                  {selectedConnection?.name ?? "Database"}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="header-actions">
          {pageView === "chat" && (
            <>
              <button className="btn ghost only-mobile" onClick={() => setMobileSidebarOpen((s) => !s)} type="button">
                会话
              </button>
              <select
                className="db-select"
                value={selectedConnectionId}
                onChange={(e) => {
                  if (!e.target.value) {
                    goHome();
                    setSelectedConnectionId("");
                    return;
                  }
                  openConnection(e.target.value);
                }}
              >
                <option value="">选择数据库</option>
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.kind})
                  </option>
                ))}
              </select>
              <button
                className="btn ghost"
                onClick={() => {
                  setNoteDraft(datasourceNote);
                  setNoteStatus("");
                  setShowNotes(true);
                }}
                type="button"
                disabled={!selectedConnectionId}
              >
                Notes
              </button>
              <div
                className="action-menu"
                ref={actionMenuRef}
              >
                <button
                  className="btn ghost icon-btn"
                  onClick={() => setShowConnectionActions((v) => !v)}
                  type="button"
                  disabled={!selectedConnectionId}
                >
                  ...
                </button>
                {showConnectionActions && (
                  <div className="action-popover">
                    <div className="action-model-picker">
                      <div className="action-model-label">Model</div>
                      <select
                        className="action-model-select"
                        value={selectedLlmModel}
                        onChange={(e) => handleSelectLlmModel(e.target.value)}
                        disabled={llmModelOptions.length === 0}
                      >
                        {llmModelOptions.map((model) => (
                          <option key={model} value={model}>
                            {model}
                          </option>
                        ))}
                      </select>
                      {llmConfig?.defaultModel && (
                        <div className="action-model-hint">默认: {llmConfig.defaultModel}</div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setShowConnectionActions(false);
                        void handleReloadSchema();
                      }}
                    >
                      Reload
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowConnectionActions(false);
                        setRenameDraft(selectedConnection?.name ?? "");
                        setShowRename(true);
                      }}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowConnectionActions(false);
                        if (!selectedConnection) return;
                        setDeleteTarget({ type: "connection", id: selectedConnection.id, name: selectedConnection.name });
                      }}
                      className="danger-text"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
          {pageView === "home" && (
            <button className="btn" onClick={() => setShowAddDb(true)} type="button">
              + Add Database
            </button>
          )}
        </div>
      </header>

      {pageView === "home" ? (
        <main className="home-main">
          {statusMessage && <div className="status-msg home-status">{statusMessage}</div>}
          <section className="home-grid">
            {connectionsLoading && (
              <>
                <div className="db-card loading"><div className="skeleton s1" /><div className="skeleton s2" /><div className="skeleton s3" /></div>
                <div className="db-card loading"><div className="skeleton s1" /><div className="skeleton s2" /><div className="skeleton s3" /></div>
                <div className="db-card loading"><div className="skeleton s1" /><div className="skeleton s2" /><div className="skeleton s3" /></div>
              </>
            )}
            {connections.map((c) => (
              <button
                key={c.id}
                className="db-card"
                onClick={() => openConnection(c.id)}
                type="button"
              >
                <div className="db-card-title">{c.name}</div>
                <div className="db-card-meta">{c.kind}</div>
                <div className="db-card-time">{formatCreatedAtUtc(c.createdAt)}</div>
              </button>
            ))}
            {!connectionsLoading && connections.length === 0 && (
              <div className="home-empty">
                <h2>还没有数据库连接</h2>
                <p>先在首页添加数据库，然后进入对话模式。</p>
                <button className="btn" onClick={() => setShowAddDb(true)} type="button">
                  + Add Database
                </button>
              </div>
            )}
          </section>
        </main>
      ) : (
      <main className="claude-main">
          <aside className={`claude-sidebar ${mobileSidebarOpen ? "open" : ""}`}>
            <div className="sidebar-top">
              <h3>Conversations</h3>
              <button
                className="btn ghost"
                onClick={() => {
                  void handleCreateConversation();
                }}
                type="button"
                disabled={!selectedConnectionId || creatingConversation}
              >
                {creatingConversation ? "Creating..." : "New"}
              </button>
            </div>
            {creatingConversation && (
              <div className="sidebar-loading">
                <span className="live-dot" />
                <span>Creating conversation...</span>
              </div>
            )}
            <div className="conv-list">
              {conversations.map((c) => (
                <div
                  key={c.id}
                  className={`conv-item ${selectedConversationId === c.id ? "active" : ""}`}
                  onClick={() => {
                    setSelectedConversationId(c.id);
                    setMobileSidebarOpen(false);
                  }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedConversationId(c.id);
                      setMobileSidebarOpen(false);
                    }
                  }}
                >
                  <div className="conv-title">{c.title}</div>
                  <button
                    className="conv-delete"
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteTarget({ type: "conversation", id: c.id, name: c.title });
                    }}
                    aria-label="Delete conversation"
                    title="Delete conversation"
                  >
                    <span aria-hidden="true">x</span>
                    <span className="sr-only">Delete</span>
                  </button>
                </div>
              ))}
              {conversations.length === 0 && <div className="empty">当前数据库暂无会话</div>}
            </div>
          </aside>

          <section className="claude-chat">
          <div className="chat-scroll" ref={listRef}>
            {currentMessages.length === 0 && (
              <div className="welcome">
                <h2>开始一个数据库对话</h2>
                <p>输入业务问题，Agent 会实时展示规划、执行 SQL 和分析结果。</p>
              </div>
            )}

            {currentMessages.map((m) => (
              <article key={m.id} className={`msg ${m.role}`}>
                <div className="msg-role-row">
                  <div className="msg-role">{m.role === "user" ? "You" : "Agent"}</div>
                  {m.role === "assistant" && (m.metaJson?.report?.debugLogs?.length ?? 0) > 0 && (
                    <button
                      className="msg-log-btn"
                      type="button"
                      aria-label="Open run logs"
                      title="查看运行日志"
                      onClick={() => setLogViewer({ messageId: m.id, logs: m.metaJson?.report?.debugLogs ?? [] })}
                    >
                      <ScrollText size={13} />
                    </button>
                  )}
                </div>
                <div className="msg-body">
                  {m.content ? (
                    m.role === "assistant" ? (
                      <div className="msg-markdown">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                      </div>
                    ) : (
                      <p className="msg-text">{m.content}</p>
                    )
                  ) : <p className="msg-text muted">正在思考...</p>}

                  {m.metaJson?.live && (
                    <div className="live-block">
                      <div className="live-status-line" title={m.metaJson.live.currentStatus}>
                        <span className="live-dot" />
                        <span>{m.metaJson.live.currentStatus}</span>
                      </div>

                      {m.metaJson.live.sqlTraces.length > 0 && (
                        <details className="sql-details">
                          <summary>
                            SQL Runs ({m.metaJson.live.sqlTraces.length})
                          </summary>
                          <div className="sql-list">
                            {m.metaJson.live.sqlTraces.map((s, i) => (
                              <div className="sql-item" key={`${m.id}-live-sql-${i}`}>
                                <div className="sql-title">
                                  {s.title} {s.status ? `[${s.status}]` : ""}
                                  {typeof s.durationMs === "number" ? ` · ${formatDurationMs(s.durationMs)}` : ""}
                                </div>
                                {s.reason && <div className="sql-reason">{s.reason}</div>}
                                <pre>{s.sql}</pre>
                              </div>
                            ))}
                          </div>
                        </details>
                      )}
                    </div>
                  )}

                  {m.metaJson?.report && (
                    <div className="report-block">
                      {m.metaJson.report.chart && (
                        <div className="chart-block">
                          <div className="section-title">{m.metaJson.report.chart.title || "Insight Chart"}</div>
                          <ReactECharts
                            option={buildChartOption(m.metaJson.report.chart)}
                            style={{ height: 300, width: "100%" }}
                          />
                        </div>
                      )}
                      {m.metaJson.report.resultTable && m.metaJson.report.resultTable.rows.length > 0 && (
                        <details className="sql-details" open>
                          <summary>
                            Result Rows ({m.metaJson.report.resultTable.rows.length})
                          </summary>
                          <div className="result-actions">
                            <div className="export-menu">
                              <button
                                className="icon-action-btn"
                                type="button"
                                onClick={() => setOpenExportForMessageId((prev) => (prev === m.id ? null : m.id))}
                                aria-label="Export result rows"
                                title="Export"
                              >
                                <Download size={14} />
                              </button>
                              {openExportForMessageId === m.id && (
                                <div className="export-popover">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      exportResultRowsAsCsv(
                                        m.metaJson?.report?.resultTable?.rows ?? [],
                                        m.metaJson?.report?.resultTable?.columns ?? [],
                                        m.metaJson?.report?.resultTable?.title ?? "result_rows",
                                      );
                                      setOpenExportForMessageId(null);
                                    }}
                                  >
                                    <FileSpreadsheet size={14} />
                                    <span>CSV</span>
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      exportResultRowsAsJson(
                                        m.metaJson?.report?.resultTable?.rows ?? [],
                                        m.metaJson?.report?.resultTable?.title ?? "result_rows",
                                      );
                                      setOpenExportForMessageId(null);
                                    }}
                                  >
                                    <FileJson2 size={14} />
                                    <span>JSON</span>
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="result-table-wrap">
                            <table className="result-table">
                              <thead>
                                <tr>
                                  {m.metaJson.report.resultTable.columns.map((col) => (
                                    <th key={`${m.id}-h-${col}`}>{col}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {m.metaJson.report.resultTable.rows.map((row, idx) => (
                                  <tr key={`${m.id}-r-${idx}`}>
                                    {(m.metaJson?.report?.resultTable?.columns ?? []).map((col) => (
                                      <td key={`${m.id}-r-${idx}-${col}`}>{formatCellValue(row[col])}</td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </details>
                      )}
                      <details className="sql-details">
                        <summary>
                          Key Evidence ({m.metaJson.report.keyEvidence.length})
                        </summary>
                        <ul>
                          {m.metaJson.report.keyEvidence.map((evi, i) => (
                            <li key={`${m.id}-e-${i}`}>
                              {evi.label}: {evi.value}
                            </li>
                          ))}
                        </ul>
                      </details>

                      {m.metaJson.report.sqlTraces.length > 0 && (
                        <details className="sql-details">
                          <summary>
                            SQL Runs ({m.metaJson.report.sqlTraces.length})
                          </summary>
                          <div className="sql-list">
                            {m.metaJson.report.sqlTraces.map((s, i) => (
                              <div className="sql-item" key={`${m.id}-sql-${i}`}>
                                <div className="sql-title">
                                  {s.title} {s.status ? `[${s.status}]` : ""}
                                  {typeof s.durationMs === "number" ? ` · ${formatDurationMs(s.durationMs)}` : ""}
                                </div>
                                {s.reason && <div className="sql-reason">{s.reason}</div>}
                                <pre>{s.sql}</pre>
                              </div>
                            ))}
                          </div>
                        </details>
                      )}
                    </div>
                  )}
                </div>
              </article>
            ))}
          </div>

          <div className="composer-wrap">
            {runStatus && <div className="run-status">{runStatus}</div>}
            {statusMessage && <div className="status-msg">{statusMessage}</div>}
            <form className="composer" onSubmit={handleSendMessage}>
              <textarea
                value={composer}
                onChange={(e) => setComposer(e.target.value)}
                placeholder="向数据库提问..."
                rows={2}
                disabled={globalLoading || !selectedConnectionId}
              />
              <button className="btn" type="submit" disabled={globalLoading || !selectedConnectionId || !composer.trim()}>
                Send
              </button>
            </form>
          </div>
          </section>
      </main>
      )}

      {showAddDb && (
        <div className="modal-mask" onClick={() => setShowAddDb(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Add Database</h3>
            <form className="modal-form" onSubmit={handleCreateDb}>
              <input
                value={dbName}
                onChange={(e) => setDbName(e.target.value)}
                placeholder="连接名称"
                required
              />
              <div className="conn-mode-tabs">
                <button
                  type="button"
                  className={`conn-mode-tab ${dbConnMode === "url" ? "active" : ""}`}
                  onClick={() => setDbConnMode("url")}
                >
                  URL
                </button>
                <button
                  type="button"
                  className={`conn-mode-tab ${dbConnMode === "params" ? "active" : ""}`}
                  onClick={() => setDbConnMode("params")}
                >
                  参数
                </button>
              </div>
              {dbConnMode === "url" ? (
                <textarea
                  value={dbUri}
                  onChange={(e) => setDbUri(e.target.value)}
                  placeholder="postgres:// / mysql:// / sqlite://..."
                  rows={4}
                  required
                />
              ) : (
                <div className="conn-param-grid">
                  <label className="conn-field full">
                    <span>数据库类型</span>
                    <select value={dbParamKind} onChange={(e) => setDbParamKind(e.target.value as "postgres" | "mysql")}>
                      <option value="postgres">PostgreSQL</option>
                      <option value="mysql">MySQL</option>
                    </select>
                  </label>
                  <label className="conn-field">
                    <span>端点（URL）</span>
                    <input
                      value={dbParamHost}
                      onChange={(e) => setDbParamHost(e.target.value)}
                      placeholder="db.example.com"
                      required
                    />
                  </label>
                  <label className="conn-field">
                    <span>端口</span>
                    <input
                      value={dbParamPort}
                      onChange={(e) => setDbParamPort(e.target.value)}
                      placeholder={dbParamKind === "postgres" ? "5432" : "3306"}
                      inputMode="numeric"
                      required
                    />
                  </label>
                  <label className="conn-field">
                    <span>数据库</span>
                    <input
                      value={dbParamDatabase}
                      onChange={(e) => setDbParamDatabase(e.target.value)}
                      placeholder="database_name"
                      required
                    />
                  </label>
                  <label className="conn-field">
                    <span>用户名</span>
                    <input
                      value={dbParamUser}
                      onChange={(e) => setDbParamUser(e.target.value)}
                      placeholder="username"
                      required
                    />
                  </label>
                  <label className="conn-field full">
                    <span>密码</span>
                    <input
                      type="password"
                      value={dbParamPassword}
                      onChange={(e) => setDbParamPassword(e.target.value)}
                      placeholder="password"
                    />
                  </label>
                  <label className="conn-field full conn-toggle">
                    <span className="conn-toggle-label">
                      <strong>SSL</strong>
                      <em>{dbParamSsl ? "已启用加密连接" : "未启用加密连接"}</em>
                    </span>
                    <button
                      type="button"
                      className={`switch ${dbParamSsl ? "on" : ""}`}
                      onClick={() => setDbParamSsl((v) => !v)}
                      aria-pressed={dbParamSsl}
                      aria-label="Toggle SSL"
                    >
                      <span className="switch-knob" />
                    </button>
                  </label>
                </div>
              )}
              {dbCreateStatus && <div className="status-msg">{dbCreateStatus}</div>}
              {dbScanPercent !== null && (
                <div className="scan-progress" aria-live="polite">
                  <div className="scan-progress-head">
                    <span>{dbScanStage || "正在扫描结构"}</span>
                    <span>{dbScanPercent}%</span>
                  </div>
                  <div className="scan-progress-track">
                    <div className="scan-progress-bar" style={{ width: `${dbScanPercent}%` }} />
                  </div>
                </div>
              )}
              <div className="modal-actions">
                <button className="btn ghost" onClick={() => setShowAddDb(false)} type="button">
                  Cancel
                </button>
                <button className="btn" type="submit" disabled={globalLoading}>
                  Save
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {logViewer && (
        <div className="modal-mask" onClick={() => setLogViewer(null)}>
          <div className="modal log-modal" onClick={(e) => e.stopPropagation()}>
            <div className="log-modal-head">
              <h3>Run Logs</h3>
              <button className="log-close-btn" type="button" onClick={() => setLogViewer(null)} aria-label="Close logs">
                <X size={14} />
              </button>
            </div>
            <div className="log-modal-body">
              <div className="log-list">
                {logViewer.logs.map((log, i) => (
                  <div className="log-item" key={`${logViewer.messageId}-log-${i}`}>
                    <div className="log-head">
                      <span className={`log-kind k-${log.kind}`}>{log.kind}</span>
                      <span className="log-title">{log.title}</span>
                      <span className="log-time">{formatLogTime(log.ts)}</span>
                    </div>
                    {log.detail && <div className="log-detail">{log.detail}</div>}
                    {log.payload && <pre className="log-payload">{log.payload}</pre>}
                  </div>
                ))}
                {logViewer.logs.length === 0 && <div className="empty">暂无日志</div>}
              </div>
            </div>
          </div>
        </div>
      )}
      {showNotes && (
        <div className="modal-mask" onClick={() => setShowNotes(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Database Notes</h3>
            <form
              className="modal-form"
              onSubmit={(e) => {
                e.preventDefault();
                void handleSaveNote();
              }}
            >
              <textarea
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                placeholder="写下这个数据库的业务口径、术语定义、重要约束。会自动带入每次对话。"
                rows={8}
              />
              {noteStatus && <div className="status-msg">{noteStatus}</div>}
              <div className="modal-actions">
                <button className="btn ghost" onClick={() => setShowNotes(false)} type="button">
                  Close
                </button>
                <button className="btn" type="submit" disabled={noteBusy || !selectedConnectionId}>
                  Save
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {showRename && (
        <div className="modal-mask" onClick={() => !renameBusy && setShowRename(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Rename Database</h3>
            <form
              className="modal-form"
              onSubmit={(e) => {
                e.preventDefault();
                void handleRenameConnection();
              }}
            >
              <input
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                placeholder="数据库名称"
                maxLength={120}
                required
              />
              <div className="modal-actions">
                <button className="btn ghost" onClick={() => setShowRename(false)} type="button" disabled={renameBusy}>
                  Cancel
                </button>
                <button className="btn" type="submit" disabled={renameBusy || !renameDraft.trim()}>
                  {renameBusy ? "Saving..." : "Save"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {deleteTarget && (
        <div className="modal-mask" onClick={() => !deleteBusy && setDeleteTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{deleteTarget.type === "connection" ? "Delete Database" : "Delete Conversation"}</h3>
            <p className="delete-tip">
              {deleteTarget.type === "connection"
                ? `删除数据库「${deleteTarget.name}」会同时删除该库下的会话、消息、索引与运行记录。`
                : `删除会话「${deleteTarget.name}」会移除该会话下所有消息与运行轨迹。`}
            </p>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setDeleteTarget(null)} type="button" disabled={deleteBusy}>
                Cancel
              </button>
              <button className="btn danger" onClick={() => void handleDeleteConfirmed()} type="button" disabled={deleteBusy}>
                {deleteBusy ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </>
  );
}

function summarizeTitle(question: string) {
  const clean = question.replace(/\s+/g, " ").trim();
  return clean.length <= 36 ? clean : `${clean.slice(0, 36)}...`;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function estimateScanProgress(elapsedMs: number) {
  const stages = [
    "连接元数据服务",
    "拉取表/视图清单",
    "读取字段定义",
    "收集主外键关系",
    "写入本地索引",
  ] as const;
  const clamped = Math.max(0, elapsedMs);
  const percent = Math.min(94, Math.max(3, Math.round((clamped / 45000) * 94)));
  const stageIdx = Math.min(stages.length - 1, Math.floor((percent / 95) * stages.length));
  return { percent, stage: stages[stageIdx] };
}

function formatDurationMs(ms: number) {
  if (!Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatCreatedAtUtc(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${day} ${h}:${min} UTC`;
}

function formatLogTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function buildConnectionUri(input: {
  mode: "url" | "params";
  uri: string;
  kind: "postgres" | "mysql";
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
}) {
  if (input.mode === "url") {
    const uri = input.uri.trim();
    if (!uri) throw new Error("请填写连接 URL");
    return uri;
  }

  const host = input.host.trim();
  const port = input.port.trim();
  const database = input.database.trim();
  const user = input.user.trim();
  if (!host || !port || !database || !user) {
    throw new Error("请完整填写连接参数");
  }
  if (!/^\d+$/.test(port)) {
    throw new Error("端口必须是数字");
  }

  const protocol = input.kind === "postgres" ? "postgres" : "mysql";
  const normalizedHost = host.replace(/^\w+:\/\//, "");
  const userInfo = `${encodeURIComponent(user)}:${encodeURIComponent(input.password ?? "")}`;
  const dbPath = encodeURIComponent(database);
  const sslQuery = input.ssl
    ? input.kind === "postgres"
      ? "uselibpqcompat=true&sslmode=require"
      : "ssl=true"
    : "";
  return `${protocol}://${userInfo}@${normalizedHost}:${port}/${dbPath}${sslQuery ? `?${sslQuery}` : ""}`;
}

function buildChartOption(chart: InsightChart) {
  if (chart.type === "pie") {
    const labelKey = chart.labelKey ?? "label";
    const valueKey = chart.valueKey ?? "value";
    return {
      tooltip: { trigger: "item" },
      legend: { bottom: 0, textStyle: { color: "#6e665a" } },
      series: [
        {
          type: "pie",
          radius: ["35%", "70%"],
          data: chart.data.map((d) => ({ name: String(d[labelKey] ?? ""), value: Number(d[valueKey] ?? 0) })),
          label: { color: "#26231d" },
        },
      ],
    };
  }

  const xKey = chart.xKey ?? "x";
  const yKeys = chart.yKeys?.length ? chart.yKeys : ["y"];
  return {
    tooltip: { trigger: "axis" },
    legend: { top: 0, textStyle: { color: "#6e665a" } },
    xAxis: {
      type: "category",
      data: chart.data.map((d) => String(d[xKey] ?? "")),
      axisLabel: { color: "#6e665a" },
    },
    yAxis: { type: "value", axisLabel: { color: "#6e665a" } },
    series: yKeys.map((k) => ({
      name: k,
      type: chart.type,
      smooth: chart.type === "line",
      data: chart.data.map((d) => Number(d[k] ?? 0)),
    })),
  };
}

function formatCellValue(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function exportResultRowsAsCsv(rows: Array<Record<string, unknown>>, columns: string[], title: string) {
  if (!rows.length || !columns.length) return;
  const header = columns.map(csvEscapeCell).join(",");
  const lines = rows.map((row) => columns.map((col) => csvEscapeCell(row[col])).join(","));
  const csv = [header, ...lines].join("\n");
  downloadTextFile(csv, `${slugifyFileName(title)}.csv`, "text/csv;charset=utf-8");
}

function exportResultRowsAsJson(rows: Array<Record<string, unknown>>, title: string) {
  if (!rows.length) return;
  const json = JSON.stringify(rows, null, 2);
  downloadTextFile(json, `${slugifyFileName(title)}.json`, "application/json;charset=utf-8");
}

function csvEscapeCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function slugifyFileName(input: string) {
  const base = input.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "_").replace(/^_+|_+$/g, "");
  return base || "result_rows";
}

function downloadTextFile(content: string, fileName: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}
