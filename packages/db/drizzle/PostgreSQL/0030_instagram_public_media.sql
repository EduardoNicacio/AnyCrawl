-- Publish the public profile timeline, direct media and visible comment handler.
UPDATE "templates"
SET "custom_handlers" = jsonb_set("custom_handlers", '{requestHandler,code,source}', to_jsonb($ig_handler$
const extractKeyedPayloadFromHtml = (html, targetKey = 'xdt_api__v1__profile_timeline') => {
    const results = [];
    if (typeof html !== 'string' || html.length === 0) return results;

    const matches = [];
    // Only target <script type="application/json" data-sjs ...>
    const scriptRe = /<script(?=[^>]*type=["']application\/json["'])(?=[^>]*\bdata-sjs\b)[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = scriptRe.exec(html)) !== null) {
        const inner = (m[1] || '').trim();
        if (!inner) continue;
        // Prefilter by key presence to avoid parsing large irrelevant blobs
        if (inner.indexOf(targetKey) === -1) continue;
        matches.push(inner);
    }

    const foundTimelines = [];
    const pushIfMatch = (maybeObj, source) => {
        try {
            if (!maybeObj || typeof maybeObj !== 'object') return;
            const direct = maybeObj?.[targetKey];
            if (direct) {
                foundTimelines.push({ source: source || 'direct', payload: direct });
                return;
            }
            const inData = maybeObj?.data?.[targetKey];
            if (inData) {
                foundTimelines.push({ source: source || 'data', payload: inData });
                return;
            }
            const inBbox = maybeObj?.__bbox?.result?.data?.[targetKey];
            if (inBbox) {
                foundTimelines.push({ source: source || '__bbox', payload: inBbox });
                return;
            }
        } catch (_) { }
    };
    const traverse = (node, source) => {
        if (!node) return;
        pushIfMatch(node, source);
        if (Array.isArray(node)) {
            for (const n of node) traverse(n, source);
            return;
        }
        if (typeof node === 'object') {
            for (const key of Object.keys(node)) {
                try { traverse(node[key], source); } catch (_) { }
            }
        }
    };

    for (const raw of matches) {
        try {
            const obj = JSON.parse(raw);
            traverse(obj, 'html-script');
        } catch (_) { }
    }

    const timelineItems = [];
    const seen = new Set();
    for (const r of foundTimelines) {
        const tl = r?.payload;
        if (!tl || typeof tl !== 'object') continue;
        const key = (() => {
            try { return tl?.sections?.[0]?.feed_view_info?.session_id || tl?.timeline?.id || JSON.stringify(Object.keys(tl).sort()); } catch (_) { return Math.random().toString(36); }
        })();
        if (seen.has(key)) continue;
        seen.add(key);
        timelineItems.push({ type: 'ig_script_payload', key: targetKey, source: r?.source || 'html', data: tl });
    }

    return timelineItems;
};

const publicPreloads = (html) => {
    const users = [];
    const media = [];
    if (typeof html !== 'string') return { users, media };
    const scriptRe = /<script(?=[^>]*type=["']application\/json["'])(?=[^>]*\bdata-sjs\b)[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = scriptRe.exec(html)) !== null) {
        const raw = match[1] || '';
        if (raw.length > 2_000_000 || !/xig_user_by_username|xig_polaris_media/.test(raw)) continue;
        try {
            const pending = [JSON.parse(raw)];
            let visited = 0;
            while (pending.length && visited++ < 50_000) {
                const value = pending.pop();
                if (!value || typeof value !== 'object') continue;
                if (value.xig_user_by_username) users.push(value.xig_user_by_username);
                if (value.xig_polaris_media) media.push(value.xig_polaris_media);
                for (const child of Object.values(value)) {
                    if (child && typeof child === 'object') pending.push(child);
                }
            }
        } catch (_) { /* Ignore unrelated or malformed scripts. */ }
    }
    return { users, media };
};

const mediaItem = (media, fallbackUsername, source) => {
    const item = media?.if_not_gated_logged_out || media;
    if (!item || typeof item !== 'object' || !item.code) return null;
    const kind = item.product_type === 'clips' || item.media_type === 2 ? 'reel' : 'post';
    const username = item.user?.username || fallbackUsername || null;
    const mediaPath = `${kind === 'reel' ? 'reel' : 'p'}/${item.code}`;
    const image = item.display_uri || item.image_versions2?.candidates?.[0]?.url ||
        item.carousel_media?.[0]?.display_uri || null;
    const video = item.video_versions?.[0]?.url || null;
    const visibleComments = media?.comments_connection?.edges || [];
    const comments = visibleComments.slice(0, 30).map((edge) => {
        const node = edge?.node || {};
        return {
            id: node.pk || node.id || null,
            username: node.user?.username || null,
            text: node.text || '',
            created_at: node.created_at || null,
            like_count: node.comment_like_count ?? null,
        };
    }).filter((comment) => comment.text);
    return {
        type: kind,
        reel_id: item.code,
        url: username ? `https://www.instagram.com/${username}/${mediaPath}/` : `https://www.instagram.com/${mediaPath}/`,
        username,
        caption: item.caption?.text || item.accessibility_caption || '',
        image,
        video,
        media: (item.carousel_media || []).slice(0, 12).map((part) => ({
            type: part.media_type === 2 ? 'video' : 'image',
            image: part.display_uri || part.image_versions2?.candidates?.[0]?.url || null,
            video: part.video_versions?.[0]?.url || null,
        })),
        created_at: item.taken_at ? new Date(item.taken_at * 1000).toISOString() : null,
        like_count: item.like_count ?? null,
        comment_count: item.comment_count ?? null,
        comments,
        comments_loaded: comments.length,
        source,
    };
};

const extractPublicPage = (html, url) => {
    const { users, media } = publicPreloads(html);
    const profileMatch = url.match(/^https?:\/\/(?:www\.)?instagram\.com\/([\w.\-]+)\/?(?:[?#].*)?$/i);
    if (profileMatch) {
        const username = profileMatch[1];
        const profile = users.find((user) => user?.username?.toLowerCase() === username.toLowerCase());
        if (!profile) return null;
        const timeline = users.find((user) =>
            user?.pk === profile.pk && Array.isArray(user?.polaris_ordered_timeline_connection?.edges));
        const nodes = timeline?.polaris_ordered_timeline_connection?.edges || [];
        const visibleMedia = nodes.map((edge) => mediaItem(edge?.node, username, 'profile_timeline')).filter(Boolean);
        const uniqueMedia = visibleMedia.filter((item, index) =>
            visibleMedia.findIndex((candidate) => candidate.reel_id === item.reel_id) === index);
        const profileItem = {
            type: 'profile', username: profile.username, full_name: profile.full_name || '',
            biography: profile.biography || '', profile_pic_url: profile.profile_pic_url || '',
            followers_count: profile.follower_count ?? null,
            following_count: profile.following_count ?? null,
            posts_count: profile.all_media_count ?? null,
            visible_media_count: uniqueMedia.length,
            is_verified: !!profile.is_verified, is_private: !!profile.is_private, url,
        };
        const mediaLines = uniqueMedia.map((item) => `- ${item.type}: ${item.url}${item.caption ? ` — ${item.caption.slice(0, 180)}` : ''}`);
        const markdown = `# ${profileItem.full_name || username} (@${username})\n\n${profileItem.biography}\n\n` +
            `- Followers: ${profileItem.followers_count ?? 'unknown'}\n` +
            `- Following: ${profileItem.following_count ?? 'unknown'}\n` +
            `- Visible media: ${uniqueMedia.length}\n\n${mediaLines.join('\n')}`;
        return { markdown, jsonResult: [profileItem, ...uniqueMedia] };
    }

    const directMatch = url.match(/^https?:\/\/(?:www\.)?instagram\.com\/(?:(?:[\w.\-]+)\/)?(?:p|reel)\/([\w-]+)\/?(?:[?#].*)?$/i);
    if (!directMatch) return null;
    const root = media.find((entry) => entry?.code === directMatch[1]);
    const item = mediaItem(root, null, 'post_page');
    if (!item) return null;
    item.url = url;
    const comments = item.comments.map((comment) => `- @${comment.username || 'unknown'}: ${comment.text.slice(0, 250)}`);
    const markdown = `# Instagram ${item.type} ${item.reel_id}\n\n${item.caption}\n\n` +
        `- Likes: ${item.like_count ?? 'unknown'}\n- Comments: ${item.comment_count ?? 'unknown'}\n` +
        `- Visible comments: ${item.comments_loaded}\n- URL: ${url}` +
        (comments.length ? `\n\n## Visible comments\n${comments.join('\n')}` : '');
    return { markdown, jsonResult: [item] };
};

const scrapeInstagram = async (context) => {
    const page = context.page;
    const preNav = context.preNav;
    const url = page ? await page.url() : (context.request?.url || '');
    const log = (...args) => console.log('[IG-SCRAPER]', ...args);

    log('Starting extraction for URL:', url);

    const publicResult = extractPublicPage(context.html, url);
    if (publicResult) {
        log('Public page preload extracted:', publicResult.jsonResult.length, 'items');
        return publicResult;
    }

    let jsonResult = [];

    const isInstagramProfileUrl = (() => {
        if (!url || typeof url !== 'string') return false;
        const pattern = /^https?:\/\/(?:[\w-]+\.)?instagram\.com\/[\w.\-]+\/?(?:\?.*)?(?:#.*)?$/i;
        return pattern.test(url.trim());
    })();

    const isInstagramReelUrl = (() => {
        if (!url || typeof url !== 'string') return false;
        // Match /reel/CODE, /p/CODE (post), and /username/reel/CODE
        const pattern = /^https?:\/\/(?:[\w-]+\.)?instagram\.com\/(?:(?:reel|p)\/+|[\w.\-]+\/(?:reel|p)\/+)[A-Za-z0-9_-]+\/?(?:\?.*)?(?:#.*)?$/i;
        return pattern.test(url.trim());
    })();

    log('URL type:', isInstagramProfileUrl ? 'profile' : isInstagramReelUrl ? 'reel' : 'unknown');

    if (isInstagramProfileUrl) {
        const username = url.match(/instagram\.com\/([\w.\-]+)/i)?.[1] || '';
        const preloadedUser = publicPreloads(context.html).users.find((user) =>
            user?.username?.toLowerCase() === username.toLowerCase()) || null;
        try {
            log('Fetching instagramProfileInfo via preNav...');
            let profileInfo;
            if (preNav && typeof preNav === 'object') {
                const exists = await (preNav.has?.('instagramProfileInfo'));
                log('preNav has instagramProfileInfo:', exists);
                if (exists) {
                    profileInfo = await (preNav.get?.('instagramProfileInfo'));
                } else if (!preloadedUser) {
                    log('Waiting briefly for instagramProfileInfo (timeout: 3s)...');
                    profileInfo = await (preNav.wait?.('instagramProfileInfo', { timeoutMs: 3000 }));
                }
            }

            if (!profileInfo?.body) {
                log('preNav instagramProfileInfo returned empty');
                console.warn('preNav instagramProfileInfo returned empty');
            } else {
                log('Got instagramProfileInfo body, length:', profileInfo.body.length);
                const res = JSON.parse(profileInfo.body);
                const user = res?.data?.user;
                if (!user) {
                    log('No user data in web_profile_info response. Keys:', Object.keys(res?.data || {}));
                    console.warn('No user data in web_profile_info response');
                } else {
                    log('User found:', user.username, '| posts:', user.edge_owner_to_timeline_media?.count, '| followers:', user.edge_followed_by?.count);

                    const buildUserMeta = (u) => ({
                        username: u.username,
                        full_name: u.full_name,
                        profile_pic_url: u.profile_pic_url_hd,
                        is_private: u.is_private,
                        is_embeds_disabled: u.is_embeds_disabled,
                        is_unpublished: null,
                        is_verified: u.is_verified,
                        friendship_status: null,
                        latest_reel_media: null,
                        biography: u.biography,
                        business_email: u.business_email,
                        business_phone_number: u.business_phone_number,
                        business_address_json: u.business_address_json,
                        is_business_account: u.is_business_account,
                        posted_count: u.edge_owner_to_timeline_media?.count ?? 0,
                        followers_count: u.edge_followed_by?.count ?? 0,
                        follow_count: u.edge_follow?.count ?? 0,
                    });

                    const buildNodeItem = (node) => ({
                        reel_id: node.shortcode,
                        full_text: node.edge_media_to_caption?.edges?.[0]?.node?.text ?? '',
                        video: node.video_url,
                        image: node.thumbnail_src,
                        token_at: node.taken_at_timestamp,
                        token_at_utc: node.taken_at_timestamp ? new Date(node.taken_at_timestamp * 1000).toISOString() : null,
                        user: buildUserMeta(user),
                        comments: [],
                        usertags: node.edge_media_to_tagged_user?.edges?.map(tag => ({
                            user: {
                                full_name: tag?.node?.user?.full_name,
                                username: tag?.node?.user?.username,
                                profile_pic_url: tag?.node?.user?.profile_pic_url,
                                is_verified: tag?.node?.user?.is_verified,
                                id: tag?.node?.user?.id,
                            }
                        })) || [],
                        location: node.location,
                        has_audio: node.has_audio,
                        has_liked: (node.edge_liked_by?.count ?? 0) > 0,
                        display_uri: node.display_url,
                        video_view_count: node.video_view_count,
                        like_count: node.edge_liked_by?.count ?? 0,
                        comment_count: node.edge_media_to_comment?.count ?? 0,
                        create_at: node.taken_at_timestamp ? new Date(node.taken_at_timestamp * 1000).toISOString() : null,
                        fb_comment_count: null,
                        is_paid_partnership: null,
                        sponsor_tags: null,
                        original_height: node.dimensions?.height,
                        original_width: node.dimensions?.width,
                        is_video: node.is_video,
                    });

                    const timelineEdges = user.edge_owner_to_timeline_media?.edges || [];
                    log('Timeline edges count:', timelineEdges.length);
                    for (const edge of timelineEdges) {
                        if (edge?.node) jsonResult.push(buildNodeItem(edge.node));
                    }

                    const reelEdges = user.edge_felix_video_timeline?.edges || [];
                    log('Reel edges count:', reelEdges.length);
                    for (const edge of reelEdges) {
                        if (edge?.node) jsonResult.push(buildNodeItem(edge.node));
                    }
                    log('Profile extraction done, total items:', jsonResult.length);
                }
            }
        } catch (err) {
            log('Profile extraction error:', err?.message || err);
            console.error('Instagram profile extraction failed:', err?.message || err);
        }

        if (jsonResult.length === 0) {
            const user = preloadedUser;
            if (user) {
                jsonResult.push({
                    type: 'profile',
                    username: user.username,
                    full_name: user.full_name || '',
                    biography: user.biography || '',
                    profile_pic_url: user.profile_pic_url || '',
                    followers_count: user.follower_count ?? null,
                    following_count: user.following_count ?? null,
                    posts_count: user.all_media_count ?? null,
                    is_verified: !!user.is_verified,
                    is_private: !!user.is_private,
                    url,
                });
                log('Profile extracted from page preload:', user.username);
            }
        }
    }

    if (isInstagramReelUrl) {
        try {
            const html = typeof context.html === 'string' ? context.html : '';
            log('Reel HTML length:', html.length);

            let commentsItems = extractKeyedPayloadFromHtml(html, 'xdt_api__v1__media__media_id__comments__connection');
            let webInfo = extractKeyedPayloadFromHtml(html, 'xdt_api__v1__media__shortcode__web_info');
            log('Comments payloads found:', commentsItems.length, '| webInfo payloads found:', webInfo.length);

            const edgesRaw = commentsItems?.[0]?.data?.edges;
            const edgesContainer = edgesRaw || {};
            const parsedComments = Object.values(edgesContainer).map((edge) => ({
                comment_like_count: edge?.node?.comment_like_count,
                parent_comment_id: edge?.node?.parent_comment_id,
                created_at: edge?.node?.created_at,
                text: edge?.node?.text,
                has_liked_comment: edge?.node?.has_liked_comment,
                restricted_status: edge?.node?.restricted_status,
                child_comment_count: edge?.node?.child_comment_count,
                is_covered: edge?.node?.is_covered,
                user: {
                    username: edge?.node?.user?.username,
                    profile_pic_url: edge?.node?.user?.profile_pic_url,
                    is_verified: edge?.node?.user?.is_verified,
                    is_unpublished: edge?.node?.user?.is_unpublished,
                }
            }));
            log('Parsed comments count:', parsedComments.length);

            const webInfoItem = webInfo?.[0]?.data?.items?.[0];
            if (webInfoItem) {
                const u = webInfoItem.user || {};
                log('Reel webInfoItem found, code:', webInfoItem.code, '| user:', u.username);
                jsonResult.push({
                    reel_id: webInfoItem.code,
                    full_text: webInfoItem.caption?.text ?? '',
                    video: webInfoItem.video_versions?.[0]?.url ?? '',
                    image: webInfoItem.image_versions2?.candidates?.[0]?.url ?? '',
                    token_at: webInfoItem.taken_at,
                    token_at_utc: webInfoItem.taken_at ? new Date(webInfoItem.taken_at * 1000).toISOString() : null,
                    user: {
                        username: u.username,
                        full_name: u.full_name,
                        profile_pic_url: u.profile_pic_url,
                        is_private: u.is_private,
                        is_embeds_disabled: u.is_embeds_disabled,
                        is_unpublished: u.is_unpublished,
                        is_verified: u.is_verified,
                        friendship_status: u.friendship_status,
                        latest_reel_media: u.latest_reel_media,
                    },
                    comments: parsedComments,
                    usertags: webInfoItem.usertags?.in?.map(tag => ({
                        user: {
                            full_name: tag?.user?.full_name,
                            username: tag?.user?.username,
                            profile_pic_url: tag?.user?.profile_pic_url,
                            is_verified: tag?.user?.is_verified,
                            id: tag?.user?.id,
                        }
                    })) || [],
                    location: webInfoItem.location,
                    has_audio: webInfoItem.has_audio,
                    has_liked: webInfoItem.has_liked,
                    display_uri: webInfoItem.display_uri,
                    video_view_count: webInfoItem.video_view_count,
                    like_count: webInfoItem.like_count ?? 0,
                    comment_count: webInfoItem.comment_count ?? 0,
                    create_at: webInfoItem.caption?.created_at ? new Date(webInfoItem.caption.created_at * 1000).toISOString() : null,
                    fb_comment_count: webInfoItem.fb_comment_count,
                    is_paid_partnership: webInfoItem.is_paid_partnership,
                    sponsor_tags: webInfoItem.sponsor_tags,
                    original_height: webInfoItem.original_height,
                    original_width: webInfoItem.original_width,
                    is_video: !!webInfoItem.video_versions?.length,
                });
                log('Reel item added to jsonResult');
            } else {
                log('No web_info item found in HTML for reel URL. webInfo raw:', JSON.stringify(webInfo?.[0]?.data?.items?.slice(0, 2)));
                console.warn('No web_info item found in HTML for reel URL');
            }
        } catch (err) {
            log('Reel extraction error:', err?.message || err);
            console.error('Instagram reel extraction failed:', err?.message || err);
        }
    }

    const buildReelMarkdown = (it) => {
        const stats = `Likes ${it.like_count ?? 0} · Comments ${it.comment_count ?? 0}${typeof it.fb_comment_count === 'number' ? ` · FB Comments ${it.fb_comment_count}` : ''}`;
        const createdAt = it.create_at || it.token_at_utc || '';
        const imageUrl = it.image || it.display_uri || '';
        const videoUrl = it.video || '';
        const user = it.user || {};
        const owner = it.owner || {};
        const tagsMd = Array.isArray(it.usertags) && it.usertags.length
            ? `\n\n## Tags\n\n${it.usertags.map(t => {
                const u = t.user || {};
                const uname = u.username ? `@${u.username}` : (u.full_name || '');
                return `- ${uname}`;
            }).join('\n')}`
            : '';
        const commentsMd = Array.isArray(it.comments) && it.comments.length
            ? `\n\n## Comments\n\n${it.comments.map(c => {
                const uname = c?.user?.username ? `@${c.user.username}` : '';
                const likes = typeof c?.comment_like_count === 'number' ? ` · Likes ${c.comment_like_count}` : '';
                const ts = c?.created_at ? ` · ${c.created_at}` : '';
                return `- ${uname}${likes}${ts}\n  ${c?.text || ''}`;
            }).join('\n')}`
            : '';
        const mediaMd = (() => {
            if (imageUrl && videoUrl) return `\n\n## Media\n\n![Image](${imageUrl})\n\nVideo: ${videoUrl}`;
            if (imageUrl) return `\n\n## Media\n\n![Image](${imageUrl})`;
            if (videoUrl) return `\n\n## Media\n\nVideo: ${videoUrl}`;
            return '';
        })();
        const userSection = `## User\n\n- username: ${user.username || ''}\n- full_name: ${user.full_name || ''}\n- is_verified: ${user.is_verified ?? ''}\n- is_private: ${user.is_private ?? ''}\n- profile_pic_url: ${user.profile_pic_url || ''}`;
        const ownerSection = owner && (owner.username || owner.full_name)
            ? `\n\n## Owner\n\n- full_name: ${owner.full_name || ''}\n- username: ${owner.username || ''}\n- is_verified: ${owner.is_verified ?? ''}\n- profile_pic_url: ${owner.profile_pic_url || ''}`
            : '';
        const locationLine = it.location ? `\n\n- Location: ${typeof it.location === 'string' ? it.location : (it.location?.name || '')}` : '';
        return `### ${it.reel_id || ''}\nURL: ${url}\nCreated At: ${createdAt}\nStats: ${stats}${locationLine}\n\n## Content\n\n\`\`\`\n${it.full_text || ''}\n\`\`\`${mediaMd}\n\n${userSection}${ownerSection}${tagsMd}${commentsMd}`;
    };

    let markdown = '';
    if (Array.isArray(jsonResult) && jsonResult.length) {
        if (jsonResult.length === 1) {
            const it = jsonResult[0];
            markdown = it.type === 'profile'
                ? `# ${it.full_name || it.username} (@${it.username})\n\n${it.biography || ''}\n\n- Followers: ${it.followers_count ?? 'unknown'}\n- Following: ${it.following_count ?? 'unknown'}\n- Posts: ${it.posts_count ?? 'unknown'}\n- Verified: ${it.is_verified ? 'yes' : 'no'}\n- URL: ${url}`
                : `# Instagram Reel ${it.reel_id || ''}\n\n${buildReelMarkdown(it)}`;
        } else {
            const itemsMd = jsonResult.map(buildReelMarkdown).join('\n\n');
            markdown = `## Reels\n\nLoaded ${jsonResult.length} reel(s) from ${url}\n\n${itemsMd}`;
        }
    }

    if (jsonResult.length === 0) {
        throw new Error(`No public Instagram data was extracted from ${url}`);
    }

    log('Final result: markdown length:', markdown.length, '| jsonResult count:', jsonResult.length);
    return { markdown, jsonResult };
};


return await scrapeInstagram(context)

$ig_handler$::text),
    "req_options" = '{"engine":"playwright","formats":["markdown"],"timeout":60000,"retry":true,"wait_until":"domcontentloaded","wait_for":500}'::jsonb,
    "description" = 'Extract public Instagram profiles and their currently visible media, or a direct public post or Reel with visible comments. Results depend on what Instagram exposes to logged-out visitors.',
    "review_notes" = 'Public profile timeline and direct post/Reel preload extraction',
    "version" = '1.0.3',
    "updated_at" = NOW()
WHERE "template_id" = 'instagram-scraper' AND "version" = '1.0.2';
