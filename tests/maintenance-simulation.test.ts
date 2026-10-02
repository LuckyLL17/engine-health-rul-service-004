import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessEngine, predictRul, simulateMaintenance } from '../src/health.js';
import { createDemoTelemetry, demoEngine, demoMaintenance, demoModels } from '../src/demo-data.js';
import { createApp } from '../src/server.js';
import { LocalStore } from '../src/store.js';
import type { MaintenanceEvent, RulPrediction } from '../src/types.js';

function buildPrediction(): RulPrediction {
  const assessment = assessEngine(demoEngine, createDemoTelemetry(), demoModels[1]);
  return predictRul(demoEngine, assessment, 240, demoModels[1]);
}

const allWindowsNonNegative = (result: ReturnType<typeof simulateMaintenance>) =>
  result.windows.every(w => w.startCycle >= 0 && w.endCycle >= 0 && w.endCycle >= w.startCycle);

describe('maintenance simulation', () => {
  it('keeps legacy delayCycles-only behaviour and recommendation text', () => {
    const prediction = buildPrediction();
    const delay = 5;
    const result = simulateMaintenance(demoEngine.id, prediction, { delayCycles: delay });

    expect(result.component).toBeUndefined();
    expect(result.adjusted).toBeUndefined();
    expect(result.delayCycles).toBe(delay);
    expect(result.impact.additionalRisk)
      .toBe(Math.min(100, Math.round(delay / Math.max(prediction.estimatedRemainingCycles, 1) * 100)));
    expect(result.impact.recommendation).toBe('当前延后仍在可评估范围内');
    expect(result.safetyLowerBoundCrossed).toBe(false);
    expect(allWindowsNonNegative(result)).toBe(true);
  });

  it('marks safety lower bound breach with non-negative windows when delay exceeds life', () => {
    const prediction = buildPrediction();
    const delay = prediction.estimatedRemainingCycles + prediction.upperBound + 50;
    const result = simulateMaintenance(demoEngine.id, prediction, { delayCycles: delay });

    expect(result.safetyLowerBoundCrossed).toBe(true);
    expect(allWindowsNonNegative(result)).toBe(true);
    expect(result.windows[0]).toMatchObject({ window: '安全下界越界窗口', breached: true, startCycle: 0, endCycle: 0 });
    expect(result.impact.recommendation).toBe('延后超过寿命下界，不建议执行');
  });

  it('adjusts risk, windows and recommendation from component/action and maintenance history', () => {
    const prediction = buildPrediction();
    const limiting = prediction.limitingComponent;
    const result = simulateMaintenance(demoEngine.id, prediction, {
      delayCycles: 8,
      component: limiting,
      action: 'replacement',
      history: demoMaintenance
    });

    expect(result.component).toBe(limiting);
    expect(result.action).toBe('replacement');
    expect(result.adjusted).toBeDefined();
    expect(result.adjusted!.extensionCycles).toBeGreaterThan(0);
    expect(result.adjusted!.estimatedRemainingCycles)
      .toBe(Math.max(0, prediction.estimatedRemainingCycles - 8 + result.adjusted!.extensionCycles));
    expect(result.adjusted!.netAdditionalRisk).toBeLessThan(result.impact.additionalRisk + 1);
    expect(result.basis?.some(line => line.includes('寿命瓶颈'))).toBe(true);
    expect(allWindowsNonNegative(result)).toBe(true);
  });

  it('discounts benefit for non-limiting components and uses recent replacement history', () => {
    const prediction = buildPrediction();
    const other = (['hot_section', 'compressor', 'bearing', 'lubrication'] as const)
      .find(component => component !== prediction.limitingComponent)!;
    const recent: MaintenanceEvent[] = [{
      id: 'M-NEW', engineId: demoEngine.id, component: other, action: 'replacement',
      occurredAt: new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10),
      severity: 'important', note: '近期刚更换'
    }];

    const result = simulateMaintenance(demoEngine.id, prediction, {
      delayCycles: 6, component: other, action: 'replacement', history: recent
    });

    expect(result.basis?.some(line => line.includes('不是当前寿命瓶颈'))).toBe(true);
    expect(result.basis?.some(line => line.includes('刚完成更换'))).toBe(true);
    // 非瓶颈 0.35 折算 × 近期更换 0.5 折扣
    expect(result.adjusted!.extensionCycles)
      .toBe(Math.round(prediction.estimatedRemainingCycles * .55 * .35 * .5));
  });

  it('suggests replacement after repeated repairs and stays read-only on inputs', () => {
    const prediction = buildPrediction();
    const component = prediction.limitingComponent;
    const history: MaintenanceEvent[] = [
      { id: 'M-1', engineId: demoEngine.id, component, action: 'repair', occurredAt: '2026-03-01', severity: 'routine', note: '一修' },
      { id: 'M-2', engineId: demoEngine.id, component, action: 'repair', occurredAt: '2026-05-01', severity: 'important', note: '二修' }
    ];
    const snapshot = JSON.stringify(prediction);
    const result = simulateMaintenance(demoEngine.id, prediction, { delayCycles: 4, component, action: 'repair', history });

    expect(JSON.stringify(prediction)).toBe(snapshot);
    expect(history).toHaveLength(2);
    expect(result.basis?.some(line => line.includes('建议优先选择更换'))).toBe(true);
    expect(result.safetyLowerBoundCrossed).toBe(false);
  });

  it('treats missing history as low-confidence evidence and keeps windows non-negative', () => {
    const prediction = buildPrediction();
    const result = simulateMaintenance(demoEngine.id, prediction, {
      delayCycles: 0, component: 'hot_section', action: 'inspection', history: []
    });
    expect(result.basis?.some(line => line.includes('暂无维护历史'))).toBe(true);
    expect(allWindowsNonNegative(result)).toBe(true);
  });

  it('still reports breach with non-negative windows when action cannot recover delay', () => {
    const prediction = buildPrediction();
    const result = simulateMaintenance(demoEngine.id, prediction, {
      delayCycles: 9999, component: prediction.limitingComponent, action: 'replacement', history: demoMaintenance
    });
    expect(result.safetyLowerBoundCrossed).toBe(true);
    expect(allWindowsNonNegative(result)).toBe(true);
    expect(result.windows[0]).toMatchObject({ breached: true, startCycle: 0, endCycle: 0 });
    expect(result.impact.recommendation).toContain('越过安全下界');
  });

  it('endpoint validates inputs, combines history, and stays strictly read-only', async () => {
    const store = new LocalStore(join(tmpdir(), `maintenance-sim-${Date.now()}.json`));
    const app = await createApp(store);
    await app.inject({ method: 'POST', url: `/api/engines/${demoEngine.id}/health-assessment`, payload: { modelId: 'health-v2' } });
    await app.inject({ method: 'POST', url: `/api/engines/${demoEngine.id}/rul-prediction`, payload: { horizonCycles: 240 } });

    const predictionsBefore = store.predictions.length;
    const maintenanceBefore = store.maintenance.length;

    const invalid = await app.inject({ method: 'POST', url: `/api/engines/${demoEngine.id}/maintenance-simulation`, payload: { component: 'gearbox', action: 'replacement' } });
    expect(invalid.statusCode).toBe(400);

    const res = await app.inject({
      method: 'POST',
      url: `/api/engines/${demoEngine.id}/maintenance-simulation`,
      payload: { delayCycles: 3, component: 'lubrication', action: 'calibration' }
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.action).toBe('calibration');
    expect(body.basis.join('')).toContain('滑油');
    expect(store.predictions.length).toBe(predictionsBefore);
    expect(store.maintenance.length).toBe(maintenanceBefore);
    expect(store.audit.some(item => item.action === 'maintenance_simulation')).toBe(false);
    await app.close();
  });
});
