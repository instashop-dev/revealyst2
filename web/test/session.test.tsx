// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "../src/auth/session.js";

vi.mock("../src/api/client.js", () => ({
  api: {
    me: vi.fn(async (token: string) =>
      token === "admin-token"
        ? { id: "a1", email: "creator@revealyst.com", plan: "free", is_admin: true }
        : { id: "u1", email: "user@example.com", plan: "free", is_admin: false },
    ),
    verifyMagicToken: vi.fn(async () => ({
      token: "admin-token",
      user: { id: "a1", email: "creator@revealyst.com", plan: "free", is_admin: true },
    })),
  },
}));

import { api } from "../src/api/client.js";

function Probe() {
  const { session, user, impersonating, login, impersonate, exitImpersonation, logout } = useAuth();
  return (
    <div>
      <span data-testid="email">{user?.email ?? "none"}</span>
      <span data-testid="token">{session?.token ?? "none"}</span>
      <span data-testid="impersonating">{String(impersonating)}</span>
      <button onClick={() => void login("magic-token")}>login</button>
      <button
        onClick={() =>
          impersonate({
            token: "imp-token",
            user: { id: "u1", email: "user@example.com", plan: "free", is_admin: false },
          })
        }
      >
        impersonate
      </button>
      <button onClick={exitImpersonation}>exit</button>
      <button onClick={logout}>logout</button>
    </div>
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("auth session impersonation", () => {
  it("keeps the real session while impersonating and restores it on exit", async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    // App creator logs in with their magic link.
    screen.getByText("login").click();
    await waitFor(() =>
      expect(screen.getByTestId("email").textContent).toBe("creator@revealyst.com"),
    );
    expect(screen.getByTestId("impersonating").textContent).toBe("false");

    // Impersonate a user → the active session switches to the target.
    screen.getByText("impersonate").click();
    await waitFor(() => expect(screen.getByTestId("email").textContent).toBe("user@example.com"));
    expect(screen.getByTestId("token").textContent).toBe("imp-token");
    expect(screen.getByTestId("impersonating").textContent).toBe("true");

    // Exit → back to the creator's own session, no re-login.
    screen.getByText("exit").click();
    await waitFor(() =>
      expect(screen.getByTestId("email").textContent).toBe("creator@revealyst.com"),
    );
    expect(screen.getByTestId("token").textContent).toBe("admin-token");
    expect(screen.getByTestId("impersonating").textContent).toBe("false");

    // Logout clears everything.
    screen.getByText("logout").click();
    await waitFor(() => expect(screen.getByTestId("email").textContent).toBe("none"));
    expect(screen.getByTestId("token").textContent).toBe("none");
  });

  it("falls back to the real session when the impersonated token dies", async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    screen.getByText("login").click();
    await waitFor(() =>
      expect(screen.getByTestId("email").textContent).toBe("creator@revealyst.com"),
    );

    // The impersonated token is expired → me() rejects for it only.
    vi.mocked(api.me).mockImplementationOnce(async () => {
      throw new Error("token expired");
    });
    screen.getByText("impersonate").click();

    // Falls back to the creator's own session…
    await waitFor(() =>
      expect(screen.getByTestId("email").textContent).toBe("creator@revealyst.com"),
    );
    expect(screen.getByTestId("impersonating").textContent).toBe("false");
    expect(screen.getByTestId("token").textContent).toBe("admin-token");
    // …and the real session survives in storage for the next reload.
    expect(localStorage.getItem("revealyst:session")).toContain("admin-token");
    expect(localStorage.getItem("revealyst:impersonation")).toBeNull();
  });
});
