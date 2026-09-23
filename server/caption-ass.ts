import {
  captionGroups,
  captionLook,
  readableOn,
  type CaptionDocument,
} from "../shared/captions";
export function renderDimensions(doc: CaptionDocument) {
  const short = doc.resolution === "1080p" ? 1080 : 720;
  const [a, b] = doc.format.split(":").map(Number);
  return a <= b
    ? [short, Math.round((short * b) / a / 2) * 2]
    : [Math.round((short * a) / b / 2) * 2, short];
}
export function captionAss(doc: CaptionDocument) {
  const [width, height] = renderDimensions(doc),
    look = captionLook(doc);
  const color = (hex: string) =>
    "&H00" + hex.slice(5, 7) + hex.slice(3, 5) + hex.slice(1, 3);
  const escape = (text: string) =>
    text
      .replaceAll("\\", "＼")
      .replaceAll("{", "｛")
      .replaceAll("}", "｝")
      .replace(/[\r\n]/g, " ");
  const time = (s: number) => {
    const n = Math.round(s * 100);
    return `${Math.floor(n / 360000)}:${String(Math.floor(n / 6000) % 60).padStart(2, "0")}:${String(Math.floor(n / 100) % 60).padStart(2, "0")}.${String(n % 100).padStart(2, "0")}`;
  };
  const font = Math.round(width * 0.053 * (look.size || 1)),
    y = Math.round(
      height *
        (doc.position === "top" ? 0.2 : doc.position === "middle" ? 0.5 : 0.77),
    );
  // Style-level colours approximate the browser renderer within libass limits.
  const st = doc.style, accent = color(look.accent!);
  const primary = st === "banner" ? color(readableOn(look.accent!)) : st === "bubble" ? color("#111611") : st === "outline" ? "&HFF" + color(look.textColor!).slice(4) : color(look.textColor!);
  const outline = st === "banner" ? accent : st === "bubble" ? color("#ffffff") : st === "outline" ? color(look.textColor!) : "&H00111111";
  const back = st === "retro" ? accent : "&H99000000";
  const border = ["classic", "banner", "bubble"].includes(st) ? 3 : 1;
  const outlineWidth = st === "minimal" ? 1 : st === "outline" || st === "retro" ? 2 : 3;
  const shadow = st === "neon" ? 4 : st === "retro" ? 4 : 0;
  // Override tags for the word being spoken, per style.
  const activeTag: Partial<Record<CaptionDocument["style"], string>> = {
    karaoke: `\\1c${accent}`, highlight: `\\1c${accent}\\bord5\\3c&H00222222`,
    bounce: `\\1c${accent}\\fscx118\\fscy118\\t(0,120,\\fscx108\\fscy108)`,
    outline: `\\1a&H00&\\1c${accent}\\3c&H00121612`, bubble: `\\1c${accent}`,
    retro: `\\1c${accent}\\4c&H00121612`, underline: `\\u1\\1c${accent}`,
  };
  let ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Noto Sans,${font},${primary},${accent},${outline},${back},-1,0,0,0,100,100,0,0,${border},${outlineWidth},${shadow},5,${Math.round(width * 0.08)},${Math.round(width * 0.08)},40,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  if (!doc.enabled) return ass;
  const emit = (start: number, end: number, text: string) => {
    if (end > start)
      ass += `Dialogue: 0,${time(start)},${time(end)},Default,,0,0,0,,{\\pos(${width / 2},${y})}${text}\n`;
  };
  for (const group of captionGroups(doc.words)) {
    const words = group.map((w) =>
      escape(look.uppercase ? w.text.toLocaleUpperCase("bg") : w.text),
    );
    const maxLen = words.join(" ").length,
      shrink =
        maxLen > 35
          ? `{\\fs${Math.max(16, Math.round((font * 35) / maxLen))}}`
          : "";
    if (["classic", "bold", "minimal", "neon"].includes(doc.style))
      emit(
        group[0].start,
        group.at(-1)!.end,
        shrink +
          (doc.style === "neon" ? `{\\3c${color(look.accent!)}\\blur2}` : "") +
          words.join(" "),
      );
    else
      group.forEach((w, i) => {
        const end = i + 1 < group.length ? group[i + 1].start : w.end;
        const line =
          doc.style === "pop"
            ? `{\\1c${color(look.accent!)}\\fscx110\\fscy110\\t(0,100,\\fscx100\\fscy100)}${words[i]}`
            : doc.style === "typewriter"
              ? words.slice(0, i + 1).join(" ")
              : words
                  .map((text, j) =>
                    j === i
                      ? `${activeTag[doc.style] ? `{${activeTag[doc.style]}}` : ""}${text}{\\r}`
                      : doc.style === "banner"
                        ? `{\\1a&H70&}${text}{\\r}`
                        : text,
                  )
                  .join(" ");
        emit(w.start, end, shrink + line);
      });
  }
  return ass;
}
