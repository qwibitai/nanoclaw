import fs from 'fs';
import https from 'https';

/**
 * Download a file from an HTTPS URL and save it to disk.
 */
export function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https
      .get(url, (response) => {
        if (response.statusCode !== 200) {
          file.close();
          fs.unlink(destPath, () => {});
          reject(
            new Error(`Download failed with status ${response.statusCode}`),
          );
          return;
        }
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      })
      .on('error', (err) => {
        file.close();
        fs.unlink(destPath, () => {});
        reject(err);
      });
  });
}
