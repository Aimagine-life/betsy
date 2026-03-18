import { useState } from "react";

export interface PersonalityData {
  name: string;
  gender: "female" | "male" | "neutral";
  tone: string;
  responseStyle: string;
  customInstructions: string;
}

interface PersonalityStepProps {
  onNext: (data: PersonalityData) => void;
}

const TONES = [
  { value: "fun", label: "Веселая", icon: "M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" },
  { value: "serious", label: "Серьёзная", icon: "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" },
  { value: "bold", label: "Дерзкая", icon: "M13 10V3L4 14h7v7l9-11h-7z" },
  { value: "professional", label: "Профессиональная", icon: "M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" },
];

const GENDERS = [
  { value: "female", label: "Женский" },
  { value: "male", label: "Мужской" },
  { value: "neutral", label: "Нейтральный" },
];

const STYLES = [
  { value: "concise", label: "Кратко" },
  { value: "detailed", label: "Подробно" },
];

export function PersonalityStep({ onNext }: PersonalityStepProps) {
  const [name, setName] = useState("Betsy");
  const [gender, setGender] = useState<"female" | "male" | "neutral">("female");
  const [tone, setTone] = useState("professional");
  const [responseStyle, setResponseStyle] = useState("concise");
  const [customInstructions, setCustomInstructions] = useState("");

  function handleNext() {
    onNext({ name: name.trim() || "Betsy", gender, tone, responseStyle, customInstructions: customInstructions.trim() });
  }

  const inputCls =
    "w-full bg-zinc-900/80 border border-zinc-800/80 rounded-md px-4 py-3 text-[14px] text-zinc-300 focus:outline-none focus:border-emerald-500/50 transition-colors placeholder-zinc-600";

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-2xl font-bold text-zinc-100 mb-2">
          Кто я? Давай разберёмся вместе.
        </h2>
        <p className="text-zinc-400 text-sm">
          Настрой характер и стиль общения.
        </p>
      </div>

      <div className="space-y-2">
        <label className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider block">
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

      <div className="space-y-2">
        <label className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider block">
          Пол
        </label>
        <div className="grid grid-cols-3 gap-2">
          {GENDERS.map((g) => (
            <button
              key={g.value}
              onClick={() => setGender(g.value as typeof gender)}
              className={`px-4 py-3 rounded-lg border text-[13px] font-medium transition-all ${
                gender === g.value
                  ? "border-emerald-500/40 bg-emerald-500/10 text-zinc-200"
                  : "border-zinc-800/80 bg-zinc-900/40 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300"
              }`}
            >
              {g.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider block">
          Тональность
        </label>
        <div className="grid grid-cols-2 gap-2">
          {TONES.map((t) => (
            <button
              key={t.value}
              onClick={() => setTone(t.value)}
              className={`flex items-center gap-2.5 px-4 py-3 rounded-lg border transition-all ${
                tone === t.value
                  ? "border-emerald-500/40 bg-emerald-500/10 text-zinc-200"
                  : "border-zinc-800/80 bg-zinc-900/40 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300"
              }`}
            >
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d={t.icon} />
              </svg>
              <span className="text-[13px] font-medium">{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider block">
          Стиль ответов
        </label>
        <div className="grid grid-cols-2 gap-2">
          {STYLES.map((s) => (
            <button
              key={s.value}
              onClick={() => setResponseStyle(s.value)}
              className={`px-4 py-3 rounded-lg border text-[13px] font-medium transition-all ${
                responseStyle === s.value
                  ? "border-emerald-500/40 bg-emerald-500/10 text-zinc-200"
                  : "border-zinc-800/80 bg-zinc-900/40 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider block">
          Дополнительные инструкции
          <span className="text-zinc-600 font-normal lowercase tracking-normal ml-1">(необязательно)</span>
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
        onClick={handleNext}
        className="w-full py-3 rounded-lg text-sm font-semibold transition-colors text-white bg-emerald-600 hover:bg-emerald-500"
      >
        Далее
      </button>
    </div>
  );
}
