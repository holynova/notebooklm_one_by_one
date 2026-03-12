const fs = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, 'history.json');

/**
 * 加载历史记录，如果文件不存在则返回空对象
 */
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = fs.readFileSync(HISTORY_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.warn('⚠️ 读取 history.json 失败，将使用空历史记录:', e.message);
  }
  return {};
}

/**
 * 保存历史记录到 history.json
 */
function saveHistory(data) {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.error('❌ 写入 history.json 失败:', e.message);
  }
}

/**
 * 获取某个 URL 的记录，不存在则返回 null
 */
function getRecord(url) {
  const history = loadHistory();
  return history[url] || null;
}

/**
 * 标记 Notebook 已创建
 */
function markNotebookCreated(url, notebookId) {
  const history = loadHistory();
  const now = new Date().toISOString();
  if (history[url]) {
    history[url].notebookId = notebookId;
    history[url].notebookCreated = true;
    history[url].updatedAt = now;
  } else {
    history[url] = {
      url,
      notebookId,
      notebookCreated: true,
      slideCreated: false,
      slideDownloadCount: 0,
      failCount: 0,
      createdAt: now,
      updatedAt: now,
    };
  }
  saveHistory(history);
}

/**
 * 标记 Slide 已生成
 */
function markSlideCreated(url) {
  const history = loadHistory();
  const now = new Date().toISOString();
  if (history[url]) {
    history[url].slideCreated = true;
    history[url].updatedAt = now;
  } else {
    history[url] = {
      url,
      notebookId: null,
      notebookCreated: false,
      slideCreated: true,
      slideDownloadCount: 0,
      failCount: 0,
      createdAt: now,
      updatedAt: now,
    };
  }
  saveHistory(history);
}

/**
 * Slide 下载次数 +1
 */
function incrementDownloadCount(url) {
  const history = loadHistory();
  const now = new Date().toISOString();
  if (history[url]) {
    history[url].slideDownloadCount = (history[url].slideDownloadCount || 0) + 1;
    history[url].updatedAt = now;
    saveHistory(history);
    return true;
  }
  return false;
}

/**
 * 标记某个 URL 任务失败，failCount +1
 */
function markFailed(url) {
  const history = loadHistory();
  const now = new Date().toISOString();
  if (history[url]) {
    history[url].failCount = (history[url].failCount || 0) + 1;
    history[url].updatedAt = now;
  } else {
    history[url] = {
      url,
      notebookId: null,
      notebookCreated: false,
      slideCreated: false,
      slideDownloadCount: 0,
      failCount: 1,
      createdAt: now,
      updatedAt: now,
    };
  }
  saveHistory(history);
  return history[url].failCount;
}

/**
 * 通过 notebookId 反查记录
 */
function findByNotebookId(notebookId) {
  const history = loadHistory();
  for (const url in history) {
    if (history[url].notebookId === notebookId) {
      return history[url];
    }
  }
  return null;
}

/**
 * 打印历史记录摘要
 */
function printSummary() {
  const history = loadHistory();
  const records = Object.values(history);
  if (records.length === 0) {
    console.log('\n📋 历史记录为空。');
    return;
  }

  const total = records.length;
  const withNotebook = records.filter(r => r.notebookCreated).length;
  const withSlide = records.filter(r => r.slideCreated).length;
  const totalDownloads = records.reduce((sum, r) => sum + (r.slideDownloadCount || 0), 0);
  const totalFailures = records.reduce((sum, r) => sum + (r.failCount || 0), 0);
  const failedUrls = records.filter(r => (r.failCount || 0) > 0).length;

  console.log('\n📋 ===== 历史记录摘要 =====');
  console.log(`   📊 URL 总数: ${total}`);
  console.log(`   📓 已创建 Notebook: ${withNotebook}`);
  console.log(`   🎴 已生成 Slide: ${withSlide}`);
  console.log(`   📥 Slide 总下载次数: ${totalDownloads}`);
  console.log(`   ❌ 失败 URL 数: ${failedUrls} (总失败次数: ${totalFailures})`);
  console.log('   ========================\n');
}

module.exports = {
  loadHistory,
  saveHistory,
  getRecord,
  markNotebookCreated,
  markSlideCreated,
  incrementDownloadCount,
  markFailed,
  findByNotebookId,
  printSummary,
};
