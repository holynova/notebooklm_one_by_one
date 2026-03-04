const { spawnSync } = require('child_process');
const path = require('path');

async function main() {
  console.log('🌟 [脚本入口]: 自动化 NotebookLM 任务即将开始...');
  
  // 1. 先执行环境检查脚本，挂载在同一个终端使其能接收交互输入
  console.log('\n--- 阶段一: 环境和授权验证 ---\n');
  const checkProcess = spawnSync('node', [path.join(__dirname, 'check_env.js')], { stdio: 'inherit' });
  
  if (checkProcess.status !== 0) {
    console.error('\n🛑 环境检查未通过或被中断，退出主程序！');
    process.exit(1);
  }

  // 2. 环境检查通过后，执行生成 Slide 的业务脚本
  console.log('\n--- 阶段二: 执行核心任务 (Slide生成) ---\n');
  const slideProcess = spawnSync('node', [path.join(__dirname, 'auto_slide.js')], { stdio: 'inherit' });

  if (slideProcess.status !== 0) {
    console.error('\n🛑 阶段二 (Slide 生成) 发生意外异常或被强制终止！');
    process.exit(1);
  }

  console.log('\n🌟 [脚本入口]: 所有任务流程已顺利结束。');
}

main().catch(err => {
  console.error('\n💥 启动主流程时遭遇致命错误:', err.message);
  process.exit(1);
});
