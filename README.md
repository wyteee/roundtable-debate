# 圆桌 Roundtable · 深夜辩论电台

三位历史名人的"电子灵魂"，围坐圆桌为你的人生问题辩论一场。

## 项目状态
需求对齐已完成（见 PRD v2.0），当前处于阶段 1：核心机制验证。

## 目录结构
- `api/` —— Vercel Serverless Function，仅一个接口 `POST /api/debate`
- `src/` —— React + Vite 前端
- `characters/` —— 人物卡 JSON（产品的心脏，见 AGENTS.md 第 4 节字段规范）
- `AGENTS.md` —— AI 协作与产品机制对齐文档，开工前必读

## 开发约定
详见 `AGENTS.md`。
