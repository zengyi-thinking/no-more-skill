import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const dbPath = path.join(root, ".nms", "data.json");
const outDir = path.join(root, "docs", "reports", "nms-html");
const outPath = path.join(outDir, "report.html");

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function avg(values = []) {
  if (values.length === 0) return 0;
  return Number((values.reduce((sum, item) => sum + item, 0) / values.length).toFixed(2));
}

function pct(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function barRows(entries, maxValue) {
  if (entries.length === 0) {
    return `<div class="empty">暂无真实数据，先运行 nms ingest 积累 session。</div>`;
  }
  return entries
    .map(([name, count], index) => {
      const width = Math.max(8, pct((count / Math.max(1, maxValue)) * 100));
      return `
        <div class="bar-row">
          <div class="bar-meta">
            <span>${index + 1}. ${escapeHtml(name)}</span>
            <strong>${count}</strong>
          </div>
          <div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div>
        </div>
      `;
    })
    .join("");
}

function workflowSteps(workflow) {
  if (!workflow || workflow.length === 0) {
    return `<div class="empty">暂无可复现 workflow。</div>`;
  }
  return workflow
    .map(
      (step, index) => `
        <div class="wf-step">
          <div class="wf-index">${index + 1}</div>
          <div>${escapeHtml(step)}</div>
        </div>
      `,
    )
    .join(`<div class="wf-arrow">→</div>`);
}

if (!fs.existsSync(dbPath)) {
  throw new Error(`Missing NMS data file: ${dbPath}`);
}

const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
const sessions = Array.isArray(db.sessions) ? db.sessions : [];
const quality = db.stats?.quality_metrics ?? {};
const skillEntries = Object.entries(db.stats?.skill_counts ?? {}).sort((a, b) => b[1] - a[1]);
const workflowEntries = Object.entries(db.stats?.workflow_counts ?? {}).sort((a, b) => b[1] - a[1]);
const topWorkflow = workflowEntries[0]?.[0]?.split(" -> ") ?? [];
const maxSkill = Math.max(1, ...skillEntries.map(([, count]) => count));
const latestSession = [...sessions].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
const perf = db.stats?.perf_windows ?? {};
const generatedAt = new Date().toISOString();

const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>NMS 行为工程汇报</title>
  <style>
    :root {
      --bg: #07111f;
      --panel: rgba(12, 23, 39, 0.88);
      --panel-2: rgba(18, 34, 52, 0.78);
      --line: rgba(120, 160, 190, 0.28);
      --text: #edf6ff;
      --muted: #9fb2c5;
      --cyan: #22d3ee;
      --green: #34d399;
      --amber: #fbbf24;
      --rose: #fb7185;
      --ink: #050816;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--text);
      font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
      background:
        radial-gradient(circle at 18% 12%, rgba(34, 211, 238, 0.22), transparent 30%),
        radial-gradient(circle at 82% 22%, rgba(52, 211, 153, 0.15), transparent 28%),
        linear-gradient(135deg, #050816 0%, #07111f 46%, #0c1d22 100%);
    }
    main {
      width: min(1440px, calc(100vw - 56px));
      margin: 0 auto;
      padding: 42px 0 56px;
    }
    .hero {
      display: grid;
      grid-template-columns: 1.08fr 0.92fr;
      gap: 28px;
      align-items: stretch;
      margin-bottom: 28px;
    }
    .hero-copy, .hero-image, .card {
      border: 1px solid var(--line);
      background: var(--panel);
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.34);
      backdrop-filter: blur(18px);
    }
    .hero-copy {
      padding: 38px;
      min-height: 380px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .eyebrow {
      color: var(--cyan);
      font-size: 13px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      font-weight: 700;
    }
    h1 {
      margin: 18px 0 14px;
      font-size: 58px;
      line-height: 1.04;
      letter-spacing: 0;
    }
    .lead {
      margin: 0;
      max-width: 720px;
      color: var(--muted);
      font-size: 20px;
      line-height: 1.7;
    }
    .hero-image {
      position: relative;
      overflow: hidden;
      min-height: 380px;
    }
    .hero-image img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      opacity: 0.9;
    }
    .hero-image::after {
      content: "";
      position: absolute;
      inset: 0;
      background: linear-gradient(90deg, rgba(5, 8, 22, 0.68), transparent 60%);
      pointer-events: none;
    }
    .kpis {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 14px;
      margin-top: 28px;
    }
    .kpi {
      padding: 16px;
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.04);
    }
    .kpi span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .kpi strong {
      display: block;
      margin-top: 8px;
      font-size: 30px;
      color: var(--text);
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 18px;
    }
    .card {
      padding: 26px;
      min-height: 280px;
    }
    .card h2 {
      margin: 0 0 18px;
      font-size: 24px;
      letter-spacing: 0;
    }
    .subtle {
      color: var(--muted);
      line-height: 1.7;
      font-size: 15px;
    }
    .bar-row { margin: 16px 0; }
    .bar-meta {
      display: flex;
      justify-content: space-between;
      gap: 18px;
      color: var(--text);
      font-size: 16px;
      margin-bottom: 9px;
    }
    .bar-track {
      height: 12px;
      background: rgba(255, 255, 255, 0.08);
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    .bar-fill {
      height: 100%;
      background: linear-gradient(90deg, var(--cyan), var(--green));
    }
    .workflow {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 28px;
    }
    .wf-step {
      min-width: 140px;
      padding: 16px 18px;
      border: 1px solid rgba(34, 211, 238, 0.42);
      background: rgba(8, 47, 73, 0.5);
      display: grid;
      gap: 8px;
    }
    .wf-index {
      width: 28px;
      height: 28px;
      display: grid;
      place-items: center;
      color: var(--ink);
      background: var(--cyan);
      font-weight: 800;
    }
    .wf-arrow {
      color: var(--green);
      font-size: 26px;
      font-weight: 700;
    }
    .insight-list {
      display: grid;
      gap: 14px;
      margin-top: 20px;
    }
    .insight {
      display: grid;
      grid-template-columns: 14px 1fr;
      gap: 12px;
      color: var(--muted);
      line-height: 1.6;
    }
    .dot {
      width: 10px;
      height: 10px;
      margin-top: 8px;
      background: var(--amber);
    }
    .timeline {
      display: grid;
      gap: 12px;
    }
    .session {
      padding: 16px;
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.035);
    }
    .session time {
      color: var(--cyan);
      font-size: 13px;
      font-family: Consolas, monospace;
    }
    .session p {
      color: var(--muted);
      margin: 8px 0 0;
      line-height: 1.55;
    }
    .footer {
      margin-top: 18px;
      padding: 24px 26px;
      border: 1px solid var(--line);
      background: rgba(5, 8, 22, 0.72);
      display: flex;
      justify-content: space-between;
      gap: 24px;
      color: var(--muted);
      line-height: 1.65;
    }
    .footer strong { color: var(--cyan); }
    .empty {
      color: var(--muted);
      padding: 18px;
      border: 1px dashed var(--line);
      background: rgba(255,255,255,0.03);
    }
    @media (max-width: 980px) {
      main { width: min(100vw - 28px, 760px); padding-top: 24px; }
      .hero, .grid { grid-template-columns: 1fr; }
      .kpis { grid-template-columns: repeat(2, 1fr); }
      h1 { font-size: 40px; }
      .footer { flex-direction: column; }
    }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <div class="hero-copy">
        <div>
          <div class="eyebrow">NMS Behavior Report</div>
          <h1>把 AI 协作变成可观察的行为资产</h1>
          <p class="lead">这份报告由 NMS 的真实本地数据生成，覆盖 session 积累、skill 使用频率、主 workflow、用户风格与系统健康度。</p>
        </div>
        <div class="kpis">
          <div class="kpi"><span>Sessions</span><strong>${sessions.length}</strong></div>
          <div class="kpi"><span>Behavior</span><strong>${quality.behavior_score ?? 0}</strong></div>
          <div class="kpi"><span>Confidence</span><strong>${Math.round((quality.workflow_confidence ?? 0) * 100)}%</strong></div>
          <div class="kpi"><span>Velocity 7d</span><strong>${quality.session_velocity_7d ?? 0}</strong></div>
          <div class="kpi"><span>Streak</span><strong>${quality.streak_days ?? 0}d</strong></div>
        </div>
      </div>
      <div class="hero-image">
        <img src="../../../images/nms-skill-hero.png" alt="NMS Skill Hero" />
      </div>
    </section>

    <section class="grid">
      <article class="card">
        <h2>Skill 使用频率</h2>
        ${barRows(skillEntries, maxSkill)}
      </article>

      <article class="card">
        <h2>主 Workflow</h2>
        <div class="workflow">${workflowSteps(topWorkflow)}</div>
        <p class="subtle">当前主 workflow 置信度为 ${quality.workflow_confidence ?? 0}。样本仍少，建议继续用真实任务喂给 <code>nms ingest</code>。</p>
      </article>

      <article class="card">
        <h2>用户画像与演化</h2>
        <div class="insight-list">
          <div class="insight"><span class="dot"></span><span>当前风格：${escapeHtml(db.user_profile?.style ?? "unknown")}</span></div>
          <div class="insight"><span class="dot"></span><span>Top Skills：${escapeHtml((db.user_profile?.top_skills ?? []).join(" / ") || "暂无")}</span></div>
          <div class="insight"><span class="dot"></span><span>陈旧风险：${quality.stale_risk ?? 0}%；需要更多近期真实任务降低风险。</span></div>
        </div>
      </article>

      <article class="card">
        <h2>系统健康</h2>
        <div class="insight-list">
          <div class="insight"><span class="dot"></span><span>ingest 平均耗时：${avg(perf.ingest_ms)} ms</span></div>
          <div class="insight"><span class="dot"></span><span>flow 平均耗时：${avg(perf.flow_ms)} ms</span></div>
          <div class="insight"><span class="dot"></span><span>night 平均耗时：${avg(perf.night_ms)} ms</span></div>
          <div class="insight"><span class="dot"></span><span>schema_version：${db.schema_version ?? "unknown"}</span></div>
        </div>
      </article>

      <article class="card">
        <h2>最近 Session</h2>
        <div class="timeline">
          ${sessions
            .slice()
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
            .slice(0, 4)
            .map(
              (session) => `
                <div class="session">
                  <time>${escapeHtml(session.created_at)} · ${escapeHtml(session.tool)}</time>
                  <p>${escapeHtml(session.compressed_text || session.conversation || "(empty)")}</p>
                </div>
              `,
            )
            .join("") || `<div class="empty">暂无 session。</div>`}
        </div>
      </article>

      <article class="card">
        <h2>下一步建议</h2>
        <div class="insight-list">
          <div class="insight"><span class="dot"></span><span>用 5-10 个真实任务继续运行 <code>nms ingest</code>，优先覆盖 PRD、UI、代码生成、Debug 场景。</span></div>
          <div class="insight"><span class="dot"></span><span>录制演示时先展示 <code>nms flow</code>，再展示 <code>nms night --dry-run --explain</code> 的 gate 判定链。</span></div>
          <div class="insight"><span class="dot"></span><span>当 workflow_confidence 超过 70% 后，再重点展示 “越来越适配你” 的产品叙事。</span></div>
        </div>
      </article>
    </section>

    <section class="footer">
      <div><strong>Generated by NMS report</strong><br />更新时间：${generatedAt}</div>
      <div>数据源：<code>.nms/data.json</code>；基础报告：<code>docs/reports/nms-html/report.md</code>；HTML：<code>docs/reports/nms-html/report.html</code>。</div>
    </section>
  </main>
</body>
</html>`;

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, html, "utf8");
console.log(outPath);
