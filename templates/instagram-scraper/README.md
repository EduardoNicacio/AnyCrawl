# Instagram Scraper

Version 1.0.3 extracts public data visible to logged-out Instagram visitors. It does not log in or request private content.

## Supported inputs

- A public profile URL such as `https://www.instagram.com/masonthames/`: profile details plus the media currently visible on the first page. This is not a complete account history.
- A direct public post URL, with or without a username prefix, such as `https://www.instagram.com/masonthames/p/DVeGNnwCBJ0/`.
- A direct public Reel URL such as `https://www.instagram.com/theacademy/reel/DV63zEuEhHk/`.

A direct post or Reel includes caption, available image or video URL, available counts, and the comments visible on that public page. `comment_count` is the site's total; `comments_loaded` is the number actually returned. The handler never labels visible comments as the full discussion.

Instagram currently redirects `/explore/tags/<tag>/` to a Popular topic page. That page is not an exact hashtag feed, so hashtag URLs are unsupported and return an extraction error. Private, gated, unavailable, and unsupported pages also fail rather than returning an empty successful result.

## Input variables

- `waitFor`: delay before extraction, in milliseconds. Default: `500`.
- `timeoutMs`: request timeout override, in milliseconds. Default: `60000`.

Send one URL per Run. The result is persisted in Run history. A Dataset is attached only if the caller explicitly selects one.

## Output

`jsonResult` contains structured items:

- `type: "profile"` — public profile fields and `visible_media_count`.
- `type: "post"` or `type: "reel"` — media URL, caption, thumbnail, available counts, and source URL. Profile media items contain only fields visible in the profile preload.
- Direct post or Reel items may include `comments`, with `comments_loaded` recording the visible count.

`markdown` is a readable summary of the same public data. The Store Run results page displays the structured items individually, and the raw JSON remains available.

The public page and its preload format can change. A successful Run means at least one structured item was extracted from the page served to that Run; it does not guarantee that Instagram exposed every post or comment.
