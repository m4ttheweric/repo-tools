// The pinned identity of everything this helper installs. The values live in
// Pins.generated.swift, written by scripts/gen-pins.sh at build time; there is
// deliberately no default anywhere, so a build that skipped codegen fails to
// compile rather than installing whatever bytes happen to be in the bundle.
struct PinsValues {
    let portlessVersion: String
    /// Carried for the record: this guards the download in fetch-deps.sh, and
    /// nothing at install time re-checks it. portlessTreeSha256 is that check.
    let portlessTarballSha256: String
    let portlessTreeSha256: String
    let nodeBinSha256: String
    let appVersion: String
}
