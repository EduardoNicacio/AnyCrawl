import { describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(
  resolve(process.cwd(), '../../templates/instagram-scraper/requestHandler.js'),
  'utf8',
);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const run = new AsyncFunction('context', source) as (context: unknown) => Promise<any>;

describe('published Instagram handler', () => {
  it('extracts a public profile from its page preload without waiting for the old API', async () => {
    const user = {
      username: 'masonthames', full_name: 'Mason Thames',
      follower_count: 3306694, following_count: 562,
      is_verified: true, profile_pic_url: 'https://example.test/avatar.jpg',
    };
    const html = `<script type="application/json" data-sjs>${JSON.stringify({
      require: [{ __bbox: { result: { data: { xig_user_by_username: user } } } }],
    })}</script>`;
    const wait = jest.fn();

    const result = await run({
      request: { url: 'https://www.instagram.com/masonthames/' },
      html,
      preNav: { has: async () => false, wait },
    });

    expect(wait).not.toHaveBeenCalled();
    expect(result.jsonResult).toEqual([expect.objectContaining({
      type: 'profile', username: 'masonthames', followers_count: 3306694,
    })]);
    expect(result.markdown).toContain('Mason Thames');
  });

  it('includes visible profile media as separate structured items', async () => {
    const profile = { pk: 'user-1', username: 'masonthames', full_name: 'Mason Thames', follower_count: 42 };
    const timeline = { pk: 'user-1', polaris_ordered_timeline_connection: { edges: [{ node: {
      code: 'DVeGNnwCBJ0', media_type: 8, product_type: 'carousel_container',
      user: { username: 'masonthames' }, caption: { text: 'Paris' },
      display_uri: 'https://example.test/post.jpg',
    } }] } };
    const html = [profile, timeline].map(user =>
      `<script type="application/json" data-sjs>${JSON.stringify({ data: { xig_user_by_username: user } })}</script>`
    ).join('');

    const result = await run({ request: { url: 'https://www.instagram.com/masonthames/' }, html });
    expect(result.jsonResult).toHaveLength(2);
    expect(result.jsonResult[0]).toMatchObject({ type: 'profile', visible_media_count: 1 });
    expect(result.jsonResult[1]).toMatchObject({
      type: 'post', reel_id: 'DVeGNnwCBJ0', caption: 'Paris',
      url: 'https://www.instagram.com/masonthames/p/DVeGNnwCBJ0/',
    });
  });

  it('extracts a direct Reel and its visible public comments', async () => {
    const media = {
      code: 'DV63zEuEhHk',
      if_not_gated_logged_out: {
        code: 'DV63zEuEhHk', media_type: 2, product_type: 'clips',
        user: { username: 'theacademy' }, caption: { text: 'On set' },
        display_uri: 'https://example.test/cover.jpg',
        video_versions: [{ url: 'https://example.test/video.mp4' }],
        like_count: 500, comment_count: 100,
      },
      comments_connection: { edges: [{ node: {
        pk: 'comment-1', text: 'Great clip', user: { username: 'viewer' },
      } }] },
    };
    const html = `<script type="application/json" data-sjs>${JSON.stringify({ data: { xig_polaris_media: media } })}</script>`;

    const result = await run({ request: { url: 'https://www.instagram.com/theacademy/reel/DV63zEuEhHk/' }, html });
    expect(result.jsonResult).toHaveLength(1);
    expect(result.jsonResult[0]).toMatchObject({
      type: 'reel', caption: 'On set', like_count: 500, comments_loaded: 1,
      comments: [expect.objectContaining({ username: 'viewer', text: 'Great clip' })],
    });
  });

  it('accepts a direct post URL nested under a username', async () => {
    const media = { code: 'DVeGNnwCBJ0', if_not_gated_logged_out: {
      code: 'DVeGNnwCBJ0', media_type: 1, user: { username: 'masonthames' },
      display_uri: 'https://example.test/post.jpg',
    } };
    const html = `<script type="application/json" data-sjs>${JSON.stringify({ data: { xig_polaris_media: media } })}</script>`;
    const result = await run({ request: { url: 'https://www.instagram.com/masonthames/p/DVeGNnwCBJ0/' }, html });
    expect(result.jsonResult[0]).toMatchObject({ type: 'post', reel_id: 'DVeGNnwCBJ0' });
  });

  it('fails when a profile page has no public profile data', async () => {
    const wait = jest.fn(async () => undefined);
    await expect(run({
      request: { url: 'https://www.instagram.com/masonthames/' },
      html: '<html></html>',
      preNav: { has: async () => false, wait },
    })).rejects.toThrow('No public Instagram data was extracted');
    expect(wait).toHaveBeenCalledWith('instagramProfileInfo', { timeoutMs: 3000 });
  });
});
