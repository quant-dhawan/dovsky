import { createHash } from "node:crypto";
import type { FontAssetApproval } from "../font-assets.js";

/** Header-only synthetic bytes; deliberately NOT a real renderable font. */
export function fontFixture() {
  const bytes = Buffer.alloc(64);
  bytes.write("wOF2"); bytes.writeUInt32BE(0x00010000, 4); bytes.writeUInt32BE(64, 8);
  bytes.writeUInt16BE(1, 12); bytes.writeUInt32BE(128, 16); bytes.writeUInt32BE(12, 20);
  const license = "Synthetic test license, not a production font.\n";
  const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
  const approval: FontAssetApproval = { path: "fixture.woff2", bytes: bytes.length, sha256: hash(bytes), licensePath: "FONT-LICENSE.txt",
    licenseSha256: hash(license), sourceUrl: "https://example.invalid/fixture-font", sourceSha256: hash("synthetic source"), note: "Operator fixture approval; not a sanitizer assertion" };
  return { bytes, license, approval };
}
