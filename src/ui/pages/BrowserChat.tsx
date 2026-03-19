import { useState, useEffect, useRef } from "react";
import { api, type ChatMessage } from "../lib/api.js";
import { MarkdownContent, formatTime } from "../lib/markdown.js";

const SUGGESTIONS = [
  "Как дела?",
  "Что ты умеешь?",
  "Расскажи о себе",
  "Помоги мне с задачей",
];

export function BrowserChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Try WebSocket connection
  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws/chat`;

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => setWsConnected(true);
      ws.onclose = () => setWsConnected(false);
      ws.onerror = () => setWsConnected(false);

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string) as { type: string; content: string; mediaUrl?: string };
          if (data.type === "message") {
            setMessages((prev) => [...prev, {
              role: "assistant",
              content: data.content,
              mediaUrl: data.mediaUrl,
              timestamp: Date.now(),
            }]);
          }
        } catch { /* ignore parse errors */ }
      };

      return () => { ws.close(); };
    } catch {
      // WebSocket not available, use HTTP fallback
      return;
    }
  }, []);

  // Load history
  useEffect(() => {
    api.getChat()
      .then((data) => setMessages(data.messages))
      .catch((err) => console.warn("Failed to load chat history:", err));
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  async function send(text?: string) {
    const msg = text ?? input.trim();
    if (!msg || sending) return;
    setInput("");
    setSending(true);

    const userMsg: ChatMessage = { role: "user", content: msg, timestamp: Date.now() };
    setMessages((prev) => [...prev, userMsg]);

    // Try WebSocket first
    if (wsConnected && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "message", content: msg }));
      setSending(false);
      textareaRef.current?.focus();
      return;
    }

    // HTTP fallback
    try {
      const { reply, mediaUrl } = await api.sendChat(msg);
      setMessages((prev) => [...prev, { role: "assistant", content: reply, mediaUrl, timestamp: Date.now() }]);
    } catch (err) {
      setMessages((prev) => [...prev, {
        role: "assistant",
        content: `[ERROR] ${err instanceof Error ? err.message : "Failed to respond"}`,
        timestamp: Date.now(),
      }]);
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  }

  async function handleClear() {
    await api.clearChat();
    setMessages([]);
  }

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-3xl font-bold text-slate-700 tracking-tight mb-1.5">Чат</h1>
          <p className="text-sm text-slate-400">
            Общайся с агентом напрямую
            {wsConnected && (
              <span className="inline-flex items-center gap-1 ml-2 text-emerald-500 text-[11px]">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                WebSocket
              </span>
            )}
          </p>
        </div>
        {messages.length > 0 && (
          <button
            onClick={() => void handleClear()}
            className="text-[12px] text-slate-400 hover:text-slate-600 transition-colors font-medium"
          >
            Очистить историю
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto card mb-3">
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center max-w-md">
              <p className="text-slate-700 text-base font-semibold mb-1">Начни разговор</p>
              <p className="text-slate-400 text-sm mb-5">Спроси агента о чём угодно</p>
              <div className="grid grid-cols-2 gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => void send(s)}
                    className="text-left px-3.5 py-2.5 rounded-md border border-slate-200 bg-white text-[13px] text-slate-500 hover:text-violet-500 hover:border-violet-300 transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="p-5 space-y-3">
            {messages.map((msg, i) => (
              <div
                key={`${msg.timestamp}-${msg.role}-${i}`}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div className={`max-w-[75%] rounded-lg px-4 py-3 ${
                  msg.role === "user"
                    ? "bg-gradient-to-r from-rose-100 to-violet-100 text-slate-700"
                    : "bg-slate-50 border border-slate-200 text-slate-600"
                }`}>
                  {msg.mediaUrl && (
                    <img
                      src={msg.mediaUrl}
                      alt="selfie"
                      className="rounded-md max-w-full mb-2"
                      loading="lazy"
                    />
                  )}
                  <div><MarkdownContent text={msg.content} /></div>
                  <p className="text-[10px] mt-2 text-slate-400 tabular-nums font-mono">{formatTime(msg.timestamp)}</p>
                </div>
              </div>
            ))}

            {sending && (
              <div className="flex justify-start">
                <div className="bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
                  <span className="text-[13px] text-slate-400">Думаю...</span>
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <div className="flex gap-2.5 items-end">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
          placeholder="Напиши сообщение..."
          disabled={sending}
          rows={1}
          className="flex-1 bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-[13px] text-slate-700 placeholder-slate-300 focus:outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100 transition-colors disabled:opacity-40 resize-none leading-relaxed"
        />
        <button
          onClick={() => void send()}
          disabled={sending || !input.trim()}
          className="px-5 py-3 rounded-xl text-[13px] font-semibold transition-colors disabled:opacity-20 text-white bg-gradient-to-r from-rose-400 to-violet-400 hover:from-rose-500 hover:to-violet-500 shrink-0"
        >
          Отправить
        </button>
      </div>
    </div>
  );
}
