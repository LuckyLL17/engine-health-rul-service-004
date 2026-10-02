import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { LocalStore } from '../src/store.js';
import type { FastifyInstance } from 'fastify';

class CountingStore extends LocalStore {
  persistCalls = 0;
  constructor(file: string) { super(file); }
  override async persist(): Promise<void> { this.persistCalls += 1; }
}

const disposables: Array<{ app: FastifyInstance; dir: string }> = [];
afterEach(async () => {
  for (const item of disposables.splice(0)) { await item.app.close(); await rm(item.dir, { recursive: true, force: true }); }
});

async function setup(): Promise<{ app: FastifyInstance; store: CountingStore }> {
  const dir = await mkdtemp(join(tmpdir(), 'rul-sim-'));
  const store = new CountingStore(join(dir, 'state.json'));
  const app = await createApp(store);
  await app.inject({ method: 'POST', url: '/api/engines/ENG-DEMO-001/health-assessment', payload: { modelId: 'health-v2' } });
  await app.inject({ method: 'POST', url: '/api/engines/ENG-DEMO-001/rul-prediction', payload: { horizonCycles: 240 } });
  store.persistCalls = 0;
  disposables.push({ app, dir });
  return { app, store };
}

describe('maintenance-simulation endpoint', () => {
  it('stays compatible with delayCycles-only legacy clients and stays read-only', async () => {
    const { app, store } = await setup();
    const before = { events: store.maintenance.length, predictions: store.predictions.length, audit: store.audit.length };
    const response = await app.inject({ method: 'POST', url: '/api/engines/ENG-DEMO-001/maintenance-simulation', payload: { delayCycles: 10 } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.delayCycles).toBe(10);
    expect(body.impact.additionalRisk).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.windows)).toBe(true);
    expect(store.persistCalls).toBe(0);
    expect(store.maintenance.length).toBe(before.events);
    expect(store.predictions.length).toBe(before.predictions);
    expect(store.audit.length).toBe(before.audit);
  });

  it('accepts component and action and returns adjusted risk, windows and advice', async () => {
    const { app, store } = await setup();
    const response = await app.inject({ method: 'POST', url: '/api/engines/ENG-DEMO-001/maintenance-simulation', payload: { delayCycles: 5, component: 'bearing', action: 'replacement' } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.component).toBe('bearing');
    expect(body.action).toBe('replacement');
    expect(body.readOnly).toBe(true);
    expect(body.adjustedRisk.mitigationReduction).toBeGreaterThan(0);
    expect(body.adjustedRul.cyclesGained).toBeGreaterThan(0);
    expect(body.maintenanceHistory.componentEvents).toBeGreaterThanOrEqual(1);
    expect(body.recommendation).toContain('更换轴承');
    expect(store.persistCalls).toBe(0);
  });

  it('returns non-negative windows and an explicit bound-crossing flag beyond the life lower bound', async () => {
    const { app } = await setup();
    const prediction = (await app.inject({ method: 'GET', url: '/api/engines/ENG-DEMO-001' })).json().latestPrediction;
    const response = await app.inject({ method: 'POST', url: '/api/engines/ENG-DEMO-001/maintenance-simulation', payload: { delayCycles: prediction.lowerBound + 30 } });
    const body = response.json();
    expect(body.adjustedRul.safetyLowerBoundBreached).toBe(true);
    expect(body.adjustedRul.cyclesPastSafetyLowerBound).toBe(30);
    for (const window of body.windows) {
      expect(window.startCycle).toBeGreaterThanOrEqual(0);
      expect(window.endCycle).toBeGreaterThanOrEqual(0);
    }
  });

  it('validates component/action inputs', async () => {
    const { app } = await setup();
    const badComponent = await app.inject({ method: 'POST', url: '/api/engines/ENG-DEMO-001/maintenance-simulation', payload: { component: 'turbine', action: 'repair' } });
    expect(badComponent.statusCode).toBe(400);
    const halfPair = await app.inject({ method: 'POST', url: '/api/engines/ENG-DEMO-001/maintenance-simulation', payload: { component: 'bearing' } });
    expect(halfPair.statusCode).toBe(400);
  });
});
