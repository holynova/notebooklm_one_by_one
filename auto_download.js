const { execSync } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const askQuestion = (query) => new Promise(resolve => rl.question(query, resolve));

// 标志位：是否正在扫描中
let isScanning = false;
let userAbortedScan = false;

// 处理 Ctrl+C 强制退出或跳过扫描
rl.on('SIGINT', () => {
  if (isScanning) {
    console.log('\n🛑 收到中断信号，已停止扫描。保留已查找到的幻灯片。');
    userAbortedScan = true; // 告知循环跳出
  } else {
    console.log('\n🛑 收到中断信号，程序已退出。');
    rl.close();
    process.exit(0);
  }
});

// 暂停工具(毫秒)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runCommand(command) {
  try {
    const output = execSync(command, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { success: true, output: output.trim() };
  } catch (error) {
    return { success: false, error: error.stderr ? error.stderr.toString() : error.message };
  }
}

async function main() {
  console.log('=============================================');
  console.log('📥 NotebookLM 批量幻灯片下载工具');
  console.log('=============================================\n');

  // 新增询问用户需求：是否有限制 N 个项目
  console.log('👉 [1/3] 过滤准备');
  const limitAns = await askQuestion('   ❓ 是否只需获取最新 N 个包含幻灯片的 Notebook 即可停止扫描？\n   (直接回车表示不限制，或输入数字 N): ');
  
  let scanLimit = Infinity;
  if (limitAns.trim() !== '') {
    const parsedN = parseInt(limitAns.trim(), 10);
    if (!isNaN(parsedN) && parsedN > 0) {
      scanLimit = parsedN;
      console.log(`   ✅ 已设置：当找到 ${scanLimit} 个幻灯片时立即停止扫描。\n`);
    } else {
      console.log(`   ⚠️ 输入的 N 无效，将扫描所有项目。\n`);
    }
  } else {
    console.log('   ✅ 未设置限制，将查阅所有项目。扫描时可按 Ctrl+C 中止扫描并进入下一步。\n');
  }

  console.log('🔍 [2/3] 正在获取所有 Notebook 列表...');
  const nbRes = runCommand('nlm list notebooks --json');
  if (!nbRes.success) {
    console.error('❌ 获取 Notebook 列表失败:', nbRes.error);
    process.exit(1);
  }

  let notebooks = [];
  try {
    notebooks = JSON.parse(nbRes.output);
  } catch (e) {
    console.error('❌ 无法解析 Notebook 列表 JSON:', e.message);
    process.exit(1);
  }

  // 按照 updated_at (或创建时间) 从最新到最旧排列
  notebooks.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

  console.log(`✅ 成功获取了 ${notebooks.length} 个 Notebook。`);
  console.log('🔍 正在过滤包含幻灯片 (Slide Deck) 的项目，这可能需要一些时间...\n');

  const notebooksWithSlides = [];
  
  // 遍历检查每个 Notebook 是否含 slide_deck
  // 为了不频繁打爆服务器，可以加入一点小延迟，但这里做的是查询操作，一般稍微快点没事
  // 使用 for 循环逐步显示进度，发现包含 slide 的立刻打印
  isScanning = true;
  userAbortedScan = false;

  for (let i = 0; i < notebooks.length; i++) {
    if (userAbortedScan) {
      break; // 如果用户按了 Ctrl+C
    }

    if (notebooksWithSlides.length >= scanLimit) {
      console.log(`\n🎉 已经达到您设置的限制上限：${scanLimit} 个项目，扫描结束。`);
      break;
    }

    const nb = notebooks[i];
    process.stdout.write(`\r   ⏳ 正在检查进度: ${i + 1}/${notebooks.length}`);
    
    // 查询该 notebook 下的 artifacts
    const artRes = runCommand(`nlm list artifacts "${nb.id}" --json`);
    if (artRes.success) {
      try {
        const artifacts = JSON.parse(artRes.output);
        const hasSlide = artifacts.some(a => a.type === 'slide_deck');
        if (hasSlide) {
          notebooksWithSlides.push(nb);
          const index = notebooksWithSlides.length;
          const title = nb.title ? nb.title : '<无标题>';
          
          // 发现目标时，清除当前进度行，并直接输出结果
          process.stdout.clearLine(0);
          process.stdout.cursorTo(0);
          console.log(`  [${index}] ${title} (更新时间: ${nb.updated_at})`);
        }
      } catch (e) {}
    }
  }

  isScanning = false;
  
  // 结束时清理最后一条进度行
  process.stdout.clearLine(0);
  process.stdout.cursorTo(0);
  
  if (notebooksWithSlides.length === 0) {
    console.log('ℹ️ 在所有 Notebook 中未发现任何已生成的幻灯片。程序退出。');
    process.exit(0);
  }

  console.log(`🎉 检查完毕，共找到 ${notebooksWithSlides.length} 个包含幻灯片的 Notebook。\n`);

  console.log('\n---------------------------------------------');
  console.log('👉 [3/3] 请输入您要下载的幻灯片编号范围。');
  console.log('   支持两种格式：');
  console.log('   - 连续范围，例如 "2-5" (将下载编号 2, 3, 4, 5)');
  console.log('   - 单个下载，例如 "3"');
  
  let rangeStart = -1, rangeEnd = -1;
  while (true) {
    const ans = await askQuestion('\n> 请输入范围 (输入 q 退出): ');
    
    if (ans.trim().toLowerCase() === 'q') {
       console.log('👋 用户取消下载。');
       process.exit(0);
    }

    const rangeMatch = ans.match(/^(\d+)(?:-(\d+))?$/);
    if (!rangeMatch) {
      console.log('⚠️ 输入格式有误，请重试。如 "1-3" 或 "2"');
      continue;
    }

    let start = parseInt(rangeMatch[1]);
    let end = rangeMatch[2] ? parseInt(rangeMatch[2]) : start;

    if (start > end) {
      [start, end] = [end, start]; // 交换大小顺序
    }

    if (start < 1 || end > notebooksWithSlides.length) {
      console.log(`⚠️ 编号超出了有效范围 (1 - ${notebooksWithSlides.length})，请重试。`);
      continue;
    }
    
    rangeStart = start;
    rangeEnd = end;
    break;
  }

  const tasksToDownload = notebooksWithSlides.slice(rangeStart - 1, rangeEnd);
  console.log(`\n=============================================`);
  console.log(`🚀 准备开始下载 ${tasksToDownload.length} 个幻灯片`);
  console.log(`=============================================\n`);

  // 创建一个下载专属的文件夹
  const downloadDir = path.join(__dirname, 'slides_downloads');
  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir);
  }

  const startTime = Date.now();
  let successCount = 0;

  for (let i = 0; i < tasksToDownload.length; i++) {
    const nb = tasksToDownload[i];
    const itemNum = rangeStart + i; // 真实编号
    const safeTitle = nb.title ? nb.title.replace(/[\\/:*?"<>|]/g, '_') : nb.id;
    const outputPath = path.join(downloadDir, `${safeTitle}.pdf`);

    console.log(`▶️ [下载 ${i + 1}/${tasksToDownload.length}] (编号 ${itemNum})，目标: ${nb.title || '<无标题>'}`);
    console.log(`   ⏳ 正在执行命令并下载为 PDF...`);

    try {
      // 执行下载命令，格式 PDF
      // 不使用 runCommand 而是直接 execSync 以保证 stdio inherit 的进度条展示
      execSync(`nlm download slide-deck "${nb.id}" --format pdf --output "${outputPath}"`, { stdio: 'inherit' });
      console.log(`   ✅ 下载成功! => ${outputPath}`);
      successCount++;
    } catch (e) {
      console.error(`   ❌ 下载失败。`);
    }

    // 下载间增加些许延迟防止被风控
    if (i < tasksToDownload.length - 1) {
      console.log(`   😴 休息两秒...\n`);
      await sleep(2000);
    }
  }

  const endTime = Date.now();
  const totalSeconds = ((endTime - startTime) / 1000).toFixed(1);

  console.log('\n=============================================');
  console.log(`🌟 批量下载全部结束! 共耗时: ${totalSeconds} 秒`);
  console.log(`✅ 成功文件数: ${successCount}/${tasksToDownload.length}`);
  console.log(`📂 所有下载好的幻灯片保存在目录:\n   👉 ${downloadDir}`);
  console.log('=============================================');
  rl.close();
}

main().catch(err => {
  console.error('\n💥 发生未预期的致命错误:', err);
  rl.close();
  process.exit(1);
});
