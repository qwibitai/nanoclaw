import pixelmatch from 'pixelmatch';

export interface DiffResult {
  changed: boolean;
  diffPercentage: number;
  threshold: number;
}

/**
 * Compare two raw RGBA pixel buffers.
 * @param before - RGBA pixel buffer
 * @param after - RGBA pixel buffer
 * @param width - image width in pixels
 * @param height - image height in pixels
 * @param thresholdPercent - percentage of changed pixels to consider "changed" (default 5%)
 */
export function compareScreenshots(
  before: Buffer,
  after: Buffer,
  width: number,
  height: number,
  thresholdPercent: number = 5,
): DiffResult {
  const totalPixels = width * height;
  const diff = Buffer.alloc(width * height * 4);

  // Force alpha=255 on both buffers so pixelmatch does not skip transparent pixels.
  // Screenshots are opaque; treating them as fully transparent causes missed diffs.
  const normBefore = Buffer.from(before);
  const normAfter = Buffer.from(after);
  for (let i = 3; i < normBefore.length; i += 4) {
    normBefore[i] = 255;
    normAfter[i] = 255;
  }

  const mismatchCount = pixelmatch(normBefore, normAfter, diff, width, height, {
    threshold: 0.1,
  });

  const diffPercentage = (mismatchCount / totalPixels) * 100;

  return {
    changed: diffPercentage > thresholdPercent,
    diffPercentage: Math.round(diffPercentage * 100) / 100,
    threshold: thresholdPercent,
  };
}
