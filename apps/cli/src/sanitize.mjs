// Provider output (and therefore anything a poisoned file, dependency README, or web page induced a
// provider to emit) flows into job/turn text and back out through this CLI to a real terminal. Strip
// cursor moves, screen clears and title-bar writes before any of it reaches stdout/stderr; \n and \t are
// left alone since real multi-line bodies depend on them.
export function stripTerminalControl(text) {
  if (typeof text !== "string" || text === "") return text;
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0x1b) {
      const next = text[i + 1];
      if (next === "[") {
        // CSI: ESC [ ... final byte in 0x40-0x7E (cursor moves, screen/line clears, colour, etc.)
        let j = i + 2;
        while (j < text.length && !(text.charCodeAt(j) >= 0x40 && text.charCodeAt(j) <= 0x7e)) j += 1;
        i = j;
      } else if (next === "]") {
        // OSC: ESC ] ... terminated by BEL or the ESC \ string terminator (window/tab titles, etc.)
        let j = i + 2;
        while (j < text.length && text.charCodeAt(j) !== 0x07 && !(text.charCodeAt(j) === 0x1b && text[j + 1] === "\\")) j += 1;
        i = j < text.length && text.charCodeAt(j) === 0x1b ? j + 1 : j;
      } else if (next !== undefined) {
        i += 1; // other two-byte escape (e.g. ESC 7 / ESC c)
      }
      // else: a lone trailing ESC, dropped
      continue;
    }
    if (code === 0x9b) {
      // 8-bit CSI: the same parameter/final-byte grammar as ESC [, in one byte.
      let j = i + 1;
      while (j < text.length && !(text.charCodeAt(j) >= 0x40 && text.charCodeAt(j) <= 0x7e)) j += 1;
      i = j;
      continue;
    }
    if (code === 0x9d) {
      // 8-bit OSC: terminated by BEL, the one-byte ST (0x9c), or the two-byte ESC \\ string terminator.
      let j = i + 1;
      while (
        j < text.length &&
        text.charCodeAt(j) !== 0x07 &&
        text.charCodeAt(j) !== 0x9c &&
        !(text.charCodeAt(j) === 0x1b && text[j + 1] === "\\")
      ) {
        j += 1;
      }
      i = j < text.length && text.charCodeAt(j) === 0x1b ? j + 1 : j;
      continue;
    }
    // C0 (minus the newline and tab that carry real formatting), DEL, and C1. JSON.stringify escapes C0 but
    // passes C1 through raw, so a terminal reading 8-bit controls would still act on them.
    if (
      (code <= 0x1f && code !== 0x0a && code !== 0x09) ||
      code === 0x7f ||
      (code >= 0x80 && code <= 0x9f)
    ) {
      continue;
    }
    out += text[i];
  }
  return out;
}

export function sanitizeForPrint(value) {
  if (typeof value === "string") return stripTerminalControl(value);
  if (Array.isArray(value)) return value.map(sanitizeForPrint);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = sanitizeForPrint(entry);
    return out;
  }
  return value;
}
