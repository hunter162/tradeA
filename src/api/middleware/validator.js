export const validateRequest = (req, res, next) => {
    // 基础验证逻辑
    if (!req.body) {
        return res.status(400).json({
            success: false,
            error: '无效的请求数据'
        });
    }
    next();
}; 