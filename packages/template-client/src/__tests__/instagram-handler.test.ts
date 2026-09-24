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
