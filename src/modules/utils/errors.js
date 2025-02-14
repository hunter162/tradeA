import { ErrorCodes, ErrorMessages } from '../../constants/errorCodes.js';
import { logger } from './index.js';

// 自定义错误类
export class CustomError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'CustomError';
    }

    toJSON() {
        return {
            code: this.code,
            message: this.message,
            name: this.name
        };
    }
}

// 特定的 Solana 服务错误类
export class SolanaServiceError extends CustomError {
    constructor(code, details = null) {
        super(code, ErrorMessages[code] || '未知错误');
        this.details = details;
        this.name = 'SolanaServiceError';
    }

    toJSON() {
        return {
            ...super.toJSON(),
            details: this.details
        };
    }
}

// 统一的错误处理函数
export function handleError(error) {
    if (error instanceof CustomError) {
        return {
            success: false,
            code: error.code,
            error: error.message
        };
    }

    // 记录未知错误
    logger.error('未知错误:', {
        error: error.message,
        stack: error.stack,
        name: error.name
    });

    // 返回通用错误响应
    return {
        success: false,
        code: 1000, // 通用错误码
        error: error.message,
        details: {
            originalError: error.message,
            stack: error.stack
        }
    };
}

// 用于包装异步路由处理函数
export const asyncHandler = (fn) => async (req, res, next) => {
    try {
        await fn(req, res, next);
    } catch (error) {
        const response = handleError(error);
        res.status(error instanceof CustomError ? 400 : 500).json(response);
    }
};

// 错误处理中间件
export const errorHandler = (err, req, res, next) => {
    logger.error('全局错误处理:', {
        error: err.message,
        stack: err.stack,
        path: req.path,
        method: req.method
    });

    const response = handleError(err);
    res.status(err instanceof CustomError ? 400 : 500).json(response);
};

// 重新导出错误码，方便其他模块使用
export { ErrorCodes }; 