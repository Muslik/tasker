#!/usr/bin/env node

/**
 * Fetch thread from Loop (Mattermost) by permalink
 *
 * Usage:
 *   ./fetch-thread.mjs <url|post_id> [options]
 *
 * Options:
 *   --html      Save as HTML to out/ folder
 *   --images    Download images locally (use with --html)
 *
 * Environment:
 *   LOOP_TOKEN - API token (required)
 *   LOOP_BASE_URL - Base URL (default: https://onetwotrip.loop.ru)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';

import { loadEnv } from '../../../lib/harness-env.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

loadEnv();

const LOOP_BASE_URL = process.env.LOOP_BASE_URL || 'https://onetwotrip.loop.ru';
const LOOP_TOKEN = process.env.LOOP_TOKEN;

function parsePermalink(input) {
  const urlMatch = input.match(/https?:\/\/[^\/]+\/[^\/]+\/pl\/([a-z0-9]+)/i);
  if (urlMatch) return urlMatch[1];
  if (/^[a-z0-9]+$/i.test(input)) return input;
  return null;
}

async function fetchThread(postId) {
  const allPosts = {};
  const allOrder = [];
  let fromCreateAt = 0;
  const perPage = 200;

  while (true) {
    const url = new URL(`${LOOP_BASE_URL}/api/v4/posts/${postId}/thread`);
    url.searchParams.set('perPage', perPage);
    if (fromCreateAt) {
      url.searchParams.set('fromCreateAt', fromCreateAt);
      url.searchParams.set('direction', 'down');
    }

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${LOOP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API error ${response.status}: ${text}`);
    }

    const data = await response.json();
    const { posts, order } = data;

    Object.assign(allPosts, posts);
    for (const id of order) {
      if (!allOrder.includes(id)) allOrder.push(id);
    }

    if (order.length < perPage) break;

    const lastPost = posts[order[order.length - 1]];
    fromCreateAt = lastPost.create_at;
  }

  allOrder.sort((a, b) => allPosts[a].create_at - allPosts[b].create_at);
  return { posts: allPosts, order: allOrder };
}

async function fetchUser(userId) {
  const url = `${LOOP_BASE_URL}/api/v4/users/${userId}`;
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${LOOP_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
  if (!response.ok) return null;
  return response.json();
}

async function fetchChannel(channelId) {
  const url = `${LOOP_BASE_URL}/api/v4/channels/${channelId}`;
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${LOOP_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
  if (!response.ok) return null;
  return response.json();
}

async function downloadFile(fileId, destPath) {
  const url = `${LOOP_BASE_URL}/api/v4/files/${fileId}`;
  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${LOOP_TOKEN}` }
  });

  if (!response.ok) {
    console.error(`Failed to download file ${fileId}: ${response.status}`);
    return false;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(destPath, buffer);
  return true;
}

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleString('ru-RU', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatMessageHtml(text) {
  // Loop/Mattermost quote format:
  // - Starts with ">" at line beginning
  // - Continues on next lines WITHOUT ">" until empty line (\n\n)
  // - Example: "> first line\nsecond line\n\nnot quote"
  // This differs from standard markdown where each line needs ">"
  let processed = text.replace(/^>[ ]?([^\n]*(?:\n(?!>|\n)[^\n]*)*)/gm, (match, content) => {
    return `<QUOTE>${content}</QUOTE>`;
  });

  let html = escapeHtml(processed);

  // Restore quotes
  html = html.replace(/&lt;QUOTE&gt;([\s\S]*?)&lt;\/QUOTE&gt;/g, '<blockquote>$1</blockquote>');

  html = html.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank">$1</a>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/@([a-z0-9._-]+)/gi, '<span class="mention">@$1</span>');
  html = html.replace(/\n/g, '<br>');
  html = html.replace(/<\/blockquote><br>/g, '</blockquote>');
  return html;
}

async function processThread(postId) {
  const threadData = await fetchThread(postId);
  const { posts, order } = threadData;

  const userIds = new Set(Object.values(posts).map(p => p.user_id));
  const usersArray = await Promise.all([...userIds].map(id => fetchUser(id)));
  const users = {};
  usersArray.forEach(user => { if (user) users[user.id] = user; });

  const firstPost = posts[order[0]];
  const channel = await fetchChannel(firstPost.channel_id);

  return { posts, order, users, channel, firstPost };
}

function formatMarkdown(data, localFiles = {}) {
  const { posts, order, users, channel, firstPost } = data;
  const lines = [];

  lines.push(`# Thread from Loop`);
  lines.push('');
  if (channel) lines.push(`**Channel:** ${channel.display_name || channel.name}`);
  lines.push(`**Messages:** ${order.length}`);
  lines.push(`**Period:** ${formatDate(firstPost.create_at)} - ${formatDate(posts[order[order.length - 1]].create_at)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const postId of order) {
    const post = posts[postId];
    const user = users[post.user_id];
    const username = user?.username || 'unknown';

    lines.push(`### ${username}`);
    lines.push(`*${formatDate(post.create_at)}*`);
    lines.push('');
    if (post.message) { lines.push(post.message); lines.push(''); }
    if (post.metadata?.files?.length > 0) {
      lines.push('**Files:**');
      for (const file of post.metadata.files) {
        const sizeKb = Math.round(file.size / 1024);
        const localPath = localFiles[file.id];
        const url = localPath || `${LOOP_BASE_URL}/api/v4/files/${file.id}`;
        lines.push(`- [${file.name}](${url}) (${sizeKb} KB)`);
      }
      lines.push('');
    }
    if (post.metadata?.reactions?.length > 0) {
      // Group reactions by emoji with usernames
      const grouped = {};
      for (const r of post.metadata.reactions) {
        if (!grouped[r.emoji_name]) grouped[r.emoji_name] = [];
        const rUser = users[r.user_id];
        grouped[r.emoji_name].push(rUser?.username || 'unknown');
      }
      const reactionsList = Object.entries(grouped)
        .map(([emoji, usernames]) => `:${emoji}: ${usernames.map(u => '@' + u).join(' ')}`)
        .join(' · ');
      lines.push(`*Reactions: ${reactionsList}*`);
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

function formatHtml(data, localFiles = {}, assetsDir = null) {
  const { posts, order, users, channel, firstPost } = data;

  const messages = order.map(postId => {
    const post = posts[postId];
    const user = users[post.user_id];
    const username = user?.username || 'unknown';

    let filesHtml = '';
    if (post.metadata?.files?.length > 0) {
      const filesList = post.metadata.files.map(file => {
        const sizeKb = Math.round(file.size / 1024);
        const isImage = /\.(png|jpg|jpeg|gif|webp)$/i.test(file.name);
        const localPath = localFiles[file.id];
        const fileUrl = localPath
          ? (assetsDir ? `${assetsDir}/${localPath}` : localPath)
          : `${LOOP_BASE_URL}/api/v4/files/${file.id}`;

        if (isImage) {
          return `<div class="file-preview"><a href="${fileUrl}" target="_blank"><img src="${fileUrl}" alt="${escapeHtml(file.name)}"></a><span>${escapeHtml(file.name)} (${sizeKb} KB)</span></div>`;
        }
        return `<div class="file"><a href="${fileUrl}" target="_blank">${escapeHtml(file.name)}</a> (${sizeKb} KB)</div>`;
      }).join('');
      filesHtml = `<div class="files">${filesList}</div>`;
    }

    let reactionsHtml = '';
    if (post.metadata?.reactions?.length > 0) {
      // Group reactions by emoji with usernames
      const grouped = {};
      for (const r of post.metadata.reactions) {
        if (!grouped[r.emoji_name]) grouped[r.emoji_name] = [];
        const rUser = users[r.user_id];
        grouped[r.emoji_name].push(rUser?.username || 'unknown');
      }
      const reactionsList = Object.entries(grouped)
        .map(([emoji, usernames]) => `<span class="reaction">:${emoji}: ${usernames.map(u => '<span class="mention">@' + escapeHtml(u) + '</span>').join(' ')}</span>`)
        .join(' ');
      reactionsHtml = `<div class="reactions">${reactionsList}</div>`;
    }

    return `
      <div class="message">
        <div class="message-header">
          <span class="author">${escapeHtml(username)}</span>
          <span class="date">${formatDate(post.create_at)}</span>
        </div>
        <div class="message-body">${post.message ? formatMessageHtml(post.message) : ''}</div>
        ${filesHtml}
        ${reactionsHtml}
      </div>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Thread: ${channel?.display_name || 'Loop'}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      line-height: 1.5;
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
      background: #1a1a1a;
      color: #e0e0e0;
    }
    .header {
      background: #2a2a2a;
      padding: 20px;
      border-radius: 8px;
      margin-bottom: 20px;
      border: 1px solid #333;
    }
    .header h1 { margin: 0 0 10px; font-size: 1.5em; color: #fff; }
    .header .meta { color: #999; font-size: 0.9em; }
    .message {
      background: #2a2a2a;
      padding: 16px;
      border-radius: 8px;
      margin-bottom: 12px;
      border: 1px solid #333;
    }
    .message-header {
      display: flex;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    .author { font-weight: 600; color: #6ab0f3; }
    .mention { color: #6ab0f3; }
    .date { color: #777; font-size: 0.85em; }
    .message-body { white-space: pre-wrap; word-wrap: break-word; }
    .message-body blockquote {
      border-left: 3px solid #555;
      margin: 4px 0;
      padding-left: 12px;
      color: #aaa;
    }
    .message-body a { color: #6ab0f3; }
    .files { margin-top: 12px; }
    .file { margin: 4px 0; }
    .file a { color: #6ab0f3; }
    .file-preview { margin: 8px 0; }
    .file-preview img {
      max-width: 100%;
      max-height: 300px;
      border-radius: 4px;
      display: block;
      margin-bottom: 4px;
    }
    .file-preview span { font-size: 0.85em; color: #888; }
    .reactions { margin-top: 8px; }
    .reaction {
      display: inline-block;
      background: #3a3a3a;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 0.85em;
      margin-right: 4px;
      color: #ccc;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>${channel ? escapeHtml(channel.display_name || channel.name) : 'Thread'}</h1>
    <div class="meta">
      <div>Messages: ${order.length}</div>
      <div>Period: ${formatDate(firstPost.create_at)} — ${formatDate(posts[order[order.length - 1]].create_at)}</div>
    </div>
  </div>
  ${messages}
</body>
</html>`;
}

async function downloadImages(data, assetsDir) {
  const { posts, order } = data;
  const localFiles = {};
  let downloadCount = 0;

  mkdirSync(assetsDir, { recursive: true });

  for (const postId of order) {
    const post = posts[postId];
    if (!post.metadata?.files?.length) continue;

    for (const file of post.metadata.files) {
      const isImage = /\.(png|jpg|jpeg|gif|webp)$/i.test(file.name);
      if (!isImage) continue;

      const ext = extname(file.name) || '.png';
      const localName = `${file.id}${ext}`;
      const destPath = join(assetsDir, localName);

      if (!existsSync(destPath)) {
        process.stdout.write(`Downloading ${file.name}...`);
        const ok = await downloadFile(file.id, destPath);
        console.log(ok ? ' done' : ' failed');
        if (ok) downloadCount++;
      }

      localFiles[file.id] = localName;
    }
  }

  return { localFiles, downloadCount };
}

async function main() {
  const args = process.argv.slice(2);
  const htmlMode = args.includes('--html');
  const downloadImagesFlag = args.includes('--images');
  const input = args.find(a => !a.startsWith('--'));

  if (!input) {
    console.error('Usage: fetch-thread.mjs <permalink|post_id> [options]');
    console.error('');
    console.error('Options:');
    console.error('  --html      Save as HTML to out/ folder');
    console.error('  --images    Download images locally (use with --html)');
    console.error('');
    console.error('Examples:');
    console.error('  ./fetch-thread.mjs https://onetwotrip.loop.ru/onetwotrip/pl/abc123');
    console.error('  ./fetch-thread.mjs abc123 --html');
    console.error('  ./fetch-thread.mjs abc123 --html --images');
    process.exit(1);
  }

  if (!LOOP_TOKEN) {
    console.error('Error: LOOP_TOKEN environment variable is not set');
    process.exit(1);
  }

  const postId = parsePermalink(input);
  if (!postId) {
    console.error(`Error: Cannot parse permalink: ${input}`);
    process.exit(1);
  }

  try {
    const data = await processThread(postId);
    const outDir = join(__dirname, 'out');

    if (htmlMode) {
      mkdirSync(outDir, { recursive: true });

      let localFiles = {};
      let assetsDir = null;

      if (downloadImagesFlag) {
        assetsDir = postId;
        const fullAssetsDir = join(outDir, assetsDir);
        const result = await downloadImages(data, fullAssetsDir);
        localFiles = result.localFiles;
        if (result.downloadCount > 0) {
          console.log(`Downloaded ${result.downloadCount} images to ${fullAssetsDir}`);
        }
      }

      const html = formatHtml(data, localFiles, assetsDir);
      const filepath = join(outDir, `${postId}.html`);
      writeFileSync(filepath, html);
      console.log(`Saved: ${filepath}`);
    } else {
      const markdown = formatMarkdown(data);
      console.log(markdown);
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
