import { Router } from 'express';
import { asyncHandler } from '../../modules/utils/errors.js';
import { transferValidators } from '../middleware/transferValidator.js';
import { validateRequest } from '../middleware/validator.js';

export function createTransferRoutes(transferController) {
    const router = Router();

    // 一对多转账
    router.post('/one-to-many', 
        transferValidators.oneToMany,
        validateRequest,
        asyncHandler(async (req, res) => {
            await transferController.oneToMany(req, res);
        })
    );

    // 多对一转账（归集）
    router.post('/many-to-one',
        transferValidators.manyToOne,
        validateRequest,
        asyncHandler(async (req, res) => {
            await transferController.manyToOne(req, res);
        })
    );

    // 多对多转账
    router.post('/many-to-many',
        transferValidators.manyToMany,
        validateRequest,
        asyncHandler(async (req, res) => {
            await transferController.manyToMany(req, res);
        })
    );

    // 单笔转账
    router.post('/transfer',
        transferValidators.transfer,
        validateRequest,
        asyncHandler(async (req, res) => {
            await transferController.transfer(req, res);
        })
    );

    return router;
} 