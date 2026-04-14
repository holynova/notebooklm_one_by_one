const fs = require('fs');
const path = require('path');

const QUEUE_FILE = path.join(__dirname, 'daily_tasks', 'task_queue.json');

// ─────────────────────────────────────────────
// URL 清洗
// ─────────────────────────────────────────────

/**
 * 对 URL 做标准化处理：
 * - 移除 YouTube 的时间戳参数 t=xxx（避免同一视频因时间戳不同被当成不同任务）
 * - 后续可按需扩展其他规则
 *
 * @param {string} rawUrl
 * @returns {string} 清洗后的 URL
 */
function normalizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl.trim());
    u.searchParams.delete('t');
    return u.toString();
  } catch {
    // 无法解析的 URL 原样返回
    return rawUrl.trim();
  }
}

// 最大重试次数
const MAX_RETRY = 3;

// 流水线阶段顺序
const PHASES = ['notebook', 'source', 'slide', 'download'];

// ─────────────────────────────────────────────
// 基础 IO
// ─────────────────────────────────────────────

/**
 * 加载任务队列，如果文件不存在则返回空对象
 */
function loadQueue() {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      const raw = fs.readFileSync(QUEUE_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.warn('⚠️ 读取 task_queue.json 失败，将使用空队列:', e.message);
  }
  return {};
}

/**
 * 保存任务队列到文件
 */
function saveQueue(queue) {
  try {
    const dir = path.dirname(QUEUE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf-8');
  } catch (e) {
    console.error('❌ 写入 task_queue.json 失败:', e.message);
  }
}

// ─────────────────────────────────────────────
// 同步输入 JSON
// ─────────────────────────────────────────────

/**
 * 从用户维护的 input JSON 文件中同步任务到队列。
 * - 新 URL → 追加为 { phase: 'notebook', status: 'pending' }
 * - 已有 URL → 保持原状态，完全不覆盖
 *
 * @param {string} inputPath - input.json 的路径
 * @returns {{ added: number, skipped: number }} 同步结果统计
 */
function syncFromInputJson(inputPath) {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`输入文件不存在: ${inputPath}`);
  }

  let inputItems;
  try {
    const raw = fs.readFileSync(inputPath, 'utf-8');
    inputItems = JSON.parse(raw);
  } catch (e) {
    throw new Error(`解析输入 JSON 失败: ${e.message}`);
  }

  if (!Array.isArray(inputItems)) {
    throw new Error('输入 JSON 必须是一个数组');
  }

  const queue = loadQueue();
  let added = 0;
  let skipped = 0;
  const now = new Date().toISOString();

  for (const item of inputItems) {
    if (!item.url) {
      console.warn('⚠️ 跳过缺少 url 字段的条目:', JSON.stringify(item));
      continue;
    }

    const url = normalizeUrl(item.url);
    if (!url) continue;

    if (queue[url]) {
      skipped++;
    } else {
      queue[url] = {
        url,
        title: item.title || '',
        phase: 'notebook',
        status: 'pending',
        notebookId: null,
        failCount: 0,
        addedAt: now,
        updatedAt: now,
      };
      added++;
    }
  }

  saveQueue(queue);
  return { added, skipped };
}

// ─────────────────────────────────────────────
// 调度
// ─────────────────────────────────────────────

/**
 * 获取下一批可执行任务（phase 为 notebook/source/slide，status 为 pending 或 failed 且未超重试次数）
 *
 * @param {number} batchSize - 批次大小，默认 10
 * @returns {Array} 任务对象数组
 */
function getNextBatch(batchSize = 10) {
  const queue = loadQueue();
  const eligible = [];

  const processablePhases = new Set(['notebook', 'source', 'slide']);

  for (const record of Object.values(queue)) {
    if (!processablePhases.has(record.phase)) continue;
    if (record.status === 'success') continue; // 该阶段已成功（理论上不应出现，因为会自动推进）
    if (record.status === 'abandoned') continue;
    if (record.status === 'failed' && record.failCount >= MAX_RETRY) continue;
    if (record.status !== 'pending' && record.status !== 'failed') continue;

    eligible.push(record);
  }

  // Fisher-Yates 洗牌：随机打乱，避免每次都取相同的任务
  for (let i = eligible.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
  }

  return eligible.slice(0, batchSize);
}

// ─────────────────────────────────────────────
// 状态更新
// ─────────────────────────────────────────────

/**
 * 标记 Notebook 已创建，推进到 source 阶段
 * @param {string} url
 * @param {string} notebookId
 */
function markNotebookCreated(url, notebookId) {
  const queue = loadQueue();
  const now = new Date().toISOString();
  if (!queue[url]) {
    console.warn(`⚠️ markNotebookCreated: 未找到 URL 记录: ${url}`);
    return;
  }
  queue[url].notebookId = notebookId;
  queue[url].phase = 'source';
  queue[url].status = 'pending';
  queue[url].updatedAt = now;
  saveQueue(queue);
}

/**
 * 标记 Source 已导入，推进到 slide 阶段
 * @param {string} url
 */
function markSourceImported(url) {
  const queue = loadQueue();
  const now = new Date().toISOString();
  if (!queue[url]) {
    console.warn(`⚠️ markSourceImported: 未找到 URL 记录: ${url}`);
    return;
  }
  queue[url].phase = 'slide';
  queue[url].status = 'pending';
  queue[url].updatedAt = now;
  saveQueue(queue);
}

/**
 * 标记 Slide 已生成，推进到 download 阶段（status: pending，等待下载）
 * @param {string} url
 */
function markSlideCreated(url) {
  const queue = loadQueue();
  const now = new Date().toISOString();
  if (!queue[url]) {
    console.warn(`⚠️ markSlideCreated: 未找到 URL 记录: ${url}`);
    return;
  }
  queue[url].phase = 'download';
  queue[url].status = 'pending';
  queue[url].updatedAt = now;
  saveQueue(queue);
}

/**
 * 标记 Slide 已下载，任务全部完成
 * @param {string} url
 */
function markDownloadDone(url) {
  const queue = loadQueue();
  const now = new Date().toISOString();
  if (!queue[url]) {
    console.warn(`⚠️ markDownloadDone: 未找到 URL 记录: ${url}`);
    return;
  }
  queue[url].phase = 'download';
  queue[url].status = 'success';
  queue[url].updatedAt = now;
  saveQueue(queue);
}

/**
 * 标记当前阶段执行失败，failCount +1。
 * 如果 failCount 达到 MAX_RETRY，则将 status 置为 abandoned。
 *
 * @param {string} url
 * @returns {number} 当前 failCount
 */
function markFailed(url) {
  const queue = loadQueue();
  const now = new Date().toISOString();

  if (!queue[url]) {
    // 理论上不应发生，防御性初始化
    queue[url] = {
      url,
      title: '',
      phase: 'notebook',
      status: 'failed',
      notebookId: null,
      failCount: 1,
      addedAt: now,
      updatedAt: now,
    };
    saveQueue(queue);
    return 1;
  }

  queue[url].failCount = (queue[url].failCount || 0) + 1;
  queue[url].updatedAt = now;

  if (queue[url].failCount >= MAX_RETRY) {
    queue[url].status = 'abandoned';
  } else {
    queue[url].status = 'failed';
  }

  saveQueue(queue);
  return queue[url].failCount;
}

/**
 * 通过 notebookId 反查记录
 * @param {string} notebookId
 * @returns {object|null}
 */
function findByNotebookId(notebookId) {
  const queue = loadQueue();
  for (const record of Object.values(queue)) {
    if (record.notebookId === notebookId) {
      return record;
    }
  }
  return null;
}

// ─────────────────────────────────────────────
// 统计
// ─────────────────────────────────────────────

/**
 * 打印队列的全局统计信息
 */
function printSummary() {
  const queue = loadQueue();
  const records = Object.values(queue);

  if (records.length === 0) {
    console.log('\n📋 任务队列为空。');
    return;
  }

  const total = records.length;

  // 按 phase 统计
  const byPhase = {};
  for (const phase of [...PHASES, 'unknown']) {
    byPhase[phase] = { pending: 0, success: 0, failed: 0, abandoned: 0 };
  }

  for (const r of records) {
    const ph = byPhase[r.phase] ? r.phase : 'unknown';
    const st = byPhase[ph][r.status] !== undefined ? r.status : 'pending';
    byPhase[ph][st]++;
  }

  const done = records.filter(r => r.phase === 'download' && r.status === 'success').length;
  const readyToDownload = records.filter(r => r.phase === 'download' && r.status === 'pending').length;
  const abandoned = records.filter(r => r.status === 'abandoned').length;
  const inProgress = total - done - abandoned;

  console.log('\n📋 ===== 任务队列统计 =====');
  console.log(`   📊 总任务数: ${total}`);
  console.log(`   ✅ 全部完成 (downloaded): ${done}`);
  console.log(`   🎴 Slide 已生成，待下载: ${readyToDownload}`);
  console.log(`   ⏳ 进行中 (notebook/source/slide): ${inProgress - readyToDownload}`);
  console.log(`   ❌ 已放弃 (abandoned): ${abandoned}`);
  console.log('\n   --- 各阶段明细 ---');

  const phaseLabel = {
    notebook: '📓 Notebook',
    source:   '🔗 Source  ',
    slide:    '🎴 Slide   ',
    download: '📥 Download',
  };

  for (const phase of PHASES) {
    const s = byPhase[phase];
    const total_phase = s.pending + s.success + s.failed + s.abandoned;
    if (total_phase === 0) continue;
    console.log(`   ${phaseLabel[phase]}: pending=${s.pending} success=${s.success} failed=${s.failed} abandoned=${s.abandoned}`);
  }

  console.log('   ========================\n');
}

// ─────────────────────────────────────────────
// 导出
// ─────────────────────────────────────────────

module.exports = {
  MAX_RETRY,
  PHASES,
  normalizeUrl,
  loadQueue,
  saveQueue,
  syncFromInputJson,
  getNextBatch,
  markNotebookCreated,
  markSourceImported,
  markSlideCreated,
  markDownloadDone,
  markFailed,
  findByNotebookId,
  printSummary,
};
