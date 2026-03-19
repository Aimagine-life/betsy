import { useState, useRef, useEffect } from "react";
import { api } from "../../lib/api.js";
import type { ChannelsData } from "./ChannelsStep.js";

interface DoneStepProps {
  channels: ChannelsData;
  onComplete: () => void;
}

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

export function DoneStep({ channels, onComplete }: DoneStepProps) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setSending(true);
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    try {
      const { reply } = await api.sendChat(text);
      setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
    } catch {
      setMessages((prev) => [...prev, { role: "assistant", content: "Ой, пока не получилось. Попробуй в панели управления!" }]);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  const enabledChannels: string[] = ["Браузер"];
  if (channels.telegram.enabled) enabledChannels.push("Telegram");
  if (channels.max.enabled) enabledChannels.push("Max");

  return (
    <div className="space-y-6">
      <div className="text-center">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-100 to-sky-100 flex items-center justify-center mx-auto mb-4 shadow-sm">
          <svg className="w-8 h-8 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h2 className="text-2xl font-bold text-slate-700 mb-2">Я готова!</h2>
        <p className="text-slate-400 text-sm">Поговори со мной или перейди в панель управления.</p>
      </div>

      {/* Connected channels */}
      <div className="flex items-center justify-center gap-2 flex-wrap">
        {enabledChannels.map((ch) => (
          <span
            key={ch}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-50 border border-emerald-200 text-[12px] text-emerald-600 font-medium"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            {ch}
          </span>
        ))}
      </div>

      {/* Mini chat */}
      <div className="wizard-card overflow-hidden">
        <div className="h-[200px] overflow-y-auto p-4 space-y-2">
          {messages.length === 0 && (
            <p className="text-slate-300 text-sm text-center pt-16">Напиши что-нибудь, чтобы проверить!</p>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[80%] rounded-xl px-3.5 py-2 text-[13px] ${
                msg.role === "user"
                  ? "bg-gradient-to-r from-rose-100 to-violet-100 text-slate-700"
                  : "bg-slate-50 border border-slate-200 text-slate-600"
              }`}>
                {msg.content}
              </div>
            </div>
          ))}
          {sending && (
            <div className="flex justify-start">
              <div className="bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-2 text-[13px] text-slate-400">
                Думаю...
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
        <div className="flex gap-2 p-3 border-t border-slate-100">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void send(); }}
            placeholder="Напиши сообщение..."
            disabled={sending}
            className="flex-1 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-[13px] text-slate-700 placeholder-slate-300 focus:outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100 transition-all disabled:opacity-40"
          />
          <button
            onClick={() => void send()}
            disabled={sending || !input.trim()}
            className="px-4 py-2 rounded-xl text-[13px] font-semibold transition-all disabled:opacity-20 text-white bg-gradient-to-r from-rose-400 to-violet-400 hover:from-rose-500 hover:to-violet-500 shrink-0 shadow-sm"
          >
            Отправить
          </button>
        </div>
      </div>

      <button
        onClick={onComplete}
        className="w-full py-3 rounded-xl text-sm font-semibold transition-all text-white bg-gradient-to-r from-rose-400 to-violet-400 hover:from-rose-500 hover:to-violet-500 shadow-sm"
      >
        Перейти в панель управления
      </button>
    </div>
  );
}
