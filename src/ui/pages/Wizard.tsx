import { useState } from "react";
import { useLocation, useRoute } from "wouter";
import { ApiKeyStep } from "./wizard/ApiKeyStep.js";
import { PasswordStep } from "./wizard/PasswordStep.js";
import { PersonalityStep, type PersonalityData } from "./wizard/PersonalityStep.js";
import { OwnerStep, type OwnerData } from "./wizard/OwnerStep.js";
import { ChannelsStep, type ChannelsData } from "./wizard/ChannelsStep.js";
import { DoneStep } from "./wizard/DoneStep.js";

interface WizardProps {
  onComplete: () => void;
}

interface WizardData {
  apiKey: string;
  falApiKey: string;
  password: string;
  personality: PersonalityData | null;
  owner: OwnerData | null;
  channels: ChannelsData | null;
}

const STEPS = [
  { slug: "api-key", label: "API ключ" },
  { slug: "password", label: "Пароль" },
  { slug: "personality", label: "Личность" },
  { slug: "owner", label: "Владелец" },
  { slug: "channels", label: "Каналы" },
  { slug: "done", label: "Готово" },
];

export function Wizard({ onComplete }: WizardProps) {
  const [, setLocation] = useLocation();
  const [, params] = useRoute("/setup/:step");
  const currentSlug = params?.step ?? "api-key";
  const stepIndex = Math.max(0, STEPS.findIndex((s) => s.slug === currentSlug));

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<WizardData>({
    apiKey: "",
    falApiKey: "",
    password: "",
    personality: null,
    owner: null,
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
          falApiKey: finalData.falApiKey,
          password: finalData.password,
          personality: finalData.personality,
          owner: finalData.owner,
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

  function handleApiKey(apiKey: string, falApiKey: string) {
    setData((prev) => ({ ...prev, apiKey, falApiKey }));
    setLocation("/setup/password");
  }

  function handlePassword(password: string) {
    setData((prev) => ({ ...prev, password }));
    setLocation("/setup/personality");
  }

  function handlePersonality(personality: PersonalityData) {
    setData((prev) => ({ ...prev, personality }));
    setLocation("/setup/owner");
  }

  function handleOwner(owner: OwnerData) {
    setData((prev) => ({ ...prev, owner }));
    setLocation("/setup/channels");
  }

  function handleChannels(channels: ChannelsData) {
    const updated = { ...data, channels };
    setData(updated);
    void saveWizard(updated);
    setLocation("/setup/done");
  }

  return (
    <div className="wizard-bg min-h-screen flex flex-col">
      {/* Header */}
      <header className="border-b border-rose-100/60 px-5 py-3 bg-white/60 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-rose-200 to-violet-200 flex items-center justify-center shadow-sm">
            <span className="text-rose-500 font-bold text-sm">B</span>
          </div>
          <div>
            <h1 className="text-sm font-bold text-slate-700 leading-none">Betsy</h1>
            <p className="text-[10px] text-slate-400 leading-none mt-0.5">Настройка</p>
          </div>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center px-6 py-10">
        {/* Progress bar */}
        <div className="flex items-center gap-1.5 mb-10 w-full max-w-md">
          {STEPS.map((s, i) => (
            <div key={s.slug} className="flex items-center gap-1 flex-1">
              <div className="flex flex-col items-center flex-1">
                <div className={`w-full h-1.5 rounded-full transition-all duration-500 ${
                  i <= stepIndex
                    ? "bg-gradient-to-r from-rose-300 via-violet-300 to-sky-300"
                    : "bg-slate-200/60"
                }`} />
                <span className={`text-[9px] font-semibold mt-1.5 transition-colors ${
                  i <= stepIndex ? "text-slate-500" : "text-slate-300"
                }`}>
                  {s.label}
                </span>
              </div>
            </div>
          ))}
        </div>

        {error && (
          <div className="w-full max-w-md mb-4 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-500">
            {error}
          </div>
        )}

        {saving && (
          <div className="w-full max-w-md mb-4 flex items-center justify-center gap-2 text-slate-400 text-sm">
            <div className="w-4 h-4 border-2 border-slate-200 border-t-violet-400 rounded-full animate-spin" />
            Сохраняю настройки...
          </div>
        )}

        {/* Active step with animated glow border */}
        <div className="w-full max-w-md wizard-glow p-6">
          {currentSlug === "api-key" && <ApiKeyStep onNext={handleApiKey} />}
          {currentSlug === "password" && <PasswordStep onNext={handlePassword} />}
          {currentSlug === "personality" && <PersonalityStep apiKey={data.apiKey} onNext={handlePersonality} />}
          {currentSlug === "owner" && <OwnerStep onNext={handleOwner} />}
          {currentSlug === "channels" && <ChannelsStep onNext={handleChannels} />}
          {currentSlug === "done" && data.channels && (
            <DoneStep channels={data.channels} onComplete={onComplete} />
          )}
        </div>
      </main>

      <footer className="text-center py-4 text-[10px] text-slate-300">
        <a href="https://github.com/pinkocto" target="_blank" rel="noopener noreferrer" className="hover:text-violet-400 transition-colors">
          by pinkocto
        </a>
      </footer>
    </div>
  );
}
