require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const sharp = require('sharp');

chromium.use(stealth);

const USER_DATA_DIR = path.join(__dirname, '.browser_data');

const readline = require('readline');

function askQuestion(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(query, ans => { rl.close(); resolve(ans); }));
}

async function randomWait(page, min, max) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  await page.waitForTimeout(delay);
}

function parseIndices(inputStr, maxLen) {
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
          if (i >= 1 && i <= maxLen) indices.add(i - 1);
        }
      }
    } else {
      const num = parseInt(part, 10);
      if (!isNaN(num) && num >= 1 && num <= maxLen) {
        indices.add(num - 1);
      }
    }
  }
  return Array.from(indices).sort((a, b) => a - b);
}

function calculateNextScheduleTime(baseTime, index, interval, skipNight) {
    if (index === 0) return baseTime;
    
    let t = baseTime;
    for (let i = 0; i < index; i++) {
        t += interval * 60 * 60 * 1000;
        let d = new Date(t);
        let h = d.getHours();
        // If it lands in the night (>= 23 or < 7)
        if (skipNight && (h >= 23 || h < 7)) {
            // Push it to 07:00 of the (current or next) day
            if (h >= 23) {
                d.setDate(d.getDate() + 1);
            }
            d.setHours(7, 0, 0, 0);
            t = d.getTime();
        }
    }
    return t;
}

/**
 * 自动生成拼图封面
 * @param {string[]} imagePaths 原始图片路径
 * @param {string} targetDir 输出目录
 * @returns {Promise<string|null>} 拼图路径
 */
async function generateCollage(imagePaths, targetDir) {
  if (!imagePaths || imagePaths.length === 0) return null;

  try {
    console.log(`🎨 正在生成拼图封面 (基于前 ${Math.min(imagePaths.length, 9)} 张图)...`);
    
    // 以第一张图为基准尺寸
    const firstImage = sharp(imagePaths[0]);
    const metadata = await firstImage.metadata();
    const w = metadata.width;
    const h = metadata.height;

    const count = imagePaths.length;
    // 数量 <= 4 用 2x2，否则用 3x3
    const gridSize = count <= 4 ? 2 : 3;
    const totalSlots = gridSize * gridSize;

    const composites = [];
    for (let i = 0; i < totalSlots; i++) {
        const imgPath = imagePaths[i % count]; // 如果不够则循环
        const row = Math.floor(i / gridSize);
        const col = i % gridSize;

        // 处理每一张小图：缩放并裁切到基准尺寸
        const buffer = await sharp(imgPath)
            .resize(w, h, { fit: 'cover', position: 'center' })
            .toBuffer();

        composites.push({
            input: buffer,
            top: row * h,
            left: col * w,
        });
    }

    const collageFilename = `collage_${Date.now()}.png`;
    const outputPath = path.join(targetDir, collageFilename);

    await sharp({
        create: {
            width: w * gridSize,
            height: h * gridSize,
            channels: 4,
            background: { r: 255, g: 255, b: 255, alpha: 1 }
        }
    })
    .composite(composites)
    .toFile(outputPath);

    console.log(`✅ 拼图封面已生成: ${outputPath}`);
    return outputPath;
  } catch (err) {
    console.error(`❌ 生成拼图失败: ${err.message}`);
    return null;
  }
}

async function publishTask(workDirOrImagePaths, title, descText, options = {}) {
  console.log("==================================================");
  console.log(`🚀 开始发布任务: ${title}`);
  
  let targetDir;
  let imagePaths = [];

  if (Array.isArray(workDirOrImagePaths)) {
    imagePaths = [...workDirOrImagePaths];
    targetDir = imagePaths.length > 0 ? path.dirname(imagePaths[0]) : process.cwd();
  } else {
    targetDir = workDirOrImagePaths;
    // 收集工作区内的有效图片
    const files = fs.readdirSync(targetDir);
    const imgFiles = files.filter(f => /\.(png|jpe?g)$/i.test(f)).sort((a, b) => {
      const numA = parseInt(a.match(/^\d+/)?.[0]) || 0;
      const numB = parseInt(b.match(/^\d+/)?.[0]) || 0;
      return numA - numB || a.localeCompare(b);
    });

    for (const f of imgFiles) {
      if (imagePaths.length >= 18) break; 
      imagePaths.push(path.resolve(targetDir, f));
    }
  }

  if (imagePaths.length === 0) {
    console.log(`❌ 未找到任何图片文件 (*.png, *.jpg)。跳过。`);
    return false;
  }

  console.log(`📂 工作目录: ${targetDir}`);
  console.log(`📝 标题: ${title}`);
  console.log(`🖼️  图片: ${imagePaths.length} 张`);
  console.log("==================================================");

  if (options.collage) {
    const collagePath = await generateCollage(imagePaths, targetDir);
    if (collagePath) {
      imagePaths = [collagePath, ...imagePaths];
    }
  }

  const isGithubActions = process.env.GITHUB_ACTIONS === "true";
  const headlessMode = isGithubActions;

  console.log(`🚀 启动浏览器 (Headless: ${headlessMode})...`);

  if (!fs.existsSync(USER_DATA_DIR)) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  }

  const executablePath = chromium.executablePath();
  if (!fs.existsSync(executablePath)) {
    console.log("❌ 这是你第一次运行，或者 Playwright Chromium 内核未找到！");
    console.log("👉 请先在终端运行以下命令进行环境初始化 (仅需一次)：");
    console.log("   pnpm exec playwright install chromium\n");
    return;
  }

  const browserCtx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: headlessMode,
    viewport: { width: 1280, height: 900 },
    locale: "zh-CN",
    args: ["--disable-blink-features=AutomationControlled"]
  });

  const page = browserCtx.pages().length > 0 ? browserCtx.pages()[0] : await browserCtx.newPage();

  const cookiesJson = process.env.COOKIES_JSON;
  if (cookiesJson) {
    try {
      console.log("🍪 检测到 cookies 环境变量，正在注入...");
      const cookies = JSON.parse(cookiesJson);
      await browserCtx.addCookies(cookies);
      console.log("   Cookies 注入成功");
    } catch (e) {
      console.log(`❌ Cookies 注入失败: ${e.message}`);
    }
  }

  try {
    console.log("\n🌐 正在打开小红书创作者中心...");
    await page.goto("https://creator.xiaohongshu.com/publish/publish?from=menu&target=image", { waitUntil: "networkidle", timeout: 60000 });

    const currentUrl = page.url().toLowerCase();
    const loginTextCount = await page.locator("text=登录").count();

    if (currentUrl.includes("login") || loginTextCount > 0) {
      console.log("\n⚠️  请在浏览器中手动登录小红书...");
      console.log("   登录完成后，脚本会自动继续");

      await randomWait(page, 1500, 3000);
      try {
        await page.waitForURL("**/publish/**", { timeout: 300000 });
        console.log("✅ 登录成功！");
      } catch (err) {
        console.log("❌ 等待登录超时或手动打断！");
        throw err;
      }
    }

    await randomWait(page, 1500, 3000);

    console.log("\n📤 正在上传图片...");

    try {
      const imageTab = page.locator('text=发布图文, text=图文, [class*="image"]').first();
      if ((await imageTab.count()) > 0) {
        await imageTab.click({ force: true });
        await randomWait(page, 800, 1500);
      }
    } catch (e) {
      // Ignored
    }

    const fileInputs = await page.locator('input[type="file"]').all();
    let imageInput = null;

    for (const inp of fileInputs) {
      const accept = (await inp.getAttribute("accept")) || "";
      if (accept.toLowerCase().includes("image") || accept.toLowerCase().includes(".jpg") || accept.toLowerCase().includes(".png") || accept.toLowerCase().includes(".jpeg")) {
        imageInput = inp;
        break;
      }
    }

    if (!imageInput) {
      for (const inp of fileInputs) {
        const accept = (await inp.getAttribute("accept")) || "";
        if (!accept.includes(".mp4") && !accept.includes(".mov")) {
          imageInput = inp;
          break;
        }
      }
    }

    if (!imageInput) {
      console.log("⚠️  未找到图片上传按钮，请手动上传图片");
      console.log(`   图片路径: ${imagePaths.join(", ")}`);
    } else {
      for (let i = 0; i < imagePaths.length; i++) {
        try {
          console.log(`   上传图片 ${i + 1}/${imagePaths.length}...`);
          await imageInput.setInputFiles(imagePaths[i]);
          await randomWait(page, 1500, 3000);
        } catch (e) {
          console.log(`   图片 ${i + 1} 上传失败: ${e.message}`);
        }
      }
    }

    console.log("   等待图片处理...");
    await randomWait(page, 4000, 6000);

    console.log("📝 正在填写标题...");
    const titleSelectors = [
      '[placeholder*="填写标题会有更多赞哦"]',
      '[placeholder*="填写标题"]',
      'input[placeholder*="标题"]',
      '.c-input_inner',
      'input.titleInput',
      '#title',
      '[class*="title"] input',
      '[data-testid="title"]'
    ];

    let titleFilled = false;
    for (const selector of titleSelectors) {
      const titleInput = page.locator(selector).first();
      try {
        if ((await titleInput.isVisible()) && (await titleInput.isEnabled())) {
          await randomWait(page, 800, 1500);
          // 小红书标题严格限制最长 20 个字
          await titleInput.fill(title.substring(0, 20));
          await randomWait(page, 500, 1000);
          titleFilled = true;
          break;
        }
      } catch (e) {}
    }

    if (!titleFilled) {
      console.log("⚠️  无法自动填写标题，请检查页面结构。");
    }

    console.log("📝 正在填写正文...");
    
    // 正文输入框选择器
    const descSelectors = [
      '[placeholder*="输入正文描述，真诚有价值的分享予人温暖"]',
      '[placeholder*="输入正文描述"]',
      '[placeholder*="正文"]',
      '[placeholder*="描述"]',
      '[class*="content"] textarea',
      '[class*="desc"] textarea',
      '#post-textarea',
      '[contenteditable="true"]'
    ];

    for (const selector of descSelectors) {
      const descInput = page.locator(selector).first();
      if ((await descInput.count()) > 0) {
        try {
          await randomWait(page, 800, 1500);
          // 正文最长 1000 个字
          await descInput.fill(descText.substring(0, 1000));
          await randomWait(page, 500, 1000);
          break;
        } catch (e) {}
      }
    }

    console.log("✅ 内容填写完成！");

    if (options.schedule || options.scheduleTime) {
      console.log("\n⏰ 正在设置定时发布...");
      try {
        let future;
        if (options.scheduleTime) {
          future = new Date(options.scheduleTime);
        } else {
          future = new Date(Date.now() + 2 * 60 * 60 * 1000);
        }
        const yyyy = future.getFullYear();
        const mm = String(future.getMonth() + 1).padStart(2, '0');
        const dd = String(future.getDate()).padStart(2, '0');
        const hh = String(future.getHours()).padStart(2, '0');
        const min = String(future.getMinutes()).padStart(2, '0');
        const timeStr = `${yyyy}-${mm}-${dd} ${hh}:${min}`;
        
        console.log(`   目标时间: ${timeStr}${options.scheduleTime ? '' : ' (两小时后)'}`);
        
        const scheduleContainer = page.locator('.custom-switch-card').filter({ hasText: /^定时发布$/ }).first();
        if (await scheduleContainer.count() > 0) {
            const switchBtn = scheduleContainer.locator('.d-switch').first();
            const isChecked = await scheduleContainer.locator('input[type="checkbox"]').evaluate(n => n.checked).catch(() => false);
            if (!isChecked) {
                await switchBtn.click({ force: true }).catch(() => switchBtn.click());
                await randomWait(page, 1000, 2000);
            }
            
            // 查找时间输入框并尝试 focus
            
            const hasInput = await page.evaluate(() => {
                 const inp = Array.from(document.querySelectorAll('input')).find(i => /^20\d\d-/.test(i.value) || (i.placeholder && (i.placeholder.includes('日期') || i.placeholder.includes('时间') || i.placeholder.includes('请选择'))));
                 if (inp) {
                     inp.focus();
                     return true;
                 }
                 return false;
            });
            
            if (hasInput) {
                await randomWait(page, 500, 1000);
                const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
                await page.keyboard.press(isMac ? 'Meta+A' : 'Control+A');
                await randomWait(page, 200, 500);
                // 模拟输入
                await page.keyboard.insertText(timeStr);
                await randomWait(page, 200, 500);
                await page.keyboard.press('Enter');
                
                // 点击空白处收起日历框
                await page.mouse.click(10, 10);
                await randomWait(page, 1000, 2000);
                console.log(`   时间设置成功: ${timeStr}`);
            } else {
                console.log("   ⚠️ 无法找到日期输入框，请检查页面是否有变化");
                await page.screenshot({ path: path.join(targetDir, "debug_schedule.png") });
                const dbg = await page.evaluate(() => document.body.innerHTML);
                try { require('fs').writeFileSync(path.join(targetDir, "debug_schedule.html"), dbg); } catch(e){}
            }
        } else {
            console.log("   ⚠️ 未找到定时发布选项卡");
        }
      } catch (e) {
         console.log(`   ⚠️ 设置定时发布出错: ${e.message}`);
      }
    }

    if (options.test) {
      console.log("\n🛑 当前为测试模式(--test)，跳过真正的发布点击...");
      await randomWait(page, 4000, 6000);
      return true;
    }

    console.log("\n🚀 正在自动点击发布...");
    const submitBtn = page.locator('button.submit, button:has-text("发布"), .publish-btn').first();

    if ((await submitBtn.count()) > 0) {
      for (let attempt = 0; attempt < 3; attempt++) {
        console.log(`   点击发布按钮 (尝试 ${attempt + 1})...`);
        try {
          await submitBtn.click({ timeout: 2000 });
        } catch (e) {
          await submitBtn.click({ force: true, timeout: 2000 });
        }

        await randomWait(page, 1500, 3000);

        const slider = page.locator('.nc_scale, .slider-container, #nc_1_n1z').first();
        if ((await slider.count()) > 0 && await slider.isVisible()) {
          console.log("⚠️  检测到滑块验证码！尝试自动滑动...");
          const sliderHandle = page.locator('#nc_1_n1z, .nc_iconfont.btn_slide').first();
          if ((await sliderHandle.count()) > 0) {
            const box = await sliderHandle.boundingBox();
            if (box) {
              await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
              await page.mouse.down();
              await page.mouse.move(box.x + 500, box.y + box.height / 2, { steps: 20 });
              await page.mouse.up();
              await randomWait(page, 1500, 3000);
            }
          }
        }

        const currentUrlAfterClick = page.url();
        if (currentUrlAfterClick.includes("manage") || currentUrlAfterClick.includes("success")) {
          break;
        }
        if ((await page.locator('text=发布成功').count()) > 0 || (await page.locator('text=已发布').count()) > 0) {
          break;
        }
        if (!(await submitBtn.isVisible())) {
          break;
        }

        console.log("   似乎未跳转，准备重试...");
        await randomWait(page, 1500, 3000);
      }
    } else {
      console.log("❌ 未找到发布按钮，请手动点击");
    }

    try {
      console.log("   等待发布成功确认...");
      const startTime = Date.now();
      let success = false;
      while (Date.now() - startTime < 15000) {
        const curUrl = page.url();
        if (curUrl.includes("manage") || curUrl.includes("success")) {
          console.log("   检测到页面跳转，发布可能成功");
          success = true;
          break;
        }

        if ((await page.locator('text=发布成功').count()) > 0 || 
            (await page.locator('text=已发布').count()) > 0 || 
            (await page.locator('div[class*="success"]').count()) > 0) {
          console.log("   检测到成功提示");
          success = true;
          break;
        }

        await randomWait(page, 400, 600);
      }

      if (success) {
        console.log("🎉 发布成功！");
      } else {
        throw new Error("Timeout waiting for success signal");
      }
    } catch (err) {
      console.log(`⚠️  未检测到明确的发布成功信号: ${err.message}`);
      const screenshotPath = path.join(targetDir, "publish_status_debug.png");
      await page.screenshot({ path: screenshotPath });
      console.log(`   已保存页面截图到: ${screenshotPath}`);
      console.log("   请手动检查浏览器状态");
    }

    if ((await page.locator('text=发布成功').count()) === 0) {
      console.log("\n等待几秒查看状态...");
      await randomWait(page, 4000, 6000);
    } else {
      await randomWait(page, 2000, 4000);
    }

    return true;

  } catch (err) {
    console.log(`\n❌ 发布失败: ${err.message}`);
    if (!isGithubActions) {
      await randomWait(page, 4000, 6000);
    }
    return false;
  } finally {
    if (!isGithubActions) {
      try {
        const cookies = await browserCtx.cookies();
        fs.writeFileSync("xhs_cookies.json", JSON.stringify(cookies, null, 2), "utf8");
        console.log(`\n🍪 Cookies 已保存到 ${path.resolve("xhs_cookies.json")}`);
        console.log("   请复制此文件内容到 GitHub Secrets (Name: COOKIES_JSON)");
      } catch (err) {
        console.log(`   Cookies 保存失败: ${err.message}`);
      }
    }

    await browserCtx.close();
    console.log("\n👋 浏览器已关闭");
  }
}

/**
 * 交互式配置模式
 */
async function interactiveMode() {
  console.log("\n💬 进入交互式配置模式...");
  const config = {};

  /**
   * macOS 专用文件夹选择器
   */
  async function chooseFolderMac() {
    if (process.platform !== 'darwin') return null;
    try {
      const cmd = `osascript -e 'POSIX path of (choose folder with prompt "请选择包含图片的文件夹")'`;
      const result = execSync(cmd).toString().trim();
      return result;
    } catch (e) {
      return null;
    }
  }

  const mode = await askQuestion("请选择发布模式 [1: 文件夹中所有图片, 发一个帖子; 2: 按照图片拆分成多个帖子发送] (默认1): ");
  config.mode = (mode === "2") ? "bulk" : "single";

  let dirPath = "";
  while (!dirPath) {
    const currentDir = process.cwd();
    console.log(`\n📂 当前目录: ${currentDir}`);
    const inputPath = await askQuestion("请输入图片文件夹路径 (直接回车 呼起文件夹选择框, 或输入 ./images 等): ");
    
    if (!inputPath) {
      if (process.platform === 'darwin') {
        const chosen = await chooseFolderMac();
        if (chosen) {
          dirPath = chosen;
        } else {
          console.log("⚠️ 未选择文件夹，请手动输入路径。");
        }
      } else {
        console.log("❌ 非 Mac 环境无法呼起选择框，请输入文件夹路径。");
      }
    } else {
      const resolved = path.resolve(currentDir, inputPath);
      if (fs.existsSync(resolved)) {
        dirPath = resolved;
      } else {
        console.log(`❌ 路径不存在: ${resolved}\n请重新输入。`);
      }
    }
  }
  config.dir = dirPath;

  if (config.mode === "bulk") {
    const chunkInput = await askQuestion("每篇帖子包含几张图片? (默认9): ");
    config.chunk = parseInt(chunkInput, 10) || 9;
  }

  config.title = await askQuestion("请输入标题 (留空则尝试读取 meta.json 或文件夹名): ");
  config.desc = await askQuestion("请输入正文描述: ");

  const collageInput = await askQuestion("是否开启自动拼图封面? (y/n, 默认n): ");
  config.collage = collageInput.toLowerCase() === "y";

  // 计算帖子概览
  let totalPosts = 1;
  const absPath = path.resolve(process.cwd(), config.dir);
  const files = fs.readdirSync(absPath);
  const imgFiles = files.filter(f => /\.(png|jpe?g)$/i.test(f));
  if (config.mode === "bulk") {
    totalPosts = Math.ceil(imgFiles.length / config.chunk);
  }

  console.log(`\n📊 任务概览: 共检测到 ${imgFiles.length} 张图片，将分为 ${totalPosts} 篇帖子发布。`);

  // 定时发布设置
  console.log("\n⏰ 定时发布设置:");
  const defaultStartTime = new Date(Date.now() + 30 * 60 * 1000);
  const defaultStartTimeStr = `${defaultStartTime.getFullYear()}-${String(defaultStartTime.getMonth() + 1).padStart(2, '0')}-${String(defaultStartTime.getDate()).padStart(2, '0')} ${String(defaultStartTime.getHours()).padStart(2, '0')}:${String(defaultStartTime.getMinutes()).padStart(2, '0')}`;
  
  const startTimeStr = await askQuestion(`请输入首篇发布时间 (默认 ${defaultStartTimeStr}): `);
  config.scheduleStart = startTimeStr ? new Date(startTimeStr).getTime() : defaultStartTime.getTime();
  if (isNaN(config.scheduleStart)) {
      console.log("⚠️ 时间格式非法，使用默认时间。");
      config.scheduleStart = defaultStartTime.getTime();
  }

  const intervalInput = await askQuestion("请输入发布间隔小时数 (默认 2): ");
  config.interval = parseFloat(intervalInput) || 2;

  const skipNightInput = await askQuestion("是否跳过凌晨 (23:00-07:00)? (y/n, 默认y): ");
  config.skipNight = skipNightInput.toLowerCase() !== "n";

  // 生成预览
  console.log("\n📋 发布计划预览:");
  console.log("--------------------------------------------------");
  const plan = [];
  for (let i = 0; i < totalPosts; i++) {
      const pTime = calculateNextScheduleTime(config.scheduleStart, i, config.interval, config.skipNight);
      const pTimeStr = new Date(pTime).toLocaleString('zh-CN', { hour12: false });
      const pTitle = config.mode === "bulk" ? `${config.title || "未命名"} (${i + 1})` : (config.title || "未命名");
      console.log(`[第 ${String(i + 1).padStart(2, '0')} 篇] ${pTimeStr} | ${pTitle}`);
      plan.push({ time: pTime, title: pTitle });
  }
  console.log("--------------------------------------------------");

  const confirm = await askQuestion("\n✅ 确认以上发布计划并开始执行? (y/n, 默认y): ");
  if (confirm.toLowerCase() === "n") {
    console.log("👋 已取消发布。");
    process.exit(0);
  }

  // 构建模拟的 argv 对象
  const simulatedArgv = {
    collage: config.collage,
    schedule: true,
    'schedule-start': new Date(config.scheduleStart).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-'),
    'schedule-interval': config.interval,
    'skip-night': config.skipNight,
    title: config.title,
    desc: config.desc,
  };

  if (config.mode === "bulk") {
    simulatedArgv['bulk-dir'] = config.dir;
    simulatedArgv.chunk = config.chunk;
  } else {
    simulatedArgv.dir = config.dir;
  }

  return simulatedArgv;
}

async function runBatch() {
  console.log("==================================================");
  console.log("小红书 Playwright(Node.js) 批量发布工具");
  console.log("==================================================");

  const args = process.argv.slice(2);
  let argv = {};

  // 如果没有提供任何命令行参数，默认进入交互模式
  if (args.length === 0) {
    argv = await interactiveMode();
  } else {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-i' || args[i] === '--interactive') {
        argv = await interactiveMode();
        break; 
      }
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
  }

  let scheduleStartTimestamp = null;
  let scheduleIntervalHours = parseFloat(argv['schedule-interval']) || 2;
  const skipNight = !!argv['skip-night'];

  if (argv['schedule-start']) {
      scheduleStartTimestamp = new Date(argv['schedule-start']).getTime();
      if (isNaN(scheduleStartTimestamp)) {
          console.log("❌ --schedule-start 时间格式不正确，建议使用 'YYYY-MM-DD HH:mm'");
          return;
      }
  }

  if (argv['bulk-dir']) {
    const bulkDir = path.resolve(process.cwd(), argv['bulk-dir']);
    if (!fs.existsSync(bulkDir)) {
      console.log(`❌ 指定的批量文件夹不存在: ${bulkDir}`);
      return;
    }
    const chunk = parseInt(argv.chunk, 10) || 9; // 默认9张图片一篇帖子
    const title = argv.title || "批量发布";
    const desc = argv.desc || "这是自动批量发布的图文";

    console.log(`\n📦 开启文件夹批量分P发布模式`);
    console.log(`📁 目标文件夹: ${bulkDir}`);
    console.log(`🖼️ 每篇帖子图片数: ${chunk}`);
    console.log(`📝 统一标题: ${title} (带序号)`);

    const files = fs.readdirSync(bulkDir);
    const imgFiles = files.filter(f => /\.(png|jpe?g)$/i.test(f)).sort((a, b) => {
      const numA = parseInt(a.match(/^\d+/)?.[0]) || 0;
      const numB = parseInt(b.match(/^\d+/)?.[0]) || 0;
      return numA - numB || a.localeCompare(b);
    }).map(f => path.resolve(bulkDir, f));

    if (imgFiles.length === 0) {
      console.log(`❌ 文件夹中没有图片文件: ${bulkDir}`);
      return;
    }

    const totalPosts = Math.ceil(imgFiles.length / chunk);
    console.log(`📊 共计 ${imgFiles.length} 张图片，将分为 ${totalPosts} 篇帖子发布。`);

    let successCount = 0;
    for (let i = 0; i < totalPosts; i++) {
      const chunkPaths = imgFiles.slice(i * chunk, (i + 1) * chunk);
      const postTitle = `${title} (${i + 1})`;
      console.log(`\n▶️ 开始执行 第 ${i + 1}/${totalPosts} 个任务...`);
      let taskOptions = { schedule: !!argv.schedule, test: !!argv.test, collage: !!argv.collage };
      if (scheduleStartTimestamp) {
        taskOptions.scheduleTime = calculateNextScheduleTime(scheduleStartTimestamp, i, scheduleIntervalHours, skipNight);
        taskOptions.schedule = true;
      }
      const isSuccess = await publishTask(chunkPaths, postTitle, desc, taskOptions);
      if (isSuccess) successCount++;

      if (i < totalPosts - 1) {
        const delayMs = Math.floor(Math.random() * (8000 - 3000 + 1)) + 3000;
        console.log(`\n⏳ 等待 ${(delayMs / 1000).toFixed(1)} 秒后执行下一个任务...`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    console.log(`\n🎉 批量发布完毕! 总任务: ${totalPosts}, 成功: ${successCount}`);
    return;
  }

  if (argv.dir) {
    const workDir = path.resolve(process.cwd(), argv.dir);
    if (!fs.existsSync(workDir)) {
      console.log(`❌ 指定的目录不存在: ${workDir}`);
      return;
    }
    let title = argv.title || "";
    let desc = argv.desc || "";

    const metaPath = path.join(workDir, 'meta.json');
    if (!title && fs.existsSync(metaPath)) {
       try {
         const data = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
         title = title || data.title;
         desc = desc || data.content + (data.tags ? "\n\n" + data.tags.join(" ") : "");
       } catch (e) {}
    }

    if (!title) {
      console.log("❌ 必须提供 --title 参数或确保目录内有 meta.json。");
      return;
    }

    let taskOptions = { schedule: !!argv.schedule, test: !!argv.test, collage: !!argv.collage };
    if (scheduleStartTimestamp) {
      taskOptions.scheduleTime = scheduleStartTimestamp;
      taskOptions.schedule = true;
    }
    await publishTask(workDir, title, desc, taskOptions);
    return;
  }

  const downloadsDir = path.join(__dirname, 'slides_downloads');
  if (!fs.existsSync(downloadsDir)) {
    console.error(`❌ 未找到文件夹 ${downloadsDir}，没有任何图片可发。`);
    process.exit(1);
  }

  const folders = fs.readdirSync(downloadsDir)
    .filter(f => f.endsWith('_images') && fs.statSync(path.join(downloadsDir, f)).isDirectory())
    .map(name => ({
      name,
      time: fs.statSync(path.join(downloadsDir, name)).mtime.getTime()
    }))
    .sort((a, b) => b.time - a.time)
    .map(f => f.name);

  if (folders.length === 0) {
    console.log('ℹ️ 在 slides_downloads 下未找到任何 _images 后缀的文件夹。');
    process.exit(0);
  }

  console.log('📂 扫描到以下图集文件夹 (按最新时间排序)：\n');
  folders.forEach((folder, index) => {
    console.log(`  [${index + 1}] ${folder}`);
  });

  let selectedIndices = [];
  while (true) {
    const ans = await askQuestion('\n> 请输入要批量发布的文件夹编号 (单选 1，多选 1,3,5，连续多选 1-15): ');
    selectedIndices = parseIndices(ans, folders.length);
    if (selectedIndices.length > 0) {
      break;
    }
    console.log('⚠️ 输入无效，请重试。');
  }

  console.log(`\n✅ 已选择 ${selectedIndices.length} 个发布任务，将按顺序逐一执行...`);
  
  let successCount = 0;
  for (let i = 0; i < selectedIndices.length; i++) {
    const idx = selectedIndices[i];
    const folderName = folders[idx];
    const workDir = path.join(downloadsDir, folderName);
    
    const rawTitle = folderName.replace('_images', '');
    const title = rawTitle.substring(0, 20);
    const desc = rawTitle;

    console.log(`\n▶️ 开始执行 第 ${i + 1}/${selectedIndices.length} 个任务...`);
    let taskOptions = { schedule: !!argv.schedule, test: !!argv.test, collage: !!argv.collage };
    if (scheduleStartTimestamp) {
      taskOptions.scheduleTime = calculateNextScheduleTime(scheduleStartTimestamp, i, scheduleIntervalHours, skipNight);
      taskOptions.schedule = true;
    }
    const isSuccess = await publishTask(workDir, title, desc, taskOptions);
    if (isSuccess) successCount++;
    
    if (i < selectedIndices.length - 1) {
      const delayMs = Math.floor(Math.random() * (8000 - 3000 + 1)) + 3000;
      console.log(`\n⏳ 等待 ${(delayMs / 1000).toFixed(1)} 秒后执行下一个任务...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  console.log(`\n🎉 批量发布完毕! 总任务: ${selectedIndices.length}, 成功: ${successCount}`);
}

runBatch().catch(err => {
  console.error("💥 预料之外的致命错误:", err);
  process.exit(1);
});
