const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { fromPath } = require('pdf2pic');
const sharp = require('sharp');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const askQuestion = (query) => new Promise(resolve => rl.question(query, resolve));

// 处理 Ctrl+C 强制退出
rl.on('SIGINT', () => {
  console.log('\n🛑 收到中断信号，程序已退出。');
  rl.close();
  process.exit(0);
});

async function main() {
  console.log('=============================================');
  console.log('🖼️ NotebookLM PDF 到图片长图拼接小工具');
  console.log('=============================================\n');

  // 解析 CLI 参数
  const args = process.argv.slice(2);
  const argv = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].substring(2);
      const val = args[i + 1];
      if (val && !val.startsWith('--')) {
        argv[key] = val;
        i++;
      } else {
        argv[key] = true;
      }
    }
  }

  const downloadsDir = path.join(__dirname, 'slides_downloads');
  if (!fs.existsSync(downloadsDir)) {
    console.error(`❌ 未找到文件夹 ${downloadsDir}，请先使用下载脚本下载幻灯片。`);
    process.exit(1);
  }

  // 获取所有的 pdf 文件，并按修改时间从新到旧排序
  const files = fs.readdirSync(downloadsDir)
    .filter(f => f.toLowerCase().endsWith('.pdf'))
    .map(name => ({
      name,
      time: fs.statSync(path.join(downloadsDir, name)).mtime.getTime()
    }))
    .sort((a, b) => b.time - a.time)
    .map(f => f.name);
  
  if (files.length === 0) {
    console.log('ℹ️ 在 slides_downloads 下未找到任何 PDF 文件。程序退出。');
    process.exit(0);
  }

  console.log('📂 请选择要转成图片的幻灯片 (输入编号)：\n');
  files.forEach((file, index) => {
    console.log(`  [${index + 1}] ${file}`);
  });

  function parseIndices(inputStr) {
    const indices = new Set();
    const parts = inputStr.split(/[,\s]+/);
    for (const part of parts) {
      if (!part) continue;
      if (part.includes('-')) {
        const [startStr, endStr] = part.split('-');
        const start = parseInt(startStr, 10);
        const end = parseInt(endStr, 10);
        if (!isNaN(start) && !isNaN(end) && start <= end) {
          for (let i = start; i <= end; i++) {
            if (i >= 1 && i <= files.length) indices.add(i - 1);
          }
        }
      } else {
        const num = parseInt(part, 10);
        if (!isNaN(num) && num >= 1 && num <= files.length) {
          indices.add(num - 1);
        }
      }
    }
    return Array.from(indices).sort((a, b) => a - b);
  }

  let selectedIndices = [];
  if (argv.file) {
    selectedIndices = parseIndices(String(argv.file));
    if (selectedIndices.length > 0) {
      console.log(`> [CLI 参数] 自动选择文件编号: ${selectedIndices.map(n => n + 1).join(', ')}`);
    } else {
      console.log(`> [CLI 参数] 文件编号 ${argv.file} 无效，将退回交互模式手动选择。`);
    }
  }

  if (selectedIndices.length === 0) {
    while (true) {
      const ans = await askQuestion('\n> 请输入文件编号 (单选 1，多选 1,3,5，连续多选 1-15): ');
      selectedIndices = parseIndices(ans);
      
      if (selectedIndices.length > 0) {
        break;
      }
      console.log('⚠️ 输入无效，请重试。');
    }
  }

  const selectedFiles = selectedIndices.map(idx => files[idx]);
  console.log(`\n✅ 已选择文件: ${selectedFiles.join(', ')}`);
  
  // 询问拼接参数 (全批次共享同样的配置)
  console.log('\n---------------------------------------------');
  console.log('⚙️ 请配置拼接选项: ');
  
  let layout = 1;
  if (argv.layout) {
    const num = parseInt(argv.layout, 10);
    if (num === 1 || num === 2) {
      layout = num;
      console.log(`> [CLI 参数] 排列方式: ${layout === 1 ? '垂直拼接' : '水平拼接'}`);
    }
  } else {
    while (true) {
      const ans = await askQuestion('   1) 垂直拼接 (Vertical) 默认\n   2) 水平拼接 (Horizontal)\n> 请选择排列方式 (1 或 2，直接回车选 1): ');
      if (ans.trim() === '') {
        break;
      }
      if (ans.trim() === '1' || ans.trim() === '2') {
        layout = parseInt(ans.trim(), 10);
        break;
      }
    }
  }

  let itemsPerGrid = 2;
  if (argv.grid) {
    const num = parseInt(argv.grid, 10);
    if (!isNaN(num) && num > 0) {
      itemsPerGrid = num;
      console.log(`> [CLI 参数] 每张大图拼接数量: ${itemsPerGrid} 张`);
    }
  } else {
    while (true) {
      const ans = await askQuestion('> 您希望几张幻灯片拼成一张大图？ (直接回车默认 2 张): ');
      if (ans.trim() === '') {
        break;
      }
      const n = parseInt(ans.trim(), 10);
      if (!isNaN(n) && n > 0) {
        itemsPerGrid = n;
        break;
      }
    }
  }

  let gap = 20;
  if (argv.gap !== undefined) {
    const num = parseInt(argv.gap, 10);
    if (!isNaN(num) && num >= 0) {
      gap = num;
      console.log(`> [CLI 参数] 间距设置: ${gap} 像素`);
    }
  } else {
    while (true) {
      const ans = await askQuestion('> 每张图之间的间距(像素 Gap)？ (直接回车默认 20 像素): ');
      if (ans.trim() === '') {
        break;
      }
      const n = parseInt(ans.trim(), 10);
      if (!isNaN(n) && n >= 0) {
        gap = n;
        break;
      }
    }
  }

  console.log('\n=============================================');
  console.log('🚀 开始渲染与拼接处理...');
  
  for (let fIdx = 0; fIdx < selectedFiles.length; fIdx++) {
    const selectedFile = selectedFiles[fIdx];
    const pdfPath = path.join(downloadsDir, selectedFile);
    const pdfBaseName = path.parse(selectedFile).name;

    console.log(`\n📄 [${fIdx + 1}/${selectedFiles.length}] 正在处理: ${selectedFile}`);
    
    // 建立临时输出目录和结果输出目录
    const tempDir = path.join(downloadsDir, '__temp_' + pdfBaseName);
    const outDir = path.join(downloadsDir, pdfBaseName + '_images');
    
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

    // 初始化 pdf2pic 选项
    const options = {
      density: 300,
      saveFilename: "page",
      savePath: tempDir,
      format: "png",
      preserveAspectRatio: true
    };

    const storeAsImage = fromPath(pdfPath, options);
    
    try {
      console.log(`   ⏳ [1/2] 正在将 PDF 每页渲染成清晰图片...`);
      const results = await storeAsImage.bulk(-1, { responseType: "image" });
      results.sort((a, b) => a.page - b.page);
      
      console.log(`   ✅ 成功解出 ${results.length} 张单页图片。`);
      console.log(`   ⏳ [2/2] 正在根据策略拼接分块 (每块 ${itemsPerGrid} 张)...`);
      
      const chunks = [];
      for (let i = 0; i < results.length; i += itemsPerGrid) {
        chunks.push(results.slice(i, i + itemsPerGrid));
      }

      const isVertical = layout === 1;
      let chunkIndex = 0;

      for (const chunk of chunks) {
        chunkIndex++;
        
        const buffers = [];
        const metas = [];
        for (const item of chunk) {
          const buf = await sharp(item.path).toBuffer();
          const meta = await sharp(buf).metadata();
          buffers.push(buf);
          metas.push(meta);
        }
        
        let totalWidth = 0;
        let totalHeight = 0;
        
        if (isVertical) {
          totalWidth = Math.max(...metas.map(m => m.width));
          totalHeight = metas.reduce((acc, m) => acc + m.height, 0) + gap * (metas.length - 1);
        } else {
          totalWidth = metas.reduce((acc, m) => acc + m.width, 0) + gap * (metas.length - 1);
          totalHeight = Math.max(...metas.map(m => m.height));
        }

        const compositeObjects = [];
        let currentX = 0, currentY = 0;
        for (let i = 0; i < buffers.length; i++) {
          compositeObjects.push({
            input: buffers[i],
            top: currentY,
            left: currentX
          });
          
          if (isVertical) {
            currentY += metas[i].height + gap;
          } else {
            currentX += metas[i].width + gap;
          }
        }

        const outFilePath = path.join(outDir, `${pdfBaseName}_${chunkIndex}.png`);
        
        await sharp({
          create: {
            width: totalWidth,
            height: totalHeight,
            channels: 4,
            background: { r: 255, g: 255, b: 255, alpha: 1 }
          }
        })
        .composite(compositeObjects)
        .png()
        .toFile(outFilePath);
        
        console.log(`   🎨 生成第 ${chunkIndex}/${chunks.length} 块 => ${outFilePath}`);
      }
      
      console.log(`   🌟 ${selectedFile} 处理完成!`);
      
    } catch (err) {
      console.error(`\n   ❌ 处理 ${selectedFile} 时发生错误:`, err.message);
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (e) {}
    }
  }

  console.log('\n=============================================');
  console.log(`🌟 所有选择的合并任务已全部完成！`);
  console.log('=============================================');
  rl.close();
}

main().catch(err => {
  console.error('\n💥 发生未预期的致命错误:', err);
  rl.close();
  process.exit(1);
});
