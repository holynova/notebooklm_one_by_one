const { execSync } = require('child_process');
const readline = require('readline');

async function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise(resolve => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runCLI(command, silent = false) {
  if (!silent) console.log(`   >>> 运行命令: ${command}`);
  try {
    const output = execSync(command, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { success: true, output: output ? output.trim() : '' };
  } catch (error) {
    const stdout = error.stdout ? error.stdout.toString().trim() : '';
    const stderr = error.stderr ? error.stderr.toString().trim() : '';
    return { success: false, output: stdout, error: stderr || error.message };
  }
}

function parseJSON(str) {
  try {
    return JSON.parse(str);
  } catch (e) {
    return null;
  }
}

function parseRange(input, max) {
  const result = new Set();
  const parts = input.split(',').map(s => s.trim());
  for (const part of parts) {
    if (part.toLowerCase() === 'all') {
      for (let i = 1; i <= max; i++) result.add(i);
      continue;
    }
    if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number);
      if (start && end && start <= end) {
        for (let i = start; i <= end; i++) if (i > 0 && i <= max) result.add(i);
      }
    } else {
      const num = Number(part);
      if (num > 0 && num <= max) result.add(num);
    }
  }
  return Array.from(result).sort((a, b) => a - b);
}

function getStringWidth(str) {
  let width = 0;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) > 255) width += 2; else width += 1;
  }
  return width;
}

function padString(str, length) {
  const currentWidth = getStringWidth(str);
  if (currentWidth >= length) return str;
  return str + ' '.repeat(length - currentWidth);
}

async function getNotebooks() {
  console.log('🔍 正在获取所有 Notebook 列表...');
  const res = runCLI('nlm notebook list --full -j', true);
  if (!res.success) {
    console.error('❌ 获取 Notebook 列表失败:', res.error);
    return [];
  }
  return parseJSON(res.output) || [];
}

async function getSources(notebookId) {
  const res = runCLI(`nlm source list ${notebookId} -j`, true);
  if (!res.success) return [];
  return parseJSON(res.output) || [];
}

async function getArtifacts(notebookId) {
  const res = runCLI(`nlm studio status ${notebookId} -j`, true);
  if (!res.success) return [];
  return parseJSON(res.output) || [];
}

function extractNotebookId(output) {
  if (!output) return null;
  const match = output.match(/[a-zA-Z0-9_-]{15,}/);
  return match ? match[0] : null;
}

async function manageExistingNotebooks() {
  const notebooks = await getNotebooks();
  if (notebooks.length === 0) {
    console.log('⚠️ 没有找到任何 Notebook。');
    return new Set();
  }

  console.log(`\n📬 你的账户中共有 ${notebooks.length} 个 Notebook。`);
  const limitInput = await askQuestion(`❓ 想要扫描多少个最近的 Notebook？(直接回车默认全部, 输入数字设置限制): `);
  
  let scanLimit = notebooks.length;
  if (limitInput.trim()) {
    const parsedLimit = parseInt(limitInput.trim());
    if (!isNaN(parsedLimit) && parsedLimit > 0) {
      scanLimit = Math.min(parsedLimit, notebooks.length);
      console.log(`⚠️ 注意：由于设置了扫描限制 (${scanLimit})，新任务的重复 URL 检测可能不完整。`);
    }
  }

  console.log(`\n📊 正在按顺序分析前 ${scanLimit} 个 Notebook 的状态...`);
  console.log('--------------------------------------------------------------------------------------------------------');
  console.log(`${'序号'.padEnd(4)} | ${padString('标题', 40)} | ${'Source 数量'.padEnd(11)} | ${'Slide 数量'}`);
  console.log('--------------------------------------------------------------------------------------------------------');
  
  const allKnownSources = new Set();
  const notebooksToProcess = [];
  const sourcelessNotebooks = [];

  for (let i = 0; i < scanLimit; i++) {
    const nb = notebooks[i];
    const nbId = nb.id || nb.notebookId;
    
    // 获取并显示详情
    const sources = await getSources(nbId);
    sources.forEach(s => { if (s.url) allKnownSources.add(s.url); });

    const artifacts = await getArtifacts(nbId);
    const slideCount = artifacts.filter(a => a.type === 'slide_deck' && a.status === 'completed').length;
    
    const record = { id: nbId, title: nb.title || '(无标题)', sourceCount: sources.length, slideCount };
    notebooksToProcess.push(record);
    
    // 实时输出每一行结果
    console.log(`${String(i + 1).padEnd(6)} | ${padString(record.title, 40)} | ${String(record.sourceCount).padEnd(11)} | ${record.slideCount}`);
    
    if (record.sourceCount === 0) {
      sourcelessNotebooks.push(record);
    }
  }
  console.log('--------------------------------------------------------------------------------------------------------\n');

  // 1. 全局清理 Source 为 0 的 Notebook
  if (sourcelessNotebooks.length > 0) {
    console.log(`🧹 发现 ${sourcelessNotebooks.length} 个没有任何 Source 的 Notebook。`);
    const answer = await askQuestion(`❓ 是否一键删除这些空的 Notebook？(y/N): `);
    if (answer.trim().toLowerCase() === 'y') {
      for (const nb of sourcelessNotebooks) {
        console.log(`   🗑️ 正在删除: ${nb.title} (${nb.id})`);
        runCLI(`nlm notebook delete ${nb.id} --confirm`, true);
      }
      console.log('✅ 清理完成。\n');
    }
  }

  // 2. 批量生成 Slide
  const missingSlides = notebooksToProcess.filter(nb => nb.sourceCount > 0 && nb.slideCount === 0);
  if (missingSlides.length > 0) {
    console.log(`🎴 发现 ${missingSlides.length} 个有 Source 但没有 Slide 的 Notebook:`);
    missingSlides.forEach((nb, i) => {
      console.log(`   ${i + 1}. ${nb.title} (${nb.id})`);
    });
    
    const rangeInput = await askQuestion(`\n❓ 请输入想要生成 Slide 的序号范围 (例如 1-3, 5, 8 或 ALL, 直接回车跳过): `);
    if (rangeInput.trim()) {
      const selectedIndices = parseRange(rangeInput, missingSlides.length);
      if (selectedIndices.length > 0) {
        let focusPrompt = await askQuestion('> 请输入 Slide 提示词 (直接回车默认: "用中文生成详细的slide"): ');
        if (!focusPrompt.trim()) focusPrompt = "用中文生成详细的slide";
        
        console.log(`\n⚙️ 开始为选定的 ${selectedIndices.length} 个 Notebook 生成 Slide...`);
        for (const idx of selectedIndices) {
          const nb = missingSlides[idx - 1];
          console.log(`   🎬 [${idx}/${selectedIndices.length}] 正在为 "${nb.title}" 生成 Slide...`);
          runCLI(`nlm slides create ${nb.id} --focus "${focusPrompt.replace(/"/g, '\\"')}" --confirm`, true);
        }
        console.log('✅ Slide 生成任务已全部下发。\n');
      }
    }
  }

  return allKnownSources;
}

async function batchCreateWithFiltering(allKnownSources) {
  console.log('\n🔗 3. 批量新建 Notebook (跳过已重复的 URL)');
  const urls = await askMultilineURLs();

  if (urls.length === 0) {
    console.log('⏭️ 未输入 URL，跳过批量创建。');
    return;
  }

  let focusPrompt = await askQuestion('\n> 请输入生成 Slide 用的提示词 (留空默认: "用中文生成详细的slide"): ');
  if (!focusPrompt.trim()) focusPrompt = "用中文生成详细的slide";

  for (const url of urls) {
    if (allKnownSources.has(url)) {
      console.log(`\n⏭️ 跳过 URL: ${url} (已在现有 Notebook 中存在)`);
      continue;
    }

    console.log(`\n🆕 正在为新 URL 创建任务: ${url}`);
    
    const createRes = runCLI(`nlm notebook create`, true);
    const notebookId = extractNotebookId(createRes.output);
    if (!notebookId) {
      console.error(`❌ 无法创建 Notebook 或提取 ID: ${createRes.error}`);
      continue;
    }
    console.log(`   ✅ 创建 Notebook 成功, ID: ${notebookId}`);

    console.log(`   ⏳ 正在添加 Source 并等待解析...`);
    const addRes = runCLI(`nlm source add ${notebookId} --url "${url}" --wait`, true);
    if (!addRes.success) {
      console.error(`   ❌ 添加 Source 失败: ${addRes.error}`);
      continue;
    }
    console.log(`   ✅ Source 添加成功`);

    console.log(`   🎴 正在生成 Slide...`);
    const slideRes = runCLI(`nlm slides create ${notebookId} --focus "${focusPrompt.replace(/"/g, '\\"')}" --confirm`, true);
    if (!slideRes.success) {
      console.error(`   ❌ 生成 Slide 失败: ${slideRes.error}`);
    } else {
      console.log(`   🎉 任务完成！`);
    }

    await sleep(2000); 
  }
}

async function askMultilineURLs() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  console.log('💡 请输入 URL 列表，每行一个，另起一行输入 END 结束输入：\n');
  return new Promise(resolve => {
    let inputUrls = [];
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed.toUpperCase() === 'END') {
        rl.close();
        resolve(inputUrls);
      } else if (trimmed) {
        const parts = trimmed.split(/[,\s]+/).map(s => s.trim()).filter(s => s.length > 0);
        inputUrls.push(...parts);
      }
    });
  });
}

async function main() {
  console.log('=============================================');
  console.log('🛠️ NotebookLM 综合管理助手 🛠️');
  console.log('=============================================\n');

  try {
    const allKnownSources = await manageExistingNotebooks();
    await batchCreateWithFiltering(allKnownSources);
  } catch (error) {
    console.error('\n💥 脚本运行出错:', error);
  } finally {
    console.log('\n🌟 管理流程已结束。');
  }
}

main();
