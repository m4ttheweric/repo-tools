import Foundation
import CoreServices
import MattstackCore

private let healthResponse = """
HTTP/1.1 200 OK\r
Content-Type: application/json\r
Content-Length: 46\r
Connection: close\r
\r
{"ok":true,"app":"mattstack","flavor":"dev"}
"""

let flavorHandoffChecks: [Check] = [
    Check("health body names the flavor") { c in
        c.expectEqual(TrayHealth.body(isDevBuild: true), #"{"ok":true,"app":"mattstack","flavor":"dev"}"#)
        c.expectEqual(TrayHealth.body(isDevBuild: false), #"{"ok":true,"app":"mattstack","flavor":"prod"}"#)
    },
    Check("health flavor is read out of a raw HTTP response") { c in
        c.expectEqual(TrayHealth.flavor(inResponse: healthResponse), "dev")
        c.expectEqual(TrayHealth.flavor(inResponse: TrayHealth.body(isDevBuild: false)), "prod")
    },
    Check("an older tray's health answer reads as unknown, not as a mismatch") { c in
        c.expect(TrayHealth.flavor(inResponse: #"{"ok":true,"app":"mattstack"}"#) == nil)
        c.expect(TrayHealth.flavor(inResponse: "HTTP/1.1 200 OK\r\n\r\nnot json") == nil)
        c.expect(TrayHealth.flavor(inResponse: #"{"ok":true,"flavor":"staging"}"#) == nil)
    },
    Check("a hand-written reply is parsed into status and body") { c in
        let parsed = try c.requireSome(HTTPReply.parse(healthResponse))
        c.expectEqual(parsed.status, 200)
        c.expectEqual(parsed.body, #"{"ok":true,"app":"mattstack","flavor":"dev"}"#)
        c.expect(HTTPReply.succeeded(healthResponse))
    },
    Check("a 404 from a tray without the retire route is not a success") { c in
        let notFound = "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n{\"ok\":false}"
        c.expectEqual(HTTPReply.parse(notFound)?.status, 404)
        c.expect(!HTTPReply.succeeded(notFound))
        c.expect(!HTTPReply.succeeded("garbage"))
        c.expect(HTTPReply.parse("garbage") == nil)
    },
    Check("socket ownership: a dead holder is taken over") { c in
        c.expectEqual(SocketOwnership.decide(myFlavor: "dev", holderIsLive: false, holderFlavor: nil,
                                             intentConfirmed: true), .takeOver)
    },
    Check("socket ownership: a same-flavor holder keeps the socket") { c in
        c.expectEqual(SocketOwnership.decide(myFlavor: "dev", holderIsLive: true, holderFlavor: "dev",
                                             intentConfirmed: true), .standAside)
    },
    Check("socket ownership: an unidentifiable holder keeps the socket") { c in
        c.expectEqual(SocketOwnership.decide(myFlavor: "prod", holderIsLive: true, holderFlavor: nil,
                                             intentConfirmed: true), .standAside)
    },
    Check("socket ownership: a wrong-flavor holder is evicted") { c in
        c.expectEqual(SocketOwnership.decide(myFlavor: "prod", holderIsLive: true, holderFlavor: "dev",
                                             intentConfirmed: true), .evictThenTakeOver)
    },
    Check("socket ownership: an unconfirmed intent never evicts anyone") { c in
        c.expectEqual(SocketOwnership.decide(myFlavor: "prod", holderIsLive: true, holderFlavor: "dev",
                                             intentConfirmed: false), .standAside)
    },
    Check("intent is confirmed only by a read that names one flavor") { c in
        let devTuple = #"{"intended":{"mode":"dev","provenance":"setting"},"cliFlavor":"dev","daemon":null}"#
        c.expect(FlavorIntent.confirms(myFlavorIsDev: true, modeReadResult: devTuple), "the dev tray is named")
        c.expect(!FlavorIntent.confirms(myFlavorIsDev: false, modeReadResult: devTuple), "the prod tray is not")
        c.expect(!FlavorIntent.confirms(myFlavorIsDev: true, modeReadResult: nil), "a failed read confirms nothing")
        c.expect(!FlavorIntent.confirms(myFlavorIsDev: true, modeReadResult: "not json"), "garbage confirms nothing")
        c.expect(!FlavorIntent.confirms(myFlavorIsDev: true, modeReadResult: #"{"intended":{"mode":"banana"}}"#),
                 "an unrecognized mode confirms nothing")
    },
    Check("sibling bundle id round-trips between the flavors") { c in
        c.expectEqual(FlavorIdentity.sibling(ofBundleID: "com.mattstack.app"), "com.mattstack.app.dev")
        c.expectEqual(FlavorIdentity.sibling(ofBundleID: "com.mattstack.app.dev"), "com.mattstack.app")
    },
    Check("launch kind: only the login-item Apple Event may stand down silently") { c in
        let loginItem = LaunchKind.classify(eventID: UInt32(kAEOpenApplication), propData: UInt32(keyAELaunchedAsLogInItem))
        c.expectEqual(loginItem, .loginItem)
        c.expect(LaunchKind.mayStandDownSilently(loginItem))
    },
    Check("launch kind: a plain open, another event, or no event at all never stands down silently") { c in
        let opened = LaunchKind.classify(eventID: UInt32(kAEOpenApplication), propData: nil)
        let urlLaunch = LaunchKind.classify(eventID: UInt32(kAEOpenDocuments), propData: nil)
        let noEvent = LaunchKind.classify(eventID: nil, propData: nil)
        c.expectEqual(opened, .userLaunch)
        c.expectEqual(urlLaunch, .userLaunch)
        c.expectEqual(noEvent, .unknown)
        for origin in [opened, urlLaunch, noEvent] {
            c.expect(!LaunchKind.mayStandDownSilently(origin), "\(origin) must take the alert path")
        }
    },
    Check("stand-down copy names the intended mode and the flavor being offered") { c in
        c.expectEqual(FlavorStandDownCopy.alertTitle(intended: "dev"), "This Mac is in dev mode")
        c.expectEqual(FlavorStandDownCopy.switchButton(myFlavor: "prod"), "Switch to prod here")
        c.expect(FlavorStandDownCopy.notificationTitle(myFlavor: "prod").contains("prod"))
        c.expect(FlavorStandDownCopy.notificationBody(intended: "dev").contains("dev"))
    },
]
