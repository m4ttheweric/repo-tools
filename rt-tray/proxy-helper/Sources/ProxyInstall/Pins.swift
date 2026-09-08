// The pinned identity of everything this helper installs. The values live in
// Pins.generated.swift, written by scripts/gen-pins.sh at build time; there is
// deliberately no default anywhere, so a build that skipped codegen fails to
// compile rather than installing whatever bytes happen to be in the bundle.
struct PinsValues {
    let portlessVersion: String
    let portlessTarballSha256: String
    let portlessTreeSha256: String
    let appVersion: String
}
