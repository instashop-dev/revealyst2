// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RadarChart, TrendChart } from "../src/components/charts.js";

describe("charts", () => {
  it("renders a radar with dimension labels", () => {
    render(
      <RadarChart
        points={[
          { label: "Specificity", value: 80 },
          { label: "Context", value: 40 },
          { label: "Role", value: 90 },
          { label: "Format", value: 30 },
          { label: "Examples", value: 10 },
        ]}
      />,
    );
    expect(screen.getByRole("img", { name: "score radar" })).toBeTruthy();
    expect(document.body.textContent).toContain("Specificity");
  });

  it("renders a trend line for 5+ points", () => {
    render(
      <TrendChart
        points={[
          { label: "Mon", value: 52 },
          { label: "Tue", value: 61 },
          { label: "Wed", value: 58 },
          { label: "Thu", value: 70 },
          { label: "Fri", value: 74 },
        ]}
      />,
    );
    expect(screen.getByRole("img", { name: "score trend" })).toBeTruthy();
  });

  it("shows an empty-state message with too little data", () => {
    render(<TrendChart points={[{ label: "Mon", value: 50 }]} />);
    expect(document.body.textContent).toContain("Not enough data yet");
  });
});
