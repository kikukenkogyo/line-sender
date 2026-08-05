#!/usr/bin/env node
/**
 * LINE送信管理アプリ にメッセージを追加するコマンド
 *
 *   node add.mjs message.json          … JSONファイルから追加（commit + push まで自動）
 *   cat message.json | node add.mjs    … 標準入力から追加
 *   node add.mjs message.json --no-push … GitHubに送らず、ファイルだけ更新
 *   node add.mjs message.json --no-git  … git操作を一切せず、ファイルだけ更新（動作確認用）
 *
 * JSONの形（1件でも、配列で複数件でもOK）:
 *   {
 *     "dest":     "社内グループLINE",       // 必須：宛先
 *     "message":  "お疲れ様です！\n...",     // 必須：本文
 *     "tone":     "group",                  // polite / work / normal / friend / group
 *     "priority": "high",                   // high / mid / low
 *     "type":     "グループ"                // 省略時は tone から自動
 *   }
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(fileURLToPath(import.meta.url));
const HTML = join(REPO, 'index.html');

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

const START_MARK = 'const messages = [';
const END_MARK = '// ===== データここまで =====';

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

function toLiteral(m) {
  const q = v => JSON.stringify(v);
  return [
    '  {',
    `    id: ${q(m.id)},`,
    `    dest: ${q(m.dest)},`,
    `    tone: ${q(m.tone)},`,
    `    toneClass: ${q(m.toneClass)},`,
    `    type: ${q(m.type)},`,
    `    message: ${q(m.message)},`,
    `    priority: ${q(m.priority)},`,
    `    priorityLabel: ${q(m.priorityLabel)},`,
    `    created: ${q(m.created)}`,
    '  }',
  ].join('\n');
}

function insert(html, entries, now) {
  const startIdx = html.indexOf(START_MARK);
  const endIdx = html.indexOf(END_MARK);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    fail('index.html のデータ欄が見つかりません。ファイルが壊れていないか確認してください。');
  }

  const closeIdx = html.lastIndexOf('];', endIdx);
  if (closeIdx === -1 || closeIdx < startIdx) fail('index.html のデータ欄の閉じカッコが見つかりません。');

  const insertAt = startIdx + START_MARK.length;
  const existing = html.slice(insertAt, closeIdx).trim();
  const block = entries.map(toLiteral).join(',\n');

  let out = html.slice(0, insertAt)
    + '\n' + block + (existing ? ',' : '')
    + html.slice(insertAt);

  const stampRe = /const lastUpdated = "[^"]*";/;
  if (stampRe.test(out)) {
    out = out.replace(stampRe, `const lastUpdated = ${JSON.stringify(now)};`);
  } else {
    console.warn('注意: lastUpdated を更新できませんでした（表示だけの問題です）');
  }

  return out;
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

const html = readFileSync(HTML, 'utf8');
writeFileSync(HTML, insert(html, entries, now), 'utf8');

console.log(`追加しました（${entries.length}件）:`);
for (const e of entries) console.log(`  ・${e.dest} / ${e.tone} / ${e.priorityLabel}`);

if (noGit) {
  console.log('（--no-git のため git 操作はしていません）');
  process.exit(0);
}

try {
  git(['add', 'index.html']);
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
