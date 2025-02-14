import { body, param } from 'express-validator';

export const groupValidators = {
    // 创建组的验证规则
    create: [
        body('groupType').isString().notEmpty(),
        body('description').optional().isString(),
        body('metadata').optional().isObject()
    ],

    // 获取组的验证规则
    getGroup: [
        param('groupType').isString().notEmpty()
    ],

    // 更新组的验证规则
    updateGroup: [
        param('groupType').isString().notEmpty(),
        body('description').optional().isString(),
        body('status').optional().isIn(['active', 'inactive']),
        body('metadata').optional().isObject()
    ],

    // 删除组的验证规则
    deleteGroup: [
        param('groupType').isString().notEmpty()
    ]
}; 