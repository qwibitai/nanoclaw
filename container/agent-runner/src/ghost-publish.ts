/**
 * Ghost CMS draft publishing.
 * Shared between the container MCP tool and the host CLI script.
 *
 * Reads blog-draft.md from a thesis directory, extracts the title,
 * and creates a draft post via the Ghost Admin API.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface GhostPublishOptions {
  directory: string;
  ghostUrl: string;
  ghostAdminApiKey: string;
  blogRepoPath: string;
  featureImagePath?: string;
}

export interface GhostPublishResult {
  success: boolean;
  message: string;
  postId?: string;
}

export interface GhostImageUploadOptions {
  imagePath: string;
  ghostUrl: string;
  ghostAdminApiKey: string;
}

export interface GhostImageUploadResult {
  success: boolean;
  message: string;
  imageUrl?: string;
}

export interface GhostUpdateImageOptions {
  postId: string;
  imageUrl: string;
  ghostUrl: string;
  ghostAdminApiKey: string;
}

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

function parseApiKey(apiKey: string): { keyId: string; keySecret: string } | null {
  const [keyId, keySecret] = apiKey.split(':');
  if (!keyId || !keySecret) return null;
  return { keyId, keySecret };
}

function parseGhostErrors(body: { errors?: { message: string }[] }): string {
  return (
    body.errors?.map((e) => e.message).join(', ') || JSON.stringify(body)
  );
}

export function createGhostToken(id: string, secret: string): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: id }),
  ).toString('base64url');

  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ iat: now, exp: now + 300, aud: '/admin/' }),
  ).toString('base64url');

  const secretBytes = Buffer.from(secret, 'hex');
  const signature = crypto
    .createHmac('sha256', secretBytes)
    .update(`${header}.${payload}`)
    .digest('base64url');

  return `${header}.${payload}.${signature}`;
}

export async function uploadImageToGhost(
  options: GhostImageUploadOptions,
): Promise<GhostImageUploadResult> {
  const { imagePath, ghostUrl, ghostAdminApiKey } = options;

  const keys = parseApiKey(ghostAdminApiKey);
  if (!keys) {
    return {
      success: false,
      message: 'Invalid GHOST_ADMIN_API_KEY format. Expected {id}:{secret}',
    };
  }

  if (!fs.existsSync(imagePath)) {
    return { success: false, message: `Image not found: ${imagePath}` };
  }

  const ext = path.extname(imagePath).toLowerCase();
  const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
  const filename = path.basename(imagePath);

  const fileBuffer = fs.readFileSync(imagePath);
  const blob = new Blob([fileBuffer], { type: mimeType });

  const formData = new FormData();
  formData.append('file', blob, filename);
  formData.append('purpose', 'image');

  const token = createGhostToken(keys.keyId, keys.keySecret);
  const apiUrl = `${ghostUrl.replace(/\/+$/, '')}/ghost/api/admin/images/upload/`;

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { Authorization: `Ghost ${token}` },
      body: formData,
    });

    const body = await response.json();

    if (!response.ok) {
      return {
        success: false,
        message: `Ghost image upload error (${response.status}): ${parseGhostErrors(body)}`,
      };
    }

    const imageUrl = body.images?.[0]?.url;
    if (!imageUrl) {
      return { success: false, message: 'Ghost returned no image URL' };
    }

    return { success: true, message: `Image uploaded: ${imageUrl}`, imageUrl };
  } catch (err) {
    return {
      success: false,
      message: `Failed to upload image: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function updateGhostPostImage(
  options: GhostUpdateImageOptions,
): Promise<GhostPublishResult> {
  const { postId, imageUrl, ghostUrl, ghostAdminApiKey } = options;

  const keys = parseApiKey(ghostAdminApiKey);
  if (!keys) {
    return {
      success: false,
      message: 'Invalid GHOST_ADMIN_API_KEY format. Expected {id}:{secret}',
    };
  }

  const token = createGhostToken(keys.keyId, keys.keySecret);
  const baseUrl = ghostUrl.replace(/\/+$/, '');
  const postUrl = `${baseUrl}/ghost/api/admin/posts/${postId}/`;

  try {
    // GET the post to retrieve updated_at (required for optimistic locking)
    const getResponse = await fetch(postUrl, {
      method: 'GET',
      headers: { Authorization: `Ghost ${token}` },
    });

    const getBody = await getResponse.json();

    if (!getResponse.ok) {
      return {
        success: false,
        message: `Ghost API error fetching post (${getResponse.status}): ${parseGhostErrors(getBody)}`,
      };
    }

    const updatedAt = getBody.posts?.[0]?.updated_at;

    // PUT to update the feature_image
    const putResponse = await fetch(postUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Ghost ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        posts: [{ feature_image: imageUrl, updated_at: updatedAt }],
      }),
    });

    const putBody = await putResponse.json();

    if (!putResponse.ok) {
      return {
        success: false,
        message: `Ghost API error updating post (${putResponse.status}): ${parseGhostErrors(putBody)}`,
      };
    }

    return {
      success: true,
      message: `Feature image set on post ${postId}`,
      postId,
    };
  } catch (err) {
    return {
      success: false,
      message: `Failed to update post image: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function publishToGhost(
  options: GhostPublishOptions,
): Promise<GhostPublishResult> {
  const { directory, ghostUrl, ghostAdminApiKey, blogRepoPath, featureImagePath } = options;

  if (!/^[\w-]+$/.test(directory)) {
    return { success: false, message: `Invalid directory name: ${directory}` };
  }

  const keys = parseApiKey(ghostAdminApiKey);
  if (!keys) {
    return {
      success: false,
      message: 'Invalid GHOST_ADMIN_API_KEY format. Expected {id}:{secret}',
    };
  }

  const draftPath = path.join(blogRepoPath, directory, 'blog-draft.md');
  if (!fs.existsSync(draftPath)) {
    return { success: false, message: `Blog draft not found: ${draftPath}` };
  }

  // Upload feature image first if provided
  let featureImageUrl: string | undefined;
  if (featureImagePath) {
    const imageResult = await uploadImageToGhost({
      imagePath: featureImagePath,
      ghostUrl,
      ghostAdminApiKey,
    });

    if (!imageResult.success) {
      return {
        success: false,
        message: `Ghost image upload failed: ${imageResult.message}`,
      };
    }

    featureImageUrl = imageResult.imageUrl;
  }

  const markdown = fs.readFileSync(draftPath, 'utf-8');

  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : directory;

  const content = titleMatch
    ? markdown.replace(/^#\s+.+\n*/, '').trim()
    : markdown.trim();

  const mobiledoc = JSON.stringify({
    version: '0.3.1',
    markups: [],
    atoms: [],
    cards: [['markdown', { markdown: content }]],
    sections: [[10, 0]],
  });

  const token = createGhostToken(keys.keyId, keys.keySecret);
  const apiUrl = `${ghostUrl.replace(/\/+$/, '')}/ghost/api/admin/posts/`;

  try {
    const postData: Record<string, string> = { title, mobiledoc, status: 'draft' };
    if (featureImageUrl) {
      postData.feature_image = featureImageUrl;
    }

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Ghost ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ posts: [postData] }),
    });

    const body = await response.json();

    if (!response.ok) {
      return {
        success: false,
        message: `Ghost API error (${response.status}): ${parseGhostErrors(body)}`,
      };
    }

    const post = body.posts?.[0];
    return {
      success: true,
      message: `Ghost draft created: "${title}" (id: ${post?.id}, url: ${post?.url})`,
      postId: post?.id,
    };
  } catch (err) {
    return {
      success: false,
      message: `Failed to create Ghost draft: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
