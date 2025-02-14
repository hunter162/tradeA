import { NFTStorage } from 'nft.storage';
import { logger } from '../utils.js';
import fs from 'fs/promises';

export class IPFSService {
    constructor(apiKey) {
        if (!apiKey) {
            throw new Error('NFT.Storage API key is required');
        }
        this.client = new NFTStorage({ token: apiKey });
    }

    async uploadImage(imagePath) {
        try {
            logger.info('开始上传图片到 IPFS', { imagePath });
            
            // 读取图片文件
            const imageBuffer = await fs.readFile(imagePath);
            const imageFile = new File([imageBuffer], 'image.jpg', { type: 'image/jpeg' });
            
            // 上传到 IPFS
            const metadata = await this.client.store({
                name: 'Token Image',
                description: 'Token image uploaded to IPFS',
                image: imageFile
            });

            logger.info('图片上传成功', {
                url: metadata.url,
                ipnft: metadata.ipnft,
                data: metadata.data
            });

            // 返回 IPFS URL
            const ipfsUrl = `https://ipfs.io/ipfs/${metadata.ipnft}/metadata.json`;
            return {
                success: true,
                url: ipfsUrl,
                metadata
            };
        } catch (error) {
            logger.error('上传图片到 IPFS 失败', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async uploadImageAndGetUrl(imagePath) {
        const result = await this.uploadImage(imagePath);
        if (result.success) {
            // 从元数据中提取图片 URL
            const imageUrl = result.metadata.data.image.href;
            return {
                success: true,
                imageUrl: imageUrl.replace('ipfs://', 'https://ipfs.io/ipfs/')
            };
        }
        return result;
    }
} 