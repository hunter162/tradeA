import { Router } from 'express';
import { SolanaController } from '../controllers/index.js';
import { validateRequest } from '../middleware/validator.js';
import multer from 'multer';
import path from 'path';
import { logger } from '../../modules/utils/index.js';
import express from 'express';
import { body, validationResult } from 'express-validator';
import { SolanaServiceError, handleError, asyncHandler } from '../../modules/utils/errors.js';
import { solanaValidators } from '../middleware/solanaValidator.js';
import { ErrorCodes } from '../../constants/errorCodes.js';

const router = Router();

// 使用中间件来获取服务实例
const getController = (req, res, next) => {
    const { solanaService } = req.app.locals.services;
    req.solanaController = new SolanaController(solanaService);
    next();
};

// 配置文件上传
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/') // 确保这个目录存在
    },
    filename: function (req, file, cb) {
        cb(null, `${Date.now()}-${file.originalname}`)
    }
});

const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 5 * 1024 * 1024 // 限制 5MB
    }
});

// 获取连接状态
router.get('/status', 
    getController,
    (req, res) => req.solanaController.getConnectionStatus(req, res)
);

// 获取当前节点信息
router.get('/endpoint', 
    getController,
    (req, res) => req.solanaController.getCurrentEndpoint(req, res)
);

// 切换节点
router.post('/switch-endpoint',
    getController,
    (req, res) => req.solanaController.switchEndpoint(req, res)
);

// SPL 代币余额
router.get('/tokens/:mintAddress/:ownerAddress/balance', async (req, res) => {
    await req.solanaController.getSPLBalance(req, res);
});

// 创建代币
router.post('/tokens/create', 
    getController,
    validateRequest,
    async (req, res) => {
        await req.solanaController.createToken(req, res);
    }
);

// 买入代币
router.post('/tokens/buy',
    getController,
    validateRequest,
    async (req, res) => {
        await req.solanaController.buyTokens(req, res);
    }
);

// 卖出代币
router.post('/tokens/sell',
    getController,
    validateRequest,
    async (req, res) => {
        await req.solanaController.sellTokens(req, res);
    }
);

// 获取绑定曲线
router.get('/tokens/:mintAddress/curve', async (req, res) => {
    await req.solanaController.getBondingCurve(req, res);
});

// 获取全局状态
router.get('/state', async (req, res) => {
    await req.solanaController.getGlobalState(req, res);
});

// 等待交易确认
router.get('/transactions/:signature/confirm', async (req, res) => {
    await req.solanaController.waitForTransaction(req, res);
});

// 上传文件到本地并同步到 IPFS
router.post('/upload', 
    getController,
    upload.single('file'), 
    async (req, res) => {
        await req.solanaController.uploadFile(req, res);
    }
);

// 创建代币验证规则
const createTokenValidation = [
    body('groupType').isString().notEmpty(),
    body('accountNumber').isInt({ min: 1 }),
    body('metadata').isObject(),
    body('metadata.name').isString().notEmpty(),
    body('metadata.symbol').isString().notEmpty(),
    body('metadata.uri').optional().isString(),
    body('metadata.image').optional().isString(),
    body('metadata.description').optional().isString(),
    body('metadata.external_url').optional().isString(),
    body('metadata.attributes').optional().isArray(),
    body('solAmount').isFloat({ min: 0.000001 }),
    body('slippageBasisPoints').optional().isInt({ min: 0, max: 1000 })
];

// 创建并购买代币
router.post('/tokens/create-and-buy',
    async (req, res) => {
        try {
            const {
                groupType,
                accountNumber,
                metadata,
                solAmount,
                slippageBasisPoints = 100,
                usePriorityFee = false,
                priorityFeeSol
            } = req.body;

            logger.info('创建代币请求:', {
                groupType,
                accountNumber,
                metadata,
                solAmount,
                slippageBasisPoints
            });

            // 参数验证
            if (!groupType || !accountNumber || !metadata || !solAmount) {
                throw new Error('Missing required parameters');
            }

            if (!metadata.name || !metadata.symbol) {
                throw new Error('Token metadata must include name and symbol');
            }

            const { solanaService } = req.app.locals.services;

            // 构造正确的参数对象
            const params = {
                groupType,
                accountNumber,
                metadata: {
                    name: metadata.name,
                    symbol: metadata.symbol,
                    description: metadata.description || '',
                    image: metadata.image || '',
                    external_url: metadata.external_url || '',
                    attributes: metadata.attributes || []
                },
                solAmount: parseFloat(solAmount),
                options: {
                    slippageBasisPoints: parseInt(slippageBasisPoints),
                    usePriorityFee,
                    priorityFeeSol: priorityFeeSol ? parseFloat(priorityFeeSol) : undefined
                }
            };

            const result = await solanaService.createAndBuy(params);

            res.json({
                success: true,
                data: result
            });
        } catch (error) {
            logger.error('创建和购买代币失败:', {
                error: error.message,
                groupType: req.body.groupType,
                accountNumber: req.body.accountNumber,
                metadata: req.body.metadata
            });
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }
);

// 获取代币信息
router.get('/tokens/:mint', async (req, res) => {
    try {
        // 从 app.locals 获取服务实例
        const { solanaService } = req.app.locals.services;
        
        const { mint } = req.params;
        const tokenInfo = await solanaService.getTokenInfo(mint);
        res.json({
            success: true,
            data: tokenInfo
        });
    } catch (error) {
        handleError(error, res);
    }
});

// 上传代币图片
router.post('/tokens/upload-image', 
    getController,
    upload.single('image'),
    async (req, res) => {
        await req.solanaController.uploadTokenImage(req, res);
    }
);

// 创建代币元数据
router.post('/tokens/metadata',
    getController,
    validateRequest,
    async (req, res) => {
        await req.solanaController.createTokenMetadata(req, res);
    }
);

export function createSolanaRoutes(solanaController) {
    // 获取网络状态
    router.get('/status',
        asyncHandler(async (req, res) => {
            await solanaController.getNetworkStatus(req, res);
        })
    );

    // 获取账户信息
    router.get('/account/:publicKey',
        solanaValidators.getAccount,
        validateRequest,
        asyncHandler(async (req, res) => {
            await solanaController.getAccountInfo(req, res);
        })
    );

    // 获取交易信息
    router.get('/transaction/:signature',
        solanaValidators.getTransaction,
        validateRequest,
        asyncHandler(async (req, res) => {
            await solanaController.getTransaction(req, res);
        })
    );

    // 获取代币信息
    router.get('/token/:mintAddress',
        solanaValidators.getToken,
        validateRequest,
        asyncHandler(async (req, res) => {
            await solanaController.getTokenInfo(req, res);
        })
    );

    return router;
}

export default router; 