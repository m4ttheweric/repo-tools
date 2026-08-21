import { describe, expect, test } from 'bun:test';
import { pickDaemonSecret } from '../secretsMapping';

// getSecret/setSecret (secrets.ts) need a vscode.ExtensionContext and are
// exercised by hand in the extension host; this covers the daemon-response
// mapping (secretsMapping.ts), which is the part RT-32 actually changed and
// the one piece of secrets.ts's logic reachable without a vscode host.
describe('pickDaemonSecret', () => {
  test('returns the requested key from an ok response', () => {
    const response = { ok: true, data: { linearApiKey: 'lin_api_x', gitlabToken: 'glpat-x' } };
    expect(pickDaemonSecret(response, 'linearApiKey')).toBe('lin_api_x');
    expect(pickDaemonSecret(response, 'gitlabToken')).toBe('glpat-x');
  });

  test('undefined when the key is absent from the response (never set)', () => {
    const response = { ok: true, data: { linearApiKey: 'lin_api_x' } };
    expect(pickDaemonSecret(response, 'gitlabToken')).toBeUndefined();
  });

  test('undefined on a null response (daemon unreachable) without throwing', () => {
    expect(pickDaemonSecret(null, 'linearApiKey')).toBeUndefined();
  });

  test('undefined on ok:false (e.g. missing/invalid api token)', () => {
    const response = { ok: false, error: 'unauthorized' };
    expect(pickDaemonSecret(response, 'linearApiKey')).toBeUndefined();
  });

  test('undefined on an empty string value, same as unset', () => {
    const response = { ok: true, data: { linearApiKey: '' } };
    expect(pickDaemonSecret(response, 'linearApiKey')).toBeUndefined();
  });
});
