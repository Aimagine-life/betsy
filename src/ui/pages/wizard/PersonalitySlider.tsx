interface PersonalitySliderProps {
  label: string;
  options: string[];
  value: number;
  onChange: (value: number) => void;
}

export function PersonalitySlider({ label, options, value, onChange }: PersonalitySliderProps) {
  return (
    <div className="mb-5">
      <div className="text-[12px] font-semibold text-slate-500 mb-2">{label}</div>
      <div className="relative mx-2">
        <div className="h-1.5 rounded-full bg-gradient-to-r from-rose-200 via-violet-200 to-sky-200" />
        <div
          className="absolute top-1/2 w-4 h-4 bg-white border-[3px] border-violet-400 rounded-full shadow-md transition-all duration-300"
          style={{ left: `${value * 25}%`, transform: 'translate(-50%, -50%)' }}
        />
      </div>
      <div className="flex justify-between mx-1 mt-1">
        {options.map((opt, i) => (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(i)}
            className="flex-1 text-center pt-1 relative"
          >
            <div className={`w-0.5 h-1 mx-auto mb-0.5 rounded-full ${i === value ? 'bg-violet-400' : 'bg-slate-200'}`} />
            <span className={`text-[9px] leading-tight transition-all ${
              i === value
                ? 'text-violet-700 font-bold text-[10px]'
                : 'text-slate-300 hover:text-slate-400'
            }`}>
              {opt}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
