export function normalizeScale(value: number): number {
  if (!Number.isFinite(value)) return 100;
  return Math.min(200, Math.max(50, Math.round(value / 10) * 10));
}
