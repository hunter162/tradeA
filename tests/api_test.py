import requests
import json
from datetime import datetime
import time
import logging
import os
from typing import Dict, Any, Optional

# 配置日志
def setup_logging():
    # 创建 logs 目录
    if not os.path.exists('logs'):
        os.makedirs('logs')
    
    # 配置日志格式
    log_format = '%(asctime)s - %(levelname)s - %(message)s'
    logging.basicConfig(
        level=logging.INFO,
        format=log_format,
        handlers=[
            logging.FileHandler(f'logs/api_test_{datetime.now().strftime("%Y%m%d_%H%M%S")}.log'),
            logging.StreamHandler()
        ]
    )
    return logging.getLogger(__name__)

class SolanaApiTest:
    """Solana API 测试类
    
    用于测试所有 API 端点的功能和性能
    
    Attributes:
        base_url: API 基础 URL
        headers: 请求头
        logger: 日志记录器
    """

    def __init__(self, base_url="http://localhost:3000/api/v1"):
        self.base_url = base_url
        self.headers = {
            'Content-Type': 'application/json'
        }
        self.logger = setup_logging()
        self.test_data = {
            'token_address': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',  # USDC
            'test_group': 'test_group',
            'test_amount_sol': 0.001
        }

    def log_request_details(self, method: str, endpoint: str, data: Optional[Dict] = None) -> None:
        """记录请求详情"""
        self.logger.info(f"\n{'='*20} 请求详情 {'='*20}")
        self.logger.info(f"方法: {method}")
        self.logger.info(f"端点: {endpoint}")
        if data:
            self.logger.info(f"请求数据: {json.dumps(data, indent=2, ensure_ascii=False)}")

    def log_response_details(self, response: requests.Response) -> None:
        """记录响应详情"""
        self.logger.info(f"\n{'='*20} 响应详情 {'='*20}")
        self.logger.info(f"状态码: {response.status_code}")
        self.logger.info(f"响应时间: {response.elapsed.total_seconds():.3f}秒")
        try:
            response_data = response.json()
            self.logger.info(f"响应数据: {json.dumps(response_data, indent=2, ensure_ascii=False)}")
        except Exception as e:
            self.logger.error(f"解析响应数据失败: {str(e)}")
            self.logger.info(f"原始响应: {response.text}")

    def make_request(self, method: str, endpoint: str, data: Optional[Dict] = None) -> requests.Response:
        """发送请求并处理响应"""
        url = f"{self.base_url}{endpoint}"
        self.log_request_details(method, endpoint, data)
        
        try:
            if method == 'GET':
                response = requests.get(url, headers=self.headers)
            elif method == 'POST':
                response = requests.post(url, json=data, headers=self.headers)
            else:
                raise ValueError(f"Unsupported method: {method}")
            
            self.log_response_details(response)
            return response
        except Exception as e:
            self.logger.error(f"请求失败: {str(e)}")
            raise

    def test_wallet_apis(self):
        """测试钱包相关 API
        
        测试端点:
        1. POST /wallets - 创建钱包
        2. GET /wallets/{group}/{account} - 获取钱包信息
        3. GET /wallets/{group}/{account}/balance - 获取余额
        4. POST /wallets/batch - 批量创建钱包
        """
        self.logger.info("\n开始测试钱包相关 API...")

        # 1. 创建钱包
        create_wallet_data = {
            "groupType": self.test_data['test_group'],
            "accountNumber": 1,
            "description": "测试钱包"  # 可选参数
        }
        self.make_request('POST', '/wallets', create_wallet_data)

        # 2. 获取钱包信息
        self.make_request('GET', f"/wallets/{self.test_data['test_group']}/1")

        # 3. 获取钱包余额
        self.make_request('GET', f"/wallets/{self.test_data['test_group']}/1/balance")

        # 4. 批量创建钱包
        batch_create_data = {
            "groupType": self.test_data['test_group'],
            "startNumber": 2,
            "count": 3,
            "description": "批量测试钱包"  # 可选参数
        }
        self.make_request('POST', '/wallets/batch', batch_create_data)

    def test_transaction_apis(self):
        """测试交易相关 API
        
        测试端点:
        1. POST /transactions/transfer - 单笔转账
        2. POST /transactions/batch-transfer - 批量转账
        3. GET /transactions/{group}/{account}/history - 获取交易历史
        """
        self.logger.info("\n开始测试交易相关 API...")

        # 1. 单笔转账
        transfer_data = {
            "fromGroup": self.test_data['test_group'],
            "fromAccount": 1,
            "toGroup": self.test_data['test_group'],
            "toAccount": 2,
            "amount": self.test_data['test_amount_sol'],
            "memo": "测试转账"  # 可选参数
        }
        self.make_request('POST', '/transactions/transfer', transfer_data)

        # 2. 批量转账
        batch_transfer_data = {
            "fromGroup": self.test_data['test_group'],
            "fromAccount": 1,
            "transfers": [
                {
                    "toGroup": self.test_data['test_group'],
                    "toAccount": 2,
                    "amount": self.test_data['test_amount_sol'],
                    "memo": "批量转账1"
                },
                {
                    "toGroup": self.test_data['test_group'],
                    "toAccount": 3,
                    "amount": self.test_data['test_amount_sol'],
                    "memo": "批量转账2"
                }
            ]
        }
        self.make_request('POST', '/transactions/batch-transfer', batch_transfer_data)

        # 3. 获取交易历史
        self.make_request('GET', f"/transactions/{self.test_data['test_group']}/1/history")

    def test_trade_apis(self):
        """测试交易相关 API
        
        测试端点:
        1. POST /trade/buy - 买入代币
        2. POST /trade/sell - 卖出代币
        3. GET /trade/price/{token} - 获取代币价格
        """
        self.logger.info("\n开始测试交易相关 API...")

        # 1. 买入代币
        buy_data = {
            "groupType": self.test_data['test_group'],
            "accountNumber": 1,
            "tokenAddress": self.test_data['token_address'],
            "amountSol": self.test_data['test_amount_sol'],
            "slippage": 1.0,
            "options": {
                "deadline": 60,
                "usePriorityFee": True
            }
        }
        self.make_request('POST', '/trade/buy', buy_data)

        # 2. 卖出代币
        sell_data = {
            "groupType": self.test_data['test_group'],
            "accountNumber": 1,
            "tokenAddress": self.test_data['token_address'],
            "percentage": 50,  # 卖出 50%
            "options": {
                "deadline": 60,
                "usePriorityFee": True
            }
        }
        self.make_request('POST', '/trade/sell', sell_data)

        # 3. 获取代币价格
        self.make_request('GET', f"/trade/price/{self.test_data['token_address']}")

    def test_solana_apis(self):
        print("\n开始测试 Solana 相关 API...")

        # 1. 获取 RPC 状态
        response = requests.get(f"{self.base_url}/solana/rpc/status", headers=self.headers)
        self.log_response(response)

        # 2. 获取全局状态
        response = requests.get(f"{self.base_url}/solana/state", headers=self.headers)
        self.log_response(response)

    def run_all_tests(self):
        """运行所有测试"""
        self.logger.info(f"开始全面 API 测试 - {datetime.now()}")
        
        try:
            # 1. 钱包测试
            self.test_wallet_apis()
            time.sleep(1)
            
            # 2. 交易测试
            self.test_transaction_apis()
            time.sleep(1)
            
            # 3. 交易测试
            self.test_trade_apis()
            
            self.logger.info(f"\n测试完成 - {datetime.now()}")
        except Exception as e:
            self.logger.error(f"测试过程中出现错误: {str(e)}", exc_info=True)

def main():
    """主函数"""
    # 可以通过环境变量配置测试参数
    base_url = os.getenv('API_BASE_URL', 'http://localhost:3000/api/v1')
    
    # 创建测试实例
    tester = SolanaApiTest(base_url=base_url)
    
    # 运行所有测试
    tester.run_all_tests()

if __name__ == "__main__":
    main() 