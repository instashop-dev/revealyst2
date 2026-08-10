// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamInvites } from "../src/components/TeamInvites.js";
import type { TeamInvite } from "../src/api/types.js";

const mockApi = vi.hoisted(() => ({
  teamInvites: vi.fn(),
  inviteMember: vi.fn(),
  revokeInvite: vi.fn(),
  resendInvite: vi.fn(),
}));

vi.mock("../src/api/client.js", () => ({
  api: mockApi,
}));

vi.mock("../src/auth/session.js", () => ({
  useAuth: () => ({
    session: {
      token: "sess",
      user: { id: "1", email: "boss@example.com", plan: "team", is_admin: false },
    },
  }),
}));

const pending = (over: Partial<TeamInvite> = {}): TeamInvite => ({
  id: "inv-1",
  email: "newbie@example.com",
  role: "member",
  status: "pending",
  created_at: "2026-08-10T10:00:00.000Z",
  expires_at: null,
  ...over,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  mockApi.teamInvites.mockResolvedValue({ invites: [pending()] });
  mockApi.inviteMember.mockResolvedValue({ message: "invite sent", invite_id: "inv-2" });
  mockApi.revokeInvite.mockResolvedValue({ message: "invite revoked" });
  mockApi.resendInvite.mockResolvedValue({ message: "invite re-sent" });
});

describe("TeamInvites", () => {
  it("loads and lists pending invites on mount", async () => {
    render(<TeamInvites teamId="t1" />);
    expect(mockApi.teamInvites).toHaveBeenCalledWith("sess", "t1");
    expect(await screen.findByText("newbie@example.com")).toBeTruthy();
    expect(screen.getByText(/pending · sent/)).toBeTruthy();
    expect(screen.getByText("Re-send")).toBeTruthy();
    expect(screen.getByText("Revoke")).toBeTruthy();
  });

  it("sends an invite with the selected role and refreshes the list", async () => {
    render(<TeamInvites teamId="t1" />);
    await screen.findByText("newbie@example.com");

    fireEvent.change(screen.getByPlaceholderText("teammate@company.com"), {
      target: { value: "fresh@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "manager" } });
    fireEvent.click(screen.getByText("Send invite"));

    await waitFor(() => {
      expect(mockApi.inviteMember).toHaveBeenCalledWith(
        "sess",
        "t1",
        "fresh@example.com",
        "manager",
      );
    });
    expect(mockApi.teamInvites).toHaveBeenCalledTimes(2); // mount + refresh
    expect(await screen.findByText(/Invite sent to fresh@example.com/)).toBeTruthy();
  });

  it("revokes a pending invite", async () => {
    render(<TeamInvites teamId="t1" />);
    await screen.findByText("newbie@example.com");
    fireEvent.click(screen.getByText("Revoke"));

    await waitFor(() => {
      expect(mockApi.revokeInvite).toHaveBeenCalledWith("sess", "inv-1");
    });
    expect(await screen.findByText(/revoked — its link no longer works/)).toBeTruthy();
  });

  it("re-sends a pending invite with a fresh link", async () => {
    render(<TeamInvites teamId="t1" />);
    await screen.findByText("newbie@example.com");
    fireEvent.click(screen.getByText("Re-send"));

    await waitFor(() => {
      expect(mockApi.resendInvite).toHaveBeenCalledWith("sess", "inv-1");
    });
    expect(await screen.findByText(/fresh invite was sent/)).toBeTruthy();
  });

  it("shows settled invites without actions and reports empty state", async () => {
    mockApi.teamInvites.mockResolvedValue({
      invites: [pending({ id: "inv-9", status: "accepted" })],
    });
    render(<TeamInvites teamId="t1" />);
    expect(await screen.findByText("newbie@example.com")).toBeTruthy();
    expect(screen.getByText("accepted")).toBeTruthy();
    expect(screen.queryByText("Revoke")).toBeNull();

    mockApi.teamInvites.mockResolvedValue({ invites: [] });
    render(<TeamInvites teamId="t1" />);
    expect(await screen.findByText("No invites sent yet.")).toBeTruthy();
  });
});
