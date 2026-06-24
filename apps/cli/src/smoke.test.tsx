import { expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Smoke } from "./smoke";

it("renders with Ink + ink-testing-library", () => {
  const { lastFrame } = render(<Smoke />);
  expect(lastFrame()).toContain("uniclip ready");
});
