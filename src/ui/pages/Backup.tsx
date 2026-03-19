import { useState, useRef } from "react";

export function Backup() {
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleExport() {
    setExporting(true);
    setError("");
    setMessage("");
    try {
      const res = await fetch("/api/backup/export");
      if (!res.ok) throw new Error("Не удалось экспортировать");

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `betsy-backup-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setMessage("Бэкап успешно скачан!");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка экспорта");
    } finally {
      setExporting(false);
    }
  }

  async function handleImport() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;

    setImporting(true);
    setError("");
    setMessage("");
    try {
      const formData = new FormData();
      formData.append("backup", file);

      const res = await fetch("/api/backup/import", {
        method: "POST",
        body: formData,
      });
      if (!res.ok) throw new Error("Не удалось импортировать");

      setMessage("Бэкап успешно восстановлен! Перезагрузите страницу.");
      if (fileRef.current) fileRef.current.value = "";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка импорта");
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-700 tracking-tight mb-1.5">Бэкап</h1>
        <p className="text-sm text-slate-400">
          Экспорт и импорт настроек агента
        </p>
      </div>

      {message && (
        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-4 py-3 text-sm text-emerald-600">
          {message}
        </div>
      )}

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* Export */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div>
            <h2 className="text-lg font-bold text-slate-700 mb-1">Экспорт</h2>
            <p className="text-[13px] text-slate-400 leading-relaxed">
              Скачать архив с настройками, памятью и историей чатов.
            </p>
          </div>

          <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 space-y-2">
            <p className="text-[12px] text-slate-500 font-medium">Что входит в бэкап:</p>
            <ul className="space-y-1">
              <li className="flex items-center gap-2 text-[12px] text-slate-400">
                <svg className="w-3.5 h-3.5 text-emerald-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                Конфигурация агента
              </li>
              <li className="flex items-center gap-2 text-[12px] text-slate-400">
                <svg className="w-3.5 h-3.5 text-emerald-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                Память и знания
              </li>
              <li className="flex items-center gap-2 text-[12px] text-slate-400">
                <svg className="w-3.5 h-3.5 text-emerald-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                История чатов
              </li>
              <li className="flex items-center gap-2 text-[12px] text-slate-400">
                <svg className="w-3.5 h-3.5 text-emerald-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                Настройки скиллов
              </li>
            </ul>
          </div>

          <button
            onClick={() => void handleExport()}
            disabled={exporting}
            className="w-full py-3 rounded-xl text-sm font-semibold transition-colors disabled:opacity-30 text-white bg-gradient-to-r from-rose-400 to-violet-400 hover:from-rose-500 hover:to-violet-500 flex items-center justify-center gap-2"
          >
            {exporting ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Экспортирую...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Скачать бэкап
              </>
            )}
          </button>
        </div>

        {/* Import */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div>
            <h2 className="text-lg font-bold text-slate-700 mb-1">Импорт</h2>
            <p className="text-[13px] text-slate-400 leading-relaxed">
              Восстановить настройки из ранее сохранённого архива.
            </p>
          </div>

          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
            <p className="text-[12px] text-amber-600 leading-relaxed">
              Внимание: импорт перезапишет текущие настройки. Рекомендуем сначала сделать экспорт.
            </p>
          </div>

          <div className="space-y-3">
            <input
              ref={fileRef}
              type="file"
              accept=".zip"
              className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-[13px] text-slate-500 file:mr-4 file:py-1 file:px-3 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-slate-100 file:text-slate-600 hover:file:bg-slate-200 file:transition-colors file:cursor-pointer"
            />

            <button
              onClick={() => void handleImport()}
              disabled={importing}
              className="w-full py-3 rounded-xl text-sm font-semibold transition-colors disabled:opacity-30 text-slate-600 bg-slate-100 hover:bg-slate-200 border border-slate-200 flex items-center justify-center gap-2"
            >
              {importing ? (
                <>
                  <div className="w-4 h-4 border-2 border-slate-300 border-t-slate-500 rounded-full animate-spin" />
                  Импортирую...
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  Восстановить из бэкапа
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
