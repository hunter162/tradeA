import { DataTypes } from 'sequelize';

export default (sequelize) => {
  const TradeTask = sequelize.define('TradeTask', {
    id: {
      type: DataTypes.STRING,
      primaryKey: true
    },
    strategyId: {
      type: DataTypes.STRING,
      allowNull: false
    },
    type: {
      type: DataTypes.ENUM('buy', 'sell'),
      allowNull: false
    },
    params: {
      type: DataTypes.JSON,
      allowNull: false
    },
    status: {
      type: DataTypes.ENUM('pending', 'processing', 'completed', 'failed'),
      defaultValue: 'pending'
    },
    result: {
      type: DataTypes.JSON,
      allowNull: true
    },
    retryCount: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    error: {
      type: DataTypes.TEXT,
      allowNull: true
    }
  }, {
    tableName: 'trade_tasks',
    timestamps: true,
    indexes: [
      {
        fields: ['strategyId']
      },
      {
        fields: ['status']
      }
    ]
  });

  return TradeTask;
}; 