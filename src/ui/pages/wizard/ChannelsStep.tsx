import { useState } from "react";

export interface ChannelsData {
  browser: boolean;
  telegram: { enabled: boolean; token: string };
  max: { enabled: boolean; token: string };
}

interface ChannelsStepProps {
  onNext: (data: ChannelsData) => void;
}

export function ChannelsStep({ onNext }: ChannelsStepProps) {
  const [telegramEnabled, setTelegramEnabled] = useState(false);
  const [telegramToken, setTelegramToken] = useState("");
  const [maxEnabled, setMaxEnabled] = useState(false);
  const [maxToken, setMaxToken] = useState("");

  function handleNext() {
    onNext({
      browser: true,
      telegram: { enabled: telegramEnabled, token: telegramToken.trim() },
      max: { enabled: maxEnabled, token: maxToken.trim() },
    });
  }

  const inputCls =
    "w-full bg-zinc-900/80 border border-zinc-800/80 rounded-md px-4 py-2.5 text-[13px] text-zinc-300 focus:outline-none focus:border-emerald-500/50 transition-colors placeholder-zinc-600";

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-2xl font-bold text-zinc-100 mb-2">
          Где мне жить?
        </h2>
        <p className="text-zinc-400 text-sm">
          Выбери каналы, через которые я буду общаться.
        </p>
      </div>

      <div className="space-y-3">
        {/* Browser - always on */}
        <div className="card p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center">
                <svg className="w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                </svg>
              </div>
              <div>
                <p className="text-[14px] font-semibold text-zinc-200">Браузер</p>
                <p className="text-[11px] text-zinc-500">Встроенный веб-чат</p>
              </div>
            </div>
            <span className="text-[11px] text-emerald-400 font-semibold uppercase tracking-wider">
              Всегда вкл
            </span>
          </div>
        </div>

        {/* Telegram */}
        <div className="card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-lg border flex items-center justify-center ${
                telegramEnabled
                  ? "bg-blue-500/15 border-blue-500/20"
                  : "bg-zinc-800/50 border-zinc-800"
              }`}>
                <svg className={`w-5 h-5 ${telegramEnabled ? "text-blue-400" : "text-zinc-600"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                </svg>
              </div>
              <div>
                <p className="text-[14px] font-semibold text-zinc-200">Telegram</p>
                <p className="text-[11px] text-zinc-500">Бот в Telegram</p>
              </div>
            </div>
            <button
              onClick={() => setTelegramEnabled(!telegramEnabled)}
              className={`w-10 h-[22px] rounded-full transition-colors relative ${
                telegramEnabled ? "bg-emerald-500" : "bg-zinc-700"
              }`}
            >
              <div className={`absolute top-[3px] w-4 h-4 rounded-full bg-white transition-transform ${
                telegramEnabled ? "left-[22px]" : "left-[3px]"
              }`} />
            </button>
          </div>

          {telegramEnabled && (
            <div className="space-y-2 pl-[52px]">
              <input
                type="password"
                value={telegramToken}
                onChange={(e) => setTelegramToken(e.target.value)}
                placeholder="Токен от @BotFather"
                className={inputCls}
              />
              <p className="text-[11px] text-zinc-600 leading-relaxed">
                Открой{" "}
                <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300">
                  @BotFather
                </a>
                {" "}в Telegram, создай бота командой /newbot и вставь полученный токен.
              </p>
            </div>
          )}
        </div>

        {/* Max */}
        <div className="card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-lg border flex items-center justify-center ${
                maxEnabled
                  ? "bg-violet-500/15 border-violet-500/20"
                  : "bg-zinc-800/50 border-zinc-800"
              }`}>
                <svg className={`w-5 h-5 ${maxEnabled ? "text-violet-400" : "text-zinc-600"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
              </div>
              <div>
                <p className="text-[14px] font-semibold text-zinc-200">Max</p>
                <p className="text-[11px] text-zinc-500">Мессенджер Max</p>
              </div>
            </div>
            <button
              onClick={() => setMaxEnabled(!maxEnabled)}
              className={`w-10 h-[22px] rounded-full transition-colors relative ${
                maxEnabled ? "bg-emerald-500" : "bg-zinc-700"
              }`}
            >
              <div className={`absolute top-[3px] w-4 h-4 rounded-full bg-white transition-transform ${
                maxEnabled ? "left-[22px]" : "left-[3px]"
              }`} />
            </button>
          </div>

          {maxEnabled && (
            <div className="space-y-2 pl-[52px]">
              <input
                type="password"
                value={maxToken}
                onChange={(e) => setMaxToken(e.target.value)}
                placeholder="Токен бота Max"
                className={inputCls}
              />
            </div>
          )}
        </div>
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
