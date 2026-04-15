/**
 * daily_slide.js
 *
 * 批量任务自动化入口脚本（无需交互）。
 * 从 daily_input_json/input.json 同步任务，每次取最多 N 个任务执行
 * notebook → source → slide 三个阶段，支持断点续传和失败重试。
 *
 * 用法:
 *   node daily_slide.js
 *   node daily_slide.js --prompt "用英文生成slide" --batch 5 --language en
 */

const { execSync } = require('child_process');
const path = require('path');
const taskQueue = require('./task_queue');
const logger = require('./logger');

// ─────────────────────────────────────────────
// 配置
// ─────────────────────────────────────────────

const DEFAULT_PROMPT = '用哆啦A梦漫画的格式, 生成详细的slide';
// const DEFAULT_PROMPT = '用中文, 生成详细的slide';
const DEFAULT_LANGUAGE = 'zh-CN';  // BCP-47：简体中文。nlm v0.5.17+ 支持 --language
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_DELAY_MIN_SEC = 3;
const DEFAULT_DELAY_MAX_SEC = 7;

// nlm 安装在 ~/.local/bin/，不在系统 PATH 中
const NLM = `${process.env.HOME}/.local/bin/nlm`;

const INPUT_JSON_PATH = path.join(__dirname, 'daily_input_json', 'input.json');

// ─────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────

/** 解析命令行参数，支持 --key value 格式 */
function parseArgs() {
    const args = process.argv.slice(2);
    const result = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('--') && i + 1 < args.length) {
            const key = args[i].slice(2);
            result[key] = args[i + 1];
            i++;
        }
    }
    return result;
}

/** 随机延迟（毫秒） */
function getRandomDelay(minSec = DEFAULT_DELAY_MIN_SEC, maxSec = DEFAULT_DELAY_MAX_SEC) {
    return Math.floor(Math.random() * (maxSec - minSec + 1) + minSec) * 1000;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 提取 Notebook ID（含连字符的长字母数字字符串） */
function extractNotebookId(output) {
    if (!output) return null;
    const match = output.match(/[a-zA-Z0-9_-]{15,}/);
    return match ? match[0] : null;
}

/** 执行 CLI 命令，返回 { success, output, error, exitCode } */
function runCLI(command, inheritStdio = false, timeoutSec = 300, stdinData = null) {
    logger.info(`   >>> 运行命令: ${command}`);
    try {
        const options = { encoding: 'utf-8', timeout: timeoutSec * 1000 };
        if (inheritStdio) {
            options.stdio = 'inherit';
        } else {
            options.stdio = ['ignore', 'pipe', 'pipe'];
            if (stdinData) {
                options.input = stdinData; // 通过 stdin 传入数据（如 "y\n" 确认交互提示）
            }
        }
        const output = execSync(command, options);
        const result = output ? output.trim() : '';
        if (!inheritStdio && result) {
            logger.info(`   <<< 执行结果:\n${result.split('\n').map(l => '       ' + l).join('\n')}`);
        } else if (!inheritStdio) {
            logger.info(`   <<< 执行结果: (空)`);
        }
        return { success: true, output: result, exitCode: 0 };
    } catch (err) {
        const stdout = err.stdout ? err.stdout.toString().trim() : '';
        const stderr = err.stderr ? err.stderr.toString().trim() : '';
        const exitCode = err.status || 0;
        // 综合所有错误信息来源用于后续判断
        const errorOutput = stderr || stdout || err.message;
        if (!inheritStdio && stdout) {
            logger.info(`   <<< 标准输出:\n${stdout.split('\n').map(l => '       ' + l).join('\n')}`);
        }
        if (stderr) {
            logger.error(`   <<< 错误输出:\n${stderr.split('\n').map(l => '       ' + l).join('\n')}`);
        } else if (!inheritStdio && !stdout) {
            // 将原始 Error 对象传入，logger 会自动附加 stack
            logger.error(`   <<< 命令执行异常:`, err);
        }
        return { success: false, output: stdout, error: errorOutput, exitCode };
    }
}

/**
 * 检查错误是否是由于 NotebookLM API 返回错误码 142 导致。
 * 错误码 142 表示资源不可用或临时性错误，应该跳过而不是标记为失败。
 * @param {string} errorOutput - 错误输出字符串
 * @param {number} exitCode - 进程退出码
 * @returns {boolean}
 */
function isErrorCode142(errorOutput, exitCode) {
    if (!errorOutput) return false;
    // 错误码 142 可能出现在多种格式的错误消息中
    // 例如: "Error 142", "error_code: 142", "[142]", "code 142" 等
    return /\b142\b/.test(errorOutput) || exitCode === 142;
}

// ─────────────────────────────────────────────
// 阶段执行函数
// ─────────────────────────────────────────────

/**
 * 阶段 1：创建 Notebook
 * @returns {{ notebookId: string|null, exitCode: number, errorOutput: string }}
 */
function runPhaseNotebook(task) {
    logger.info(`\n   [Phase 1/3: notebook] 正在创建新 Notebook...`);
    const res = runCLI(`${NLM} notebook create`);
    if (!res.success) {
        return { notebookId: null, exitCode: res.exitCode, errorOutput: res.error };
    }

    const notebookId = extractNotebookId(res.output);
    if (!notebookId) {
        logger.error(`   ⚠️ 无法从输出中提取 Notebook ID，原始输出: ${res.output || '(空)'}`);
        return { notebookId: null, exitCode: 1, errorOutput: '无法提取 Notebook ID' };
    }
    logger.info(`   ✅ Notebook 创建成功，ID: ${notebookId}`);
    return { notebookId, exitCode: 0, errorOutput: '' };
}

/**
 * 阶段 2：导入 URL 作为 Source
 * @returns {{ ok: boolean, exitCode: number, errorOutput: string }}
 */
function runPhaseSource(task) {
    logger.info(`\n   [Phase 2/3: source] 正在导入 URL 为 source，等待解析完毕...`);
    const res = runCLI(`${NLM} source add ${task.notebookId} --url "${task.url}" --wait`, true);
    if (!res.success) {
        return { ok: false, exitCode: res.exitCode, errorOutput: res.error };
    }
    logger.info(`   ✅ URL 导入完成！`);
    return { ok: true, exitCode: 0, errorOutput: '' };
}

/**
 * 阶段 3：生成 Slide
 * @param {object} task - 任务对象
 * @param {string} focusPrompt - 提示词
 * @param {string} language - BCP-47 语言码（如 zh-CN、en）
 * @returns {{ ok: boolean, exitCode: number, errorOutput: string }}
 */
function runPhaseSlide(task, focusPrompt, language) {
    logger.info(`\n   [Phase 3/3: slide] 正在发起 Slide 生成请求（语言: ${language}, 提示词: "${focusPrompt}"）...`);
    const escapedPrompt = focusPrompt.replace(/"/g, '\\"');
    // 使用 --confirm：跳过交互确认，且不等 slide 生成完成（API 返回"已开始"即返回）
    const command = `${NLM} slides create ${task.notebookId} --language ${language} --focus "${escapedPrompt}" --confirm`;
    const res = runCLI(command, false);
    if (!res.success) {
        return { ok: false, exitCode: res.exitCode, errorOutput: res.error };
    }
    logger.info(`   ✅ Slide 生成成功！`);
    return { ok: true, exitCode: 0, errorOutput: '' };
}

// ─────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────

async function main() {
    logger.divider();
    logger.info('🗓️  NotebookLM Daily Slide 批量生成脚本');
    logger.divider();
    logger.info(`📄 日志文件: ${logger.logFilePath}`);

    // 解析参数
    const args = parseArgs();
    const focusPrompt = (args.prompt || DEFAULT_PROMPT).trim();
    const batchSize = parseInt(args.batch || DEFAULT_BATCH_SIZE, 10);
    const language = (args.language || DEFAULT_LANGUAGE).trim();

    logger.info(`⚙️  配置: batch=${batchSize}, language=${language}, prompt="${focusPrompt}"`);
    logger.info(`⚙️  nlm 路径: ${NLM}`);

    // ── 阶段一：同步输入 JSON ──────────────────────
    logger.info('\n--- 阶段一: 同步输入文件 ---\n');
    let syncResult;
    try {
        syncResult = taskQueue.syncFromInputJson(INPUT_JSON_PATH);
        logger.info(`✅ 同步完成: 新增 ${syncResult.added} 个任务，跳过 ${syncResult.skipped} 个已有任务`);
    } catch (e) {
        logger.error('❌ 同步输入文件失败:', e);
        process.exit(1);
    }

    // ── 阶段二：取批次任务 ─────────────────────────
    logger.info('\n--- 阶段二: 获取待处理任务 ---\n');
    const batch = taskQueue.getNextBatch(batchSize);

    if (batch.length === 0) {
        logger.info('✅ 当前没有待处理的任务（全部完成或已放弃）。');
        taskQueue.printSummary();
        return;
    }

    logger.info(`📋 本批次共 ${batch.length} 个任务：`);
    batch.forEach((t, i) => {
        const titleShort = t.title ? t.title.slice(0, 40) + (t.title.length > 40 ? '...' : '') : t.url;
        logger.info(`   ${i + 1}. [${t.phase}/${t.status}] ${titleShort}`);
    });

    // ── 阶段三：逐任务执行 ─────────────────────────
    logger.info('\n--- 阶段三: 开始执行任务 ---\n');

    let successCount = 0;
    let failedCount = 0;

    for (let i = 0; i < batch.length; i++) {
        // 每次从队列重新加载最新状态（防止写入竞争）
        const queue = taskQueue.loadQueue();
        const task = queue[batch[i].url];

        if (!task) {
            logger.warn(`⚠️ 任务不存在，跳过: ${batch[i].url}`);
            continue;
        }

        const taskNum = i + 1;
        const titleShort = task.title ? task.title.slice(0, 50) : task.url;
        logger.divider('-');
        logger.info(`▶️  [任务 ${taskNum}/${batch.length}] ${titleShort}`);
        logger.info(`   URL: ${task.url}`);
        logger.info(`   当前状态: phase=${task.phase}, status=${task.status}, failCount=${task.failCount}`);

        let taskFailed = false;

        // ── Phase: notebook ──────────────────────────
        if (task.phase === 'notebook') {
            const result = runPhaseNotebook(task);
            if (!result.notebookId) {
                // 检查是否是错误码 142：跳过此任务，不记录失败
                if (isErrorCode142(result.errorOutput, result.exitCode)) {
                    logger.warn(`   ⚠️ Notebook 创建遇到错误码 142（资源不可用），跳过此任务，继续下一个`);
                    continue;
                }
                const fc = taskQueue.markFailed(task.url);
                taskFailed = true;
                logger.error(`   ⚠️ Notebook 创建失败 (累计失败 ${fc} 次${fc >= taskQueue.MAX_RETRY ? '，已放弃' : '，下次重试'})`);
            } else {
                taskQueue.markNotebookCreated(task.url, result.notebookId);
                task.notebookId = result.notebookId; // 本地更新，下面的步骤会用到
                task.phase = 'source';
                task.status = 'pending';
            }
        }

        // ── Phase: source ────────────────────────────
        if (!taskFailed && task.phase === 'source') {
            const result = runPhaseSource(task);
            if (!result.ok) {
                // 检查是否是错误码 142：跳过此任务，不记录失败
                if (isErrorCode142(result.errorOutput, result.exitCode)) {
                    logger.warn(`   ⚠️ Source 导入遇到错误码 142（资源不可用），跳过此任务，继续下一个`);
                    continue;
                }
                const fc = taskQueue.markFailed(task.url);
                taskFailed = true;
                logger.error(`   ⚠️ Source 导入失败 (累计失败 ${fc} 次${fc >= taskQueue.MAX_RETRY ? '，已放弃' : '，下次重试'})`);
            } else {
                taskQueue.markSourceImported(task.url);
                task.phase = 'slide';
                task.status = 'pending';
            }
        }

        // ── Phase: slide ─────────────────────────────
        if (!taskFailed && task.phase === 'slide') {
            const result = runPhaseSlide(task, focusPrompt, language);
            if (!result.ok) {
                // 检查是否是错误码 142 或 8：跳过此任务，不记录失败（限流或资源不可用，下次重试）
                if (isErrorCode142(result.errorOutput, result.exitCode) || /\bcode[,\s]+8\b/.test(result.errorOutput)) {
                    logger.warn(`   ⚠️ Slide 生成遇到错误码 ${/\bcode[,\s]+8\b/.test(result.errorOutput) ? '8（限流）' : '142（资源不可用）'}，跳过此任务，继续下一个`);
                    continue;
                }
                const fc = taskQueue.markFailed(task.url);
                taskFailed = true;
                logger.error(`   ⚠️ Slide 生成失败 (累计失败 ${fc} 次${fc >= taskQueue.MAX_RETRY ? '，已放弃' : '，下次重试'})`);
            } else {
                taskQueue.markSlideCreated(task.url);
            }
        }

        if (taskFailed) {
            failedCount++;
        } else {
            successCount++;
            logger.info(`\n   🎉 [任务 ${taskNum}/${batch.length}] 完成！Slide 已生成，等待下载。`);
        }

        // 任务之间随机等待，防止被风控
        if (i < batch.length - 1) {
            const delayMs = getRandomDelay();
            logger.info(`\n   😴 随机等待 ${(delayMs / 1000).toFixed(1)} 秒，准备执行下一个任务...`);
            await sleep(delayMs);
        }
    }

    // ── 汇总 ──────────────────────────────────────
    logger.divider();
    logger.info(`📊 本批次执行完毕: ✅ 成功 ${successCount} 个 / ❌ 失败 ${failedCount} 个`);
    logger.divider();
    taskQueue.printSummary();
    logger.info(`📄 完整日志: ${logger.logFilePath}`);
}

main().catch(err => {
    logger.error('\n💥 发生未预期的脚本异常:', err);
    process.exit(1);
});
