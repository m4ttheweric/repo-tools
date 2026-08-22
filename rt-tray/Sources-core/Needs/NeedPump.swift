import Foundation

/// Wraps an rt NDJSON run (`setup apply`, `uninstall`) so every `need` event
/// is performed on the app's NeedBroker as it arrives, then passed through to
/// the consumer unchanged.
///
/// rt blocks on `GET /setup/need/<id>` until the app records an outcome, so a
/// consumer that only renders the stream leaves rt polling until its own
/// 10-minute timeout and the run's app/privileged steps never happen. The
/// outcome itself reaches the consumer as rt's next `step` event for that id,
/// which is why nothing is injected into the stream here.
public enum NeedPump {
    public static func performing(_ upstream: AsyncThrowingStream<String, Error>,
                                  needs: NeedBroker) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                // This wraps a whole run from its first event: an outcome left
                // by an earlier run would answer rt's poll with work this run
                // never did.
                await needs.forgetAll()
                do {
                    for try await line in upstream {
                        continuation.yield(line)
                        guard case .need(let id, let request)? = try? ApplyEvent.decode(line) else { continue }
                        _ = await needs.perform(id: id, request: request)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            // Cancelling the pump is what tears the upstream down: its own
            // onTermination is the hook that terminates rt.
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
