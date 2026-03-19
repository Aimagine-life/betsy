import { useState } from "react";

export interface OwnerData {
  name: string;
  addressAs: string;
  facts: string[];
  telegramOwnerId: string;
  permissions: {
    shell: boolean;
    ssh: boolean;
    browser: boolean;
    npmInstall: boolean;
  };
}

interface OwnerStepProps {
  onNext: (data: OwnerData) => void;
}

interface PermissionItem {
  key: keyof OwnerData["permissions"];
  label: string;
  description: string;
}

const PERMISSIONS: PermissionItem[] = [
  { key: "shell", label: "Shell команды", description: "Выполнение команд в терминале" },
  { key: "ssh", label: "SSH доступ", description: "Подключение к удалённым серверам" },
  { key: "browser", label: "Браузер", description: "Открытие сайтов и поиск" },
  { key: "npmInstall", label: "npm install", description: "Установка npm пакетов" },
];

export function OwnerStep({ onNext }: OwnerStepProps) {
  const [name, setName] = useState("");
  const [addressAs, setAddressAs] = useState("");
  const [facts, setFacts] = useState<string[]>([]);
  const [telegramOwnerId, setTelegramOwnerId] = useState("");
  const [permissions, setPermissions] = useState<OwnerData["permissions"]>({
    shell: true,
    ssh: false,
    browser: true,
    npmInstall: true,
  });

  function addFact() {
    setFacts((prev) => [...prev, ""]);
  }

  function updateFact(index: number, value: string) {
    setFacts((prev) => prev.map((f, i) => (i === index ? value : f)));
  }

  function removeFact(index: number) {
    setFacts((prev) => prev.filter((_, i) => i !== index));
  }

  function togglePermission(key: keyof OwnerData["permissions"]) {
    setPermissions((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function handleNext() {
    onNext({
      name: name.trim(),
      addressAs: addressAs.trim(),
      facts: facts.map((f) => f.trim()).filter(Boolean),
      telegramOwnerId: telegramOwnerId.trim(),
      permissions,
    });
  }

  const inputCls =
    "w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-[14px] text-slate-700 focus:outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100 transition-all placeholder-slate-300";

  const labelCls = "text-[11px] text-slate-400 font-semibold uppercase tracking-wider block";

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-2xl font-bold text-slate-700 mb-2">Расскажи о себе</h2>
        <p className="text-slate-400 text-sm">Чтобы я лучше тебя знала.</p>
      </div>

      {/* Name */}
      <div className="space-y-2">
        <label className={labelCls}>Имя владельца</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Константин"
          className={inputCls}
        />
      </div>

      {/* Address As */}
      <div className="space-y-2">
        <label className={labelCls}>Как обращаться</label>
        <input
          type="text"
          value={addressAs}
          onChange={(e) => setAddressAs(e.target.value)}
          placeholder="Костя, boss, шеф..."
          className={inputCls}
        />
        <p className="text-[11px] text-slate-400">Агент будет использовать это обращение в диалоге</p>
      </div>

      {/* Facts */}
      <div className="space-y-2">
        <label className={labelCls}>
          О тебе{" "}
          <span className="text-slate-300 font-normal lowercase tracking-normal">(необязательно)</span>
        </label>
        <div className="space-y-2">
          {facts.map((fact, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="text"
                value={fact}
                onChange={(e) => updateFact(i, e.target.value)}
                placeholder="Например: день рождения 4 мая, люблю пиццу..."
                className={inputCls}
              />
              <button
                type="button"
                onClick={() => removeFact(i)}
                className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-slate-300 hover:text-rose-400 hover:bg-rose-50 transition-all"
                aria-label="Удалить факт"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={addFact}
          className="flex items-center gap-1.5 text-violet-400 hover:text-violet-500 text-[13px] transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Добавить факт
        </button>
      </div>

      {/* Telegram ID */}
      <div className="space-y-2">
        <label className={labelCls}>Telegram ID владельца</label>
        <input
          type="number"
          value={telegramOwnerId}
          onChange={(e) => setTelegramOwnerId(e.target.value)}
          placeholder="Например: 123456789"
          className={inputCls}
        />
        <p className="text-[11px] text-slate-400">
          Узнай свой ID у @userinfobot в Telegram. Бот будет отвечать только тебе.
        </p>
      </div>

      {/* Permissions */}
      <div className="space-y-2">
        <label className={labelCls}>Разрешения</label>
        <div className="space-y-2">
          {PERMISSIONS.map(({ key, label, description }) => (
            <div
              key={key}
              className="bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between gap-4"
            >
              <div className="flex-1 min-w-0">
                <div className="text-[14px] font-medium text-slate-700">{label}</div>
                <div className="text-[12px] text-slate-400 mt-0.5">{description}</div>
              </div>
              <button
                type="button"
                onClick={() => togglePermission(key)}
                className={`shrink-0 w-10 h-[22px] rounded-full transition-colors relative ${
                  permissions[key]
                    ? "bg-gradient-to-r from-rose-300 to-violet-300"
                    : "bg-slate-200"
                }`}
                aria-label={`${permissions[key] ? "Выключить" : "Включить"} ${label}`}
              >
                <div
                  className={`absolute top-[3px] w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${
                    permissions[key] ? "left-[22px]" : "left-[3px]"
                  }`}
                />
              </button>
            </div>
          ))}
        </div>
      </div>

      <button
        onClick={handleNext}
        className="w-full py-3 rounded-xl text-sm font-semibold transition-all text-white bg-gradient-to-r from-rose-400 to-violet-400 hover:from-rose-500 hover:to-violet-500 shadow-sm"
      >
        Далее
      </button>
    </div>
  );
}
