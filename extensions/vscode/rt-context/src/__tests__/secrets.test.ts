import { describe, expect, test } from 'bun:test';
import { pickDaemonSecret } from '../secretsMapping';

// getSecret/setSecret (secrets.ts) need a vscode.ExtensionContext and are
// exercised by hand in the extension host; this covers the daemon-response
// mapping (secretsMapping.ts), which is the part RT-32 actually changed and
// the one piece of secrets.ts's logic reachable without a vscode host.
describe('pickDaemonSecret', () => {
  test('ok + value present -> {status: "ok", value}', () => {
    const response = { ok: true, data: { linearApiKey: 'lin_api_x', gitlabToken: 'glpat-x' } };
    expect(pickDaemonSecret(response, 'linearApiKey')).toEqual({ status: 'ok', value: 'lin_api_x' });
    expect(pickDaemonSecret(response, 'gitlabToken')).toEqual({ status: 'ok', value: 'glpat-x' });
  });

  test('ok but the key is absent from the response (never configured) -> "unset", not a failure', () => {
    const response = { ok: true, data: { linearApiKey: 'lin_api_x' } };
    expect(pickDaemonSecret(response, 'gitlabToken')).toEqual({ status: 'unset' });
  });

  test('an empty string value -> "unset", same as absent', () => {
    const response = { ok: true, data: { linearApiKey: '' } };
    expect(pickDaemonSecret(response, 'linearApiKey')).toEqual({ status: 'unset' });
  });

  test('null response (daemonQuery couldn\'t reach the daemon) -> "daemon-down", distinct from a gate failure', () => {
    expect(pickDaemonSecret(null, 'linearApiKey')).toEqual({ status: 'daemon-down' });
  });

  test('ok:false (the handler\'s token gate refused) -> "gate-failed", carrying the reason, distinct from daemon-down', () => {
    const response = { ok: false, error: 'bad-token' };
    expect(pickDaemonSecret(response, 'linearApiKey')).toEqual({ status: 'gate-failed', error: 'bad-token' });
  });

  test('ok:false with no error field still reports gate-failed rather than falling through silently', () => {
    const response = { ok: false };
    expect(pickDaemonSecret(response, 'linearApiKey')).toEqual({ status: 'gate-failed', error: 'unknown' });
  });
});
