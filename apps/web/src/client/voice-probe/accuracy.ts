/** Japanese character error rate. Count insertions, deletions and substitutions. */
export function characterErrors(reference: string, transcript: string) {
  const normalize = (s: string) =>
    Array.from(
      s
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[\p{Z}\p{P}\p{C}]/gu, ""),
    );
  const expected = normalize(reference);
  if (!expected.length) return null;
  const actual = normalize(transcript);
  let row = Array.from({ length: actual.length + 1 }, (_, j) => j);
  for (let i = 0; i < expected.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < actual.length; j++) {
      next.push(
        Math.min(
          row[j + 1]! + 1,
          next[j]! + 1,
          row[j]! + Number(expected[i] !== actual[j]),
        ),
      );
    }
    row = next;
  }
  return { edits: row[actual.length]!, characters: expected.length };
}
