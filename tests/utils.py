from solana.rpc.api import Client
from solana.keypair import Keypair
import base58
import os

def create_test_keypair():
    """
    创建测试用的密钥对
    """
    return Keypair()

def get_balance(client: Client, public_key: str):
    """
    获取账户余额
    """
    response = client.get_balance(public_key)
    if "result" in response:
        return response["result"]["value"]
    return 0

def wait_for_confirmation(client: Client, signature: str, max_retries: int = 30):
    """
    等待交易确认
    """
    for _ in range(max_retries):
        response = client.confirm_transaction(signature)
        if response["result"]:
            return True
    return False 