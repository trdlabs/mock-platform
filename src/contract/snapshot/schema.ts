export const MANIFEST_SCHEMA = {
  $id: 'snapshot-manifest',
  type: 'object',
  additionalProperties: false,
  required: ['ref', 'createdAtMs', 'versions', 'bundleRef', 'checksumsRef'],
  properties: {
    ref: { type: 'string' },
    createdAtMs: { type: 'number' },
    bundleRef: { type: 'string' },
    checksumsRef: { type: 'string' },
    versions: {
      type: 'object',
      additionalProperties: false,
      required: [
        'snapshotSchemaVersion', 'opsReadContractVersion', 'researchReadContractVersion',
        'analysisContractVersion', 'exporterVersion', 'sourcePlatformCommit', 'redactionPolicyVersion',
      ],
      properties: {
        snapshotSchemaVersion: { type: 'string' },
        opsReadContractVersion: { type: 'string' },
        researchReadContractVersion: { type: 'string' },
        analysisContractVersion: { type: 'string' },
        exporterVersion: { type: 'string' },
        sourcePlatformCommit: { type: 'string' },
        redactionPolicyVersion: { type: 'string' },
      },
    },
  },
} as const;

const CLOSE_REASON_ENUM = [
  'take_profit_final', 'take_profit_partial', 'stop_loss', 'breakeven', 'trailing_stop',
  'signal_exit', 'time_exit', 'liquidation', 'manual', 'other', null,
] as const;

const capabilityAbsent = {
  type: 'object', additionalProperties: false, required: ['available'],
  properties: { available: { const: false }, reason: { type: 'string' } },
} as const;

export const BUNDLE_SCHEMA = {
  $id: 'snapshot-bundle',
  type: 'object',
  additionalProperties: false,
  required: [
    'runs', 'tradesByRun', 'eventsByRun', 'decisionsByRun', 'tradeEvidenceByTrade', 'runtimeHealth',
    'marketHealth', 'executionHealth', 'coverage', 'analysisByRun', 'researchByRun', 'replay',
  ],
  properties: {
    runs: { type: 'array', items: { $ref: '#/$defs/botRun' } },
    tradesByRun: { type: 'object', additionalProperties: { type: 'array', items: { $ref: '#/$defs/closedTrade' } } },
    eventsByRun: { type: 'object', additionalProperties: { type: 'array', items: { $ref: '#/$defs/event' } } },
    decisionsByRun: { type: 'object', additionalProperties: { type: 'array', items: { $ref: '#/$defs/decision' } } },
    tradeEvidenceByTrade: { type: 'object', additionalProperties: { $ref: '#/$defs/tradeEvidence' } },
    runtimeHealth: { $ref: '#/$defs/runtimeHealth' },
    marketHealth: { $ref: '#/$defs/marketHealth' },
    executionHealth: { $ref: '#/$defs/executionHealth' },
    coverage: { $ref: '#/$defs/coverage' },
    analysisByRun: { type: 'object', additionalProperties: { $ref: '#/$defs/analysis' } },
    researchByRun: { type: 'object', additionalProperties: { $ref: '#/$defs/research' } },
    replay: {
      type: 'object', additionalProperties: false, required: ['frames'],
      properties: { frames: { type: 'array', items: { $ref: '#/$defs/replayFrame' } } },
    },
    historical: { $ref: '#/$defs/historicalBundle' },
  },
  $defs: {
    capabilityAbsent,
    botRun: {
      type: 'object', additionalProperties: false,
      required: ['runId', 'mode', 'status', 'strategy', 'startedAtMs', 'finishedAtMs', 'lastSeenMs', 'symbols'],
      properties: {
        runId: { type: 'string' }, mode: { enum: ['live', 'paper', 'backtest'] },
        status: { enum: ['running', 'finished', 'crashed', 'aborted'] },
        strategy: { type: 'object', additionalProperties: false, required: ['name', 'version'],
          properties: { name: { type: 'string' }, version: { type: 'string' } } },
        startedAtMs: { type: 'number' }, finishedAtMs: { type: ['number', 'null'] },
        lastSeenMs: { type: 'number' }, symbols: { type: 'array', items: { type: 'string' } },
      },
    },
    closedTrade: {
      type: 'object', additionalProperties: false,
      required: ['tradeId', 'runId', 'symbol', 'side', 'openedAtMs', 'closedAtMs', 'entryPrice', 'exitPrice', 'realizedPnl', 'pnlPct', 'isWin', 'closeReason', 'closeReasonRaw'],
      properties: {
        tradeId: { type: 'string' }, runId: { type: 'string' }, symbol: { type: 'string' },
        side: { enum: ['long', 'short'] }, openedAtMs: { type: 'number' }, closedAtMs: { type: ['number', 'null'] },
        entryPrice: { type: ['string', 'null'] }, exitPrice: { type: ['string', 'null'] },
        realizedPnl: { type: 'string' }, pnlPct: { type: 'string' }, isWin: { type: ['boolean', 'null'] },
        closeReason: { enum: CLOSE_REASON_ENUM },
        closeReasonRaw: { type: ['string', 'null'] },
      },
    },
    tradeLifecycleEvent: {
      type: 'object', additionalProperties: false,
      required: ['tsMs', 'type', 'price', 'qty'],
      properties: {
        tsMs: { type: 'number' },
        type: { enum: ['entry', 'dca', 'tp', 'sl', 'exit', 'stop_update'] },
        price: { type: ['string', 'null'] },
        qty: { type: ['string', 'null'] },
        note: { type: ['string', 'null'] },
      },
    },
    tradeEvidence: {
      type: 'object', additionalProperties: false,
      required: ['tradeId', 'runId', 'symbol', 'side', 'openedAtMs', 'closedAtMs', 'entryPrice', 'exitPrice', 'realizedPnl', 'pnlPct', 'closeReason', 'closeReasonRaw', 'lifecycle'],
      properties: {
        tradeId: { type: 'string' }, runId: { type: 'string' }, symbol: { type: 'string' },
        side: { enum: ['long', 'short'] }, openedAtMs: { type: 'number' }, closedAtMs: { type: ['number', 'null'] },
        entryPrice: { type: ['string', 'null'] }, exitPrice: { type: ['string', 'null'] },
        realizedPnl: { type: 'string' }, pnlPct: { type: 'string' },
        closeReason: { enum: CLOSE_REASON_ENUM },
        closeReasonRaw: { type: ['string', 'null'] },
        lifecycle: { type: 'array', items: { $ref: '#/$defs/tradeLifecycleEvent' } },
      },
    },
    event: {
      type: 'object', additionalProperties: false,
      required: ['category', 'severity', 'runId', 'tradeId', 'tsMs', 'safeMessage'],
      properties: {
        category: { type: 'string' },
        severity: { anyOf: [{ enum: ['debug', 'info', 'warn', 'error', 'fatal'] }, { type: 'null' }] },
        runId: { type: 'string' }, tradeId: { type: ['string', 'null'] }, tsMs: { type: 'number' }, safeMessage: { type: 'string' },
      },
    },
    decision: {
      type: 'object', additionalProperties: false,
      required: ['category', 'runId', 'botId', 'symbol', 'side', 'reason', 'tsMs', 'safeMessage'],
      properties: {
        category: { type: 'string' }, runId: { type: 'string' }, botId: { type: 'string' }, symbol: { type: 'string' },
        side: { enum: ['long', 'short'] }, reason: { type: 'string' }, tsMs: { type: 'number' }, safeMessage: { type: 'string' },
      },
    },
    indicators: {
      type: 'object', additionalProperties: false,
      required: ['ready', 'freshnessOk', 'pipelineOk', 'serviceOk', 'botOk'],
      properties: {
        ready: { type: 'boolean' }, freshnessOk: { type: 'boolean' }, pipelineOk: { type: 'boolean' },
        serviceOk: { type: 'boolean' }, botOk: { type: 'boolean' },
      },
    },
    runtimeHealth: {
      type: 'object', additionalProperties: false, required: ['entries', 'asOf'],
      properties: {
        asOf: { type: 'number' },
        entries: { type: 'array', items: {
          type: 'object', additionalProperties: false,
          required: ['source', 'status', 'indicators', 'availability', 'capturedAtMs'],
          properties: {
            source: { type: 'string' }, status: { enum: ['ok', 'degraded', 'down'] },
            indicators: { $ref: '#/$defs/indicators' },
            availability: { enum: ['available', 'degraded', 'unavailable'] }, capturedAtMs: { type: 'number' },
          },
        } },
      },
    },
    marketHealth: {
      type: 'object', additionalProperties: false, required: ['status', 'diagnostics', 'streamAgeMs', 'availability', 'asOf'],
      properties: {
        status: { enum: ['ok', 'degraded', 'down'] }, diagnostics: { type: 'object' },
        streamAgeMs: { type: ['number', 'null'] }, availability: { enum: ['available', 'degraded', 'unavailable'] }, asOf: { type: 'number' },
      },
    },
    executionHealth: {
      type: 'object', additionalProperties: false, required: ['status', 'recentCounts', 'lastEventMs', 'availability', 'asOf'],
      properties: {
        status: { enum: ['ok', 'degraded', 'down'] }, recentCounts: { type: 'object', additionalProperties: { type: 'number' } },
        lastEventMs: { type: ['number', 'null'] }, availability: { enum: ['available', 'degraded', 'unavailable'] }, asOf: { type: 'number' },
      },
    },
    coverage: {
      type: 'object', additionalProperties: false, required: ['entries', 'availability', 'asOf'],
      properties: {
        availability: { enum: ['available', 'degraded', 'unavailable'] }, asOf: { type: 'number' },
        entries: { type: 'array', items: {
          type: 'object', additionalProperties: false, required: ['source', 'kind', 'state', 'freshnessAgeMs'],
          properties: {
            source: { type: 'string' }, kind: { enum: ['openInterest', 'liquidations', 'funding', 'taker'] },
            state: { enum: ['present', 'missing', 'stale', 'unsupported'] }, freshnessAgeMs: { type: ['number', 'null'] },
          },
        } },
      },
    },
    analysisTrade: {
      type: 'object', additionalProperties: false,
      required: ['tradeId', 'symbol', 'side', 'openedAtMs', 'closedAtMs', 'realizedPnl', 'entryReason', 'exitReason'],
      properties: {
        tradeId: { type: 'string' }, symbol: { type: 'string' }, side: { enum: ['long', 'short'] },
        openedAtMs: { type: 'number' }, closedAtMs: { type: ['number', 'null'] }, realizedPnl: { type: 'string' },
        entryReason: { type: ['string', 'null'] }, exitReason: { type: ['string', 'null'] },
      },
    },
    analysis: {
      type: 'object', additionalProperties: false,
      required: ['runRef', 'opsContractVersion', 'asOf', 'freshness', 'identity', 'period', 'healthContext',
        'metrics', 'trades', 'strategyConfig', 'dcaCount', 'slTpBeEvents', 'features', 'summaryPatterns'],
      properties: {
        runRef: { type: 'string' }, opsContractVersion: { type: 'string' }, asOf: { type: 'number' },
        freshness: { enum: ['fresh', 'stale', 'degraded'] },
        identity: {
          type: 'object', additionalProperties: false, required: ['mode', 'strategy', 'symbols'],
          properties: {
            mode: { enum: ['live', 'paper', 'backtest'] },
            strategy: { type: 'object', additionalProperties: false, required: ['name', 'version'],
              properties: { name: { type: 'string' }, version: { type: 'string' } } },
            symbols: { type: 'array', items: { type: 'string' } },
          },
        },
        period: { type: 'object', additionalProperties: false, required: ['fromMs', 'toMs'],
          properties: { fromMs: { type: 'number' }, toMs: { type: 'number' } } },
        healthContext: { type: 'string' },
        metrics: {
          type: 'object', additionalProperties: false,
          required: ['pnl', 'winRate', 'maxDrawdown', 'totalTrades', 'topTradeContributionPct'],
          properties: {
            pnl: { type: 'string' }, winRate: { type: 'number' }, maxDrawdown: { type: 'string' },
            totalTrades: { type: 'number' }, profitFactor: { type: 'string' }, topTradeContributionPct: { type: 'number' },
          },
        },
        trades: { type: 'array', items: { $ref: '#/$defs/analysisTrade' } },
        strategyConfig: { anyOf: [{ type: 'object' }, { $ref: '#/$defs/capabilityAbsent' }] },
        dcaCount: { anyOf: [{ type: 'number' }, { $ref: '#/$defs/capabilityAbsent' }] },
        slTpBeEvents: { anyOf: [
          { type: 'array', items: { type: 'object', additionalProperties: false, required: ['tradeId', 'kind', 'tsMs'],
            properties: { tradeId: { type: 'string' }, kind: { enum: ['sl', 'tp', 'be'] }, tsMs: { type: 'number' } } } },
          { $ref: '#/$defs/capabilityAbsent' },
        ] },
        features: { anyOf: [
          { type: 'object', additionalProperties: false, required: ['oi', 'liquidation', 'dump', 'bounce'],
            properties: { oi: { type: 'boolean' }, liquidation: { type: 'boolean' }, dump: { type: 'boolean' }, bounce: { type: 'boolean' } } },
          { $ref: '#/$defs/capabilityAbsent' },
        ] },
        summaryPatterns: { type: 'array', items: { type: 'string' } },
      },
    },
    research: {
      type: 'object', additionalProperties: false, required: ['summary', 'trades', 'decisions', 'analysisContext'],
      properties: {
        summary: {
          type: 'object', additionalProperties: false, required: ['runRef', 'mode', 'metrics', 'asOf'],
          properties: {
            runRef: { type: 'string' }, mode: { enum: ['live', 'paper', 'backtest'] }, asOf: { type: 'number' },
            metrics: {
              type: 'object', additionalProperties: false, required: ['netPnlUsd', 'winRate', 'maxDrawdownPct', 'sharpe', 'totalTrades'],
              properties: {
                netPnlUsd: { type: 'string' }, winRate: { type: 'number' }, maxDrawdownPct: { type: 'string' },
                profitFactor: { type: 'string' }, sharpe: { anyOf: [{ type: 'string' }, { $ref: '#/$defs/capabilityAbsent' }] }, totalTrades: { type: 'number' },
              },
            },
          },
        },
        trades: { type: 'array', items: {
          type: 'object', additionalProperties: false, required: ['tradeId', 'symbol', 'side', 'openedAtMs', 'closedAtMs', 'realizedPnl'],
          properties: { tradeId: { type: 'string' }, symbol: { type: 'string' }, side: { enum: ['long', 'short'] },
            openedAtMs: { type: 'number' }, closedAtMs: { type: ['number', 'null'] }, realizedPnl: { type: 'string' } } } },
        decisions: { type: 'array', items: {
          type: 'object', additionalProperties: false, required: ['category', 'symbol', 'reason', 'tsMs'],
          properties: { category: { type: 'string' }, symbol: { type: 'string' }, reason: { type: 'string' }, tsMs: { type: 'number' } } } },
        analysisContext: { type: 'string' },
      },
    },
    replayFrame: {
      type: 'object', additionalProperties: false, required: ['offsetMs', 'resource'],
      properties: { offsetMs: { type: 'number' }, resource: { enum: ['runs', 'runtime-health'] } },
    },
    ohlcvBar: {
      type: 'object', additionalProperties: false,
      required: ['tsMs', 'open', 'high', 'low', 'close', 'volume'],
      properties: {
        tsMs: { type: 'number' }, open: { type: 'number' }, high: { type: 'number' },
        low: { type: 'number' }, close: { type: 'number' }, volume: { type: 'number' },
      },
    },
    fundingEntry: {
      type: 'object', additionalProperties: false,
      required: ['tsMs', 'symbol', 'rate'],
      properties: { tsMs: { type: 'number' }, symbol: { type: 'string' }, rate: { type: 'number' } },
    },
    openInterestEntry: {
      type: 'object', additionalProperties: false,
      required: ['tsMs', 'symbol', 'openInterestUsd'],
      properties: { tsMs: { type: 'number' }, symbol: { type: 'string' }, openInterestUsd: { type: 'number' } },
    },
    liquidationEntry: {
      type: 'object', additionalProperties: false,
      required: ['tsMs', 'symbol', 'side', 'sizeUsd'],
      properties: {
        tsMs: { type: 'number' }, symbol: { type: 'string' },
        side: { enum: ['long', 'short'] }, sizeUsd: { type: 'number' },
      },
    },
    canonicalRowV2: {
      type: 'object', additionalProperties: false,
      required: [
        'schema_version', 'minute_ts', 'symbol', 'open', 'high', 'low', 'close', 'volume', 'turnover',
        'oi_total_usd', 'funding_rate', 'liq_long_usd', 'liq_short_usd',
        'has_oi', 'has_funding', 'has_liquidations',
        'taker_buy_volume_usd', 'taker_sell_volume_usd', 'has_taker_flow',
      ],
      properties: {
        schema_version: { type: 'number' }, minute_ts: { type: 'number' }, symbol: { type: 'string' },
        open: { type: 'number' }, high: { type: 'number' }, low: { type: 'number' },
        close: { type: 'number' }, volume: { type: 'number' }, turnover: { type: 'number' },
        oi_total_usd: { type: ['number', 'null'] }, funding_rate: { type: ['number', 'null'] },
        liq_long_usd: { type: ['number', 'null'] }, liq_short_usd: { type: ['number', 'null'] },
        has_oi: { type: 'boolean' }, has_funding: { type: 'boolean' }, has_liquidations: { type: 'boolean' },
        taker_buy_volume_usd: { type: ['number', 'null'] }, taker_sell_volume_usd: { type: ['number', 'null'] },
        has_taker_flow: { type: 'boolean' },
      },
    },
    historicalBundle: {
      type: 'object', additionalProperties: false,
      required: ['barsBySymbolAndTimeframe', 'fundingBySymbol', 'openInterestBySymbol', 'liquidationsBySymbol'],
      properties: {
        barsBySymbolAndTimeframe: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            additionalProperties: { type: 'array', items: { $ref: '#/$defs/ohlcvBar' } },
          },
        },
        fundingBySymbol: {
          type: 'object',
          additionalProperties: { type: 'array', items: { $ref: '#/$defs/fundingEntry' } },
        },
        openInterestBySymbol: {
          type: 'object',
          additionalProperties: { type: 'array', items: { $ref: '#/$defs/openInterestEntry' } },
        },
        liquidationsBySymbol: {
          type: 'object',
          additionalProperties: { type: 'array', items: { $ref: '#/$defs/liquidationEntry' } },
        },
        rowsBySymbol: {
          type: 'object',
          additionalProperties: { type: 'array', items: { $ref: '#/$defs/canonicalRowV2' } },
        },
      },
    },
  },
} as const;
