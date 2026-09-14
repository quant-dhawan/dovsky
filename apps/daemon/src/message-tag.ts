/**
 * Fences an untrusted room turn as escaped XML-like tag content before it is spliced into a
 * provider prompt (see `daemon.ts`'s `discussionPrompt`).
 *
 * Escaping is used instead of a delimiter/nonce scheme on purpose: a random nonce can always be
 * guessed or brute-forced by a sufficiently motivated adversary controlling the body text, but an
 * escaped "<" or "&" can never again be interpreted as a structural character by anything that
 * parses this output as tags. That is strictly stronger, for free, with no state to carry around.
 *
 * Zero imports: this stays a pure, dependency-free module so it is trivial to unit-test.
 */

export function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function xmlAttrEscape(value: string): string {
  return xmlEscape(value).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function messageTag(attrs: Record<string, string>, body: string): string {
  const attrText = Object.entries(attrs)
    .map(([key, value]) => `${key}="${xmlAttrEscape(value)}"`)
    .join(" ");
  return `<message ${attrText}>${xmlEscape(body)}</message>`;
}
