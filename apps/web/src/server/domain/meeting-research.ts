import { isUuidV4OrV5 } from "./uuid";
import { record, shortText } from "./input";

export type Finding = {
  answer: string;
  conditions: string;
  title: string;
  publisher: string;
  url: string;
  source?: "web";
  license?: "CC-BY-4.0";
};
type Outcome = "verified" | "unverified" | "failed";
export type Research = {
  id: string;
  question: string;
  deadline: number;
  status: "pending" | "timeout" | Outcome;
  finding?: Finding;
  grant?: string;
  grantUntil?: number;
};
export type ResearchCommand =
  | { action: "start"; id: string; question: string }
  | { action: "finish"; id: string; status: Outcome; finding?: Finding }
  | { action: "present"; id: string; grant: string }
  | { action: "release"; id: string; grant: string }
  | { action: "spoken"; id: string; grant: string };

function readFinding(value: unknown): Finding | undefined {
  if (!record(value)) return;
  const { answer, conditions, title, publisher, url } = value;
  if (
    !shortText(answer, 240) ||
    !shortText(conditions, 240) ||
    !shortText(title, 120) ||
    !shortText(publisher, 100) ||
    !shortText(url, value.source === "web" ? 2048 : 256)
  )
    return;
  if (value.source === "web") {
    const link = URL.parse(url);
    if (
      !link ||
      link.protocol !== "https:" ||
      link.username ||
      link.password ||
      link.port ||
      !/^[a-z0-9.-]+\.[a-z]{2,63}$/i.test(link.hostname) ||
      /(?:^|\.)(localhost|local|internal|test|invalid)$/i.test(link.hostname) ||
      /[\s\\]/.test(url) ||
      value.license !== undefined
    )
      return;
    return { answer, conditions, title, publisher, url, source: "web" };
  }
  if (
    !/^https:\/\/www\.f-cp\.jp\/shimin\/guide\/guide05\/(#c0[12])?$/.test(
      url,
    ) &&
    !/^https:\/\/data\.worldbank\.org\/indicator\/SP\.POP\.TOTL\?locations=[A-Z]{2}&start=\d{4}&end=\d{4}$/.test(
      url,
    )
  )
    return;
  const license = value.license;
  if (license !== undefined && license !== "CC-BY-4.0") return;
  return {
    answer,
    conditions,
    title,
    publisher,
    url,
    ...(license && { license }),
  };
}

export function readResearchCommand(input: unknown): ResearchCommand | null {
  if (!record(input) || !isUuidV4OrV5(input.id)) return null;
  const { id, action } = input;
  if (action === "start" && shortText(input.question, 180))
    return { id, action, question: input.question.trim() };
  if (
    (action === "present" || action === "spoken" || action === "release") &&
    isUuidV4OrV5(input.grant)
  )
    return { id, action, grant: input.grant };
  if (action === "finish") {
    const { status } = input;
    if (status === "failed" || status === "unverified")
      return { id, action, status };
    const finding = readFinding(input.finding);
    if (status === "verified" && finding)
      return { id, action, status, finding };
  }
  return null;
}

export function expireResearch(rows: Research[], now: number): Research[] {
  let changed = false;
  const updated = rows.map((row): Research => {
    if (row.status === "pending" && now >= row.deadline) {
      changed = true;
      return { ...row, status: "timeout" };
    }
    if (row.grantUntil !== undefined && now >= row.grantUntil) {
      changed = true;
      const copy = { ...row };
      delete copy.grant;
      delete copy.grantUntil;
      return copy;
    }
    return row;
  });
  return changed ? updated : rows;
}

export function publicResearch(rows: Research[]) {
  return rows.map(({ grant, grantUntil, ...row }) => {
    // Older saved World Bank findings predate the license field.
    const finding = row.finding;
    return {
      ...row,
      ...(finding?.url.startsWith("https://data.worldbank.org/") && {
        finding: { ...finding, license: "CC-BY-4.0" as const },
      }),
      presented: !!grant || grantUntil !== undefined,
    };
  });
}

export function updateResearch(
  rows: Research[],
  cmd: ResearchCommand,
  now: number,
) {
  const current = rows.find((r) => r.id === cmd.id);
  const replace = (row: Research) => rows.map((r) => (r === current ? row : r));
  if (cmd.action === "start") {
    if (current)
      return {
        rows,
        status: current.question === cmd.question ? current.status : "conflict",
      };
    // Bounded room field shares the notebook's lifetime and stays below Firestore's document limit.
    if (rows.length >= 48) return { rows, status: "full" };
    if (rows.some((r) => r.status === "pending"))
      return { rows, status: "busy" };
    const pending: Research = {
      id: cmd.id,
      question: cmd.question,
      deadline: now + 30_000,
      status: "pending",
    };
    return { rows: [...rows, pending], status: pending.status };
  }
  if (!current) return { rows, status: "missing" };
  if (cmd.action === "release" || cmd.action === "spoken") {
    if (current.grant !== cmd.grant || current.grantUntil === undefined)
      return { rows, status: "unavailable" };
    const updated = { ...current };
    delete updated.grantUntil;
    if (cmd.action === "release") delete updated.grant;
    return { rows: replace(updated), status: cmd.action };
  }
  if (cmd.action === "present") {
    if (
      current.status !== "verified" ||
      !current.finding ||
      (current.grant &&
        (current.grant !== cmd.grant || current.grantUntil === undefined))
    )
      return { rows, status: "unavailable" };
    return {
      rows: current.grant
        ? rows
        : replace({ ...current, grant: cmd.grant, grantUntil: now + 60_000 }),
      status: "present",
      speech: current.finding.answer,
    };
  }
  if (current.status === "timeout") return { rows, status: "timeout" };
  if (current.status !== "pending") {
    const sameFinding = Object.entries(cmd.finding ?? {}).every(
      ([key, value]) => current.finding?.[key as keyof Finding] === value,
    );
    return {
      rows,
      status:
        current.status === cmd.status && sameFinding
          ? current.status
          : "conflict",
    };
  }
  return {
    rows: replace({
      ...current,
      status: cmd.status,
      ...(cmd.finding && { finding: cmd.finding }),
    }),
    status: cmd.status,
  };
}
