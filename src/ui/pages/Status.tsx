import { useState, useEffect } from "react";
import { api, type StatusData } from "../lib/api.js";

interface ChannelStatus {
  name: string;
  type: string;
  connected: boolean;
  details?: string;
}

interface ToolStatus {
  name: string;
  enabled: boolean;
  calls: number;
}

interface CostData {
  today: number;
  month: number;
  totalTokens: number;
}

export function Status() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [channels, setChannels] = useState<ChannelStatus[]>([]);
  const [tools, setTools] = useState<ToolStatus[]>([]);
  const [costs, setCosts] = useState<CostData>({ today: 0, month: 0, totalTokens: 0 });
  const [memoryCount, setMemoryCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function poll() {
      const [statusResult, channelsResult, toolsResult, costsResult, knowledgeResult] =
        await Promise.allSettled([
          api.getStatus(),
          fetch("/api/channels").then((r) => r.ok ? r.json() as Promise<{ channels: ChannelStatus[] }> : null),
          fetch("/api/tools").then((r) => r.ok ? r.json() as Promise<{ tools: ToolStatus[] }> : null),
          fetch("/api/costs").then((r) => r.ok ? r.json() as Promise<CostData> : null),
          api.getKnowledge().catch(() => null),
        ]);
      if (!active) return;

      if (statusResult.status === "fulfilled") {
        setStatus(statusResult.value);
        setError(null);
      } else {
        setError(statusResult.reason instanceof Error ? statusResult.reason.message : "Ошибка подключения");
      }

      if (channelsResult.status === "fulfilled" && channelsResult.value) {
        setChannels(channelsResult.value.channels);
      }
      if (toolsResult.status === "fulfilled" && toolsResult.value) {
        setTools(toolsResult.value.tools);
      }
      if (costsResult.status === "fulfilled" && costsResult.value) {
        setCosts(costsResult.value);
      }
      if (knowledgeResult.status === "fulfilled" && knowledgeResult.value) {
        setMemoryCount(knowledgeResult.value.entries.length);
      }
    }

    void poll();
    const interval = setInterval(() => void poll(), 5000);
    return () => { active = false; clearInterval(interval); };
  }, []);

  if (error && !status) {
    return (
      <div className="text-center py-32">
        <p className="text-xl text-zinc-300 mb-2">Ошибка подключения</p>
        <p className="text-sm text-zinc-600">{error}</p>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="text-center py-32">
        <div className="w-5 h-5 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin mx-auto mb-3" />
        <p className="text-sm text-zinc-600">Загрузка...</p>
      </div>
    );
  }

  // Default channels if endpoint not available
  const displayChannels = channels.length > 0
    ? channels
    : [
        { name: "Браузер", type: "browser", connected: true, details: "Встроенный чат" },
      ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-zinc-100 tracking-tight mb-1.5">Статус</h1>
        <p className="text-sm text-zinc-500">
          Состояние каналов, инструментов и расходов
        </p>
      </div>

      {/* Channels */}
      <div>
        <h2 className="text-sm font-bold text-zinc-200 uppercase tracking-wider mb-3">Каналы</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {displayChannels.map((ch) => (
            <div key={ch.type} className="card p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[14px] font-semibold text-zinc-200">{ch.name}</span>
                <span className={`w-2.5 h-2.5 rounded-full ${ch.connected ? "bg-emerald-400" : "bg-red-400"}`} />
              </div>
              <p className="text-[12px] text-zinc-500">
                {ch.connected ? "Подключён" : "Отключён"}
              </p>
              {ch.details && (
                <p className="text-[11px] text-zinc-600 mt-1">{ch.details}</p>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Memory & Tools row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* Memory */}
        <div>
          <h2 className="text-sm font-bold text-zinc-200 uppercase tracking-wider mb-3">Память</h2>
          <div className="card p-4">
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-zinc-400">Записей в памяти</span>
              <span className="text-xl font-bold text-zinc-200 font-mono readout">{memoryCount}</span>
            </div>
          </div>
        </div>

        {/* Costs */}
        <div>
          <h2 className="text-sm font-bold text-zinc-200 uppercase tracking-wider mb-3">Расходы</h2>
          <div className="card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-zinc-400">Сегодня</span>
              <span className="text-lg font-bold text-zinc-200 font-mono readout">${costs.today.toFixed(2)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-zinc-400">За месяц</span>
              <span className="text-lg font-bold text-zinc-200 font-mono readout">${costs.month.toFixed(2)}</span>
            </div>
            {costs.totalTokens > 0 && (
              <div className="flex items-center justify-between pt-2 border-t border-zinc-800/40">
                <span className="text-[12px] text-zinc-500">Всего токенов</span>
                <span className="text-[13px] text-zinc-400 font-mono">{costs.totalTokens.toLocaleString()}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Tools */}
      {tools.length > 0 && (
        <div>
          <h2 className="text-sm font-bold text-zinc-200 uppercase tracking-wider mb-3">Инструменты</h2>
          <div className="card overflow-hidden">
            <div className="divide-y divide-zinc-800/40">
              {tools.map((tool) => (
                <div key={tool.name} className="flex items-center justify-between px-4 py-3">
                  <div className="flex items-center gap-3">
                    <span className={`w-2 h-2 rounded-full ${tool.enabled ? "bg-emerald-400" : "bg-zinc-600"}`} />
                    <span className="text-[13px] text-zinc-300">{tool.name}</span>
                  </div>
                  <span className="text-[12px] text-zinc-500 font-mono">
                    {tool.calls} вызовов
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
