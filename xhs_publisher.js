require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();

chromium.use(stealth);

const USER_DATA_DIR = path.join(__dirname, '.browser_data');

async function publishToXhs() {
  console.log("==================================================");
  console.log("小红书 Playwright(Node.js) 发布工具");
  console.log("==================================================");

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

  let workDir = '';
  let metaPath = '';

  if (argv.dir) {
    workDir = path.resolve(process.cwd(), argv.dir);
    if (!fs.existsSync(workDir)) {
      console.log(`❌ 指定的目录不存在: ${workDir}`);
      return;
    }
    metaPath = path.join(workDir, 'meta.json');
  } else {
    // 默认回退逻辑: 提取 content/ 下最新的日期文件夹
    const contentDir = path.join(__dirname, 'content');
    if (!fs.existsSync(contentDir)) {
      console.log("❌ 没有找到 content 目录，也没有提供 --dir 参数。");
      return;
    }

    const folders = fs.readdirSync(contentDir).filter(f => fs.statSync(path.join(contentDir, f)).isDirectory());
    const dates = folders.sort();
    if (dates.length === 0) {
      console.log("❌ content 目录下没有找到任何日期文件夹。");
      return;
    }

    const latestDate = dates[dates.length - 1];
    workDir = path.join(contentDir, latestDate);
    metaPath = path.join(workDir, 'meta.json');
  }

  let data = { title: "", content: "", tags: [] };
  if (fs.existsSync(metaPath)) {
    try {
      data = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch (e) {
      console.log(`⚠️ 无法解析 ${metaPath}:`, e.message);
    }
  }

  // 覆盖 CLI 参数
  if (argv.title) data.title = argv.title;
  if (argv.desc) data.content = argv.desc;
  
  if (!data.title) {
    console.log("❌ 没有提供帖子标题。请通过 meta.json 或者传入 --title 参数设定标题。");
    return;
  }

  // 收集工作区内的有效图片
  const imagePaths = [];
  const files = fs.readdirSync(workDir);
  // 按自然顺序尝试收集 1.png, 2.png 或者直接按找的顺序全部加入
  const imgFiles = files.filter(f => /\.(png|jpe?g)$/i.test(f)).sort((a, b) => {
    // 尝试识别数字前缀排序
    const numA = parseInt(a.match(/^\d+/)?.[0]) || 0;
    const numB = parseInt(b.match(/^\d+/)?.[0]) || 0;
    return numA - numB || a.localeCompare(b);
  });

  for (const f of imgFiles) {
    // 限制单贴做多18张图(小红书极限)，代码里只取前18即可
    if (imagePaths.length >= 18) break; 
    imagePaths.push(path.resolve(workDir, f));
  }

  if (imagePaths.length === 0) {
    console.log(`❌ 在 ${workDir} 内未找到任何图片文件 (*.png, *.jpg)。`);
    return;
  }

  console.log(`\n📂 工作目录: ${workDir}`);
  console.log(`📝 标题: ${data.title}`);
  console.log(`🖼️  图片: ${imagePaths.length} 张`);
  console.log("==================================================");

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

      await page.waitForTimeout(2000);
      try {
        await page.waitForURL("**/publish/**", { timeout: 300000 });
        console.log("✅ 登录成功！");
      } catch (err) {
        console.log("❌ 等待登录超时或手动打断！");
        throw err;
      }
    }

    await page.waitForTimeout(2000);

    console.log("\n📤 正在上传图片...");

    try {
      const imageTab = page.locator('text=发布图文, text=图文, [class*="image"]').first();
      if ((await imageTab.count()) > 0) {
        await imageTab.click({ force: true });
        await page.waitForTimeout(1000);
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
          await page.waitForTimeout(2000);
        } catch (e) {
          console.log(`   图片 ${i + 1} 上传失败: ${e.message}`);
        }
      }
    }

    console.log("   等待图片处理...");
    await page.waitForTimeout(5000);

    console.log("📝 正在填写标题...");
    let titleInput = page.locator('input[placeholder*="标题"], input[class*="title"], #title').first();
    if ((await titleInput.count()) > 0) {
      await titleInput.fill(data.title.substring(0, 20));
    } else {
      titleInput = page.locator('[class*="title"] input, [data-testid="title"]').first();
      if ((await titleInput.count()) > 0) {
        await titleInput.fill(data.title.substring(0, 20));
      }
    }

    console.log("📝 正在填写正文...");
    const descText = (data.content || '') + "\n\n" + (data.tags || []).join(" ");
    
    const descSelectors = [
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
          await descInput.fill(descText.substring(0, 1000));
          break;
        } catch (e) {}
      }
    }

    console.log("✅ 内容填写完成！");

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

        await page.waitForTimeout(2000);

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
              await page.waitForTimeout(2000);
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
        await page.waitForTimeout(2000);
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

        await page.waitForTimeout(500);
      }

      if (success) {
        console.log("🎉 发布成功！");
      } else {
        throw new Error("Timeout waiting for success signal");
      }
    } catch (err) {
      console.log(`⚠️  未检测到明确的发布成功信号: ${err.message}`);
      const screenshotPath = path.join(workDir, "publish_status_debug.png");
      await page.screenshot({ path: screenshotPath });
      console.log(`   已保存页面截图到: ${screenshotPath}`);
      console.log("   请手动检查浏览器状态");
    }

    if ((await page.locator('text=发布成功').count()) === 0) {
      console.log("\n等待几秒查看状态...");
      await page.waitForTimeout(5000);
    } else {
      await page.waitForTimeout(3000);
    }

  } catch (err) {
    console.log(`\n❌ 发布失败: ${err.message}`);
    if (!isGithubActions) {
      await page.waitForTimeout(5000);
    }
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

publishToXhs().catch(err => {
  console.error("💥 预料之外的致命错误:", err);
  process.exit(1);
});
