const { execSync } = require('child_process');

function runCommand(command, options = {}) {
  try {
    return execSync(command, { stdio: 'pipe', encoding: 'utf-8', ...options }).trim();
  } catch (error) {
    return null;
  }
}

function checkCommandExists(command) {
  // Use 'command -v' which is standard in POSIX shells
  return runCommand(`command -v ${command}`) !== null;
}

function main() {
  console.log('🔍 正在检测 nlm 命令是否存在...');
  
  if (checkCommandExists('nlm')) {
    console.log('✅ nlm 已经安装！');
    const versionInfo = runCommand('nlm --version') || runCommand('nlm --help | head -n 1');
    console.log(`ℹ️ 版本/帮助信息: ${versionInfo}`);
    return;
  }

  console.log('❌ 未找到 nlm 命令。');
  console.log('⏳ 准备使用 uv 进行安装...');

  // 检测 uv 是否已安装
  if (!checkCommandExists('uv')) {
    console.error('❌ 未检测到 uv 命令。请先安装 uv 包管理器。');
    console.error('👉 参考安装 uv: https://docs.astral.sh/uv/getting-started/installation/');
    process.exit(1);
  }

  try {
    // 执行安装命令
    console.log('\n⚙️ 正在执行: uv tool install notebooklm-mcp-cli');
    execSync('uv tool install notebooklm-mcp-cli', { stdio: 'inherit' });
    console.log('\n✅ 安装命令执行完毕。');
  } catch (error) {
    console.error('❌ 安装失败！');
    console.error(error.message);
    process.exit(1);
  }

  // 验证安装结果
  console.log('🔍 正在验证安装结果...');
  
  // uv tool install 会将可执行文件放到用户目录下的 bin 文件夹 (如 ~/.local/bin)
  // 此时当前进程的 PATH 环境变量可能还没更新，我们尝试在使用 command -v 检测
  if (checkCommandExists('nlm')) {
    console.log('🎉 安装验证成功：nlm 命令已可用！');
    const versionInfo = runCommand('nlm --version') || runCommand('nlm --help | head -n 1');
    console.log(`ℹ️ nlm 信息: ${versionInfo}`);
  } else {
    console.warn('⚠️ 安装过程没有报错，但是在当前环境的 PATH 中仍未找到 nlm命令。');
    console.warn('👉 这通常是因为包含 uv 工具的目录（如 ~/.cargo/bin 或 ~/.local/bin）尚未添加到你的 PATH 中，或者你需要重启终端以使环境变量生效。');
    
    // 尝试找一下可能的常规路径
    const homeDir = require('os').homedir();
    const possiblePaths = [
      `${homeDir}/.local/bin/nlm`,
      `${homeDir}/.cargo/bin/nlm`
    ];
    
    for (const p of possiblePaths) {
      const fs = require('fs');
      if (fs.existsSync(p)) {
        console.log(`✅ 找到了 nlm 的执行文件路径: ${p}`);
        console.log(`👉 你可以直接使用 ${p}，或者将 ${require('path').dirname(p)} 添加到你的环境变量 PATH 中。`);
        break;
      }
    }
  }
}

main();
