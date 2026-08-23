/**
 * The team's Slack app manifest — one owner runs `rt setup slack create-app`
 * once, and every member's `rt setup slack connect` OAuth handshake targets
 * the app this manifest describes. Scopes are fixed here (not pack-declared)
 * because the manifest and the OAuth `user_scope` request must always name
 * the same set — drift between the two would surface as Slack silently
 * granting fewer scopes than the connect flow asked for.
 */

export interface SlackScopeNeeds {
  bot: string[];
  user: string[];
}

export const DEFAULT_SCOPE_NEEDS: SlackScopeNeeds = {
  bot: ["chat:write", "reactions:write", "channels:read", "users:read"],
  user: ["reactions:write", "chat:write"],
};

export const DEFAULT_CALLBACK_PORT = 11234;

export function buildSlackManifest(opts: { name: string; callbackPort: number; scopes: SlackScopeNeeds }): object {
  return {
    display_information: { name: opts.name },
    oauth_config: {
      redirect_urls: [`http://localhost:${opts.callbackPort}/callback`],
      scopes: { bot: opts.scopes.bot, user: opts.scopes.user },
    },
    settings: { org_deploy_enabled: false },
  };
}
