import { describe, expect, it } from "vitest";
import {
  initialAgenda,
  readAgendaCommand,
  schedule,
  updatePlan,
} from "./meeting-agenda";

const id = "38e52682-cc5c-4ebb-94ee-5a8826e050e1";
const first = { partId: "part-0", name: "本を選ぶ", minutes: 5 };
const reflection = { partId: "part-3", name: "振り返り", minutes: 2 };

describe("shared meeting schedule", () => {
  it("accepts only bounded, append-only notes and structured plans", () => {
    const note = {
      action: "note",
      id,
      partId: "part-0",
      text: "  次回は金曜日  ",
    };
    const plan = { action: "save", planVersion: 1, parts: [first, reflection] };
    expect(readAgendaCommand(note)).toEqual({ ...note, text: "次回は金曜日" });
    expect(readAgendaCommand(plan)).toEqual(plan);
    expect(readAgendaCommand({ action: "start" })).toEqual({ action: "start" });
    for (const input of [
      null,
      [],
      {},
      { ...note, id: "invalid" },
      { ...note, partId: -1 },
      { ...plan, parts: [{ ...first, partId: "" }, reflection] },
      { ...note, text: " " },
      { ...note, text: "字".repeat(181) },
      { ...plan, planVersion: -1 },
      { ...plan, parts: [] },
      { ...plan, parts: [null, reflection] },
      { ...plan, parts: [{ ...first, minutes: 0 }, reflection] },
      { ...plan, parts: [{ ...first, name: " " }, reflection] },
    ]) {
      expect(readAgendaCommand(input)).toBeNull();
    }
  });
  it("requires an explicit ID for existing rows and a null ID for additions", () => {
    expect(
      readAgendaCommand({
        action: "save",
        version: 1,
        parts: [first, reflection],
      }),
    ).toBe("reload-required");
    const old = { name: first.name, minutes: first.minutes };
    expect(
      readAgendaCommand({
        action: "save",
        planVersion: 1,
        parts: [old, reflection],
      }),
    ).toBe("reload-required");
    expect(
      readAgendaCommand({ action: "note", id, part: 1, text: "共有" }),
    ).toBe("reload-required");
    const addition = {
      action: "confirm",
      planVersion: 1,
      parts: [{ ...old, partId: null }, reflection],
    };
    expect(readAgendaCommand(addition)).toEqual(addition);
  });

  it("rejects duplicate, unknown, retired and substituted reflection IDs", () => {
    const planning = { ...initialAgenda(30), planningAt: 1 };
    const edit = { action: "save", planVersion: 0 } as const;
    for (const [parts, reason] of [
      [[first, first, reflection], "duplicate-part"],
      [[{ ...first, partId: "legacy-0" }, reflection], "unknown-part"],
      [[first, { ...reflection, partId: null }], "reflection-fixed"],
      [[first, { ...reflection, partId: "part-2" }], "reflection-fixed"],
      [[first, { ...reflection, minutes: 1 }], "reflection-fixed"],
      [[first, { ...reflection, name: "別の名前" }], "reflection-fixed"],
    ] as const) {
      const command = readAgendaCommand({ ...edit, parts });
      if (!command || typeof command === "string" || command.action !== "save")
        throw new Error("Expected a parsed plan");
      expect(updatePlan(planning, command, 30, true, 2)).toBe(reason);
    }
    const withNew = updatePlan(
      planning,
      { ...edit, parts: [{ ...first, partId: null }, reflection] },
      30,
      true,
      2,
    );
    if (typeof withNew === "string") throw new Error("Expected saved plan");
    expect(withNew.parts[0]?.partId).toBe("part-4");
    const resave = { ...edit, planVersion: withNew.planVersion };
    expect(
      updatePlan(
        withNew,
        { ...resave, parts: [first, reflection] },
        30,
        true,
        3,
      ),
    ).toBe("unknown-part");
    expect(
      updatePlan(
        withNew,
        { ...resave, parts: [{ ...first, partId: null }, reflection] },
        30,
        true,
        3,
      ),
    ).toMatchObject({
      parts: [{ partId: "part-5" }, reflection],
    });
  });
  it.each([15, 30, 45, 60])(
    "fits the default phases into a %i-minute room",
    (minutes) => {
      const empty = initialAgenda(minutes);
      expect(schedule(empty, minutes)).toMatchObject({
        startsAt: null,
        endsAt: null,
      });
      expect(empty.parts.reduce((total, p) => total + p.minutes, 0)).toBe(
        minutes,
      );
      const agenda = { ...empty, planningAt: 1000, planVersion: 1 };
      const scheduled = schedule(agenda, minutes);
      expect(scheduled.startsAt).toBe(181000);
      expect(scheduled.parts.at(-1)?.endsAt).toBe(scheduled.endsAt);
      expect(scheduled.parts[1]?.startsAt).toBe(scheduled.parts[0]?.endsAt);
    },
  );
  it("allows only the host to open planning and prevents stale confirmations", () => {
    const empty = initialAgenda(15);
    const start = { action: "start" } as const;
    const planning = { ...empty, planningAt: 10, version: 1, planVersion: 1 };
    expect(updatePlan(empty, start, 15, false, 10)).toBe("host-only");
    expect(updatePlan(empty, start, 15, true, 10)).toEqual(planning);
    expect(updatePlan(planning, start, 15, true, 100)).toBe(planning);
    const save = {
      action: "save",
      planVersion: 1,
      parts: [first, reflection],
    } as const;
    const edit = { ...save, parts: [...save.parts] };
    const saved = {
      ...planning,
      parts: edit.parts,
      version: 2,
      planVersion: 2,
    };
    expect(updatePlan(planning, edit, 15, false, 100)).toEqual(saved);
    expect(updatePlan(saved, edit, 15, true, 110)).toBe("agenda-stale");
    expect(
      updatePlan(planning, { ...edit, action: "confirm" }, 15, false, 180010),
    ).toBe("agenda-stale");
    expect(
      updatePlan(
        planning,
        { ...edit, parts: [{ ...first, minutes: 14 }, reflection] },
        15,
        false,
        100,
      ),
    ).toBe("over-total");
    const confirmed = updatePlan(
      saved,
      { ...edit, action: "confirm", planVersion: 2 },
      15,
      false,
      120,
    );
    expect(confirmed).toEqual({
      ...saved,
      version: 3,
      planVersion: 3,
      confirmedAt: 120,
    });
    if (typeof confirmed === "string")
      throw new Error("Expected a confirmed plan");
    expect(schedule(confirmed, 15)).toMatchObject({
      startsAt: 120,
      endsAt: 900120,
    });
    expect(
      updatePlan(confirmed, { ...edit, planVersion: 3 }, 15, true, 125),
    ).toBe(confirmed);
  });
});

it.each([true, false])(
  "protects the committed timeline after manual or automatic start (manual=%s)",
  (manual) => {
    const minute = 60_000;
    const start = 10 * 60 * minute;
    const parts = [
      { ...first, minutes: 20 },
      { partId: "part-1", name: "比較", minutes: 10 },
      { partId: "part-2", name: "決定", minutes: 10 },
      reflection,
    ] as const;
    const agenda = {
      ...initialAgenda(45),
      parts: [...parts],
      planningAt: start - 3 * minute,
      confirmedAt: manual ? start : null,
      version: 8,
      planVersion: 4,
    };
    const now = start + 24 * minute;
    const [past, current, future, last] = parts;
    const save = (
      parts: { partId: string | null; name: string; minutes: number }[],
    ) =>
      updatePlan(
        agenda,
        { action: "save", planVersion: 4, parts },
        45,
        false,
        now,
      );
    for (const [parts, reason] of [
      [[{ ...past, minutes: 15 }, current, future, last], "part-ended"],
      [[{ ...past, name: "変更" }, current, future, last], "part-ended"],
      [[past, future, current, last], "current-part-moved"],
      [[past, future, last], "current-part-moved"],
      [
        [past, { ...current, minutes: 4 }, future, last],
        "current-ends-too-soon",
      ],
      [
        [past, { ...current, minutes: 3 }, future, last],
        "current-ends-too-soon",
      ],
      [
        [past, { ...future, minutes: 1, partId: null }, current, future, last],
        "current-part-moved",
      ],
    ] as const)
      expect(save([...parts])).toBe(reason);
    const reallocated = save([
      past,
      current,
      { ...future, minutes: 5 },
      { partId: null, name: "候補を比較", minutes: 5 },
      last,
    ]);
    if (typeof reallocated === "string")
      throw new Error("Expected reallocation");
    const timeline = schedule(reallocated, 45);
    expect(timeline.parts[1]!.endsAt! - now).toBe(6 * minute);
    expect(timeline.endsAt).toBe(start + 45 * minute);
    expect(reallocated).toMatchObject({
      version: 9,
      planVersion: 5,
      confirmedAt: agenda.confirmedAt,
    });
    expect(save([past, { ...current, minutes: 5 }, last])).toMatchObject({
      planVersion: 5,
    });
  },
);
