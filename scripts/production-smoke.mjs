#!/usr/bin/env node

/**
 * Post-deployment smoke test for the public site and its API.
 *
 * The check deliberately uses only Node's built-in fetch implementation so it
 * can run from a CI job or an operator laptop without installing a test
 * framework. Override the defaults when checking a preview or staging deploy:
 *
 *   SMOKE_SITE_URL=https://preview.example.com \
 *   SMOKE_API_URL=https://api.preview.example.com \
 *   SMOKE_USERNAME=octocat \
 *   node scripts/production-smoke.mjs
 */

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export const DEFAULT_SITE_URL = 'https://vibecodeleaderboard.com';
export const DEFAULT_USERNAME = 'octocat';
export const DEFAULT_TIMEOUT_MS = 30_000;
const SITE_NAME = 'Vibe Code Leaderboard';

const SSE_EVENTS = new Set(['queued', 'started', 'scanning', 'scanned', 'complete', 'error']);

function asObject(value, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function finiteNumber(value, label) {
  assert.equal(typeof value, 'number', `${label} must be a number`);
  assert.ok(Number.isFinite(value), `${label} must be finite`);
}

function nonNegativeNumber(value, label) {
  finiteNumber(value, label);
  assert.ok(value >= 0, `${label} must be non-negative`);
}

function nonEmptyString(value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  assert.ok(value.length > 0, `${label} must not be empty`);
}

function validateToolMap(value, label) {
  asObject(value, label);
  for (const [tool, count] of Object.entries(value)) {
    nonEmptyString(tool, `${label} key`);
    nonNegativeNumber(count, `${label}.${tool}`);
  }
}

export function validateLeaderboard(payload) {
  const leaderboard = asObject(payload, 'leaderboard');
  nonEmptyString(leaderboard.generated_at, 'leaderboard.generated_at');
  assert.ok(Number.isFinite(Date.parse(leaderboard.generated_at)), 'leaderboard.generated_at must be an ISO timestamp');
  assert.ok(Array.isArray(leaderboard.rankings), 'leaderboard.rankings must be an array');

  leaderboard.rankings.forEach((entry, index) => {
    const user = asObject(entry, `leaderboard.rankings[${index}]`);
    nonEmptyString(user.username, `leaderboard.rankings[${index}].username`);
    finiteNumber(user.rank, `leaderboard.rankings[${index}].rank`);
    nonNegativeNumber(user.commit_count, `leaderboard.rankings[${index}].commit_count`);
    nonNegativeNumber(user.commits_30d, `leaderboard.rankings[${index}].commits_30d`);
    nonNegativeNumber(user.unique_repos, `leaderboard.rankings[${index}].unique_repos`);
    assert.ok(Array.isArray(user.recent_repos), `leaderboard.rankings[${index}].recent_repos must be an array`);
    validateToolMap(user.by_tool, `leaderboard.rankings[${index}].by_tool`);
  });

  return leaderboard;
}

export function validateUserResponse(payload) {
  const user = asObject(payload, 'user response');
  nonEmptyString(user.username, 'user response.username');
  finiteNumber(user.rank, 'user response.rank');
  nonNegativeNumber(user.commit_count, 'user response.commit_count');
  nonNegativeNumber(user.commits_30d, 'user response.commits_30d');
  nonNegativeNumber(user.unique_repos, 'user response.unique_repos');
  validateToolMap(user.by_tool, 'user response.by_tool');
  assert.ok(Array.isArray(user.recent_repos), 'user response.recent_repos must be an array');
  return user;
}

export function validateReportResponse(payload) {
  const report = asObject(payload, 'complete report');
  nonEmptyString(report.username, 'complete report.username');
  finiteNumber(report.rank, 'complete report.rank');
  finiteNumber(report.total_ranked, 'complete report.total_ranked');
  finiteNumber(report.percentile, 'complete report.percentile');
  assert.ok(report.percentile >= 0 && report.percentile <= 1, 'complete report.percentile must be between 0 and 1');
  nonNegativeNumber(report.total_commits, 'complete report.total_commits');
  nonNegativeNumber(report.repos_with_commits, 'complete report.repos_with_commits');

  if (report.by_tool !== undefined) validateToolMap(report.by_tool, 'complete report.by_tool');
  if (report.sparkline_30d !== undefined) {
    assert.ok(Array.isArray(report.sparkline_30d), 'complete report.sparkline_30d must be an array');
    assert.equal(report.sparkline_30d.length, 30, 'complete report.sparkline_30d must contain 30 values');
    report.sparkline_30d.forEach((count, index) => nonNegativeNumber(count, `complete report.sparkline_30d[${index}]`));
  }
  if (report.top_repos !== undefined) {
    assert.ok(Array.isArray(report.top_repos), 'complete report.top_repos must be an array');
    report.top_repos.forEach((repo, index) => {
      const item = asObject(repo, `complete report.top_repos[${index}]`);
      nonEmptyString(item.repo, `complete report.top_repos[${index}].repo`);
      nonNegativeNumber(item.commits, `complete report.top_repos[${index}].commits`);
      assert.ok(Array.isArray(item.tools), `complete report.top_repos[${index}].tools must be an array`);
      item.tools.forEach((tool, toolIndex) => nonEmptyString(
        tool,
        `complete report.top_repos[${index}].tools[${toolIndex}]`,
      ));
    });
  }
  if (report.first_ai_commit !== undefined) {
    nonEmptyString(report.first_ai_commit, 'complete report.first_ai_commit');
    assert.ok(Number.isFinite(Date.parse(report.first_ai_commit)), 'complete report.first_ai_commit must be an ISO timestamp');
  }

  return report;
}

// The /u/<username> profile page is user.html transformed by
// functions/u/[username].js for link-preview crawlers. If the function does
// not run, the /u/* redirect in _redirects serves the raw template with its
// placeholder title and static OG tags — reject exactly that.
export function validateProfileHtml(html, { username, profileUrl }) {
  nonEmptyString(html, 'profile html');
  nonEmptyString(username, 'profile username');
  nonEmptyString(profileUrl, 'profile url');

  const title = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  nonEmptyString(title, 'profile <title>');
  assert.doesNotMatch(title, /loading/i,
    'profile <title> is the un-injected user.html placeholder; functions/u/[username].js did not run');
  assert.match(title, new RegExp(escapeRegExp(username), 'i'),
    'profile <title> does not name the requested user');
  assert.ok(title.endsWith(` - ${SITE_NAME}`), `profile <title> must end with " - ${SITE_NAME}"`);

  const ogTitle = metaTagContent(html, 'property', 'og:title');
  assert.equal(ogTitle, title, 'og:title does not match the injected <title>');
  nonEmptyString(metaTagContent(html, 'property', 'og:description'), 'og:description');
  nonEmptyString(metaTagContent(html, 'name', 'description'), 'meta description');

  const image = metaTagContent(html, 'property', 'og:image');
  nonEmptyString(image, 'og:image');
  let imageUrl;
  try {
    imageUrl = new URL(image);
  } catch {
    throw new Error(`og:image is not an absolute URL: ${image}`);
  }
  assert.ok(
    imageUrl.origin === new URL(profileUrl).origin
      && (imageUrl.pathname === '/og-image.png' || imageUrl.pathname.startsWith('/og/')),
    `og:image must be the site's /og/<username> or default /og-image.png, got ${image}`,
  );

  assert.equal(metaTagContent(html, 'property', 'og:url'), profileUrl,
    'og:url does not match the fetched profile URL');
  assert.equal(linkRelHref(html, 'canonical'), profileUrl,
    'canonical link does not match the fetched profile URL');

  return { title, image: imageUrl.href };
}

function metaTagContent(html, attribute, name) {
  const marker = new RegExp(`\\b${attribute}\\s*=\\s*["']${escapeRegExp(name)}["']`, 'i');
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    if (marker.test(tag)) {
      return tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1] ?? null;
    }
  }
  return null;
}

function linkRelHref(html, rel) {
  const marker = new RegExp(`\\brel\\s*=\\s*["']${escapeRegExp(rel)}["']`, 'i');
  const tag = (html.match(/<link\b[^>]*>/gi) || []).find(candidate => marker.test(candidate));
  return tag?.match(/\bhref\s*=\s*["']([^"']*)["']/i)?.[1] ?? null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?${}()|[\]\\]/g, '\\$&');
}

function validateSseEvent(eventName, data, state) {
  assert.ok(SSE_EVENTS.has(eventName), `unexpected SSE event: ${eventName}`);
  asObject(data, `${eventName} event data`);
  assert.equal(state.terminal, false, `SSE event ${eventName} arrived after the terminal event`);

  switch (eventName) {
    case 'queued':
      finiteNumber(data.position, 'queued.position');
      nonNegativeNumber(data.estimated_wait_seconds, 'queued.estimated_wait_seconds');
      break;
    case 'started':
      assert.equal(state.started, false, 'started event must occur at most once');
      nonNegativeNumber(data.repos_found, 'started.repos_found');
      state.started = true;
      break;
    case 'scanning':
      assert.equal(state.started, true, 'scanning must follow started');
      nonEmptyString(data.repo, 'scanning.repo');
      assert.equal(Number.isInteger(data.index), true, 'scanning.index must be an integer');
      assert.equal(Number.isInteger(data.total), true, 'scanning.total must be an integer');
      assert.ok(data.index >= 0 && data.index < data.total, 'scanning.index must be within scanning.total');
      assert.equal(state.scanning.has(data.repo), false, `repo scanned twice: ${data.repo}`);
      state.scanning.set(data.repo, data);
      break;
    case 'scanned':
      assert.equal(state.started, true, 'scanned must follow started');
      nonEmptyString(data.repo, 'scanned.repo');
      assert.ok(state.scanning.has(data.repo), `scanned repo has no matching scanning event: ${data.repo}`);
      assert.equal(state.scanned.has(data.repo), false, `repo completed twice: ${data.repo}`);
      nonNegativeNumber(data.commits_found, 'scanned.commits_found');
      if (data.tools !== undefined) validateToolMap(data.tools, 'scanned.tools');
      state.scanned.add(data.repo);
      break;
    case 'complete':
      validateReportResponse(data);
      state.terminal = true;
      state.terminalName = eventName;
      break;
    case 'error':
      // The client treats the payload as opaque, but the API contract
      // recommends this shape for logs and future clients.
      nonEmptyString(data.code, 'error.code');
      nonEmptyString(data.message, 'error.message');
      state.terminal = true;
      state.terminalName = eventName;
      break;
    default:
      throw new Error(`unhandled SSE event: ${eventName}`);
  }
}

export function parseSseBlock(block, state) {
  const lines = block.split(/\r?\n/);
  let eventName;
  const dataLines = [];

  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trim());
    }
  }

  // Heartbeats/comments are not application events. Any data without a named
  // event would become the browser's default `message` event, which the
  // documented client ignores, so reject it as a broken application event.
  if (!eventName) {
    assert.equal(dataLines.length, 0, 'application SSE events must have a named event field');
    return false;
  }
  assert.equal(dataLines.length, 1, `${eventName} event must contain exactly one data line`);
  let data;
  try {
    data = JSON.parse(dataLines[0]);
  } catch (error) {
    throw new Error(`${eventName} event data is not valid JSON: ${error.message}`);
  }
  validateSseEvent(eventName, data, state);
  state.events.push(eventName);
  return true;
}

async function readSse(response, signal) {
  assert.ok(response.body, 'SSE response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state = { events: [], started: false, scanning: new Map(), scanned: new Set(), terminal: false };
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (signal.aborted) throw new Error('SSE stream timed out');
    buffer += decoder.decode(value, { stream: true });

    let separator;
    while ((separator = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const block = buffer.slice(0, separator);
      buffer = buffer.slice(separator).replace(/^\r?\n\r?\n/, '');
      parseSseBlock(block, state);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) parseSseBlock(buffer, state);
  assert.ok(state.terminal, 'SSE stream ended without a terminal complete/error event');
  assert.equal(state.terminalName, 'complete', 'report smoke test received a terminal error event');
  return state;
}

function normalizeBase(value, label) {
  const url = new URL(value);
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  assert.ok(url.protocol === 'http:' || url.protocol === 'https:', `${label} must use http or https`);
  return url;
}

function endpoint(base, pathname) {
  return new URL(pathname.replace(/^\//, ''), `${base.toString().replace(/\/$/, '')}/`).toString();
}

function assertCors(response, siteOrigin, label) {
  const allowed = response.headers.get('access-control-allow-origin');
  assert.ok(allowed === '*' || allowed === siteOrigin, `${label} is missing CORS for ${siteOrigin}`);
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`${init?.method || 'GET'} ${url} timed out after ${timeoutMs}ms`);
    throw new Error(`${init?.method || 'GET'} ${url} failed: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function readTextWithTimeout(response, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      response.text(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`response body timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function checkSite(site, timeoutMs) {
  const root = await fetchWithTimeout(site.toString(), { headers: { Accept: 'text/html' } }, timeoutMs);
  assert.ok(root.status >= 200 && root.status < 300, `site root returned HTTP ${root.status}`);
  assert.match(root.headers.get('content-type') || '', /text\/html/i, 'site root must return HTML');
  const html = await readTextWithTimeout(root, timeoutMs);
  assert.match(html, /<title>.*Vibe Code Leaderboard.*<\/title>/is, 'site root is not the leaderboard app shell');

  const dataResponse = await fetchWithTimeout(endpoint(site, '/leaderboard.json'), {
    headers: { Accept: 'application/json' },
  }, timeoutMs);
  assert.equal(dataResponse.status, 200, `leaderboard.json returned HTTP ${dataResponse.status}`);
  assert.match(dataResponse.headers.get('content-type') || '', /application\/json/i, 'leaderboard.json must return JSON');
  let payload;
  try {
    payload = JSON.parse(await readTextWithTimeout(dataResponse, timeoutMs));
  } catch (error) {
    throw new Error(`leaderboard.json is not valid JSON: ${error.message}`);
  }
  validateLeaderboard(payload);
  return payload;
}

async function checkProfilePage(site, username, timeoutMs) {
  const profilePath = `/u/${encodeURIComponent(username)}`;
  const response = await fetchWithTimeout(
    endpoint(site, profilePath),
    { headers: { Accept: 'text/html' } },
    timeoutMs,
  );
  assert.equal(response.status, 200, `profile page ${profilePath} returned HTTP ${response.status}`);
  assert.match(response.headers.get('content-type') || '', /text\/html/i, 'profile page must return HTML');
  const html = await readTextWithTimeout(response, timeoutMs);
  // The function echoes the request URL into og:url/canonical, so compare
  // against the post-redirect URL the fetch actually landed on.
  const profileUrl = new URL(response.url || endpoint(site, profilePath)).href;
  return validateProfileHtml(html, { username, profileUrl });
}

async function checkApi(api, siteOrigin, username, timeoutMs) {
  const headers = { Origin: siteOrigin };
  const health = await fetchWithTimeout(endpoint(api, '/health'), { method: 'HEAD', headers }, timeoutMs);
  assert.ok((health.status >= 200 && health.status < 300) || health.status === 404,
    `API health returned HTTP ${health.status}`);
  assertCors(health, siteOrigin, 'API health response');

  const userResponse = await fetchWithTimeout(endpoint(api, `/user/${encodeURIComponent(username)}`), {
    headers: { ...headers, Accept: 'application/json' },
  }, timeoutMs);
  assertCors(userResponse, siteOrigin, 'user response');
  if (userResponse.status === 200) {
    let userPayload;
    try {
      userPayload = JSON.parse(await readTextWithTimeout(userResponse, timeoutMs));
    } catch (error) {
      throw new Error(`user response is not valid JSON: ${error.message}`);
    }
    validateUserResponse(userPayload);
  } else if (userResponse.status === 404) {
    let notFound;
    try {
      notFound = JSON.parse(await readTextWithTimeout(userResponse, timeoutMs));
    } catch (error) {
      throw new Error(`user 404 response is not valid JSON: ${error.message}`);
    }
    asObject(notFound, 'user 404 response');
    nonEmptyString(notFound.detail, 'user 404 response.detail');
  } else {
    throw new Error(`user endpoint returned unexpected HTTP ${userResponse.status}`);
  }

  const reportPath = `/report/${encodeURIComponent(username)}`;
  const streamController = new AbortController();
  const timer = setTimeout(() => streamController.abort(), timeoutMs);
  try {
    const streamResponse = await fetch(endpoint(api, `${reportPath}/stream`), {
      headers: { ...headers, Accept: 'text/event-stream' },
      signal: streamController.signal,
    });
    assert.equal(streamResponse.status, 200, `report SSE returned HTTP ${streamResponse.status}`);
    assert.match(streamResponse.headers.get('content-type') || '', /text\/event-stream/i,
      'report stream must return text/event-stream');
    assertCors(streamResponse, siteOrigin, 'report stream response');

    const trigger = await fetch(endpoint(api, reportPath), {
      method: 'POST',
      headers: { ...headers, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: '',
      signal: streamController.signal,
    });
    assert.ok(trigger.status >= 200 && trigger.status < 300,
      `report trigger returned HTTP ${trigger.status}`);
    assertCors(trigger, siteOrigin, 'report trigger response');

    return await readSse(streamResponse, streamController.signal);
  } catch (error) {
    if (error.name === 'AbortError' || streamController.signal.aborted) {
      throw new Error(`report SSE timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function runSmoke({
  siteUrl = process.env.SMOKE_SITE_URL || DEFAULT_SITE_URL,
  apiUrl,
  username = process.env.SMOKE_USERNAME || DEFAULT_USERNAME,
  timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  log = console.log,
} = {}) {
  const site = normalizeBase(siteUrl, 'SMOKE_SITE_URL');
  const api = normalizeBase(
    apiUrl || process.env.SMOKE_API_URL || `https://api.${site.hostname.replace(/^www\./, '')}`,
    'SMOKE_API_URL',
  );
  nonEmptyString(username, 'SMOKE_USERNAME');
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0, 'SMOKE_TIMEOUT_MS must be a positive integer');

  log(`production smoke: site ${site.origin}`);
  await checkSite(site, timeoutMs);
  log('  ok: site shell and leaderboard.json');
  await checkProfilePage(site, username, timeoutMs);
  log(`  ok: profile page /u/${username} injects title and OG tags`);
  const state = await checkApi(api, site.origin, username, timeoutMs);
  log(`  ok: API health, user/${username}, report SSE (${state.events.join(' → ')})`);
  return { site: site.origin, api: api.origin, username, events: state.events };
}

function usage() {
  console.log(`Usage: node scripts/production-smoke.mjs\n\nEnvironment overrides:\n  SMOKE_SITE_URL       Site origin (default: ${DEFAULT_SITE_URL})\n  SMOKE_API_URL        API origin (default: https://api.<site-host>)\n  SMOKE_USERNAME       User used for the /u profile page and /user, /report probes (default: ${DEFAULT_USERNAME})\n  SMOKE_TIMEOUT_MS     Per-request/stream timeout (default: ${DEFAULT_TIMEOUT_MS})`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    usage();
  } else {
    try {
      await runSmoke();
    } catch (error) {
      console.error(`production smoke failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
