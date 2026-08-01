# 面试题 - Java 核心（基础 + 集合 + IO）

> 用法：先盖住答案自答，再对照。🔴 高频/重点 · 答案力求"讲到原理 + 结合实战"。
> 配套知识点：`资料/01-Java核心.md`

---

## 一、Java 基础

### Q1 🔴 == 和 equals() 的区别？

**答**：
- `==`：比较**基本类型的值**，比较**引用类型的内存地址**。
- `equals()`：Object 默认也是比地址（`return this == obj`），但通常被重写为"内容相等"。String、Integer 等都重写了。

**追问 - 为什么重写 equals 要重写 hashCode？**
- 约定：equals 相等的对象，hashCode 必须相等。
- 反例：两个 Person 对象 equals 相等但 hashCode 不同 → 放进 HashMap 会变成两个 key（因为先按 hashCode 定桶），逻辑错误。
- 规则：equals 用到的字段，hashCode 也要用到。

---

### Q2 🟡 String / StringBuilder / StringBuffer 区别？

| | String | StringBuilder | StringBuffer |
|---|--------|---------------|--------------|
| 可变性 | 不可变 | 可变 | 可变 |
| 线程安全 | 安全（不可变） | 不安全 | 安全（synchronized） |
| 性能 | 低（每次新建） | 高 | 中 |

- String 不可变：`final char[] value`（JDK9 改 byte[]），修改会创建新对象。
- 场景：单线程拼字符串用 StringBuilder；多线程用 StringBuffer（少）；少量拼接编译器优化成 StringBuilder。

**追问 - String 为什么设计成不可变？**
1. 线程安全（不可变天然安全）。
2. hashCode 可缓存（常作 HashMap key，不可变保证 hash 稳定）。
3. 字符串常量池（共享引用）。
4. 安全性（类加载器、URL 等不可被篡改）。

---

### Q3 🟡 Java 中的异常体系？

```
Throwable
  ├── Error（不该 catch，如 OOM、StackOverflow）
  └── Exception
       ├── RuntimeException（运行时，非受检）—— NullPointerException、ClassCastException、IllegalArgumentException
       └── 其他 Exception（受检，必须处理）—— IOException、SQLException
```

- **受检异常**：编译器强制 try/catch 或 throws（IO、SQL）。
- **非受检异常**：RuntimeException，编译器不强制（空指针、数组越界）。

---

### Q4 🟢 JDK 动态代理和 CGLIB 区别？为什么 Spring 默认用 CGLIB？

- **JDK 动态代理**：基于**接口**，目标类必须实现接口。`Proxy.newProxyInstance`。
- **CGLIB**：基于**继承**生成子类，不能代理 final 类/方法。`Enhancer`。
- SpringBoot 2.x 起 `spring.aop.proxy-target-class=true` 默认 CGLIB，原因：很多类没实现接口，CGLIB 通用性更好。

---

### Q5 🔴 接口和抽象类的区别？JDK8 后接口的变化？

| | 抽象类 | 接口 |
|---|--------|------|
| 关系 | 单继承 | 多实现 |
| 构造方法 | 有 | 无 |
| 字段 | 任意 | public static final |
| 方法 | 任意 | 默认 public abstract |

**JDK8+ 接口增强**：
- `default` 方法：有默认实现（解决接口演进问题，如 Collection.stream）。
- `static` 方法：接口静态方法。
- JDK9+ `private` 方法：default 方法间复用。

**设计选择**：抽象类表"is-a"（强相关 + 共享代码），接口表"can-do"（能力契约）。

---

## 二、集合框架（高频中的高频）

### Q6 🔴🔴 HashMap 的 put 流程？（必背）

**答**：
1. 计算 key 的 hash：`(h = key.hashCode()) ^ (h >>> 16)`（扰动，让高位参与）。
2. `(n-1) & hash` 定位桶（n 是数组长度，2 的幂）。
3. 桶为空 → 直接放。
4. 桶非空：
   - 第一个节点 key 相等（== 或 equals）→ 覆盖 value。
   - 是 TreeNode（红黑树）→ 红黑树插入。
   - 是链表 → 尾插；插入后长度 ≥8 且数组 ≥64 → 转红黑树。
5. `++size > threshold`（capacity × 0.75）→ resize 扩容（2 倍）。

---

### Q7 🔴🔴 HashMap 在 JDK7 多线程下为什么会死循环？JDK8 解决了吗？

**JDK7 头插法扩容死循环**：
- 扩容时用头插法迁移链表，多线程并发扩容会形成**环形链表**。
- 下次 get 遍历到环 → 死循环 → CPU 100%。

**JDK8 改为尾插法**：
- 扩容时保持原顺序（尾插），不反转链表 → 不会成环。
- **但 HashMap 仍非线程安全**：并发 put 可能丢数据（两个线程同时判断桶空，一个覆盖另一个）、size 不准。
- 并发要用 ConcurrentHashMap。

---

### Q8 🔴🔴 HashMap 为什么用红黑树？为什么阈值是 8？

**为什么用红黑树**：
- 链表查找 O(n)，hash 碰撞严重时（恶意构造 key 攻击）退化成 O(n)，性能灾难。
- 红黑树查找 O(log n)，长链表时优化明显。

**为什么阈值是 8**：
- 桶内元素数服从**泊松分布**（λ=0.5），达到 8 的概率 ≈ 0.00000006，属于"极端异常"。
- 平时几乎不会树化（开销大），只有 hash 极端退化才用。
- 树退化回链表阈值是 6（避免 7-8 来回抖动）。

---

### Q9 🔴 HashMap 扩容机制？JDK8 有什么优化？

- 触发：`size > capacity × 0.75`。
- 扩为 2 倍。
- **JDK8 优化**：元素新位置要么原 idx，要么 `idx + oldCapacity`（看 hash 新增的高位 bit 是 0 还是 1），不需要重新算 hash，迁移高效。

---

### Q10 🔴🔴 ConcurrentHashMap JDK7 和 JDK8 区别？为什么放弃分段锁？

**JDK7**：Segment[] 分段锁，每段一个 ReentrantLock，默认 16 段 → 并发度 16。

**JDK8**：Node[] + CAS + synchronized 锁单个桶。
- 空桶：CAS 插入。
- 非空桶：synchronized 锁头节点。
- 链表 ≥8 → 红黑树。

**为什么放弃分段锁？**
1. **并发度更高**：JDK7 上限 16，JDK8 锁粒度到桶，并发度 = 桶数（默认 16，扩容后更多）。
2. **减少内存**：分段锁每个 Segment 自带锁对象，开销大。
3. **CAS + synchronized 优化**：synchronized 在 JDK6 后优化得很好（偏向/轻量级），空桶用 CAS 无锁，冲突才 synchronized。

**size 怎么算？** baseCount（CAS）+ CounterCell[] 分段累加（借鉴 LongAdder 思想，减少竞争）。

---

### Q11 🔴 ArrayList 的扩容机制？

- 默认初始容量 10（首次 add 才创建数组，延迟初始化）。
- 扩容：`oldCapacity + (oldCapacity >> 1)` = **1.5 倍**。
- 用 `Arrays.copyOf` 复制。

**对比 HashMap 2 倍**：ArrayList 是线性增长（1.5 倍节省空间），HashMap 是 2 倍（保证 `(n-1)&hash` 位运算有效）。

---

### Q12 🟡 ArrayList vs LinkedList？什么时候用哪个？

| | ArrayList | LinkedList |
|---|-----------|------------|
| 底层 | 数组 | 双向链表 |
| 随机访问 | O(1) | O(n) |
| 增删（尾部） | O(1) 均摊 | O(1) |
| 增删（中间） | O(n)（搬移） | O(1)（已定位节点，但定位 O(n)） |
| 内存 | 紧凑 | 每节点多两个指针 |

**实战**：99% 用 ArrayList（缓存友好、随机访问快）。LinkedList 增删优势在"已持有节点引用"时才体现，业务场景少。LinkedList 实现了 Deque，可做队列/栈。

---

### Q13 🟡 fail-fast 和 fail-safe？

- **fail-fast**：遍历时被修改（modCount 变化）抛 ConcurrentModificationException。ArrayList、HashMap 的迭代器。单线程下边遍历边删要用 iterator.remove()。
- **fail-safe**：遍历副本（CopyOnWriteArrayList）或弱一致性（ConcurrentHashMap），不抛异常但可能读不到最新。

---

### Q14 🔴 TreeMap / LinkedHashMap / PriorityQueue？

- **TreeMap**：红黑树，key 有序（Comparable / Comparator），O(log n)。需排序遍历时用。
- **LinkedHashMap**：HashMap + 双向链表，维护插入/访问顺序。`accessOrder=true` 时每次 get 把节点移到尾部 → 经典 **LRU 实现**（重写 removeEldestEntry）。
- **PriorityQueue**：二叉堆（数组实现），出队按优先级。top K 问题、任务调度。

---

## 三、泛型与反射

### Q15 🟡 什么是泛型擦除？

- Java 泛型是**编译期**特性，编译后擦除（`List<String>` 变成 `List`）。
- 运行时拿不到泛型类型（`list.getClass()` 不含 String）。
- 带来的限制：不能 `new T()`、不能 `new T[]`、不能 catch 泛型异常、基本类型要包装。
- 通过反射拿泛型：`Method.getGenericReturnType()`（方法签名保留泛型）。

---

### Q16 🟡 反射的作用和性能？

- 作用：运行时获取类信息、创建对象、调用方法、访问字段（Spring、MyBatis、JSON 序列化全靠它）。
- 性能：比直接调用慢（要安全检查、参数装箱、JIT 优化难），但可优化：
  - `setAccessible(true)` 跳过权限检查。
  - 缓存 Method/Field 对象。
  - JDK7+ MethodHandle / JDK9+ VarHandle 更快。

---

## 四、Java 8 新特性（高频）

### Q17 🔴 Stream 流的核心操作？

- **中间操作**（惰性）：filter、map、flatMap、sorted、distinct、peek、limit、skip。
- **终端操作**（触发）：forEach、collect、count、reduce、min/max、anyMatch、findFirst。
- **惰性求值**：中间操作不立即执行，终端操作才触发，可短路（findFirst 找到就停）。
- **并行流**：`.parallel()` 用 ForkJoinPool，注意线程安全 + 顺序。

**追问 - forEach 和 for 循环区别？**
- forEach 是内部迭代（库控制），无法 break/continue，不能用局部变量（effectively final）。
- for 是外部迭代，更灵活。

---

### Q18 🟢 Optional 怎么用？

- 解决 NPE。`Optional.ofNullable(x).orElse(default).map(...)`.
- 别用于字段（设计是为返回值），别 `get()`（丢失意义）。
- 链式 + orElse / orElseThrow / ifPresent。

---

### Q19 🟡 接口的 default 方法多继承冲突？

- 类优先于接口：父类方法覆盖接口 default。
- 子接口优先于父接口。
- 冲突必须重写解决：`Interface.super.method()`。

---

## 五、NIO / IO

### Q20 🔴 BIO / NIO / AIO 区别？

| | BIO | NIO | AIO |
|---|-----|-----|-----|
| 阻塞 | 同步阻塞 | 同步非阻塞（多路复用） | 异步非阻塞 |
| 连接处理 | 一连接一线程 | 一个线程管多连接（Selector） | 回调 CompletionHandler |
| 实现 | Socket | Channel+Selector+Buffer | epoll/IOCP |
| 适用 | 连接少 | 连接多（Netty） | 连接多且数据量大 |

---

### Q21 🔴 零拷贝（Zero-Copy）是什么？哪些场景用？

**传统读文件发网络**（4 次拷贝 + 4 次上下文切换）：
```
磁盘 → 内核读缓冲 → 用户空间 → 内核socket缓冲 → 网卡
```

**零拷贝技术**：
- **mmap**（内存映射）：用户空间和内核共享缓冲区，省去"内核→用户"拷贝。
- **sendfile**：内核直接从读缓冲送到网卡，全程不进用户空间（Linux 2.4+ 配合 DMA gather，2 次拷贝）。

**应用**：
- **Kafka**：用 sendfile 顺序读，超高吞吐。
- **Netty**：`FileRegion` 用 sendfile；用 `DirectByteBuffer` 减少一次拷贝。
- **Nginx**：sendfile 默认开。

---

## 六、易错/对比题

### Q22 🔴 String s = new String("abc") 创建了几个对象？

- 如果常量池没有 "abc"：**2 个**（常量池的 "abc" + 堆的 new String 对象）。
- 如果常量池已有 "abc"：**1 个**（只堆上 new）。

**intern()**：把字符串放入常量池并返回常量池引用。

---

### Q23 🟢 Integer 缓存？

```java
Integer a = 127, b = 127;  // a == b → true
Integer c = 128, d = 128;  // c == d → false
```
- Integer 对 `-128 ~ 127` 有缓存（IntegerCache），自动装箱返回同一对象。
- 超范围会 new 新对象。比较 Integer 要用 `equals()`。

---

### Q24 🟡 Java 是值传递还是引用传递？

**Java 只有值传递**。
- 基本类型：传值的副本。
- 引用类型：传引用的副本（副本指向同一对象）。方法内改对象属性影响外部，但重新赋值引用不影响外部。

---

## 七、自测重点（盖住答案）

- [ ] HashMap put 流程能讲完整
- [ ] HashMap JDK7 死循环原因
- [ ] ConcurrentHashMap JDK7/8 区别 + 为什么放弃分段锁
- [ ] ArrayList vs LinkedList，为什么 99% 用 ArrayList
- [ ] JDK 代理 vs CGLIB
- [ ] equals/hashCode 约定
- [ ] 零拷贝 + Kafka 为什么快
- [ ] 异常体系，受检 vs 非受检

> 并发/JVM 的题在 `面试题-并发与JVM.md`
