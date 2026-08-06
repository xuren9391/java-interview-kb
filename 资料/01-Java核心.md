# Java 核心（源码级 · JVM · 并发 · 集合 · IO · 线上案例）

> 难度：🟢必会 🟡进阶 🔴高阶（专家级）
> 这是后端面试基本盘，几乎每场必问，且最容易拉开差距。
> **本文档目标：从 API 级讲到源码/内核级 + 设计动机 + 大量图解 + 线上实战案例。**
>
> **背景设定**：本文案例围绕「企迈科技 SaaS 茶饮小程序后端」（2021.9 至今）展开——
> 优惠券/资产计算、点单商品业务、促销活动设计开发；近百万家门店、接口 RT 2s→400ms、高峰缓存命中 85%。
> 每个知识点都按【为什么/痛点 → 原理图解+代码 → 真实案例 → 对比/边界 → 面试话术】五维度展开。

---

# 第一篇 JVM（讲透到 G1/ZGC 调优与 OOM 实战）

## 1.1 运行时数据区（JDK8+ 全景图）

### 【为什么/痛点】为什么要划分这么多区域？

一句话：**不同数据的"生命周期 + 共享范围"完全不同**，混在一起管理会又慢又危险。
- 线程私有的栈帧、PC 寄存器：随线程生灭，不需要加锁，零竞争。
- 线程共享的堆、方法区：跨线程可见，需要 GC 管理、需要并发控制。
- 把"私有数据"和"共享数据"物理隔离，JVM 才能针对各自特性做极致优化（栈用完即抛、堆用 GC、元空间用本地内存）。

### 【原理图解】

```
┌──────────────────────────────────────────────────────────────┐
│                        JVM 运行时数据区                        │
├─────────────────────────────┬────────────────────────────────┤
│      线程共享（随 JVM 存在）  │         线程私有（随线程存在）    │
├─────────────────────────────┼────────────────────────────────┤
│  ┌───────────────────────┐  │  ┌──────────────────────────┐  │
│  │   堆 Heap（最大）      │  │  │  虚拟机栈 VM Stack        │  │
│  │  ┌──────┬──────────┐  │  │  │  ┌────────────────────┐  │  │
│  │  │新生代 │  老年代   │  │  │  │  │ 栈帧 Frame         │  │  │
│  │  │Eden  │          │  │  │  │  │ ├ 局部变量表        │  │  │
│  │  │S0 S1 │          │  │  │  │  │ ├ 操作数栈          │  │  │
│  │  └──────┴──────────┘  │  │  │  │ ├ 动态链接          │  │  │
│  └───────────────────────┘  │  │  │ └ 方法返回地址      │  │  │
│  ┌───────────────────────┐  │  │  └────────────────────┘  │  │
│  │ 方法区(元空间)         │  │  └──────────────────────────┘  │
│  │ Metaspace(本地内存)    │  │  ┌──────────────────────────┐  │
│  │ 类信息/常量池/静态变量  │  │  │  本地方法栈 Native Stack  │  │
│  └───────────────────────┘  │  └──────────────────────────┘  │
│                              │  ┌──────────────────────────┐  │
│                              │  │  程序计数器 PC Register   │  │
│                              │  │  (记录当前执行字节码地址) │  │
│                              │  └──────────────────────────┘  │
└──────────────────────────────┴────────────────────────────────┘
        + 直接内存 Direct Memory（NIO 堆外，受 MaxDirectMemorySize 限制）
```

#### OOM 对应区域速查
| 区域 | OOM 错误信息 | 典型原因 |
|------|-------------|---------|
| 堆 | `Java heap space` | 内存泄漏/大对象/大数据集 |
| 元空间 | `Metaspace` | 动态生成类太多（CGLIB/JSP） |
| 虚拟机栈 | `StackOverflowError` | 递归过深；`Unable to create new native thread` 线程数超限 |
| 直接内存 | `Direct buffer memory` | Netty/NIO 堆外未释放 |

### 🔴 必须讲清的 6 个深度点

**① 永久代 → 元空间的演进（JDK8）**
| | 永久代（JDK7-） | 元空间（JDK8+） |
|---|---|---|
| 位置 | JVM 堆的一部分 | **本地内存（Native Memory）** |
| 大小限制 | -XX:MaxPermSize（固定，易 OOM） | -XX:MaxMetaspaceSize（默认无上限，受物理内存） |
| 存什么 | 类信息、常量池、静态变量 | 类信息、常量池（静态变量移到堆） |

**为什么废弃永久代？** 🔴
1. 永久代大小固定，调优困难。动态生成类多（CGLIB、Groovy、JSP、反射）容易 `OutOfMemoryError: PermGen space`。
2. 字符串常量池（intern）JDK7 移到堆，JDK8 彻底移除永久代，避免 PermGen OOM。
3. JRockit 和 Hotspot 融合的需要（JRockit 没有永久代）。
4. 元空间用本地内存，GC 扫描范围小，full GC 更快。

**【面试话术】**
「永久代到元空间这个演进，我理解核心动机是『把元数据从 JVM 进程堆里解放出来』。我们企迈在 JDK8 早期就遇到过，项目里大量用 CGLIB 做优惠券规则的动态代理，加上 Spring AOP，PermGen 一度天天 OOM。换 JDK8 元空间后，类元数据走本地内存，配合 `-XX:MaxMetaspaceSize=512m` 兜底，再没出过 PermGen 问题。本质上这是 Oracle 融合 JRockit 的产物，也让 GC 在扫描类元数据时范围更小。」

---

**② 为什么程序计数器是线程私有的？**
- 字节码解释器靠 PC 决定下一条执行什么。多线程切换后回来，必须从自己上次的位置继续，所以每线程一个 PC。
- **如果 PC 共享**：线程 A 切走、B 执行覆盖了 PC，A 回来就从 B 的位置继续，整个执行流乱套。
- PC 是唯一一个 **JVM 规范中明确规定不会 OOM** 的区域。

**③ 为什么虚拟机栈/本地方法栈是线程私有的？**
- 栈帧存局部变量、操作数栈。每个方法调用一个栈帧。私有保证各线程方法调用互不干扰。
- 栈深固定（-Xss，默认 512K-1M），递归太深 → `StackOverflowError`。
- 局部变量表以 **变量槽（Slot）** 为单位，32 位类型占 1 槽，64 位（long/double）占 2 槽。

**【面试话术】**
「PC 和栈为什么私有，本质是『线程切换的语义正确性』。CPU 时间片切换是 OS 随时可能发生的，如果没有线程私有的 PC，切回来就找不到下一条字节码；如果没有私有栈，A 的局部变量会被 B 覆盖。这是并发能正确工作的物理基础。我们调 `-Xss` 时要权衡：栈越大越能扛深递归，但同样内存能开的线程数就越少，1M 栈 + 1000 线程就是 1G。」

---

**④ 直接内存（Direct Memory）**
- NIO 的 `ByteBuffer.allocateDirect()` 用堆外内存，不受 JVM 堆大小控制，但受 `-XX:MaxDirectMemorySize` 限制。
- **优点**：减少一次内核态→用户态拷贝（零拷贝），GC 不扫描（减少 GC 压力）。
- **缺点**：分配/回收成本高（Unsafe.allocateMemory），无法被 JVM 直接管理（Netty 用 PoolChunkList 池化）。
- **排查**：`-XX:NativeMemoryTracking=detail` + `jcmd <pid> VM.native_memory`。

```java
// Netty 风格的堆外内存分配（演示，生产用 ByteBufAllocator）
ByteBuffer direct = ByteBuffer.allocateDirect(1024 * 1024); // 1MB 堆外
// 注意：分配和释放都是系统调用，比 HeapByteBuffer 慢，但 IO 时省一次拷贝
```

**【面试话术】**
「直接内存我在企迈的高并发网关层用过。我们有个门店商品聚合接口，高峰 QPS 上万，原来用 HeapByteBuffer 走 NIO，每次网络读写都要在堆和内核缓冲之间多拷一次，GC 压力也大。后来换 Netty 的 PooledDirectByteBuf，堆外池化，既省了那次拷贝又避开了 GC 扫描。代价是分配回收贵，所以一定要池化复用，不然反而更慢。排查堆外泄漏我用 `-XX:NativeMemoryTracking=detail` + `jcmd VM.native_memory summary`。」

---

**⑤ 对象一定分配在堆上吗？** 🔴（高频追问，原版太简，此处大幅扩展）

**痛点/动机**：堆分配意味着必然经过 GC（分配是快的，但 GC 回收是 STW 的）。如果一些对象只在方法内部用、用完就死，为什么还要污染堆、还要 GC 扫描？JVM 想：「能不能让这些短命对象压根不进堆？」

**逃逸分析（Escape Analysis，-XX:+DoEscapeAnalysis，JDK6+ 默认开）**：
分析一个对象的"作用域是否逃出方法/线程"，分三级：
- **未逃逸（NoEscape）**：对象只在方法内使用 → 可**栈上分配**（实际是**标量替换 Scalar Replacement**）+ 锁消除。
- **方法逃逸（ArgEscape/GlobalEscape）**：对象被 return 或赋给静态字段 → 必须堆分配。
- **线程逃逸**：对象被其他线程访问（如存入共享容器）→ 堆分配。

**标量替换图解**（这才是"栈上分配"的真相——Hotspot 并不真的在栈上放对象，而是把对象打散成基本类型局部变量）：
```
方法内代码：                         逃逸分析 + 标量替换后 JVM 实际执行：
class Point { int x, y; }            // Point 对象根本不创建！
void calc() {                        void calc() {
    Point p = new Point(1, 2);           int x = 1, y = 2;  // 拆成两个栈上 int
    int sum = p.x + p.y;                 int sum = x + y;   // 直接用局部变量
}                                       // 方法结束 x、y 随栈帧销毁，零 GC 开销
                                    }
```

**锁消除（Lock Elision）**：若同步块的对象未逃逸（如方法内 `new Object()` 当锁），JIT 直接删除 synchronized。
```java
// StringBuffer 是同步的，但如果 sb 没逃出方法，synchronized 被消除
public String concat(String a, String b) {
    StringBuffer sb = new StringBuffer(); // 未逃逸
    sb.append(a).append(b);               // 这里 sb 的锁全被消除
    return sb.toString();
}
```

**验证方法**：
```bash
# 关闭逃逸分析对比（默认开启）
-XX:-DoEscapeAnalysis -XX:+PrintEscapeAnalysis -XX:+DoEscapeAnalysis
# 用 JMH 跑一个 new 大量小对象的方法，开关对比，看是否分配计数下降
# JVM 输出标量替换信息：-XX:+UnlockDiagnosticVMOptions -XX:+PrintInlining
```

**【面试话术】**
「严格说『栈上分配』是个通俗说法，Hotspot 真正做的是逃逸分析 + 标量替换。我在企迈对优惠券计算引擎做过一次性能优化——计算函数里频繁 new 一堆临时 `DiscountContext`、`CouponMeta` 对象，Profiler 看堆分配很大但 GC 又都能立刻回收。我确认这些对象没逃逸出方法（没 return、没赋给字段），所以 -XX:+DoEscapeAnalysis 默认开着时，JVM 把它们标量替换成栈上的 int/String 局部变量，省掉了堆分配和 YGC 扫描。我还顺手验证过锁消除——方法内 new StringBuffer 当字符串拼接，JIT 直接把 synchronized 抹了。逃逸分析是 JDK8 之后默认开的，但有些极特殊场景（对象逃逸边界复杂）JIT 可能放弃分析退化成堆分配，这种时候要看 -XX:+PrintEscapeAnalysis 输出。」

---

**⑥ TLAB（Thread Local Allocation Buffer）** 🟡（原版太简，此处扩展）

**痛点/动机**：堆是所有线程共享的，但 `new` 对象绝大多数落在 Eden 区。如果每个 `new` 都要 CAS 抢"Eden 指针"，多线程高并发分配时 CAS 失败重试会非常严重（想想高峰期每秒几十万次 `new`）。怎么办？**给每个线程一块 Eden 私有缓冲区，自己分自己的，分满了再去抢新的**——这就是 TLAB。

**原理图解**：
```
Eden 区被切成多块 TLAB（每个线程一块私有）：
┌────────────────────────────────────────────────────────────┐
│  Eden 区                                                    │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐  │
│  │ TLAB-A   │ │ TLAB-B   │ │ TLAB-C   │ │ 共享区(CAS)   │  │
│  │ (线程A)  │ │ (线程B)  │ │ (线程C)  │ │ 所有线程竞争  │  │
│  │ 指针碰撞  │ │ 指针碰撞  │ │ 指针碰撞  │ │              │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────┘  │
└────────────────────────────────────────────────────────────┘
线程 A 在自己 TLAB-A 里 new：纯指针移动，无锁、无 CAS，纳秒级
TLAB-A 满了 → CAS 向 Eden 申请一块新的 TLAB（这是低频操作）
```

**分配流程（Hotspot）**：
1. 尝试 TLAB fast path：当前线程 TLAB 内指针碰撞，O(1)，无锁。
2. TLAB 满了 → slow path：CAS 申请新 TLAB；若 Eden 也不够 → 触发 Minor GC。
3. 默认 `-XX:+UseTLAB` 开启。TLAB 占 Eden 的比例 `-XX:TLABWasteTargetPercent=1`（默认 1%）。

**为什么 TLAB 让堆分配"看起来无锁"？**
因为 99% 的 `new` 走 fast path（自己 TLAB 内指针移动），只有 TLAB 耗尽时才竞争一次。这让 JVM 的对象分配速度接近 `malloc` 的最优情况。

**【面试话术】**
「TLAB 解决的是『多线程并发 new 对象时的指针竞争』问题。堆虽然是共享的，但 Hotspot 给每个线程在 Eden 区划了一块私有 TLAB，对象优先在自己的 TLAB 里用指针碰撞分配——完全无锁无 CAS。只有 TLAB 耗尽了才去 Eden 抢新的，竞争频率从『每次 new』降到『每几千次 new 一次』。我们企迈高峰期一秒能产生几十万个小对象（订单流水、计算中间态），正是因为 TLAB + 逃逸分析标量替换，堆分配基本不成为瓶颈。这个默认是开的，不用专门调，除非你想看 -XX:+PrintTLAB 的分配日志做深入调优。」

---

## 1.2 对象的创建全过程（6 步）🔴

### 【为什么/痛点】为什么要分 6 步，而不是一步到位？

因为 JVM 要兼顾**性能（快速分配）+ 安全（内存初始化）+ 灵活（支持 GC 和锁）**：
- 内存必须先清零，否则字段会有脏值（其他对象遗留的数据），这是安全红线。
- 对象头必须先设置，因为 GC、synchronized、hashCode 全依赖它。
- 构造方法最后才执行，保证字段赋值时对象结构已完整。

### 【原理图解】

```
┌─────────────────────────────────────────────────────────┐
│ 1. 类加载检查                                            │
│    new → 常量池定位类符号 → 检查是否已加载/解析/初始化      │
│    没有 → 触发类加载（见 1.6）                            │
├─────────────────────────────────────────────────────────┤
│ 2. 分配内存                                              │
│    方式 A：指针碰撞（Bump the Pointer）                   │
│      内存规整（Serial/ParNew/G1）→ 移动指针即可           │
│    方式 B：空闲列表（Free List）                          │
│      内存碎片（CMS）→ 维护空闲块列表，找合适的             │
│    并发安全：CAS 重试 或 TLAB 或加锁                      │
├─────────────────────────────────────────────────────────┤
│ 3. 内存空间初始化为零值（不含对象头）                      │
│    → 保证实例字段无需赋初值就能用（Java 不赋值有默认值）   │
├─────────────────────────────────────────────────────────┤
│ 4. 设置对象头（Object Header）                            │
│    - Mark Word（hashCode/分代年龄/锁状态，32/64 bit）     │
│    - 类型指针（Class Pointer，指向 Class 元数据）         │
│    - 数组长度（仅数组对象有）                             │
├─────────────────────────────────────────────────────────┤
│ 5. 执行 <init>（构造方法）                                │
│    → 调用构造函数，对字段赋初值                           │
├─────────────────────────────────────────────────────────┤
│ 6. 引用指向对象（栈帧局部变量表）                          │
└─────────────────────────────────────────────────────────┘
```

**关键细节**：
- 步骤 4 和 5 之间，对象内存已分配且零值，但还没构造——如果此时其他线程读到（如 DCL 重排序 bug），会拿到"半初始化对象"。
- 步骤 2 的"指针碰撞 vs 空闲列表"取决于收集器是否整理内存。CMS 用标记-清除有碎片 → 空闲列表；G1/Serial 用复制/整理 → 指针碰撞。

### 对象内存布局（Hotspot）

```
┌──────────────────────────────────────────────┐
│ 对象 = 对象头 + 实例数据 + 对齐填充            │
├──────────────────────────────────────────────┤
│ 对象头 Header：                                │
│   - Mark Word（8 byte，64位）                  │
│   - Class Pointer（4 byte 压缩 / 8 byte）     │
│   - [数组长度 4 byte，仅数组]                  │
│ 实例数据 Instance Data：字段值（按类型宽度排序）│
│ 对齐填充 Padding：补齐 8 byte 整数倍           │
└──────────────────────────────────────────────┘
```

**字段重排**：Hotspot 会把相同宽度的字段放一起，并先放 longs/doubles 再放 ints 再放 refs，父类字段在子类之前。可用 `-XX:-UseCompressedOops` 关闭指针压缩验证对象大小变化。

**Mark Word 内容随锁状态变化**（见 2.3 synchronized）：
```
无锁：    hashCode(31) | 分代年龄(4) | 0(1偏向位) | 01(2锁标志)
偏向锁：  线程ID(54) | epoch(2) | 分代年龄(4) | 1 | 01
轻量级锁：指向栈中Lock Record的指针(62) | 00
重量级锁：指向ObjectMonitor的指针(62) | 10
GC标记：  空 | 11
```

### 【真实案例 - 企迈茶饮】
优惠券计算引擎里有大量 `DiscountResult` 短命对象。用 JOL（Java Object Layout）分析：
```java
// 引入 org.openjdk.jol:jol-core
System.out.println(ClassLayout.parseClass(DiscountResult.class).toPrintable());
// 输出可见：HEADER 12B + 字段 + padding = 24B（刚好 8 的倍数）
```
发现一个有 3 个 long + 2 个引用的小对象是 40B，因为没对齐 padding 到 48B。把字段顺序调整后无变化（Hotspot 自动重排），但确认关闭指针压缩会多 8B，所以**生产坚持开 `-XX:+UseCompressedOops`**（堆 <32G 默认开）。

### 【面试话术】
「对象创建这 6 步我背得很熟，但我想强调两个面试常被追问的点。第一，**指针碰撞 vs 空闲列表取决于收集器**——G1/Serial 用复制整理所以指针碰撞，CMS 用标记-清除有碎片只能空闲列表。第二，**步骤 4 设对象头和步骤 5 构造之间的缝隙**就是 DCL 单例必须 volatile 的根因——new 实际是『分配→设对象头→赋引用→构造』，赋引用（步骤 6 的指针写入）如果和构造（步骤 5）重排，其他线程会拿到半初始化对象。我用 JOL 实测过我们优惠券的 DiscountResult 对象布局，确认了字段重排和指针压缩的效果，开了 UseCompressedOops 后对象头从 16B 压到 12B，对百万级对象的小内存场景省内存很明显。」

---

## 1.3 GC 算法深度对比

### 【为什么/痛点】为什么有这么多 GC 算法？

因为没有一种算法能同时满足"无碎片 + 快 + 不浪费空间"：
- 新生代对象朝生夕死（95%+ 立刻死）→ 复制算法（存活少，复制成本低）。
- 老年代对象长寿 → 标记-清除（CMS 快但有碎片）或标记-整理（无碎片但慢）。
- 不同代用不同算法 = 分代收集，工程上的折中。

### 【对比表】
| 算法 | 过程 | 优 | 劣 | 适用 |
|------|------|----|----|------|
| 标记-清除 Mark-Sweep | ①从 GC Roots 遍历标记存活 ②清除未标记 | 简单、无移动 | **碎片**、效率不稳（存活多时清除慢）| CMS |
| 复制 Copying | 内存分两块，存活对象复制到另一块 | 无碎片、快（存活少时）| 浪费一半空间 | 新生代 |
| 标记-整理 Mark-Compact | 标记 → 存活对象向一端移动 | 无碎片、不浪费 | 移动成本高、STW 长 | 老年代 |
| 分代收集 Generational | 新生代复制 + 老年代标记整理 | 综合最优 | 实现复杂 | 主流 |

### 🔴 GC Roots（根对象）完整清单

**为什么需要 GC Roots？** 可达性分析从 Roots 出发遍历对象图，不可达的 = 垃圾。没有 Roots 就没有起点，整个对象图无法判断谁死谁活。

GC Roots 包括：
1. **虚拟机栈**中的引用（方法局部变量、参数、临时变量）——最主要
2. **本地方法栈**中 JNI 引用
3. **方法区**中类静态变量引用
4. **方法区**中常量引用（如字符串常量池里的引用）
5. **JVM 内部引用**：基本类型 Class、常驻异常对象（NullPointerException 等）、系统类加载器
6. **同步锁 synchronized** 持有的对象
7. **JMXBean、JVMTI**（追踪本地代码的对象）
8. **分代回收的"临时 GC Roots"**：跨代引用处理时，老年代作为 Roots 扫描成本高，用 **Remembered Set / Card Table** 记录跨代引用，避免全堆扫描。

### 跨代引用问题（Card Table + Write Barrier）🟡

**痛点**：Minor GC 只回收新生代，但老年代可能持有新生代对象的引用。如果不处理，要么"全堆扫描老年代"（代价巨大），要么"漏回收"（保留本该回收的新生代对象，导致内存泄漏）。

**解决**：Card Table + Write Barrier。
- 老年代引用新生代 → Minor GC 时本应把整个老年代当 Roots，代价大。
- 解决：**Card Table**（卡表，512B 一张卡）。老年代写引用到新生代时，**写屏障**把对应卡标记为 dirty。Minor GC 只扫 dirty 卡。
- G1 用 **Remembered Set（RSet）**，每个 Region 记录"谁指向我"。

```
老年代内存（按 512B 分卡）：
┌──────┬──────┬──────┬──────┬──────┐
│ Card │ Card │ Card │ Card │ Card │  ← 每张 512B
│  0   │  1   │  2   │  3   │  4   │
└──┬───┴──────┴──┬───┴──────┴──────┘
Card Table（字节数组，1 byte 对应 1 card）：
   0        0       1(dirty)  0       0
   ↑                ↑
   干净            有跨代引用，Minor GC 只扫这张卡
```

**写屏障（Write Barrier）伪代码**：
```cpp
// Hotspot 在每次引用赋值（o.field = value）后插入
void post_write_barrier(Object o, Object value) {
    if (in_old_gen(o) && in_young_gen(value)) {
        card_table[card_index_of(o)] = DIRTY; // 标脏
    }
}
```

### 【面试话术】
「GC Roots 这个问题，我会先讲『为什么需要』——可达性分析必须有个起点。然后我会强调一个面试加分点：**『跨代引用 + Card Table』其实是『用写屏障换扫描效率』的经典工程权衡**。Minor GC 本来要回收新生代，但老年代可能持着新生代的引用，全扫老年代代价太大。Card Table 把老年代切成 512B 一张卡，写屏障在老年代写新对象引用时把对应卡标 dirty，Minor GC 只扫 dirty 卡。G1 更进一步，每个 Region 维护 RSet 记录『谁指向我』，避免全堆扫。我们企迈用的 G1，遇到过 RSet 维护成本高（写屏障开销）导致吞吐下降的情况，那时就要权衡 Region 大小和 RSet 精度。」

---

## 1.4 垃圾收集器全景（演进 + 对比 + 选型）

```
新生代(复制)         老年代
─────────────────────────────────────────────
Serial    ──────── Serial Old     (单线程，client 模式)
ParNew   ──────── CMS             (标记清除，并发)
Parallel Scavenge ── Parallel Old (吞吐量优先)
          G1                       (Region 化，混合回收)
          ZGC / Shenandoah         (着色指针/读屏障，亚毫秒停顿)
```

### ① CMS（Concurrent Mark Sweep）🔴 必精通（虽已废弃但常考）

**设计目标**：低停顿（并发收集，STW 短）。
**痛点**：早期 Web 服务对响应时间敏感，Serial/Parallel 的 STW 让接口卡顿，需要"边跑边收"。

**四阶段**：
```
阶段1 初始标记 Initial Mark（STW）
   ↓ 只标记 GC Roots 直接关联的对象，速度极快
阶段2 并发标记 Concurrent Mark
   ↓ 从 Roots 遍历对象图，与用户线程并发（耗时最长但不卡）
阶段3 重新标记 Remark（STW）
   ↓ 修正并发标记期间用户线程导致的标记变化
   ↓ 使用增量更新（Incremental Update）
阶段4 并发清除 Concurrent Sweep
   ↓ 清除未标记对象，与用户线程并发
```

**CMS 的 4 大痛点** 🔴：
1. **CPU 敏感**：并发阶段占工作线程（默认 (CPU+3)/4 个），降低吞吐。
2. **浮动垃圾 Floating Garbage**：并发清除期间新产生的垃圾本轮回收不了。
3. **空间碎片**（标记-清除）→ 大对象分配困难 → 触发 Full GC。
4. **Concurrent Mode Failure**：并发阶段老年代满了 → 退化为 Serial Old（单线程 STW Full GC），停顿极长。

**为什么 JDK9 废弃 CMS？** 碎片化 + 浮动垃圾导致频繁 Full GC，维护成本高，G1 更成熟。

**【面试话术】**
「CMS 我会重点讲它的并发设计：初始标记和重新标记 STW 但极短，真正耗时的并发标记和并发清除都是和业务线程并行的。但代价是四个痛点——CPU 抢占、浮动垃圾、碎片、Concurrent Mode Failure。CMS 退化是最危险的，老年代在并发清除阶段满了就直接退 Serial Old 单线程 Full GC，停顿几秒。我们企迈在 JDK8 早期还用 CMS，配 `-XX:CMSInitiatingOccupancyFraction=70` 控制触发时机，但碎片问题最终让我们在 JDK9+ 全面切 G1。CMS 在 JDK14 彻底移除了，但面试还是会考，因为它代表了『并发收集器』的鼻祖设计。」

### ② G1（Garbage First）🔴🔴 必精通（JDK9 默认）

**核心思想**：把堆切成 Region，跟踪每个 Region 的回收价值（垃圾占比），**优先回收价值高的**（Garbage First）。
**痛点**：CMS 碎片严重、Parallel 停顿长。G1 用 Region 化 + 混合回收，在"停顿可控 + 高吞吐 + 无碎片"间找平衡。

**内存模型**：
```
堆切分为 ~2048 个 Region，每个 1~32MB（2 的幂，自动选）
逻辑分代（不再物理连续）：
  ┌──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┐
  │E │E │S │O │O │H │H │O │E │O │空│空│
  ├──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┤
  E=Eden  S=Survivor  O=Old  H=Humongous(大对象，跨多个 Region)
```
- 一个 Region 当前是什么角色是动态的（回收后可转变）。
- 大对象（>Region 一半）进 Humongous Region。

**关键数据结构**：
- **Remembered Set（RSet）**：每个 Region 一个，记录"哪些其他 Region 引用了我"，避免全堆扫描。**Point-into**（指向自己）。
- **Collection Set（CSet）**：本次回收的 Region 集合。

**回收过程**：
```
【Young GC】（只回收年轻代 Region）
  Eden/Survivor 满 → 触发 → STW → 复制存活到新 Survivor/Old

【并发标记周期 Concurrent Marking Cycle】（Mixed GC 前奏）
  -XX:InitiatingHeapOccupancyPercent（默认 45%）触发
  1. 初始标记（STW，搭车一次 Young GC）
  2. 根区域扫描（扫描 Survivor 指向 Old 的引用）
  3. 并发标记（SATB 快照，三色标记）
  4. 重新标记（STW，处理 SATB 缓冲区）
  5. 清理（STW，统计每个 Region 垃圾占比，选 CSet）

【Mixed GC】（回收所有年轻代 + 部分老年代 Region）
  - 按"垃圾比例 / 预期停顿"选老年代 Region
  - 可通过 -XX:G1MixedGCCountTarget 控制分多次回收完
```

**三色标记 + SATB** 🔴（G1 的并发标记算法）：
```
白色：未访问
灰色：自己访问了，子节点未访问完
黑色：自己+子节点都访问完（安全，不会漏标）

漏标问题：并发标记时，黑色对象新增指向白色对象的引用 → 漏标
CMS 用 增量更新：新增引用时重新标记黑色变灰
G1 用 SATB（Snapshot-At-The-Beginning）：
  开始时拍快照，并发期间删除的引用记到 SATB 缓冲区
  重新标记时把 SATB 中的对象当存活（宁可多标不漏标）
```

**三色标记漏标的两个充要条件**（理论根基）：
```
并发标记期间，要漏标一个白色对象，必须同时满足：
  条件1：黑色对象新增了指向白色对象的引用（建立新引用）
  条件2：灰色对象到白色对象的引用断开（破坏原路径）
解决思路：破坏任一条件即可
  - 增量更新（CMS）：拦截"新增引用"→ 条件1，写时记下，重新标记扫描
  - SATB（G1）：拦截"断开引用"→ 条件2，删除时记下，重新标记当存活
```

**关键参数**：
```bash
-XX:+UseG1GC
-XX:MaxGCPauseMillis=200       # 期望最大停顿（软目标，G1 会努力但不保证）
-XX:G1HeapRegionSize=16m       # Region 大小（不设自动算）
-XX:InitiatingHeapOccupancyPercent=45  # 触发并发标记的堆占用阈值
-XX:G1NewSizePercent=5         # 新生代最小占比
-XX:G1MaxNewSizePercent=60     # 新生代最大占比
-XX:G1MixedGCCountTarget=8     # Mixed GC 分多少次完成
-XX:G1MixedGCLiveThresholdPercent=90  # Region 存活对象超此比例不回收
-XX:+ParallelRefProcEnabled    # 并行处理引用（加速）
```

**G1 触发 Full GC 的场景** 🔴（灾难，要避免）：
1. 并发标记跟不上分配速度（老年代涨太快）。
2. Mixed GC 没回收到足够空间。
3. Evacuation Failure（转移时没足够 Region 放存活对象）。
4. Humongous Allocation 失败。
→ 退化为 **JDK10 前单线程、JDK10+ 多线程**的 Serial Full GC，停顿几秒到几十秒。

**什么时候用 G1？** 堆 >6GB、停顿目标 0.1-0.5s。

**【面试话术】**
「G1 我在企迈生产环境跑 JDK9+，主战场。核心是 Region 化 + Garbage First 策略——堆切成 2048 个 Region，逻辑分代但不物理连续，每次 Young/Mixed GC 选垃圾比例高的 Region 组成 CSet 回收，配合 MaxGCPauseMillis 软目标做停顿预测。G1 用 SATB 解决三色标记漏标，本质是『拍快照 + 拦截引用删除』，宁可多标不漏标。最坑的是 Full GC 退化——我们踩过 Mixed GC 跟不上分配速度导致退 Serial Full GC 停顿 5 秒的坑，根因是本地缓存没设淘汰老年代涨太快。后来调 IHOP 到 35（更早触发并发标记）+ 业务层 Caffeine LRU 才稳。我深度调过 G1MixedGCLiveThresholdPercent，默认 85 太严，Region 存活对象超 85% 就不回收，碎片越积越多，调到 65 放宽回收条件，Mixed GC 频率降一个数量级。」

### ③ ZGC（Z Garbage Collector）🔴（JDK15 转正）

**痛点**：G1 的停顿在 100-200ms 级别，对延迟敏感场景（金融交易、实时推荐）仍不够。需要"与堆大小无关的亚毫秒停顿"。

**目标**：停顿 <1ms（JDK16+），与堆大小无关（TB 级堆也能）。

**两大核心技术**：
1. **着色指针（Colored Pointers）**：
   - 64 位指针的高 4 位塞 GC 元信息：Marked0 / Marked1 / Remapped / Finalizable。
   ```
   64 位指针布局（ZGC）：
   [18未用][1 Finalizable][1 Remapped][1 Marked1][1 Marked0][42 地址]
   ```
   - 指针本身携带状态，GC 时改指针的标志位，无需改对象头。

2. **读屏障（Load Barrier）**：
   - 每次从堆读引用，JVM 插入检查（读屏障）。
   - 若指针颜色不对（过期），**自愈**：把对象转移到新位置，更新指针。
   - 这样 GC 和应用可并发移动对象，几乎无 STW（只初始/重新标记有极短 STW）。

**着色指针 + 读屏障协作图解**：
```
应用线程读 obj.field（field 是引用）：
  ① 读 field 指针，检查颜色（Marked0/Marked1/Remapped）
  ② 颜色正确 → 直接返回
  ③ 颜色过期（GC 已搬迁对象）→ 读屏障自愈：
     - 把对象复制到新 Region
     - 更新 field 指针指向新地址 + 设 Remapped 颜色
     - 返回新指针
GC 转移对象时无需 STW，因为读屏障会按需修正
```

**代价**：吞吐略降（~10%，读屏障开销）。
**适用**：超大堆、低延迟要求极致（金融交易、实时）。

**【面试话术】**
「ZGC 的精髓是『把 GC 状态编码进指针本身』。64 位指针高 4 位存 Marked0/Marked1/Remapped 颜色，GC 改指针标志位就能标记/转移，不用动对象头。配合读屏障——每次从堆读引用都检查颜色，过期就自愈式转移对象并更新指针。这样 GC 和应用能真正并发移动对象，几乎没有 STW。代价是吞吐降 10%（读屏障开销）。我们在企迈没用 ZGC（堆才 8G，G1 够用），但我研究过美团、字节在 100G+ 堆上用 ZGC 的实践，停顿稳定 <5ms。ZGC JDK15 转正，JDK16 + Generational ZGC 进一步优化，是未来的方向。」

### ④ Shenandoah（RedHat，JDK12+）
- 与 ZGC 类似（亚毫秒停顿），用** Brooks 转发指针**（每个对象多一个指针指向自己或新副本）而非着色指针。
- OpenJDK 自带，Hotspot 用 ZGC 较多。
- Brooks 指针的代价：每个对象多吃 8 字节 + 每次访问多一次间接寻址。

### 收集器选型决策树 🔴
```
堆 < 4GB？→ Parallel（吞吐优先）或 G1
堆 4-32GB，停顿 200ms 可接受？→ G1（默认）
堆 > 32GB 或停顿 <10ms？→ ZGC
```

**选型对比表**：
| 收集器 | 停顿 | 吞吐 | 堆大小 | 适用场景 |
|--------|------|------|--------|---------|
| Parallel | 长（秒级） | 最高 | 任意 | 离线计算、批处理 |
| CMS | 中（百ms） | 中 | 中小 | 已废弃 |
| G1 | 100-200ms | 中高 | 6G-32G | 主流 Web 服务 |
| ZGC | <10ms | 低 10% | TB 级 | 低延迟、大堆 |
| Shenandoah | <10ms | 低 | 大堆 | RedHat 生态 |

---

## 1.5 内存分配策略（对象进新生代还是老年代？）

### 【为什么/痛点】为什么要分代 + 分配策略？

因为对象的"寿命"分布极度不均（90%+ 朝生夕死）。如果不分代，每次 GC 扫描整个堆；分代后，新生代频繁小回收（Minor GC 快），老年代偶发大回收（Full GC 慢但少见）。**分代是"用工程复杂度换 GC 效率"的核心权衡**。

### 【规则】
```
1. 对象优先在 Eden 分配（TLAB）
   Minor GC：Eden 满触发，Eden+S0 存活复制到 S1，年龄+1
2. 大对象直接进老年代（-XX:PretenureSizeThreshold）
   避免在 Eden 和 Survivor 间来回复制
3. 长期存活进老年代（MaxTenuringThreshold，默认 15；CMS 是 6）
4. 动态年龄判断：
   Survivor 中相同年龄对象大小总和 > Survivor 空间的 50%
   → 年龄 >= 该年龄的对象直接进老年代
5. 空间分配担保：
   Minor GC 前检查 老年代连续可用空间 > 新生代所有对象总空间
   不满足 → 检查是否允许担保失败（HandlePromotionFailure）
   允许 → 冒险 Minor GC（可能 Promotion Failed 触发 Full GC）
   不允许 → 直接 Full GC
```

**新生代为什么用复制算法？** 🔴
- 新生代朝生夕死（95%+ 对象很快死），存活少 → 复制成本低。
- 8:1:1 划分，浪费只有 10%（只用一个 Survivor）。

**动态年龄判断的真实意义**：避免 Survivor 溢出。如果某次大量对象同龄（如批量缓存预热），Survivor 可能装不下，按"年龄 >= 阈值"批量晋升老年代。

### 【真实案例 - 企迈茶饮】
门店商品批量预热时一次性 new 几万个 `ProductCache` 对象，Survivor 装不下，触发动态年龄判断，这批对象直接晋升老年代。本来是"短期缓存"，结果进了老年代，撑了一周后 Mixed GC 频繁。**解决**：预热改成流式 + 限制批次大小，避免大批同龄对象。

### 【面试话术】
「分配策略我会讲 5 条规则，但面试官最爱挖的是『动态年龄判断』和『空间分配担保』。动态年龄判断是 JVM 的安全阀——Survivor 中同龄对象总和超 50% 就批量晋升，防止 Survivor 溢出。空间分配担保是 Minor GC 前的预检查，老年代放不下所有新生代存活对象 + 不允许担保失败就直接 Full GC。我踩过坑：企迈门店商品批量预热一次 new 几万同龄对象，全被动态年龄判断轰进老年代，结果本来短命的缓存对象撑在老年代一周，Mixed GC 频繁。后来改流式分批预热才根治。这个教训是『不要一次创建大批同龄对象，否则 JVM 的代际假设会被打乱』。」

---

## 1.6 类加载机制（详解 + 破坏双亲委派实战）

### 【为什么/痛点】为什么要类加载机制 + 双亲委派？

两个核心痛点：
1. **安全**：如果用户能自己写个 `java.lang.String` 替换核心类，整个 JVM 安全体系崩塌。双亲委派保证核心类必须由 Bootstrap 加载。
2. **唯一性**：同一个类被同一个加载器加载只会产生一个 Class 对象，避免"两个 String 类不兼容"的混乱。

### 类加载 7 步全过程

```
加载 Loading
  → 通过类全限定名获取字节流（从 jar/网络/动态生成）
  → 转为方法区的运行时数据结构
  → 生成 java.lang.Class 对象（堆中），作为方法区数据入口
    ↓
验证 Verification
  → 文件格式、元数据、字节码、符号引用验证（确保安全合规）
    ↓
准备 Preparation
  → 为类变量（static）分配内存并赋【零值】（int→0, 引用→null）
  → 注意：static final 常量在此阶段赋【初值】（ConstantValue 属性）
    例：static int a = 123;  准备阶段 a=0，初始化阶段 a=123
        static final int A = 123;  准备阶段就 A=123
    ↓
解析 Resolution
  → 符号引用替换为直接引用（方法/字段/类的内存地址）
  → 可在初始化前或延迟到首次使用（延迟解析）
    ↓
初始化 Initialization  ← 真正执行类构造器
  → 执行 <clinit>：所有 static 变量赋值 + static{} 块
  → JVM 保证 <clinit> 线程安全（多线程初始化同一类，只有一个执行，其他阻塞）
    ↓
使用 Using
    ↓
卸载 Unloading
```

**类初始化触发时机（6 种，主动引用）** 🟡：
1. new / getstatic / putstatic / invokestatic（new 对象、读写静态字段、调静态方法）
2. 反射调用（Class.forName）
3. 初始化一个类，父类未初始化则先初始化父类
4. JVM 启动主类（含 main）
5. MethodHandle 句柄对应的类
6. 接口含 default 方法，实现类初始化时接口先初始化

**不触发初始化**：通过子类访问父类静态字段（只初始化父类）；通过数组定义 `MyClass[]`；常量（ConstantValue）。

### 双亲委派模型 + 工作流程

```
         BootstrapClassLoader（启动类加载器，C++，加载 JAVA_HOME/lib）
              ↑ 委派
         ExtClassLoader（扩展类加载器，加载 JAVA_HOME/lib/ext）
              ↑ 委派
         AppClassLoader（应用类加载器，加载 classpath）
              ↑ 委派
         自定义 ClassLoader
```

**委派逻辑**（ClassLoader.loadClass）：
```java
protected Class<?> loadClass(String name, boolean resolve) {
    // 1. 检查是否已加载
    Class<?> c = findLoadedClass(name);
    if (c == null) {
        try {
            // 2. 委派父加载器
            c = parent.loadClass(name, false);
        } catch (ClassNotFoundException e) {
            // 3. 父加载不到，自己 findClass
            c = findClass(name);
        }
    }
    return c;
}
```

**为什么需要双亲委派？** 🔴
1. **安全**：防止核心类被篡改。用户写 `java.lang.String` 会被委派到 Bootstrap 加载真正的 String。
2. **避免重复加载**：保证类的唯一性（同一个类 + 同一个加载器 = 同一个 Class 对象）。

### 破坏双亲委派的 5 大场景 🔴🔴

**场景 1：JDBC（SPI 机制 + TCCL）**
- 问题：`java.sql.DriverManager`（rt.jar，Bootstrap 加载）要加载第三方 `com.mysql.Driver`（classpath，App 加载）。
- Bootstrap 是 App 的"祖父"，无法向下委派。
- 解决：**线程上下文类加载器（TCCL，Thread Context ClassLoader）**。
```java
// DriverManager 内部用 TCCL 加载 Driver
ClassLoader cl = Thread.currentThread().getContextClassLoader(); // AppClassLoader
ServiceLoader<Driver> loaders = ServiceLoader.load(Driver.class, cl); // 反向用 App 加载
```

**场景 2：Tomcat（应用隔离）**
```
Tomcat 类加载结构：
  CommonClassLoader（共享）
    ↑
  CatalinaClassLoader（Tomcat 自身）
    ↑
  SharedClassLoader（多应用共享）
    ↑
  WebAppClassLoader（每个 Web 应用一个）← 打破双亲委派
    ↑
  JspClassLoader（每个 JSP 一个）
```
- WebAppClassLoader **优先自己加载** WEB-INF/classes，再委派父类（与双亲委派相反）。
- 目的：不同 Web 应用可能依赖不同版本的同一 jar，必须隔离。

**场景 3：OSGi / 模块化**
- 网状类加载结构，每个模块独立 ClassLoader，模块间可声明依赖。
- 彻底打破树状双亲委派。

**场景 4：热部署 / 热加载**
- 修改类后，用新 ClassLoader 重新加载 → 新 Class 对象。
- 旧 Class 对象等老实例 GC 后释放。
- OSGi、JRebel、Spring DevTools 用此机制。

**场景 5：SPI（ServiceLoader）**
- 同 JDBC，所有 SPI 都用 TCCL。

### 【真实案例 - 企迈茶饮】
我们用 Tomcat 部署，多个 SaaS 模块（订单、促销、券）依赖不同版本的工具库。WebAppClassLoader 的隔离保证各模块互不影响。另外线上排查"类冲突"用过 `arthas` 的 `sc -d 类名` 看是哪个 ClassLoader 加载的，定位 jar 包冲突。

### 【面试话术】
「双亲委派我会先讲清『委派逻辑』——loadClass 先 findLoadedClass，再 parent.loadClass，最后自己 findClass。然后讲『为什么要委派』——安全（防核心类篡改）+ 唯一性（同类同加载器 = 同 Class 对象）。重点讲破坏场景：JDBC 用 TCCL 反向加载 SPI 实现，因为 Bootstrap 加载的 DriverManager 没法向下委派；Tomcat WebAppClassLoader 优先自己加载实现应用隔离；OSGi 网状结构彻底打破树状；热部署靠新 ClassLoader 重加载。我在企迈踩过 jar 包冲突——arthas 的 sc -d 看是哪个 ClassLoader 加载的，定位到两个版本共存。破坏双亲委派不是错，是工程需要，但要清楚自己在做什么、为什么。」

---

## 1.7 JVM 调优实战（参数 + 决策 + 案例）

### 【为什么/痛点】为什么要调优？

JVM 默认参数是"通用最优"，不是"你的业务最优"。线上场景的堆大小、对象寿命分布、延迟/吞吐权衡都不同。调优的目标不是"让 GC 消失"，而是"让 GC 在可控范围内、停顿可接受、不 Full GC"。

### 常用参数完整版
```bash
# ===== 堆 =====
-Xms4g -Xmx4g               # 初始=最大（生产建议相等，避免扩缩抖动）
-Xmn 或 -XX:NewRatio=2      # 新生代 / 老年代:新生代比例
-XX:SurvivorRatio=8         # Eden:S0:S1 = 8:1:1
-XX:MaxTenuringThreshold=15 # 晋升老年代年龄阈值

# ===== 元空间 =====
-XX:MetaspaceSize=256m      # 触发 Full GC 的阈值（建议设大，避免早期 FullGC）
-XX:MaxMetaspaceSize=512m

# ===== 直接内存 =====
-XX:MaxDirectMemorySize=1g

# ===== 收集器 =====
-XX:+UseG1GC
-XX:MaxGCPauseMillis=200
-XX:+ParallelRefProcEnabled  # 并行处理 Reference（Finalizer 等）

# ===== GC 日志（JDK9+ 统一日志 Xlog）=====
-Xlog:gc*,gc+heap=debug:file=gc.log:time,uptime,level,tags:filecount=10,filesize=100m

# ===== 故障诊断 =====
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/data/dump/
-XX:OnError="jstack %p"     # 错误时执行
-XX:+PrintCommandLineFlags  # 打印 JVM 启动参数
```

### 调优三大目标（权衡）🔴
```
低延迟（停顿短）↔ 高吞吐（GC 占 CPU 比例低）↔ 不 Full GC
三者要权衡，无法全占。
```
- **低延迟**：G1/ZGC，调小 MaxGCPauseMillis。
- **高吞吐**：Parallel，调大新生代减少 GC 频率。
- **避免 Full GC**：合理堆大小 + 监控。

### 【企迈生产实际 JVM 参数】（脱敏）
```bash
# 优惠券计算服务（8C16G 容器）
-Xms8g -Xmx8g                    # 堆固定 8G，避免动态扩缩
-XX:+UseG1GC
-XX:MaxGCPauseMillis=200
-XX:InitiatingHeapOccupancyPercent=35   # 调低，更早触发并发标记
-XX:G1MixedGCLiveThresholdPercent=65    # 放宽 Mixed GC 回收条件
-XX:MaxMetaspaceSize=512m
-XX:+ParallelRefProcEnabled
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/data/dump/
-Xlog:gc*:file=/data/log/gc.log:time,uptime,level,tags:filecount=10,filesize=100m
```

### 📌 线上实战案例 1：G1 频繁 Mixed GC 导致接口抖动

**现象**：线上订单接口 P99 偶发飙到 3s，每 10 分钟左右一次。
**排查**：
1. Grafana 看 GC：Mixed GC 频繁，每次 800ms，老年代占用 70%。
2. GC 日志看：`InitiatingHeapOccupancyPercent=45` 触发并发标记，但回收效率低（很多 Region 存活对象超 85%）。
3. 堆 dump：发现一个 `Cache` 对象占 2GB（本地缓存没设淘汰）。

**解决**：
- 业务层：缓存加 LRU 淘汰 + 改用 Caffeine（限制大小）。
- JVM：`-XX:InitiatingHeapOccupancyPercent=35`（更早触发标记），`-XX:G1MixedGCLiveThresholdPercent=65`（放宽回收条件）。
- 监控：堆占用告警 60%。

**结果**：Mixed GC 从 10 分钟一次降到 1 小时一次，停顿从 800ms 降到 200ms。

### 📌 线上实战案例 2：Full GC 诡异触发

**现象**：每天凌晨 3 点固定一次 Full GC，停顿 8s。
**排查**：
1. 不是业务高峰，但定时任务（报表生成）在跑。
2. dump 分析：定时任务用 `new HashMap()` 累积了 3 亿条数据（没分页查 DB）。
3. 大对象 + 老年代瞬间涨满 → Full GC。

**解决**：报表改流式处理（MyBatis Cursor + 分批写），避免内存堆积。

**教训**：警惕"大对象/大数据集"进老年代，业务要做分页/流式。

### 【面试话术】
「JVM 调优我会先讲『三大目标权衡』——低延迟、高吞吐、不 Full GC 三者不可兼得，要先定业务优先级。企迈是 Web 服务，延迟优先，所以选 G1 + MaxGCPauseMillis=200。我亲历过两次典型调优：一次是优惠券本地缓存没淘汰，老年代涨到 70% 触发频繁 Mixed GC，每次 800ms，订单 P99 飙到 3s。我做了两件事——业务层换 Caffeine 加 LRU，JVM 层把 IHOP 从 45 调到 35（更早触发并发标记）、MixedGCLiveThresholdPercent 从 85 调到 65（放宽回收条件），Mixed GC 降一个数量级。另一次是报表定时任务用 HashMap 累积 3 亿条，每天凌晨 Full GC 8s，改 MyBatis Cursor 流式处理根治。调优心得是『先查业务再调参数』，90% 的 GC 问题都是业务代码（缓存不淘汰、大数据集、内存泄漏）引起的。」

---

## 1.8 线上问题排查 SOP（必背，面试高频）🔴🔴

### 【为什么/痛点】为什么要 SOP？

线上故障每一秒都是损失。没有 SOP，工程师手忙脚乱试命令浪费时间。SOP 把"高频问题"标准化为"可复现的排查步骤"，把 MTTR（平均恢复时间）从小时级压到分钟级。

### SOP 1：CPU 100% 排查（完整 7 步）

```
① top                      找 CPU 最高的进程 PID
② top -Hp <PID>            找进程内 CPU 最高的线程 TID（十进制）
③ printf "%x\n" <TID>      转十六进制（nid）
④ jstack <PID> > stack.log 导出线程栈（建议连导 3 次，间隔 5s）
⑤ grep "nid=<hex>" stack.log  定位代码行
⑥ 分析根因：
   - 死循环 / 无限递归
   - GC 频繁（jstat -gc <PID> 1000 看 FGCT/YGCT）
   - 正则灾难回溯
   - 序列化/反序列化死循环
   - 加密/哈希计算密集
⑦ 修复 + 验证
```

**也要判断是不是 GC 引起**：
- `top` 看进程 CPU 高，但 `top -Hp` 里用户线程都 idle → 多半是 GC 线程（"GC task thread")在烧。
- `jstat -gcutil <PID> 1000 10` 看 GCT 占比 + Full GC 频率。

**Arthas 简化版**：`thread -n 3` 直接看 CPU top3 线程，`thread <id>` 看栈。

### SOP 2：OOM 排查（分类 + 工具）

| OOM 类型 | 原因 | 排查 |
|---------|------|------|
| `Java heap space` | 堆溢出：内存泄漏 / 大对象 / 大数据集 | dump + MAT 支配树 |
| `Metaspace` | 动态生成类太多（CGLIB/Groovy/JSP/反射） | 调大 MaxMetaspaceSize + 找类泄漏 |
| `GC overhead limit` | GC 花 >98% 时间回收 <2% 堆 | 实质堆溢出前兆，同上 |
| `Direct buffer memory` | NIO 堆外内存（Netty） | MaxDirectMemorySize + 排查未释放 |
| `unable to create new native thread` | 线程数超限 / 内存不够创建线程栈 | 查线程泄漏 / 调 ulimit -u / 减 -Xss |
| `Requested array size exceeds VM limit` | 申请的数组超 Integer.MAX_VALUE | 业务 bug |

**MAT（Memory Analyzer）分析流程**：
1. `jmap -dump:format=b,file=heap.hprof <PID>`（或自动 dump）。
2. MAT 打开 → **Leak Suspects Report**（自动分析疑似泄漏）。
3. **Dominator Tree**（支配树）：找占内存最大的对象。
4. **Path to GC Roots**：看对象为什么没被回收（被谁持有）。
5. 定位到具体类/集合 → 修代码。

### SOP 3：接口响应慢排查

```
单接口慢 or 全局慢？
全局慢 → 机器资源（CPU/内存/GC/网络/磁盘 IO）
单接口慢 →
  1. 链路追踪（SkyWalking/Zipkin）看每个 Span 耗时
  2. 细查：
     - DB：慢查询日志 + explain（锁等待？大结果集？）
     - 下游接口：超时配置 / 重试风暴
     - Redis：大 Key 阻塞 / 网络抖动
     - GC：Full GC 停顿（看 GC 日志）
     - 锁竞争：jstack 看 BLOCKED 线程
     - 日志：同步写日志阻塞（改异步）
  3. 优化 + 压测验证
```

### 【企迈 RT 2s→400ms 的真实排查经历】
- **现象**：优惠券计算接口 P99 = 2s。
- **链路追踪**：发现 70% 时间在 DB（多次查门店商品 + 多次查券规则）。
- **优化**：
  1. 把 N+1 查询改批量查询（IN 一次查全）。
  2. 券规则用 Redis 缓存 + 本地 Caffeine 二级缓存，命中 85%。
  3. 串行计算改 CompletableFuture 并行（CPU 密集部分）。
  4. 排查发现一次 Full GC（HashMap 累积），改流式。
- **结果**：P99 降到 400ms。

### 常用诊断工具清单 🔴
| 工具 | 用途 |
|------|------|
| jps | Java 进程列表 |
| jstat | GC/类加载统计（jstat -gc <pid> 1000） |
| jstack | 线程栈（死锁/CPU 高） |
| jmap | 内存快照、直方图（jmap -histo:live） |
| **Arthas** | 在线热诊断神器：dashboard/thread/trace/watch/heapdump |
| MAT | 离线 dump 深度分析 |
| async-profiler | 火焰图，性能剖析 |
| GCEasy/GCViewer | GC 日志分析 |
| JConsole/jvisualvm | 可视化监控 |

**Arthas 高频命令**：
```bash
dashboard            # 总览
thread -n 3          # CPU top3 线程
thread -b            # 找阻塞其他线程的"罪魁"
trace 类 方法        # 方法调用链耗时
watch 类 方法 '{params, returnObj}'  # 查看入参返回
jad 类               # 反编译（确认线上代码版本）
heapdump /tmp/x.hprof
```

### 【面试话术】
「线上排查我有完整 SOP。CPU 100% 我用『top → top -Hp → printf %x → jstack → grep nid』七步定位，同时用 jstat 区分是用户线程烧还是 GC 烧。OOM 我先看错误类型——heap space 走 MAT 支配树，Metaspace 查类泄漏，Direct buffer 查 Netty 堆外。接口慢我靠 SkyWalking 链路追踪，先定位是全局慢还是单接口，再细查 DB/下游/Redis/GC/锁。Arthas 是我的主力——thread -n 3 看 CPU 高的线程，trace 看方法耗时，watch 看入参返回，jad 反编译确认线上代码版本。企迈优惠券接口 RT 从 2s 降到 400ms 的过程就是这样排查的：链路追踪发现 70% 时间在 DB 的 N+1 查询，改成批量 + Redis+Caffeine 二级缓存命中 85%，再并行化 CPU 密集计算，最后顺带修了一个 Full GC 隐患。」

---

# 第二篇 并发编程 JUC（讲到 AQS/线程池源码级 + 实战）

## 2.1 并发三要素 & JMM（Java Memory Model）

### 【为什么/痛点】为什么会有并发问题？

现代 CPU 为了性能做了三件事，每一件都破坏了"顺序一致"的直觉：
1. **多核 CPU 各自有 L1/L2 缓存** → 一个核改了变量，另一个核可能看到旧值（可见性问题）。
2. **编译器/CPU 乱序执行指令** → 写的代码顺序 ≠ 实际执行顺序（有序性问题）。
3. **操作非原子**（如 i++ 是读-改-写三步）→ 中间被打断（原子性问题）。

JMM 就是定义"什么场景下线程间的读写可见、有序"的规范，让程序员有规可循。

### 【对比表】
| 要素 | 问题 | 原因 | 解决 |
|------|------|------|------|
| **可见性** | 线程改了变量，另一个看不到 | CPU 缓存 / 工作内存 | volatile / synchronized / Lock |
| **原子性** | 操作被中断 | 指令非原子 | synchronized / Lock / CAS |
| **有序性** | 指令重排 | 编译器/CPU 优化 | volatile（内存屏障）/ happens-before |

### 【原理图解 - JMM 模型】

```
线程 A                      线程 B
┌──────────┐               ┌──────────┐
│ 工作内存  │               │ 工作内存  │  ← CPU 缓存抽象
│ (本地副本)│               │ (本地副本)│
└────┬─────┘               └────┬─────┘
     │ save/load                 │ save/load
┌────┴──────────────────────────┴────┐
│            主内存（共享变量）          │
└────────────────────────────────────┘
```
- JMM 定义 8 种原子操作：lock/unlock/read/load/use/assign/store/write。
- 线程不能直接操作主内存，必须通过工作内存。

**JMM 不保证可见性的反例**：
```java
// 线程 A 死循环等 stop=true，可能永远看不到 B 改的值（CPU 缓存）
boolean stop = false;        // 不加 volatile
// 线程 A
while (!stop) { /* 卡死 */ }
// 线程 B
stop = true;                 // A 可能永远不退出
```

### happens-before 8 大规则 🔴
1. 程序顺序规则（同线程内，代码书写顺序，但有依赖才保证）
2. 监视器锁规则（unlock happens-before 后续 lock）
3. volatile 变量规则（写 happens-before 后续读）
4. 线程启动规则（Thread.start() happens-before 该线程所有动作）
5. 线程终止规则（线程所有动作 happens-before Thread.terminate()）
6. 线程中断规则（interrupt() happens-before 检测到中断）
7. 对象终结规则（构造方法结束 happens-before finalizer）
8. 传递性（A happens-before B，B happens-before C → A happens-before C）

**作用**：判断并发环境下"某次写是否对另一次读可见"。JMM 向程序员提供 happens-before 保证，把底层屏障细节隐藏。

### 【面试话术】
「并发三要素根源是『CPU 多核缓存 + 乱序执行 + 非原子操作』，JMM 是定义程序员和 JVM 契约的规范——happens-before 8 大规则告诉你哪些场景下写对读可见。我自己写过血泪 bug：企迈有个订单状态机用 boolean 标志位跨线程通信，没加 volatile，测试环境怎么都对，上线后偶发死循环。后来定位是 CPU 缓存可见性问题，加了 volatile 立马好。happens-before 我背得很熟，但实战中用得最多的是『volatile 写 happens-before 后续读』和『unlock happens-before 后续 lock』。」

---

## 2.2 volatile 深度（底层 + 应用）

### 【为什么/痛点】volatile 解决什么问题？

`volatile` 比 `synchronized` 轻量，专门解决**可见性 + 有序性**（不解决原子性）。适用场景：
- 状态标志位（如 stop、ready）跨线程通信。
- DCL 单例防止指令重排。
- 配合 CAS 实现无锁数据结构（如 AQS 的 state）。

如果用 synchronized 做这些事，太重（涉及锁升级、OS 调度）；用 volatile 刚好——一行汇编指令搞定。

### 两层语义
1. **可见性**：写 volatile 变量 → 强制刷主内存 + 让其他线程工作内存失效。
2. **禁止指令重排**：插入**内存屏障**。

### 底层实现（汇编级）🔴
- Hotspot 写 volatile 变量 → 生成 `lock addl $0x0, (%rsp)` 指令（lock 前缀）。
- **lock 前缀指令的作用**：
  1. 锁定缓存行 → 触发 **MESI 缓存一致性协议** → 其他 CPU 该缓存行失效。
  2. 作为**全屏障**（StoreLoad），禁止前后指令重排。

### 内存屏障 4 种 🟡
| 屏障 | 作用 |
|------|------|
| LoadLoad | Load1; LoadLoad; Load2 → Load1 必须先于 Load2 |
| StoreStore | Store1; StoreStore; Store2 → Store1 必须先于 Store2 |
| LoadStore | Load; LoadStore; Store → Load 先于 Store |
| StoreLoad | Store; StoreLoad; Load → 最强（全屏障），Store 先于后续 Load |

volatile 写前插 StoreStore，写后插 StoreLoad；读后插 LoadLoad + LoadStore。

### volatile 不保证原子性 🔴
`i++` 是读-改-写三步：
```
1. 读 i 到工作内存
2. i+1
3. 写回主内存
```
volatile 保证每步可见，但**三步之间可被打断** → 丢更新。要 `AtomicInteger`（CAS）或锁。

### 🔴 经典应用：DCL 单例为什么必须 volatile

```java
public class Singleton {
    private static volatile Singleton instance;  // volatile 必加！
    public static Singleton getInstance() {
        if (instance == null) {
            synchronized (Singleton.class) {
                if (instance == null) {
                    instance = new Singleton();
                }
            }
        }
        return instance;
    }
}
```

**`new Singleton()` 编译成 3 步**：
```
① memory = allocate()    // 分配内存
② ctorInstance(memory)   // 初始化对象
③ instance = memory      // 引用指向内存
```
**指令重排可能变 ①③②**：其他线程在 ③ 之后、② 之前判 `instance != null` → 拿到**未初始化对象** → NPE。

volatile 禁止 ②③ 重排，保证安全。

**为什么用双检查（DCL）？**
- 第一次 check：避免每次都加锁（性能）。
- 第二次 check：防止并发下重复创建。

### 【对比/边界】volatile vs synchronized vs Atomic
| | volatile | synchronized | AtomicXxx |
|---|----------|--------------|-----------|
| 可见性 | ✅ | ✅ | ✅ |
| 原子性 | ❌ | ✅ | ✅（CAS） |
| 有序性 | ✅ | ✅ | ✅ |
| 阻塞 | 否 | 是 | 否 |
| 适用 | 状态标志、DCL | 复合操作 | 单变量计数 |

### 【面试话术】
「volatile 我会讲『两层语义 + 底层 lock 前缀指令 + 不保证原子性 + DCL 必加』。底层是 Hotspot 写 volatile 生成 `lock addl $0x0,(%rsp)`，lock 前缀做两件事——锁定缓存行触发 MESI 让其他 CPU 失效 + 作为 StoreLoad 全屏障禁止重排。DCL 单例必加 volatile 是因为 new 对象三步（分配→初始化→赋引用）可能重排成『分配→赋引用→初始化』，其他线程拿到半初始化对象 NPE。我在企迈用 volatile 最多的场景是状态机标志位（订单关闭、券失效）和配置热更新开关，比 synchronized 轻得多。但要记住 volatile 不保证原子性，i++ 还是要用 AtomicInteger。」

---

## 2.3 synchronized 深度（锁升级源码级）

### 【为什么/痛点】为什么要锁升级？

早期 synchronized 直接上重量级锁（OS 互斥量），无竞争时也走内核态，性能差。JDK6 引入锁升级：
- **无竞争**：偏向锁（记 ThreadID，零开销）。
- **轻度竞争**：轻量级锁（CAS 自旋，无内核态）。
- **激烈竞争**：重量级锁（OS 调度阻塞）。

核心思想：**根据竞争激烈程度动态选择锁实现，让"大部分无竞争场景"几乎零开销**。

### 对象头 Mark Word 与锁状态（64 位）🔴🔴

```
┌──────────────────────────────────────────────────────────────┐
│ 锁状态    │ Mark Word 内容（64 bit）              │ 标志位     │
├───────────┼───────────────────────────────────────┼───────────┤
│ 无锁      │ unused(25) | hashCode(31) | unused(1) │ 0 01      │
│           │ | 分代年龄(4) | 0(偏向位) | 01(锁标志) │           │
│ 偏向锁    │ 线程ID(54) | epoch(2) | 分代年龄(4)   │ 1 01      │
│           │ | 1(偏向位) | 01                      │           │
│ 轻量级锁  │ 指向栈中 Lock Record 的指针(62)        │ 00        │
│ 重量级锁  │ 指向 ObjectMonitor 的指针(62)         │ 10        │
│ GC 标记   │ -                                     │ 11        │
└──────────────────────────────────────────────────────────────┘
```

### 锁升级完整流程（JDK6+ 优化）🔴

```
┌─────────┐  多线程竞争   ┌──────────┐  自旋失败    ┌──────────┐
│  无锁    │ ──────────→ │ 偏向锁    │ ──────────→ │ 轻量级锁  │
│ (01,0)  │              │ (01,1)   │              │ (00)     │
└─────────┘              └──────────┘              └────┬─────┘
                                                       │ 竞争激烈
                                                       ▼
                                                  ┌──────────┐
                                                  │ 重量级锁  │
                                                  │ (10)     │
                                                  └──────────┘
特点：只升不降（GC 除外）
```

**① 偏向锁（Biased Locking）**
- 第一个线程进入 → CAS 把自己 ThreadID 写入 Mark Word。
- 之后该线程再进入，只比对 ThreadID（无 CAS 无自旋），近乎无开销。
- 适合**单线程重入**场景。
- **JDK15 废弃**（现代应用竞争多，偏向锁 revocation 成本 > 收益）。

**② 轻量级锁（Thin Lock / 自旋锁）**
- 多线程交替（无真竞争）→ 每个线程栈帧生成 **Lock Record**。
- CAS 把 Mark Word 复制到 Lock Record（Displaced Mark Word），并尝试把 Mark Word 指向 Lock Record。
- 成功 → 获锁。失败 → 自旋（自适应自旋：上次成功就多旋几次）。
- 适合**多线程交替执行，持有时间短**。

**③ 重量级锁（Heavyweight Lock）**
- 自旋失败 → Mark Word 指向 **ObjectMonitor**（C++ 实现）。
- 未获锁线程进入 **EntryList**，调用 `pthread_mutex_lock` 阻塞（OS 调度，成本高：用户态↔内核态切换）。
- 适合**竞争激烈、持有时间长**。

### ObjectMonitor 核心结构 🟡
```cpp
class ObjectMonitor {
    ObjectWaiter * _owner;       // 持有者线程
    ObjectWaiter * _EntryList;   // 阻塞等待的线程队列
    ObjectWaiter * _WaitSet;     // wait() 后的线程集合
    int _count;                  // 重入计数
    ...
}
```
- `wait()` → 释放锁，线程进 WaitSet，等 notify 唤醒回 EntryList。
- `notify()` → 从 WaitSet 移一个到 EntryList。

### synchronized vs ReentrantLock 🔴
| | synchronized | ReentrantLock |
|---|---|---|
| 实现 | JVM 关键字（monitorenter/exit） | AQS（JDK API） |
| 释放 | 自动（出块/异常） | **手动 finally unlock** |
| 中断 | 不可 | lockInterruptibly() |
| 超时 | 不可 | tryLock(timeout) |
| 公平 | 非公平 | 可选公平 |
| 条件变量 | 1 个（wait/notify） | 多个 Condition |
| 锁分离 | 不可 | ReentrantReadWriteLock / StampedLock |

### 【真实案例 - 企迈茶饮】
优惠券领取的库存扣减用 synchronized（库存少、竞争短）：`synchronized(couponId.intern())` 桶锁。秒杀场景换成 Redis + Lua（分布式锁 + 原子扣减）。

### 【面试话术】
「synchronized 我会从『为什么有锁升级』讲起——早期直接重量级锁太重，JDK6 引入偏向锁→轻量级锁→重量级锁的渐进升级，核心是『按竞争激烈度动态选锁实现』。Mark Word 64 位里前缀记录锁状态，偏向锁存 ThreadID（零开销重入），轻量级锁 CAS 自旋（无内核态），重量级锁走 ObjectMonitor 的 EntryList + pthread_mutex_lock（内核态阻塞）。只升不降（GC 除外）。JDK15 把偏向锁废弃了，因为现代应用竞争多，revocation 成本超过收益。synchronized vs ReentrantLock 我看场景：简单同步用 synchronized（自动释放、JVM 优化好），需要超时/中断/公平/多 Condition 用 ReentrantLock。企迈券库存扣减我用 synchronized(couponId.intern()) 做桶锁，秒杀场景换 Redis+Lua 分布式锁。」

---

## 2.4 CAS 与 ABA（底层 + 自旋）🔴

### 【为什么/痛点】CAS 解决什么问题？

` synchronized` 性能差（OS 调度阻塞），无锁编程（lock-free）用 CAS 实现"无阻塞的原子更新"。CAS 是 **Compare And Swap**——比较并交换，硬件级原子指令，无锁数据结构（AtomicXxx、ConcurrentHashMap、AQS）的基石。

### CAS（Compare And Swap）
```java
// AtomicInteger.compareAndSet 源码最终调用 Unsafe
public final native boolean compareAndSwapInt(Object o, long offset, int expected, int x);
```
- 硬件支持：x86 的 `cmpxchg` 指令（带 lock 前缀保证总线锁/缓存锁）。
- 原子语义：比较内存值 V 与期望值 E，相等则更新为 N，返回 true；否则返回 false。

### CAS 三大缺点 🔴
1. **自旋开销**：竞争激烈时空转烧 CPU。
2. **只保证一个变量**：多变量要 AtomicReference 包装对象。
3. **ABA 问题**：
   - 值 A→B→A，CAS 认为没变。
   - 解决：**版本号** AtomicStampedReference（值 + stamp 一起比较）。

### ABA 的真实危害场景 🟡
- **栈/链表操作**：线程 1 准备 CAS 把 head 从 A 换成 C，期间线程 2 把 A 弹出又 push 回来（A 的 next 变了），线程 1 CAS 成功但链表结构已破坏。
- **银行转账**：余额 100→200→100，CAS 误判没变（业务上可能有问题）。

### 自适应自旋（Adaptive Spinning）
- JDK6 引入。自旋次数动态调整：上次 CAS 成功 → 认为这次也能成功 → 多旋；反之少旋。
- 避免固定自旋在竞争激烈时空转。

### 【真实案例 - 企迈茶饮】
优惠券剩余库存用 AtomicInteger CAS 扣减（无锁高性能），秒杀级流量下比 synchronized 快。但坑：高并发下 CAS 自旋失败多，CPU 飙高。**解决**：阈值降级——超过一定失败率切换到分段锁（库存拆成 N 个槽，分别 CAS）。

### 【面试话术】
「CAS 是无锁编程的基石，硬件级 cmpxchg 指令保证原子。AtomicInteger、AQS、ConcurrentHashMap 全靠它。三大缺点我必须讲——自旋烧 CPU、只能单变量、ABA。ABA 最经典的是链表操作场景：head A 被弹出又 push 回来，CAS 误判没变导致结构破坏，用 AtomicStampedReference 加版本号解决。企迈券库存我用 AtomicInteger CAS 扣减，比 synchronized 快很多，但秒杀流量下自旋失败率飙升 CPU 烧，我做了个分段锁降级——把库存拆 N 个槽各自 CAS，分散竞争点。自适应自旋是 JDK6 的优化，根据历史成功率动态调自旋次数。CAS 不是银弹，竞争激烈时反而不如锁。」

---

## 2.5 AQS（AbstractQueuedSynchronizer）🔴🔴 必精通（源码级）

AQS 是 JUC 的基石：ReentrantLock、Semaphore、CountDownLatch、ReentrantReadWriteLock 都基于它。

### 【为什么/痛点】为什么要有 AQS？

如果没有 AQS，每个同步工具（锁、信号量、闭锁）都要自己实现"线程排队 + 阻塞唤醒 + 状态管理"，重复造轮子且容易出 bug。AQS 用**模板方法模式**抽出公共逻辑（CLH 队列 + state + park/unpark），子类只需实现 `tryAcquire/tryRelease`。这是 Doug Lea 的神作，一行代码被全行业复用十几年。

### 核心组成

```
              ┌─ volatile int state（同步状态）
AQS ──────────┤
              └─ CLH 队列（变体，FIFO 双向链表，存等待线程的 Node）
```

**state 的含义随实现而异**：
- ReentrantLock：0 无锁，>0 持有次数（可重入）。
- Semaphore：剩余许可数。
- CountDownLatch：未完成的计数。
- ReadWriteLock：高 16 位读 / 低 16 位写。

### CLH 队列结构 🟡
```
       head                                  tail
        ↓                                      ↓
   ┌────────┬──────┬──────┬─────────┬──────┬──────┬────────┐
   │(哨兵)  │ prev │ next │ thread  │waitSt│ next │  ...   │
   │  Node  │←─────│      │─────────│      │─────→│        │
   └────────┴──────┴──────┴─────────┴──────┴──────┴────────┘
   waitStatus: CANCELLED(1) / SIGNAL(-1) / CONDITION(-2) / PROPAGATE(-3)
```

**为什么用 CLH 变体而不是普通队列？**
- CLH 入队只需 CAS 设 tail，出队只需 head 后移，竞争点少。
- 每个节点靠前驱的 waitStatus 决定是否 park，避免全局锁。

### ReentrantLock 加锁流程（非公平）🔴

```java
// 1. lock()
final void lock() {
    if (compareAndSetState(0, 1)) {          // CAS 抢锁
        setExclusiveOwnerThread(current);    // 设 owner
    } else {
        acquire(1);                          // 抢不到走 AQS 流程
    }
}

// 2. acquire（AQS 模板方法）
public final void acquire(int arg) {
    if (!tryAcquire(arg) &&                  // ① 尝试获锁（子类实现）
        acquireQueued(addWaiter(Node.EXCLUSIVE), arg))  // ② 入队+阻塞
        selfInterrupt();                     // ③ 补中断标志
}

// 3. 非公平 tryAcquire（NonfairSync）
final boolean nonfairTryAcquire(int acquires) {
    int c = getState();
    if (c == 0) {                            // 无锁
        if (compareAndSetState(0, acquires)) { // 再次抢
            setExclusiveOwnerThread(current);
            return true;
        }
    } else if (current == getExclusiveOwnerThread()) { // 可重入
        setState(c + acquires);
        return true;
    }
    return false;
}

// 4. acquireQueued：入队后自旋+park
final boolean acquireQueued(Node node, int arg) {
    for (;;) {
        Node p = node.predecessor();
        if (p == head && tryAcquire(arg)) {  // 前驱是 head 才尝试
            setHead(node);
            return;
        }
        if (shouldParkAfterFailedAcquire(p, node) && // 前驱设 SIGNAL
            parkAndCheckInterrupt())                  // LockSupport.park 阻塞
            throw new InterruptedException();
    }
}
```

**公平 vs 非公平区别**：
```java
// 公平锁 tryAcquire 多一步：
if (c == 0) {
    if (!hasQueuedPredecessors() &&   // ← 队列有人等，就不抢
        compareAndSetState(0, acquires)) { ... }
}
```
- 非公平：上来直接 CAS 抢，吞吐高（减少线程切换）。
- 公平：按队列顺序，饿不死，但吞吐低。

### 基于 AQS 的核心组件 🔴
| 组件 | 模式 | state 含义 |
|------|------|-----------|
| ReentrantLock | 独占 | 重入次数 |
| ReentrantReadWriteLock | 共享(读)+独占(写) | 高16读/低16写 |
| Semaphore | 共享 | 许可数 |
| CountDownLatch | 共享 | 计数（到0唤醒） |
| CyclicBarrier | 基于 ReentrantLock+Condition | — |
| StampedLock（JDK8） | 乐观读+写 | 不基于 AQS |

### CountDownLatch vs CyclicBarrier 🔴
| | CountDownLatch | CyclicBarrier |
|---|---|---|
| 实现 | AQS 共享 | ReentrantLock + Condition |
| 计数 | 减到 0 | 达到指定数 |
| 复用 | 一次性 | reset 可复用 |
| 场景 | 主线程等 N 个任务 | N 个线程互相等齐 |

### 【真实案例 - 企迈茶饮】
优惠券计算引擎的多策略并行：主线程用 CountDownLatch 等待 6 个策略（满减、折扣、买赠、满件减、组合、新人券）都算完，再合并结果。如果某个策略超时，主线程不会无限等——`latch.await(500, MS)` 带超时。

### 【面试话术】
「AQS 是 JUC 基石，我会讲『为什么有 AQS——模板方法抽出公共同步逻辑避免重复造轮子』。核心是 volatile int state（语义随实现变）+ CLH 变体队列（FIFO 双向链表）。ReentrantLock 加锁流程我背得滚瓜烂熟：lock 先 CAS 抢 state，抢不到走 acquire → tryAcquire（子类实现）→ acquireQueued 入队 + shouldParkAfterFailedAcquire + LockSupport.park。公平 vs 非公平的区别就是 hasQueuedPredecessors 这一句——非公平直接抢（吞吐高），公平看队列（不饿死）。企迈券计算引擎我用 CountDownLatch 让主线程等 6 个策略并行算完再合并，带超时防卡死。AQS 我读过源码，建议面试前看一遍 acquire/release 的完整流程，能讲到 LockSupport.park 的底层数据结构（Parker，用 pthread_mutex + pthread_cond）就是加分项。」

---

## 2.6 线程池（ThreadPoolExecutor）🔴🔴 必精通（源码 + 实战）

### 【为什么/痛点】为什么要有线程池？

两个痛点：
1. **线程创建/销毁成本高**（OS 系统调用 + 栈内存分配）。池化复用，省开销。
2. **无限制 new 线程会 OOM**（`unable to create new native thread`）或拖垮下游。线程池做"限流 + 隔离 + 可监控"。

### 7 参数 + 状态机

```java
new ThreadPoolExecutor(
    int corePoolSize,                  // 核心线程数
    int maximumPoolSize,               // 最大线程数
    long keepAliveTime, TimeUnit unit, // 非核心线程空闲存活时间
    BlockingQueue<Runnable> workQueue, // 任务队列
    ThreadFactory threadFactory,       // 线程工厂（务必命名！）
    RejectedExecutionHandler handler   // 拒绝策略
);
```

**线程池状态**（ctl 高 3 位存状态，低 29 位存 worker 数）：
```
RUNNING     (-1)  接受新任务 + 处理队列
SHUTDOWN    (0)   不接受新任务 + 处理完队列
STOP        (1)   不接受 + 不处理 + 中断进行中
TIDYING     (2)   所有任务终止，worker 数 0，调 terminated()
TERMINATED  (3)   terminated() 执行完
```

### 执行流程（必背）🔴

```
提交任务 execute(task)
      │
      ▼
┌──────────────────────┐
│ 当前线程数 < core？   │──是──→ 创建核心线程执行
└──────┬───────────────┘
       │否
       ▼
┌──────────────────────┐
│ 队列未满？            │──是──→ 入队等待
└──────┬───────────────┘
       │否
       ▼
┌──────────────────────┐
│ 当前线程数 < max？    │──是──→ 创建非核心线程执行
└──────┬───────────────┘
       │否
       ▼
   执行拒绝策略
```

### 4 种拒绝策略 🔴
1. **AbortPolicy**（默认）：抛 RejectedExecutionException。
2. **CallerRunsPolicy**：让提交任务的线程自己执行（**背压**降速，生产推荐）。
3. **DiscardPolicy**：默默丢弃（慎用，丢数据无感知）。
4. **DiscardOldestPolicy**：丢队列最老的，重试（适合时效性任务）。

### Worker 源码核心 🟡
```java
final void runWorker(Worker w) {
    Runnable task = w.firstTask;
    while (task != null || (task = getTask()) != null) {  // 循环取任务
        w.lock();  // Worker 继承 AQS，独占锁（区分运行/空闲）
        try {
            beforeExecute(w.thread, task);  // 钩子
            task.run();                      // 执行
            afterExecute(task, null);        // 钩子
        } finally {
            task = null;
        }
    }
}
// getTask() 从队列 take/poll，超时返回 null → 线程退出（销毁非核心线程）
```

### 为什么禁用 Executors？🔴
| Executors 方法 | 问题 |
|---------------|------|
| newFixedThreadPool | LinkedBlockingQueue **无界** → 队列堆积 OOM |
| newSingleThreadExecutor | 同上无界队列 |
| newCachedThreadPool | 最大线程 Integer.MAX_VALUE → 线程数 OOM |
| newScheduledThreadPool | DelayedQueue 无界 → OOM |

阿里规约：用 `new ThreadPoolExecutor(...)` 显式有界队列 + 明确参数。

### 线程数怎么设？🔴
- **CPU 密集型**：`N + 1`（N = CPU 核数）。多 1 防偶发停顿。
- **IO 密集型**：`2N` 或 `N × (1 + 等待时间/计算时间)`。
  - 本质：让 CPU 不闲着（IO 时切换其他线程）。
- **混合型**：拆成两个线程池，或根据 Profiling 算。
- **最终靠压测**：监控队列堆积、拒绝次数、活跃线程。

### 【企迈线程池配置规范】
```java
// 通用业务线程池（IO 密集，8C 机器）
ThreadPoolExecutor bizPool = new ThreadPoolExecutor(
    16,                                  // core（2N）
    32,                                  // max（4N，给突发）
    60L, TimeUnit.SECONDS,
    new LinkedBlockingQueue<>(500),      // 有界队列
    new ThreadFactoryBuilder()           // Guava，命名！
        .setNameFormat("biz-pool-%d").build(),
    new ThreadPoolExecutor.CallerRunsPolicy()  // 背压
);
// 监控：暴露 activeCount、queueSize、rejected 次数到 Prometheus
```

### 📌 线上实战案例 3：线程池把 DB 连接打满

**现象**：订单服务 DB 连接池报满，接口超时。
**排查**：
1. DB 端看连接数：1000+（连接池配 50，怎么这么多）。
2. 查应用：发现有个 `@Async` 异步任务用 `Executors.newFixedThreadPool(200)`，并发查 DB。
3. 200 线程 × 各自拿连接 → 远超连接池。

**解决**：
- 异步线程池调到合理大小（按 DB 连接池反算）。
- 异步任务加 Sentinel 限流。
- 连接池监控告警。

**教训**：线程池大小要和下游资源（DB 连接、HTTP 连接）匹配，不能盲目开大。

### 📌 线上实战案例 4：线程池任务丢失

**现象**：用户提交任务后偶尔不执行，无报错。
**排查**：用 `DiscardPolicy`（默默丢）+ 队列无界（其实有界 1000）但突发流量超 1000 → 丢弃无感知。
**解决**：改 `CallerRunsPolicy`（背压）+ 监控拒绝次数 + 告警。

### 【面试话术】
「线程池我讲四块——7 参数、执行流程（核心→队列→非核心→拒绝）、4 种拒绝策略、为什么禁 Executors。执行流程必背：线程数 < core 创建核心，满了入队，队列满了创建非核心到 max，再满走拒绝策略。禁用 Executors 是因为 newFixedThreadPool 用无界队列 OOM，newCachedThreadPool 最大线程 Integer.MAX_VALUE 线程 OOM，阿里规约强制 new ThreadPoolExecutor 显式参数。线程数 IO 密集 2N、CPU 密集 N+1，但最终靠压测。企迈踩过两个坑——一是 @Async 用 Executors 开 200 线程把 DB 连接打满，二是用 DiscardPolicy 任务丢失无感知。生产标配是 CallerRunsPolicy（背压）+ 有界队列 + Prometheus 监控 queueSize/rejected + 线程命名（排查必备）。」

---

## 2.7 ThreadLocal 深度（原理 + 泄漏 + 最佳实践）🔴

### 【为什么/痛点】ThreadLocal 解决什么问题？

两个经典场景：
1. **线程内变量隔离**：每个线程有自己的副本（如数据库连接、用户上下文、SimpleDateFormat），避免共享竞争。
2. **避免参数层层透传**：把 traceId、用户信息放 ThreadLocal，全链路任意位置可取，不用每个方法签名都加参数。

### 数据结构
```
Thread
  └── ThreadLocal.ThreadLocalMap threadLocals
        └── Entry[] table
              Entry extends WeakReference<ThreadLocal<?>>
              {
                  ThreadLocal<?> key;   // 弱引用
                  Object value;         // 强引用
              }
```

### 为什么 key 用弱引用？🔴
- 如果 key 强引用 ThreadLocal，ThreadLocal 对象永远回收不了（只要线程活着）。
- 弱引用让 ThreadLocal 在无强引用时被 GC（key 变 null），但 **value 还在**（强引用）→ 泄漏隐患。

### 内存泄漏机制 🔴

```
Thread (线程池，长期存活)
  └── ThreadLocalMap
        └── Entry[0]: key=WeakRef[ThreadLocal@xxx]  ← GC 后 key=null
                       value=BigObject            ← 强引用，回收不掉！
```
- 线程池场景，线程长期存活。
- ThreadLocal 用完没 remove → key 被 GC 变 null，value 强引用驻留 → 泄漏。

### ThreadLocal 的自清理机制（不够可靠）🟡
- get/set/remove 时会清理 key==null 的 Entry（expungeStaleEntry）。
- **但**：如果不再次访问该 ThreadLocal，value 永远清不掉。

### 最佳实践
```java
ThreadLocal<User> ctx = new ThreadLocal<>();
try {
    ctx.set(user);
    // 业务
} finally {
    ctx.remove();  // 必须手动 remove！尤其线程池场景
}
```

### InheritableThreadLocal 的局限 + TTL 🔴
- InheritableThreadLocal：子线程能继承父线程值，但**线程池失效**（线程复用，父子关系只在线程创建时建立一次）。
- 解决：阿里 **TransmittableThreadLocal（TTL）**，用 Agent 字节码增强 / 装饰 Runnable，在任务提交时快照、执行时回放。
- 场景：链路追踪 traceId、用户上下文、日志 MDC 跨线程池传递。

### 【真实案例 - 企迈茶饮】
多租户场景用 ThreadLocal 存当前请求的 `tenantId`、`shopId`、`userId`，全链路任意方法可取，不用透传。配合 TTL 在线程池任务里也能拿到。坑：早期用 InheritableThreadLocal，线程池场景下租户 ID 串号（A 门店用户看到 B 门店数据），换 TTL 解决。

### 【面试话术】
「ThreadLocal 我讲『为什么有 + 数据结构 + 为什么 key 弱引用 + 泄漏机制 + TTL』。核心是每个 Thread 有自己的 ThreadLocalMap，Entry 的 key 是弱引用（防止 ThreadLocal 对象泄漏），value 是强引用。泄漏场景：线程池线程长期存活 + ThreadLocal 用完没 remove → key 被 GC 变 null 但 value 还在 → 内存泄漏。自清理机制（get/set/remove 时清 key==null 的 Entry）不可靠，所以必须 try-finally remove。InheritableThreadLocal 线程池失效（线程复用父子关系只建一次），企迈多租户用 TTL 跨线程池传 tenantId/shopId/userId，早期用 InheritableThreadLocal 还串过号（A 门店看到 B 门店数据），换 TTL 根治。」

---

## 2.8 并发容器深度

### ConcurrentHashMap JDK7 vs JDK8 🔴🔴

**JDK7：Segment 分段锁**
```
ConcurrentHashMap
  └── Segment[]（默认 16 段）
        └── HashEntry[]（每段一个数组）
              └── 链表
每个 Segment 继承 ReentrantLock → 锁一段 → 并发度 16
```

**JDK8：Node[] + CAS + synchronized**
```
ConcurrentHashMap
  └── Node[] table
        └── 链表 / TreeBin（红黑树）

put 流程：
1. hash 定位桶
2. 桶空 → CAS 插入（无锁）
3. 桶非空 → synchronized 锁头节点 → 插入（锁粒度=桶）
4. 链表 ≥8 且数组 ≥64 → 转红黑树
5. addCount（baseCount CAS + CounterCell[] 分段计数）
```

**为什么放弃分段锁？** 🔴
1. **并发度更高**：JDK7 上限 16，JDK8 锁粒度到桶，并发度 = 桶数（默认 16，扩容后更多）。
2. **内存更省**：分段锁每段自带锁对象，开销大。
3. **CAS + synchronized 优化**：synchronized 在 JDK6 后优化好（偏向/轻量），空桶 CAS 无锁，冲突才 synchronized。

**size 怎么算？**（借鉴 LongAdder）
- `baseCount`（无竞争时 CAS）+ `CounterCell[]`（有竞争时分段累加）。
- size 时求和，**弱一致性**（可能不准）。

### CopyOnWriteArrayList 🟡
- 写时复制：`ReentrantLock` + 复制新数组 → 旧引用指向新数组。
- 读无锁，读的是旧数组快照（**最终一致**）。
- 适合**读多写少**（监听器列表、配置）。
- 缺点：写放大（每次复制整个数组）、弱一致性。

### 阻塞队列 BlockingQueue（线程池用）
| 实现 | 特点 |
|------|------|
| ArrayBlockingQueue | 有界数组，一把锁（出入互斥） |
| LinkedBlockingQueue | 链表，两把锁（出入分离），默认 Integer.MAX_VALUE（坑） |
| SynchronousQueue | 无容量，直接交付（CachedThreadPool 用） |
| PriorityBlockingQueue | 优先级（堆），无界 |
| DelayQueue | 延时（ScheduledThreadPool 用） |
| LinkedTransferQueue | transfer() 直接交付，高吞吐 |

### 【真实案例 - 企迈茶饮】
- ConcurrentHashMap：门店商品本地缓存（Caffeine 内部就是它的扩展思路），高峰读多写少。
- 优惠券规则配置用 CopyOnWriteArrayList（运维改配置时写，业务读），避免读写锁开销。
- 异步任务队列用 LinkedBlockingQueue（有界 500），曾因忘设容量默认 Integer.MAX_VALUE 堆积 OOM，后改为显式 500。

### 【面试话术】
「ConcurrentHashMap 我重点讲 JDK7 到 JDK8 的演进——JDK7 是 Segment 分段锁（ReentrantLock 锁一段，并发度 16），JDK8 改成 Node[] + CAS + synchronized 锁头节点，并发度提到桶级别。为什么放弃分段锁？一是并发度更高（桶级 vs 16 段），二是内存省（分段锁每段自带锁对象），三是 JDK6 后 synchronized 优化好（偏向/轻量级），空桶 CAS 无锁，冲突才 synchronized。size 用 baseCount + CounterCell[] 分段计数（借鉴 LongAdder），弱一致。CopyOnWriteArrayList 写时复制适合读多写少（配置、监听器），缺点写放大。企迈门店商品缓存用 ConcurrentHashMap（高峰读多写少），券规则配置用 CopyOnWriteArrayList，异步队列用 LinkedBlockingQueue 但一定显式设容量，我踩过默认 Integer.MAX_VALUE 堆积 OOM 的坑。」

---

# 第三篇 集合框架（源码级）

## 3.1 HashMap JDK8 源码深度 🔴🔴

### 【为什么/痛点】HashMap 解决什么问题？为什么这么设计？

HashMap 是"哈希表 + 链表/红黑树"的混合结构，每个决策都是工程权衡：
- **数组**：O(1) 随机访问，但插入删除要搬移。
- **链表**：插入删除 O(1)，但查找 O(n)。
- **红黑树**：查找/插入/删除 O(log n)，避免哈希退化时链表变 O(n)。
- 组合：桶用数组 O(1) 定位，桶内冲突用链表（少时）或红黑树（多时）。

### 数据结构
```
table[] (Node / TreeNode)
  [0] → null
  [1] → Node → Node → Node → ... (链表)
  [2] → TreeNode（红黑树）
  ...

Node { int hash; K key; V value; Node next; }
TreeNode extends Node { parent, left, right, prev, red; }
```

### 核心参数
```java
static final int DEFAULT_INITIAL_CAPACITY = 16;
static final float DEFAULT_LOAD_FACTOR = 0.75f;
static final int TREEIFY_THRESHOLD = 8;       // 链表转树
static final int UNTREEIFY_THRESHOLD = 6;     // 树退化链表
static final int MIN_TREEIFY_CAPACITY = 64;   // 树化要求数组长度
```

### hash 扰动函数 🔴
```java
static final int hash(Object key) {
    int h;
    return (key == null) ? 0 : (h = key.hashCode()) ^ (h >>> 16);
}
```
- **高 16 位异或低 16 位**，让高位也参与桶定位。
- 原因：桶下标 `(n-1) & hash`，n 通常小（如 16），只用低几位，碰撞多。扰动让高位也影响。

### 桶下标计算 🔴
```java
index = (n - 1) & hash;  // n 是 2 的幂，等价 hash % n 但更快
```
**为什么容量是 2 的幂？**
- `(n-1) & hash` 等价 `hash % n`，但位运算快。
- 扩容时，元素新位置要么 `原 idx`，要么 `idx + oldCap`（看 hash 新增高位 bit），高效迁移。

### put 流程源码 🔴
```java
final V putVal(int hash, K key, V value, boolean onlyIfAbsent, boolean evict) {
    Node<K,V>[] tab = table;
    // 1. 初始化或扩容
    if (tab == null || tab.length == 0)
        tab = resize();
    int i = (n - 1) & hash;       // 桶下标
    Node<K,V> p = tab[i];
    // 2. 桶空，直接放
    if (p == null)
        tab[i] = newNode(hash, key, value, null);
    else {
        // 3. 桶非空
        Node<K,V> e; K k;
        if (p.hash == hash && ((k = p.key) == key || (key != null && key.equals(k))))
            e = p;                          // 3.1 key 相等，覆盖
        else if (p instanceof TreeNode)
            e = ((TreeNode<K,V>)p).putTreeVal(this, tab, i, hash, key, value); // 3.2 红黑树
        else {
            for (int binCount = 0; ; ++binCount) {  // 3.3 链表遍历
                if ((e = p.next) == null) {          // 尾插
                    p.next = newNode(hash, key, value, null);
                    if (binCount >= TREEIFY_THRESHOLD - 1)
                        treeifyBin(tab, hash);       // 链表≥8 尝试树化
                    break;
                }
                if (e.hash == hash && ((k = e.key) == key || (key != null && key.equals(k))))
                    break;                           // 找到 key
                p = e;
            }
        }
        if (e != null) {  // 覆盖旧值
            V oldValue = e.value;
            if (!onlyIfAbsent || oldValue == null)
                e.value = value;
            return oldValue;
        }
    }
    ++modCount;
    if (++size > threshold)  // 4. 超阈值扩容
        resize();
    return null;
}
```

### 为什么链表转树阈值是 8？🔴
- 理想 hash 下，桶内元素数服从**泊松分布**（λ=0.5）。
- 长度 8 的概率 ≈ 0.00000006，属"极端异常"（hash 退化或恶意攻击）。
- 平时几乎不树化（树化开销大）。
- 退化阈值 6（不是 7，避免 7-8 来回抖动）。

### JDK7 多线程死循环（头插法）🔴🔴
```
JDK7 扩容时 transfer，头插法迁移链表：
原链表：A → B → null
线程1 扩容，处理到 A（记下 next=B）
线程2 扩容完成，B → A（头插反转）
线程1 继续，A.next=B → 把 B 接到新表头 → B.next=A → 环！
→ get 遍历到环 → CPU 100%
```
JDK8 改尾插（保持原顺序），不成环，但**仍非线程安全**（并发 put 丢数据、size 不准）。

### resize 扩容优化（JDK8）🔴
- 扩容 2 倍。
- 元素重新定位：`newIndex = (hash & oldCap) == 0 ? oldIndex : oldIndex + oldCap`。
- 不用重算 hash，只看新增高位 bit。

### 【真实案例 - 企迈茶饮】
门店商品 SKU 缓存用 HashMap（外层 Caffeine），峰值 50 万 SKU。曾遇并发 put 导致 size 不准（少几个），改用 ConcurrentHashMap 解决。也遇到过 key 用自定义对象没重写 hashCode/equals 导致内存泄漏（重复 key 堆积），后来用 Lombok @EqualsAndHashCode 自动生成。

### 【面试话术】
「HashMap 我会按『数据结构 → 核心参数 → hash 扰动 → put 流程 → 为什么阈值 8 → JDK7 死循环 → resize 优化』讲。数据结构是数组+链表+红黑树。hash 扰动是高 16 位异或低 16 位，让高位参与桶定位（因为 n-1 掩码通常只取低位）。桶下标用 (n-1)&hash 而不是 % n，因为位运算快 + 扩容时元素要么留原位要么 idx+oldCap。put 流程必背：桶空直接放、桶非空看是链表还是红黑树、key 相等覆盖、链表尾插、≥8 树化。为什么阈值 8？泊松分布下长度 8 概率 0.00000006，是异常情况才树化。JDK7 头插法多线程死循环，JDK8 改尾插不成环但仍非线程安全。企迈门店 SKU 缓存早期用 HashMap 并发 put 丢数据，改 ConcurrentHashMap。踩过自定义对象 key 没重写 hashCode/equals 导致重复 key 堆积的坑，用 Lombok @EqualsAndHashCode 解决。」

---

## 3.2 ConcurrentHashMap put 流程（JDK8）🔴

```java
final V putVal(K key, V value, boolean onlyIfAbsent) {
    int hash = spread(key.hashCode());
    for (Node<K,V>[] tab = table;;) {
        int i = (n - 1) & hash;
        Node<K,V> f = tab[i];
        if (f == null) {
            // 桶空 → CAS 无锁插入
            if (casTabAt(tab, i, null, new Node<>(hash, key, value, null)))
                break;
        } else if ((fh = f.hash) == MOVED) {
            // hash==MOVED 表示正在扩容，帮忙迁移
            tab = helpTransfer(tab, f);
        } else {
            // 桶非空 → synchronized 锁头节点
            synchronized (f) {
                if (tabAt(tab, i) == f) {  // 二次确认
                    // 链表/红黑树插入...
                }
            }
        }
    }
    addCount(1L, binCount);  // 分段计数（baseCount + CounterCell）
}
```

### 【关键设计点】
1. **桶空 CAS 无锁**：避免无冲突时上锁，零开销。
2. **桶非空 synchronized 锁头节点**：锁粒度=桶，并发度高。
3. **hash==MOVED（ForwardingNode）帮忙扩容**：多线程协助迁移，加速扩容。
4. **二次确认 `tabAt(tab,i)==f`**：防止 CAS 后桶已被替换。
5. **addCount 分段计数**：baseCount CAS 失败时用 CounterCell[]（借鉴 LongAdder），减少竞争。

### 【面试话术】
「ConcurrentHashMap put 流程我背得出：hash 定位桶 → 桶空 CAS 无锁插入 → 桶非空 synchronized 锁头节点 → hash==MOVED 帮忙扩容 → addCount 分段计数。亮点是『空桶 CAS + 非空 synchronized』的分级策略，无冲突时零开销，有冲突锁粒度到桶。扩容时多线程协助（helpTransfer，ForwardingNode 标记 MOVED）是个很巧妙的设计，让扩容不阻塞写。size 用 baseCount + CounterCell[] 分段累加（LongAdder 思路），弱一致。」

---

## 3.3 ArrayList / LinkedList 对比

### 【为什么/痛点】为什么 99% 用 ArrayList？

很多人以为"频繁增删用 LinkedList"，这是误解。LinkedList 的增删优势只在"已持有节点引用"时（如迭代器删除），业务场景几乎都是先 `get(i)` 定位（O(n)）再增删，整体还是 O(n)。而 ArrayList 连续内存对 CPU 缓存友好，实测性能远超 LinkedList。

| | ArrayList | LinkedList |
|---|-----------|------------|
| 底层 | 数组 | 双向链表 |
| 随机访问 | O(1) | O(n) |
| 尾部增 | O(1) 均摊 | O(1) |
| 中间增删 | O(n)（搬移） | O(1)（已定位节点，但定位 O(n)） |
| 内存 | 紧凑 | 每节点多 prev/next 指针 |

**ArrayList 扩容**：首次 10，之后 `oldCap + (oldCap >> 1)` = 1.5 倍（`Arrays.copyOf`）。

**为什么 99% 用 ArrayList？** 🔴
- 数组**缓存友好**（连续内存，CPU 预取），实际性能远好于链表。
- LinkedList 增删优势在"已持有节点引用"时才体现，业务场景几乎不存在（都是先 get(i) 定位再增删，get 本身 O(n)）。
- LinkedList 实现了 Deque，可做队列/栈（但 ArrayDeque 更快）。

### 【真实案例 - 企迈茶饮】
优惠券列表查询默认 ArrayList。曾有个场景用 LinkedList 做"频繁头插"，结果遍历时性能差，改 ArrayDeque（头尾 O(1)）+ 数组实现，性能提 3 倍。

### 【面试话术】
「ArrayList vs LinkedList 我会纠正一个常见误区——『频繁增删用 LinkedList』是错的。LinkedList 增删 O(1) 的前提是『已持有节点引用』，业务里都是先 get(i) 定位（O(n)）再删，整体还是 O(n)。而 ArrayList 连续内存对 CPU 缓存友好，实测性能远超 LinkedList。我有个经验：99% 场景用 ArrayList，需要队列/栈用 ArrayDeque（比 LinkedList 快），LinkedList 几乎不用。ArrayList 扩容 1.5 倍（首次 10），如果预知大小用 new ArrayList<>(expectedSize) 避免多次扩容。」

---

## 3.4 TreeMap / LinkedHashMap

### 【为什么/痛点】为什么有这两个？

- **TreeMap**：需要按 key 排序遍历（如优惠券按面额排序、Top N）。红黑树 O(log n)。
- **LinkedHashMap**：需要保持插入顺序或访问顺序（LRU 缓存）。HashMap + 双向链表。

- **TreeMap**：红黑树，key 有序（Comparable/Comparator），O(log n)。需排序遍历时用。
- **LinkedHashMap**：HashMap + 双向链表，维护**插入顺序**或**访问顺序**（accessOrder=true）。
  - **LRU 经典实现**：accessOrder=true + 重写 removeEldestEntry。
  ```java
  class LRU<K,V> extends LinkedHashMap<K,V> {
      private final int cap;
      LRU(int cap) { super(cap, 0.75f, true); this.cap = cap; }  // accessOrder=true
      @Override
      protected boolean removeEldestEntry(Map.Entry<K,V> eldest) {
          return size() > cap;  // 超容量淘汰最久未访问
      }
  }
  ```

### 【真实案例 - 企迈茶饮】
- TreeMap：优惠券按"面额降序"排序展示（Comparator）。
- LinkedHashMap：早期本地 LRU 缓存实现，后换 Caffeine（W-TinyLFU，命中率更高）。

### 【面试话术】
「TreeMap 是红黑树，key 有序，O(log n)，用于需要排序遍历的场景（如券按面额排序、Top N）。LinkedHashMap 是 HashMap + 双向链表，可保持插入顺序或访问顺序（accessOrder=true）。LRU 经典实现就是 LinkedHashMap accessOrder=true + 重写 removeEldestEntry，超容量淘汰最久未访问。企迈早期本地缓存用这个 LRU，后来换 Caffeine（W-TinyLFU 算法命中率更高，支持过期时间）。」

---

# 第四篇 IO / NIO / 零拷贝

## 4.1 BIO → NIO → AIO

### 【为什么/痛点】为什么要演进？

- **BIO**：一个连接一个线程，连接数上去后线程爆炸。痛点：连接数受限。
- **NIO**：一个线程管多个连接（多路复用），用 Selector 监听事件。痛点解决：单线程可管几万连接（Netty 用此）。
- **AIO**：真正的异步（OS 完成 IO 后回调），无需应用轮询。痛点：Linux 的 AIO 实现不成熟（epoll 模拟），Netty 也放弃 AIO 用 NIO。

| | BIO | NIO | AIO |
|---|-----|-----|-----|
| 模型 | 同步阻塞 | 同步非阻塞（多路复用） | 异步非阻塞 |
| 实现 | InputStream/OutputStream | Channel + Selector + Buffer | CompletionHandler |
| 适用 | 连接少 | 连接多（Netty） | 连接多且数据量大 |

### 【面试话术】
「BIO→NIO→AIO 的演进核心是『连接数 + 线程数』的解耦。BIO 一个连接一个线程，连接多就线程爆炸。NIO 多路复用让一个线程管几万连接（epoll_wait 事件驱动），Netty 就是基于这个。AIO 是真异步（OS 完成回调），但 Linux AIO 不成熟（epoll 模拟），Netty 也放弃 AIO 用 NIO，所以 Java 圈实际还是 NIO 为主。」

## 4.2 NIO 三大核心 🟡

### Buffer
```
position（当前位置）→ limit（限制）→ capacity（容量）
写模式：position 从 0 增，limit=capacity
flip() 切读：limit=position, position=0
```

```java
ByteBuffer buf = ByteBuffer.allocate(1024);
buf.put((byte) 1);     // 写
buf.flip();            // 切读
byte b = buf.get();    // 读
buf.clear();           // 复位（数据还在，position=0, limit=capacity）
```

### Channel（双向）
FileChannel / SocketChannel / ServerSocketChannel / DatagramChannel。

### Selector（多路复用）
```java
Selector selector = Selector.open();
channel.configureBlocking(false);
channel.register(selector, SelectionKey.OP_READ);
while (true) {
    selector.select();  // 阻塞到有事件
    Set<SelectionKey> keys = selector.selectedKeys();
    for (key : keys) {
        if (key.isReadable()) { /* 读 */ }
    }
}
```
- Linux 基于 **epoll**（epoll_wait），O(1) 事件通知。
- 一个线程管几万连接（Netty 用此）。

**epoll vs select/poll**：
| | select | poll | epoll |
|---|--------|------|-------|
| FD 上限 | 1024 | 无 | 无 |
| 复杂度 | O(n) | O(n) | O(1) |
| 机制 | 每次拷贝 FD 集 + 遍历 | 同 select | 红黑树 + 就绪链表，事件驱动 |

### 【面试话术】
「NIO 三大核心 Buffer/Channel/Selector。Buffer 三个指针 position/limit/capacity，flip() 切读写。Channel 双向，Selector 多路复用——一个线程管几万连接，Linux 底层是 epoll（红黑树 + 就绪链表，O(1) 事件通知），比 select/poll 的 O(n) 遍历强。Netty 就基于 NIO 封装。企迈高并发网关用 Netty，单机扛几万长连接没问题。」

## 4.3 零拷贝（Zero-Copy）🔴🔴

### 【为什么/痛点】为什么要零拷贝？

传统"读文件发网络"有 4 次拷贝（2 次 DMA + 2 次 CPU）+ 4 次上下文切换（user/kernel 来回）。数据从磁盘到网卡，中间多次进出用户空间是浪费。零拷贝的目标是**减少 CPU 拷贝和上下文切换**，让数据尽量留在内核态。

### 传统读文件发网络（4 次拷贝 + 4 次上下文切换）
```
1. read(): 磁盘 → 内核读缓冲（DMA）→ 用户空间 buffer（CPU 拷贝）
2. write(): 用户 buffer → 内核 socket 缓冲（CPU）→ 网卡（DMA）
上下文切换：user→kernel→user→kernel→user
```

### mmap（内存映射）
```
mmap() 把文件映射到用户空间内存（与内核共享）
读文件：用户直接读映射内存（无需内核→用户拷贝）
省去一次 CPU 拷贝
```

### sendfile（Linux 2.1+）
```
sendfile() 内核直接从读缓冲 → socket 缓冲 → 网卡
全程不进用户空间
Linux 2.4+ 配合 DMA gather，连 socket 缓冲都省（只传描述符）
2 次拷贝（都是 DMA）
```

### 三种方式对比
| 方式 | CPU 拷贝 | DMA 拷贝 | 上下文切换 | 适用 |
|------|---------|---------|-----------|------|
| 传统 | 2 | 2 | 4 | — |
| mmap | 1 | 2 | 4 | 用户态需处理数据 |
| sendfile | 0 | 2 | 2 | 纯转发（Kafka） |

### 应用场景 🔴
- **Kafka**：用 sendfile 顺序读 + PageCache，超高吞吐。
- **Netty**：FileRegion 用 sendfile；用 DirectByteBuffer 减一次拷贝。
- **Nginx**：sendfile 默认开。

### 【面试话术】
「零拷贝我讲『传统 4 次拷贝 + 4 次切换 → mmap 省 1 次 CPU 拷贝 → sendfile 省 2 次 CPU 拷贝 + 2 次切换』。传统 read+write 数据磁盘到网卡要进出用户空间 4 次拷贝 + 4 次上下文切换。mmap 把文件映射到用户空间和内核共享，省一次 CPU 拷贝。sendfile 全程不进用户空间，Linux 2.4+ 配 DMA gather 连 socket 缓冲都省（只传描述符），2 次 DMA 拷贝 + 2 次切换。Kafka 顺序读 + sendfile + PageCache 是它超高吞吐的关键。Netty FileRegion 也用 sendfile，DirectByteBuffer 减一次拷贝。Nginx sendfile 默认开。」

---

# 第五篇 Java 新特性（高频加分）

## 5.1 各版本重要特性

### 【为什么/痛点】为什么要了解新特性？

8 年工程师不能用 Java 8 写所有代码。新特性解决真实痛点：
- **Lambda/Stream**：函数式编程，集合操作更简洁。
- **var**：减少样板代码（局部变量类型推断）。
- **Record**：不可变 DTO，替代 Lombok @Data 写一堆样板。
- **Sealed**：封闭类，控制继承层次。
- **Pattern Matching**：减少 instanceof + 强转样板。
- **虚拟线程**：高并发 IO 的新范式。

| 版本 | 重要特性 |
|------|---------|
| Java 8 | Lambda、Stream、Optional、default/static 方法、新日期（java.time） |
| Java 9 | 模块化 Jigsaw、JShell、private 接口方法、集合工厂方法 List.of() |
| Java 11 (LTS) | var 局部推断、HTTP Client、ZGC 实验、String API 增强（strip/isBlank/lines） |
| Java 17 (LTS) | Sealed 类、Pattern Matching（instanceof）、Record、Switch 表达式、文本块 """ |
| Java 21 (LTS) | **虚拟线程**、Pattern Matching for switch、Record Patterns、Sequenced Collections |

### 【常用新特性代码示例】

**Stream API（Java 8）**：
```java
// 企迈：找出所有满减券按面额降序取前 3 的券名
coupons.stream()
    .filter(c -> c.getType() == CouponType.FULL_REDUCTION)
    .sorted(Comparator.comparing(Coupon::getAmount).reversed())
    .limit(3)
    .map(Coupon::getName)
    .collect(Collectors.toList());
```

**Record（Java 14+）**——不可变 DTO：
```java
// 一行替代 Lombok @Data + 构造 + getter + equals + hashCode
public record CouponDTO(Long id, String name, BigDecimal amount) {}
// 自动生成：构造、getter（id()/name()/amount()）、equals、hashCode、toString
```

**Pattern Matching for switch（Java 21）**：
```java
// 老写法：instanceof + 强转
Object obj = ...;
if (obj instanceof String) {
    String s = (String) obj;
    System.out.println(s.length());
}
// 新写法
switch (obj) {
    case String s -> System.out.println(s.length());
    case Integer i when i > 0 -> System.out.println(i);
    case null -> System.out.println("null");
    default -> System.out.println("other");
}
```

**文本块（Java 15）**：
```java
String json = """
    {"shopId": %d, "coupon": "%s"}
    """.formatted(shopId, coupon);
```

### 【LTS 版本选型建议】
- **Java 8**：存量系统，短期不动。
- **Java 11**：稳定过渡，主流企业。
- **Java 17**：新项目首选，生态成熟。
- **Java 21**：虚拟线程尝鲜，高并发场景值得升级。

### 【面试话术】
「新特性我重点掌握 5 个：Java 8 的 Lambda/Stream（函数式集合操作，企迈券列表过滤排序分组天天用）、Java 14 的 Record（不可变 DTO 替代 Lombok @Data 样板）、Java 16 的 Pattern Matching（instanceof + 强转简化）、Java 17 的 Sealed/Switch 表达式/文本块、Java 21 的虚拟线程。LTS 选型我建议新项目用 17（生态成熟），高并发 IO 场景考虑 21（虚拟线程）。企迈现在还在 8，但有计划升 17，主要是为了 Record 和 Switch 表达式减少样板代码，加上 G1 在 17 上更成熟。」

## 5.2 虚拟线程（Virtual Thread，JDK21）🔴 重点

### 【为什么/痛点】虚拟线程解决什么问题？

传统平台线程（Platform Thread）= OS 线程，昂贵（1MB 栈 + OS 调度）。一个 IO 密集服务开几千个线程就到极限。虚拟线程是 **JVM 调度的轻量级线程**，由 JVM 在少量载体线程上调度，IO 阻塞时让出载体线程——**用同步代码写出异步性能，告别 callback 地狱**。

```java
Thread.startVirtualThread(() -> { /* task */ });

// 或线程池
Executors.newVirtualThreadPerTaskExecutor();
```

### 【原理图解】

```
┌─────────────────────────────────────────────────────┐
│  虚拟线程（百万级，JVM 管理）                         │
│  VT1   VT2   VT3   ...   VT1000000                  │
│   │     │     │              │                       │
│   └─────┴─────┴──── mount ───┴──→ 载体线程 Carrier   │
│                                    (ForkJoinPool,    │
│                                     少量, =CPU核数)   │
│                                                       │
│  IO 阻塞时：VT unmount（让出载体线程），IO 完成再 mount│
└─────────────────────────────────────────────────────┘
```

- 由 JVM 调度（非 OS），运行在少量**载体线程（Carrier Thread，ForkJoinPool）**上。
- 虚拟线程在 IO 阻塞时**让出载体线程**（unmount），IO 完成后再 mount 回来。
- 一个应用可起**百万级**虚拟线程。

### 【与传统线程对比】
| | 平台线程 | 虚拟线程 |
|---|---------|---------|
| 实现 | OS 线程（1:1） | JVM 调度（M:N） |
| 数量 | 几千上限 | 百万级 |
| 栈内存 | 固定 1MB | 按需（堆上） |
| 调度 | OS 抢占 | JVM 协作（IO 时让出） |
| 阻塞 | 烧线程 | 让出载体线程，零浪费 |

### 适用与注意 🔴
- **适用**：高并发 IO 密集（HTTP 服务、DB 查询），同步代码写出异步性能（无 callback 地狱）。
- **不适用**：CPU 密集（无收益）、synchronized 长时间持锁（JDK21 会"钉住"载体线程，建议用 ReentrantLock）。
- 与平台线程 API 兼容，ThreadLocal/InheritableThreadLocal 可用（但有性能注意）。

### 【"钉住"载体线程的坑】🔴
- JDK21 中，虚拟线程在 `synchronized` 代码块内阻塞（如 wait、IO）会**钉住（pin）载体线程**，载体线程无法服务其他虚拟线程，退化成平台线程的弊端。
- 解决：用 `ReentrantLock` 替代 synchronized（JDK21 的虚拟线程会正确 unmount）。
- JDK24 优化了 synchronized 的 pinning 问题。

### 【真实案例 - 通用互联网】
一个 HTTP 网关服务，原来用平台线程池（200 线程），QPS 上限 2000。换虚拟线程（百万级），QPS 提到 10 万+，代码几乎不改（Tomcat 已支持虚拟线程）。注意要把 synchronized 改 ReentrantLock 避免 pinning。

### 【面试话术】
「虚拟线程是 JDK21 最大的特性，解决了『IO 密集型服务线程数受限』的痛点。传统平台线程是 OS 线程（1:1），1MB 栈 + OS 调度，几千个就到极限。虚拟线程是 JVM 调度的轻量线程（M:N），跑在少量载体线程（ForkJoinPool）上，IO 阻塞时 unmount 让出载体线程，完成后 mount 回来——用同步代码写出异步性能，告别 callback 地狱。一个应用可起百万级虚拟线程。适用高并发 IO，不适用 CPU 密集。最大坑是 JDK21 里 synchronized 会『钉住』载体线程（阻塞时不 unmount），要用 ReentrantLock 替代。我在通用 HTTP 网关场景研究过，平台线程池 200 线程 QPS 上限 2000，换虚拟线程 QPS 提到 10 万+，代码几乎不改（Tomcat 已支持）。企迈券计算 IO 密集，未来升 21 后是巨大优化空间。」

---

# 高频追问清单（自测，盖住回答）

1. **描述一次对象从创建到被回收的完整过程。** 🔴
   答：类加载检查→分配内存（指针碰撞/空闲列表+TLAB）→零值初始化→设对象头→执行<init>→引用入栈。回收：GC Roots 不可达→标记→复制/清除/整理。

2. **元空间替代永久代的原因？** 🔴
   答：永久代固定大小易 OOM（CGLIB/JSP 动态类多）；元空间用本地内存无上限；JRockit 融合需要；GC 扫描范围小。

3. **对象一定分配在堆上吗？逃逸分析、标量替换？** 🔴
   答：不一定。逃逸分析（默认开）分析对象作用域，未逃逸的对象做标量替换（拆成基本类型栈上变量）+ 锁消除，不进堆。

4. **TLAB 解决什么问题？** 🟡
   答：多线程并发 new 抢 Eden 指针。给每线程一块 Eden 私有 TLAB，自己分自己的，无锁无 CAS。

5. **G1 的 Region、RSet、Mixed GC 流程？什么时候触发 Full GC？** 🔴🔴
   答：Region 化（~2048 个，1-32MB），逻辑分代不物理连续。RSet 记录"谁指向我"。Mixed GC 回收年轻代+部分老年代 Region。Full GC 触发：并发标记跟不上、Mixed GC 回收不够、Evacuation Failure、Humongous Allocation 失败。

6. **G1 的三色标记 + SATB？和 CMS 增量更新的区别？** 🔴
   答：三色标记（白/灰/黑）并发标记。漏标需同时满足"新增引用 + 断开引用"。CMS 增量更新拦截新增（条件1），G1 SATB 拦截断开（条件2）+ 拍快照，宁可多标不漏标。

7. **ZGC 为什么能 <1ms 停顿？着色指针 + 读屏障？** 🔴
   答：64 位指针高 4 位存 GC 状态（颜色），GC 改指针标志位不动对象头。读屏障每次读引用检查颜色，过期就自愈式转移对象并更新指针，GC 和应用真正并发。

8. **volatile 底层？为什么 DCL 必须加？** 🔴
   答：写 volatile 生成 `lock addl` 指令，lock 前缀做 MESI 缓存失效 + StoreLoad 全屏障。DCL 必须加因为 new 对象三步（分配→初始化→赋引用）可能重排成（分配→赋引用→初始化），其他线程拿半初始化对象 NPE。

9. **synchronized 锁升级全过程？Mark Word 变化？** 🔴🔴
   答：无锁→偏向锁（记 ThreadID）→轻量级锁（CAS 自旋）→重量级锁（ObjectMonitor 阻塞）。Mark Word 64 位记录锁状态，偏向锁存 ThreadID，轻量级存 Lock Record 指针，重量级存 ObjectMonitor 指针。只升不降（GC 除外）。JDK15 废弃偏向锁。

10. **CAS 原理、缺点、ABA？** 🔴
    答：cmpxchg 硬件指令。缺点：自旋烧 CPU、单变量、ABA（值 A→B→A 误判，AtomicStampedReference 加版本号解决）。

11. **AQS 原理 + ReentrantLock 加锁源码流程？公平非公平区别？** 🔴🔴
    答：volatile state + CLH 变体队列。ReentrantLock：lock→CAS 抢 state→acquire→tryAcquire（子类）→acquireQueued 入队+park。公平锁 hasQueuedPredecessors 判断队列是否有人，非公平直接抢。

12. **线程池 7 参数 + 流程 + 状态机？为什么禁 Executors？线程数怎么设？** 🔴🔴
    答：core/max/keepAlive/queue/factory/handler。流程：核心→队列→非核心→拒绝。禁 Executors 因无界队列/无限线程 OOM。IO 密集 2N，CPU 密集 N+1，压测定。

13. **ThreadLocal 泄漏机制？为什么 key 弱引用？TTL 解决什么？** 🔴
    答：key 弱引用防 ThreadLocal 对象泄漏，但 value 强引用导致泄漏。线程池 + 不 remove → key=null value 驻留。TTL 解决线程池下 InheritableThreadLocal 失效，跨线程池传上下文。

14. **HashMap put 源码？为什么阈值 8？JDK7 死循环？JDK8 resize 优化？** 🔴🔴
    答：桶空直接放、桶非空链表/红黑树、key 相等覆盖、尾插、≥8 树化、超阈值扩容。阈值 8 因泊松分布下概率 0.00000006 异常才树化。JDK7 头插多线程成环。JDK8 尾插 + resize 时元素留原位或 idx+oldCap。

15. **ConcurrentHashMap JDK7 vs JDK8？为什么放弃分段锁？** 🔴
    答：JDK7 Segment 分段锁（ReentrantLock，并发度 16），JDK8 Node[]+CAS+synchronized 锁头节点（并发度=桶数）。放弃分段锁：并发度更高、内存省、synchronized 优化好。

16. **零拷贝（mmap/sendfile）？Kafka 为什么快？** 🔴
    答：传统 4 次拷贝 4 次切换。mmap 省 1 次 CPU 拷贝，sendfile 省 2 次 CPU 拷贝 + 2 次切换。Kafka 快：顺序读 + sendfile + PageCache + 零拷贝。

17. **虚拟线程原理？适用场景？什么情况钉住载体线程？** 🔴
    答：JVM 调度的轻量线程跑在载体线程上，IO 阻塞 unmount。适用高并发 IO。JDK21 synchronized 会 pin，用 ReentrantLock 替代。

18. **双亲委派？破坏场景（JDBC/Tomcat/热部署）？** 🔴
    答：loadClass 先 findLoadedClass→parent.loadClass→findClass。破坏场景：JDBC 用 TCCL，Tomcat WebAppClassLoader 优先自己加载，OSGi 网状，热部署新 ClassLoader 重加载。

19. **JVM 调优三大目标？怎么权衡？** 🔴
    答：低延迟、高吞吐、不 Full GC，三者不可兼得。Web 服务延迟优先选 G1，批处理吞吐优先选 Parallel。先定优先级再调。

20. **CPU 100% 排查 SOP？** 🔴
    答：top→top -Hp→printf %x→jstack→grep nid。同时 jstat 区分是 GC 烧还是用户线程烧。Arthas thread -n 3 简化。

21. **OOM 有哪些类型？怎么排查？** 🔴
    答：heap space（MAT 支配树）、Metaspace（类泄漏）、GC overhead（堆溢出前兆）、Direct buffer（Netty 堆外）、unable to create native thread（线程超限/栈太大）。

22. **GC Roots 有哪些？** 🔴
    答：栈引用、本地方法栈 JNI、静态变量、常量、JVM 内部引用（Class/异常/类加载器）、synchronized 持有对象、JMXBean/JVMTI、跨代临时 Roots（Card Table）。

23. **happens-before 8 大规则？** 🔴
    答：程序顺序、监视器锁、volatile、线程启动、线程终止、线程中断、对象终结、传递性。

24. **synchronized vs ReentrantLock？** 🔴
    答：synchronized 自动释放/JVM 关键字/不可中断/非公平/单 Condition；ReentrantLock 手动 finally unlock/AQS/可中断/可超时/可公平/多 Condition。

25. **CountDownLatch vs CyclicBarrier？** 🔴
    答：CountDownLatch 基于 AQS 共享，减到 0，一次性，主线程等 N 任务；CyclicBarrier 基于 ReentrantLock+Condition，达到指定数，可 reset 复用，N 线程互等。

26. **为什么 HashMap 容量是 2 的幂？** 🔴
    答：(n-1)&hash 等价 hash%n 但位运算快；扩容时元素新位置要么原 idx 要么 idx+oldCap，高效迁移。

27. **HashMap 和 Hashtable 区别？** 🟡
    答：HashMap 非线程安全允许 null 键值、初始 16、扩容 2 倍；Hashtable 线程安全（方法 synchronized）不允许 null、初始 11、扩容 2n+1（已废弃用 ConcurrentHashMap）。

28. **阻塞队列有哪些？线程池分别用哪个？** 🟡
    答：ArrayBlockingQueue（有界一把锁）、LinkedBlockingQueue（两把锁默认无界坑）、SynchronousQueue（直接交付 CachedThreadPool）、PriorityBlockingQueue、DelayQueue（ScheduledThreadPool）、LinkedTransferQueue。

29. **BIO/NIO/AIO 区别？Netty 用哪个？** 🟡
    答：BIO 同步阻塞一连接一线程；NIO 同步非阻塞多路复用（epoll）；AIO 异步非阻塞（Linux 不成熟）。Netty 用 NIO。

30. **JDK8 Stream 和 for 循环性能对比？** 🟡
    答：简单遍历 for 更快（无 lambda 开销）；复杂操作（filter/map/group/sort/parallel）Stream 更简洁，parallelStream 大数据量可并行。生产用 Stream 优先可读性，热路径用 for。

31. **Record 和 Lombok @Data 区别？** 🟡
    答：Record 是语言级不可变 DTO（构造+getter+equals+hashCode+toString 全自动，无 setter 不可变）；Lombok @Data 字节码增强可变（有 setter）。Record 更安全（不可变），Lombok 更灵活。

32. **接口的 default/private 方法？** 🟢
    答：default（Java 8）给接口加默认实现不破坏实现类；private（Java 9）接口内部复用代码。Stream/Collection API 大量用 default。

33. **类初始化的 6 种触发时机？** 🟡
    答：new/getstatic/putstatic/invokestatic、反射、初始化子类先初始化父类、main 主类、MethodHandle、接口含 default 方法的实现类初始化。不触发：子类访问父类静态字段、数组定义、常量。

34. **逃逸分析的两种优化（标量替换 + 锁消除）？** 🔴
    答：标量替换——未逃逸对象拆成基本类型栈上变量（不进堆）；锁消除——未逃逸对象的 synchronized 直接删除（如方法内 new StringBuffer）。

> 对应面试题：`面试/面试题-Java核心.md` 和 `面试/面试题-并发与JVM.md`
