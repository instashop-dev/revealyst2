// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { HistoryPage } from "../src/pages/HistoryPage.js";

const mockApi = vi.hoisted(() => ({
  history: vi.fn(),
}));

vi.mock("../src/api/client.js", () => ({
  api: mockApi,
}));

vi.mock("../src/auth/session.js", () => ({
  useAuth: () => ({
    session: {
      token: "sess",
      user: { id: "1", email: "jamie@example.com", plan: "free", is_admin: false },
    },
  }),
}));

const event = (over: Record<string, unknown> = {}) => ({
  prompt_hash: "h1",
  score: 72,
  breakdown: {
    specificity: 80,
    context: 70,
    role_clarity: 70,
    output_format: 60,
    examples_included: 40,
  },
  flags: [],
  llm_platform: "chatgpt",
  rating: null,
  created_at: "2026-08-01T10:00:00.000Z",
  ...over,
});

describe("HistoryPage (server-side filtering, PMF review)", () => {
  beforeEach(() => {
    mockApi.history.mockResolvedValue({
      events: [event(), event({ prompt_hash: "h2", llm_platform: "claude", score: 45 })],
      note: "scores only",
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("fetches history and renders the rows", async () => {
    render(
      <MemoryRouter>
        <HistoryPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("chatgpt")).toBeTruthy());
    expect(screen.getByText("claude")).toBeTruthy();
  });

  it("passes the platform filter to the API instead of filtering client-side", async () => {
    render(
      <MemoryRouter>
        <HistoryPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(mockApi.history).toHaveBeenCalled());
    const input = screen.getByPlaceholderText("e.g. chatgpt");
    fireEvent.change(input, { target: { value: "ChatGPT" } });
    await waitFor(() =>
      expect(mockApi.history).toHaveBeenLastCalledWith("sess", "all", "ChatGPT", undefined),
    );
  });

  it("shows the 'no data yet' empty state only when no filters are active", async () => {
    mockApi.history.mockResolvedValue({ events: [], note: "scores only" });
    render(
      <MemoryRouter>
        <HistoryPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText(/No prompts synced in this period/i)).toBeTruthy());
  });

  it("shows the 'filters match nothing' state when filters are active", async () => {
    mockApi.history.mockResolvedValue({ events: [], note: "scores only" });
    render(
      <MemoryRouter>
        <HistoryPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(mockApi.history).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText("e.g. chatgpt"), {
      target: { value: "gemini" },
    });
    await waitFor(() =>
      expect(screen.getByText(/Nothing matches the current filters/i)).toBeTruthy(),
    );
  });
});
