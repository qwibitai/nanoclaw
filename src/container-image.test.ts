import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

describe('container entrypoint', () => {
  it('captures stdin before recompiling the runner', () => {
    const dockerfilePath = path.join(process.cwd(), 'container', 'Dockerfile');
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf-8');

    const captureIdx = dockerfile.indexOf('cat > /tmp/input.json');
    const compileIdx = dockerfile.indexOf('npx tsc --outDir /tmp/dist');

    expect(captureIdx).toBeGreaterThanOrEqual(0);
    expect(compileIdx).toBeGreaterThanOrEqual(0);
    expect(captureIdx).toBeLessThan(compileIdx);
  });
});
