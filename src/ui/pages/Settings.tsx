import { useState, useEffect, useRef } from "react";
import { useLocation, useRoute } from "wouter";
import { PERSONALITY_SLIDERS, DEFAULT_PERSONALITY } from "../../core/personality.js";
import { PersonalitySlider } from "./wizard/PersonalitySlider.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Config {
  agent?: {
    name?: string;
    gender?: "female" | "male";
    personality?: Record<string, number>;
    custom_instructions?: string;
  };
  owner?: {
    name?: string;
    address_as?: string;
    facts?: string[];
  };
  llm?: {
    api_key?: string;
    fast?: { api_key?: string; provider?: string; model?: string };
    strong?: { api_key?: string; provider?: string; model?: string };
  };
  selfies?: { fal_api_key?: string };
  skillsmp?: { api_key?: string };
  telegram?: { token?: string; owner_id?: number; enabled?: boolean };
  channels?: {
    browser?: boolean;
    telegram?: { enabled?: boolean; token?: string; owner_id?: number };
    max?: { enabled?: boolean; token?: string };
  };
  security?: {
    password_hash?: string;
    tools?: {
      shell?: boolean;
      ssh?: boolean;
      browser?: boolean;
      npm_install?: boolean;
    };
  };
}

type Toast = { text: string; type: "success" | "error" | "saving" };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const inputCls =
  "w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-[14px] text-slate-700 focus:outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100 transition-all placeholder-slate-300";

const labelCls = "text-[11px] text-slate-400 font-semibold uppercase tracking-wider block";

const sectionCls = "bg-white border border-slate-200 rounded-xl p-6 space-y-5";

const saveBtnCls =
  "px-6 py-2.5 rounded-xl text-[13px] font-semibold text-white bg-gradient-to-r from-rose-400 to-violet-400 hover:from-rose-500 hover:to-violet-500 shadow-sm transition-all disabled:opacity-40";

function Toggle({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      className={`shrink-0 w-10 h-[22px] rounded-full transition-colors relative ${
        on ? "bg-gradient-to-r from-rose-300 to-violet-300" : "bg-slate-200"
      }`}
    >
      <div
        className={`absolute top-[3px] w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${
          on ? "left-[22px]" : "left-[3px]"
        }`}
      />
    </button>
  );
}

function MaskedField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const isMasked = !editing && value === "***";

  return (
    <div className="space-y-2">
      <label className={labelCls}>{label}</label>
      <div className="flex items-center gap-2">
        <input
          type={editing ? "text" : "password"}
          value={isMasked ? "••••••••••••" : value}
          readOnly={isMasked}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={`${inputCls} flex-1`}
        />
        {!editing && (
          <button
            type="button"
            onClick={() => {
              onChange("");
              setEditing(true);
            }}
            className="shrink-0 px-3 py-2.5 rounded-xl text-[12px] font-medium text-violet-500 border border-violet-200 hover:bg-violet-50 transition-all"
          >
            Изменить
          </button>
        )}
        {editing && (
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="shrink-0 px-3 py-2.5 rounded-xl text-[12px] font-medium text-slate-400 border border-slate-200 hover:bg-slate-50 transition-all"
          >
            Скрыть
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

type TabId = "personality" | "owner" | "apikeys" | "channels" | "security";

const TABS: { id: TabId; label: string }[] = [
  { id: "personality", label: "Личность" },
  { id: "owner", label: "Владелец" },
  { id: "apikeys", label: "API ключи" },
  { id: "channels", label: "Каналы" },
  { id: "security", label: "Безопасность" },
];

// ---------------------------------------------------------------------------
// Tab: Личность
// ---------------------------------------------------------------------------

function PersonalityTab({
  config,
  onSave,
}: {
  config: Config;
  onSave: (patch: Partial<Config>) => void;
}) {
  const [name, setName] = useState(config.agent?.name ?? "Betsy");
  const [gender, setGender] = useState<"female" | "male">(config.agent?.gender ?? "female");
  const [sliders, setSliders] = useState<Record<string, number>>({
    ...DEFAULT_PERSONALITY,
    ...(config.agent?.personality ?? {}),
  });
  const [customInstructions, setCustomInstructions] = useState(
    config.agent?.custom_instructions ?? ""
  );
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  useEffect(() => {
    fetch("/api/setup/avatar")
      .then((r) => {
        if (r.ok) setAvatarUrl("/api/setup/avatar?" + Date.now());
      })
      .catch(() => {});
  }, []);

  function buildPatch(
    n = name,
    g = gender,
    s = sliders,
    ci = customInstructions
  ): Partial<Config> {
    return {
      agent: {
        ...config.agent,
        name: n.trim() || "Betsy",
        gender: g,
        personality: s,
        custom_instructions: ci.trim(),
      },
    };
  }

  function handleNameChange(v: string) {
    setName(v);
    onSave(buildPatch(v));
  }

  function handleGenderChange(g: "female" | "male") {
    setGender(g);
    onSave(buildPatch(name, g));
  }

  function handleSliderChange(key: string, value: number) {
    const newSliders = { ...sliders, [key]: value };
    setSliders(newSliders);
    onSave(buildPatch(name, gender, newSliders));
  }

  function handleCustomInstructionsChange(v: string) {
    setCustomInstructions(v);
    onSave(buildPatch(name, gender, sliders, v));
  }

  async function handleAvatarFile(file: File) {
    if (file.size > 5 * 1024 * 1024) return;
    const buf = await file.arrayBuffer();
    const base64 = btoa(
      new Uint8Array(buf).reduce((data, byte) => data + String.fromCharCode(byte), "")
    );

    // Upload avatar file
    const token = localStorage.getItem("betsy_token");
    const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const uploadRes = await fetch("/api/setup/avatar", {
      method: "POST",
      headers,
      body: buf,
    });
    if (uploadRes.ok) setAvatarUrl("/api/setup/avatar?" + Date.now());

    // AI analysis
    setAnalyzing(true);
    try {
      const res = await fetch("/api/setup/analyze-avatar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: base64 }),
      });
      if (res.ok) {
        const data = await res.json() as { ok?: boolean; analysis?: Record<string, unknown> };
        const a = data.analysis;
        if (a) {
          const sliderKeys = ["formality","emotionality","humor","confidence","response_length","structure","emoji","examples","friendliness","initiative","curiosity","empathy","criticism"];
          const newSliders: Record<string, number> = { ...sliders };
          for (const k of sliderKeys) {
            if (typeof a[k] === "number") newSliders[k] = Math.min(4, Math.max(0, a[k] as number));
          }
          const newName = typeof a.name === "string" ? a.name : name;
          const newGender = (a.gender === "female" || a.gender === "male") ? a.gender : gender;
          if (Object.keys(newSliders).length > 0) setSliders(newSliders);
          if (typeof a.name === "string") setName(newName);
          if (a.gender === "female" || a.gender === "male") setGender(newGender);
          onSave(buildPatch(newName, newGender, newSliders, customInstructions));
        }
      }
    } finally {
      setAnalyzing(false);
    }
  }

  const genderChipCls = (active: boolean) =>
    `flex-1 py-3 rounded-xl border text-[13px] font-medium transition-all cursor-pointer ${
      active
        ? "border-violet-300 bg-gradient-to-br from-violet-50 to-rose-50 text-slate-700 shadow-sm"
        : "border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-500"
    }`;

  const sectionHeaderCls = "text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-3";

  return (
    <div className="space-y-6">
      {/* Avatar */}
      <div className={sectionCls}>
        <div className={labelCls}>Аватар</div>
        <div className="flex items-center gap-5">
          <button
            type="button"
            onClick={() => {
              const input = document.createElement("input");
              input.type = "file";
              input.accept = "image/*";
              input.onchange = () => {
                const f = input.files?.[0];
                if (f) void handleAvatarFile(f);
              };
              input.click();
            }}
            className="relative w-[80px] h-[80px] rounded-2xl overflow-hidden border-2 border-dashed border-violet-300 bg-gradient-to-br from-rose-50 via-violet-50 to-sky-50 flex items-center justify-center cursor-pointer hover:border-violet-400 transition-all shrink-0"
          >
            {avatarUrl ? (
              <img src={avatarUrl} alt="Аватар" className="w-full h-full object-cover" />
            ) : (
              <svg className="w-7 h-7 text-violet-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
              </svg>
            )}
            {analyzing && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-white/80 rounded-2xl">
                <div className="w-5 h-5 border-2 border-slate-200 border-t-violet-400 rounded-full animate-spin" />
                <span className="text-[9px] text-violet-500 font-medium">Анализ...</span>
              </div>
            )}
          </button>
          <div className="text-[12px] text-slate-400 leading-relaxed">
            {analyzing
              ? "AI анализирует аватар и подбирает характер..."
              : <>Нажми на аватар, чтобы загрузить новое фото.<br />Макс. размер — 5 МБ.</>
            }
          </div>
        </div>
      </div>

      {/* Name + Gender */}
      <div className={sectionCls}>
        <div className="space-y-2">
          <label className={labelCls}>Имя агента</label>
          <input
            type="text"
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
            placeholder="Betsy"
            className={inputCls}
          />
        </div>
        <div className="space-y-2">
          <label className={labelCls}>Пол</label>
          <div className="flex gap-2">
            {(["female", "male"] as const).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => handleGenderChange(g)}
                className={genderChipCls(gender === g)}
              >
                {g === "female" ? "Женский" : "Мужской"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Personality sliders — each group in its own card */}
      {PERSONALITY_SLIDERS.map((group) => (
        <div key={group.group} className={sectionCls}>
          <div className={labelCls}>{group.group}</div>
          {group.sliders.map((slider) => (
            <PersonalitySlider
              key={slider.key}
              label={slider.label}
              options={[...slider.options]}
              value={sliders[slider.key] ?? 2}
              onChange={(v) => handleSliderChange(slider.key, v)}
            />
          ))}
        </div>
      ))}

      {/* Custom instructions */}
      <div className={sectionCls}>
        <div className="space-y-2">
          <label className={labelCls}>
            Дополнительные инструкции{" "}
            <span className="text-slate-300 font-normal lowercase tracking-normal">(необязательно)</span>
          </label>
          <textarea
            value={customInstructions}
            onChange={(e) => handleCustomInstructionsChange(e.target.value)}
            placeholder="Например: отвечай только на русском, используй эмодзи..."
            rows={4}
            className={`${inputCls} resize-none`}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: Владелец
// ---------------------------------------------------------------------------

function OwnerTab({
  config,
  onSave,
}: {
  config: Config;
  onSave: (patch: Partial<Config>) => void;
}) {
  const [ownerName, setOwnerName] = useState(config.owner?.name ?? "");
  const [addressAs, setAddressAs] = useState(config.owner?.address_as ?? "");
  const [facts, setFacts] = useState<string[]>(config.owner?.facts ?? []);

  function buildPatch(
    n = ownerName,
    a = addressAs,
    f = facts
  ): Partial<Config> {
    return {
      owner: {
        name: n.trim(),
        address_as: a.trim(),
        facts: f.map((x) => x.trim()).filter(Boolean),
      },
    };
  }

  function handleNameChange(v: string) {
    setOwnerName(v);
    onSave(buildPatch(v));
  }

  function handleAddressAsChange(v: string) {
    setAddressAs(v);
    onSave(buildPatch(ownerName, v));
  }

  function addFact() {
    const newFacts = [...facts, ""];
    setFacts(newFacts);
    // Don't save empty fact — will save when user types
  }

  function updateFact(i: number, v: string) {
    const newFacts = facts.map((f, idx) => (idx === i ? v : f));
    setFacts(newFacts);
    onSave(buildPatch(ownerName, addressAs, newFacts));
  }

  function removeFact(i: number) {
    const newFacts = facts.filter((_, idx) => idx !== i);
    setFacts(newFacts);
    onSave(buildPatch(ownerName, addressAs, newFacts));
  }

  return (
    <div className="space-y-6">
      <div className={sectionCls}>
        <div className="space-y-2">
          <label className={labelCls}>Имя владельца</label>
          <input
            type="text"
            value={ownerName}
            onChange={(e) => handleNameChange(e.target.value)}
            placeholder="Константин"
            className={inputCls}
          />
        </div>

        <div className="space-y-2">
          <label className={labelCls}>Как обращаться</label>
          <input
            type="text"
            value={addressAs}
            onChange={(e) => handleAddressAsChange(e.target.value)}
            placeholder="Костя, boss, шеф..."
            className={inputCls}
          />
          <p className="text-[11px] text-slate-400">Агент будет использовать это обращение в диалоге</p>
        </div>
      </div>

      <div className={sectionCls}>
        <div className="space-y-2">
          <label className={labelCls}>
            Факты о тебе{" "}
            <span className="text-slate-300 font-normal lowercase tracking-normal">(необязательно)</span>
          </label>
          <div className="space-y-2">
            {facts.map((fact, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="text"
                  value={fact}
                  onChange={(e) => updateFact(i, e.target.value)}
                  placeholder="Например: день рождения 4 мая..."
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
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: API ключи
// ---------------------------------------------------------------------------

function ApiKeysTab({
  config,
  onSave,
}: {
  config: Config;
  onSave: (patch: Partial<Config>) => void;
}) {
  const [openrouterKey, setOpenrouterKey] = useState(
    config.llm?.api_key ?? config.llm?.fast?.api_key ?? config.llm?.strong?.api_key ?? "",
  );
  const [falKey, setFalKey] = useState(config.selfies?.fal_api_key ?? "");
  const [skillsmpKey, setSkillsmpKey] = useState(config.skillsmp?.api_key ?? "");
  const [validating, setValidating] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [validated, setValidated] = useState(false);
  const [validateError, setValidateError] = useState("");

  async function validateKey() {
    const key = openrouterKey.trim();
    if (!key || key === "***") return;
    setValidating(true);
    setBalance(null);
    setValidated(false);
    setValidateError("");
    try {
      const res = await fetch("/api/setup/validate-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: key }),
      });
      const data = await res.json() as { valid: boolean; error?: string; balance?: number | null };
      if (!data.valid) {
        setValidateError(data.error ?? "Неверный API ключ");
        return;
      }
      setBalance(data.balance ?? null);
      setValidated(true);
    } catch {
      setValidateError("Не удалось проверить ключ");
    } finally {
      setValidating(false);
    }
  }

  function handleOpenrouterChange(v: string) {
    setOpenrouterKey(v);
    setValidated(false);
    setBalance(null);
    if (v && v !== "***") {
      onSave({ llm: { ...config.llm, api_key: v } });
    }
  }

  function handleFalKeyChange(v: string) {
    setFalKey(v);
    if (v && v !== "***") {
      onSave({ selfies: { fal_api_key: v } });
    }
  }

  function handleSkillsmpKeyChange(v: string) {
    setSkillsmpKey(v);
    if (v && v !== "***") {
      onSave({ skillsmp: { api_key: v } });
    }
  }

  function formatBalance(val: number | null): string {
    if (val === null) return "—";
    if (val === 0) return "$0.00";
    return `$${val.toFixed(2)}`;
  }

  return (
    <div className="space-y-6">
      <div className={sectionCls}>
        <MaskedField
          label="OpenRouter API ключ"
          value={openrouterKey}
          onChange={handleOpenrouterChange}
          placeholder="sk-or-..."
        />
        <div className="flex items-center gap-3 -mt-2">
          <button
            type="button"
            onClick={() => void validateKey()}
            disabled={!openrouterKey.trim() || openrouterKey === "***" || validating}
            className="px-4 py-2 rounded-xl text-[12px] font-semibold transition-all disabled:opacity-30 text-white bg-gradient-to-r from-rose-400 to-violet-400 hover:from-rose-500 hover:to-violet-500"
          >
            {validating ? "Проверяю..." : "Проверить ключ"}
          </button>
          {validated && (
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-[12px] text-emerald-600 font-medium">Валиден</span>
              <span className="text-[12px] font-mono text-slate-500 ml-1">Баланс: {formatBalance(balance)}</span>
            </div>
          )}
          {validateError && (
            <span className="text-[12px] text-rose-500 font-medium">{validateError}</span>
          )}
        </div>
      </div>
      <div className={sectionCls}>
        <MaskedField
          label="Fal.ai API ключ"
          value={falKey}
          onChange={handleFalKeyChange}
          placeholder="fal-..."
        />
        <p className="text-[11px] text-slate-400 -mt-2">
          Визуальные способности: селфи, видео-кружочки, генерация изображений.
        </p>
      </div>
      <div className={sectionCls}>
        <MaskedField
          label="SkillsMP API ключ"
          value={skillsmpKey}
          onChange={handleSkillsmpKeyChange}
          placeholder="sk_live_skillsmp_..."
        />
        <div className="space-y-1.5 -mt-2">
          <p className="text-[11px] text-slate-400">
            Маркетплейс навыков для ИИ-ассистентов. Позволяет Betsy самостоятельно
            находить и устанавливать новые навыки из 500 000+ открытых репозиториев.
          </p>
          <p className="text-[11px] text-slate-400">
            Бесплатно, лимит 500 запросов в день.{" "}
            <a
              href="https://skillsmp.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-violet-400 hover:text-violet-500 underline underline-offset-2"
            >
              Получить ключ
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: Каналы
// ---------------------------------------------------------------------------

function ChannelsTab({
  config,
  onSave,
}: {
  config: Config;
  onSave: (patch: Partial<Config>) => void;
}) {
  const telegramCfg = config.channels?.telegram ?? config.telegram;
  const maxCfg = config.channels?.max;

  const [telegramEnabled, setTelegramEnabled] = useState(
    (telegramCfg as { enabled?: boolean } | undefined)?.enabled ?? !!telegramCfg?.token
  );
  const [telegramToken, setTelegramToken] = useState(telegramCfg?.token ?? "");
  const [telegramOwnerId, setTelegramOwnerId] = useState(
    String(telegramCfg?.owner_id ?? "")
  );
  const [maxEnabled, setMaxEnabled] = useState(
    (maxCfg as { enabled?: boolean } | undefined)?.enabled ?? false
  );
  const [maxToken, setMaxToken] = useState(
    (maxCfg as { token?: string } | undefined)?.token ?? ""
  );

  function buildPatch(
    tgEnabled = telegramEnabled,
    tgToken = telegramToken,
    tgOwnerId = telegramOwnerId,
    mxEnabled = maxEnabled,
    mxToken = maxToken
  ): Partial<Config> {
    return {
      channels: {
        browser: true,
        telegram: {
          enabled: tgEnabled,
          token: tgToken && tgToken !== "***" ? tgToken : (telegramCfg?.token ?? ""),
          owner_id: tgOwnerId ? Number(tgOwnerId) : undefined,
        },
        max: {
          enabled: mxEnabled,
          token: mxToken && mxToken !== "***" ? mxToken : ((maxCfg as { token?: string } | undefined)?.token ?? ""),
        },
      },
    };
  }

  function handleTelegramToggle() {
    const v = !telegramEnabled;
    setTelegramEnabled(v);
    onSave(buildPatch(v));
  }

  function handleTelegramToken(v: string) {
    setTelegramToken(v);
    onSave(buildPatch(telegramEnabled, v));
  }

  function handleTelegramOwnerId(v: string) {
    setTelegramOwnerId(v);
    onSave(buildPatch(telegramEnabled, telegramToken, v));
  }

  function handleMaxToggle() {
    const v = !maxEnabled;
    setMaxEnabled(v);
    onSave(buildPatch(telegramEnabled, telegramToken, telegramOwnerId, v));
  }

  function handleMaxToken(v: string) {
    setMaxToken(v);
    onSave(buildPatch(telegramEnabled, telegramToken, telegramOwnerId, maxEnabled, v));
  }

  const inputCls2 =
    "w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-[13px] text-slate-700 focus:outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100 transition-all placeholder-slate-300";

  return (
    <div className="space-y-4">
      {/* Browser */}
      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-100 to-sky-100 flex items-center justify-center">
              <svg className="w-5 h-5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
              </svg>
            </div>
            <div>
              <p className="text-[14px] font-semibold text-slate-700">Браузер</p>
              <p className="text-[11px] text-slate-400">Встроенный веб-чат</p>
            </div>
          </div>
          <span className="text-[11px] text-emerald-500 font-semibold uppercase tracking-wider">Всегда вкл</span>
        </div>
      </div>

      {/* Telegram */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center transition-colors ${
              telegramEnabled ? "bg-gradient-to-br from-sky-100 to-blue-100" : "bg-slate-100"
            }`}>
              <svg className={`w-5 h-5 transition-colors ${telegramEnabled ? "text-sky-500" : "text-slate-300"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
            </div>
            <div>
              <p className="text-[14px] font-semibold text-slate-700">Telegram</p>
              <p className="text-[11px] text-slate-400">Бот в Telegram</p>
            </div>
          </div>
          <Toggle on={telegramEnabled} onToggle={handleTelegramToggle} label="Telegram toggle" />
        </div>

        {telegramEnabled && (
          <div className="space-y-2 pl-[52px]">
            <input
              type="password"
              value={telegramToken === "***" ? "" : telegramToken}
              onChange={(e) => handleTelegramToken(e.target.value)}
              placeholder={telegramToken === "***" ? "Токен сохранён (введите новый для смены)" : "Токен от @BotFather"}
              className={inputCls2}
            />
            <input
              type="text"
              value={telegramOwnerId}
              onChange={(e) => handleTelegramOwnerId(e.target.value)}
              placeholder="Telegram ID владельца"
              className={inputCls2}
            />
          </div>
        )}
      </div>

      {/* Max */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center transition-colors ${
              maxEnabled ? "bg-gradient-to-br from-violet-100 to-purple-100" : "bg-slate-100"
            }`}>
              <svg className={`w-5 h-5 transition-colors ${maxEnabled ? "text-violet-500" : "text-slate-300"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
            </div>
            <div>
              <p className="text-[14px] font-semibold text-slate-700">Max</p>
              <p className="text-[11px] text-slate-400">Мессенджер Max</p>
            </div>
          </div>
          <Toggle on={maxEnabled} onToggle={handleMaxToggle} label="Max toggle" />
        </div>

        {maxEnabled && (
          <div className="pl-[52px]">
            <input
              type="password"
              value={maxToken === "***" ? "" : maxToken}
              onChange={(e) => handleMaxToken(e.target.value)}
              placeholder={maxToken === "***" ? "Токен сохранён (введите новый для смены)" : "Токен бота Max"}
              className={inputCls2}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: Безопасность
// ---------------------------------------------------------------------------

const PERMISSIONS = [
  { key: "shell" as const, label: "Shell команды", description: "Выполнение команд в терминале" },
  { key: "ssh" as const, label: "SSH доступ", description: "Подключение к удалённым серверам" },
  { key: "browser" as const, label: "Браузер", description: "Открытие сайтов и поиск" },
  { key: "npm_install" as const, label: "npm install", description: "Установка npm пакетов" },
];

function SecurityTab({
  config,
  onSave,
}: {
  config: Config;
  onSave: (patch: Partial<Config>) => void;
}) {
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [tools, setTools] = useState({
    shell: config.security?.tools?.shell ?? true,
    ssh: config.security?.tools?.ssh ?? false,
    browser: config.security?.tools?.browser ?? true,
    npm_install: config.security?.tools?.npm_install ?? true,
  });
  const [savingPwd, setSavingPwd] = useState(false);
  const [savedPwd, setSavedPwd] = useState(false);
  const [errorPwd, setErrorPwd] = useState("");

  function toggleTool(key: keyof typeof tools) {
    const newTools = { ...tools, [key]: !tools[key] };
    setTools(newTools);
    onSave({ security: { ...config.security, tools: newTools } });
  }

  async function savePassword() {
    if (!newPassword) { setErrorPwd("Введите новый пароль"); return; }
    if (newPassword !== confirmPassword) { setErrorPwd("Пароли не совпадают"); return; }
    setSavingPwd(true);
    setSavedPwd(false);
    setErrorPwd("");
    try {
      // Verify old password via auth endpoint
      if (config.security?.password_hash) {
        const authRes = await fetch("/api/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: oldPassword }),
        });
        if (!authRes.ok) {
          throw new Error("Неверный текущий пароль");
        }
      }
      // Hash new password on server via wizard endpoint (reuse save config flow)
      const { createHash } = await import("node:crypto").catch(() => ({ createHash: null }));
      let passwordHash: string;
      if (createHash) {
        passwordHash = createHash("sha256").update(newPassword).digest("hex");
      } else {
        // Fallback: send to server for hashing via wizard
        const wizRes = await fetch("/api/setup/wizard", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: newPassword, apiKey: "", personality: null, owner: null, channels: null }),
        });
        if (!wizRes.ok) throw new Error("Ошибка смены пароля");
        setSavedPwd(true);
        setTimeout(() => setSavedPwd(false), 3000);
        setOldPassword("");
        setNewPassword("");
        setConfirmPassword("");
        return;
      }
      const patch: Partial<Config> = {
        security: { ...config.security, password_hash: passwordHash },
      };
      const token = localStorage.getItem("betsy_token");
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch("/api/config", {
        method: "POST",
        headers,
        body: JSON.stringify({ ...config, ...patch }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Ошибка" })) as { error?: string };
        throw new Error(body.error ?? "Ошибка сохранения");
      }
      onSave(patch);
      setSavedPwd(true);
      setTimeout(() => setSavedPwd(false), 3000);
      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      setErrorPwd(err instanceof Error ? err.message : "Ошибка");
    } finally {
      setSavingPwd(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Password change */}
      <div className={sectionCls}>
        <div className={`${labelCls} mb-1`}>Смена пароля</div>
        {config.security?.password_hash && (
          <div className="space-y-2">
            <label className={labelCls}>Текущий пароль</label>
            <input
              type="password"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              placeholder="Введите текущий пароль"
              className={inputCls}
            />
          </div>
        )}
        <div className="space-y-2">
          <label className={labelCls}>Новый пароль</label>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="Минимум 6 символов"
            className={inputCls}
          />
        </div>
        <div className="space-y-2">
          <label className={labelCls}>Подтверждение пароля</label>
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Повтори новый пароль"
            className={inputCls}
          />
        </div>
        <div className="flex items-center gap-4 pt-2">
          <button
            type="button"
            onClick={() => void savePassword()}
            disabled={savingPwd}
            className={saveBtnCls}
          >
            {savingPwd ? "Сохраняю..." : "Сменить пароль"}
          </button>
          {savedPwd && !savingPwd && (
            <span className="text-[12px] text-emerald-500 font-medium">Пароль изменён</span>
          )}
          {errorPwd && !savingPwd && (
            <span className="text-[12px] text-rose-500 font-medium">{errorPwd}</span>
          )}
        </div>
      </div>

      {/* Permissions */}
      <div className={sectionCls}>
        <div className={`${labelCls} mb-1`}>Разрешения инструментов</div>
        <div className="space-y-2">
          {PERMISSIONS.map(({ key, label, description }) => (
            <div
              key={key}
              className="bg-slate-50 border border-slate-100 rounded-xl p-4 flex items-center justify-between gap-4"
            >
              <div className="flex-1 min-w-0">
                <div className="text-[14px] font-medium text-slate-700">{label}</div>
                <div className="text-[12px] text-slate-400 mt-0.5">{description}</div>
              </div>
              <Toggle
                on={tools[key]}
                onToggle={() => toggleTool(key)}
                label={`${tools[key] ? "Выключить" : "Включить"} ${label}`}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Settings component
// ---------------------------------------------------------------------------

export function Settings() {
  const [, setLocation] = useLocation();
  const [, params] = useRoute("/settings/:tab");
  const tabFromUrl = params?.tab as TabId | undefined;
  const activeTab: TabId = tabFromUrl && TABS.some(t => t.id === tabFromUrl) ? tabFromUrl : "personality";
  const setActiveTab = (tab: TabId) => setLocation(`/settings/${tab}`);
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const token = localStorage.getItem("betsy_token");
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    fetch("/api/config", { headers })
      .then(async (r) => {
        if (!r.ok) throw new Error("Ошибка загрузки конфига");
        const data = await r.json() as Config & { configured?: boolean };
        setConfig(data);
      })
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : "Ошибка"))
      .finally(() => setLoading(false));
  }, []);

  async function saveConfig(patch: Partial<Config>) {
    setToast({ text: "Сохраняю...", type: "saving" });
    clearTimeout(toastTimerRef.current);
    try {
      const token = localStorage.getItem("betsy_token");
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch("/api/config", {
        method: "POST",
        headers,
        body: JSON.stringify({ ...config, ...patch }),
      });
      if (!res.ok) throw new Error("Ошибка");
      setConfig((prev) => prev ? { ...prev, ...patch } : prev);
      setToast({ text: "Сохранено", type: "success" });
      toastTimerRef.current = setTimeout(() => setToast(null), 2000);
    } catch {
      setToast({ text: "Ошибка сохранения", type: "error" });
      toastTimerRef.current = setTimeout(() => setToast(null), 4000);
    }
  }

  function debouncedSave(patch: Partial<Config>) {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => void saveConfig(patch), 500);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-5 h-5 border-2 border-slate-200 border-t-violet-400 rounded-full animate-spin" />
      </div>
    );
  }

  if (loadError || !config) {
    return (
      <div className="text-rose-400 text-sm py-10 text-center">
        {loadError || "Не удалось загрузить настройки"}
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-slate-700">Настройки</h1>
        <p className="text-[13px] text-slate-400 mt-1">Управление конфигурацией агента</p>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-slate-200 mb-6 gap-0">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2.5 text-[13px] transition-colors border-b-2 -mb-px ${
              activeTab === tab.id
                ? "border-violet-400 text-slate-700 font-semibold"
                : "border-transparent text-slate-400 hover:text-slate-500 font-medium"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "personality" && (
        <PersonalityTab config={config} onSave={debouncedSave} />
      )}
      {activeTab === "owner" && (
        <OwnerTab config={config} onSave={debouncedSave} />
      )}
      {activeTab === "apikeys" && (
        <ApiKeysTab config={config} onSave={debouncedSave} />
      )}
      {activeTab === "channels" && (
        <ChannelsTab config={config} onSave={debouncedSave} />
      )}
      {activeTab === "security" && (
        <SecurityTab config={config} onSave={debouncedSave} />
      )}

      {/* Toast */}
      {toast && (
        <div className={`fixed top-6 right-6 toast-enter px-4 py-2.5 rounded-xl shadow-lg text-sm font-medium transition-all z-50 ${
          toast.type === "success" ? "bg-emerald-50 text-emerald-600 border border-emerald-200" :
          toast.type === "error" ? "bg-red-50 text-red-500 border border-red-200" :
          "bg-slate-50 text-slate-500 border border-slate-200"
        }`}>
          {toast.text}
        </div>
      )}
    </div>
  );
}
