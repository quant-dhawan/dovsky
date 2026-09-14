import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fontAssetEvidence, fontAssetHash, fontPolicyHash, parseFontAssetApprovals } from "./font-assets.js";
import { fontFixture } from "./__fixtures__/font.js";

test("font approvals are exact, bounded, operator records with no globs or arbitrary types", () => {
  const { approval } = fontFixture();
  assert.deepEqual(parseFontAssetApprovals(undefined), []);
  assert.deepEqual(parseFontAssetApprovals([approval]), [approval]);
  for (const value of [null, {}, [approval, approval], [{ ...approval, path: "../font.woff2" }], [{ ...approval, path: "/font.woff2" }], [{ ...approval, path: "*.woff2" }], [{ ...approval, path: "font.exe" }], [{ ...approval, path: "a//font.woff2" }], [{ ...approval, bytes: 3_000_000 }], [{ ...approval, sha256: "invalid" }], [{ ...approval, licensePath: "a/../LICENSE" }], [{ ...approval, sourceUrl: "https://user:pass@example.invalid/font" }], [{ ...approval, sourceUrl: "file:///font" }], [{ ...approval, note: "" }], [{ ...approval, extra: true }]]) assert.throws(() => parseFontAssetApprovals(value));
  assert.equal(fontPolicyHash([approval]), fontPolicyHash([{ ...approval }]));
  assert.notEqual(fontPolicyHash([approval]), fontPolicyHash([{ ...approval, note: "Different approval" }]));
});

test("font evidence verifies exact new bytes and license and discloses its limits", () => {
  const root = mkdtempSync(resolve(tmpdir(), "font-evidence-"));
  const { bytes, license, approval } = fontFixture();
  const file = resolve(root, approval.path);
  try {
    writeFileSync(file, bytes); writeFileSync(resolve(root, approval.licensePath), license);
    const receipt = fontAssetEvidence(root, approval.path, null, bytes, [approval]);
    assert.match(receipt, /operator-pinned-font-identity-v1/);
    assert.match(receipt, /no network source verification, sanitizer guarantee, semantic binary review, or human acceptance/);
    assert.ok(receipt.includes(approval.sha256) && receipt.includes(approval.licenseSha256));
    assert.throws(() => fontAssetEvidence(root, approval.path, bytes, bytes, [approval]), /additions/);
    assert.throws(() => fontAssetEvidence(root, approval.path, null, null, [approval]), /additions/);
    assert.throws(() => fontAssetEvidence(root, approval.path, null, bytes, []), /approved/);
    const changed = Buffer.from(bytes); changed[63] = 1; writeFileSync(file, changed);
    assert.throws(() => fontAssetEvidence(root, approval.path, null, changed, [approval]), /bytes/);
    assert.throws(() => fontAssetEvidence(root, approval.path, null, bytes, [approval]), /bytes/);
    writeFileSync(file, bytes); writeFileSync(resolve(root, approval.licensePath), "Different license");
    assert.throws(() => fontAssetEvidence(root, approval.path, null, bytes, [approval]), /license/);
    writeFileSync(resolve(root, approval.licensePath), license); chmodSync(file, 0o755);
    assert.throws(() => fontAssetEvidence(root, approval.path, null, bytes, [approval]), /non-executable/);
    chmodSync(file, 0o644); renameSync(file, resolve(root, "actual.woff2")); symlinkSync("actual.woff2", file);
    assert.throws(() => fontAssetEvidence(root, approval.path, null, bytes, [approval]), /regular/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("hash-matching bytes still fail unsupported headers and symlinked parents", () => {
  const root = mkdtempSync(resolve(tmpdir(), "font-header-"));
  const { bytes, license, approval } = fontFixture();
  try {
    writeFileSync(resolve(root, approval.licensePath), license);
    for (const [offset, value] of [[0, 0], [4, 0x74746366], [8, 65], [12, 0], [16, 0xffffffff], [20, 0], [28, 1], [40, 1]]) {
      const changed = Buffer.from(bytes); changed.writeUInt32BE(value!, offset!);
      writeFileSync(resolve(root, approval.path), changed);
      assert.throws(() => fontAssetEvidence(root, approval.path, null, changed, [{ ...approval, sha256: fontAssetHash(changed) }]), /header/);
    }
    mkdirSync(resolve(root, "real")); writeFileSync(resolve(root, "real", approval.path), bytes); symlinkSync("real", resolve(root, "alias"));
    assert.throws(() => fontAssetEvidence(root, `alias/${approval.path}`, null, bytes, [{ ...approval, path: `alias/${approval.path}` }]), /symlink/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
