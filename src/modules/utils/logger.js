import winston from 'winston';
import path from 'path';
import fs from 'fs';

// 确保日志目录存在
const LOG_DIR = path.join(process.cwd(), 'logs');
const SOLANA_LOG_DIR = path.join(LOG_DIR, 'solana');

// 创建日志目录
[LOG_DIR, SOLANA_LOG_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// 自定义日志格式
const logFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
);

// 创建 Solana 专用日志记录器
const solanaLogger = winston.createLogger({
    format: logFormat,
    transports: [
        // Solana RPC 调用日志
        new winston.transports.File({
            filename: path.join(SOLANA_LOG_DIR, 'rpc.log'),
            level: 'debug',
            maxsize: 5242880, // 5MB
            maxFiles: 5,
            tailable: true
        }),
        // Solana 交易模拟日志
        new winston.transports.File({
            filename: path.join(SOLANA_LOG_DIR, 'simulation.log'),
            level: 'debug',
            maxsize: 5242880,
            maxFiles: 5,
            tailable: true
        }),
        // 错误日志
        new winston.transports.File({
            filename: path.join(SOLANA_LOG_DIR, 'error.log'),
            level: 'error',
            maxsize: 5242880,
            maxFiles: 5,
            tailable: true
        }),
        // 控制台输出
        new winston.transports.Console({
            level: 'info',
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ]
});

// 添加日志分类方法
const logToFile = (type, level, message, meta = {}) => {
    const logData = {
        type,
        message,
        ...meta,
        timestamp: new Date().toISOString()
    };

    switch (type) {
        case 'rpc':
            solanaLogger.transports[0].write(logData);
            break;
        case 'simulation':
            solanaLogger.transports[1].write(logData);
            break;
        case 'error':
            solanaLogger.transports[2].write(logData);
            break;
        default:
            solanaLogger.log(level, message, meta);
    }
};

// 创建 Logger 类包装 winston
export class Logger {
    constructor(name = 'App') {
        this.name = name;
        this.logger = solanaLogger;
    }

    info(message, data) {
        this.logger.info(message, { ...data, name: this.name });
    }

    error(message, data) {
        this.logger.error(message, { ...data, name: this.name });
    }

    warn(message, data) {
        this.logger.warn(message, { ...data, name: this.name });
    }

    debug(message, data) {
        this.logger.debug(message, { ...data, name: this.name });
    }

    rpc(message, data) {
        logToFile('rpc', 'info', message, { ...data, name: this.name });
    }

    simulation(message, data) {
        logToFile('simulation', 'info', message, { ...data, name: this.name });
    }
}

// 创建默认实例
export const logger = new Logger(); 