import { describe, expect, it } from "vitest";

import { downsampleChartPoints } from "../../extension/portfolio/chartDownsample";

describe("chart downsampling", () => {
  it("returns original series when already under cap", () => {
    const points = [
      { ts: 1, price: 10 },
      { ts: 2, price: 11 },
      { ts: 3, price: 12 },
    ];

    const result = downsampleChartPoints(points, 5);
    expect(result).toEqual(points);
  });

  it("keeps first/last points and enforces max length", () => {
    const points = Array.from({ length: 50 }, (_, idx) => ({
      ts: idx + 1,
      price: (idx + 1) * 1.5,
    }));

    const result = downsampleChartPoints(points, 10);
    expect(result).toHaveLength(10);
    expect(result[0]).toEqual(points[0]);
    expect(result[result.length - 1]).toEqual(points[points.length - 1]);
  });
});
