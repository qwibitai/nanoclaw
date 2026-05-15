import { createHash, createHmac } from 'crypto';

function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

function isoBasic(date: Date): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

export async function uploadToR2(opts: {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  objectKey: string;
  body: Buffer;
  contentType: string;
}): Promise<void> {
  const now = new Date();
  const { amzDate, dateStamp } = isoBasic(now);
  const region = 'auto';
  const service = 's3';
  const host = `${opts.accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${opts.bucket}/${opts.objectKey.split('/').map(encodeURIComponent).join('/')}`;
  const payloadHash = sha256Hex(opts.body);
  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = ['PUT', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${opts.secretAccessKey}`, dateStamp), region), service), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const url = `https://${host}${canonicalUri}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      authorization:
        `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${credentialScope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'content-type': opts.contentType,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    },
    body: opts.body,
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`R2 upload failed: ${res.status} ${detail.slice(0, 300)}`);
  }
}

export async function deleteFromR2(opts: {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  objectKey: string;
}): Promise<void> {
  const now = new Date();
  const { amzDate, dateStamp } = isoBasic(now);
  const region = 'auto';
  const service = 's3';
  const host = `${opts.accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${opts.bucket}/${opts.objectKey.split('/').map(encodeURIComponent).join('/')}`;
  const payloadHash = sha256Hex('');
  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = ['DELETE', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${opts.secretAccessKey}`, dateStamp), region), service), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const url = `https://${host}${canonicalUri}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      authorization:
        `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${credentialScope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    },
  });

  if (!res.ok && res.status !== 404) {
    const detail = await res.text();
    throw new Error(`R2 delete failed: ${res.status} ${detail.slice(0, 300)}`);
  }
}
