# 面试题 - AI Agent（LLM / RAG / Agent）

> ⚠️ **重要前提**：AI 是加分项不是必考。
> - 如果简历/项目**没写 AI**，被问到只要说清 RAG/Agent 基本概念、知道 Java 怎么集成即可，别强答。
> - 如果简历**写了 AI 项目**，这块会被深挖，必须吃透。
> 配套知识点：`资料/08-AI-Agent应用.md`

---

## 一、LLM 基础

### Q1 🟡 LLM 是什么？Token、上下文窗口、参数量？

- **LLM**：基于 Transformer 的生成式模型（GPT-4、Claude、GLM、Qwen、DeepSeek、Llama）。
- **Token**：模型最小单位（≈ 1 汉字 / 0.75 英文单词），按 token 计费。
- **上下文窗口**：单次输入+输出最大 token（4k/8k/32k/128k/1M）。
- **参数量**：7B/13B/70B（B=十亿），越大能力越强成本越高。

---

### Q2 🔴 大模型的"坑"有哪些？怎么应对？

| 问题 | 应对 |
|------|------|
| 幻觉（胡说八道） | RAG + 提示约束 + 引用溯源 |
| 时效性（知识截止） | RAG / 联网搜索 / Function Calling |
| 上下文长度限制 | 分块 + RAG / 长上下文模型 |
| 成本高 | 缓存、降模型、Batch、流式 |
| 延迟（首 token 慢） | 流式输出、模型加速、就近部署 |
| 确定性差 | temperature=0、few-shot、结构化输出 |
| 安全合规 | 输入/输出审核、私有化、脱敏 |

---

### Q3 🟡 闭源 API vs 开源私有化怎么选？

- **闭源 API**（GPT-4/Claude）：能力强，但数据出域、付费。适合通用场景、非敏感数据。
- **开源私有化**（Qwen/DeepSeek/Llama）：数据不出域、可微调、免费。适合敏感数据、内部场景、特定任务微调降本。
- **专用小模型**（Embedding/Rerank）：不做对话，做特定任务，成本极低。

---

## 二、Prompt 工程

### Q4 🟡 Prompt 工程原则？

1. 明确具体（任务、输入、输出格式）。
2. 结构化（markdown / 标签分隔）。
3. Few-shot（2-5 个示例）。
4. 角色设定。
5. 思维链（CoT，"一步步思考"）。
6. 约束输出（JSON schema）。

---

### Q5 🔴 Function Calling / Tool Use 是什么？

- 定义工具 schema（函数名、参数、描述）。
- LLM 决定调哪个工具、传什么参数。
- 拿到工具结果，LLM 继续推理。

是 **Agent 的基础**——让 LLM 能调外部 API / 查库 / 执行代码。

---

## 三、RAG（必懂，落地主流）

### Q6 🔴🔴 RAG 全流程？

```
【离线】文档 → 清洗 → 分块(Chunking) → 向量化(Embedding) → 存向量库
【在线】问题 → 向量化 → 向量检索 Top-K → 重排(Rerank) → 拼 prompt → LLM → 回答(带引用)
```

类比"开卷考试"：LLM 是考生，检索给参考资料，解决幻觉 + 私有数据 + 时效性。

---

### Q7 🔴 分块 Chunking 怎么做？

- 按字数（500-1000 token）滑动窗口。
- 按语义（段落、Markdown 标题）。
- 重叠 10-20% 避免切断语义。
- 太小信息不全，太大稀释相关性。
- 进阶：父子块（小块检索、大块给 LLM）。

---

### Q8 🔴 向量检索原理？为什么用 HNSW？

- **Embedding**：文本 → 向量（768/1024/1536 维），语义相近距离近（余弦相似度）。
- **ANN 近似最近邻算法**：
  - **HNSW**（主流）：分层图，精度好速度快。
  - IVF：聚类，快但精度略低。
  - PQ：乘积量化压缩，省内存。
- **向量库**：Milvus（开源主流）/ Faiss（库）/ Qdrant / PGVector（PG 扩展，简单）。

---

### Q9 🟡 为什么需要重排 Rerank？

- 向量检索**快但粗**（双塔模型，query 和 doc 独立编码）。
- **Cross-Encoder 重排慢但准**（query 和 doc 一起编码）。
- 组合：检索 Top-50 → Rerank 精排取 Top-5，效果最优。

---

### Q10 🔴 混合检索？

- **向量**（语义）+ **BM25**（关键词）融合。
- 用户 query 可能含专有名词/缩写，向量检索效果差，BM25 补足。
- RRF（Reciprocal Rank Fusion）融合两路结果。

---

### Q11 🟡 RAG 评估指标？

- **检索质量**：Recall@K（相关文档是否召回）。
- **生成质量**：Faithfulness（忠于资料）、Answer Relevancy（切题）。
- 工具：RAGAS、TruLens。

---

## 四、Agent

### Q12 🔴🔴 Agent 和 RAG 区别？ReAct？

- **RAG**：检索 + 生成，单轮问答增强。
- **Agent**：LLM + 工具 + 规划 + 记忆，能自主完成多步任务。

**ReAct**（Reasoning + Acting）：Thought → Action（调工具） → Observation → 循环。最经典 Agent 范式。

**其他模式**：
- Plan-and-Execute：先规划全计划再执行。
- Reflection：执行后反思，发现错误回退。

---

### Q13 🔴 多 Agent 协作？

- 角色分工（AutoGen：researcher + coder + critic）。
- 编排（MetaGPT 软件公司模拟、CrewAI 团队协作）。
- **LangGraph**：状态机式编排，可控性强，适合生产。

---

### Q14 🔴 主流 Agent 框架？Java 怎么选？

| 框架 | 特点 |
|------|------|
| LangChain | 生态最大，通用原型 |
| LlamaIndex | RAG 专精 |
| LangGraph | 状态机，生产级 |
| AutoGen（微软） | 多 Agent |
| Dify | 低代码可视化 |
| Coze（字节） | Bot 平台 |
| **Spring AI** | **Java 生态，对标 LangChain** |
| **LangChain4j** | Java 版 LangChain |

**Java 后端首选**：Spring AI（Spring Boot 无缝集成）或 LangChain4j。

---

## 五、Java 工程化（你的主战场）

### Q15 🔴🔴 你怎么把 LLM 集成进 Java 业务系统？

**架构**：
```
用户 → API 网关 → 业务服务 → AI Service（封装 LLM）
                              ├─ Prompt 管理（版本化、A/B）
                              ├─ 模型路由（大/小分流）
                              ├─ RAG（向量检索）
                              ├─ Tool 调用（业务 API）
                              ├─ 缓存层
                              └─ 监控/审计
                              ↓
                          LLM（API / 私有化）
```

**集成方式**：Spring AI（`ChatClient`/`EmbeddingModel`/`VectorStore`，支持 OpenAI/Ollama/通义/GLM）或 LangChain4j。

**与传统系统关系**：AI 作为**增强层**（搜索重排、智能客服、Text2SQL、报表生成），不替代核心事务。核心业务仍走 Java。

---

### Q16 🔴🔴 怎么控制 LLM 调用的成本和延迟？

**成本**：
- **Prompt 缓存**：相同 prompt 缓存结果（Redis）。
- **模型分级**：简单任务用小模型，复杂用大（Router 分流）。
- **Batch 接口**：批量请求降单价。
- **流式输出**：边生成边返回，体感快。

**延迟**：
- 流式输出（首 token 快）。
- 模型加速（vLLM/TensorRT-LLM）。
- 就近部署。
- 超时控制 + 重试 + 降级备用模型。

---

### Q17 🔴 怎么保证 LLM 调用可靠性？

- **重试 + 降级**：API 失败重试，主模型挂切备用。
- **超时控制**：LLM 慢，设合理超时。
- **限流**：防恶意烧钱。
- **结构化输出**：JSON schema / Function Calling 强制格式，防解析失败。
- **安全**：输入审核（Prompt Injection 防护）、输出审核、脱敏、私有化、审计日志。

---

### Q18 🟡 Prompt 怎么管理？

- 版本化（Git 管理 prompt 模板）。
- A/B 测试（不同 prompt 对比效果）。
- 评估（准确率、满意度）。
- 配置化（运行时调整不重启）。

---

## 六、场景题（简历有 AI 项目会被问）

### Q19 🔴 你做的 AI 项目解决了什么业务问题？怎么评估效果？

**回答模板（STAR）**：
- **S 背景**：客服人力成本高 / 知识检索慢 / 报表生成耗时。
- **T 任务**：用 AI 降本提效。
- **A 行动**：
  - 选型：私有化 Qwen（数据敏感）+ Milvus 向量库 + Spring AI 集成。
  - RAG：企业文档分块 → Embedding → 向量检索 + BM25 混合 → Rerank。
  - 工程：Prompt 缓存（命中率 40%）+ 模型分级（简单走小模型省 60% 成本）。
- **R 结果**：准确率 85%，响应 <3s，月省 X 万，覆盖 N% 工单。

---

### Q20 🔴 Text2SQL 怎么做？

- 难点：复杂 SQL 准确率、schema 理解、权限。
- 方案：LLM + RAG（schema 说明、few-shot 示例）+ Function Calling（执行 SQL）+ 结果校验。
- 生产：限制可查表/字段、只读账号、结果白名单校验、人工兜底。

---

## 自测重点（简历有 AI 才需要）

- [ ] RAG 全流程 + 每个环节的作用
- [ ] 向量检索 HNSW + 为什么需要 Rerank
- [ ] Agent vs RAG + ReAct
- [ ] Java 集成架构（Spring AI）
- [ ] 成本/延迟/可靠性控制
- [ ] 幻觉怎么解决
- [ ] 闭源 vs 开源选型
- [ ] 自己 AI 项目的 STAR 话术（量化效果）

> 💡 再次提醒：AI 是加分项。简历没写别强答，会了反而显得浮夸。简历写了就必须吃透，否则被反噬。
