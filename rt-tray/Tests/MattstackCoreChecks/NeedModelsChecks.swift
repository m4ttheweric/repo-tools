import Foundation
import MattstackCore

let needModelsChecks: [Check] = [
    Check("ProxyHelper path and prompt") { c in
        c.expectEqual(ProxyHelper.path(bundlePath: "/Applications/mattstack.app"),
                      "/Applications/mattstack.app/Contents/Helpers/mattstack-proxy-install")
        c.expect(ProxyHelper.promptText.contains("administrator"))
    },
    Check("NeedResult encodes {ok, detail}") { c in
        let j = String(decoding: try JSONEncoder().encode(NeedResult(ok: true, detail: "proxy installed")), as: UTF8.self)
        c.expect(j.contains("\"ok\":true") && j.contains("\"detail\":\"proxy installed\""))
    },
]
