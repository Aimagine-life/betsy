import { useState } from "react";

interface PasswordStepProps {
  onNext: (password: string) => void;
}

export function PasswordStep({ onNext }: PasswordStepProps) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");

  function handleNext() {
    if (password.length < 8) { setError("Минимум 8 символов"); return; }
    if (password !== confirm) { setError("Пароли не совпадают"); return; }
    setError("");
    onNext(password);
  }

  const inputCls =
    "w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-[14px] text-slate-700 focus:outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100 transition-all placeholder-slate-300";

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-2xl font-bold text-slate-700 mb-2">Придумай пароль</h2>
        <p className="text-slate-400 text-sm">Для защиты настроек. Минимум 8 символов.</p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-500">{error}</div>
      )}

      <div className="space-y-4">
        <div className="space-y-2">
          <label className="text-[11px] text-slate-400 font-semibold uppercase tracking-wider block">Пароль</label>
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
          <label className="text-[11px] text-slate-400 font-semibold uppercase tracking-wider block">Подтверждение пароля</label>
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
          <div className={`h-1.5 flex-1 rounded-full transition-colors ${password.length >= 8 ? "bg-gradient-to-r from-rose-300 to-amber-300" : "bg-slate-200"}`} />
          <div className={`h-1.5 flex-1 rounded-full transition-colors ${password.length >= 12 ? "bg-gradient-to-r from-amber-300 to-emerald-300" : "bg-slate-200"}`} />
          <div className={`h-1.5 flex-1 rounded-full transition-colors ${password.length >= 16 ? "bg-gradient-to-r from-emerald-300 to-sky-300" : "bg-slate-200"}`} />
          <span className="text-[11px] text-slate-400 ml-1">
            {password.length < 8 ? "Слабый" : password.length < 12 ? "Нормальный" : "Сильный"}
          </span>
        </div>
      )}

      <button
        onClick={handleNext}
        disabled={password.length < 8 || !confirm}
        className="w-full py-3 rounded-xl text-sm font-semibold transition-all disabled:opacity-30 text-white bg-gradient-to-r from-rose-400 to-violet-400 hover:from-rose-500 hover:to-violet-500 shadow-sm"
      >
        Далее
      </button>
    </div>
  );
}
