import { useState } from "react";
import { ApiKeyStep } from "./wizard/ApiKeyStep.js";
import { PasswordStep } from "./wizard/PasswordStep.js";
import { PersonalityStep, type PersonalityData } from "./wizard/PersonalityStep.js";
import { ChannelsStep, type ChannelsData } from "./wizard/ChannelsStep.js";
import { DoneStep } from "./wizard/DoneStep.js";

interface WizardProps {
  onComplete: () => void;
}

interface WizardData {
  apiKey: string;
  password: string;
  personality: PersonalityData | null;
  channels: ChannelsData | null;
}

const STEPS = [
  { label: "API ключ" },
  { label: "Пароль" },
  { label: "Личность" },
  { label: "Каналы" },
  { label: "Готово" },
];

export function Wizard({ onComplete }: WizardProps) {
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<WizardData>({
    apiKey: "",
    password: "",
    personality: null,
    channels: null,
  });

  async function saveWizard(finalData: WizardData) {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/setup/wizard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: finalData.apiKey,
          password: finalData.password,
          personality: finalData.personality,
          channels: finalData.channels,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Ошибка сохранения" })) as { error?: string };
        throw new Error(body.error ?? "Ошибка сохранения");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка сохранения");
    } finally {
      setSaving(false);
    }
  }

  function handleApiKey(apiKey: string) {
    setData((prev) => ({ ...prev, apiKey }));
    setStep(1);
  }

  function handlePassword(password: string) {
    setData((prev) => ({ ...prev, password }));
    setStep(2);
  }

  function handlePersonality(personality: PersonalityData) {
    setData((prev) => ({ ...prev, personality }));
    setStep(3);
  }

  function handleChannels(channels: ChannelsData) {
    const updated = { ...data, channels };
    setData(updated);
    void saveWizard(updated);
    setStep(4);
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#09090b]">
      {/* Header */}
      <header className="border-b border-zinc-800/60 px-5 py-3 bg-zinc-950/95">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center">
            <span className="text-emerald-400 font-bold text-sm">B</span>
          </div>
          <div>
            <h1 className="text-sm font-bold text-zinc-100 leading-none">Betsy</h1>
            <p className="text-[10px] text-zinc-600 leading-none mt-0.5">Настройка</p>
          </div>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center px-6 py-10">
        {/* Progress bar */}
        <div className="flex items-center gap-1 mb-10 w-full max-w-md">
          {STEPS.map((s, i) => (
            <div key={s.label} className="flex items-center gap-1 flex-1">
              <div className="flex flex-col items-center flex-1">
                <div className={`w-full h-1 rounded-full transition-colors ${
                  i <= step ? "bg-emerald-500" : "bg-zinc-800"
                }`} />
                <span className={`text-[9px] font-medium mt-1.5 ${
                  i <= step ? "text-zinc-400" : "text-zinc-700"
                }`}>
                  {s.label}
                </span>
              </div>
            </div>
          ))}
        </div>

        {error && (
          <div className="w-full max-w-md mb-4 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        {saving && (
          <div className="w-full max-w-md mb-4 flex items-center justify-center gap-2 text-zinc-500 text-sm">
            <div className="w-4 h-4 border-2 border-zinc-700 border-t-emerald-400 rounded-full animate-spin" />
            Сохраняю настройки...
          </div>
        )}

        <div className="w-full max-w-md">
          {step === 0 && <ApiKeyStep onNext={handleApiKey} />}
          {step === 1 && <PasswordStep onNext={handlePassword} />}
          {step === 2 && <PersonalityStep onNext={handlePersonality} />}
          {step === 3 && <ChannelsStep onNext={handleChannels} />}
          {step === 4 && data.channels && (
            <DoneStep channels={data.channels} onComplete={onComplete} />
          )}
        </div>
      </main>
    </div>
  );
}
