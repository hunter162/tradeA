import { Keypair } from '@solana/web3.js';

class CustomAnchorWallet {
    constructor(keypair = Keypair.generate()) {
        this.keypair = keypair;
    }

    get publicKey() {
        return this.keypair.publicKey;
    }

    async signTransaction(tx) {
        tx.partialSign(this.keypair);
        return tx;
    }

    async signAllTransactions(txs) {
        txs.forEach(tx => tx.partialSign(this.keypair));
        return txs;
    }

    // Required by Anchor
    get payer() {
        return this.keypair;
    }
}

export default CustomAnchorWallet;