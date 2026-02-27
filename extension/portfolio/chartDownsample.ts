export type ChartPoint = { ts: number; price: number };

export function downsampleChartPoints(points: ChartPoint[], maxPoints: number): ChartPoint[] {
  const boundedMax = Math.max(2, Math.floor(maxPoints));
  if (points.length <= boundedMax) return points;

  const out: ChartPoint[] = [];
  out.push(points[0]);

  const interiorTarget = boundedMax - 2;
  const interiorCount = points.length - 2;
  const stride = interiorCount / interiorTarget;
  let lastIndex = 0;

  for (let i = 0; i < interiorTarget; i += 1) {
    const candidate = 1 + Math.floor(i * stride);
    const nextIndex = Math.min(points.length - 2, Math.max(lastIndex + 1, candidate));
    out.push(points[nextIndex]);
    lastIndex = nextIndex;
  }

  out.push(points[points.length - 1]);
  return out;
}
