import Foundation

public struct NDJSONSplitter: Sendable {
    private var buffer = Data()
    public init() {}

    public mutating func feed(_ data: Data) -> [String] {
        buffer.append(data)
        var lines: [String] = []
        while let nl = buffer.firstIndex(of: UInt8(ascii: "\n")) {
            let chunk = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            if let s = String(data: chunk, encoding: .utf8)?.trimmingCharacters(in: .whitespaces), !s.isEmpty {
                lines.append(s)
            }
        }
        return lines
    }

    public mutating func flush() -> String? {
        defer { buffer.removeAll() }
        guard let s = String(data: buffer, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !s.isEmpty else { return nil }
        return s
    }
}
