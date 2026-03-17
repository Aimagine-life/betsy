import { useState } from "react";

interface ApiKeyStepProps {
  onNext: (apiKey: string) => void;
}

export function ApiKeyStep({ onNext }: ApiKeyStepProps) {
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");

  function handleNext() {
    const key = apiKey.trim();
    if (!key) {
      setError("Введите API ключ");
      return;
    }
    if (key.length < 10) {
      setError("Ключ слишком короткий");
      return;
    }
    setError("");
    onNext(key);
  }

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-2xl font-bold text-zinc-100 mb-2">
          Привет! Я Betsy.
        </h2>
        <p className="text-zinc-400 text-sm">
          Давай настроим меня за 60 секунд.
        </p>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="space-y-2">
        <label className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider block">
          OpenRouter API ключ
        </label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => { setApiKey(e.target.value); setError(""); }}
          onKeyDown={(e) => { if (e.key === "Enter") handleNext(); }}
          placeholder="sk-or-..."
          className="w-full bg-zinc-900/80 border border-zinc-800/80 rounded-md px-4 py-3 text-[14px] text-zinc-300 focus:outline-none focus:border-emerald-500/50 transition-colors placeholder-zinc-600"
          autoFocus
        />
        <a
          href="https://openrouter.ai/keys"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[12px] text-emerald-400 hover:text-emerald-300 transition-colors mt-1"
        >
          Получить бесплатно
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </a>
      </div>

      <button
        onClick={handleNext}
        disabled={!apiKey.trim()}
        className="w-full py-3 rounded-lg text-sm font-semibold transition-colors disabled:opacity-30 text-white bg-emerald-600 hover:bg-emerald-500"
      >
        Далее
      </button>
    </div>
  );
}
