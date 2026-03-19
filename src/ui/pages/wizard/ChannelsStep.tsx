import { useState } from "react";

export interface ChannelsData {
  browser: boolean;
  telegram: { enabled: boolean; token: string; ownerId: string };
  max: { enabled: boolean; token: string };
}

interface ChannelsStepProps {
  onNext: (data: ChannelsData) => void;
}

export function ChannelsStep({ onNext }: ChannelsStepProps) {
  const [telegramEnabled, setTelegramEnabled] = useState(false);
  const [telegramToken, setTelegramToken] = useState("");
  const [telegramOwnerId, setTelegramOwnerId] = useState("");
  const [maxEnabled, setMaxEnabled] = useState(false);
  const [maxToken, setMaxToken] = useState("");

  function handleNext() {
    onNext({
      browser: true,
      telegram: { enabled: telegramEnabled, token: telegramToken.trim(), ownerId: telegramOwnerId.trim() },
      max: { enabled: maxEnabled, token: maxToken.trim() },
    });
  }

  const inputCls =
    "w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-[13px] text-slate-700 focus:outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100 transition-all placeholder-slate-300";

  const toggleCls = (on: boolean) =>
    `w-10 h-[22px] rounded-full transition-colors relative ${on ? "bg-gradient-to-r from-rose-300 to-violet-300" : "bg-slate-200"}`;

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-2xl font-bold text-slate-700 mb-2">Где мне жить?</h2>
        <p className="text-slate-400 text-sm">Выбери каналы, через которые я буду общаться.</p>
      </div>

      <div className="space-y-3">
        {/* Browser */}
        <div className="wizard-card p-4">
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
        <div className="wizard-card p-4 space-y-3">
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
            <button aria-label="Telegram toggle" onClick={() => setTelegramEnabled(!telegramEnabled)} className={toggleCls(telegramEnabled)}>
              <div className={`absolute top-[3px] w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${
                telegramEnabled ? "left-[22px]" : "left-[3px]"
              }`} />
            </button>
          </div>

          {telegramEnabled && (
            <div className="space-y-2 pl-[52px]">
              <input type="password" value={telegramToken} onChange={(e) => setTelegramToken(e.target.value)} placeholder="Токен от @BotFather" className={inputCls} />
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Открой{" "}
                <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="text-violet-400 hover:text-violet-500">@BotFather</a>
                {" "}в Telegram, создай бота командой /newbot и вставь полученный токен.
              </p>
              <input type="text" value={telegramOwnerId} onChange={(e) => setTelegramOwnerId(e.target.value)} placeholder="Например: 123456789" className={inputCls} />
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Telegram ID владельца. Узнай свой ID у{" "}
                <a href="https://t.me/userinfobot" target="_blank" rel="noopener noreferrer" className="text-violet-400 hover:text-violet-500">
                  @userinfobot
                </a>
                . Бот будет отвечать только тебе.
              </p>
            </div>
          )}
        </div>

        {/* Max */}
        <div className="wizard-card p-4 space-y-3">
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
            <button aria-label="Max toggle" onClick={() => setMaxEnabled(!maxEnabled)} className={toggleCls(maxEnabled)}>
              <div className={`absolute top-[3px] w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${
                maxEnabled ? "left-[22px]" : "left-[3px]"
              }`} />
            </button>
          </div>

          {maxEnabled && (
            <div className="space-y-2 pl-[52px]">
              <input type="password" value={maxToken} onChange={(e) => setMaxToken(e.target.value)} placeholder="Токен бота Max" className={inputCls} />
            </div>
          )}
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
