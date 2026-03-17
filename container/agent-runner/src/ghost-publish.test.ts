import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(),
      readFileSync: vi.fn(),
    },
  };
});

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  publishToGhost,
  createGhostToken,
  uploadImageToGhost,
  updateGhostPostImage,
} from './ghost-publish.js';

describe('ghost-publish', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createGhostToken', () => {
    it('creates a valid JWT structure', () => {
      const token = createGhostToken('key-id', 'aabbccdd');
      const parts = token.split('.');
      expect(parts).toHaveLength(3);

      const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      expect(header).toEqual({ alg: 'HS256', typ: 'JWT', kid: 'key-id' });

      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      expect(payload.aud).toBe('/admin/');
      expect(payload.exp - payload.iat).toBe(300);
    });
  });

  describe('publishToGhost', () => {
    it('reads blog-draft.md, extracts title, and posts to Ghost', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        '# My Blog Post\n\nSome content here.\n\nMore content.',
      );

      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            posts: [{ id: 'post-123', url: 'https://blog.com/my-post' }],
          }),
      });

      const result = await publishToGhost({
        directory: '20260316-test',
        ghostUrl: 'https://blog.com',
        ghostAdminApiKey: 'keyid:aabbccdd',
        blogRepoPath: '/workspace/projects/pj/huynh.io',
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('My Blog Post');
      expect(result.message).toContain('post-123');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://blog.com/ghost/api/admin/posts/',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        }),
      );

      // Verify the POST body contains the title and markdown content (without title)
      const fetchCall = mockFetch.mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.posts[0].title).toBe('My Blog Post');
      expect(body.posts[0].status).toBe('draft');
    });

    it('returns error for invalid directory name', async () => {
      const result = await publishToGhost({
        directory: '../escape',
        ghostUrl: 'https://blog.com',
        ghostAdminApiKey: 'keyid:aabbccdd',
        blogRepoPath: '/workspace/projects/pj/huynh.io',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid directory');
    });

    it('returns error for invalid API key format', async () => {
      const result = await publishToGhost({
        directory: '20260316-test',
        ghostUrl: 'https://blog.com',
        ghostAdminApiKey: 'no-colon-here',
        blogRepoPath: '/workspace/projects/pj/huynh.io',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid GHOST_ADMIN_API_KEY');
    });

    it('returns error when blog-draft.md not found', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await publishToGhost({
        directory: '20260316-test',
        ghostUrl: 'https://blog.com',
        ghostAdminApiKey: 'keyid:aabbccdd',
        blogRepoPath: '/workspace/projects/pj/huynh.io',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    });

    it('returns error on Ghost API failure', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('# Title\n\nContent');

      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        json: () =>
          Promise.resolve({
            errors: [{ message: 'Unauthorized' }],
          }),
      });

      const result = await publishToGhost({
        directory: '20260316-test',
        ghostUrl: 'https://blog.com',
        ghostAdminApiKey: 'keyid:aabbccdd',
        blogRepoPath: '/workspace/projects/pj/huynh.io',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('401');
      expect(result.message).toContain('Unauthorized');
    });

    it('uses directory as fallback title when no heading found', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('No heading here, just content.');

      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            posts: [{ id: 'post-456', url: 'https://blog.com/post' }],
          }),
      });

      const result = await publishToGhost({
        directory: '20260316-fallback-title',
        ghostUrl: 'https://blog.com',
        ghostAdminApiKey: 'keyid:aabbccdd',
        blogRepoPath: '/workspace/projects/pj/huynh.io',
      });

      expect(result.success).toBe(true);

      const fetchCall = mockFetch.mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.posts[0].title).toBe('20260316-fallback-title');
    });

    it('returns postId on successful publish', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('# Title\n\nContent');

      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            posts: [{ id: 'post-789', url: 'https://blog.com/title' }],
          }),
      });

      const result = await publishToGhost({
        directory: '20260316-test',
        ghostUrl: 'https://blog.com',
        ghostAdminApiKey: 'keyid:aabbccdd',
        blogRepoPath: '/workspace/projects/pj/huynh.io',
      });

      expect(result.success).toBe(true);
      expect(result.postId).toBe('post-789');
    });

    it('uploads image and sets feature_image when featureImagePath provided', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (String(p).endsWith('blog-draft.md')) return '# My Post\n\nContent';
        return Buffer.from('fake-image-data');
      });

      // First call: image upload
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            images: [{ url: 'https://blog.com/content/images/header.jpg' }],
          }),
      });
      // Second call: post creation
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            posts: [{ id: 'post-img', url: 'https://blog.com/my-post' }],
          }),
      });

      const result = await publishToGhost({
        directory: '20260316-test',
        ghostUrl: 'https://blog.com',
        ghostAdminApiKey: 'keyid:aabbccdd',
        blogRepoPath: '/workspace/projects/pj/huynh.io',
        featureImagePath: '/workspace/projects/pj/huynh.io/20260316-test/header.jpg',
      });

      expect(result.success).toBe(true);
      expect(result.postId).toBe('post-img');

      // Image upload call
      expect(mockFetch.mock.calls[0][0]).toBe(
        'https://blog.com/ghost/api/admin/images/upload/',
      );
      expect(mockFetch.mock.calls[0][1].method).toBe('POST');

      // Post creation call includes feature_image
      const postBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(postBody.posts[0].feature_image).toBe(
        'https://blog.com/content/images/header.jpg',
      );
    });

    it('returns error when image upload fails', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (String(p).endsWith('blog-draft.md')) return '# My Post\n\nContent';
        return Buffer.from('fake-image-data');
      });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () =>
          Promise.resolve({ errors: [{ message: 'Upload failed' }] }),
      });

      const result = await publishToGhost({
        directory: '20260316-test',
        ghostUrl: 'https://blog.com',
        ghostAdminApiKey: 'keyid:aabbccdd',
        blogRepoPath: '/workspace/projects/pj/huynh.io',
        featureImagePath: '/workspace/projects/pj/huynh.io/20260316-test/header.jpg',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('image upload');
    });
  });

  describe('uploadImageToGhost', () => {
    it('uploads image and returns URL', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-image'));

      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            images: [
              { url: 'https://blog.com/content/images/photo.jpg', ref: 'photo.jpg' },
            ],
          }),
      });

      const result = await uploadImageToGhost({
        imagePath: '/path/to/photo.jpg',
        ghostUrl: 'https://blog.com',
        ghostAdminApiKey: 'keyid:aabbccdd',
      });

      expect(result.success).toBe(true);
      expect(result.imageUrl).toBe('https://blog.com/content/images/photo.jpg');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://blog.com/ghost/api/admin/images/upload/',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('returns error when image file not found', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await uploadImageToGhost({
        imagePath: '/path/to/missing.jpg',
        ghostUrl: 'https://blog.com',
        ghostAdminApiKey: 'keyid:aabbccdd',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    });

    it('returns error on API failure', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-image'));

      mockFetch.mockResolvedValue({
        ok: false,
        status: 413,
        json: () =>
          Promise.resolve({ errors: [{ message: 'File too large' }] }),
      });

      const result = await uploadImageToGhost({
        imagePath: '/path/to/huge.jpg',
        ghostUrl: 'https://blog.com',
        ghostAdminApiKey: 'keyid:aabbccdd',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('413');
    });

    it('returns error for invalid API key format', async () => {
      const result = await uploadImageToGhost({
        imagePath: '/path/to/photo.jpg',
        ghostUrl: 'https://blog.com',
        ghostAdminApiKey: 'invalid-key',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid GHOST_ADMIN_API_KEY');
    });
  });

  describe('updateGhostPostImage', () => {
    it('fetches post then updates feature_image', async () => {
      // GET post
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            posts: [{ id: 'post-123', updated_at: '2024-01-01T00:00:00.000Z' }],
          }),
      });
      // PUT update
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            posts: [
              {
                id: 'post-123',
                feature_image: 'https://blog.com/images/header.jpg',
              },
            ],
          }),
      });

      const result = await updateGhostPostImage({
        postId: 'post-123',
        imageUrl: 'https://blog.com/images/header.jpg',
        ghostUrl: 'https://blog.com',
        ghostAdminApiKey: 'keyid:aabbccdd',
      });

      expect(result.success).toBe(true);

      // Verify GET call
      expect(mockFetch.mock.calls[0][0]).toBe(
        'https://blog.com/ghost/api/admin/posts/post-123/',
      );
      expect(mockFetch.mock.calls[0][1].method).toBe('GET');

      // Verify PUT call
      expect(mockFetch.mock.calls[1][0]).toBe(
        'https://blog.com/ghost/api/admin/posts/post-123/',
      );
      expect(mockFetch.mock.calls[1][1].method).toBe('PUT');
      const putBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(putBody.posts[0].feature_image).toBe(
        'https://blog.com/images/header.jpg',
      );
      expect(putBody.posts[0].updated_at).toBe('2024-01-01T00:00:00.000Z');
    });

    it('returns error when GET post fails', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: () =>
          Promise.resolve({ errors: [{ message: 'Post not found' }] }),
      });

      const result = await updateGhostPostImage({
        postId: 'missing',
        imageUrl: 'https://blog.com/images/header.jpg',
        ghostUrl: 'https://blog.com',
        ghostAdminApiKey: 'keyid:aabbccdd',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('404');
    });

    it('returns error when PUT update fails', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            posts: [{ id: 'post-123', updated_at: '2024-01-01T00:00:00.000Z' }],
          }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 422,
        json: () =>
          Promise.resolve({ errors: [{ message: 'Validation error' }] }),
      });

      const result = await updateGhostPostImage({
        postId: 'post-123',
        imageUrl: 'https://blog.com/images/header.jpg',
        ghostUrl: 'https://blog.com',
        ghostAdminApiKey: 'keyid:aabbccdd',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('422');
    });

    it('returns error for invalid API key format', async () => {
      const result = await updateGhostPostImage({
        postId: 'post-123',
        imageUrl: 'https://blog.com/images/header.jpg',
        ghostUrl: 'https://blog.com',
        ghostAdminApiKey: 'no-colon',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid GHOST_ADMIN_API_KEY');
    });
  });
});
