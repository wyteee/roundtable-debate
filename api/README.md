# API

Vercel 约定：此目录下的文件自动成为 Serverless Function。

计划中唯一接口：debate.ts → POST /api/debate（SSE 流式）
入参/出参约定见根目录 AGENTS.md 第 6 节。

当前为空，阶段 1 先在本地脚本里验证 runDebate 逻辑，
阶段 2 再迁移进这里包装成正式接口。
