#!/usr/bin/env node
/**
 * LINE送信管理アプリ にメッセージを追加するコマンド
 *
 *   node add.mjs message.json          … JSONファイルから追加（commit + push まで自動）
 *   cat message.json | node add.mjs    … 標準入力から追加
 *   node add.mjs message.json --no-push … GitHubに送らず、ファイルだけ更新
 *   node add.mjs message.json --no-git  … git操作を一切せず、ファイルだけ更新（動作確認用）
 *
 * 渡すJSONの形（1件でも、配列で複数件でもOK）:
 *   {
 *     "dest":     "社内グループLINE",       // 必須：宛先
 *     "message":  "お疲れ様です！\n...",     // 必須：本文
 *     "tone":     "group",                  // polite / work / normal / friend / group
 *     "priority": "high",                   // high / mid / low
 *     "type":     "グループ"                // 省略時は tone から自動
 *   }
 *
 * 追加先は messages.json（アプリが開くたびに読みに行くファイル）。
 * index.html は触らない。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(fileURLToPath(import.meta.url));
const DATA = join(REPO, 'messages.json');

// トーンの設定（表示名を変えたいときはここを直す）
const TONES = {
  polite: { label: '①丁寧',        cls: 'tone-polite', type: '個人' },
  work:   { label: '②仕事',        cls: 'tone-work',   type: '仕事' },
  normal: { label: '③ふつう',      cls: 'tone-normal', type: '個人' },
  friend: { label: '④友達',        cls: 'tone-friend', type: '個人' },
  group:  { label: '⑤グループLINE', cls: 'tone-group',  type: 'グループ' },
};

const PRIORITIES = {
  high: '🔴急ぎ',
  mid:  '🟡ふつう',
  low:  '🟢あとで',
};

function fail(msg) {
  console.error('エラー: ' + msg);
  process.exit(1);
}

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function readInput(path) {
  const raw = path ? readFileSync(resolve(path), 'utf8') : readFileSync(0, 'utf8');
  if (!raw.trim()) fail('入力が空です。JSONを渡してください。');
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail('JSONとして読めませんでした: ' + e.message);
  }
}

function normalize(input, now) {
  const dest = String(input.dest ?? '').trim();
  const message = String(input.message ?? '').trim();
  if (!dest) fail('"dest"（宛先）は必須です。');
  if (!message) fail('"message"（本文）は必須です。');

  const toneKey = String(input.tone ?? 'normal').trim();
  const tone = TONES[toneKey];
  if (!tone) fail(`"tone" は ${Object.keys(TONES).join(' / ')} のいずれかにしてください（受け取った値: ${toneKey}）`);

  const priorityKey = String(input.priority ?? 'mid').trim();
  const priorityLabel = PRIORITIES[priorityKey];
  if (!priorityLabel) fail(`"priority" は ${Object.keys(PRIORITIES).join(' / ')} のいずれかにしてください（受け取った値: ${priorityKey}）`);

  return {
    id: randomBytes(16).toString('hex'),
    dest,
    tone: tone.label,
    toneClass: tone.cls,
    type: String(input.type ?? tone.type).trim(),
    message,
    priority: priorityKey,
    priorityLabel,
    created: now,
  };
}

function loadData() {
  let raw;
  try {
    raw = readFileSync(DATA, 'utf8');
  } catch {
    return { updated: '', messages: [] };   // まだ無ければ新規作成
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    fail('messages.json が壊れています: ' + e.message);
  }
  const messages = Array.isArray(data) ? data : (data && data.messages) || [];
  if (!Array.isArray(messages)) fail('messages.json の "messages" が配列ではありません。');
  return { updated: (data && data.updated) || '', messages };
}

function git(args) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// ===== 実行 =====
const argv = process.argv.slice(2);
const noPush = argv.includes('--no-push');
const noGit = argv.includes('--no-git');
const path = argv.find(a => !a.startsWith('--'));

const now = stamp();
const input = readInput(path);
const list = Array.isArray(input) ? input : [input];
if (list.length === 0) fail('追加するメッセージがありません。');

const entries = list.map(x => normalize(x, now));

const data = loadData();
data.messages = [...entries, ...data.messages];
data.updated = now;
writeFileSync(DATA, JSON.stringify({ updated: data.updated, messages: data.messages }, null, 2) + '\n', 'utf8');

console.log(`追加しました（${entries.length}件）:`);
for (const e of entries) console.log(`  ・${e.dest} / ${e.tone} / ${e.priorityLabel}`);

if (noGit) {
  console.log('（--no-git のため git 操作はしていません）');
  process.exit(0);
}

try {
  git(['add', 'messages.json']);
  const subject = entries.length === 1
    ? `メッセージ追加: ${entries[0].dest}`
    : `メッセージ追加: ${entries.length}件`;
  git(['commit', '-m', `${subject}\n\nCo-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`]);
} catch (e) {
  fail('git commit に失敗しました: ' + (e.stderr || e.message));
}

if (noPush) {
  console.log('コミット済み。（--no-push のため GitHub には送っていません）');
  process.exit(0);
}

try {
  git(['push', 'origin', 'HEAD']);
  console.log('GitHubに反映しました → https://kikukenkogyo.github.io/line-sender/');
} catch (e) {
  console.error('push に失敗しました（コミットは残っています）: ' + (e.stderr || e.message));
  process.exit(1);
}
