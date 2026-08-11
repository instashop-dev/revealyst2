// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { NotFoundPage } from "../src/pages/NotFoundPage.js";

afterEach(cleanup);

describe("not-found page (PMF review: unknown URLs were a blank dead end)", () => {
  it("explains the page is missing and links back to Progress", () => {
    render(
      <MemoryRouter initialEntries={["/nope"]}>
        <NotFoundPage />
      </MemoryRouter>,
    );
    expect(screen.getByText("Page not found")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to Progress" })).toBeTruthy();
  });
});
