import { describe, expect, it } from 'vitest';
import { createDemoTelemetry, demoEngine, demoMaintenance, demoModels } from '../src/demo-data.js';
import { assessEngine, predictRul, simulateMaintenance } from '../src/health.js';

function scenario() {
  const assessment = assessEngine(demoEngine, createDemoTelemetry(), demoModels[1], demoMaintenance.length);
  const prediction = predictRul(demoEngine, assessment, 240, demoModels[1]);
  return { assessment, prediction };
}

describe('maintenance simulation', () => {
  it('keeps legacy delayCycles-only callers compatible', () => {
    const { prediction } = scenario();
    const delay = 10;
    const result = simulateMaintenance({ engineId: demoEngine.id, prediction, delayCycles: delay });
    expect(result.delayCycles).toBe(delay);
    expect(result.component).toBeUndefined();
    expect(result.action).toBeUndefined();
    expect(result.impact.additionalRisk).toBe(Math.min(100, Math.round(delay / Math.max(prediction.estimatedRemainingCycles, 1) * 100)));
    expect(result.impact.recommendation).toBe('当前延后仍在可评估范围内');
    for (const window of result.windows) {
      expect(window.startCycle).toBeGreaterThanOrEqual(0);
      expect(window.endCycle).toBeGreaterThanOrEqual(window.startCycle);
    }
    expect(result.adjustedRul.safetyLowerBoundBreached).toBe(false);
  });

  it('keeps every window non-negative and flags the crossed safety lower bound when delay exceeds life', () => {
    const { prediction } = scenario();
    const delay = prediction.lowerBound + 40;
    const result = simulateMaintenance({ engineId: demoEngine.id, prediction, delayCycles: delay });
    expect(result.adjustedRul.safetyLowerBoundBreached).toBe(true);
    expect(result.adjustedRul.safetyLowerBound).toBe(0);
    expect(result.adjustedRul.cyclesPastSafetyLowerBound).toBe(40);
    expect(result.adjustedRul.lowerBound).toBe(0);
    for (const window of result.windows) {
      expect(window.startCycle).toBeGreaterThanOrEqual(0);
      expect(window.endCycle).toBeGreaterThanOrEqual(0);
      expect(window.endCycle).toBeGreaterThanOrEqual(window.startCycle);
    }
    const breachWindow = result.windows.find(window => window.safetyLowerBoundBreached);
    expect(breachWindow).toBeDefined();
    expect(result.recommendation).toContain('越过安全下界');
  });

  it('adjusts risk and life using component, action and maintenance history', () => {
    const { assessment, prediction } = scenario();
    const result = simulateMaintenance({ engineId: demoEngine.id, prediction, assessment, maintenanceHistory: demoMaintenance, delayCycles: 5, component: 'bearing', action: 'replacement', referenceDate: '2026-10-01T00:00:00.000Z' });
    expect(result.readOnly).toBe(true);
    expect(result.maintenanceHistory.totalEvents).toBe(demoMaintenance.length);
    expect(result.maintenanceHistory.componentEvents).toBe(1);
    expect(result.maintenanceHistory.lastComponentAction).toBe('inspection');
    expect(result.adjustedRisk.mitigationReduction).toBeGreaterThan(0);
    expect(result.adjustedRisk.adjustedComponentScore).toBeLessThanOrEqual(result.adjustedRisk.baselineRisk);
    expect(result.adjustedRul.cyclesGained).toBeGreaterThan(0);
    expect(result.recommendation).toContain('更换轴承');
  });

  it('gives inspection less relief than replacement', () => {
    const { assessment, prediction } = scenario();
    const inspection = simulateMaintenance({ engineId: demoEngine.id, prediction, assessment, maintenanceHistory: demoMaintenance, delayCycles: 0, component: 'bearing', action: 'inspection', referenceDate: '2026-10-01T00:00:00.000Z' });
    const replacement = simulateMaintenance({ engineId: demoEngine.id, prediction, assessment, maintenanceHistory: demoMaintenance, delayCycles: 0, component: 'bearing', action: 'replacement', referenceDate: '2026-10-01T00:00:00.000Z' });
    expect(replacement.adjustedRisk.mitigationReduction).toBeGreaterThan(inspection.adjustedRisk.mitigationReduction);
    expect(replacement.adjustedRul.cyclesGained).toBeGreaterThan(inspection.adjustedRul.cyclesGained);
  });

  it('does not mutate the prediction or maintenance history', () => {
    const { assessment, prediction } = scenario();
    const predictionSnapshot = JSON.stringify(prediction);
    const historySnapshot = JSON.stringify(demoMaintenance);
    simulateMaintenance({ engineId: demoEngine.id, prediction, assessment, maintenanceHistory: demoMaintenance, delayCycles: 30, component: 'bearing', action: 'repair', referenceDate: '2026-10-01T00:00:00.000Z' });
    expect(JSON.stringify(prediction)).toBe(predictionSnapshot);
    expect(JSON.stringify(demoMaintenance)).toBe(historySnapshot);
  });

  it('rejects providing component without action (or vice versa)', () => {
    const { prediction } = scenario();
    expect(() => simulateMaintenance({ engineId: demoEngine.id, prediction, component: 'bearing' })).toThrow(/together/);
  });
});
