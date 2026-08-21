import CoreGraphics
import Foundation

let args = CommandLine.arguments
guard args.count == 2 else {
    FileHandle.standardError.write("usage: winid <window title>\n".data(using: .utf8)!)
    exit(2)
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
