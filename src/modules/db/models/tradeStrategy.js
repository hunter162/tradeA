import { DataTypes } from 'sequelize';

export default (sequelize) => {
  const TradeStrategy = sequelize.define('TradeStrategy', {
    id: {
      type: DataTypes.STRING,
      primaryKey: true
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false
    },
    type: {
      type: DataTypes.ENUM('single', 'combo'),
      allowNull: false
    },
    groupType: {
      type: DataTypes.STRING,
      allowNull: false
    },
    accountRange: {
      type: DataTypes.STRING,
      allowNull: false
    },
    token: {
      type: DataTypes.STRING,
      allowNull: false
    },
    rules: {
      type: DataTypes.JSON,
      allowNull: false
    },
    status: {
      type: DataTypes.ENUM('active', 'paused', 'completed'),
      defaultValue: 'active'
    },
    batchId: {
      type: DataTypes.STRING,
      allowNull: true
    }
  }, {
    tableName: 'trade_strategies',
    timestamps: true,
    indexes: [
      {
        fields: ['status']
      },
      {
        fields: ['nextExecutionTime']
      }
    ]
  });

  return TradeStrategy;
}; 