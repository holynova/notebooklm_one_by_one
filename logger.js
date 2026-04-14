/**
 * logger.js
 *
 * 轻量日志模块：同时输出到控制台和本地日志文件。
 * 日志文件路径：daily_logs/YYYY-MM-DD_HH-mm-ss.log
 *
 * 用法：
 *   const logger = require('./logger');
 *   logger.info('消息');
 *   logger.error('出错了', err);   // err 可为 Error 对象，会打印 stack
 */

const fs   = require('fs');
const path = require('path');

// ─────────────────────────────────────────────
// 日志文件初始化
// ─────────────────────────────────────────────

const LOG_DIR = path.join(__dirname, 'daily_logs');

/** 生成 YYYY-MM-DD_HH-mm-ss 格式的时间字符串 */
function formatDateForFilename(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
           `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

// 每次进程启动时创建一个新日志文件
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}
const LOG_FILE = path.join(LOG_DIR, `${formatDateForFilename(new Date())}.log`);

// ─────────────────────────────────────────────
// 核心写入
// ─────────────────────────────────────────────

/** 格式化当前时间戳，用于每行日志前缀 */
function timestamp() {
    return new Date().toISOString().replace('T', ' ').substring(0, 23);
}

/**
 * 将一行写入日志文件（追加模式，带时间戳前缀）
 * @param {string} level - INFO / WARN / ERROR
 * @param {string} msg
 */
function writeToFile(level, msg) {
    const line = `[${timestamp()}] [${level}] ${msg}\n`;
    try {
        fs.appendFileSync(LOG_FILE, line, 'utf-8');
    } catch (e) {
        // 写文件失败时只打印到 stderr，不影响主流程
        process.stderr.write(`[logger] 写日志失败: ${e.message}\n`);
    }
}

/**
 * 序列化 Error 对象为可读字符串（包含 stack）
 * @param {any} err
 * @returns {string}
 */
function serializeError(err) {
    if (!err) return '';
    if (err instanceof Error) {
        // stack 包含 message，无需重复
        return `\n  ↳ ${err.stack || err.message}`;
    }
    if (typeof err === 'object') {
        try { return `\n  ↳ ${JSON.stringify(err)}`; } catch { /* ignore */ }
    }
    return `\n  ↳ ${String(err)}`;
}

// ─────────────────────────────────────────────
// 公开 API（镜像 console 风格）
// ─────────────────────────────────────────────

/**
 * 普通信息日志
 * @param {...any} args
 */
function info(...args) {
    const msg = args.map(String).join(' ');
    console.log(msg);
    writeToFile('INFO', msg);
}

/**
 * 警告日志
 * @param {...any} args
 */
function warn(...args) {
    const msg = args.map(String).join(' ');
    console.warn(msg);
    writeToFile('WARN', msg);
}

/**
 * 错误日志 —— 最后一个参数若为 Error，自动附加 stack
 * @param {...any} args  最后一个可以是 Error 对象
 */
function error(...args) {
    // 检查最后一个参数是否为 Error/object（错误附加信息）
    let errObj = null;
    let parts  = args;
    if (args.length > 0) {
        const last = args[args.length - 1];
        if (last instanceof Error || (last && typeof last === 'object' && !(typeof last === 'string'))) {
            errObj = last;
            parts  = args.slice(0, -1);
        }
    }

    const msg     = parts.map(String).join(' ');
    const errStr  = serializeError(errObj);
    const fullMsg = msg + errStr;

    console.error(fullMsg);
    writeToFile('ERROR', fullMsg);
}

/**
 * 分隔线（方便日志视觉分区）
 * @param {string} [char='=']
 * @param {number} [len=45]
 */
function divider(char = '=', len = 45) {
    const line = char.repeat(len);
    console.log(line);
    writeToFile('INFO', line);
}

// ─────────────────────────────────────────────
// 导出
// ─────────────────────────────────────────────

module.exports = {
    info,
    warn,
    error,
    divider,
    /** 日志文件的绝对路径（供启动时打印） */
    logFilePath: LOG_FILE,
};
