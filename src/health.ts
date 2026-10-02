import { Anomaly, Component, Engine, EngineStatus, HealthAssessment, MaintenanceEvent, ModelVersion, RulPrediction, TelemetrySample } from './types.js';

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

export function maintenanceWindows(prediction: RulPrediction): Array<{ window: string; startCycle: number; endCycle: number; priority: string; reason: string }> { const start = Math.max(0, prediction.lowerBound - 25); return [{ window: '近期检查窗口', startCycle: start, endCycle: Math.max(start, prediction.lowerBound), priority: 'high', reason: `${prediction.limitingComponent} 的预测寿命下界接近` }, { window: '计划维护窗口', startCycle: prediction.lowerBound, endCycle: Math.max(prediction.lowerBound, prediction.estimatedRemainingCycles), priority: prediction.confidence > 70 ? 'medium' : 'high', reason: '建议在下界前安排拆检或部件更换' }, { window: '延后风险窗口', startCycle: prediction.estimatedRemainingCycles, endCycle: Math.max(prediction.estimatedRemainingCycles, prediction.upperBound), priority: 'critical', reason: '超过预测中位寿命后，维护概率显著上升' }]; }

export type MaintenanceAction = MaintenanceEvent['action'];
export type SimulationWindow = { window: string; startCycle: number; endCycle: number; priority: string; reason: string; safetyLowerBoundBreached?: boolean };

export type MaintenanceSimulationInput = {
  engineId: string;
  prediction: RulPrediction;
  assessment?: HealthAssessment;
  maintenanceHistory?: MaintenanceEvent[];
  delayCycles?: number;
  component?: Component;
  action?: MaintenanceAction;
  /** 模拟推演的参考日期，默认取当前时间，仅用于折算距上次维护的循环数，不影响只读性 */
  referenceDate?: string;
};

export type MaintenanceSimulationResult = {
  engineId: string;
  delayCycles: number;
  component?: Component;
  action?: MaintenanceAction;
  readOnly: true;
  adjustedRisk: {
    baselineRisk: number;
    additionalRiskFromDelay: number;
    mitigationReduction: number;
    netRisk: number;
    adjustedComponentScore: number;
    probabilityOfMaintenanceAtDelay: number;
    probabilityAfterMitigation: number;
  };
  adjustedRul: {
    estimatedRemainingCycles: number;
    lowerBound: number;
    upperBound: number;
    limitingComponent: Component;
    cyclesGained: number;
    safetyLowerBound: number;
    safetyLowerBoundBreached: boolean;
    cyclesPastSafetyLowerBound: number;
  };
  maintenanceHistory: {
    totalEvents: number;
    componentEvents: number;
    lastComponentAction?: MaintenanceAction;
    lastComponentEventAt?: string;
    historyFactor: number;
  };
  windows: SimulationWindow[];
  recommendation: string;
  impact: { additionalRisk: number; recommendation: string };
};

const actionEffectiveness: Record<MaintenanceAction, number> = { inspection: .18, calibration: .32, repair: .58, replacement: .9 };
const componentLabels: Record<Component, string> = { hot_section: '热端部件', compressor: '压气机', bearing: '轴承', lubrication: '滑油系统' };
const actionLabels: Record<MaintenanceAction, string> = { inspection: '检查', calibration: '校准', repair: '修理', replacement: '更换' };

function probabilityAt(prediction: RulPrediction, cycle: number): number {
  const curve = prediction.riskByHorizon;
  if (cycle <= curve[0].cycle) return curve[0].probabilityOfMaintenance;
  for (let i = 1; i < curve.length; i += 1) {
    if (cycle <= curve[i].cycle) {
      const span = curve[i].cycle - curve[i - 1].cycle || 1;
      const ratio = (cycle - curve[i - 1].cycle) / span;
      return round(clamp(curve[i - 1].probabilityOfMaintenance + ratio * (curve[i].probabilityOfMaintenance - curve[i - 1].probabilityOfMaintenance), 0, .99), 3);
    }
  }
  const tail = curve[curve.length - 1];
  return round(clamp(tail.probabilityOfMaintenance + Math.max(0, cycle - tail.cycle) * .004, 0, .99), 3);
}

function buildSimulationWindows(p: { lowerBound: number; estimatedRemainingCycles: number; upperBound: number; limitingComponent: Component }, rawSafetyLowerBound: number, breached: boolean, cyclesPastBound: number, delay: number, mitigation: boolean): SimulationWindow[] {
  const lower = Math.max(0, Math.round(p.lowerBound));
  const estimate = Math.max(lower, Math.round(p.estimatedRemainingCycles));
  const upper = Math.max(estimate, Math.round(p.upperBound));
  const windows: SimulationWindow[] = [
    { window: '近期检查窗口', startCycle: Math.max(0, lower - 25), endCycle: lower, priority: 'high', reason: `${p.limitingComponent} 的安全寿命下界（第 ${lower} 循环）前的检查区间` },
    { window: '计划维护窗口', startCycle: lower, endCycle: estimate, priority: 'medium', reason: mitigation ? '结合维护动作的修正后，可在该区间安排计划内停场' : '建议在安全下界前安排拆检或部件更换' },
    { window: '延后风险窗口', startCycle: estimate, endCycle: upper, priority: 'critical', reason: '超过预测中位寿命后，维护概率显著上升' }
  ];
  if (breached) windows.unshift({ window: '安全下界越界区间', startCycle: 0, endCycle: Math.max(0, delay), priority: 'critical', reason: `延后 ${delay} 个循环已越过 ${p.limitingComponent} 的安全下界 ${rawSafetyLowerBound} 个循环（越界 ${cyclesPastBound} 个循环），必须立即安排维护`, safetyLowerBoundBreached: true });
  return windows;
}

/**
 * 只读维护推演：在不修改预测、评估与维护历史的前提下，
 * 结合 delayCycles / component / action 返回调整后的风险、窗口和建议。
 */
export function simulateMaintenance(input: MaintenanceSimulationInput): MaintenanceSimulationResult {
  const { prediction, engineId } = input;
  const delay = Math.max(0, Math.floor(Number.isFinite(input.delayCycles) ? input.delayCycles ?? 0 : 0));
  const referenceTime = new Date(input.referenceDate ?? new Date().toISOString()).getTime() || Date.now();
  const history = input.maintenanceHistory ?? [];
  const targetComponent = input.component;
  const action = input.action;
  const mitigation = Boolean(targetComponent && action);
  if ((input.component && !input.action) || (!input.component && input.action)) throw Object.assign(new Error('component_and_action_must_be_provided_together'), { statusCode: 400 });

  const componentRisks = input.assessment?.componentRisks ?? [];
  const componentRisk = targetComponent ? round(componentRisks.find(item => item.component === targetComponent)?.score ?? Math.max(0, 100 - prediction.estimatedRemainingCycles)) : 0;

  const componentHistory = targetComponent ? history.filter(event => event.component === targetComponent) : [];
  const lastComponentEvent = componentHistory.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0];
  const sameActionCount = action && lastComponentEvent ? componentHistory.filter(event => event.action === action).length : 0;
  const cyclesSinceLastEvent = lastComponentEvent ? Math.max(0, Math.round((referenceTime - new Date(lastComponentEvent.occurredAt).getTime()) / (1000 * 60 * 60 * 24) / 2.5)) : Infinity;
  // 距上次维护越久增益越高；同一动作重复执行存在边际递减
  const recencyFactor = lastComponentEvent ? clamp(cyclesSinceLastEvent / 120, .65, 1.1) : 1;
  const repetitionPenalty = sameActionCount > 0 ? 1 - .2 * sameActionCount : 1;
  const historyFactor = mitigation ? round(clamp(recencyFactor * repetitionPenalty, .45, 1.1), 3) : 1;

  const baseDelayRisk = Math.min(100, Math.round(delay / Math.max(prediction.estimatedRemainingCycles, 1) * 100));
  const effectiveness = mitigation && action ? actionEffectiveness[action] : 0;
  const mitigationReduction = mitigation ? Math.round(componentRisk * effectiveness * historyFactor) : 0;
  const adjustedComponentScore = mitigation ? round(clamp(componentRisk - mitigationReduction)) : round(componentRisk);
  const netRisk = clamp(baseDelayRisk - (mitigation ? Math.round(mitigationReduction * .45) : 0));

  const componentShare = targetComponent ? Math.max(.15, (100 - componentRisk) / 100) : 0;
  const cyclesGained = mitigation && targetComponent && action
    ? Math.round(prediction.estimatedRemainingCycles * componentShare * effectiveness * historyFactor * (action === 'replacement' ? 1.35 : 1))
    : 0;
  const nextLimiting = targetComponent && mitigation
    ? componentRisks.filter(item => item.component !== targetComponent).sort((a, b) => a.estimatedCyclesToLimit - b.estimatedCyclesToLimit)[0]
    : undefined;
  const limitingComponent = targetComponent && mitigation && targetComponent === prediction.limitingComponent && nextLimiting
    ? nextLimiting.component
    : prediction.limitingComponent;

  // 先按延后消耗寿命，再叠加维护动作带来的延寿；所有循环值都钳制为非负
  const adjustedEstimate = Math.max(0, prediction.estimatedRemainingCycles - delay + cyclesGained);
  const adjustedLower = Math.max(0, Math.min(adjustedEstimate, prediction.lowerBound - delay + Math.round(cyclesGained * .8)));
  const adjustedUpper = Math.max(adjustedEstimate, prediction.upperBound - delay + Math.round(cyclesGained * 1.1));
  const safetyLowerBound = Math.max(0, prediction.lowerBound - delay);
  const breached = delay > prediction.lowerBound;
  const cyclesPastSafetyLowerBound = Math.max(0, delay - prediction.lowerBound);

  const probabilityAtDelay = probabilityAt(prediction, Math.max(0, prediction.estimatedRemainingCycles - delay));
  const probabilityAfterMitigation = mitigation
    ? round(clamp(probabilityAtDelay - effectiveness * .35 * historyFactor + (breached ? .15 : 0), 0, .99), 3)
    : probabilityAtDelay;

  const windows = buildSimulationWindows({ lowerBound: adjustedLower, estimatedRemainingCycles: adjustedEstimate, upperBound: adjustedUpper, limitingComponent }, prediction.lowerBound, breached, cyclesPastSafetyLowerBound, delay, mitigation);

  let recommendation: string;
  if (breached && mitigation) recommendation = `延后 ${delay} 个循环已越过安全下界 ${prediction.lowerBound}（越界 ${cyclesPastSafetyLowerBound} 个循环），即便立即执行「${actionLabels[action!]}${componentLabels[targetComponent!]}」仍存在超期服役风险，建议提前至下界前完成并优先安排 ${componentLabels[limitingComponent]} 的检查`;
  else if (breached) recommendation = `延后 ${delay} 个循环已越过安全下界 ${prediction.lowerBound}（越界 ${cyclesPastSafetyLowerBound} 个循环），不建议继续延后，应立即安排维护`;
  else if (mitigation) recommendation = `「${actionLabels[action!]}${componentLabels[targetComponent!]}」结合 ${componentHistory.length} 次同部件维护历史，预计延寿 ${cyclesGained} 个循环、风险降低 ${mitigationReduction}，可在第 ${adjustedLower}-${adjustedEstimate} 循环窗口内安排计划维护`;
  else recommendation = delay > prediction.lowerBound ? '延后超过寿命下界，不建议执行' : '当前延后仍在可评估范围内';

  return {
    engineId,
    delayCycles: delay,
    ...(targetComponent ? { component: targetComponent } : {}),
    ...(action ? { action } : {}),
    readOnly: true,
    adjustedRisk: { baselineRisk: round(componentRisk), additionalRiskFromDelay: baseDelayRisk, mitigationReduction, netRisk, adjustedComponentScore, probabilityOfMaintenanceAtDelay: probabilityAtDelay, probabilityAfterMitigation },
    adjustedRul: { estimatedRemainingCycles: adjustedEstimate, lowerBound: adjustedLower, upperBound: adjustedUpper, limitingComponent, cyclesGained, safetyLowerBound, safetyLowerBoundBreached: breached, cyclesPastSafetyLowerBound },
    maintenanceHistory: { totalEvents: history.length, componentEvents: componentHistory.length, ...(lastComponentEvent ? { lastComponentAction: lastComponentEvent.action, lastComponentEventAt: lastComponentEvent.occurredAt } : {}), historyFactor },
    windows,
    recommendation,
    impact: { additionalRisk: baseDelayRisk, recommendation }
  };
}
