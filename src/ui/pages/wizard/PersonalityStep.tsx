import { useState } from "react";
import { PERSONALITY_SLIDERS, DEFAULT_PERSONALITY } from "../../../core/personality.js";
import { PersonalitySlider } from "./PersonalitySlider.js";

export interface PersonalityData {
  name: string;
  gender: "female" | "male";
  sliders: Record<string, number>;
  customInstructions: string;
}

interface PersonalityStepProps {
  apiKey: string;
  onNext: (data: PersonalityData) => void;
}

export function PersonalityStep({ apiKey, onNext }: PersonalityStepProps) {
  const [name, setName] = useState("Betsy");
  const [gender, setGender] = useState<"female" | "male">("female");
  const [sliders, setSliders] = useState<Record<string, number>>({ ...DEFAULT_PERSONALITY });
  const [customInstructions, setCustomInstructions] = useState("");
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  function setSlider(key: string, value: number) {
    setSliders((prev) => ({ ...prev, [key]: value }));
  }

  async function handleAvatarFile(file: File) {
    if (file.size > 5 * 1024 * 1024) return;
    const preview = URL.createObjectURL(file);
    setAvatarPreview(preview);
    setAnalyzing(true);
    try {
      const buf = await file.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(buf).reduce((data, byte) => data + String.fromCharCode(byte), "")
      );
      const res = await fetch("/api/setup/analyze-avatar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, image: base64 }),
      });
      if (res.ok) {
        const data = await res.json() as {
          ok?: boolean;
          analysis?: Record<string, unknown>;
        };
        const a = data.analysis;
        if (a) {
          const sliderKeys = ["formality","emotionality","humor","confidence","response_length","structure","emoji","examples","friendliness","initiative","curiosity","empathy","criticism"];
          const newSliders: Record<string, number> = {};
          for (const k of sliderKeys) {
            if (typeof a[k] === "number") newSliders[k] = Math.min(4, Math.max(0, a[k] as number));
          }
          if (Object.keys(newSliders).length > 0) setSliders((prev) => ({ ...prev, ...newSliders }));
          if (typeof a.name === "string") setName(a.name);
          if (a.gender === "female" || a.gender === "male") setGender(a.gender);
        }
      }
    } finally {
      setAnalyzing(false);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) void handleAvatarFile(f);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(true);
  }

  function handleDragLeave() {
    setDragOver(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void handleAvatarFile(f);
  }

  function handleNext() {
    onNext({
      name: name.trim() || "Betsy",
      gender,
      sliders,
      customInstructions: customInstructions.trim(),
    });
  }

  const inputCls =
    "w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-[14px] text-slate-700 focus:outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100 transition-all placeholder-slate-300";

  const sectionHeaderCls = "text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-3";

  const genderChipCls = (active: boolean) =>
    `flex-1 py-3 rounded-xl border text-[13px] font-medium transition-all cursor-pointer ${
      active
        ? "border-violet-300 bg-gradient-to-br from-violet-50 to-rose-50 text-slate-700 shadow-sm"
        : "border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-500"
    }`;

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-2xl font-bold text-slate-700 mb-2">Кто я? Давай разберёмся вместе.</h2>
        <p className="text-slate-400 text-sm">Настрой характер и стиль общения.</p>
      </div>

      {/* Avatar drop zone */}
      <div className="flex flex-col items-center gap-3">
        <div className="relative">
          {/* Pulsing glow */}
          {!avatarPreview && (
            <div className="absolute -inset-3 rounded-[34px] bg-gradient-to-r from-rose-300 via-violet-300 to-sky-300 opacity-30 animate-pulse blur-md pointer-events-none" />
          )}
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
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`relative w-[200px] h-[200px] rounded-[28px] overflow-hidden border-2 border-dashed transition-all cursor-pointer flex flex-col items-center justify-center gap-2 select-none ${
              dragOver
                ? "border-violet-400 bg-violet-50 scale-[1.02]"
                : avatarPreview
                ? "border-violet-300 shadow-md"
                : "border-violet-300 bg-gradient-to-br from-rose-50 via-violet-50 to-sky-50 hover:border-violet-400 shadow-lg shadow-violet-100/50"
            }`}
          >
            {avatarPreview ? (
              <img src={avatarPreview} alt="Аватар" className="w-full h-full object-cover" />
            ) : (
              <>
                <svg
                  className="w-10 h-10 text-violet-300"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z"
                  />
                </svg>
                <span className="text-[13px] font-medium text-violet-400">Загрузить аватар</span>
                <span className="text-[11px] text-slate-400">или перетащи сюда</span>
              </>
            )}
            {/* Spinner overlay during analysis */}
            {analyzing && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-white/70 rounded-[28px]">
                <div className="w-7 h-7 border-2 border-slate-200 border-t-violet-400 rounded-full animate-spin" />
                <span className="text-[12px] text-violet-500 font-medium">Анализирую...</span>
              </div>
            )}
          </button>
        </div>

        {/* Tooltip */}
        <div className="bg-gradient-to-r from-violet-50 to-rose-50 border border-violet-200/60 rounded-xl px-4 py-2.5 text-center max-w-[280px]">
          <p className="text-[12px] text-slate-500 leading-relaxed">
            Аватар — основа личности агента. Загрузи фото, и AI автоматически подберёт характер, стиль и тональность.
          </p>
        </div>
      </div>

      {/* Name */}
      <div className="space-y-2">
        <label className="text-[11px] text-slate-400 font-semibold uppercase tracking-wider block">
          Имя агента
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Betsy"
          className={inputCls}
        />
      </div>

      {/* Gender */}
      <div className="space-y-2">
        <label className="text-[11px] text-slate-400 font-semibold uppercase tracking-wider block">
          Пол
        </label>
        <div className="flex gap-2">
          {(["female", "male"] as const).map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => setGender(g)}
              className={genderChipCls(gender === g)}
            >
              {g === "female" ? "Женский" : "Мужской"}
            </button>
          ))}
        </div>
      </div>

      {/* Personality sliders — each group separated */}
      {PERSONALITY_SLIDERS.map((group) => (
        <div key={group.group} className="bg-white/60 border border-slate-200/60 rounded-xl p-4">
          <div className={sectionHeaderCls}>{group.group}</div>
          {group.sliders.map((slider) => (
            <PersonalitySlider
              key={slider.key}
              label={slider.label}
              options={[...slider.options]}
              value={sliders[slider.key] ?? 2}
              onChange={(v) => setSlider(slider.key, v)}
            />
          ))}
        </div>
      ))}

      {/* Custom instructions */}
      <div className="space-y-2">
        <label className="text-[11px] text-slate-400 font-semibold uppercase tracking-wider block">
          Дополнительные инструкции
          <span className="text-slate-300 font-normal lowercase tracking-normal ml-1">(необязательно)</span>
        </label>
        <textarea
          value={customInstructions}
          onChange={(e) => setCustomInstructions(e.target.value)}
          placeholder="Например: отвечай только на русском, используй эмодзи..."
          rows={3}
          className={`${inputCls} resize-none`}
        />
      </div>

      <button
        type="button"
        onClick={handleNext}
        className="w-full py-3 rounded-xl text-sm font-semibold transition-all text-white bg-gradient-to-r from-rose-400 to-violet-400 hover:from-rose-500 hover:to-violet-500 shadow-sm"
      >
        Далее
      </button>
    </div>
  );
}
