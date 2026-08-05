#!/usr/bin/env node
/**
 * LINE送信管理アプリ から、元データ（messages.json）ごとメッセージを削除するコマンド
 *
 * 使い方（モードはどれか1つ）:
 *   node remove.mjs --all              … 全部消す
 *   node remove.mjs --keep 5           … 新しい5件だけ残して、あとは消す
 *   node remove.mjs --days 7           … 7日より古いものを消す
 *   node remove.mjs --match "テスト"    … 宛先か本文に「テスト」を含むものを消す
 *   node remove.mjs --id abc123        … ID指定で消す（複数可: --id a --id b）
 *
 * 補助オプション:
 *   --dry-run    … 実際には消さず、消える対象だけ表示する
 *   --no-push    … GitHubに送らず、ファイルだけ更新
 *   --no-git     … git操作をせず、ファイルだけ更新（動作確認用）
 *
 * 消したあとでも `git revert` で元に戻せる（履歴に残るため）。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(fileURLToPath(import.meta.url));
const DATA = join(REPO, 'messages.json');

function fail(msg) {
  console.error('エラー: ' + msg);
  process.exit(1);
}

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// "2026-08-05 15:19" → Date（読めなければ null）
function parseCreated(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(s || ''));
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

function loadData() {
  let raw;
  try {
    raw = readFileSync(DATA, 'utf8');
  } catch {
    fail('messages.json が見つかりません。');
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    fail('messages.json が壊れています: ' + e.message);
  }
  const messages = Array.isArray(data) ? data : (data && data.messages) || [];
  if (!Array.isArray(messages)) fail('messages.json の "messages" が配列ではありません。');
  return messages;
}

function git(args) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function preview(m) {
  const head = String(m.message || '').split('\n')[0];
  const body = head.length > 24 ? head.slice(0, 24) + '…' : head;
  return `${m.created}  ${m.dest}  「${body}」`;
}

// ===== オプション解析 =====
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const noPush = argv.includes('--no-push');
const noGit = argv.includes('--no-git');

function optValue(name) {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
}
function optValues(name) {
  const out = [];
  argv.forEach((a, i) => { if (a === name && argv[i + 1]) out.push(argv[i + 1]); });
  return out;
}

const modes = ['--all', '--keep', '--days', '--match', '--id'].filter(m => argv.includes(m));
if (modes.length === 0) fail('モードを指定してください（--all / --keep N / --days N / --match "文字" / --id ID）');
if (modes.length > 1) fail('モードは1つだけにしてください（指定された: ' + modes.join(', ') + '）');
const mode = modes[0];

// ===== 消す対象を決める =====
const messages = loadData();
if (messages.length === 0) {
  console.log('メッセージは1件もありません。何もしませんでした。');
  process.exit(0);
}

let doomed;

if (mode === '--all') {
  doomed = messages.slice();

} else if (mode === '--keep') {
  const n = Number(optValue('--keep'));
  if (!Number.isInteger(n) || n < 0) fail('--keep には0以上の整数を指定してください。');
  // 新しい順に並べて、先頭n件を残す
  const ordered = messages.slice().sort((a, b) => String(b.created).localeCompare(String(a.created)));
  const keepIds = new Set(ordered.slice(0, n).map(m => m.id));
  doomed = messages.filter(m => !keepIds.has(m.id));

} else if (mode === '--days') {
  const n = Number(optValue('--days'));
  if (!Number.isFinite(n) || n < 0) fail('--days には0以上の数を指定してください。');
  const limit = Date.now() - n * 24 * 60 * 60 * 1000;
  doomed = messages.filter(m => {
    const d = parseCreated(m.created);
    if (!d) return false;          // 日付が読めないものは安全側に倒して残す
    return d.getTime() < limit;
  });

} else if (mode === '--match') {
  const q = String(optValue('--match') || '').trim();
  if (!q) fail('--match には検索する文字を指定してください。');
  doomed = messages.filter(m =>
    String(m.dest || '').includes(q) || String(m.message || '').includes(q));

} else {
  const ids = optValues('--id');
  if (ids.length === 0) fail('--id にIDを指定してください。');
  const set = new Set(ids);
  doomed = messages.filter(m => set.has(m.id));
}

if (doomed.length === 0) {
  console.log('条件に合うメッセージはありませんでした。何もしませんでした。');
  process.exit(0);
}

console.log(`削除対象（${doomed.length}件 / 全${messages.length}件）:`);
for (const m of doomed) console.log('  ・' + preview(m));

if (dryRun) {
  console.log('（--dry-run のため、まだ消していません）');
  process.exit(0);
}

// ===== 削除 =====
const doomedIds = new Set(doomed.map(m => m.id));
const remaining = messages.filter(m => !doomedIds.has(m.id));
const now = stamp();

writeFileSync(DATA, JSON.stringify({ updated: now, messages: remaining }, null, 2) + '\n', 'utf8');
console.log(`削除しました。残り ${remaining.length}件。`);

if (noGit) {
  console.log('（--no-git のため git 操作はしていません）');
  process.exit(0);
}

try {
  git(['add', 'messages.json']);
  git(['commit', '-m', `メッセージ削除: ${doomed.length}件（残り${remaining.length}件）\n\nCo-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`]);
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
