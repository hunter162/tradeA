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
    async pinFileToIPFS(formData) {
        try {
            logger.info('Starting file upload to IPFS');

            const response = await axios.post(
                'https://api.pinata.cloud/pinning/pinFileToIPFS',
                formData,
                {
                    headers: {
                        'Authorization': `Bearer ${this.jwt}`,
                        ...formData.getHeaders()
                    },
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity
                }
            );

            logger.info('File successfully uploaded to IPFS:', {
                ipfsHash: response.data.IpfsHash,
                pinSize: response.data.PinSize
            });

            return response.data;
        } catch (error) {
            logger.error('Failed to upload file to IPFS:', {
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }
    async uploadFile(file) {
        try {
            // 1. 详细的验证和日志记录
            logger.info('开始验证文件对象:', {
                hasFile: !!file,
                fileDetails: file ? {
                    path: file.path,
                    originalname: file.originalname,
                    mimetype: file.mimetype,
                    size: file.size
                } : null
            });

            // 2. 基础验证
            if (!file || typeof file !== 'object') {
                throw new Error('没有提供文件对象');
            }

            // 3. 完整性验证
            const requiredFields = ['path', 'originalname', 'mimetype', 'size'];
            const missingFields = requiredFields.filter(field => !file[field]);

            if (missingFields.length > 0) {
                logger.error('文件对象验证失败:', {
                    providedFields: Object.keys(file),
                    missingFields,
                    fileDetails: JSON.stringify(file)
                });
                throw new Error(`文件对象缺少必要字段: ${missingFields.join(', ')}`);
            }

            logger.info('准备上传文件:', {
                filename: file.originalname,
                mimetype: file.mimetype,
                size: file.size,
                path: file.path
            });

            // 4. 文件存在性验证
            try {
                await fsPromises.access(file.path);
            } catch (error) {
                throw new Error(`文件不存在: ${file.path}`);
            }

            // 5. 创建文件流
            const fileStream = fs.createReadStream(file.path);

            // 6. 创建 FormData 实例
            const pinataFormData = new FormData();

            // 7. 添加文件到 FormData
            pinataFormData.append('file', fileStream, {
                filepath: file.originalname,    // 使用原始文件名
                contentType: file.mimetype,     // 设置正确的 content type
                knownLength: file.size         // 如果可能，提供文件大小
            });

            // 8. 添加元数据
            const metadata = JSON.stringify({
                name: file.originalname || `File ${Date.now()}`,
                keyvalues: {
                    originalName: file.originalname,
                    mimetype: file.mimetype,
                    size: file.size,
                    timestamp: new Date().toISOString(),
                    source: 'uploadFile'
                }
            });
            pinataFormData.append('pinataMetadata', metadata);

            // 9. 添加 Pinata 选项
            const pinataOptions = JSON.stringify({
                cidVersion: 1,
                wrapWithDirectory: false,
                customPinPolicy: {
                    regions: [
                        {
                            id: 'FRA1',
                            desiredReplicationCount: 1
                        },
                        {
                            id: 'NYC1',
                            desiredReplicationCount: 1
                        }
                    ]
                }
            });
            pinataFormData.append('pinataOptions', pinataOptions);

            // 10. 发送请求到 Pinata
            const response = await axios.post(
                'https://api.pinata.cloud/pinning/pinFileToIPFS',
                pinataFormData,
                {
                    headers: {
                        'Authorization': `Bearer ${this.jwt}`,
                        ...pinataFormData.getHeaders()
                    },
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity,
                    timeout: 60000 // 60 秒超时
                }
            );

            // 11. 记录成功信息
            logger.info('文件上传成功:', {
                filename: file.originalname,
                ipfsHash: response.data.IpfsHash,
                pinSize: response.data.PinSize,
                timestamp: response.data.Timestamp
            });

            // 12. 返回结果
            return {
                success: true,
                IpfsHash: response.data.IpfsHash,
                url: `https://gateway.pinata.cloud/ipfs/${response.data.IpfsHash}`,
                pinSize: response.data.PinSize,
                timestamp: response.data.Timestamp
            };

        } catch (error) {
            // 13. 错误处理和日志记录
            logger.error('Pinata 上传失败:', {
                message: error.message,
                stack: error.stack,
                filename: file?.originalname,
                fileDetails: file ? {
                    path: file.path,
                    mimetype: file.mimetype,
                    size: file.size
                } : 'No file'
            });

            // 14. 重新抛出错误
            throw error;
        } finally {
            // 15. 清理工作：关闭文件流等
            try {
                if (file?.path) {
                    // 注意：某些场景下可能不想删除原文件，这取决于你的需求
                    // await fsPromises.unlink(file.path);
                    logger.debug('文件处理完成:', { path: file.path });
                }
            } catch (cleanupError) {
                logger.warn('清理文件时出错:', {
                    error: cleanupError.message,
                    path: file?.path
                });
            }
        }
    }
} 