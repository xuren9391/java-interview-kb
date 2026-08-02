# AI Agent 应用（LLM · RAG 全链路 · Agent · Java 工程化 · 深度案例）

> 难度：🟢了解 🟡能落地 🔴精通
> 这是 2024-2026 的热门方向，简历写了就会被问。**作为 Java 后端**，重点不是训模型，而是**如何把大模型能力工程化集成进业务系统**。
> **本文档重点：深度案例讲解**（含完整代码、架构图、踩坑、效果数据），让你面试能讲出"我做过、踩过这些坑、量化了这些效果"。

---

# 第一章 大模型（LLM）基础

## 1.1 核心概念

| 概念 | 说明 |
|------|------|
| **LLM** | 基于 Transformer 的生成式模型（GPT-4、Claude、GLM、Qwen、DeepSeek、Llama） |
| **Token** | 模型最小单位（≈ 1 汉字 / 0.75 英文单词），按 token 计费 |
| **上下文窗口** | 单次输入 + 输出的最大 token 数（4k/8k/32k/128k/1M） |
| **参数量** | 7B/13B/70B（B=十亿），越大能力越强成本越高 |
| **Temperature** | 采样温度，0=确定性，1+=创造性 |
| **Top-p / Top-k** | 采样策略，控制生成多样性 |

## 1.2 模型分类与选型

| 类型 | 代表 | 特点 | 适用 |
|------|------|------|------|
| 闭源 API | GPT-4、Claude、Gemini、GLM-4 | 能力强、付费、数据出域 | 通用场景、非敏感数据 |
| 开源权重 | Llama3、Qwen、DeepSeek、Mistral | 可私有部署、可微调、免费 | 敏感数据、内部场景、降本 |
| 专用模型 | Embedding（bge-m3）、Rerank（bge-reranker） | 不做对话，做特定任务 | RAG 的向量化/重排 |

**选型决策树** 🔴：
```
数据敏感吗？
├─ 是（内部文档/客户数据）→ 开源私有化（Qwen/DeepSeek）
└─ 否 → 需要顶级能力吗？
        ├─ 是 → GPT-4 / Claude
        └─ 否（降本）→ 开源 API（通义/智谱）或小模型
```

## 1.3 大模型的"坑"（面试加分点）🔴

| 问题 | 说明 | 应对 |
|------|------|------|
| **幻觉** | 一本正经胡说八道 | RAG + 提示约束 + 引用溯源 |
| **时效性** | 训练数据有截止日期 | RAG / 联网搜索 / Function Calling |
| **上下文长度限制** | 长文本塞不下 | 分块 + RAG / 长上下文模型 |
| **成本高** | token 费用 | 缓存、降模型、Batch、流式 |
| **延迟** | 首 token 几秒 | 流式输出、模型加速、就近部署 |
| **确定性差** | 同输入不同输出 | temperature=0、few-shot、结构化输出 |
| **安全合规** | 涉黄涉政、数据泄露 | 输入/输出审核、私有化、脱敏 |

---

# 第二章 Prompt 工程

## 2.1 提示工程原则
1. **明确具体**：任务、输入、输出格式说清楚。
2. **结构化**：用 markdown / 标签分隔指令、上下文、示例。
3. **Few-shot**：给 2-5 个示例引导格式。
4. **角色设定**："你是资深 Java 工程师……"。
5. **思维链 CoT**：要求"一步步思考"，提升推理。
6. **约束输出**：JSON / schema，便于程序解析。

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

---

# 第三章 RAG（检索增强生成）🔴 必懂

## 3.1 为什么需要 RAG
LLM 知识有限、会幻觉、不懂私有数据。RAG = **检索 + 生成**：
```
用户问题 → 检索相关文档 → 把文档塞进 prompt → LLM 基于文档回答
```
类比"开卷考试"：LLM 是考生，检索系统给参考资料。

## 3.2 RAG 全链路架构图 🔴

```
┌─────────────── 离线索引（Indexing）─────────────────┐
│  文档库 → 解析(PDF/Word/HTML) → 清洗 → 分块          │
│     → Embedding 模型 → 向量                          │
│     → 存入 向量库(Milvus/PGVector) + 元数据           │
└──────────────────────────────────────────────────────┘

┌─────────────── 在线查询（Retrieval）─────────────────┐
│  用户 Query                                          │
│     → Query 改写（扩展/纠错/HyDE）                    │
│     → 向量化                                          │
│     → 多路召回：向量检索(语义) + BM25(关键词) + 知识图谱 │
│     → Rerank 精排（Cross-Encoder）                    │
│     → 取 Top-K                                        │
│     → 拼 Prompt（文档 + 问题 + 引用约束）              │
│     → LLM 生成                                        │
│     → 后处理（引用标注、审核）                         │
└──────────────────────────────────────────────────────┘
```

## 3.3 关键环节详解

### ① 文档分块 Chunking 🟡
- 按字数（500-1000 token）滑动窗口。
- 按语义（段落、Markdown 标题）。
- 重叠（overlap 10-20%）避免切断语义。
- 太小信息不全，太大块稀释相关性。
- 进阶：**父子块**（小块检索、大块给 LLM）。

### ② Embedding 向量化 🟢
- 用 Embedding 模型（bge-m3、text-embedding-3、m3e）把文本变向量。
- 语义相近的文本向量距离近（余弦相似度）。

### ③ 向量检索 🔴
- **ANN 算法**：HNSW（主流，精度好）、IVF（聚类，快）、PQ（压缩省内存）。
- **向量库**：Milvus（分布式主流）、Faiss（库）、Qdrant、PGVector（PG 扩展，小规模）。
- **混合检索**：向量（语义）+ BM25（关键词）融合，效果更好。

### ④ 重排 Rerank 🟡
- 检索 Top-50 后用 **Cross-Encoder**（如 bge-reranker）精排取 Top-5。
- 检索（双塔）快但粗，重排慢但准，组合最优。

## 3.4 RAG 进阶 🔴
- **Query 改写**：口语化问题改成更适合检索的形式；**HyDE**（先让 LLM 生成假设答案再检索）。
- **多路召回**：向量 + 关键词 + 知识图谱。
- **父子块（Parent-Child）**：小块检索、大块给 LLM。
- **元数据过滤**：按文档类型、时间、权限过滤。
- **Self-RAG / Corrective RAG**：让 LLM 自评检索质量，决定是否重检索。

## 3.5 RAG 评估 🔴
- **检索质量**：Recall@K（相关文档是否被召回）。
- **生成质量**：Faithfulness（忠于资料）、Answer Relevancy（切题）。
- 工具：RAGAS、TruLens。

---

# 第四章 Agent（智能体）

## 4.1 什么是 Agent
LLM + 工具调用 + 规划 + 记忆 = **能自主完成多步任务的智能体**。

## 4.2 Agent 经典模式 🔴
- **ReAct**（Thought → Action → Observation 循环）。
- **Plan-and-Execute**（先规划全计划再执行）。
- **Reflection**（执行后反思，发现错误回退）。

## 4.3 主流框架 🔴
| 框架 | 特点 | 适用 |
|------|------|------|
| LangChain | 生态最大 | 通用原型 |
| LlamaIndex | RAG 专精 | 知识库问答 |
| LangGraph | 状态机，可控 | 生产级 Agent |
| **Spring AI** | **Java 生态** | **Java 后端集成首选** |
| **LangChain4j** | Java 版 LangChain | Java 集成 |

---

# 第五章 深度案例讲解 🔴🔴（面试加分核心）

> 这章是本文档的重点。每个案例按「背景 → 架构 → 核心代码 → 踩坑 → 效果」讲，让你面试能讲出深度。

## 案例一：企业知识库智能问答（RAG 经典落地）

### 📌 背景
某公司内部有大量文档（产品文档、技术规范、FAQ、历史工单），员工查找效率低。传统搜索（ES 关键词）召回不准、无法理解自然语言提问。

### 🏗️ 架构
```
【离线】
内部文档(PDF/Word/Confluence/工单)
  → 文档解析(unstructured/PdfBox)
  → 清洗(去水印/格式化)
  → 分块(TokenTextSplitter, 500 token, overlap 50)
  → Embedding(bge-m3, 1024 维)
  → 存 Milvus + 元数据(部门/权限/时间)

【在线】
员工提问
  → Query 改写(LLM 把口语改规范)
  → 多路召回：向量(Milvus Top 20) + BM25(Top 20) → RRF 融合
  → Rerank(bge-reranker-large 精排取 Top 5)
  → 权限过滤(只取该员工有权限的)
  → 拼 Prompt(资料 + 引用约束)
  → LLM(Qwen-72B 私有化) 生成
  → 引用标注(返回每个论据的文档出处)
```

### 💻 核心代码（Spring AI）
```java
@Service
public class KnowledgeQAService {
    private final ChatClient chatClient;
    private final VectorStore vectorStore;
    private final SearchService searchService; // BM25 检索
    private final RerankService rerankService;

    public AnswerResult answer(String question, User user) {
        // 1. Query 改写
        String rewritten = queryRewrite(question);

        // 2. 多路召回
        List<Document> vectorHits = vectorStore.similaritySearch(
            SearchRequest.query(rewritten).withTopK(20).withSimilarityThreshold(0.6));
        List<Document> bm25Hits = searchService.bm25Search(rewritten, 20);

        // 3. RRF 融合
        List<Document> merged = rrfMerge(vectorHits, bm25Hits);

        // 4. Rerank 精排
        List<Document> reranked = rerankService.rerank(rewritten, merged, 5);

        // 5. 权限过滤
        List<Document> accessible = reranked.stream()
            .filter(d -> user.canAccess(d.getMetadata().get("dept")))
            .collect(toList());

        // 6. 生成 + 引用
        String context = buildContextWithCitations(accessible);
        String answer = chatClient.prompt()
            .system("基于以下资料回答，每个论据标注[文档名]出处，资料没有就说不知道")
            .user(question + "\n\n资料：\n" + context)
            .call()
            .content();

        return new AnswerResult(answer, extractCitations(accessible));
    }
}
```

### 🕳️ 踩坑与解决 🔴

**坑 1：分块太大导致检索稀释**
- 现象：一个 2000 token 的块里只有一小段相关，但整块都作为上下文，LLM 被无关内容干扰。
- 解决：改用**父子块**——用小块（200 token）检索，命中后取其所属大块（1000 token）给 LLM。

**坑 2：专业术语召回不准**
- 现象："K8s 节点调度" 检索不到写 "Kubernetes pod 调度" 的文档（语义近但用词不同）。
- 解决：① 同义词词典扩充 query；② bge-m3 多语言模型对中英混合友好；③ 加 BM25 补关键词召回。

**坑 3：幻觉（LLM 编造资料里没有的内容）**
- 解决：① Prompt 强约束"资料没有就说不知道"；② 引用溯源（要求每个论据标出处）；③ 后置校验（答案里的关键事实回查资料）。

**坑 4：权限泄漏**
- 现象：销售员工问"薪资制度"，检索到了 HR 私密文档。
- 解决：**检索后按用户权限过滤**（元数据带部门/密级），不只靠 LLM 自觉。

**坑 5：成本爆炸**
- 现象：每次都把 Top 20 文档全塞 prompt，token 消耗大。
- 解决：① Rerank 后只取 Top 5；② Prompt 缓存（相同问题）；③ 简单问题走小模型。

### 📊 效果
- 召回准确率（Recall@5）：从纯向量 72% → 混合检索 85% → +Rerank 91%。
- 回答满意度：人工评测 82%（vs 传统关键词搜索 45%）。
- 单次问答成本：0.03 元（Qwen 私有化摊销）。
- 响应时间：P95 3.2s（首 token 1.5s + 生成）。

---

## 案例二：智能客服（RAG + 多轮 + 转人工）

### 📌 背景
电商客服压力大，80% 是重复问题（订单状态、退换货、物流）。传统规则客服死板，关键词匹配不准。

### 🏗️ 架构
```
用户消息
  → 意图识别(LLM 分类：闲聊/业务咨询/投诉)
  ├─ 闲聊 → 直接 LLM 回复
  ├─ 业务咨询
  │   → 查用户上下文(最近订单)
  │   → RAG 检索 FAQ/政策文档
  │   → Function Calling 查实时数据(查订单/物流)
  │   → 生成回复 + 推荐话术
  └─ 投诉/复杂 → 转人工(带工单摘要)
  
记忆：Redis 存对话历史(最近 10 轮)，超长则摘要压缩
```

### 💻 Function Calling 查实时数据
```java
@Bean
@Description("查询用户订单状态")
public Function<OrderQuery, OrderInfo> queryOrder(OrderService svc) {
    return q -> svc.getOrder(q.userId(), q.orderId());
}

// LLM 自动判断需要查订单时调用
String reply = chatClient.prompt()
    .system("你是电商客服，友好专业。可调用工具查实时数据。")
    .user(userMessage)
    .functions("queryOrder", "queryLogistics", "createReturn")
    .advisors(new MessageChatMemoryAdvisor(chatMemory, conversationId, 10))
    .call()
    .content();
```

### 🕳️ 踩坑
- **多轮记忆丢失**：超过上下文窗口 → 用摘要压缩历史对话。
- **工具调用错误**：LLM 传错参数 → schema 严格校验 + 默认值。
- **转人工时机**：设阈值（连续 2 次答非所问 / 用户明确要求 / 投诉情绪）。

### 📊 效果
- 自动解决率：68%（80% 重复问题里解决了一大半）。
- 平均响应时间：2s（vs 人工 3-5 分钟）。
- 客户满意度：4.3/5（vs 纯规则客服 3.1）。

---

## 案例三：Text2SQL（自然语言查数据）

### 📌 背景
业务方/运营想看数据但不会写 SQL，找开发排期慢。希望"用一句话查报表"。

### 🏗️ 架构
```
用户："上个月华东区销售额 Top 10 的商品"
  → RAG 检索相关表结构说明 + few-shot 示例
  → LLM 生成 SQL
  → SQL 校验(语法/权限/白名单表)
  → 只读账号执行
  → 结果 → LLM 生成自然语言解读 + 图表配置
```

### 💻 核心实现
```java
public Text2SQLResult query(String question, User user) {
    // 1. 检索相关 schema
    List<TableSchema> tables = schemaRetriever.find(question);
    String schemaDesc = formatSchema(tables); // 表名/字段/注释/示例

    // 2. few-shot 示例
    List<Example> examples = exampleStore.findSimilar(question, 3);

    // 3. 生成 SQL
    String sql = chatClient.prompt()
        .system(SQL_TEMPLATE) // 含约束：只读/限制行数/禁用危险操作
        .user(buildPrompt(question, schemaDesc, examples))
        .call()
        .entity(SQLExtraction.class) // 结构化输出
        .getSql();

    // 4. 安全校验
    sqlValidator.validate(sql, user); // 白名单表/只读/行数限制

    // 5. 执行
    QueryResult data = readOnlyJdbcTemplate.query(sql);

    // 6. 生成解读
    String insight = chatClient.prompt()
        .user("用自然语言解读这组数据：" + data)
        .call().content();

    return new Text2SQLResult(sql, data, insight);
}
```

### 🕳️ 踩坑
- **复杂 SQL 准确率低**（多表 join、子查询）→ 限制复杂度 + 提供视图（view）简化。
- **schema 理解错**→ 给字段加中文注释 + 示例值。
- **安全问题**→ 只读账号 + 表白名单 + SQL 审计日志 + 行数限制。
- **幻觉表/字段**→ 校验生成的 SQL 里字段是否真实存在。

### 📊 效果
- 简单查询准确率：88%；复杂查询：62%（兜底转人工）。
- 业务方自助查询占比：45%（减少开发排期）。

---

## 案例四：Agent 自动化运维（ReAct 多步任务）

### 📌 背景
线上告警后，运维要查日志、看监控、定位服务、甚至重启。希望 Agent 自动初步定位。

### 🏗️ 架构（ReAct 循环）
```
告警："order-service CPU 90%"
  → Thought: 需要先查是哪个实例、什么进程占用
  → Action: 调用 query_monitor(service="order-service", metric="cpu")
  → Observation: pod-2 CPU 95%，GC 频繁
  → Thought: 可能是 FullGC，查 GC 日志
  → Action: query_logs(pod="pod-2", keyword="Full GC")
  → Observation: "Full GC 10s 一次，老年代 95%"
  → Thought: 内存泄漏，dump 分析
  → Action: heap_dump(pod="pod-2")
  → ... 最终生成诊断报告 + 建议处理
```

### 💻 LangGraph 状态机实现（关键）
```java
// 定义状态机节点
StateGraph<AgentState> graph = new StateGraph<>(AgentState.class)
    .addNode("plan", planNode)        // 规划
    .addNode("execute", executeNode)  // 执行工具
    .addNode("reflect", reflectNode)  // 反思
    .addEdge(START, "plan")
    .addEdge("plan", "execute")
    .addConditionalEdges("execute", shouldContinue,  // 判断是否完成
        Map.of("continue", "plan", "end", END));

// 工具集
List<Tool> tools = List.of(
    new QueryMonitorTool(),
    new QueryLogsTool(),
    new HeapDumpTool(),
    new RestartServiceTool()  // 高危操作，需人工确认
);
```

### 🕳️ 踩坑
- **死循环**（Agent 反复调同一工具）→ 设最大步数 + 去重。
- **高危操作**（如重启、删数据）→ 强制人工确认（Human-in-the-loop）。
- **工具描述不清**→ LLM 调错工具 → schema 写详细 + 给示例。

### 📊 效果
- 简单告警自动定位率：55%（自动出诊断报告，人工复核）。
- 平均定位时间：从 20 分钟降到 4 分钟。

---

# 第六章 Java 工程化（你的主战场）

## 6.1 整体架构落地 🔴

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

## 6.2 工程化要点 🔴🔴

### ① 成本控制
- **Prompt 缓存**：相同 prompt 缓存（Redis），命中率 30-50%。
- **模型分级**：简单任务用小模型（Qwen-7B），复杂用大（Qwen-72B）。
- **Batch 接口**：批量请求降单价。
- **流式输出**：边生成边返回，体感快。

### ② 可靠性
- **重试 + 降级**：API 失败重试，主模型挂切备用。
- **超时控制**：LLM 慢，设合理超时。
- **限流**：防恶意烧钱。
- **结构化输出**：JSON schema / Function Calling 强制格式。

### ③ 安全
- **输入审核**：Prompt Injection（"忽略以上指令"）防护。
- **输出审核**：合规过滤（涉黄涉政）。
- **脱敏**：敏感数据不出域（用私有化模型）。
- **审计日志**：记录调用。

### ④ 可观测
- 记录 prompt、token 消耗、延迟、模型版本。
- LangSmith / Langfuse（Trace）。
- 评估体系（准确率、满意度）。

---

# 第七章 面试可能问的（简历有 AI 才需要）🔴

1. 你做的 AI 项目解决了什么业务问题？效果怎么评估？🔴
2. RAG 流程？分块、检索、重排分别怎么做？🔴
3. 向量检索为什么用 HNSW？混合检索为什么？🔴
4. LLM 幻觉怎么解决？🔴
5. Agent vs RAG 区别？ReAct？🔴
6. 怎么控制 LLM 调用的成本和延迟？🔴
7. 你项目的 AI 部分架构？怎么和 Java 业务集成？🔴
8. **深度追问**：RAG 召回率怎么提升？（讲混合检索 + Rerank + 父子块）
9. **深度追问**：你的 RAG 踩过什么坑？（讲分块、权限、幻觉）
10. **深度追问**：Agent 怎么防死循环和高危操作？

> ⚠️ **提醒**：AI 是加分项。简历没写别强答。简历写了就必须吃透（尤其上面 4 个案例的细节），否则被反噬。
