import { initializeDatabase } from '../src/modules/db/connection.js';
import { logger } from '../src/modules/utils/index.js';

async function main() {
    try {
        logger.info('开始初始化数据库...');
        await initializeDatabase();
        logger.info('数据库初始化完成');
        process.exit(0);
    } catch (error) {
        logger.error('数据库初始化失败:', error);
        process.exit(1);
    }
}

main(); 