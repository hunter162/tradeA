import db from '../../modules/db/index.js';
import { logger } from '../../modules/utils/index.js';

export class GroupController {
    constructor(walletService) {
        if (!walletService) {
            throw new Error('WalletService is required');
        }
        this.walletService = walletService;
    }

    // 创建组
    async createGroup(req, res) {
        try {
            const { groupType, description } = req.body;
            
            logger.info('创建组请求:', {
                groupType,
                description
            });

            const result = await this.walletService.createGroup(groupType, description);
            
            res.json({
                success: true,
                data: result
            });
        } catch (error) {
            logger.error('创建组失败:', {
                error: error.message,
                groupType: req.body.groupType
            });
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }

    // 获取组信息
    async getGroup(req, res) {
        try {
            const { groupType } = req.params;
            const group = await this.walletService.getGroup(groupType);
            res.json({
                success: true,
                data: group
            });
        } catch (error) {
            logger.error('获取组信息失败:', error);
            res.status(404).json({
                success: false,
                error: error.message
            });
        }
    }
    async getBasicGroupInfo(req, res) {
        try {
            const { groupType } = req.params;

            logger.info('获取组基本信息请求:', {
                groupType,
                requestId: req.id
            });

            const info = await this.walletService.getBasicGroupInfo(groupType);

            res.json({
                success: true,
                data: info
            });
        } catch (error) {
            logger.error('获取组基本信息失败:', {
                error: error.message,
                groupType: req.params.groupType,
                requestId: req.id
            });

            res.status(error.message.includes('not found') ? 404 : 500).json({
                success: false,
                error: error.message
            });
        }
    }

    // 获取所有组
    async getAllGroups(req, res) {
        try {
            const groups = await this.walletService.getAllGroups();
            res.json({
                success: true,
                data: groups
            });
        } catch (error) {
            logger.error('获取所有组失败:', error);
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }

    // 更新组
    async updateGroup(req, res) {
        try {
            const { groupType } = req.params;
            const updates = req.body;
            const result = await this.walletService.updateGroup(groupType, updates);
            res.json({
                success: true,
                data: result
            });
        } catch (error) {
            logger.error('更新组失败:', error);
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }

    // 删除组
    async deleteGroup(req, res) {
        try {
            const { groupType } = req.params;
            const result = await this.walletService.deleteGroup(groupType);
            res.json({
                success: true,
                data: result
            });
        } catch (error) {
            logger.error('删除组失败:', error);
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }

    // 获取组统计信息
    async getGroupStats(req, res) {
        try {
            const { groupType } = req.params;
            const stats = await this.walletService.getGroupStats(groupType);
            res.json({
                success: true,
                data: stats
            });
        } catch (error) {
            logger.error('获取组统计信息失败:', error);
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }
} 