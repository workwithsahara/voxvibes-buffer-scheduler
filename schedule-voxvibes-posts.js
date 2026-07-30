#!/usr/bin/env node
/**
 * Voxvibes International → Buffer daily queue top-up (EVERGREEN)
 * -----------------------------------------------------------------------
 * Standalone automation for "Voxvibes International" — LinkedIn Page and
 * Facebook Page, both on the same Buffer account (which also has a
 * separate LinkedIn Profile channel, "khaliljerro", handled by its own
 * separate repo/automation with different, dated content).
 *
 * KEY DIFFERENCE FROM THE LAYA/ATW REPOS: this content library has NO
 * YEAR FOLDER — just month folders (01_january .. 12_december) directly
 * under the root. That means it's EVERGREEN: the same "August 1st" post
 * is reused every year, forever (2026, 2027, 2028, ...), with no need to
 * ever duplicate content into new year folders. The script matches by
 * calendar month+day, not by a specific year.
 *
 * Filenames follow the same pattern as LAYA: "DD_<monabbrev><DD>_<slug>.png",
 * e.g. "01_aug01_national-mustard-day.png" — the leading DD is the day of
 * month, and the slug becomes that day's caption (title-cased).
 *
 * Runs unattended (e.g. via GitHub Actions cron, or any daily cron job).
 * Each run:
 *   1. Discovers month folders under ROOT_FOLDER_ID (e.g. "08_august"),
 *      then PNGs inside each, building a month-day calendar: "08-01" ->
 *      { fileId, title }. No folder IDs are hardcoded.
 *   2. Walks forward from today, day by day (real calendar dates), looking
 *      up each date's month-day in that calendar — so content cycles
 *      through every year automatically with zero maintenance.
 *   3. For each channel, schedules as many missing dates as the account's
 *      plan limit allows, one post/day, earliest date first.
 *   4. Posts at POST_TIME_LOCAL in POST_UTC_OFFSET.
 *
 * Because Buffer plans cap total *scheduled* (not yet sent) posts, this
 * script is safe to run every day forever — as old posts publish, slots
 * free up and the next unscheduled day gets queued automatically.
 *
 * Required environment variables (set as repo/CI secrets):
 *   BUFFER_API_KEY        Personal API key for this Buffer account
 *   BUFFER_ORG_ID         This Buffer account's organization ID
 *   BUFFER_CHANNEL_IDS    Comma-separated channel IDs (LinkedIn Page, Facebook Page)
 *   GOOGLE_DRIVE_API_KEY  API key with Drive API enabled (read-only is fine)
 *   ROOT_FOLDER_ID        Drive folder ID of the "Social Media" folder
 *                         (the one containing month folders like "08_august")
 * Optional:
 *   BUFFER_MIN_DATE            Default skip-before date (YYYY-MM-DD) applied
 *                               to any channel without its own override.
 *   BUFFER_CHANNEL_MIN_DATES   Per-channel overrides, comma-separated
 *                               "channelId=YYYY-MM-DD" pairs (empty date =
 *                               no minimum for that channel).
 *   POST_TIME_LOCAL       Default "19:00:00" (7 PM)
 *   POST_UTC_OFFSET       Default "+08:00" (Asia/Manila)
 *   LOOKAHEAD_DAYS         Default 400 — how many real calendar days ahead
 *                          of today to scan for matching content. 400
 *                          safely covers more than a full year, so it
 *                          never runs out of dates to consider even if the
 *                          Buffer plan limit is raised later.
 *   DRY_RUN                 "true" to log without creating posts
 *
 * Requires Node.js 18+ (uses global fetch).
 */

const BUFFER_API_KEY = requireEnv("BUFFER_API_KEY");
const ORG_ID = requireEnv("BUFFER_ORG_ID");
const CHANNEL_IDS = requireEnv("BUFFER_CHANNEL_IDS").split(",").map((s) => s.trim());
const DRIVE_API_KEY = requireEnv("GOOGLE_DRIVE_API_KEY");
const ROOT_FOLDER_ID = requireEnv("ROOT_FOLDER_ID");

const DEFAULT_MIN_DATE = process.env.BUFFER_MIN_DATE || null;

function parseChannelMinDates(raw) {
  const map = {};
  if (!raw) return map;
  for (const pair of raw.split(",")) {
    const [channelId, date] = pair.split("=").map((s) => (s || "").trim());
    if (!channelId) continue;
    map[channelId] = date || null;
  }
  return map;
}
const CHANNEL_MIN_DATES = parseChannelMinDates(process.env.BUFFER_CHANNEL_MIN_DATES);
function minDateFor(channelId) {
  return channelId in CHANNEL_MIN_DATES ? CHANNEL_MIN_DATES[channelId] : DEFAULT_MIN_DATE;
}

const POST_TIME_LOCAL = process.env.POST_TIME_LOCAL || "19:00:00";
const POST_UTC_OFFSET = process.env.POST_UTC_OFFSET || "+08:00";
const LOOKAHEAD_DAYS = parseInt(process.env.LOOKAHEAD_DAYS || "400", 10);
const DRY_RUN = process.env.DRY_RUN === "true";

const MONTH_NUMBERS = {
  january: "01", february: "02", march: "03", april: "04",
  may: "05", june: "06", july: "07", august: "08",
  september: "09", october: "10", november: "11", december: "12",
};

const BUFFER_GRAPHQL_URL = "https://api.buffer.com/graphql";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Google Drive helpers
// ---------------------------------------------------------------------------
async function listSubfolders(folderId) {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set(
    "q",
    `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
  );
  url.searchParams.set("fields", "files(id,name)");
  url.searchParams.set("pageSize", "100");
  url.searchParams.set("key", DRIVE_API_KEY);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Drive folder list failed for ${folderId}: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.files || [];
}

async function listDriveFolderFiles(folderId) {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("q", `'${folderId}' in parents and mimeType = 'image/png' and trashed = false`);
  url.searchParams.set("fields", "files(id,name)");
  url.searchParams.set("pageSize", "100");
  url.searchParams.set("key", DRIVE_API_KEY);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Drive file list failed for folder ${folderId}: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.files || [];
}

// Parses "01_aug01_national-mustard-day.png" -> { day: 1, slug: "national-mustard-day" }
function parseFilename(name) {
  const m = name.match(/^(\d{1,2})_[a-z]+\d{1,2}_(.+)\.png$/i);
  if (!m) return null;
  return { day: parseInt(m[1], 10), slug: m[2] };
}

function titleFromSlug(slug) {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Parses a month folder name. Accepts "08_august", "8_august", or just
// "august" — pulls the month number either from a leading number or by
// matching the full month name.
function parseMonthFolderName(name) {
  const numPrefixMatch = name.match(/^(\d{1,2})_/);
  if (numPrefixMatch) {
    return String(parseInt(numPrefixMatch[1], 10)).padStart(2, "0");
  }
  const nameMatch = name.toLowerCase().match(/[a-z]+/);
  if (nameMatch && MONTH_NUMBERS[nameMatch[0]]) {
    return MONTH_NUMBERS[nameMatch[0]];
  }
  return null;
}

// Discovers ROOT_FOLDER_ID/<MM_month>/*.png and builds an EVERGREEN
// month-day calendar: { "08-01": { fileId, title }, "08-02": {...}, ... }
// No year involved — same key applies every year.
async function buildMonthDayCalendar() {
  const calendar = {};
  const monthFolders = await listSubfolders(ROOT_FOLDER_ID);

  for (const monthFolder of monthFolders) {
    const monthNum = parseMonthFolderName(monthFolder.name);
    if (!monthNum) {
      console.warn(`Skipping unrecognized month folder: ${monthFolder.name}`);
      continue;
    }

    const files = await listDriveFolderFiles(monthFolder.id);
    for (const f of files) {
      const parsed = parseFilename(f.name);
      if (!parsed) {
        console.warn(`Skipping file with unexpected name: ${monthFolder.name}/${f.name}`);
        continue;
      }
      const monthDayKey = `${monthNum}-${String(parsed.day).padStart(2, "0")}`;
      calendar[monthDayKey] = { fileId: f.id, title: titleFromSlug(parsed.slug) };
    }
  }

  return calendar;
}

// Given today's date, returns an ordered list of { dateKey, monthDayKey }
// for the next `days` real calendar days (today included), so we can look
// up each one against the evergreen month-day calendar.
function upcomingDates(days) {
  const out = [];
  const start = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const dateKey = d.toISOString().slice(0, 10); // YYYY-MM-DD
    const monthDayKey = dateKey.slice(5); // MM-DD
    out.push({ dateKey, monthDayKey });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Buffer GraphQL helpers
// ---------------------------------------------------------------------------
async function bufferRequest(query, variables) {
  const res = await fetch(BUFFER_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${BUFFER_API_KEY}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) {
    throw new Error(`Buffer API error: ${JSON.stringify(data.errors)}`);
  }
  return data.data;
}

async function getOrgScheduledPostLimit() {
  const query = `
    query Account {
      account { organizations { id limits { scheduledPosts } } }
    }
  `;
  const data = await bufferRequest(query, {});
  const org = data.account.organizations.find((o) => o.id === ORG_ID);
  return org ? org.limits.scheduledPosts : 10;
}

async function getChannelServices(channelIds) {
  const query = `
    query Channels($organizationId: OrganizationId!) {
      channels(input: { organizationId: $organizationId }) { id service }
    }
  `;
  const data = await bufferRequest(query, { organizationId: ORG_ID });
  const map = {};
  for (const ch of data.channels) {
    if (channelIds.includes(ch.id)) map[ch.id] = ch.service;
  }
  return map;
}

async function getScheduledDates(channelId) {
  const query = `
    query Posts($organizationId: OrganizationId!, $channelIds: [ChannelId!]) {
      posts(input: { organizationId: $organizationId, filter: { channelIds: $channelIds, status: [scheduled] } }, first: 100) {
        edges { node { dueAt } }
      }
    }
  `;
  const data = await bufferRequest(query, { organizationId: ORG_ID, channelIds: [channelId] });
  return new Set(data.posts.edges.map((e) => e.node.dueAt.slice(0, 10)));
}

async function createPost({ channelId, service, fileId, title, dueAtIso }) {
  const mutation = `
    mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess { post { id status dueAt } }
        ... on LimitReachedError { message }
        ... on InvalidInputError { message }
        ... on UnexpectedError { message }
      }
    }
  `;
  const input = {
    channelId,
    mode: "customScheduled",
    schedulingType: "automatic",
    dueAt: dueAtIso,
    text: title,
    assets: [
      {
        image: {
          url: `https://lh3.googleusercontent.com/d/${fileId}`,
          metadata: { altText: title },
        },
      },
    ],
  };

  // Facebook and Instagram require an explicit post "type" — omitting it
  // throws "Facebook posts require a type (post, story, or reel)".
  if (service === "facebook") {
    input.metadata = { facebook: { type: "post" } };
  } else if (service === "instagram") {
    input.metadata = { instagram: { type: "post", shouldShareToFeed: true } };
  }
  // LinkedIn doesn't require an explicit type.

  if (DRY_RUN) {
    console.log(`[DRY RUN] Would create post: channel=${channelId} (${service}) dueAt=${dueAtIso} title="${title}"`);
    return;
  }
  const data = await bufferRequest(mutation, { input });
  const payload = data.createPost;
  if (payload.message) {
    throw new Error(`createPost failed: ${payload.message}`);
  }
  console.log(`Scheduled: channel=${channelId} (${service}) dueAt=${dueAtIso} title="${title}" -> post ${payload.post.id}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`Run started ${new Date().toISOString()}${DRY_RUN ? " [DRY RUN]" : ""}`);

  const calendar = await buildMonthDayCalendar();
  const monthDayCount = Object.keys(calendar).length;
  console.log(`Loaded ${monthDayCount} evergreen month-day entries from Drive (applies every year).`);

  const dates = upcomingDates(LOOKAHEAD_DAYS);

  const limit = await getOrgScheduledPostLimit();
  console.log(`Buffer scheduled-post limit per channel: ${limit}`);

  const services = await getChannelServices(CHANNEL_IDS);

  for (const channelId of CHANNEL_IDS) {
    const service = services[channelId] || "unknown";
    const channelMinDate = minDateFor(channelId);
    console.log(`\nChannel ${channelId} (${service}) — minimum date: ${channelMinDate || "(none)"}`);

    let scheduledDates;
    try {
      scheduledDates = await getScheduledDates(channelId);
    } catch (err) {
      console.error(`Skipping channel ${channelId}: couldn't read current schedule (${err.message})`);
      continue;
    }
    let scheduledCount = scheduledDates.size;
    console.log(`Channel ${channelId}: ${scheduledCount}/${limit} slots currently used.`);

    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 3;

    for (const { dateKey, monthDayKey } of dates) {
      if (scheduledCount >= limit) break;
      if (channelMinDate && dateKey < channelMinDate) continue;
      if (scheduledDates.has(dateKey)) continue;

      const entry = calendar[monthDayKey];
      if (!entry) continue; // no content for this month-day, skip

      const dueAtIso = `${dateKey}T${POST_TIME_LOCAL}${POST_UTC_OFFSET}`;

      try {
        await createPost({ channelId, service, fileId: entry.fileId, title: entry.title, dueAtIso });
        scheduledCount++;
        consecutiveFailures = 0;
      } catch (err) {
        console.error(`Failed to schedule ${dateKey} on ${channelId}: ${err.message}`);
        consecutiveFailures++;
        if (/limit/i.test(err.message)) break;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`Stopping this channel after ${consecutiveFailures} consecutive failures.`);
          break;
        }
      }
    }
  }

  console.log("\nRun complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
