const readline = require('readline');
const { execSync } = require('child_process');

// 初始化 readline 接口用于接收交互式输入
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Promisify 简单的交互问答
const askQuestion = (query) => new Promise(resolve => rl.question(query, resolve));

// 处理 Ctrl+C 强制退出
rl.on('SIGINT', () => {
  console.log('\n🛑 收到中断信号，程序已退出。');
  rl.close();
  process.exit(0);
});

// 暂停工具(毫秒)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 1. 获取并处理用户输入的所有 URL
function getUrls() {
  return new Promise((resolve) => {
    console.log('\n🔗 1. 请输入一个或多个 URL，作为生成 Slide 的资源。');
    console.log('💡 你可以在一行内用逗号、空格分隔，也可以直接换行粘贴多个 URL。');
    console.log('👉 粘贴完成后，另起一行输入 END 并回车结束输入：\n');
    process.stdout.write('> '); // 只打印一次引导符
    
    let urls = [];
    
    const onLine = (line) => {
      if (line.trim().toUpperCase() === 'END') {
        rl.removeListener('line', onLine);
        resolve(urls);
        return;
      }
      
      const parts = line.split(/[,\s]+/).map(s => s.trim()).filter(s => s.length > 0);
      urls.push(...parts);
    };
    
    rl.on('line', onLine);
  });
}

// 辅助方法：提取 Notebook ID (一般为含有连字符的长字符串, 例如 12ab34cd-56ef-78gh-90ij-klmnopqrstuv)
function extractNotebookId(output) {
  if (!output) return null;
  // 适配常见的字母数字连字符组合（通常大于15位）
  const match = output.match(/[a-zA-Z0-9_-]{15,}/);
  return match ? match[0] : null;
}

// 随机获取 min 到 max 之间的等待毫秒数
function getRandomDelay(minSeconds = 3, maxSeconds = 7) {
  return Math.floor(Math.random() * (maxSeconds - minSeconds + 1) + minSeconds) * 1000;
}

// 封装一个带有日志打印的执行函数
function runCLI(command, inheritStdio = false) {
  console.log(`   >>> 运行命令: ${command}`);
  try {
    const options = { encoding: 'utf-8' };
    if (inheritStdio) {
      options.stdio = 'inherit';
    } else {
      options.stdio = ['ignore', 'pipe', 'pipe'];
    }
    const output = execSync(command, options);
    const result = output ? output.trim() : '';
    
    if (!inheritStdio && result) {
      console.log(`   <<< 执行结果:\n${result.split('\\n').map(l => '       ' + l).join('\\n')}`);
    } else if (!inheritStdio) {
      console.log(`   <<< 执行结果: (空)`);
    }
    return { success: true, output: result };
  } catch (error) {
    const stdout = error.stdout ? error.stdout.toString().trim() : '';
    const stderr = error.stderr ? error.stderr.toString().trim() : '';
    if (!inheritStdio && stdout) {
      console.log(`   <<< 标准输出:\n${stdout.split('\\n').map(l => '       ' + l).join('\\n')}`);
    }
    if (stderr) {
      console.log(`   <<< 错误输出:\n${stderr.split('\\n').map(l => '       ' + l).join('\\n')}`);
    } else if (!inheritStdio && !stdout && !stderr) {
      console.log(`   <<< 错误信息: ${error.message}`);
    }
    return { success: false, output: stdout, error: stderr || error.message };
  }
}

// 主流程
async function main() {
  console.log('=============================================');
  console.log('🚀 NotebookLM Slide 批量自动化生成脚本 🚀');
  console.log('=============================================\n');

  // 获取 URL 列表
  const rawUrls = await getUrls();
  if (rawUrls.length === 0) {
    console.log('❌ 未输入任何 URL，程序已退出。');
    rl.close();
    return;
  }
  
  // 简单去重
  const urls = [...new Set(rawUrls)];
  console.log(`\n✅ 共收集到 ${urls.length} 个独立 URL 任务。`);

  // 获取提示词
  console.log('\n---------------------------------------------');
  console.log('📝 2. 请设置 Slide 生成要求');
  let focusPrompt = await askQuestion('> 请输入生成 Slide 用的提示词 (留空默认: "用中文生成详细的slide"): ');
  
  if (!focusPrompt.trim()) {
    focusPrompt = "用中文生成详细的slide";
    console.log(`ℹ️ 使用默认提示词: "${focusPrompt}"`);
  }

  console.log('\n=============================================');
  console.log('⚙️ 开始按顺序处理任务 (请勿关闭终端窗口)...');
  console.log('=============================================\n');

  // 按照 url 迭代执行任务
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    console.log(`\n▶️ [任务 ${i + 1}/${urls.length}] 正在处理 URL: ${url}`);
    
    // 2.1 创建无标题 Notebook，让导入后的 source 自动重命名它
    console.log(`\n   [步骤 1/3] 正在创建无标题的新 Notebook...`);
    
    const createRes = runCLI(`nlm notebook create`);
    if (!createRes.success) {
      console.error(`   🛑 遇到错误，创建 Notebook 失败，中止后续任务！`);
      process.exit(1);
    }

    const notebookId = extractNotebookId(createRes.output);
    if (!notebookId) {
      console.error(`   ❌ 无法从命令输出中提取 Notebook ID。`);
      console.error(`   🛑 遇到错误，中止后续任务！`);
      process.exit(1);
    }
    console.log(`   ✅ 成功创建 Notebook，ID提取为: ${notebookId}`);

    // 2.2 导入 URL 作为 source
    console.log(`\n   [步骤 2/3] 正在将 URL 导入为 source，等待后台解析处理完毕...`);
    // stdio: 'inherit' 让用户能直接看到CLI可能带的进度条
    const addRes = runCLI(`nlm source add ${notebookId} --url "${url}" --wait`, true);
    if (!addRes.success) {
      console.error(`   🛑 导入 URL 失败或超时，中止后续任务！`);
      process.exit(1);
    }
    console.log(`   ✅ URL 导入完成！`);

    // 2.3 生成 Slide
    console.log(`\n   [步骤 3/3] 开始使用提示词生成 Slide...`);
    
    let command = `nlm slides create ${notebookId} --confirm`;
    if (focusPrompt.trim()) {
      const escapedPrompt = focusPrompt.replace(/"/g, '\\"');
      command = `nlm slides create ${notebookId} --focus "${escapedPrompt}" --confirm`;
    }
    
    const slideRes = runCLI(command, true);
    if (!slideRes.success) {
      console.error(`   🛑 生成 Slide 请求执行失败，中止后续任务！`);
      process.exit(1);
    }
    console.log(`   🎉 [任务 ${i + 1}/${urls.length}] 阶段成功完成！Slide 生成已触发。`);

    // 2.4 如果不是最后一个任务，随机等待几秒再继续
    if (i < urls.length - 1) {
      const delayMs = getRandomDelay(3, 7); // 默认 3-7 秒
      console.log(`\n   😴 随机等待 ${(delayMs / 1000).toFixed(1)} 秒，准备执行下一个任务...`);
      await sleep(delayMs);
    }
  }

  // 2.5 全部执行成功后退出
  console.log('\n=============================================');
  console.log('🌟 所有任务执行流程完毕！去 NotebookLM 看看成果吧。');
  console.log('=============================================');
  rl.close();
}

// 捕获顶层错误
main().catch(error => {
  console.error('\n💥 发生未预期的脚本异常:', error);
  rl.close();
});
