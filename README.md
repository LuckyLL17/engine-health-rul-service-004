# 航空发动机健康状态评估与剩余寿命预测服务

这是一个可直接在主机运行的纯后端 Node.js + TypeScript 项目，不依赖 Docker、数据库、Redis、Kafka 或云服务。业务状态默认写入本地 `data/state.json`，演示数据由代码生成，适合离线测试和后续接入真实传感器数据。

## 已实现业务

- 发动机档案与型号配置
- 飞行架次和多传感器时序导入
- 时间戳、单位、范围和单调性校验
- 缺失值线性插值与异常点剔除
- 飞行阶段工况归一化
- 排气温度裕度、燃油效率、振动风险、滑油压力裕度计算
- 传感器漂移和突变检测
- 发动机健康评分与状态分级
- 部件级风险排序
- 基于退化趋势的剩余寿命估算
- 预测置信区间与解释性证据
- 维修事件回灌和风险修正
- 传感器数据按时间顺序重放
- 维护窗口推演
- 模型版本比较
- 告警事件、审计轨迹和本地结果导出

## 运行

```bash
npm install
npm run build
npm test
npm run demo
npm start
```

服务默认监听 `http://127.0.0.1:6195`。

## 主要 API

```text
GET  /api/health
GET  /api/models
POST /api/engines/import
GET  /api/engines/:id
GET  /api/engines/:id/telemetry
POST /api/engines/:id/health-assessment
POST /api/engines/:id/rul-prediction
POST /api/engines/:id/replay
GET  /api/replay/jobs/:id
POST /api/engines/:id/maintenance-simulation
POST /api/models/compare
GET  /api/engines/:id/risk-events
GET  /api/audit/:engineId
```

## 示例

```bash
curl http://127.0.0.1:6195/api/health
curl http://127.0.0.1:6195/api/engines/ENG-DEMO-001/health-assessment
curl -X POST http://127.0.0.1:6195/api/engines/ENG-DEMO-001/rul-prediction \
  -H 'content-type: application/json' \
  -d '{"horizonCycles":120}'
```

## 维护窗口推演

`POST /api/engines/:id/maintenance-simulation` 为**只读**推演，不写入业务状态或审计日志。

- 旧客户端仅传 `delayCycles`：响应结构与文案保持兼容；延后超过安全下界时，窗口周期全部收敛为非负（0 表示立即到期），并返回 `safetyLowerBoundCrossed: true` 及一个 `breached: true` 的“安全下界越界窗口”。
- 传入 `component`（`hot_section` / `compressor` / `bearing` / `lubrication`）和 `action`（`inspection` / `replacement` / `repair` / `calibration`）后，结合该发动机维护历史修正收益，返回：
  - `adjusted`：动作后的剩余寿命、上下界、寿命延长循环数、风险消减与净增量风险
  - `windows`：基于调整后寿命的非负维护窗口，越界时前置显式预警窗口
  - `impact.recommendation`：是否可延后、可接受延后上限及瓶颈部件提示
  - `basis`：历史折扣、重复维修、非瓶颈折算等推演依据

```bash
curl -X POST http://127.0.0.1:6195/api/engines/ENG-DEMO-001/maintenance-simulation \
  -H 'content-type: application/json' \
  -d '{"delayCycles":10,"component":"compressor","action":"replacement"}'
```
