import pinataSDK from '@pinata/sdk';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import FormData from 'form-data';
import axios from 'axios';
import { logger } from '../utils/index.js';

export class PinataService {
    constructor(apiKey, apiSecret, jwt) {
        if (!apiKey || !apiSecret || !jwt) {
            logger.error('Pinata credentials missing:', {
                hasApiKey: !!apiKey,
                hasApiSecret: !!apiSecret,
                hasJwt: !!jwt
            });
            throw new Error('Pinata credentials are required');
        }

        logger.info('Initializing Pinata service with credentials:', {
            hasApiKey: !!apiKey,
            hasApiSecret: !!apiSecret,
            hasJwt: !!jwt
        });

        // 初始化 Pinata SDK
        this.pinata = new pinataSDK({ 
            pinataApiKey: apiKey, 
            pinataSecretApiKey: apiSecret,
            pinataJWTKey: jwt 
        });
        
        this.jwt = jwt;  // 保存 JWT 供后续使用
        
        logger.info('Pinata service initialized');
    }

    async uploadImage(imagePath) {
        try {
            logger.info('开始上传图片到 Pinata', { imagePath });
            
            const imageBuffer = await fsPromises.readFile(imagePath);
            
            const formData = new FormData();
            formData.append('file', imageBuffer, {
                filename: 'token-image.jpg',
                contentType: 'image/jpeg',
            });

            const metadata = JSON.stringify({
                name: 'Token Image',
                keyvalues: {
                    timestamp: new Date().toISOString(),
                }
            });
            formData.append('pinataMetadata', metadata);

            // 使用 JWT 认证
            const headers = {
                'Authorization': `Bearer ${this.jwt}`
            };

            const response = await axios.post(
                'https://api.pinata.cloud/pinning/pinFileToIPFS',
                formData,
                {
                    headers: {
                        'Content-Type': `multipart/form-data; boundary=${formData._boundary}`,
                        ...headers
                    },
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity
                }
            );

            logger.info('图片上传成功', {
                ipfsHash: response.data.IpfsHash,
                pinSize: response.data.PinSize,
                timestamp: response.data.Timestamp
            });

            return {
                success: true,
                imageUrl: `https://gateway.pinata.cloud/ipfs/${response.data.IpfsHash}`,
                ipfsHash: response.data.IpfsHash,
                data: response.data
            };
        } catch (error) {
            logger.error('上传图片到 Pinata 失败', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async testAuthentication() {
        try {
            const result = await this.pinata.testAuthentication();
            logger.info('Pinata 认证测试成功', result);
            return true;
        } catch (error) {
            logger.error('Pinata 认证测试失败', error);
            return false;
        }
    }

    async getPinList() {
        try {
            const result = await this.pinata.pinList();
            logger.info('获取 Pin 列表成功', {
                count: result.count,
                rows: result.rows.length
            });
            return result;
        } catch (error) {
            logger.error('获取 Pin 列表失败', error);
            throw error;
        }
    }

    async uploadJSON(jsonData) {
        try {
            const response = await this.pinata.pinJSONToIPFS(jsonData, {
                pinataMetadata: {
                    name: `Token Metadata ${Date.now()}`
                }
            });

            return {
                success: true,
                url: `https://gateway.pinata.cloud/ipfs/${response.IpfsHash}`,
                hash: response.IpfsHash
            };
        } catch (error) {
            logger.error('上传 JSON 到 IPFS 失败', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async uploadFile(file) {
        try {
            if (!file || !file.path) {
                throw new Error('Invalid file object');
            }

            logger.info('准备上传文件:', {
                filename: file.originalname,
                mimetype: file.mimetype,
                size: file.size
            });

            // 使用普通版本的 fs.createReadStream
            const fileStream = fs.createReadStream(file.path);

            // 创建新的 FormData 实例
            const pinataFormData = new FormData();
            pinataFormData.append('file', fileStream, {
                filename: file.originalname,
                contentType: file.mimetype
            });

            // 添加元数据
            const metadata = JSON.stringify({
                name: file.originalname || `Token Image ${Date.now()}`,
                keyvalues: {
                    originalName: file.originalname,
                    mimetype: file.mimetype,
                    size: file.size,
                    timestamp: new Date().toISOString()
                }
            });
            pinataFormData.append('pinataMetadata', metadata);

            // 使用 axios 发送请求
            const response = await axios.post(
                'https://api.pinata.cloud/pinning/pinFileToIPFS',
                pinataFormData,
                {
                    headers: {
                        'Authorization': `Bearer ${this.jwt}`,
                        ...pinataFormData.getHeaders()
                    },
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity
                }
            );

            logger.info('文件上传成功:', {
                filename: file.originalname,
                ipfsHash: response.data.IpfsHash
            });

            return {
                success: true,
                IpfsHash: response.data.IpfsHash,
                url: `https://gateway.pinata.cloud/ipfs/${response.data.IpfsHash}`
            };
        } catch (error) {
            logger.error('Pinata 上传失败:', {
                message: error.message,
                stack: error.stack,
                filename: file?.originalname
            });
            throw error;
        }
    }
} 