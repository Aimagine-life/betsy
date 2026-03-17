import { useState } from "react";

interface PasswordStepProps {
  onNext: (password: string) => void;
}

export function PasswordStep({ onNext }: PasswordStepProps) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");

  function handleNext() {
    if (password.length < 8) {
      setError("Минимум 8 символов");
      return;
    }
    if (password !== confirm) {
      setError("Пароли не совпадают");
      return;
    }
    setError("");
    onNext(password);
  }

  const inputCls =
    "w-full bg-zinc-900/80 border border-zinc-800/80 rounded-md px-4 py-3 text-[14px] text-zinc-300 focus:outline-none focus:border-emerald-500/50 transition-colors placeholder-zinc-600";

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-2xl font-bold text-zinc-100 mb-2">
          Придумай пароль
        </h2>
        <p className="text-zinc-400 text-sm">
          Для защиты настроек. Минимум 8 символов.
        </p>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="space-y-4">
        <div className="space-y-2">
          <label className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider block">
            Пароль
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError(""); }}
            placeholder="Минимум 8 символов"
            className={inputCls}
            autoFocus
          />
        </div>

        <div className="space-y-2">
          <label className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider block">
            Подтверждение пароля
          </label>
          <input
            type="password"
            value={confirm}
            onChange={(e) => { setConfirm(e.target.value); setError(""); }}
            onKeyDown={(e) => { if (e.key === "Enter") handleNext(); }}
            placeholder="Повторите пароль"
            className={inputCls}
          />
        </div>
      </div>

      {password.length > 0 && (
        <div className="flex items-center gap-2">
          <div className={`h-1 flex-1 rounded-full ${password.length >= 8 ? "bg-emerald-500" : "bg-zinc-700"}`} />
          <div className={`h-1 flex-1 rounded-full ${password.length >= 12 ? "bg-emerald-500" : "bg-zinc-700"}`} />
          <div className={`h-1 flex-1 rounded-full ${password.length >= 16 ? "bg-emerald-500" : "bg-zinc-700"}`} />
          <span className="text-[11px] text-zinc-500 ml-1">
            {password.length < 8 ? "Слабый" : password.length < 12 ? "Нормальный" : "Сильный"}
          </span>
        </div>
      )}

      <button
        onClick={handleNext}
        disabled={password.length < 8 || !confirm}
        className="w-full py-3 rounded-lg text-sm font-semibold transition-colors disabled:opacity-30 text-white bg-emerald-600 hover:bg-emerald-500"
      >
        Далее
      </button>
    </div>
  );
}
