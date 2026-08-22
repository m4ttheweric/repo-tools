import CoreGraphics
import Foundation

let args = CommandLine.arguments
guard args.count == 2 else {
    FileHandle.standardError.write("usage: winid <window title>\n".data(using: .utf8)!)
    exit(2)
}
// Without Screen Recording, other processes' window titles come back empty — the Tart
// window still enumerates, so a name-title match would misreport this as "no window".
guard CGPreflightScreenCaptureAccess() else {
    FileHandle.standardError.write("Screen Recording permission not granted — enable it for this terminal/runner (System Settings → Privacy & Security → Screen & System Audio Recording), then retry\n".data(using: .utf8)!)
    exit(3)
}
let wanted = args[1]
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
for w in list {
    let owner = w[kCGWindowOwnerName as String] as? String ?? ""
    let name = w[kCGWindowName as String] as? String ?? ""
    let layer = w[kCGWindowLayer as String] as? Int ?? 0
    if owner.lowercased() == "tart" && name == wanted && layer == 0, let id = w[kCGWindowNumber as String] as? Int {
        print(id)
        exit(0)
    }
}
FileHandle.standardError.write("no on-screen tart window titled \(wanted)\n".data(using: .utf8)!)
exit(1)
