# 改动日志 · 圆桌 Roundtable

> 每次 Claude 协助改动代码/人物卡/脚本，都会在这里加一条新记录，方便随时核对"改了什么、为什么改"。
> 格式：日期 + 改动摘要 + 涉及文件 + 原因（如果是修bug，注明触发条件）

---

## 2026-08-30

### 项目初始化
- 建立仓库骨架：`api/` `src/` `characters/` `public/` 目录结构
- 新建 `AGENTS.md`：产品逻辑与工程约定对齐文档
- 新建 `.gitignore` `.env.example` `README.md`

### 人物名单确定
- 最终8位：尼采、马基雅维利（替苏格拉底）、Steve Jobs（替爱比克泰德）、波伏娃、芒格、苏轼（替老子）、拿破仑（替荣格）、卡尔·马克思（替简·奥斯汀）
- 同步更新 `AGENTS.md` 人物名单表

### 8张人物卡完成（`characters/*.json`）
- `nietzsche.json` `machiavelli.json` `jobs.json` `beauvoir.json` `munger.json` MVP 5张
- `su_shi.json` `napoleon.json` `marx.json` 扩展3张
- 修订：苏轼补充苏辙/苏洵/交游线（原版遗漏，直接影响其"心安处是吾乡"世界观的重要支撑）；马克思删除私生子细节（与其经济学论证无实质关联），改为议会"蓝皮书"取证方式+陪女儿玩角色扮演游戏+莎士比亚爱好（与其严谨论证风格/私下温情面更直接相关）

### 测试脚本迭代（`scripts/test-debate.mjs`）
- 从0搭建：读人物卡拼system prompt，跑开场轮+交锋轮，调用Claude API
- 修复：`max_tokens`从400→700→1000（中文token开销+JSON格式开销导致多次截断）
- 修复：交锋轮指令改为"只能回应一人一句话，不能同时怼多人"（避免发言过长+跑题）
- 新增：结尾必须重申问题本身立场的硬性要求（防止讨论滑向纯案例拉锯）
- 新增：私有记忆机制（每次发言同时产出公开发言+内心活动，后者只喂给角色自己）
- 修复：私有记忆指令去掉"情绪必须累积升级"的偏向性表述，改为如实反映当下情境
- 输出格式几经调整：JSON → 分隔符标记 → 改回JSON+禁止英文直引号+正则抢救兜底（角色发言爱用引号强调，与JSON转义冲突，最终方案是禁止模型使用英文直引号）
- 新增：方式C"结盟"选项 + relations字段里正面认可部分要认真对待的提醒（此前relations多为"认可+但+批评"句式，导致辩论清一色互怼、从未出现结盟）
- 新增：完整轮次控制（标准3-4轮，可用`DEBATE_ROUNDS`环境变量调）+ 收尾高光生成（规则打分选句`pickTopLines` + 轻量压缩改写`compressToAdvice`，不发起新的总结陈词LLM调用）
- 新增：题目支持`DEBATE_QUESTION`环境变量覆盖，角色组合支持命令行参数指定

### 正式后端接口（`api/debate.js`）
- 新建：把`test-debate.mjs`验证过的核心逻辑包装成正式的`POST /api/debate`，Vercel Serverless Function，SSE流式返回
- 新增：`response_type`（rebut/ally/advance）+ `target`结构化输出，供后端拼出前端需要的`tag`字符串（如"反驳 尼采"），对应PRD"标签来自系统分类，不改变角色语言本身"的要求
- SSE事件类型：`speech`（发言）、`banner`（建议收尾）、`advice`（收尾高光）、`done`（结束）、`error`（出错）
- 已知待办：用户实时插话机制暂未接入（PRD本身也把这个列为MVP可选项），当前只支持"我已有答案"按钮直接中断连接跳转收尾屏

### 前端（Kimi生成，非Claude产出）
- 技术栈对齐AGENTS.md：React + Vite + TS + Tailwind + html2canvas
- 视觉方向由用户另行确定为"柯布西耶风格"（非PRD原定的深空霓虹未来复古风，为用户主动选择的新方向）
- 已知问题：`DebateScreen.tsx`目前是完全预写死的剧本（`characters.ts`里`opening`/`clashes`/`replyUser`/`advice`都是固定文本），需要重构为消费`/api/debate`的真实流式数据，这是下一步工作
