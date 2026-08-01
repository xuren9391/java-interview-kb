# 面试题 - 并发与 JVM

> 🔴 高频 · 这是 Java 资深面试最核心、最容易拉开差距的部分，必须讲到"源码/原理级"。
> 配套知识点：`资料/01-Java核心.md`

---

## 第一部分：并发（JUC）

### Q1 🔴 并发三要素？怎么解决？

| 要素 | 问题 | 原因 | 解决 |
|------|------|------|------|
| 可见性 | 一个线程改了，另一个看不到 | CPU 缓存 / 工作内存 | volatile / synchronized / Lock |
| 原子性 | 操作被中断 | 指令非原子 | synchronized / Lock / CAS |
| 有序性 | 指令重排 | 编译器/CPU 优化 | volatile（内存屏障）/ happens-before |

---

### Q2 🔴 volatile 原理？能保证原子性吗？

**两层语义**：
1. **可见性**：写后强制刷主内存 + 让其他线程工作内存失效。
2. **禁止指令重排**：插入内存屏障（StoreStore/StoreLoad/LoadLoad/LoadStore）。

**底层实现**：写 volatile 变量 → lock 前缀指令 → 触发缓存一致性（MESI）→ 其他 CPU 缓存行失效。

**不保证原子性**：`i++` 是读-改-写三步，volatile 保证每步可见但三步之间仍可能被插入。

---

### Q3 🔴🔴 DCL 单例为什么必须加 volatile？

```java
private static volatile Singleton instance;
public static Singleton getInstance() {
    if (instance == null) {
        synchronized (Singleton.class) {
            if (instance == null) {
                instance = new Singleton();  // 非原子
            }
        }
    }
    return instance;
}
```

`new Singleton()` 编译成 3 步：①分配内存 ②初始化对象 ③引用指向内存。
指令重排可能变成 ①③②：其他线程在 ③ 之后、② 之前判 `instance != null` → 拿到**未初始化的对象** → NPE。
volatile 禁止 ①③② 重排，保证安全。

---

### Q4 🔴 happens-before 八大规则？

1. 程序顺序（同线程内代码顺序）
2. 监视器锁（unlock 先于后续 lock）
3. volatile（写先于后续读）
4. 线程启动（start() 先于被启动线程动作）
5. 线程终止（线程动作先于 terminate()）
6. 线程中断（interrupt() 先于检测到中断）
7. 对象终结（构造结束先于 finalizer）
8. 传递性

---

### Q5 🔴🔴 synchronized 锁升级过程？（必精通）

```
无锁 → 偏向锁 → 轻量级锁 → 重量级锁（只升不降）
```

- **偏向锁**：第一个线程 CAS 记录 ThreadID 到 Mark Word，之后该线程进入只比对 ID（无 CAS 无自旋）。适合单线程重入。
- **轻量级锁**：多线程交替但无竞争，CAS 把 Mark Word 复制到栈帧 Lock Record，失败则自旋。
- **重量级锁**：自旋失败 / 长竞争 → Mark Word 指向 ObjectMonitor（C++），线程进 EntryList 阻塞（OS mutex，成本高）。

**JDK15 偏向锁被废弃**（现代应用竞争多，偏向锁维护成本 > 收益）。

---

### Q6 🔴 synchronized vs ReentrantLock？

| | synchronized | ReentrantLock |
|---|---|---|
| 实现 | JVM 关键字 | AQS |
| 释放 | 自动 | 手动 finally unlock（忘写会死锁） |
| 中断 | 不可 | lockInterruptibly() |
| 公平 | 非公平 | 可选 |
| 条件 | 1 个 | 多个 Condition |
| 尝试 | 不可 | tryLock(timeout) |
| 锁分离 | 不可 | 读写锁 ReentrantReadWriteLock |

---

### Q7 🔴 CAS 原理？ABA 怎么解决？

**CAS**：`compareAndSwap(V, expected, new)`，硬件级原子（cmpxchg）。V==expected 则更新为 new，返回 true；否则返回 false。

**缺点**：
1. 自旋开销大（竞争激烈空转）。
2. 只保证一个变量（AtomicReference 可包装多字段）。
3. ABA 问题。

**ABA**：值 A→B→A，CAS 以为没变。解决：**版本号** AtomicStampedReference（值+版本号一起比较）。

---

### Q8 🔴🔴 AQS 原理？讲讲 ReentrantLock 加锁流程。（必精通）

**核心**：volatile int state + CLH 双向队列。

```
              ┌─ state（volatile，同步状态）
AQS ──────────┤
              └─ CLH 队列（FIFO 双向链表，存等待的 Node）
```

**两种模式**：独占（重写 tryAcquire/tryRelease）、共享（tryAcquireShared）。

**ReentrantLock 非公平加锁**：
1. CAS 尝试 state 0→1，成功 → 获取锁，owner = 当前线程。
2. 失败：判断 owner 是否自己（可重入）→ state++。
3. 否则：封装 Node 入 CLH 队列，park 阻塞，前驱唤醒后再次 tryAcquire。

**公平 vs 非公平**：公平锁 tryAcquire 前先 `hasQueuedPredecessors()` 判断队列有人等。非公平直接抢，吞吐更高。

---

### Q9 🔴🔴 线程池 7 参数 + 执行流程？（必背）

```java
new ThreadPoolExecutor(
    corePoolSize, maximumPoolSize, keepAliveTime, unit,
    workQueue, threadFactory, handler
);
```

**流程**：
1. 核心线程未满 → 创建核心线程。
2. 核心 满 → 放 workQueue。
3. 队列 满 → 创建非核心线程（到 maximumPoolSize）。
4. 都满 → 拒绝策略。

**4 种拒绝策略**：AbortPolicy（抛异常，默认）/ CallerRunsPolicy（提交者执行，背压）/ DiscardPolicy / DiscardOldestPolicy。

---

### Q10 🔴 为什么阿里规约禁用 Executors？

- `newFixedThreadPool` / `newSingleThreadExecutor`：用**无界** LinkedBlockingQueue → 队列堆积 OOM。
- `newCachedThreadPool`：最大线程 Integer.MAX_VALUE → 线程数 OOM。

要用 `new ThreadPoolExecutor(...)` 显式指定有界队列 + 明确参数。

---

### Q11 🔴 线程数怎么设置？

- **CPU 密集**：`N + 1`（N = 核数）。多 1 防偶发停顿。
- **IO 密集**：`2N` 或 `N × (1 + 等待时间/计算时间)`。
- 本质：让 CPU 不闲着（IO 时切换其他线程）。
- 实际：通过压测调优，监控队列堆积、拒绝次数。

---

### Q12 🔴 ThreadLocal 原理？为什么内存泄漏？

**结构**：每个 Thread 持有 ThreadLocalMap，key 是 ThreadLocal 的**弱引用**，value 是**强引用**。

**泄漏原因**：key 弱引用被 GC 变 null，但 value 强引用还在。线程池场景线程长期存活 → value 永久驻留 → 泄漏。

**解决**：用完 `threadLocal.remove()`，尤其线程池 + finally。

**InheritableThreadLocal 限制**：子线程能继承父线程值，但**线程池复用线程时失效**（父子关系只在线程创建时建立一次）。→ 用阿里 **TransmittableThreadLocal（TTL）** 解决线程池传递。

---

### Q13 🔴 CountDownLatch vs CyclicBarrier？

| | CountDownLatch | CyclicBarrier |
|---|---|---|
| 实现 | AQS 共享 | ReentrantLock + Condition |
| 计数 | 减到 0 | 达到指定数 |
| 复用 | 一次性 | 可 reset 复用 |
| 场景 | 主线程等 N 个任务完成 | N 个线程互相等齐 |

---

### Q14 🔴 死锁的四个必要条件？怎么排查？

**四条件**：互斥、持有并等待、不可剥夺、循环等待。

**排查**：
- `jstack <pid>` → 找 "Found Java-level deadlock"。
- Arthas `thread -b` 找阻塞源头。
- 预防：固定加锁顺序、加超时 tryLock、避免嵌套锁、减小锁粒度。

---

### Q15 🟡 ForkJoinPool 和普通线程池区别？

- **工作窃取**：空闲线程从其他线程队列尾部偷任务。
- 适合分治任务（递归拆分）、计算密集（并行流底层）。
- 普通线程池共享一个队列，ForkJoin 每个线程一个双端队列（自己 LIFO，窃取 FIFO）。

---

## 第二部分：JVM

### Q16 🔴🔴 运行时数据区？哪些共享哪些私有？

**线程共享**：堆（对象）、方法区/元空间（类信息、常量、静态变量）。
**线程私有**：虚拟机栈、本地方法栈、程序计数器。

**JDK8 永久代 → 元空间**：永久代在堆，易 OOM；元空间用本地内存，不受 MaxHeapSize 限制。

---

### Q17 🔴 GC Roots 有哪些？

1. 虚拟机栈局部变量引用
2. 本地方法栈 JNI 引用
3. 方法区静态变量引用
4. 方法区常量引用
5. JVM 内部引用（Class、异常、类加载器）
6. synchronized 持有的对象
7. JMXBean、JVMTI（临时）

---

### Q18 🔴🔴 G1 和 CMS 区别？G1 为什么替代 CMS？

| | CMS | G1 |
|---|-----|-----|
| 算法 | 标记-清除（碎片） | 复制 + 标记整理（无碎片） |
| 内存 | 固定新生代老年代 | Region（逻辑分代） |
| 停顿 | 不可控 | 可设目标 MaxGCPauseMillis |
| 碎片 | 严重 | 无（Region 复制） |
| 适用 | <6G | >6G |

**G1 核心**：Region 化，优先回收垃圾多的 Region（Garbage First），Mixed GC 回收年轻代 + 部分老年代。

**G1 触发 Full GC**：混合回收跟不上 / 老年代占用过高（超过 IHOP 阈值）→ 退化为单线程 Serial Full GC（灾难）。

---

### Q19 🔴 JDK8 为什么用元空间替代永久代？

1. 永久代大小固定（-XX:MaxPermSize），容易 OOM（动态生成类多时，如 CGLIB、Groovy）。
2. 永久代 GC 效率低，调优困难。
3. 元空间用本地内存，大小动态（受物理内存限制），更灵活。
4. JRockit / Hotspot 融合的需要。

---

### Q20 🔴🔴 类加载过程 + 双亲委派 + 破坏场景？（必精通）

**过程**：加载 → 验证 → 准备 → 解析 → 初始化 → 使用 → 卸载。
- 准备：static 变量赋零值；`static final` 常量赋初值。
- 初始化：执行 `<clinit>`（static 赋值 + static 块），JVM 保证线程安全。

**双亲委派**：加载时先委托父加载器，父加载不到才自己加载。保证核心类（java.lang.*）不被篡改 + 避免重复加载。

**破坏场景**：
1. **JDBC**：DriverManager（rt.jar）要加载第三方 Driver（classpath）→ 用**线程上下文类加载器（TCCL）** 父委派反过来。
2. **Tomcat**：每个 Web 应用独立 ClassLoader，优先加载自己 WEB-INF/classes，实现应用隔离。
3. **SPI**（ServiceLoader）：用 TCCL。
4. **OSGi / 模块化**：网状结构。
5. **热部署**：重新 ClassLoader 加载实现热更新。

---

### Q21 🔴🔴 CPU 100% 怎么排查？（必背流程）

```
① top                  找 CPU 最高的 Java 进程 PID
② top -Hp <PID>        找进程内 CPU 最高的线程 TID（十进制）
③ printf "%x\n" <TID>  转十六进制（nid）
④ jstack <PID> > s.log 导出线程栈
⑤ grep nid=<hex> s.log 定位代码行
⑥ 分析：死循环 / GC 频繁 / 正则回溯 / 序列化
```
**也看是不是 GC**：`jstat -gc <PID> 1000` 看 FGCT/YGCT；或 top 看 CPU 高但应用线程 idle，多半 GC 线程在烧。

---

### Q22 🔴🔴 OOM 排查？

**OOM 类型**：
- `Java heap space`：堆溢出 → dump + MAT 分析支配树找大对象/泄漏。
- `Metaspace`：动态生成类太多（CGLIB/反射/Groovy）→ 调大 MaxMetaspaceSize。
- `GC overhead limit`：GC 占 98% 时间回收 <2% → 实质堆溢出前兆。
- `Direct buffer memory`：NIO 堆外 → MaxDirectMemorySize。
- `unable to create new native thread`：线程数超限 → 查线程泄漏 / ulimit。

**工具**：`jmap -dump` 导出 + **MAT**（看 Dominator Tree、GC Root 链路）+ **Arthas**（在线诊断）+ `-XX:+HeapDumpOnOutOfMemoryError` 自动 dump。

---

### Q23 🔴 内存泄漏 vs 内存溢出？

- **泄漏（Leak）**：对象不用了但被引用持有，无法回收，逐渐堆积。
- **溢出（OOM）**：申请内存时无可用内存。泄漏最终常导致溢出。
- 经典泄漏：静态集合持有、ThreadLocal 不 remove、监听器未注销、连接未关。

---

### Q24 🔴 常用 JVM 参数？

```bash
-Xms4g -Xmx4g              # 初始=最大堆（避免抖动）
-Xmn / -XX:NewRatio        # 新生代
-XX:MetaspaceSize / MaxMetaspaceSize
-XX:+UseG1GC
-XX:MaxGCPauseMillis=200
-XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=...
-Xlog:gc*:file=gc.log      # JDK9+ 统一日志
```

---

### Q25 🔴 JDK21 虚拟线程？和平台线程区别？

- **虚拟线程**：JVM 调度的轻量级线程（非 OS），一个应用可起百万个。
- 适合**高并发 IO 密集**，同步代码写出异步性能（无 callback 地狱）。
- 底层：ForkJoinPool 调度，IO 阻塞时让出载体平台线程。
- **注意**：synchronized 钉住平台线程（JDK21），建议用 ReentrantLock；CPU 密集无收益。

---

## 自测重点（盖住答案）

- [ ] DCL 为何 volatile
- [ ] synchronized 锁升级
- [ ] AQS + ReentrantLock 流程
- [ ] 线程池 7 参数 + 流程 + 线程数设定
- [ ] ThreadLocal 泄漏 + TTL
- [ ] G1 vs CMS，G1 触发 Full GC 场景
- [ ] 类加载 + 双亲委派破坏
- [ ] CPU 100% 排查步骤
- [ ] OOM 类型与排查
- [ ] 元空间替代永久代原因
