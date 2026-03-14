#!/usr/bin/env npx tsx
/**
 * Google Drive Tool for NanoClaw
 *
 * Usage:
 *   npx tsx tools/drive/drive.ts list [--folder-id <id>]
 *   npx tsx tools/drive/drive.ts search --name "apollo" [--mime "text/csv"]
 *   npx tsx tools/drive/drive.ts download --file-id <id> --output /tmp/file.csv
 *   npx tsx tools/drive/drive.ts info --file-id <id>
 *
 * Environment variables:
 *   GOOGLE_SERVICE_ACCOUNT_KEY — JSON string of the service account key
 */

import { google, drive_v3 } from 'googleapis';
import fs from 'fs';

type Action = 'list' | 'search' | 'download' | 'info';

interface Args {
  action: Action;
  folderId?: string;
  name?: string;
  mime?: string;
  fileId?: string;
  output?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const action = argv[0] as Action;

  if (!['list', 'search', 'download', 'info'].includes(action)) {
    console.error(JSON.stringify({
      status: 'error',
      error: `Unknown action "${action}". Use: list, search, download, info`,
      usage: [
        'npx tsx tools/drive/drive.ts list [--folder-id <id>]',
        'npx tsx tools/drive/drive.ts search --name "apollo" [--mime "text/csv"]',
        'npx tsx tools/drive/drive.ts download --file-id <id> --output /tmp/file.csv',
        'npx tsx tools/drive/drive.ts info --file-id <id>',
      ],
    }));
    process.exit(1);
  }

  const flags: Record<string, string> = {};
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      flags[argv[i].slice(2)] = argv[++i];
    }
  }

  return {
    action,
    folderId: flags['folder-id'],
    name: flags.name,
    mime: flags.mime,
    fileId: flags['file-id'],
    output: flags.output,
  };
}

function getAuth(): InstanceType<typeof google.auth.JWT> {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

  if (!keyJson) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'Missing GOOGLE_SERVICE_ACCOUNT_KEY environment variable.',
    }));
    process.exit(1);
  }

  let key: { client_email: string; private_key: string };
  try {
    key = JSON.parse(keyJson);
  } catch {
    console.error(JSON.stringify({
      status: 'error',
      error: 'GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON.',
    }));
    process.exit(1);
  }

  return new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
}

function getDrive(auth: InstanceType<typeof google.auth.JWT>): drive_v3.Drive {
  return google.drive({ version: 'v3', auth });
}

async function listFiles(drive: drive_v3.Drive, folderId?: string) {
  let query = 'trashed = false';
  if (folderId) {
    query += ` and '${folderId}' in parents`;
  }

  const files: Array<{ id: string; name: string; mimeType: string; size: string; modifiedTime: string }> = [];
  let pageToken: string | undefined;

  do {
    const res = await drive.files.list({
      q: query,
      fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime)',
      pageSize: 100,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    for (const f of res.data.files || []) {
      files.push({
        id: f.id || '',
        name: f.name || '',
        mimeType: f.mimeType || '',
        size: f.size || '0',
        modifiedTime: f.modifiedTime || '',
      });
    }

    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);

  console.log(JSON.stringify({
    status: 'success',
    action: 'list',
    count: files.length,
    files,
  }));
}

async function searchFiles(drive: drive_v3.Drive, name: string, mime?: string) {
  let query = `trashed = false and name contains '${name.replace(/'/g, "\\'")}'`;
  if (mime) {
    query += ` and mimeType = '${mime}'`;
  }

  const res = await drive.files.list({
    q: query,
    fields: 'files(id, name, mimeType, size, modifiedTime, parents)',
    pageSize: 50,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const files = (res.data.files || []).map((f) => ({
    id: f.id || '',
    name: f.name || '',
    mimeType: f.mimeType || '',
    size: f.size || '0',
    modifiedTime: f.modifiedTime || '',
    parents: f.parents || [],
  }));

  console.log(JSON.stringify({
    status: 'success',
    action: 'search',
    query: name,
    count: files.length,
    files,
  }));
}

async function downloadFile(drive: drive_v3.Drive, fileId: string, output: string) {
  // First get file metadata to check type
  const meta = await drive.files.get({
    fileId,
    fields: 'name, mimeType, size',
    supportsAllDrives: true,
  });

  const mimeType = meta.data.mimeType || '';

  let content: string;

  // Google Workspace files need to be exported
  if (mimeType === 'application/vnd.google-apps.spreadsheet') {
    const res = await drive.files.export({
      fileId,
      mimeType: 'text/csv',
    }, { responseType: 'text' });
    content = res.data as string;
  } else if (mimeType === 'application/vnd.google-apps.document') {
    const res = await drive.files.export({
      fileId,
      mimeType: 'text/plain',
    }, { responseType: 'text' });
    content = res.data as string;
  } else {
    // Regular files — detect binary vs text
    const isBinary = /^(image|video|audio)\//.test(mimeType)
      || /^application\/(pdf|zip|octet-stream|x-tar|gzip)/.test(mimeType);

    if (isBinary) {
      const res = await drive.files.get({
        fileId,
        alt: 'media',
        supportsAllDrives: true,
      }, { responseType: 'arraybuffer' });
      const buf = Buffer.from(res.data as ArrayBuffer);
      fs.writeFileSync(output, buf);

      console.log(JSON.stringify({
        status: 'success',
        action: 'download',
        fileId,
        fileName: meta.data.name,
        mimeType,
        outputPath: output,
        size: buf.length,
      }));
      return;
    } else {
      const res = await drive.files.get({
        fileId,
        alt: 'media',
        supportsAllDrives: true,
      }, { responseType: 'text' });
      content = res.data as string;
    }
  }

  fs.writeFileSync(output, content, 'utf-8');

  console.log(JSON.stringify({
    status: 'success',
    action: 'download',
    fileId,
    fileName: meta.data.name,
    mimeType,
    outputPath: output,
    size: Buffer.byteLength(content, 'utf-8'),
  }));
}

async function fileInfo(drive: drive_v3.Drive, fileId: string) {
  const res = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType, size, modifiedTime, createdTime, parents, webViewLink',
    supportsAllDrives: true,
  });

  console.log(JSON.stringify({
    status: 'success',
    action: 'info',
    file: {
      id: res.data.id,
      name: res.data.name,
      mimeType: res.data.mimeType,
      size: res.data.size,
      modifiedTime: res.data.modifiedTime,
      createdTime: res.data.createdTime,
      parents: res.data.parents,
      webViewLink: res.data.webViewLink,
    },
  }));
}

async function main() {
  const args = parseArgs();
  const auth = getAuth();
  const drive = getDrive(auth);

  try {
    switch (args.action) {
      case 'list':
        await listFiles(drive, args.folderId);
        break;

      case 'search':
        if (!args.name) {
          console.error(JSON.stringify({ status: 'error', error: 'search requires --name' }));
          process.exit(1);
        }
        await searchFiles(drive, args.name, args.mime);
        break;

      case 'download':
        if (!args.fileId || !args.output) {
          console.error(JSON.stringify({ status: 'error', error: 'download requires --file-id and --output' }));
          process.exit(1);
        }
        await downloadFile(drive, args.fileId, args.output);
        break;

      case 'info':
        if (!args.fileId) {
          console.error(JSON.stringify({ status: 'error', error: 'info requires --file-id' }));
          process.exit(1);
        }
        await fileInfo(drive, args.fileId);
        break;
    }
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    const statusCode = (err as { code?: number })?.code;
    if (statusCode === 401 || statusCode === 403) {
      console.error(JSON.stringify({
        status: 'error',
        error,
        hint: `Google Drive API returned ${statusCode}. Verify: (1) Drive API is enabled in Google Cloud Console, (2) The file/folder is shared with the service account email (found in GOOGLE_SERVICE_ACCOUNT_KEY → client_email), (3) The service account has the correct access level.`,
      }));
    } else if (statusCode === 404) {
      console.error(JSON.stringify({
        status: 'error',
        error,
        hint: 'File or folder not found. Check the file ID and ensure it is shared with the service account.',
      }));
    } else {
      console.error(JSON.stringify({ status: 'error', error }));
    }
    process.exit(1);
  }
}

main();
