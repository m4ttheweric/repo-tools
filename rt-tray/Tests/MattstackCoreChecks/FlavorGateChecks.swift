import Foundation
import MattstackCore

let flavorGateChecks: [Check] = [
    Check("matched flavor serves") { c in
        let action = FlavorGate.decide(myFlavorIsDev: true,
                                       modeReadResult: #"{"intended":{"mode":"dev","provenance":"setting"},"cliFlavor":"dev","daemon":null}"#)
        c.expectEqual(action, .serve)
    },
    Check("mismatched flavor stands down with the intended mode") { c in
        let action = FlavorGate.decide(myFlavorIsDev: false,
                                       modeReadResult: #"{"intended":{"mode":"dev","provenance":"setting"},"cliFlavor":"dev","daemon":null}"#)
        c.expectEqual(action, .standDown(intended: "dev"))
    },
    Check("a failed mode read serves") { c in
        c.expectEqual(FlavorGate.decide(myFlavorIsDev: false, modeReadResult: nil), .serve)
    },
    Check("a garbage mode read serves") { c in
        c.expectEqual(FlavorGate.decide(myFlavorIsDev: true, modeReadResult: "not json"), .serve)
    },
    Check("locator: dev build with no wrapper resolves nil — never the bundled daemon shim") { c in
        let loc = RtBinaryLocator.resolve(bundlePath: "/tmp/x.app", isDevBuild: true, isDebugBuild: false,
                                          environment: [:], home: "/tmp/nohome",
                                          fileExists: { $0.contains("Contents/MacOS/rt") })
        c.expect(loc == nil, "no dev wrapper ⇒ nil, even though the bundled path exists")
    },
]
