// These fixtures contain only fictional participants and conversations.
export const people = [
  { name: "アオイ", initial: "A", color: "peach" },
  { name: "ハル", initial: "H", color: "mint" },
  { name: "ユイ", initial: "Y", color: "butter" },
] as const;
export const presets = ["ノト", "ピコ", "ロロ"] as const;
export type Preset = (typeof presets)[number];
export const inviteCode = "AINOTE";
export const roomPath = "/rooms/demo";
export const reflections = ["話せた", "少し", "話せなかった"] as const;
export type Reflection = (typeof reflections)[number];

export type Part = {
  aim?: string;
  partId: string;
  name: string;
  minutes: number;
  notes: string[];
};
export type SampleNote = {
  member?: Preset;
  id: string;
  topic: string;
  date: string;
  role: "主催" | "参加";
  parts: Part[];
  reflection?: Reflection;
  speaking?: string;
};
export const sampleNotes: SampleNote[] = [
  {
    id: "bookclub",
    topic: "次の読書会で読む本を決める",
    date: "2026.11.06",
    role: "主催",
    parts: [
      {
        partId: "sample-0",
        name: "読みたいテーマ",
        minutes: 8,
        notes: [
          "日常の見方が少し変わる本を選びたい。",
          "短い章なら忙しい週も続けやすい。",
        ],
      },
      {
        partId: "sample-1",
        name: "候補を持ち寄る",
        minutes: 12,
        notes: ["それぞれが気になる一冊と、その理由を紹介した。"],
      },
      {
        partId: "sample-2",
        name: "次回の準備",
        minutes: 8,
        notes: ["初回は第一章まで読み、気になった一文を持ち寄る。"],
      },
      { partId: "sample-13", name: "振り返り", minutes: 2, notes: [] },
    ],
    reflection: "話せた",
    speaking: "6分18秒",
  },
  {
    id: "exhibition",
    topic: "学園祭の展示アイデア",
    date: "2026.11.04",
    role: "参加",
    parts: [
      {
        partId: "sample-3",
        name: "アイデアを出す",
        minutes: 15,
        notes: [
          "来場者が参加できる展示にする。",
          "入口に小さな投票スペースを置く案が出た。",
        ],
      },
      {
        partId: "sample-4",
        name: "準備するもの",
        minutes: 13,
        notes: ["次回までに会場図と材料の候補を集める。"],
      },
      { partId: "sample-13", name: "振り返り", minutes: 2, notes: [] },
    ],
    reflection: "少し",
    speaking: "4分32秒",
  },
];

export function sampleParts(minutes: number): Part[] {
  const first = Math.floor(minutes / 3);
  return [
    { partId: "sample-10", name: "考えを持ち寄る", minutes: first, notes: [] },
    {
      partId: "sample-11",
      name: "アイデアを深める",
      minutes: minutes - first - 5,
      notes: [],
    },
    { partId: "sample-12", name: "次の一歩を決める", minutes: 3, notes: [] },
    { partId: "sample-13", name: "振り返り", minutes: 2, notes: [] },
  ];
}
