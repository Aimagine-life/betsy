import { useState, useEffect } from "react";

interface Skill {
  id: string;
  name: string;
  description: string;
  trigger: string;
  enabled: boolean;
}

export function Skills() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newTrigger, setNewTrigger] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchSkills();
  }, []);

  async function fetchSkills() {
    try {
      const res = await fetch("/api/skills");
      if (res.ok) {
        const data = await res.json() as { skills: Skill[] };
        setSkills(data.skills);
      }
    } catch { /* endpoint may not exist */ }
    setLoading(false);
  }

  async function createSkill() {
    if (!newName.trim() || !newTrigger.trim()) {
      setError("Введите имя и триггер");
      return;
    }
    setCreating(true);
    setError("");
    try {
      const res = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName.trim(),
          description: newDescription.trim(),
          trigger: newTrigger.trim(),
        }),
      });
      if (!res.ok) throw new Error("Не удалось создать скилл");
      setNewName("");
      setNewDescription("");
      setNewTrigger("");
      setShowCreate(false);
      await fetchSkills();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    } finally {
      setCreating(false);
    }
  }

  async function deleteSkill(id: string) {
    try {
      await fetch(`/api/skills/${id}`, { method: "DELETE" });
      setSkills((prev) => prev.filter((s) => s.id !== id));
    } catch { /* ignore */ }
  }

  const inputCls =
    "w-full bg-zinc-900/80 border border-zinc-800/80 rounded-md px-3 py-2.5 text-[13px] text-zinc-300 focus:outline-none focus:border-emerald-500/50 transition-colors placeholder-zinc-600";

  if (loading) {
    return (
      <div className="text-center py-32">
        <div className="w-5 h-5 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin mx-auto mb-3" />
        <p className="text-sm text-zinc-600">Загрузка...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold text-zinc-100 tracking-tight mb-1.5">Скиллы</h1>
          <p className="text-sm text-zinc-500">
            Управляй навыками агента
          </p>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="px-4 py-2 rounded-md text-[13px] font-semibold transition-colors text-white bg-emerald-600 hover:bg-emerald-500"
        >
          {showCreate ? "Отмена" : "Создать скилл"}
        </button>
      </div>

      {showCreate && (
        <div className="card p-5 space-y-4">
          <h3 className="text-sm font-bold text-zinc-200 uppercase tracking-wider">Новый скилл</h3>

          {error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-sm text-red-400">
              {error}
            </div>
          )}

          <div className="space-y-3">
            <div>
              <label className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider block mb-1.5">
                Название
              </label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Например: Генерация отчётов"
                className={inputCls}
              />
            </div>
            <div>
              <label className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider block mb-1.5">
                Описание
              </label>
              <textarea
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="Что делает этот скилл..."
                rows={2}
                className={`${inputCls} resize-none`}
              />
            </div>
            <div>
              <label className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider block mb-1.5">
                Триггер
              </label>
              <input
                type="text"
                value={newTrigger}
                onChange={(e) => setNewTrigger(e.target.value)}
                placeholder="Например: /report"
                className={inputCls}
              />
            </div>
          </div>

          <button
            onClick={() => void createSkill()}
            disabled={creating}
            className="px-5 py-2.5 rounded-md text-[13px] font-semibold transition-colors disabled:opacity-30 text-white bg-emerald-600 hover:bg-emerald-500"
          >
            {creating ? "Создаю..." : "Создать"}
          </button>
        </div>
      )}

      {skills.length === 0 ? (
        <div className="card text-center py-24">
          <p className="text-zinc-400 text-base mb-1.5">Нет скиллов</p>
          <p className="text-zinc-600 text-sm">
            Создай первый скилл для своего агента
          </p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="divide-y divide-zinc-800/40">
            {skills.map((skill) => (
              <div key={skill.id} className="flex items-center justify-between px-5 py-4 hover:bg-zinc-800/25 transition-colors">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2.5 mb-1">
                    <span className={`w-2 h-2 rounded-full ${skill.enabled ? "bg-emerald-400" : "bg-zinc-600"}`} />
                    <h3 className="text-[14px] font-semibold text-zinc-200">{skill.name}</h3>
                    <code className="text-[11px] text-zinc-600 bg-zinc-800/60 px-2 py-0.5 rounded font-mono">
                      {skill.trigger}
                    </code>
                  </div>
                  {skill.description && (
                    <p className="text-[12px] text-zinc-500 pl-[18px]">{skill.description}</p>
                  )}
                </div>
                <button
                  onClick={() => void deleteSkill(skill.id)}
                  className="text-[11px] text-zinc-600 hover:text-red-400 transition-colors font-medium ml-4 shrink-0"
                >
                  Удалить
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
