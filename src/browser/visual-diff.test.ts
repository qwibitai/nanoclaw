import { describe, it, expect } from 'vitest';
import { compareScreenshots } from './visual-diff.js';

describe('compareScreenshots', () => {
  it('reports no change for identical images', () => {
    const width = 2;
    const height = 2;
    const pixels = Buffer.alloc(width * height * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = 255; // R
      pixels[i + 1] = 0; // G
      pixels[i + 2] = 0; // B
      pixels[i + 3] = 255; // A
    }

    const result = compareScreenshots(pixels, pixels, width, height);
    expect(result.changed).toBe(false);
    expect(result.diffPercentage).toBe(0);
  });

  it('detects changes between different images', () => {
    const width = 2;
    const height = 2;
    const red = Buffer.alloc(width * height * 4);
    const blue = Buffer.alloc(width * height * 4);
    for (let i = 0; i < red.length; i += 4) {
      red[i] = 255;
      red[i + 1] = 0;
      red[i + 2] = 0;
      red[i + 3] = 255;
      blue[i] = 0;
      blue[i + 1] = 0;
      blue[i + 2] = 255;
      blue[i + 3] = 255;
    }

    const result = compareScreenshots(red, blue, width, height);
    expect(result.changed).toBe(true);
    expect(result.diffPercentage).toBe(100);
  });

  it('respects custom threshold', () => {
    const width = 10;
    const height = 10;
    const img1 = Buffer.alloc(width * height * 4, 0);
    const img2 = Buffer.alloc(width * height * 4, 0);
    // Change 1 pixel out of 100 = 1%
    img2[0] = 255;

    const lowThreshold = compareScreenshots(img1, img2, width, height, 0.5);
    expect(lowThreshold.changed).toBe(true);

    const highThreshold = compareScreenshots(img1, img2, width, height, 5);
    expect(highThreshold.changed).toBe(false);
  });
});
