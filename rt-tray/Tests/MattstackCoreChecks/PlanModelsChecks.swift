import Foundation
import MattstackCore

let samplePlanJSON = """
{ "contract": 1, "at": "2026-08-21T04:00:00Z",
  "team": { "slug": "assured", "name": "Assured", "mode": "join" },
  "groups": [
    { "id": "mac", "title": "Your Mac", "rows": [
      { "id": "perm.fda", "kind": "permission", "title": "Full Disk Access",
        "why": "Reads your repositories' git state so the daemon can show branch and MR status.",
        "required": true, "optionalNote": null, "status": "needs-you", "detail": "Not granted",
        "action": { "type": "open-settings", "label": "Open Full Disk Access Settings…", "target": "fda" },
        "recheck": "on-activate" },
      { "id": "tool.clt", "kind": "tool", "title": "Apple command line tools", "why": "git and python3.",
        "required": true, "optionalNote": null, "status": "ready", "detail": "git 2.50.1", "action": null, "recheck": "on-change" } ] },
    { "id": "accounts", "title": "Accounts", "rows": [
      { "id": "account.gitlab", "kind": "account", "title": "GitLab", "why": "MRs live on gitlab.assured.com.",
        "required": true, "optionalNote": null, "status": "missing", "detail": null,
        "action": { "type": "connect", "label": "Connect", "integration": "gitlab",
                    "fields": [ { "name": "token", "label": "Personal access token", "secret": true, "hint": "scopes: read_api, read_user" } ],
                    "alternatives": [ { "id": "use-gh", "label": "Use gh login" } ] },
        "recheck": "on-change" },
      { "id": "tool.chrome", "kind": "tool", "title": "Google Chrome", "why": "Evidence capture.",
        "required": false, "optionalNote": "Works without this.", "status": "skipped", "detail": null,
        "action": { "type": "future-thing", "label": "?" }, "recheck": "manual" } ] } ],
  "canInstall": false, "requiredMissing": ["perm.fda", "account.gitlab"] }
"""

let planModelsChecks: [Check] = [
    Check("Plan decodes the contract sample") { c in
        let plan = try JSONDecoder().decode(Plan.self, from: Data(samplePlanJSON.utf8))
        c.expectEqual(plan.contract, 1)
        c.expectEqual(plan.team.mode, .join)
        try c.requireEqual(plan.groups.map { $0.rows.count }, [2, 2])
        let fda = plan.groups[0].rows[0], gitlab = plan.groups[1].rows[0]
        c.expectEqual(fda.status, .needsYou)
        c.expectEqual(fda.action?.type, .openSettings)
        c.expectEqual(fda.action?.target, "fda")
        c.expectEqual(fda.recheck, .onActivate)
        c.expectEqual(gitlab.action?.fields?.first?.secret, true)
        c.expectEqual(gitlab.action?.alternatives?.first?.id, "use-gh")
        c.expectEqual(plan.requiredMissing, ["perm.fda", "account.gitlab"])
        c.expectEqual(plan.canInstall, false)
    },
    Check("unknown action type, status, and kind degrade instead of failing the whole plan") { c in
        func chromeRow(_ json: String) throws -> PlanRow {
            let plan = try JSONDecoder().decode(Plan.self, from: Data(json.utf8))
            return try c.requireSome(plan.groups.flatMap(\.rows).first { $0.id == "tool.chrome" },
                                     "the degraded row must survive decoding")
        }
        c.expectEqual(try chromeRow(samplePlanJSON).action?.type, .unknown)
        let lenient = samplePlanJSON.replacingOccurrences(of: "\"status\": \"skipped\"", with: "\"status\": \"brand-new\"")
        c.expectEqual(try chromeRow(lenient).status, .error)
        let lenientKind = samplePlanJSON.replacingOccurrences(of: "\"id\": \"tool.chrome\", \"kind\": \"tool\"",
                                                              with: "\"id\": \"tool.chrome\", \"kind\": \"brand-new-kind\"")
        c.expectEqual(try chromeRow(lenientKind).kind, .info)
    },
    Check("Plan round-trips through the encoder") { c in
        let plan = try JSONDecoder().decode(Plan.self, from: Data(samplePlanJSON.utf8))
        let data = try JSONEncoder().encode(plan)
        let again = try JSONDecoder().decode(Plan.self, from: data)
        c.expectEqual(again, plan)
    },
    Check("an ActionField with no `secret` key decodes as not-secret instead of failing the whole plan") { c in
        let json = Data(#"{"name":"token","label":"Personal access token","hint":"scopes: read_api"}"#.utf8)
        let field = try JSONDecoder().decode(ActionField.self, from: json)
        c.expectEqual(field.secret, false)
        c.expectEqual(field.hint, "scopes: read_api")
        let bare = try JSONDecoder().decode(ActionField.self, from: Data(#"{"name":"handle","label":"Handle"}"#.utf8))
        c.expectEqual(bare.secret, false)
        c.expectEqual(bare.hint, nil)
    },
]
