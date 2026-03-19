import { useState, useEffect } from "react";
import { api, type StatusData, type ChatMessage } from "../lib/api.js";

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
}

export function Dashboard() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [recentMessages, setRecentMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function poll() {
      const [statusRes, logsRes, chatRes] = await Promise.allSettled([
        api.getStatus(),
        api.getLogs().catch(() => ({ log: "" })),
        api.getChat().catch(() => ({ messages: [] })),
      ]);
      if (!active) return;

      if (statusRes.status === "fulfilled") {
        setStatus(statusRes.value);
        setError(null);
      } else {
        setError("Ошибка подключения");
      }

      if (logsRes.status === "fulfilled") {
        const raw = (logsRes.value as { log: string }).log || "";
        const parsed = raw.split("\n").filter(Boolean).slice(-20).map((line) => {
          const m = line.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*\[(\w+)\]\s*(.*)/);
          return m
            ? { timestamp: m[1], level: m[2], message: m[3] }
            : { timestamp: "", level: "INFO", message: line };
        });
        setLogs(parsed);
      }

      if (chatRes.status === "fulfilled") {
        const msgs = (chatRes.value as { messages: ChatMessage[] }).messages || [];
        setRecentMessages(msgs.slice(-5));
      }
    }

    void poll();
    const interval = setInterval(() => void poll(), 5000);
    return () => { active = false; clearInterval(interval); };
  }, []);

  if (error && !status) {
    return (
      <div className="text-center py-32">
        <p className="text-xl text-slate-700 mb-2">Ошибка подключения</p>
        <p className="text-sm text-slate-400">{error}</p>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="text-center py-32">
        <div className="w-5 h-5 border-2 border-slate-200 border-t-violet-400 rounded-full animate-spin mx-auto mb-3" />
        <p className="text-sm text-slate-400">Загрузка...</p>
      </div>
    );
  }

  const st = status as StatusData & {
    agentName?: string;
    channels?: string[];
    tools?: string[];
    memory?: { entries: number };
    mode?: string;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-slate-700 tracking-tight mb-1.5">
          {st.agentName || "Betsy"}
        </h1>
        <p className="text-sm text-slate-400">Панель управления</p>
      </div>

      {/* Status Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatusCard
          label="Статус"
          value={st.running ? "Работает" : "Остановлен"}
          color={st.running ? "emerald" : "slate"}
          icon="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
        />
        <StatusCard
          label="Uptime"
          value={formatUptime(st.uptime ?? 0)}
          color="violet"
          icon="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
        />
        <StatusCard
          label="Каналы"
          value={String((st.channels || []).length)}
          color="blue"
          icon="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
        />
        <StatusCard
          label="Память"
          value={String(st.memory?.entries ?? 0)}
          color="rose"
          icon="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
        />
      </div>

      {/* Channels & Tools */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* Channels */}
        <div className="bg-white border border-slate-200/60 rounded-xl p-5">
          <h2 className="text-sm font-bold text-slate-500 uppercase tracking-wider mb-3">Каналы</h2>
          <div className="space-y-2">
            {(st.channels || ["browser"]).map((ch) => (
              <div key={ch} className="flex items-center gap-2.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400" />
                <span className="text-[13px] text-slate-600 capitalize">{ch === "browser" ? "Браузер" : ch === "telegram" ? "Telegram" : ch}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Tools */}
        <div className="bg-white border border-slate-200/60 rounded-xl p-5">
          <h2 className="text-sm font-bold text-slate-500 uppercase tracking-wider mb-3">
            Инструменты <span className="text-slate-300 font-normal">({(st.tools || []).length})</span>
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {(st.tools || []).map((tool) => (
              <span
                key={tool}
                className="px-2.5 py-1 rounded-lg bg-slate-50 text-[11px] font-medium text-slate-500 border border-slate-100"
              >
                {tool}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Activity & Quick Actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* Recent Activity */}
        <div className="bg-white border border-slate-200/60 rounded-xl p-5">
          <h2 className="text-sm font-bold text-slate-500 uppercase tracking-wider mb-3">Последняя активность</h2>
          {logs.length === 0 && recentMessages.length === 0 ? (
            <p className="text-[13px] text-slate-400 py-4 text-center">Нет активности</p>
          ) : (
            <div className="space-y-2 max-h-[240px] overflow-y-auto">
              {recentMessages.map((msg, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${msg.role === "user" ? "bg-blue-400" : "bg-violet-400"}`} />
                  <div className="min-w-0">
                    <span className="text-[11px] text-slate-300 font-mono">
                      {new Date(msg.timestamp).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit" })}
                    </span>
                    <p className="text-[12px] text-slate-500 truncate">{msg.content}</p>
                  </div>
                </div>
              ))}
              {logs.slice(-5).map((log, i) => (
                <div key={`log-${i}`} className="flex items-start gap-2">
                  <span className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${
                    log.level === "ERROR" ? "bg-red-400" : log.level === "WARN" ? "bg-amber-400" : "bg-slate-300"
                  }`} />
                  <div className="min-w-0">
                    <span className="text-[11px] text-slate-300 font-mono">{log.timestamp}</span>
                    <p className="text-[12px] text-slate-500 truncate">{log.message}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Quick Actions */}
        <div className="bg-white border border-slate-200/60 rounded-xl p-5">
          <h2 className="text-sm font-bold text-slate-500 uppercase tracking-wider mb-3">Быстрые действия</h2>
          <div className="space-y-2">
            <QuickAction
              label={st.running ? "Остановить агента" : "Запустить агента"}
              description={st.running ? "Приостановить работу" : "Возобновить работу"}
              icon={st.running ? "M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" : "M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"}
              color={st.running ? "rose" : "emerald"}
              onClick={async () => {
                try {
                  if (st.running) await api.stop();
                  else await api.start();
                } catch {}
              }}
            />
            <QuickAction
              label="Открыть чат"
              description="Написать агенту"
              icon="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
              color="violet"
              onClick={() => { window.location.hash = ""; window.location.pathname = "/chat"; }}
            />
            <QuickAction
              label="Настройки"
              description="Изменить конфигурацию"
              icon="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              color="slate"
              onClick={() => { window.location.pathname = "/settings"; }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusCard({ label, value, color, icon }: { label: string; value: string; color: string; icon: string }) {
  const colors: Record<string, string> = {
    emerald: "from-emerald-50 to-emerald-100/50 text-emerald-600",
    violet: "from-violet-50 to-violet-100/50 text-violet-600",
    blue: "from-blue-50 to-blue-100/50 text-blue-600",
    rose: "from-rose-50 to-rose-100/50 text-rose-600",
    slate: "from-slate-50 to-slate-100/50 text-slate-500",
  };

  return (
    <div className="bg-white border border-slate-200/60 rounded-xl p-4">
      <div className="flex items-center gap-2.5 mb-2">
        <div className={`w-8 h-8 rounded-lg bg-gradient-to-br ${colors[color]} flex items-center justify-center`}>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
          </svg>
        </div>
        <span className="text-[11px] text-slate-400 uppercase tracking-wider font-medium">{label}</span>
      </div>
      <p className="text-xl font-bold text-slate-700 font-mono">{value}</p>
    </div>
  );
}

function QuickAction({ label, description, icon, color, onClick }: {
  label: string; description: string; icon: string; color: string; onClick: () => void;
}) {
  const colors: Record<string, string> = {
    emerald: "text-emerald-500 bg-emerald-50",
    rose: "text-rose-500 bg-rose-50",
    violet: "text-violet-500 bg-violet-50",
    slate: "text-slate-500 bg-slate-50",
  };

  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-slate-50/80 transition-colors text-left group"
    >
      <div className={`w-9 h-9 rounded-lg ${colors[color]} flex items-center justify-center shrink-0`}>
        <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
        </svg>
      </div>
      <div>
        <p className="text-[13px] font-medium text-slate-700 group-hover:text-slate-900">{label}</p>
        <p className="text-[11px] text-slate-400">{description}</p>
      </div>
    </button>
  );
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 24) {
    const d = Math.floor(h / 24);
    return `${d}д ${h % 24}ч`;
  }
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м`;
}
