const { execSync, spawnSync } = require('child_process');
const readline = require('readline');

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

// 运行命令，返回 stdout 或 null
function runCommand(command, options = {}) {
  try {
    return execSync(command, { stdio: 'pipe', encoding: 'utf-8', ...options }).trim();
  } catch (error) {
    return null;
  }
}

// 检测命令是否存在
function checkCommandExists(command) {
  return runCommand(`command -v ${command}`) !== null;
}

// 检查是否登录 (通过调用 nlm notebook list 测试)
function checkIsLoggedIn() {
  try {
    execSync('nlm notebook list', { stdio: 'pipe', encoding: 'utf-8' });
    return true; // 没有抛错代表已登录
  } catch (err) {
    return false; // 抛错通常表示未登录
  }
}

async function main() {
  console.log('=============================================');
  console.log('🔍 正在进行 NotebookLM 环境检查...');
  console.log('=============================================\n');

  // 1. 检查是否安装 nlm
  process.stdout.write('   📝 检查 nlm 命令是否安装... ');
  let isInstalled = checkCommandExists('nlm');
  
  if (isInstalled) {
    console.log('✅ 已安装');
  } else {
    console.log('❌ 未找到');
    const ans = await askQuestion('\n   ❓ nlm CLI 未安装，是否需要帮您自动安装？(Y/n): ');
    if (ans.trim().toUpperCase() !== 'N') {
      console.log('   ⚙️ 正在启动安装脚本...\n');
      try {
        // 由于安装脚本 install_nlm.js 本身提供了安装逻辑，直接调用它
        spawnSync('node', ['install_nlm.js'], { stdio: 'inherit' });
        
        // 再次检查确认
        isInstalled = checkCommandExists('nlm');
        if (!isInstalled) {
          console.log('\n   ⚠️ 安装流程已结束，但在当前环境中依然找不到 nlm。这可能是因为环境变量 PATH 未更新。');
          console.log('   ⏭️ 请尝试重启终端后再次运行本脚本。');
          process.exit(1);
        }
      } catch (e) {
        console.error('\n   ❌ 调用安装脚本失败：', e.message);
        process.exit(1);
      }
    } else {
      console.log('   🛑 您取消了自动安装，请手动安装后重试。');
      process.exit(1);
    }
  }

  // 2. 检查是否已登录
  process.stdout.write('   📝 检查 nlm 是否已登录验证... ');
  let isLoggedIn = checkIsLoggedIn();

  if (isLoggedIn) {
    console.log('✅ 已登录');
  } else {
    console.log('❌ 未登录或授权失效');
    const ans = await askQuestion('\n   ❓ nlm CLI 尚未登录，是否现在帮您打开登录引导？(Y/n): ');
    if (ans.trim().toUpperCase() !== 'N') {
      console.log('   ⚙️ 正在启动登录授权向导，请根据浏览器提示完成操作...\n');
      try {
        // nlm login 是交互式的，会打开浏览器
        spawnSync('nlm', ['login'], { stdio: 'inherit' });
        
        // 再次检查是否登录成功
        isLoggedIn = checkIsLoggedIn();
        if (!isLoggedIn) {
          console.log('\n   ❌ 登录并没有成功完成，请检查授权流程是否被取消。');
          process.exit(1);
        } else {
          console.log('\n   ✅ 欧耶！登录与授权环境验证通过！');
        }
      } catch (e) {
        console.error('\n   ❌ 启动登录命令失败：', e.message);
        process.exit(1);
      }
    } else {
      console.log('   🛑 您取消了登录引导，由于没有授权脚本无法继续执行。');
      process.exit(1);
    }
  }

  console.log('\n=============================================');
  console.log('🎉 环境检查全部通过，准备就绪！');
  console.log('=============================================\n');
  rl.close();
}

main().catch((e) => {
  console.error('\\n💥 环境检查时遭遇意外错误:', e);
  process.exit(1);
});
