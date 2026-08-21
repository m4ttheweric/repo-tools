import Foundation
import MattstackCore

let rowActionChecks: [Check] = [
    Check("native actions") { c in
        c.expectEqual(RowActionDispatcher.dispatch(RowAction(type: .openSettings, label: "Open…", target: "fda"), fieldValues: nil, alternative: nil), .openSettings(target: "fda"))
        c.expectEqual(RowActionDispatcher.dispatch(RowAction(type: .requestPermission, label: "Allow", which: "notifications"), fieldValues: nil, alternative: nil), .requestPermission(which: "notifications"))
    },
    Check("connect: collect first, then rt setup <integration> connect with JSON on stdin; use-gh alternative") { c in
        let fields = [ActionField(name: "token", label: "Token", secret: true, hint: "read_api")]
        let a = RowAction(type: .connect, label: "Connect", integration: "gitlab", fields: fields, alternatives: [ActionAlternative(id: "use-gh", label: "Use gh login")])
        c.expectEqual(RowActionDispatcher.dispatch(a, fieldValues: nil, alternative: nil), .collectFields(fields, integration: "gitlab", alternatives: a.alternatives!))
        let d = RowActionDispatcher.dispatch(a, fieldValues: ["token": "glpat-xyz"], alternative: nil)
        c.expectEqual(d, .rtVerb(args: ["setup", "gitlab", "connect", "--json"], stdin: Data("{\"token\":\"glpat-xyz\"}".utf8)))
        c.expectEqual(RowActionDispatcher.dispatch(a, fieldValues: nil, alternative: "use-gh"), .rtVerb(args: ["setup", "gitlab", "connect", "--json"], stdin: Data("{\"useGh\":true}".utf8)))
    },
    Check("oauth / owner-once / install / link-bundled / run / steps / open-url / unknown") { c in
        c.expectEqual(RowActionDispatcher.dispatch(RowAction(type: .oauth, label: "Connect", integration: "slack", verb: ["setup", "slack", "connect"]), fieldValues: nil, alternative: nil), .rtVerb(args: ["setup", "slack", "connect", "--json"], stdin: nil))
        let owner = RowAction(type: .ownerOnce, label: "Create…", integration: "slack", fields: [ActionField(name: "configToken", label: "App configuration token", secret: true)])
        c.expectEqual(RowActionDispatcher.dispatch(owner, fieldValues: ["configToken": "xoxe-1"], alternative: nil),
                      .rtVerb(args: ["setup", "slack", "create-app", "--json"], stdin: Data("{\"configToken\":\"xoxe-1\"}".utf8)))
        c.expectEqual(RowActionDispatcher.dispatch(RowAction(type: .install, label: "Install", tool: "herdr", via: "brew"), fieldValues: nil, alternative: nil), .rtVerb(args: ["tools", "install", "herdr", "--json"], stdin: nil))
        c.expectEqual(RowActionDispatcher.dispatch(RowAction(type: .linkBundled, label: "Use mattstack's", tool: "gh"), fieldValues: nil, alternative: nil), .rtVerb(args: ["deps", "link", "gh", "--json"], stdin: nil))
        c.expectEqual(RowActionDispatcher.dispatch(RowAction(type: .run, label: "Re-check", verb: ["setup", "status"]), fieldValues: nil, alternative: nil), .rtVerb(args: ["setup", "status", "--json"], stdin: nil))
        c.expectEqual(RowActionDispatcher.dispatch(RowAction(type: .steps, label: "Show steps…", steps: ["a", "b"]), fieldValues: nil, alternative: nil), .showSteps(["a", "b"]))
        c.expectEqual(RowActionDispatcher.dispatch(RowAction(type: .openURL, label: "Download", url: "https://claude.ai/download"), fieldValues: nil, alternative: nil), .openURL(URL(string: "https://claude.ai/download")!))
        c.expectEqual(RowActionDispatcher.dispatch(RowAction(type: .unknown, label: "?"), fieldValues: nil, alternative: nil), .none)
        c.expectEqual(RowActionDispatcher.dispatch(RowAction(type: .openURL, label: "x", url: "not a url at all ::"), fieldValues: nil, alternative: nil), .none)
    },
]
