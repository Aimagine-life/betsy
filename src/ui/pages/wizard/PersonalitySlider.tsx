interface PersonalitySliderProps {
  label: string;
  options: string[];
  value: number;
  onChange: (value: number) => void;
}

export function PersonalitySlider({ label, options, value, onChange }: PersonalitySliderProps) {
  return (
    <div className="mb-4">
      <div className="text-[12px] font-semibold text-slate-500 mb-2">{label}</div>
      <div className="flex gap-1">
        {options.map((opt, i) => {
          const isActive = i === value;
          return (
            <button
              key={opt}
              type="button"
              onClick={() => onChange(i)}
              className={`flex-1 py-2 rounded-lg text-center cursor-pointer transition-all duration-200 ${
                isActive
                  ? "bg-gradient-to-b from-violet-50 to-rose-50 text-violet-600 font-bold"
                  : "text-slate-400"
              }`}
            >
              <span className="text-[10px] leading-tight">
                {opt}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
