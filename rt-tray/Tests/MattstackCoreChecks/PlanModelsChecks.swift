import Foundation
import MattstackCore

let samplePlanJSON = """
{ "contract": 1, "at": "2026-08-21T04:00:00Z",
  "team": { "slug": "acme", "name": "Acme", "mode": "join" },
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
      { "id": "account.gitlab", "kind": "account", "title": "GitLab", "why": "MRs live on gitlab.example.com.",
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
        c.expectEqual(plan.groups.count, 2)
        c.expectEqual(plan.groups[0].rows[0].status, .needsYou)
        c.expectEqual(plan.groups[0].rows[0].action?.type, .openSettings)
        c.expectEqual(plan.groups[0].rows[0].action?.target, "fda")
        c.expectEqual(plan.groups[0].rows[0].recheck, .onActivate)
        c.expectEqual(plan.groups[1].rows[0].action?.fields?.first?.secret, true)
        c.expectEqual(plan.groups[1].rows[0].action?.alternatives?.first?.id, "use-gh")
        c.expectEqual(plan.requiredMissing, ["perm.fda", "account.gitlab"])
        c.expectEqual(plan.canInstall, false)
    },
    Check("unknown action type and status degrade instead of failing the whole plan") { c in
        let plan = try JSONDecoder().decode(Plan.self, from: Data(samplePlanJSON.utf8))
        let chrome = plan.groups[1].rows[1]
        c.expectEqual(chrome.action?.type, .unknown)
        var lenient = samplePlanJSON
        lenient = lenient.replacingOccurrences(of: "\"status\": \"skipped\"", with: "\"status\": \"brand-new\"")
        let plan2 = try JSONDecoder().decode(Plan.self, from: Data(lenient.utf8))
        c.expectEqual(plan2.groups[1].rows[1].status, .error)
    },
    Check("Plan round-trips through the encoder") { c in
        let plan = try JSONDecoder().decode(Plan.self, from: Data(samplePlanJSON.utf8))
        let data = try JSONEncoder().encode(plan)
        let again = try JSONDecoder().decode(Plan.self, from: data)
        c.expectEqual(again, plan)
    },
]
