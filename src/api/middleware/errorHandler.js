import { logger } from '../../modules/utils/index.js';

export const errorHandler = (err, req, res, next) => {
    logger.error('API错误:', err);
    
    res.status(err.status || 500).json({
        success: false,
        error: err.message || '服务器内部错误'
    });
}; 