import { useState } from "react";

interface ApiKeyStepProps {
  onNext: (apiKey: string, falApiKey: string) => void;
}

export function ApiKeyStep({ onNext }: ApiKeyStepProps) {
  const [apiKey, setApiKey] = useState("");
  const [falApiKey, setFalApiKey] = useState("");
  const [error, setError] = useState("");
  const [validating, setValidating] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [validated, setValidated] = useState(false);

  async function validate() {
    const key = apiKey.trim();
    if (!key) { setError("Введите API ключ"); return; }
    if (key.length < 10) { setError("Ключ слишком короткий"); return; }
    setError("");
    setValidating(true);
    setBalance(null);
    setValidated(false);
    try {
      const res = await fetch("/api/setup/validate-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: key }),
      });
      const data = await res.json() as { valid: boolean; error?: string; balance?: number | null };
      if (!data.valid) { setError(data.error ?? "Неверный API ключ"); return; }
      setBalance(data.balance ?? null);
      setValidated(true);
    } catch {
      setError("Не удалось проверить ключ. Проверьте интернет.");
    } finally {
      setValidating(false);
    }
  }

  function formatBalance(val: number | null): string {
    if (val === null) return "—";
    if (val === 0) return "$0.00";
    return `$${val.toFixed(2)}`;
  }

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-2xl font-bold text-slate-700 mb-2">Привет! Я Betsy.</h2>
        <p className="text-slate-400 text-sm">Давай настроим меня за 60 секунд.</p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-500">{error}</div>
      )}

      <div className="space-y-2">
        <label className="text-[11px] text-slate-400 font-semibold uppercase tracking-wider block">
          OpenRouter API ключ
        </label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => { setApiKey(e.target.value); setError(""); setValidated(false); setBalance(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") { validated ? onNext(apiKey.trim(), falApiKey.trim()) : void validate(); } }}
          placeholder="sk-or-..."
          className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-[14px] text-slate-700 focus:outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100 transition-all placeholder-slate-300"
          autoFocus
        />
        <a
          href="https://openrouter.ai/keys"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[12px] text-violet-400 hover:text-violet-500 transition-colors mt-1"
        >
          Получить бесплатно
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </a>
      </div>

      {validated && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-sm text-emerald-600 font-medium">Ключ валиден</span>
          </div>
          <span className="text-sm font-mono text-slate-600">Баланс: {formatBalance(balance)}</span>
        </div>
      )}

      <div className="space-y-2">
        <label className="text-[11px] text-slate-400 font-semibold uppercase tracking-wider block">
          FAL.AI API КЛЮЧ <span className="normal-case font-normal tracking-normal">(необязательно)</span>
        </label>
        <input
          type="password"
          value={falApiKey}
          onChange={(e) => setFalApiKey(e.target.value)}
          placeholder="key-..."
          className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-[14px] text-slate-700 focus:outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100 transition-all placeholder-slate-300"
        />
        <p className="text-[12px] text-slate-400 leading-relaxed">
          Fal.ai даёт агенту визуальные способности: генерация селфи и видео-кружочков, создание изображений по описанию, обработка и редактирование фото.
        </p>
        <a
          href="https://fal.ai/dashboard/keys"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[12px] text-violet-400 hover:text-violet-500 transition-colors mt-1"
        >
          Получить ключ
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </a>
      </div>

      {!validated ? (
        <button
          onClick={() => void validate()}
          disabled={!apiKey.trim() || validating}
          className="w-full py-3 rounded-xl text-sm font-semibold transition-all disabled:opacity-30 text-white bg-gradient-to-r from-rose-400 to-violet-400 hover:from-rose-500 hover:to-violet-500 shadow-sm"
        >
          {validating ? (
            <span className="flex items-center justify-center gap-2">
              <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Проверяю...
            </span>
          ) : "Проверить ключ"}
        </button>
      ) : (
        <button
          onClick={() => onNext(apiKey.trim(), falApiKey.trim())}
          className="w-full py-3 rounded-xl text-sm font-semibold transition-all text-white bg-gradient-to-r from-rose-400 to-violet-400 hover:from-rose-500 hover:to-violet-500 shadow-sm"
        >
          Далее
        </button>
      )}
    </div>
  );
}
