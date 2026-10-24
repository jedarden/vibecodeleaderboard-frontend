import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';

import { generateOGMetaTags, injectOGTags } from '../functions/u/[username].js';
import {
  runSmoke,
  validateLeaderboard,
  validateProfileHtml,
  validateReportResponse,
  validateUserResponse,
} from '../scripts/production-smoke.mjs';

const CORS = { 'Access-Control-Allow-Origin': 'http://127.0.0.1:0' };
const REPORT = {
  username: 'octocat',
  rank: 1,
  total_ranked: 10,
  percentile: 0.9,
  total_commits: 100,
  repos_with_commits: 2,
  by_tool: { claude: 70, cursor: 30 },
  sparkline_30d: Array.from({ length: 30 }, () => 1),
  top_repos: [{ repo: 'octocat/site', commits: 100, tools: ['claude'] }],
  first_ai_commit: '2024-01-01T00:00:00Z',
};
const LEADERBOARD = {
  generated_at: '2026-09-17T00:00:00Z',
  rankings: [{
    rank: 1,
    username: 'octocat',
    commit_count: 100,
    commits_30d: 10,
    unique_repos: 2,
    recent_repos: ['octocat/site'],
    by_tool: { claude: 70 },
  }],
};

let server;
let baseUrl;
let userTemplate;

before(async () => {
  userTemplate = await readFile(new URL('../user.html', import.meta.url), 'utf8');

  let releaseStream;
  const streamReady = new Promise((resolve) => { releaseStream = resolve; });

  server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const headers = { ...CORS, 'Access-Control-Allow-Methods': 'GET, HEAD, POST' };

    if (url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>Vibe Code Leaderboard</title>');
      return;
    }
    if (url.pathname === '/leaderboard.json') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(LEADERBOARD));
      return;
    }
    if (url.pathname === '/health' && request.method === 'HEAD') {
      response.writeHead(200, headers);
      response.end();
      return;
    }
    if (url.pathname === '/user/octocat' && request.method === 'GET') {
      response.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ...LEADERBOARD.rankings[0], total_ranked: 10 }));
      return;
    }
    if (url.pathname === '/u/octocat' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      // Render against the real origin (port included) so og:url,
      // og:image, and canonical match the URL the runner fetched.
      response.end(injectOGTags(
        userTemplate,
        generateOGMetaTags('octocat', LEADERBOARD.rankings[0], new URL(request.url, baseUrl)),
      ));
      return;
    }
    if (url.pathname === '/report/octocat/stream' && request.method === 'GET') {
      response.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream' });
      response.flushHeaders();
      response.write(': connected\n\n');
      await streamReady;
      response.write('event: queued\ndata: {"position":0,"estimated_wait_seconds":0}\n\n');
      response.write('event: started\ndata: {"repos_found":1}\n\n');
      response.write('event: scanning\ndata: {"repo":"octocat/site","index":0,"total":1}\n\n');
      response.write('event: scanned\ndata: {"repo":"octocat/site","commits_found":100,"tools":{"claude":70}}\n\n');
      response.write(`event: complete\ndata: ${JSON.stringify(REPORT)}\n\n`);
      response.end();
      return;
    }
    if (url.pathname === '/report/octocat' && request.method === 'POST') {
      response.writeHead(202, { ...headers, 'Content-Type': 'application/json' });
      response.end('{}');
      releaseStream();
      return;
    }
    response.writeHead(404, headers);
    response.end(JSON.stringify({ detail: 'not found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  // Replace the fixture's placeholder with the actual site origin in all API
  // responses. The smoke runner checks the browser-facing CORS contract.
  CORS['Access-Control-Allow-Origin'] = baseUrl;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('production smoke runner checks site, data, API, and report SSE end-to-end', async () => {
  const result = await runSmoke({
    siteUrl: baseUrl,
    apiUrl: baseUrl,
    username: 'octocat',
    timeoutMs: 5_000,
    log: () => {},
  });

  assert.deepEqual(result.events, ['queued', 'started', 'scanning', 'scanned', 'complete']);
});

test('profile page smoke validates the function-injected title and OG tags', () => {
  const profileUrl = `${baseUrl}/u/octocat`;
  const at = new URL(profileUrl);
  const render = (username, userData) => injectOGTags(userTemplate, generateOGMetaTags(username, userData, at));

  assert.equal(
    validateProfileHtml(render('octocat', LEADERBOARD.rankings[0]), { username: 'octocat', profileUrl }).title,
    '#1 octocat - Vibe Code Leaderboard',
  );

  // A username that is not on the leaderboard still gets injected metadata,
  // just without the rank prefix and with the default OG image.
  assert.equal(
    validateProfileHtml(render('ghost', null), { username: 'ghost', profileUrl }).title,
    'ghost - Vibe Code Leaderboard',
  );
});

test('profile page smoke rejects the un-injected template and broken injections', () => {
  const profileUrl = `${baseUrl}/u/octocat`;
  const opts = { username: 'octocat', profileUrl };
  const injected = injectOGTags(
    userTemplate,
    generateOGMetaTags('octocat', LEADERBOARD.rankings[0], new URL(profileUrl)),
  );

  // _redirects serves user.html raw when the Pages function is missing.
  assert.throws(() => validateProfileHtml(userTemplate, opts), /placeholder/);
  assert.throws(() => validateProfileHtml(injected.replace(
    'property="og:title" content="#1 octocat - Vibe Code Leaderboard"',
    'property="og:title" content="Vibe Code Leaderboard"',
  ), opts), /og:title/);
  assert.throws(() => validateProfileHtml(injected.replace(
    /property="og:url" content="[^"]*"/,
    'property="og:url" content="https://elsewhere.example/u/octocat"',
  ), opts), /og:url/);
  assert.throws(() => validateProfileHtml(injected.replace(
    /rel="canonical" href="[^"]*"/,
    'rel="canonical" href="https://elsewhere.example/u/octocat"',
  ), opts), /canonical/);
  assert.throws(() => validateProfileHtml(injected.replace(
    /property="og:image" content="[^"]*"/,
    'property="og:image" content="not a url"',
  ), opts), /og:image/);
});

test('documented response validators reject missing required shapes', () => {
  assert.throws(() => validateLeaderboard({ generated_at: '2026-09-17T00:00:00Z', rankings: [{}] }), /username/);
  assert.throws(() => validateUserResponse({ username: 'octocat' }), /rank/);
  assert.throws(() => validateReportResponse({ username: 'octocat', rank: 1 }), /total_ranked/);
  assert.throws(() => validateReportResponse({
    ...REPORT,
    top_repos: [{ repo: 'octocat/site', commits: 100 }],
  }), /tools/);
});
