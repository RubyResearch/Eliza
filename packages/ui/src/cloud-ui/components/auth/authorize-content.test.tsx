/** Verifies AuthorizeContent through the package's configured test harness. */
// @vitest-environment jsdom

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
/**
 * Component tests for AuthorizeContent, the app-authorize consent screen. Drives
 * the signed-in and signed-out branches and the OAuth-start / cancel-redirect
 * paths against a mocked `@elizaos/ui` auth hook (deterministic; no live Steward
 * backend), asserting on rendered controls and redirect behaviour in jsdom.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeStewardServerCookieSynced,
  invalidateStewardServerCookieSyncMarker,
  markStewardServerCookieSynced,
} from "../../../cloud/lib/steward-session-cookie-sync-marker";

const enabledProviders = vi.hoisted(() => ({
  passkey: true,
  email: true,
  siwe: false,
  siws: false,
  google: true,
  discord: true,
  github: false,
  twitter: false,
  oauth: ["google", "discord"],
}));

const authRef = vi.hoisted(() => ({
  current: {
    isLoading: false,
    isAuthenticated: true,
    getToken: vi.fn<() => string | null>(() => "token-1"),
    signOut: vi.fn(),
    providers: enabledProviders,
    isProvidersLoading: false,
    signInWithOAuth: vi.fn(),
    activeTenantId: "elizacloud",
  },
}));

const useAuthMock = vi.hoisted(() => vi.fn(() => authRef.current));
const pushMock = vi.hoisted(() => vi.fn());
const searchParamsRef = vi.hoisted(() => ({
  current: new URLSearchParams(
    "app_id=app-1&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&state=state-1",
  ),
}));

vi.mock("../../../login/index", () => ({
  DiscordIcon: ({ size }: { size?: number }) => (
    <svg aria-hidden="true" data-size={size} data-testid="discord-icon" />
  ),
  GoogleIcon: ({ size }: { size?: number }) => (
    <svg aria-hidden="true" data-size={size} data-testid="google-icon" />
  ),
  LoginForm: ({
    showDiscord,
    showGoogle,
    title,
  }: {
    showDiscord?: boolean;
    showGoogle?: boolean;
    title?: string;
  }) => (
    <div
      data-show-discord={String(showDiscord)}
      data-show-google={String(showGoogle)}
      data-testid="steward-login"
    >
      {title}
    </div>
  ),
  useAuth: () => useAuthMock(),
}));

vi.mock("../../runtime/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
  useSearchParams: () => searchParamsRef.current,
}));

vi.mock("../../runtime/image", () => ({
  default: (props: {
    src: string;
    alt: string;
    width?: number;
    height?: number;
  }) => (
    <img
      src={props.src}
      alt={props.alt}
      width={props.width}
      height={props.height}
    />
  ),
}));

import { AuthorizeContent } from "./authorize-content";
import { APP_AUTH_RETURN_TO_KEY } from "./authorize-return";

function mockAppFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        app: {
          id: "app-1",
          name: "Demo App",
          website_url: "https://demo.example",
        },
      }),
    })),
  );
}

describe("AuthorizeContent", () => {
  const realLocation = window.location;
  let locationAssignMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.localStorage.clear();
    invalidateStewardServerCookieSyncMarker();
    locationAssignMock = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...realLocation, assign: locationAssignMock },
    });
    authRef.current = {
      isLoading: false,
      isAuthenticated: true,
      getToken: vi.fn<() => string | null>(() => "token-1"),
      signOut: vi.fn(),
      providers: enabledProviders,
      isProvidersLoading: false,
      signInWithOAuth: vi.fn(),
      activeTenantId: "elizacloud",
    };
    useAuthMock.mockClear();
    pushMock.mockReset();
    searchParamsRef.current = new URLSearchParams(
      "app_id=app-1&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&state=state-1",
    );
    mockAppFetch();
  });

  afterEach(() => {
    invalidateStewardServerCookieSyncMarker();
    cleanup();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: realLocation,
    });
  });

  it("renders a compact signed-in consent screen with one primary action and one cancel affordance", async () => {
    render(<AuthorizeContent />);

    await waitFor(() => expect(screen.getByText("Demo App")).toBeTruthy());

    expect(
      screen.getByText(
        "Connect Demo App to your Eliza Cloud account. AI features may use your cloud credit balance.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("This app wants to:")).toBeNull();
    expect(screen.queryByText("Access your Eliza Cloud account")).toBeNull();
    expect(screen.queryByText(/By continuing/)).toBeNull();
    expect(screen.queryByText("Signed in")).toBeNull();
    const authorizeButton = screen.getByRole("button", {
      name: "Authorize Demo App",
    });
    expect(authorizeButton.className).toContain("hover:bg-accent-hover");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    await waitFor(() =>
      expect(window.localStorage.getItem(APP_AUTH_RETURN_TO_KEY)).toBe(
        "http://localhost/",
      ),
    );
  });

  it("retires explicit-sync proof before raw SDK sign-out when the token is unreadable", async () => {
    const user = userEvent.setup();
    const endpoint = "/api/auth/steward-session";
    let proofAtSignOut: boolean | undefined;
    const signOut = vi.fn(() => {
      proofAtSignOut = consumeStewardServerCookieSynced("token-1", endpoint);
    });
    authRef.current = {
      ...authRef.current,
      getToken: vi.fn<() => string | null>(() => null),
      signOut,
    };
    markStewardServerCookieSynced("token-1", endpoint);

    render(<AuthorizeContent />);

    await waitFor(() => expect(screen.getByText("Demo App")).toBeTruthy());
    await user.click(
      screen.getByRole("button", { name: "Authorize Demo App" }),
    );

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(proofAtSignOut).toBe(false);
    expect(
      screen.getByText("Your session expired. Please sign in again."),
    ).toBeTruthy();
  });

  it("uses the local Playwright test-auth adapter without calling the Steward hook", async () => {
    vi.stubEnv("VITE_PLAYWRIGHT_TEST_AUTH", "true");

    render(<AuthorizeContent />);

    await waitFor(() => expect(screen.getByText("Demo App")).toBeTruthy());

    expect(useAuthMock).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Authorize Demo App" }),
    ).toBeTruthy();
    expect(screen.queryByTestId("steward-login")).toBeNull();
  });

  it("sends signed-in users through the cancel redirect", async () => {
    const user = userEvent.setup();

    render(<AuthorizeContent />);

    await waitFor(() => expect(screen.getByText("Demo App")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(locationAssignMock).toHaveBeenCalledWith(
      "https://example.com/callback?error=access_denied&error_description=User+denied+authorization&state=state-1",
    );
  });

  it("refuses a scriptable redirect_uri scheme and never navigates", async () => {
    searchParamsRef.current = new URLSearchParams(
      "app_id=app-1&redirect_uri=javascript%3Aalert(1)&state=state-1",
    );

    render(<AuthorizeContent />);

    await waitFor(() =>
      expect(screen.getByText("Invalid redirect_uri format.")).toBeTruthy(),
    );
    expect(locationAssignMock).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Authorize Demo App" }),
    ).toBeNull();
    expect(window.localStorage.getItem(APP_AUTH_RETURN_TO_KEY)).toBeNull();
  });

  it("hands off to native-app custom scheme redirect URIs", async () => {
    const user = userEvent.setup();
    searchParamsRef.current = new URLSearchParams(
      "app_id=app-1&redirect_uri=myapp%3A%2F%2Foauth%2Fcallback&state=state-1",
    );

    render(<AuthorizeContent />);

    await waitFor(() => expect(screen.getByText("Demo App")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(locationAssignMock).toHaveBeenCalledWith(
      "myapp://oauth/callback?error=access_denied&error_description=User+denied+authorization&state=state-1",
    );
  });

  it("keeps the signed-out state to sign-in controls plus one cancel affordance", async () => {
    authRef.current = {
      ...authRef.current,
      isAuthenticated: false,
    };

    render(<AuthorizeContent />);

    await waitFor(() => expect(screen.getByText("Demo App")).toBeTruthy());

    expect(screen.getByTestId("steward-login").textContent).toBe(
      "Sign in to authorize",
    );
    expect(
      screen.getByTestId("steward-login").getAttribute("data-show-google"),
    ).toBe("false");
    expect(
      screen.getByTestId("steward-login").getAttribute("data-show-discord"),
    ).toBe("false");
    expect(
      screen.getByRole("button", { name: "Continue with Google" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Continue with Discord" }),
    ).toBeTruthy();
    expect(screen.queryByText("This app wants to:")).toBeNull();
    expect(screen.queryByText(/By continuing/)).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("starts app-auth OAuth with the allowlisted Steward login redirect", async () => {
    const user = userEvent.setup();
    const signInWithOAuth = vi.fn(async () => ({
      token: "token-1",
      user: { id: "user-1", email: "nubs@example.com" },
    }));
    authRef.current = {
      ...authRef.current,
      isAuthenticated: false,
      signInWithOAuth,
    };

    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...realLocation,
        assign: locationAssignMock,
        origin: "https://elizacloud.ai",
      },
    });

    render(<AuthorizeContent />);

    await waitFor(() => expect(screen.getByText("Demo App")).toBeTruthy());
    await user.click(
      screen.getByRole("button", { name: "Continue with Google" }),
    );

    await waitFor(() =>
      expect(signInWithOAuth).toHaveBeenCalledWith("google", {
        redirectUri: "https://elizacloud.ai/login",
        tenantId: "elizacloud",
      }),
    );
  });

  it("sends signed-out users through the cancel redirect", async () => {
    const user = userEvent.setup();
    authRef.current = {
      ...authRef.current,
      isAuthenticated: false,
    };

    render(<AuthorizeContent />);

    await waitFor(() => expect(screen.getByText("Demo App")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(locationAssignMock).toHaveBeenCalledWith(
      "https://example.com/callback?error=access_denied&error_description=User+denied+authorization&state=state-1",
    );
  });

  it("automatically completes first-party mobile PKCE without a consent interstitial", async () => {
    window.localStorage.setItem(STEWARD_TOKEN_KEY, "token-1");
    searchParamsRef.current = new URLSearchParams({
      flow: "mobile_pkce",
      client_id: "ai.elizaos.app",
      environment: "staging",
      redirect_uri: "https://eliza.app/auth/callback",
      state: "mobile-state-1",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
      device_name: "Android",
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          app: {
            name: "Eliza",
            websiteUrl: "https://eliza.app",
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: "mobile-code-1" }),
      } as Response);
    vi.stubGlobal("fetch", fetchMock);

    render(<AuthorizeContent />);

    await waitFor(() =>
      expect(locationAssignMock).toHaveBeenCalledWith(
        "elizaos://auth/callback?code=mobile-code-1&state=mobile-state-1",
      ),
    );
    expect(screen.queryByRole("button", { name: /Authorize/ })).toBeNull();
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/app-auth/mobile/config?clientId=ai.elizaos.app&environment=staging&redirectUri=https%3A%2F%2Feliza.app%2Fauth%2Fcallback",
    );
    const connectCall = fetchMock.mock.calls[1];
    expect(connectCall?.[0]).toBe("/api/v1/app-auth/connect");
    expect(JSON.parse(String(connectCall?.[1]?.body))).toEqual({
      flow: "mobile_pkce",
      clientId: "ai.elizaos.app",
      environment: "staging",
      codeChallenge: "a".repeat(43),
      codeChallengeMethod: "S256",
      deviceName: "Android",
      redirectUri: "https://eliza.app/auth/callback",
      state: "mobile-state-1",
    });
  });

  it("routes signed-out mobile requests through the full hosted login page", async () => {
    authRef.current = {
      ...authRef.current,
      isAuthenticated: false,
    };
    searchParamsRef.current = new URLSearchParams({
      flow: "mobile_pkce",
      client_id: "ai.elizaos.app",
      environment: "staging",
      redirect_uri: "https://eliza.app/auth/callback",
      state: "mobile-state-1",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
    });
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...realLocation,
        assign: locationAssignMock,
        origin: "https://cloud-staging.eliza.app",
        search: `?${searchParamsRef.current.toString()}`,
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ success: true, app: { name: "Eliza" } }),
      })),
    );

    render(<AuthorizeContent />);

    await waitFor(() =>
      expect(locationAssignMock).toHaveBeenCalledWith(
        `/login?returnTo=${encodeURIComponent(`/app-auth/authorize${window.location.search}`)}`,
      ),
    );
    expect(screen.queryByTestId("steward-login")).toBeNull();
  });

  it("returns a failed mobile connection to the app instead of leaving a spinner", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(STEWARD_TOKEN_KEY, "token-1");
    searchParamsRef.current = new URLSearchParams({
      flow: "mobile_pkce",
      client_id: "ai.elizaos.app",
      environment: "staging",
      redirect_uri: "https://eliza.app/auth/callback",
      state: "mobile-state-1",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true, app: { name: "Eliza" } }),
        } as Response)
        .mockResolvedValueOnce({ ok: false, status: 503 } as Response),
    );

    render(<AuthorizeContent />);

    await waitFor(() =>
      expect(
        screen.getByText("Failed to connect to Eliza (HTTP 503)."),
      ).toBeTruthy(),
    );
    expect(screen.queryByText("Finishing sign-in…")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Return to Eliza" }));
    expect(locationAssignMock).toHaveBeenCalledWith(
      "elizaos://auth/callback?error=access_denied&error_description=User+denied+authorization&state=mobile-state-1",
    );
  });
});
