import { useMemo } from "react";

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit" });
}

export function MarkdownContent({ text }: { text: string }) {
  const elements = useMemo(() => parseMarkdown(text), [text]);
  return <>{elements}</>;
}

function parseMarkdown(text: string): React.ReactNode[] {
  const lines = text.split("\n");
  const result: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      result.push(
        <pre key={key++} className="bg-zinc-950 border border-zinc-800/60 rounded-md px-3.5 py-2.5 my-2 overflow-x-auto">
          {lang && <span className="text-[10px] text-zinc-600 block mb-1 font-mono uppercase">{lang}</span>}
          <code className="text-[13px] text-zinc-300 font-mono leading-relaxed">{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    if (line.trim() === "") {
      result.push(<div key={key++} className="h-1.5" />);
      i++;
      continue;
    }

    if (/^[-*]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s/, ""));
        i++;
      }
      result.push(
        <ul key={key++} className="list-none space-y-0.5 my-1">
          {items.map((item, idx) => (
            <li key={idx} className="flex gap-2 text-[13px] text-zinc-300 leading-relaxed">
              <span className="text-zinc-600 shrink-0">-</span>
              <span>{renderInline(item)}</span>
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\d+[.)]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+[.)]\s/, ""));
        i++;
      }
      result.push(
        <ol key={key++} className="list-none space-y-0.5 my-1">
          {items.map((item, idx) => (
            <li key={idx} className="flex gap-2 text-[13px] text-zinc-300 leading-relaxed">
              <span className="text-zinc-600 shrink-0 tabular-nums w-4 text-right">{idx + 1}.</span>
              <span>{renderInline(item)}</span>
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    result.push(
      <p key={key++} className="text-[13px] text-zinc-300 leading-relaxed">{renderInline(line)}</p>,
    );
    i++;
  }

  return result;
}

function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith("`")) {
      parts.push(<code key={match.index} className="bg-zinc-800 text-zinc-300 px-1.5 py-0.5 rounded-sm text-[12px] font-mono">{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      parts.push(<strong key={match.index} className="text-zinc-200 font-semibold">{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*")) {
      parts.push(<em key={match.index} className="text-zinc-300 italic">{token.slice(1, -1)}</em>);
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}
