# Operator-pinned font evidence

Binary changes still make review evidence incomplete by default. A narrow exception
supports **new WOFF2 files only**, with medium/high evaluation, required hard model
review, scripted checks, and the normal human checklist. Updates, removals,
collections, metadata/private blocks, executable files, and symlinks remain blocked.

An operator may configure `fontAssets` on a runtime workflow. This field is not a
public job parameter and no repository manifest grants an approval. Each entry has
exact `path`, `sha256`, `bytes`, `licensePath`, `licenseSha256`, `sourceUrl`,
`sourceSha256`, and `note` fields. Paths are canonical repository-relative paths;
there are no globs. URLs are credential-free HTTPS provenance references, not
instructions to fetch data. Approvals are bounded to 32 fonts, 2 MiB per font,
and a 64 KiB license file. The operator must establish trust in the exact source
and any derivation before adding the approval.

Before a provider runs, the daemon writes a normalized, frozen `font-policy.json`
into that job's artifacts. Its hash is part of the immutable review evidence.
The reviewer sees the exact before/after identity, byte count, license identity,
declared provenance and limits. A changed runtime policy invalidates acceptance
for jobs with this policy header, including revocation. Rerun evaluation under
the intended policy; do not edit stored evidence or acceptance records.

Verification checks the exact approved bytes, license, regular non-executable
files and parents, and basic WOFF2 header limits. It **does not** decode/sanitize
font tables, independently fetch the declared source, establish legal license
rights, prove rendering correctness, or attest human testing. The SHA-256 pin
is the trust boundary; header checks alone do not make an untrusted font safe.
Rendering tests remain separate evidence. The format reference is the
[WOFF2 specification](https://www.w3.org/TR/WOFF2/).

No database migration, new dependency, or broader binary allowlist is needed.
Text-only legacy evidence without this header keeps its existing semantics;
previously incomplete binary evidence is never retroactively made complete.

## Bootstrap rollout

An older daemon cannot evaluate a newly added font binary. First evaluate and
accept a **text-only verifier upgrade** using unchanged gates. Then use the
upgraded verifier with explicit font approvals for a fresh evaluated job that
retains its original source baseline, all quality/scenario gates, required model
review, and human checklist. The font receipt supplements the review; it does not
waive any other requirement.

The approved light preview and production stay unchanged until their respective
exact-candidate acceptance checks pass. Do not encode binaries as text, seed them
into a replacement baseline, or mark a generic permission as human testing.
