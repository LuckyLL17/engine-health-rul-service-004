import { createApp } from './server.js';

if (process.argv[2] === 'demo') {
  const app = await createApp();
  const assessment = await app.inject({ method: 'POST', url: '/api/engines/ENG-DEMO-001/health-assessment', payload: { modelId: 'health-v2' } });
  const prediction = await app.inject({ method: 'POST', url: '/api/engines/ENG-DEMO-001/rul-prediction', payload: { horizonCycles: 240 } });
  const legacySimulation = await app.inject({ method: 'POST', url: '/api/engines/ENG-DEMO-001/maintenance-simulation', payload: { delayCycles: 10 } });
  const actionSimulation = await app.inject({ method: 'POST', url: '/api/engines/ENG-DEMO-001/maintenance-simulation', payload: { delayCycles: 5, component: 'bearing', action: 'replacement' } });
  console.log(JSON.stringify({ assessment: JSON.parse(assessment.body), prediction: JSON.parse(prediction.body), legacySimulation: JSON.parse(legacySimulation.body), actionSimulation: JSON.parse(actionSimulation.body) }, null, 2));
  await app.close();
}
