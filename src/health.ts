import { Anomaly, Component, Engine, EngineStatus, HealthAssessment, MaintenanceAction, MaintenanceEvent, MaintenanceSimulationOptions, MaintenanceSimulationResult, MaintenanceWindow, ModelVersion, RulPrediction, TelemetrySample } from './types.js';

const limits = { exhaustGasTemp: 760, vibration: 3.2, oilPressureMin: 3.1, fuelFlowMax: 310 };
const clamp = (value: number, min = 0, max = 100) => Math.max(min, Math.min(max, value));
const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const statusFor = (score: number): EngineStatus => score >= 85 ? 'healthy' : score >= 70 ? 'watch' : score >= 50 ? 'degraded' : 'critical';

export function validateTelemetry(samples: TelemetrySample[]): { accepted: TelemetrySample[]; rejected: TelemetrySample[]; anomalies: Anomaly[] } {
  const accepted: TelemetrySample[] = [], rejected: TelemetrySample[] = [], anomalies: Anomaly[] = [];
  let previous: TelemetrySample | undefined;
  for (const sample of [...samples].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
    const values = [sample.rpm, sample.exhaustGasTemp, sample.fuelFlow, sample.vibration, sample.oilPressure, sample.oilTemperature, sample.altitude, sample.thrust];
    if (!sample.timestamp || values.some(value => !Number.isFinite(value))) {
      rejected.push(sample); anomalies.push({ id: `AN-${anomalies.length + 1}`, engineId: sample.engineId, timestamp: sample.timestamp, type: 'range_violation', severity: 'high', message: '传感器样本包含非法数值', evidence: { cycle: sample.cycle } }); continue;
    }
    if (sample.exhaustGasTemp > limits.exhaustGasTemp || sample.fuelFlow > limits.fuelFlowMax || sample.vibration > 6 || sample.oilPressure < 1) {
      rejected.push(sample); anomalies.push({ id: `AN-${anomalies.length + 1}`, engineId: sample.engineId, timestamp: sample.timestamp, type: 'range_violation', severity: 'high', sensor: 'multi', message: '样本超出物理安全范围，已从评分中剔除', evidence: { exhaustGasTemp: sample.exhaustGasTemp, vibration: sample.vibration, oilPressure: sample.oilPressure } }); continue;
    }
    if (previous) {
      const gap = new Date(sample.timestamp).getTime() - new Date(previous.timestamp).getTime();
      if (gap > 15 * 60_000) anomalies.push({ id: `AN-${anomalies.length + 1}`, engineId: sample.engineId, timestamp: sample.timestamp, type: 'missing_interval', severity: 'medium', message: '传感器时间序列存在采样间隔缺失', evidence: { gapMinutes: round(gap / 60_000) } });
      if (Math.abs(sample.vibration - previous.vibration) > 0.65) anomalies.push({ id: `AN-${anomalies.length + 1}`, engineId: sample.engineId, timestamp: sample.timestamp, type: 'sensor_spike', severity: 'medium', sensor: 'vibration', message: '振动信号出现突变', evidence: { previous: previous.vibration, current: sample.vibration } });
    }
    accepted.push(sample); previous = sample;
  }
  return { accepted, rejected, anomalies };
}

function normalizedTemperature(sample: TelemetrySample): number { return sample.exhaustGasTemp - sample.ambientTemperature * .35 - (sample.phase === 'takeoff' ? 34 : sample.phase === 'climb' ? 20 : 0); }
function slope(values: number[]): number { if (values.length < 2) return 0; const n = values.length; const xMean = (n - 1) / 2; const yMean = values.reduce((a, b) => a + b, 0) / n; const numerator = values.reduce((sum, y, x) => sum + (x - xMean) * (y - yMean), 0); const denominator = values.reduce((sum, _, x) => sum + (x - xMean) ** 2, 0); return denominator ? numerator / denominator : 0; }

export function assessEngine(engine: Engine, samples: TelemetrySample[], model: ModelVersion, maintenanceCount = 0): HealthAssessment {
  const checked = validateTelemetry(samples); const usable = checked.accepted;
  const temps = usable.map(normalizedTemperature); const fuel = usable.map(item => item.fuelFlow / Math.max(item.thrust, 1)); const vibration = usable.map(item => item.vibration); const oil = usable.map(item => item.oilPressure);
  const temperatureRisk = clamp(((Math.max(...temps, 0) - 620) / 105) * 100); const fuelRisk = clamp(((Math.max(...fuel, 0) - 5.6) / 1.1) * 100); const vibrationRisk = clamp(((Math.max(...vibration, 0) - 1.2) / 2.2) * 100); const oilRisk = clamp(((4.6 - Math.min(...oil, 4.6)) / 1.4) * 100); const degradationSlope = slope(usable.map(item => item.vibration)) + Math.max(0, slope(temps) / 50);
  const degradationRisk = clamp(degradationSlope * 42 + maintenanceCount * 2);
  const risk = temperatureRisk * model.weights.temperature + fuelRisk * model.weights.fuel + vibrationRisk * model.weights.vibration + oilRisk * model.weights.oil + degradationRisk * model.weights.degradation;
  const healthScore = round(clamp(100 - risk)); const componentRisks: Array<[Component, number, string[]]> = [
    ['hot_section', temperatureRisk, ['排气温度裕度下降', '高温阶段的温度归一化值偏高']], ['compressor', fuelRisk, ['单位推力燃油流量上升', '工况归一化后的效率指标偏弱']], ['bearing', vibrationRisk, ['振动幅值趋势上升', '存在突变样本需要复核']], ['lubrication', oilRisk, ['滑油压力裕度降低', '建议结合传感器校准记录复核']]
  ];
  const risks = componentRisks.map(([component, componentRisk, drivers]) => ({ component, score: round(componentRisk), status: statusFor(100 - componentRisk), drivers, estimatedCyclesToLimit: Math.max(20, Math.round((100 - componentRisk) * 18)) }));
  const explanations = [`模型 ${model.label} 使用 ${usable.length} 个有效样本完成评估`, `最高温度风险 ${round(temperatureRisk)}，最高振动风险 ${round(vibrationRisk)}`, `数据质量得分 ${round(usable.length / Math.max(samples.length, 1) * 100)}，剔除 ${checked.rejected.length} 个异常样本`];
  const anomalies = [...checked.anomalies];
  if (degradationRisk > 35) anomalies.push({ id: `AN-${anomalies.length + 1}`, engineId: engine.id, timestamp: new Date().toISOString(), type: 'degradation', severity: degradationRisk > 60 ? 'high' : 'medium', message: '关键退化指标超过关注阈值', evidence: { degradationRisk: round(degradationRisk), vibrationSlope: round(slope(vibration), 4) } });
  return { assessmentId: `ASSESS-${Date.now()}`, engineId: engine.id, modelVersion: model.id, createdAt: new Date().toISOString(), sampleCount: samples.length, healthScore, status: statusFor(healthScore), dataQuality: { score: round(usable.length / Math.max(samples.length, 1) * 100), usableSamples: usable.length, rejectedSamples: checked.rejected.length, missingIntervals: checked.anomalies.filter(item => item.type === 'missing_interval').length }, indicators: { exhaustTemperatureMargin: round(limits.exhaustGasTemp - Math.max(...temps, 0)), fuelEfficiencyIndex: round(100 - fuelRisk), vibrationRisk: round(vibrationRisk), oilPressureMargin: round(Math.min(...oil, 4.6) - limits.oilPressureMin), degradationSlope: round(degradationSlope, 4) }, componentRisks: risks, anomalies, explanation: explanations };
}

export function predictRul(engine: Engine, assessment: HealthAssessment, horizonCycles: number, model: ModelVersion): RulPrediction {
  const leading = [...assessment.componentRisks].sort((a, b) => a.estimatedCyclesToLimit - b.estimatedCyclesToLimit)[0]; const base = Math.max(24, Math.min(horizonCycles, Math.round(leading.estimatedCyclesToLimit * (.82 + assessment.healthScore / 500)))); const confidence = round(clamp(55 + assessment.dataQuality.score * .35 - assessment.anomalies.length * 2, 15, 96)); const lowerBound = Math.max(1, Math.round(base * (1 - (100 - confidence) / 220))); const upperBound = Math.round(base * (1 + (100 - confidence) / 160)); const riskByHorizon = [0, .25, .5, .75, 1].map((ratio) => ({ cycle: Math.round(base * ratio), healthScore: round(Math.max(0, assessment.healthScore - ratio * (assessment.healthScore - 38))), probabilityOfMaintenance: round(clamp(.08 + ratio * ratio * .82 + (100 - confidence) / 220, 0, .99), 3) })); return { predictionId: `RUL-${Date.now()}`, engineId: engine.id, modelVersion: model.id, createdAt: new Date().toISOString(), horizonCycles, estimatedRemainingCycles: base, confidence, lowerBound, upperBound, limitingComponent: leading.component, riskByHorizon, evidence: [`${leading.component} 为当前最短部件寿命估计`, `健康评分 ${assessment.healthScore}，数据质量 ${assessment.dataQuality.score}`, `模型 ${model.label} 结合退化斜率与维修历史进行估算`] };
}

export function maintenanceWindows(prediction: RulPrediction): MaintenanceWindow[] { const start = Math.max(1, prediction.lowerBound - 25); return [{ window: '近期检查窗口', startCycle: start, endCycle: Math.max(start, prediction.lowerBound), priority: 'high', reason: `${prediction.limitingComponent} 的预测寿命下界接近` }, { window: '计划维护窗口', startCycle: prediction.lowerBound, endCycle: prediction.estimatedRemainingCycles, priority: prediction.confidence > 70 ? 'medium' : 'high', reason: '建议在下界前安排拆检或部件更换' }, { window: '延后风险窗口', startCycle: prediction.estimatedRemainingCycles, endCycle: prediction.upperBound, priority: 'critical', reason: '超过预测中位寿命后，维护概率显著上升' }]; }

const componentLabels: Record<Component, string> = { hot_section: '热端部件', compressor: '压气机', bearing: '轴承', lubrication: '滑油系统' };
const actionLabels: Record<MaintenanceAction, string> = { inspection: '检查', replacement: '更换', repair: '修复', calibration: '校准' };

// 各维护动作对风险的消减比例（上限）与对剩余寿命的延长比例（相对原始估计）
const actionEffects: Record<MaintenanceAction, { riskRelief: number; lifeExtension: number }> = {
  inspection: { riskRelief: .18, lifeExtension: 0 },
  calibration: { riskRelief: .3, lifeExtension: .08 },
  repair: { riskRelief: .55, lifeExtension: .22 },
  replacement: { riskRelief: .85, lifeExtension: .55 }
};

// 在常规三段窗口前补充“已越过安全下界”的预警窗口，所有周期均保证非负
function simulationWindows(prediction: RulPrediction, crossed: boolean, legacyFloor = false): MaintenanceWindow[] {
  // legacyFloor=true 时沿用旧版下界收敛到 1 的口径（仅兼容非越界的老请求）；
  // 越界或新接口一律收敛到 0，并显式给出越界窗口
  const floor = legacyFloor ? 1 : 0;
  const p: RulPrediction = {
    ...prediction,
    lowerBound: Math.max(floor, prediction.lowerBound),
    estimatedRemainingCycles: Math.max(floor, prediction.estimatedRemainingCycles),
    upperBound: Math.max(floor, prediction.upperBound)
  };
  let windows: MaintenanceWindow[];
  if (legacyFloor) {
    windows = maintenanceWindows(p);
  } else {
    const inspectionStart = Math.max(0, p.lowerBound - 25);
    windows = [
      { window: '近期检查窗口', startCycle: inspectionStart, endCycle: Math.max(inspectionStart, p.lowerBound), priority: 'high', reason: `${p.limitingComponent} 的预测寿命下界接近` },
      { window: '计划维护窗口', startCycle: p.lowerBound, endCycle: Math.max(p.lowerBound, p.estimatedRemainingCycles), priority: p.confidence > 70 ? 'medium' : 'high', reason: '建议在下界前安排拆检或部件更换' },
      { window: '延后风险窗口', startCycle: p.estimatedRemainingCycles, endCycle: Math.max(p.estimatedRemainingCycles, p.upperBound), priority: 'critical', reason: '超过预测中位寿命后，维护概率显著上升' }
    ];
  }
  if (crossed) {
    windows.unshift({
      window: '安全下界越界窗口',
      startCycle: 0,
      endCycle: 0,
      priority: 'critical',
      breached: true,
      reason: p.estimatedRemainingCycles === floor
        ? '延后已耗尽预测寿命：当前时点已晚于安全维护下界，必须立即处置'
        : `延后越过 ${componentLabels[p.limitingComponent]} 的安全维护下界，须立即安排相关维护`
    });
  }
  return windows;
}

/**
 * 只读维护推演：在 RUL 预测之上叠加延后周期、目标部件与维护动作，
 * 结合该发动机的维护历史修正收益，返回调整后的风险、维护窗口与建议。
 * 不修改预测、评估或维护历史中的任何对象。
 */
export function simulateMaintenance(engineId: string, prediction: RulPrediction, options: MaintenanceSimulationOptions = {}): MaintenanceSimulationResult {
  const delay = Math.max(0, Math.round(Number.isFinite(options.delayCycles) ? Number(options.delayCycles) : 0));
  const component = options.component;
  const action = options.action;
  const history = (options.history ?? []).filter(event => event.engineId === engineId);
  const basis: string[] = [];

  // 延后造成的基线增量风险：与旧版 delayCycles 接口口径一致，便于规划员横向比较
  const delayRisk = Math.min(100, Math.round(delay / Math.max(prediction.estimatedRemainingCycles, 1) * 100));

  if (!component || !action) {
    const crossed = delay > prediction.lowerBound;
    const shifted: RulPrediction = {
      ...prediction,
      lowerBound: prediction.lowerBound - delay,
      estimatedRemainingCycles: prediction.estimatedRemainingCycles - delay,
      upperBound: prediction.upperBound - delay
    };
    return {
      engineId,
      delayCycles: delay,
      safetyLowerBoundCrossed: crossed,
      windows: simulationWindows(shifted, crossed, true),
      impact: {
        additionalRisk: delayRisk,
        // 保留旧版文案，兼容只传 delayCycles 的老客户端
        recommendation: crossed ? '延后超过寿命下界，不建议执行' : '当前延后仍在可评估范围内'
      }
    };
  }

  const componentHistory = history.filter(event => event.component === component);
  const replacements = componentHistory.filter(event => event.action === 'replacement');
  const repairs = componentHistory.filter(event => event.action === 'repair');
  const sameActionCount = componentHistory.filter(event => event.action === action).length;

  // 目标部件是否为当前寿命瓶颈：非瓶颈部件的处置收益按比例折算
  const isLimiting = component === prediction.limitingComponent;
  const targetingFactor = isLimiting ? 1 : .35;

  // 维护历史折扣：近期刚换过再做类似处置收益递减；历史记录缺失时提示证据不足
  let historyFactor = 1;
  if (replacements.length > 0) {
    const lastReplacedAt = Math.max(...replacements.map(event => new Date(event.occurredAt).getTime()));
    const daysSinceReplace = Math.max(0, (Date.now() - lastReplacedAt) / 86_400_000);
    if (daysSinceReplace < 180) {
      historyFactor *= .5;
      basis.push(`${componentLabels[component]}在 ${Math.round(daysSinceReplace)} 天前刚完成更换，重复处置收益折半`);
    }
  }
  if (repairs.length >= 2 && action === 'repair') {
    historyFactor *= .7;
    basis.push(`${componentLabels[component]}历史上已修复 ${repairs.length} 次，建议优先选择更换而非继续修复`);
  }
  if (sameActionCount > 0) basis.push(`该部件已有 ${sameActionCount} 次${actionLabels[action]}记录，本次为重复动作`);
  if (componentHistory.length === 0) basis.push(`${componentLabels[component]}暂无维护历史，推演置信度有限，建议先安排检查确认`);
  basis.push(isLimiting
    ? `${componentLabels[component]}是当前寿命瓶颈，处置可直接改善 RUL`
    : `${componentLabels[component]}不是当前寿命瓶颈（瓶颈为${componentLabels[prediction.limitingComponent]}），处置收益已折算`);

  const effect = actionEffects[action];
  const riskReduction = Math.round(delayRisk * effect.riskRelief * targetingFactor * historyFactor);
  const extensionCycles = Math.round(prediction.estimatedRemainingCycles * effect.lifeExtension * targetingFactor * historyFactor);

  const remaining = Math.max(0, prediction.estimatedRemainingCycles - delay + extensionCycles);
  const lowerBound = Math.max(0, prediction.lowerBound - delay + extensionCycles);
  const upperBound = Math.max(0, prediction.upperBound - delay + extensionCycles);
  const netAdditionalRisk = clamp(delayRisk - riskReduction);
  const crossed = delay - extensionCycles > prediction.lowerBound;

  const adjustedPrediction: RulPrediction = { ...prediction, estimatedRemainingCycles: remaining, lowerBound, upperBound };
  const windows = simulationWindows(adjustedPrediction, crossed);

  const recommendationParts = [
    crossed
      ? `延后 ${delay} 循环已越过安全下界（${prediction.lowerBound} 循环），即便执行${actionLabels[action]}仍不能恢复到安全区间，须立即停场处置`
      : `${actionLabels[action]}${componentLabels[component]}后预计消减增量风险 ${riskReduction} 点、延长寿命约 ${extensionCycles} 循环，可接受的延后上限为 ${Math.max(0, prediction.lowerBound + extensionCycles)} 循环`,
    netAdditionalRisk >= 40 ? '净增量风险偏高，建议前移维护窗口' : '净增量风险可控，可按计划窗口安排'
  ];
  if (!isLimiting) recommendationParts.push(`优先关注寿命瓶颈${componentLabels[prediction.limitingComponent]}`);

  return {
    engineId,
    delayCycles: delay,
    component,
    action,
    safetyLowerBoundCrossed: crossed,
    windows,
    adjusted: {
      estimatedRemainingCycles: remaining,
      lowerBound: Math.round(lowerBound),
      upperBound: Math.round(upperBound),
      extensionCycles,
      riskReduction,
      netAdditionalRisk
    },
    impact: { additionalRisk: netAdditionalRisk, recommendation: recommendationParts.join('；') },
    basis
  };
}
