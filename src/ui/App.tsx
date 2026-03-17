import { useState, useEffect } from "react";
import { BrowserChat } from "./pages/BrowserChat.js";
import { Status } from "./pages/Status.js";
import { Skills } from "./pages/Skills.js";
import { Backup } from "./pages/Backup.js";
import { Wizard } from "./pages/Wizard.js";
import { api, type StatusData } from "./lib/api.js";

type Page = "dashboard" | "chat" | "status" | "skills" | "backup" | "settings";

const NAV: { page: Page; label: string; icon: string }[] = [
  { page: "dashboard", label: "\u0413\u043B\u0430\u0432\u043D\u0430\u044F", icon: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0h4" },
  { page: "chat", label: "\u0427\u0430\u0442", icon: "M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" },
  { page: "status", label: "\u0421\u0442\u0430\u0442\u0443\u0441", icon: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" },
  { page: "skills", label: "\u0421\u043A\u0438\u043B\u043B\u044B", icon: "M13 10V3L4 14h7v7l9-11h-7z" },
  { page: "backup", label: "\u0411\u044D\u043A\u0430\u043F", icon: "M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" },
  { page: "settings", label: "\u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438", icon: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z" },
];

export function App() {
  const [page, setPage] = useState<Page>("dashboard");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [status, setStatus] = useState<StatusData | null>(null);

  useEffect(() => {
    // Check if config exists: 404 means no config → show wizard
    fetch("/api/config")
      .then((res) => {
        if (res.ok) {
          setConfigured(true);
        } else {
          setConfigured(false);
        }
      })
      .catch(() => setConfigured(false));
  }, []);

  useEffect(() => {
    if (!configured) return;
    function poll() {
      api.getStatus().then(setStatus).catch((err) => console.warn("Status poll failed:", err));
    }
    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [configured]);

  if (configured === null) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin" />
      </div>
    );
  }

  if (!configured) {
    return <Wizard onComplete={() => setConfigured(true)} />;
  }

  const isRunning = status?.running ?? false;

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className="w-[240px] shrink-0 border-r border-zinc-800/80 flex flex-col bg-[#0c0c0e] sticky top-0 h-screen">
        {/* Logo */}
        <div className="px-5 py-5 border-b border-zinc-800/60">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center">
              <span className="text-emerald-400 font-bold text-sm">B</span>
            </div>
            <div>
              <h1 className="text-[15px] font-bold text-zinc-100 leading-none tracking-tight">Betsy</h1>
              <p className="text-[11px] text-zinc-600 leading-none mt-1">{"\u0410\u0432\u0442\u043E\u043D\u043E\u043C\u043D\u044B\u0439 \u0430\u0433\u0435\u043D\u0442"}</p>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-0.5">
          {NAV.map((n) => (
            <button
              key={n.page}
              onClick={() => setPage(n.page)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-[13px] font-medium transition-colors ${
                page === n.page
                  ? "bg-zinc-800/80 text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/40"
              }`}
            >
              {page === n.page && (
                <span className="w-[3px] h-4 rounded-full bg-emerald-500 -ml-1.5 mr-0.5 shrink-0" />
              )}
              <svg className="w-[17px] h-[17px] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d={n.icon} />
              </svg>
              {n.label}
            </button>
          ))}
        </nav>

        {/* Bottom: Status */}
        <div className="px-4 py-4 border-t border-zinc-800/60 space-y-2.5">
          <div className="flex items-center gap-2.5">
            <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${isRunning ? "bg-emerald-400" : "bg-zinc-600"}`} />
            <span className="text-[13px] text-zinc-400">
              {isRunning ? "\u0420\u0430\u0431\u043E\u0442\u0430\u0435\u0442" : "\u041E\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D"}
            </span>
            {status?.uptime !== undefined && isRunning && (
              <span className="text-[11px] text-zinc-600 font-mono ml-auto readout">
                {formatUptime(status.uptime)}
              </span>
            )}
          </div>

          <div className="flex items-center justify-between pt-1 border-t border-zinc-800/40">
            <span className="text-[10px] text-zinc-700 font-mono">v0.1.0</span>
            <SystemClock />
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 min-h-screen overflow-y-auto">
        <div className="px-10 py-8">
          {page === "dashboard" && <BrowserChat />}
          {page === "chat" && <BrowserChat />}
          {page === "status" && <Status />}
          {page === "skills" && <Skills />}
          {page === "backup" && <Backup />}
          {page === "settings" && <div className="text-zinc-400">Настройки (в разработке)</div>}
        </div>
      </main>
    </div>
  );
}

function SystemClock() {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const interval = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <span className="text-[10px] font-mono text-zinc-600 tabular-nums">
      {time.toLocaleTimeString([], { hour12: false })}
    </span>
  );
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}\u0447 ${m}\u043C`;
  return `${m}\u043C`;
}
