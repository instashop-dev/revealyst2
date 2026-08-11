import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { GetStarted } from "../src/components/GetStarted.js";

describe("GetStarted onboarding checklist", () => {
  it("walks a new user through install → connect → sync → score", () => {
    render(
      <MemoryRouter>
        <GetStarted />
      </MemoryRouter>,
    );
    expect(screen.getByText("Get started")).toBeTruthy();
    expect(screen.getByText("Install the extension")).toBeTruthy();
    expect(screen.getByText("Connect your account")).toBeTruthy();
    expect(screen.getByText("Turn on Cloud sync")).toBeTruthy();
    expect(screen.getByText("Score your first prompt")).toBeTruthy();
    // The connect step links into Settings for the API token.
    const link = screen.getByRole("link", { name: /Settings → Connect the extension/ });
    expect(link.getAttribute("href")).toBe("/settings");
  });
});
