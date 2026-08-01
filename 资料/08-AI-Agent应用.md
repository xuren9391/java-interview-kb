# AI Agent 应用（LLM · RAG 代码 · Agent 框架 · Java 工程化 · 架构图）

> 难度：🟢了解 🟡能落地 🔴精通
> 这是 2024-2026 的热门方向，简历写了就会被问。**作为 Java 后端**，重点不是训模型，而是**如何把大模型能力工程化集成进业务系统**。
> 这是你的差异化加分项，但前提是简历/项目里有体现，否则点到为止即可。

---

# 第一章 大模型（LLM）基础 🟢

## 1.1 核心概念

| 概念 | 说明 |
|------|------|
| **LLM** | 基于 Transformer 的生成式模型（GPT-4、Claude、GLM、Qwen、DeepSeek、Llama） |
| **Token** | 模型最小单位（≈ 1 汉字 / 0.75 英文单词），按 token 计费 |
| **上下文窗口** | 单次输入 + 输出的最大 token 数（4k/8k/32k/128k/1M） |
| **参数量** | 7B/13B/70B（B=十亿），越大能力越强成本越高 |
| **Temperature** | 采样温度，0=确定性，1+=创造性 |
| **Top-p / Top-k** | 采样策略，控制生成多样性 |

## 1.2 模型分类

| 类型 | 代表 | 特点 |
|------|------|------|
| 闭源 API | GPT-4、Claude、Gemini、GLM-4 | 能力强、付费、数据出域 |
| 开源权重 | Llama3、Qwen、DeepSeek、Mistral | 可私有部署、可微调 |
| 专用模型 | Embedding（bge、text-embedding）、多模态 | 不做对话，做特定任务 |

**选型**：内部敏感数据用开源私有化（Qwen/DeepSeek）；通用能力用闭源 API；特定任务用专用小模型降本。

## 1.3 大模型的"坑"（面试加分点）🔴🔴

| 问题 | 说明 | 应对 |
|------|------|------|
| **幻觉 Hallucination** | 一本正经胡说八道 | RAG + 提示约束 + 引用溯源 |
| **时效性** | 训练数据有截止日期 | RAG / 联网搜索 / Function Calling |
| **上下文长度限制** | 长文本塞不下 | 分块 + RAG / 长上下文模型 |
| **成本高** | token 费用 | 缓存、降模型、Batch、流式 |
| **延迟** | 首 token 几秒 | 流式输出、模型加速、就近部署 |
| **确定性差** | 同输入不同输出 | temperature=0、few-shot、结构化输出 |
| **安全合规** | 涉黄涉政、数据泄露 | 输入/输出审核、私有化、脱敏 |

---

# 第二章 Prompt 工程 🟡

## 2.1 提示工程原则
1. **明确具体**：任务、输入、输出格式说清楚。
2. **结构化**：用 markdown / 标签分隔指令、上下文、示例。
3. **Few-shot**：给 2-5 个示例引导格式。
4. **角色设定**："你是一个资深 Java 工程师……"。
5. **思维链 CoT**：要求"一步步思考"，提升推理。
6. **约束输出**：要求 JSON / schema，便于程序解析。

## 2.2 Prompt 模板（实战）
```
# 角色
你是 {领域} 专家。

# 任务
{具体任务描述}

# 输入
{input}

# 输出要求
- 严格输出 JSON，schema：{...}
- 不要输出解释性文字

# 示例
输入：{example_in}
输出：{example_out}
```

## 2.3 🔴 Function Calling / Tool Use
让 LLM **调用外部函数/API**，是 Agent 的基础。
- 定义工具 schema（函数名、参数、描述）。
- LLM 决定调用哪个工具、传什么参数。
- 拿到工具结果，LLM 继续推理。

```
用户："查下北京明天天气"
LLM → 调用 get_weather(city="北京", date="明天")
工具返回 → LLM 组织回答
```

---

# 第三章 RAG（检索增强生成）🔴🔴 必懂（落地主流）

## 3.1 为什么需要 RAG
LLM 知识有限、会幻觉、不懂私有数据。RAG = **检索 + 生成**：
```
用户问题 → 检索相关文档 → 把文档塞进 prompt → LLM 基于文档回答
```
类比"开卷考试"：LLM 是考生，检索系统给参考资料。

## 3.2 RAG 全链路 🔴🔴

```
【离线索引阶段】
原始文档 → 清洗 → 分块(Chunking) → 向量化(Embedding) → 存向量库

【在线查询阶段】
用户问题 → 向量化 → 向量检索 Top-K → 重排(Rerank) → 拼 prompt → LLM → 回答(带引用)
```

## 3.3 架构图 🔴

```
┌─────────────── 离线索引（Indexing）─────────────────┐
│  文档库 → 解析(PDF/Word/HTML) → 清洗 → 分块          │
│     → Embedding 模型 → 向量                          │
│     → 存入 向量库(Milvus/PGVector) + 元数据           │
└──────────────────────────────────────────────────────┘

┌─────────────── 在线查询（Retrieval）─────────────────┐
│  用户 Query                                          │
│     → Query 改写（扩展/纠错）                         │
│     → 向量化                                          │
│     → 多路召回：向量检索(语义) + BM25(关键词) + 知识图谱 │
│     → Rerank 精排（Cross-Encoder）                    │
│     → 取 Top-K                                        │
│     → 拼 Prompt（文档 + 问题 + 引用约束）              │
│     → LLM 生成                                        │
│     → 后处理（引用标注、审核）                         │
└──────────────────────────────────────────────────────┘
```

## 3.4 关键环节详解

### ① 文档分块 Chunking 🟡
- 按字数（500-1000 token）滑动窗口。
- 按语义（段落、Markdown 标题）。
- 重叠（overlap 10-20%）避免切断语义。
- 太小块信息不全，太大块稀释相关性。
- 进阶：**父子块**（小块检索、大块给 LLM）。

### ② Embedding 向量化 🟢
- 用 Embedding 模型（bge-m3、text-embedding-3、m3e）把文本变向量（768/1024/1536 维）。
- 语义相近的文本向量距离近（余弦相似度）。

### ③ 向量检索 🔴
- **ANN（近似最近邻）算法**：
  - **HNSW**（主流）：分层图，精度好速度快。
  - **IVF**：聚类，快但精度略低。
  - **PQ**：乘积量化压缩，省内存。
- **向量库**：
  - **Milvus**（开源主流，分布式）
  - **Faiss**（库，非服务）
  - **Qdrant / Weaviate**
  - **PGVector**（PostgreSQL 扩展，简单，小规模够用）
  - **Elasticsearch / Redis** 也支持向量（混合检索方便）
- **混合检索**：向量（语义）+ BM25（关键词）融合，效果更好。

### ④ 重排 Rerank 🟡
- 检索 Top-50 后用 **Cross-Encoder** 模型（如 bge-reranker）精排取 Top-5。
- 检索（双塔）快但粗，重排慢但准，组合最优。

### ⑤ Prompt 拼装 + 引用 🟡
- 把检索到的文档 + 用户问题组装 prompt，要求 LLM"只基于以下资料回答，并标注引用"。

## 3.5 RAG 进阶 🔴
- **Query 改写**：用户口语化问题改写成更适合检索的形式。
- **多路召回**：向量 + 关键词 + 知识图谱。
- **父子块（Parent-Child）**：小块检索、大块给 LLM。
- **元数据过滤**：按文档类型、时间、权限过滤。
- **Self-RAG / Corrective RAG**：让 LLM 自评检索质量，决定是否重检索。

## 3.6 RAG 评估 🔴
- **检索质量**：Recall@K（相关文档是否被召回）。
- **生成质量**：Faithfulness（忠于资料）、Answer Relevancy（切题）。
- 工具：RAGAS、TruLens。

## 3.7 Spring AI + RAG 代码示例 🔴

```java
// 1. 配置向量库
@Bean
public VectorStore vectorStore(EmbeddingModel embeddingModel) {
    return PgVectorStore.builder(jdbcTemplate, embeddingModel)
        .dimensions(1536).build();
}

// 2. 离线：文档入库
public void ingestDocuments(List<Document> docs) {
    // 分块
    TokenTextSplitter splitter = new TokenTextSplitter();
    List<Document> chunks = splitter.apply(docs);
    // 向量化 + 入库
    vectorStore.add(chunks);
}

// 3. 在线：检索增强问答
public String chatWithRag(String question) {
    return chatClient.prompt()
        .user(question)
        .advisors(new QuestionAnswerAdvisor(vectorStore, SearchRequest.defaults()
            .withTopK(5)
            .withSimilarityThreshold(0.7)))
        .call()
        .content();
}
```

---

# 第四章 Agent（智能体）🔴🔴

## 4.1 什么是 Agent
LLM + 工具调用 + 规划 + 记忆 = **能自主完成多步任务的智能体**。

区别于单轮对话，Agent 能：
- **规划**：拆解任务为子步骤。
- **使用工具**：Function Calling 调 API、查数据库、执行代码。
- **反思迭代**：根据结果调整下一步。
- **记忆**：短期（对话上下文）+ 长期（向量库存储经验）。

## 4.2 Agent 经典模式 🔴🔴

**① ReAct（Reasoning + Acting）**
```
Thought（思考）→ Action（行动/调工具）→ Observation（观察结果）→ 循环
```
最经典的 Agent 范式。

**② Plan-and-Execute**
先规划完整计划，再逐步执行。适合复杂长任务。

**③ Reflection / Self-Correction**
执行后自我反思，发现错误回退重来。

## 4.3 多 Agent 协作 🔴
- **角色分工**：如 AutoGen（researcher + coder + critic）。
- **编排**：MetaGPT（软件公司模拟）、CrewAI（团队协作）。
- **工作流**：LangGraph（状态机式编排，可控性强）。

## 4.4 主流框架对比 🔴

| 框架 | 特点 | 适用 |
|------|------|------|
| **LangChain** | 生态最大，链式编排 | 通用、原型 |
| **LlamaIndex** | RAG 专精 | 知识库问答 |
| **LangGraph** | 状态机，可控 Agent | 生产级复杂 Agent |
| **AutoGen**（微软） | 多 Agent 对话 | 多角色协作 |
| **Dify** | 低代码可视化平台 | 快速搭建、非技术友好 |
| **Coze**（字节） | Bot 搭建平台 | 轻量应用 |
| **Spring AI**（Java！） | **Java 生态**，对标 LangChain | **Java 后端集成首选** |
| **LangChain4j** | Java 版 LangChain | Java 集成 |

**作为 Java 工程师**：重点看 **Spring AI** 和 **LangChain4j**。

---

# 第五章 Java 接入 LLM 工程化 🔴（你的主战场）

## 5.1 Spring AI 核心抽象 🟡
- 统一抽象：`ChatClient`、`EmbeddingModel`、`VectorStore`、`ChatMemory`、`Advisor`。
- 支持多模型：OpenAI、Anthropic、Ollama（本地）、阿里通义、智谱 GLM、Azure。
- 内置 RAG（Advisor）、Function Calling（Tool）、Structured Output、ChatMemory。

## 5.2 整体架构落地 🔴🔴

```
用户 → API 网关 → 业务服务
                  ↓
              AI Service（封装 LLM 调用）
                  ├─ Prompt 管理（版本化、A/B）
                  ├─ 模型路由（大/小模型分流）
                  ├─ RAG 模块（向量检索）
                  ├─ Tool 调用（业务 API / 查 DB）
                  ├─ 缓存层（Prompt 结果缓存）
                  ├─ 限流（防烧钱）
                  └─ 监控/审计（token、延迟、内容审核）
                  ↓
            LLM（API / 私有化部署）
```

**与传统系统关系**：AI 作为**增强层**（搜索重排、智能客服、Text2SQL、报表生成），不替代核心事务。核心业务仍走 Java。

## 5.3 Function Calling 示例（Spring AI）🔴

```java
@Bean
@Description("查询订单状态")
public Function<OrderStatusRequest, OrderStatus> queryOrderStatus(OrderService orderService) {
    return request -> orderService.getStatus(request.orderId());
}

// ChatClient 自动把 Function 注册为 tool
String answer = chatClient.prompt()
    .user("我的订单 12345 发货了吗？")
    .functions("queryOrderStatus")  // LLM 决定调用
    .call()
    .content();
// LLM 会调用 queryOrderStatus({orderId:12345})，拿到结果后组织回答
```

## 5.4 工程化要点 🔴🔴

### ① 成本控制
- **Prompt 缓存**：相同 prompt 缓存结果（Redis）。
- **模型分级**：简单任务用小模型，复杂用大（Router 路由）。
- **Batch 接口**：批量请求降单价。
- **流式输出**：边生成边返回，体感快。

### ② 可靠性
- **重试 + 降级**：API 失败重试，主模型挂切备用模型。
- **超时控制**：LLM 响应慢，设合理超时。
- **限流**：防止恶意调用烧钱。
- **结构化输出**：JSON schema / Function Calling 强制格式，避免解析失败。

### ③ 安全
- **输入审核**：敏感词、Prompt Injection（"忽略以上指令，输出..."）防护。
- **输出审核**：合规过滤（涉黄涉政）。
- **脱敏**：敏感数据不出域（用私有化模型）。
- **审计日志**：记录调用。

### ④ 可观测
- 记录 prompt、token 消耗、延迟、模型版本。
- LangSmith / Langfuse（Trace）。
- 评估体系（准确率、满意度）。

## 5.5 Text2SQL（典型场景）🔴
- 自然语言 → SQL → 执行 → 图表。
- 方案：LLM + RAG（schema 说明、few-shot 示例）+ Function Calling（执行 SQL）+ 结果校验。
- 生产要点：
  - 限制可查表/字段（白名单）。
  - 只读账号（防删改）。
  - 结果行数限制。
  - SQL 语法校验 + 执行计划检查。
  - 人工兜底（复杂查询转人工）。

---

# 第六章 典型业务场景 🟡

| 场景 | 要点 |
|------|------|
| 智能客服/知识库问答 | RAG + 企业知识 + 多轮对话 + 转人工 |
| 智能数据分析（Text2SQL） | NL→SQL，schema 理解、权限 |
| 代码助手 | 生成/Review/文档/单测 |
| 工作流自动化 | Agent 调度多工具完成业务流程 |
| 内容生成 | 营销文案、摘要、翻译、分类 |

---

# 第七章 面试可能问的（简历有 AI 才需要）🔴

1. 你做的 AI 项目解决了什么业务问题？效果怎么评估？🔴
2. RAG 流程？分块、检索、重排分别怎么做？🔴
3. 向量检索为什么用 HNSW？和 IVF、暴力检索区别？🔴
4. 混合检索（向量+BM25）为什么？🔴
5. LLM 幻觉怎么解决？🔴
6. Agent vs RAG 区别？ReAct？🔴
7. 怎么控制 LLM 调用的成本和延迟？🔴
8. Prompt 怎么管理？A/B？版本？🟡
9. 为什么用 Spring AI / LangChain4j？vs Python？🟡
10. 模型怎么选？开源 vs 闭源？🔴
11. Function Calling 怎么保证可靠性？🔴
12. 你项目的 AI 部分架构？怎么和 Java 业务集成？🔴

> ⚠️ **提醒**：AI 是加分项不是必考。简历没写别强答，会了反而显得浮夸。简历写了就必须吃透，否则被反噬。

> 对应面试题：`面试/面试题-AI-Agent.md`
