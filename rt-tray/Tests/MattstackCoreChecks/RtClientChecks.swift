import Foundation
import MattstackCore

/// Writes an executable shell script into a temp dir; checks spawn THAT and
/// nothing else — never a real rt, never launchd's control tool or any other process-management tool.
private func fakeExecutable(_ body: String) throws -> URL {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("rt-checks-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let url = dir.appendingPathComponent("fake-rt")
    try ("#!/bin/sh\n" + body + "\n").write(to: url, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
    return url
}

let rtClientChecks: [Check] = [
    Check("NDJSONSplitter yields complete lines and keeps partial tails") { c in
        var s = NDJSONSplitter()
        c.expectEqual(s.feed(Data("{\"a\":1}\n{\"b\"".utf8)), ["{\"a\":1}"])
        c.expectEqual(s.feed(Data(":2}\n\n{\"c\":3}".utf8)), ["{\"b\":2}"])
        c.expectEqual(s.flush(), "{\"c\":3}")
        c.expectEqual(s.flush(), nil)
    },
    Check("RtClient.run captures stdout, exit code, and passes stdin + RT_APP_SOCKET") { c in
        let exe = try fakeExecutable(#"read line; esc=$(printf '%s' "$line" | sed 's/\\/\\\\/g; s/"/\\"/g'); printf '{"contract":1,"echo":"%s","sock":"%s","args":"%s"}' "$esc" "$RT_APP_SOCKET" "$*"; exit 0"#)
        let client = RtClient(location: RtLocation(executable: exe, argumentPrefix: [], source: .bundled),
                              environment: ["RT_APP_SOCKET": "/tmp/x.sock"])
        let result = try await client.run(["setup", "plan", "--json"], stdin: Data("{\"code\":\"abc\"}\n".utf8))
        c.expectEqual(result.exitCode, 0)
        struct Echo: Decodable { let echo: String; let sock: String; let args: String }
        let echo: Echo = try result.decode(Echo.self)
        c.expectEqual(echo.echo, "{\"code\":\"abc\"}")
        c.expectEqual(echo.sock, "/tmp/x.sock")
        c.expectEqual(echo.args, "setup plan --json")
    },
    Check("exit 2 with {error:{}} surfaces as RtUserError") { c in
        let exe = try fakeExecutable(#"printf '{"contract":1,"error":{"code":"no-access","message":"ask the owner"}}'; exit 2"#)
        let client = RtClient(location: RtLocation(executable: exe, argumentPrefix: [], source: .bundled), environment: [:])
        let result = try await client.run(["team", "join"], stdin: nil)
        c.expectEqual(result.exitCode, 2)
        c.expectEqual(result.userError, RtUserError(code: "no-access", message: "ask the owner"))
    },
    Check("stream yields one element per NDJSON line and finishes") { c in
        let exe = try fakeExecutable(#"printf '{"event":"plan","steps":[]}\n{"event":"done","ok":true}\n'"#)
        let client = RtClient(location: RtLocation(executable: exe, argumentPrefix: [], source: .bundled), environment: [:])
        var lines: [String] = []
        for try await line in client.stream(["setup", "apply", "--json"], stdin: nil) { lines.append(line) }
        c.expectEqual(lines.count, 2)
        c.expect(lines[1].contains("\"done\""))
    },
    Check("stream throws when the process exits non-zero and non-2") { c in
        let exe = try fakeExecutable("exit 1")
        let client = RtClient(location: RtLocation(executable: exe, argumentPrefix: [], source: .bundled), environment: [:])
        var threw = false
        do { for try await _ in client.stream(["x"], stdin: nil) {} } catch { threw = true }
        c.expect(threw, "expected a throw on exit 1")
    },
    Check("argumentPrefix is prepended (stub runs as bun <stub.ts> <args>)") { c in
        let exe = try fakeExecutable(#"printf '{"contract":1,"args":"%s"}' "$*""#)
        let client = RtClient(location: RtLocation(executable: exe, argumentPrefix: ["/stub.ts"], source: .stub), environment: [:])
        struct A: Decodable { let args: String }
        let a: A = try await client.run(["version"], stdin: nil).decode(A.self)
        c.expectEqual(a.args, "/stub.ts version")
    },
    Check("locator: prod bundle → Contents/MacOS/rt, falling back to rt-daemon until L4 renames") { c in
        let exists: (String) -> Bool = { $0 == "/Applications/mattstack.app/Contents/MacOS/rt-daemon" }
        let loc = RtBinaryLocator.resolve(bundlePath: "/Applications/mattstack.app", isDevBuild: false, isDebugBuild: false,
                                          environment: [:], home: "/Users/u", fileExists: exists)
        c.expectEqual(loc?.source, .legacyBundled)
        c.expectEqual(loc?.executable.path, "/Applications/mattstack.app/Contents/MacOS/rt-daemon")
        let both: (String) -> Bool = { $0.hasSuffix("/rt") || $0.hasSuffix("/rt-daemon") }
        let loc2 = RtBinaryLocator.resolve(bundlePath: "/Applications/mattstack.app", isDevBuild: false, isDebugBuild: false,
                                           environment: [:], home: "/Users/u", fileExists: both)
        c.expectEqual(loc2?.source, .bundled)
        c.expectEqual(loc2?.executable.path, "/Applications/mattstack.app/Contents/MacOS/rt")
    },
    Check("locator: dev flavor prefers the ~/.local/bin/rt wrapper; stub only in DEBUG with both env vars") { c in
        let all: (String) -> Bool = { _ in true }
        let dev = RtBinaryLocator.resolve(bundlePath: "/x/mattstack-dev.app", isDevBuild: true, isDebugBuild: false,
                                          environment: [:], home: "/Users/u", fileExists: all)
        c.expectEqual(dev?.source, .devWrapper)
        c.expectEqual(dev?.executable.path, "/Users/u/.local/bin/rt")
        let env = ["RT_STUB_SCENARIO": "join-happy", "RT_STUB_PATH": "/repo/rt-tray/Tests/stub-rt/stub.ts"]
        let stub = RtBinaryLocator.resolve(bundlePath: "/x/mattstack.app", isDevBuild: false, isDebugBuild: true,
                                           environment: env, home: "/Users/u", fileExists: all)
        c.expectEqual(stub?.source, .stub)
        c.expectEqual(stub?.executable.path, "/Users/u/.bun/bin/bun")
        c.expectEqual(stub?.argumentPrefix, ["/repo/rt-tray/Tests/stub-rt/stub.ts"])
        let release = RtBinaryLocator.resolve(bundlePath: "/x/mattstack.app", isDevBuild: false, isDebugBuild: false,
                                              environment: env, home: "/Users/u", fileExists: all)
        c.expectEqual(release?.source, .bundled, "release builds ignore RT_STUB_SCENARIO")
        let noPath = RtBinaryLocator.resolve(bundlePath: "/x/mattstack.app", isDevBuild: false, isDebugBuild: true,
                                             environment: ["RT_STUB_SCENARIO": "x"], home: "/Users/u", fileExists: all)
        c.expectEqual(noPath?.source, .bundled, "scenario without RT_STUB_PATH is ignored")
        let none = RtBinaryLocator.resolve(bundlePath: "/x/mattstack.app", isDevBuild: false, isDebugBuild: false,
                                           environment: [:], home: "/Users/u", fileExists: { _ in false })
        c.expect(none == nil, "no rt anywhere → nil, never a guess")
    },
    Check("ConnectResult decodes github's handle/owners and omits them for other integrations") { c in
        let githubJSON = Data(#"{"integration":"github","status":"ready","handle":"mgoodwin","owners":["m4ttstack"]}"#.utf8)
        let github = try JSONDecoder().decode(ConnectResult.self, from: githubJSON)
        c.expectEqual(github.handle, "mgoodwin")
        c.expectEqual(github.owners, ["m4ttstack"])
        let slackJSON = Data(#"{"integration":"slack","status":"ready"}"#.utf8)
        let slack = try JSONDecoder().decode(ConnectResult.self, from: slackJSON)
        c.expect(slack.handle == nil, "handle absent for non-github integrations")
        c.expect(slack.owners == nil, "owners absent for non-github integrations")
    },
]
