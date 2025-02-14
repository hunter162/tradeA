export const solanaUtils = {
    // SOL 转 lamports
    solToLamports(solAmount) {
        return Math.floor(parseFloat(solAmount) * LAMPORTS_PER_SOL);
    },

    // lamports 转 SOL
    lamportsToSol(lamports) {
        return lamports / LAMPORTS_PER_SOL;
    },

    // 格式化 SOL 显示
    formatSol(solAmount) {
        return solAmount.toFixed(9);
    },

    // 检查余额是否足够
    hasEnoughBalance(balanceInSol, requiredSol, includeFee = true) {
        const fee = includeFee ? 0.000005 : 0; // 5000 lamports
        return parseFloat(balanceInSol) >= (parseFloat(requiredSol) + fee);
    }
}; 