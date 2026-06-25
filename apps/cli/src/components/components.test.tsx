import { expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Header } from "./Header";
import { ClipList } from "./ClipList";
import { PairScreen } from "./PairScreen";
import { Composer } from "./Composer";
import { Transfers } from "./Transfers";

it("Header shows routingId, Mode A, status and peer count", () => {
  const { lastFrame } = render(<Header routingId="abc123" status="secure channel" peerCount={2} />);
  const f = lastFrame()!;
  expect(f).toContain("abc123");
  expect(f).toContain("Mode A");
  expect(f).toContain("secure channel");
  expect(f).toContain("2");
});

it("ClipList renders rows and marks the selected one", () => {
  const items = [
    { id: "1", text: "first", ts: 1, mine: true },
    { id: "2", text: "second", ts: 2, mine: false },
  ];
  const { lastFrame } = render(<ClipList items={items} selected={1} />);
  const f = lastFrame()!;
  expect(f).toContain("first");
  expect(f).toContain("second");
  expect(f).toMatch(/[>›❯].*second/); // a cursor marks the selected row
});

it("PairScreen shows the URL and the QR block", () => {
  const { lastFrame } = render(<PairScreen roomUrl="http://h/r/abc123#sek" qr={"█ █\n ██"} />);
  const f = lastFrame()!;
  expect(f).toContain("abc123");
  expect(f).toContain("█");
});

it("Composer shows the over-limit warning when over=true", () => {
  const { lastFrame } = render(
    <Composer value="x" onChange={() => {}} onSubmit={() => {}} over={true} />
  );
  const f = lastFrame()!;
  expect(f).toContain("32 KB");
});

it("Composer does not show the over-limit warning when over=false", () => {
  const { lastFrame } = render(
    <Composer value="x" onChange={() => {}} onSubmit={() => {}} over={false} />
  );
  const f = lastFrame()!;
  expect(f).not.toContain("Too large");
});

it("Transfers renders a row per active transfer with direction + percent", () => {
  const { lastFrame } = render(
    <Transfers rows={[{ fileId: "f1", dir: "send", name: "photo.png", sent: 5, total: 10 }]} />,
  );
  const f = lastFrame()!;
  expect(f).toContain("photo.png");
  expect(f).toContain("50%");
  expect(f).toMatch(/[↑]/);
});
