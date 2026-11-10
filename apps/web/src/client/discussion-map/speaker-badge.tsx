import type { Utterance } from "./types";

const palette = [
  "#304d93",
  "#125e4b",
  "#8d3659",
  "#794a16",
  "#66418b",
  "#3b5962",
];

export function getSpeakerColors(utterances: readonly Utterance[]) {
  const colors = new Map<string, string>();
  for (const { speaker } of utterances) {
    if (!colors.has(speaker))
      colors.set(speaker, palette[colors.size % palette.length]!);
  }
  return colors;
}

export function SpeakerBadge({
  name,
  colors,
}: {
  name: string;
  colors: ReadonlyMap<string, string>;
}) {
  return (
    <span className="map-speaker" style={{ backgroundColor: colors.get(name) }}>
      {name}
    </span>
  );
}
