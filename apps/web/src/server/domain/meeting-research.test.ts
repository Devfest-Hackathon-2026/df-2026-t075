import { describe, expect, it } from "vitest";
import {
  readResearchCommand,
  updateResearch,
  expireResearch,
  type Research,
} from "./meeting-research";
const id = "2495a326-91fe-4a3d-931e-4593f77fabd2";
const finding = {
  answer: "2020年は123人",
  conditions: "全国",
  title: "Population",
  publisher: "World Bank",
  url: "https://data.worldbank.org/indicator/SP.POP.TOTL?locations=JP&start=2020&end=2020",
};
describe("worker research commands", () => {
  it("accepts only bounded content and links to the actual public sources", () => {
    const finish = { id, action: "finish", status: "verified", finding };
    for (const cmd of [
      { id, action: "start", question: "総人口は？" },
      finish,
      { id, action: "present", grant: id },
      { id, action: "finish", status: "failed" },
      { id, action: "finish", status: "unverified" },
    ])
      expect(readResearchCommand({ ...cmd, roomId: "ignored" })).toEqual(cmd);
    for (const invalid of [
      null,
      {},
      { ...finish, id: "not-an-id" },
      { ...finish, finding: null },
      { ...finish, action: "other" },
      { ...finish, status: "timeout" },
      { id, action: "start", question: "   " },
      ...Object.keys(finding).map((k) => ({
        ...finish,
        finding: { ...finding, [k]: "" },
      })),
      { ...finish, finding: { ...finding, url: "javascript:alert(1)" } },
    ])
      expect(readResearchCommand(invalid)).toBeNull();
  });
  it("bounds stored requests and only grants a verified result", () => {
    const row: Research = {
      id,
      status: "unverified",
      deadline: 5,
      question: "何人？",
    };
    expect(
      updateResearch(
        Array<Research>(48).fill(row),
        { id: "new", action: "start", question: "何円？" },
        1,
      ).status,
    ).toBe("full");
    expect(
      updateResearch([], { id, action: "finish", status: "failed" }, 1).status,
    ).toBe("missing");
    expect(
      updateResearch([row], { id, action: "present", grant: id }, 1).status,
    ).toBe("unavailable");
    expect(
      updateResearch([row], { id, action: "finish", status: "unverified" }, 1)
        .rows[0],
    ).toBe(row);
  });
});

it("only the current grant can confirm or release playout; a crashed worker's lease expires", () => {
  const row: Research = {
    id,
    deadline: 100,
    question: "調査",
    status: "verified",
    finding,
  };
  const claim = { action: "present", grant: id, id } as const;
  const { rows } = updateResearch([row], claim, 0);
  expect(
    updateResearch(rows, { ...claim, action: "release", grant: "other" }, 5)
      .rows,
  ).toBe(rows);
  expect(updateResearch(rows, { ...claim, action: "release" }, 5).rows).toEqual(
    [row],
  );
  expect(expireResearch(rows, 59999)).toBe(rows);
  expect(expireResearch(rows, 60000)).toEqual([row]);
  const complete = updateResearch(rows, { ...claim, action: "spoken" }, 5).rows;
  expect(expireResearch(complete, 60000)).toBe(complete);
  expect(updateResearch(complete, claim, 60000).status).toBe("unavailable");
});

it("accepts a cited web finding and rejects unsafe or unmarked links", () => {
  const result = {
    ...finding,
    source: "web",
    publisher: "example.org",
    url: "https://example.org/report",
  };
  const cmd = { action: "finish", id, status: "verified", finding: result };
  expect(readResearchCommand(cmd)).toEqual(cmd);
  for (const url of [
    "javascript:alert(1)",
    "https://user@example.org",
    "https://127.0.0.1/",
    "https://server.local/",
  ]) {
    expect(
      readResearchCommand({ ...cmd, finding: { ...result, url } }),
    ).toBeNull();
  }
  expect(
    readResearchCommand({ ...cmd, finding: { ...result, source: undefined } }),
  ).toBeNull();
});
