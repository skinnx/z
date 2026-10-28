/**
 * OAuth for MCP connectors: an `OAuthClientProvider` whose state lives sealed in the connector row.
 * Dynamic client registration, PKCE and token refresh are run by @ai-sdk/mcp's `auth()`.
 *
 * Only an interactive provider (the owner pressed "Sign in") may start a new authorization: it
 * stores the PKCE verifier and a single-use state that expires after 10 minutes. Background
 * connects and refreshes use a non-interactive one, which never overwrites a pending sign-in and
 * turns "needs a new login" into NeedsAuthError.
 */
import { randomBytes } from "node:crypto";
import type { OAuthAuthorizationServerInformation, OAuthClientInformation, OAuthClientProvider, OAuthTokens } from "@ai-sdk/mcp";
import type { Store } from "./store.ts";

export const STATE_TTL_MS = 10 * 60_000;

export type OAuthState = {
  tokens?: OAuthTokens;
  tokensSavedAt?: number;
  client?: OAuthClientInformation;
  /** Redirect URI the client was registered with. */
  clientRedirectUri?: string;
  dynamic?: boolean;
  server?: OAuthAuthorizationServerInformation;
  verifier?: string;
  state?: string;
  stateExpiresAt?: number;
  /** Redirect URI of the pending authorization; the code exchange must repeat it. */
  redirectUri?: string;
};

export class NeedsAuthError extends Error {
  constructor() {
    super("Sign in again to connect");
    this.name = "NeedsAuthError";
  }
}

export function readOAuth(store: Store, id: string): OAuthState {
  return store.connectors.oauth<OAuthState>(id) ?? {};
}

export function writeOAuth(store: Store, id: string, patch: Partial<OAuthState>) {
  const next = { ...readOAuth(store, id), ...patch };
  for (const key of Object.keys(next) as (keyof OAuthState)[]) if (next[key] === undefined) delete next[key];
  store.connectors.setOAuth(id, Object.keys(next).length ? next : null);
}

export function createOAuthProvider(
  store: Store,
  id: string,
  options: { redirectUri: string; interactive: boolean; onRedirect?: (url: URL) => void },
): OAuthClientProvider {
  const read = () => readOAuth(store, id);
  const write = (patch: Partial<OAuthState>) => writeOAuth(store, id, patch);
  return {
    get redirectUrl() {
      return options.redirectUri;
    },
    get clientMetadata() {
      return {
        client_name: "z",
        redirect_uris: [options.redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },
    clientInformation: () => read().client,
    isClientInformationDynamicallyRegistered: () => Boolean(read().dynamic),
    saveClientInformation: (client) => write({ client, dynamic: true, clientRedirectUri: options.redirectUri }),
    authorizationServerInformation: () => read().server,
    saveAuthorizationServerInformation: (server) => write({ server }),
    tokens: () => read().tokens,
    saveTokens: (tokens) => write({ tokens, tokensSavedAt: Date.now() }),
    saveCodeVerifier: (verifier) => {
      if (options.interactive) write({ verifier });
    },
    codeVerifier: () => {
      const verifier = read().verifier;
      if (!verifier) throw new Error("No sign-in is pending for this connector");
      return verifier;
    },
    state: () => randomBytes(24).toString("base64url"),
    saveState: (state) => {
      if (options.interactive) write({ state, stateExpiresAt: Date.now() + STATE_TTL_MS, redirectUri: options.redirectUri });
    },
    storedState: () => read().state,
    redirectToAuthorization: (url) => {
      if (!options.interactive) throw new NeedsAuthError();
      options.onRedirect?.(url);
    },
    invalidateCredentials: (scope, context) => {
      if (scope === "all") store.connectors.setOAuth(id, null);
      else if (scope === "client") write({ client: undefined, dynamic: undefined, clientRedirectUri: undefined, server: undefined });
      else if (scope === "verifier") write({ verifier: undefined });
      // Only drop the generation that failed, not tokens a concurrent refresh just saved.
      else if (!context || read().tokens?.access_token === context.tokens.access_token) write({ tokens: undefined, tokensSavedAt: undefined });
    },
  };
}
