import { Router } from 'express';
import { asyncHandler } from '../../modules/utils/errors.js';
import { groupValidators } from '../middleware/groupValidator.js';
import { validateRequest } from '../middleware/validator.js';

export function createGroupRoutes(groupController) {
    const router = Router();

    // 创建组
    router.post('/',
        groupValidators.create,
        validateRequest,
        asyncHandler(async (req, res) => {
            await groupController.createGroup(req, res);
        })
    );

    // 获取所有组
    router.get('/',
        asyncHandler(async (req, res) => {
            await groupController.getGroups(req, res);
        })
    );

    // 获取单个组
    router.get('/:groupType',
        groupValidators.getGroup,
        validateRequest,
        asyncHandler(async (req, res) => {
            await groupController.getGroup(req, res);
        })
    );

    // 更新组
    router.put('/:groupType',
        groupValidators.updateGroup,
        validateRequest,
        asyncHandler(async (req, res) => {
            await groupController.updateGroup(req, res);
        })
    );

    // 删除组
    router.delete('/:groupType',
        groupValidators.deleteGroup,
        validateRequest,
        asyncHandler(async (req, res) => {
            await groupController.deleteGroup(req, res);
        })
    );

    return router;
} 