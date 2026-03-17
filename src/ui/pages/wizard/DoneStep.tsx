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
      setMessages((prev) => [...prev, { role: "assistant", content: "Пока не могу ответить. Завершите настройку!" }]);
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
        <div className="w-16 h-16 rounded-2xl bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center mx-auto mb-4">
          <svg className="w-8 h-8 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h2 className="text-2xl font-bold text-zinc-100 mb-2">
          Я готова!
        </h2>
        <p className="text-zinc-400 text-sm">
          Поговори со мной или перейди в панель управления.
        </p>
      </div>

      {/* Connected channels */}
      <div className="flex items-center justify-center gap-2 flex-wrap">
        {enabledChannels.map((ch) => (
          <span
            key={ch}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-[12px] text-emerald-400 font-medium"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            {ch}
          </span>
        ))}
      </div>

      {/* Mini chat */}
      <div className="card overflow-hidden">
        <div className="h-[200px] overflow-y-auto p-4 space-y-2">
          {messages.length === 0 && (
            <p className="text-zinc-600 text-sm text-center pt-16">
              Напиши что-нибудь, чтобы проверить!
            </p>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[80%] rounded-lg px-3.5 py-2 text-[13px] ${
                msg.role === "user"
                  ? "bg-zinc-800 text-zinc-200"
                  : "bg-zinc-900/80 border border-zinc-800/60 text-zinc-300"
              }`}>
                {msg.content}
              </div>
            </div>
          ))}
          {sending && (
            <div className="flex justify-start">
              <div className="bg-zinc-900/80 border border-zinc-800/60 rounded-lg px-3.5 py-2 text-[13px] text-zinc-500">
                Думаю...
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
        <div className="flex gap-2 p-3 border-t border-zinc-800/60">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void send(); }}
            placeholder="Напиши сообщение..."
            disabled={sending}
            className="flex-1 bg-zinc-900/80 border border-zinc-800/80 rounded-md px-3 py-2 text-[13px] text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-emerald-500/50 transition-colors disabled:opacity-40"
          />
          <button
            onClick={() => void send()}
            disabled={sending || !input.trim()}
            className="px-4 py-2 rounded-md text-[13px] font-semibold transition-colors disabled:opacity-20 text-white bg-emerald-600 hover:bg-emerald-500 shrink-0"
          >
            Отправить
          </button>
        </div>
      </div>

      <button
        onClick={onComplete}
        className="w-full py-3 rounded-lg text-sm font-semibold transition-colors text-white bg-emerald-600 hover:bg-emerald-500"
      >
        Перейти в панель управления
      </button>
    </div>
  );
}
