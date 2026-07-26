export interface ParsedTimeSignature {
  numerator: number;
  denominator: number;
}

export const parseTimeSignature = (
  timeSignature: string | undefined,
): ParsedTimeSignature => {
  const [rawNumerator, rawDenominator] = (timeSignature ?? '4/4').split('/');
  const numerator = Number.parseInt(rawNumerator ?? '', 10);
  const denominator = Number.parseInt(rawDenominator ?? '', 10);

  return {
    numerator: Number.isFinite(numerator) && numerator > 0 ? numerator : 4,
    denominator: Number.isFinite(denominator) && denominator > 0 ? denominator : 4,
  };
};

export const quarterNoteBeatsPerBar = (timeSignature: string | undefined): number => {
  const { numerator, denominator } = parseTimeSignature(timeSignature);
  return numerator * (4 / denominator);
};
